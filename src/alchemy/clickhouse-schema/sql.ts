/**
 * ClickHouse SQL text analysis: a small lexer plus the two things that read it.
 *
 * TypeKro never REWRITES a statement — an author's DDL reaches the server byte for byte.
 * It does have to READ statements for two reasons, and both need the same thing: a scan
 * that knows where a string literal starts and ends.
 *
 * 1. {@link validateOnClusterStatement} decides whether a statement is actually
 *    cluster-wide, so `execution.mode: 'onCluster'` can reject a statement that would
 *    silently land on one replica instead of rewriting it into something it wasn't.
 * 2. {@link extractStatementSecrets} collects the literals a statement contains, so the
 *    server's own error text — which quotes the offending fragment back — can be redacted
 *    against what was actually submitted rather than against a keyword list that a
 *    positional `S3('…','AKIA…','wJalr…','CSV')` walks straight past.
 *
 * Deliberately not a SQL parser. It resolves quoting and comments and nothing else; every
 * question above is answered conservatively, so an unrecognised shape is rejected (1) or
 * over-redacted (2) rather than waved through.
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

/** Statement keywords that are session-scoped, and so can never be cluster-wide. */
const SESSION_SCOPE_KEYWORDS = new Set(['use', 'set']);

/**
 * The leading keyword, lowercased — `undefined` for a statement that starts with anything
 * other than a bare word.
 */
export function leadingKeyword(statement: string): string | undefined {
  const first = tokenizeClickHouseSql(statement)[0];
  return first?.kind === 'word' ? first.value.toLowerCase() : undefined;
}

/**
 * Prove that a statement applies to every server, under `execution.mode: 'onCluster'`.
 *
 * EXACTLY ONE proof is accepted: the statement carries `ON CLUSTER <cluster>`, naming the
 * configured cluster, so the initiating server distributes it through Keeper's DDL queue.
 *
 * Nothing is INFERRED from the statement's shape. An earlier version accepted a clause-free
 * statement whose dotted references were all on a `replicatedDatabases` allow-list, which
 * keyed on the references rather than on the DDL TARGET: `CREATE TABLE events AS
 * analytics.source` passed the check while creating `events` on one server only. Deciding
 * this properly means parsing the target of every DDL form ClickHouse accepts, and a
 * parser that is subtly wrong here silently half-applies a schema — so the safe rule is
 * the explicit one, and the author writes the clause.
 *
 * The statement is never rewritten. Adding `ON CLUSTER` on the author's behalf would
 * change the semantics of DDL TypeKro did not write, and getting that wrong on a
 * production cluster is not recoverable.
 *
 * Statements that legitimately cannot carry the clause — `SET`, `USE`, a single-node
 * `SYSTEM …`, `INSERT` — do not belong under `onCluster` at all; `fanout` runs them on
 * every server itself, and reaching every server is then the author's business.
 */
export function validateOnClusterStatement(statement: string, cluster: string): string | undefined {
  if (statementTargetsCluster(statement, cluster)) return undefined;

  const keyword = leadingKeyword(statement);
  if (keyword !== undefined && SESSION_SCOPE_KEYWORDS.has(keyword)) {
    return (
      `starts with '${keyword.toUpperCase()}', which is session-scoped and applies only to ` +
      `the one server it runs on; statements that cannot carry an 'ON CLUSTER' clause ` +
      `belong under execution.mode 'fanout'`
    );
  }

  return (
    `carries no 'ON CLUSTER ${cluster}' clause, which is the only thing that makes a ` +
    `single execution reach every server; add the clause, or use execution.mode 'fanout'`
  );
}

/**
 * Keywords whose following value is a credential.
 *
 * `IDENTIFIED BY` is handled separately: it is the two-word form of the same idea.
 */
const SECRET_KEYWORDS = new Set([
  'password',
  'token',
  'access_key_id',
  'secret_access_key',
  'aws_access_key_id',
  'aws_secret_access_key',
]);

/**
 * Below this length a "secret" is not one, and blanking it out of the server's message
 * would destroy the message without protecting anything.
 */
const MIN_SECRET_LENGTH = 3;

/**
 * Every value in the SUBMITTED statement that must not survive into a captured message.
 *
 * Deliberately over-broad: EVERY single-quoted literal counts, not only the ones a
 * keyword introduces. That is the whole point — the case keyword matching misses is the
 * positional one, `S3('https://…', '<key id>', '<secret>', 'CSV')`, where nothing in the
 * text says which argument is the credential. Redacting a harmless literal costs a word
 * of an error message; leaking the other kind costs the key.
 */
export function extractStatementSecrets(statement: string): readonly string[] {
  const tokens = tokenizeClickHouseSql(statement);
  const secrets = new Set<string>();

  const add = (value: string | undefined) => {
    if (value !== undefined && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === 'quoted' && token.quote === "'") {
      add(token.value);
      continue;
    }
    if (token?.kind !== 'word') continue;

    const keyword = token.value.toLowerCase();
    let cursor = index + 1;
    if (keyword === 'identified') {
      if (!isWord(tokens[cursor], 'by')) continue;
      cursor += 1;
      // `IDENTIFIED WITH sha256_password BY '…'` also lands here via the BY token.
    } else if (!SECRET_KEYWORDS.has(keyword)) {
      continue;
    }
    // Step over an assignment or separator between the keyword and its value.
    while (
      tokens[cursor]?.kind === 'punct' &&
      ['=', ':', '(', ','].includes(tokens[cursor]?.value ?? '')
    ) {
      cursor += 1;
    }
    add(identifierValue(tokens[cursor]));
  }

  return [...secrets];
}
