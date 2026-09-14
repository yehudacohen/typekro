/**
 * ClickHouse SQL text analysis: a small lexer plus the two things that read it.
 *
 * TypeKro never REWRITES a statement — an author's DDL reaches the server byte for byte.
 * It does have to READ them, and that needs a scan which knows where a string literal
 * starts and ends: {@link validateOnClusterStatement} decides whether a statement is
 * actually cluster-wide, so `execution.mode: 'onCluster'` can reject a statement that
 * would silently land on one replica instead of rewriting it into something it wasn't.
 * Deliberately not a SQL parser. It resolves quoting and comments and nothing else; the
 * question above is answered conservatively, so an unrecognised shape is rejected rather
 * than waved through.
 */

/** One lexical unit. Numbers and operators collapse into `punct` — nothing here reads them. */
export type ClickHouseSqlToken =
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'quoted'; readonly value: string; readonly quote: "'" | '"' | '`' }
  | { readonly kind: 'punct'; readonly value: string };

const WORD_START = /[A-Za-z_]/;
const WORD_BODY = /[A-Za-z0-9_$]/;

/**
 * Split a statement into words, quoted values and single punctuation characters.
 *
 * Comments (`--`, `#`, `/* … *\/`) are dropped. Quoted values are returned DECODED — the
 * doubling and backslash escapes ClickHouse accepts are resolved — because both callers
 * compare against the value the server sees, not the source spelling.
 */
export function tokenizeClickHouseSql(statement: string): readonly ClickHouseSqlToken[] {
  const tokens: ClickHouseSqlToken[] = [];
  let index = 0;

  while (index < statement.length) {
    const char = statement[index] as string;

    // -- line comment / # line comment
    if ((char === '-' && statement[index + 1] === '-') || char === '#') {
      const newline = statement.indexOf('\n', index);
      index = newline === -1 ? statement.length : newline + 1;
      continue;
    }
    // /* block comment */
    if (char === '/' && statement[index + 1] === '*') {
      const end = statement.indexOf('*/', index + 2);
      index = end === -1 ? statement.length : end + 2;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char as "'" | '"' | '`';
      let value = '';
      index += 1;
      while (index < statement.length) {
        const current = statement[index] as string;
        if (current === '\\' && index + 1 < statement.length) {
          // ClickHouse accepts C-style escapes inside quoted values.
          value += statement[index + 1];
          index += 2;
          continue;
        }
        if (current === quote) {
          if (statement[index + 1] === quote) {
            // Doubled quote: an escaped quote, not the end of the value.
            value += quote;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push({ kind: 'quoted', value, quote });
      continue;
    }
    if (WORD_START.test(char)) {
      let value = '';
      while (index < statement.length && WORD_BODY.test(statement[index] as string)) {
        value += statement[index];
        index += 1;
      }
      tokens.push({ kind: 'word', value });
      continue;
    }
    tokens.push({ kind: 'punct', value: char });
    index += 1;
  }

  return tokens;
}

function isWord(token: ClickHouseSqlToken | undefined, keyword: string): boolean {
  return token?.kind === 'word' && token.value.toLowerCase() === keyword;
}

/** The value an identifier position carries, whatever quoting style spelled it. */
function identifierValue(token: ClickHouseSqlToken | undefined): string | undefined {
  if (!token) return undefined;
  if (token.kind === 'word') return token.value;
  if (token.kind === 'quoted') return token.value;
  return undefined;
}

/**
 * Whether the statement carries `ON CLUSTER <cluster>` naming exactly this cluster.
 *
 * Case-insensitive in the keywords, exact in the cluster name, and indifferent to how
 * the name is spelled — bare, backtick-quoted, double-quoted or single-quoted are all the
 * same identifier to ClickHouse. A match inside a string literal cannot be mistaken for
 * the real clause because the lexer has already resolved literals into `quoted` tokens.
 */
export function statementTargetsCluster(statement: string, cluster: string): boolean {
  const tokens = tokenizeClickHouseSql(statement);
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (!isWord(tokens[index], 'on') || !isWord(tokens[index + 1], 'cluster')) continue;
    if (identifierValue(tokens[index + 2]) === cluster) return true;
  }
  return false;
}

/** Statement keywords that make the target database implicit for everything after them. */
const SESSION_SCOPE_KEYWORDS = new Set(['use', 'set']);

/**
 * The leading keyword, lowercased — `undefined` for a statement that starts with anything
 * other than a bare word.
 */
export function leadingKeyword(statement: string): string | undefined {
  const first = tokenizeClickHouseSql(statement)[0];
  return first?.kind === 'word' ? first.value.toLowerCase() : undefined;
}

const DATABASE_STATEMENT_KEYWORDS = new Set(['create', 'attach', 'drop', 'rename', 'alter']);

/**
 * Every database this statement names EXPLICITLY.
 *
 * Two shapes carry one: a qualified object (`orders.events`) and a database-level
 * statement (`CREATE DATABASE IF NOT EXISTS orders`). An unqualified object name is
 * deliberately NOT resolved against `client.database` — the point of the caller is to
 * prove which database a statement lands in, and an implicit one proves nothing.
 */
export function referencedDatabases(statement: string): readonly string[] {
  const tokens = tokenizeClickHouseSql(statement);
  const databases = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    // `<db> . <object>` — a qualified reference.
    const dotted = identifierValue(tokens[index]);
    if (
      dotted !== undefined &&
      tokens[index]?.kind !== 'punct' &&
      tokens[index + 1]?.kind === 'punct' &&
      tokens[index + 1]?.value === '.' &&
      identifierValue(tokens[index + 2]) !== undefined
    ) {
      databases.add(dotted);
      continue;
    }
    // `CREATE|ATTACH|DROP|RENAME|ALTER DATABASE [IF NOT EXISTS] <db>`
    const keyword = tokens[index];
    if (
      keyword?.kind === 'word' &&
      DATABASE_STATEMENT_KEYWORDS.has(keyword.value.toLowerCase()) &&
      isWord(tokens[index + 1], 'database')
    ) {
      let cursor = index + 2;
      // Skip `IF NOT EXISTS` / `IF EXISTS`.
      if (isWord(tokens[cursor], 'if')) {
        cursor += 1;
        if (isWord(tokens[cursor], 'not')) cursor += 1;
        if (isWord(tokens[cursor], 'exists')) cursor += 1;
      }
      const name = identifierValue(tokens[cursor]);
      if (name !== undefined) databases.add(name);
    }
  }

  return [...databases];
}

/** Why a statement is not provably cluster-wide, or `undefined` when it is. */
export interface OnClusterRejection {
  readonly statementIndex: number;
  readonly reason: string;
}

/**
 * Prove that a statement applies to every server, under `execution.mode: 'onCluster'`.
 *
 * Two proofs are accepted, and nothing else:
 *
 * - the statement carries `ON CLUSTER <cluster>`, so the initiating server distributes it
 *   through Keeper's DDL queue;
 * - every database it names is on the `replicatedDatabases` allow-list, so the
 *   `Replicated` database engine replicates the DDL itself. A statement that names NO
 *   database cannot be checked (its target depends on the session) and is rejected, as is
 *   one starting with `USE` or `SET`, which changes what later statements mean.
 *
 * The statement is never rewritten. Adding `ON CLUSTER` on the author's behalf would
 * change the semantics of DDL TypeKro did not write, and getting that wrong on a
 * production cluster is not recoverable.
 */
export function validateOnClusterStatement(
  statement: string,
  cluster: string,
  replicatedDatabases: readonly string[]
): string | undefined {
  if (statementTargetsCluster(statement, cluster)) return undefined;

  const keyword = leadingKeyword(statement);
  if (keyword !== undefined && SESSION_SCOPE_KEYWORDS.has(keyword)) {
    return (
      `starts with '${keyword.toUpperCase()}', which is session-scoped and applies only to ` +
      `the one server it runs on`
    );
  }

  const allowed = new Set(replicatedDatabases);
  if (allowed.size > 0) {
    const referenced = referencedDatabases(statement);
    if (referenced.length > 0 && referenced.every((database) => allowed.has(database))) {
      return undefined;
    }
    if (referenced.length === 0) {
      return (
        `names no database explicitly, so it cannot be shown to target one of the ` +
        `Replicated databases in 'replicatedDatabases'`
      );
    }
    const outside = referenced.filter((database) => !allowed.has(database));
    return `carries no 'ON CLUSTER ${cluster}' clause and names ${outside
      .map((database) => `'${database}'`)
      .join(', ')}, which is not in 'replicatedDatabases'`;
  }

  return (
    `carries no 'ON CLUSTER ${cluster}' clause, and no 'replicatedDatabases' allow-list ` +
    `was declared to prove it targets a Replicated database`
  );
}
