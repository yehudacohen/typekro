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
  | {
      readonly kind: 'quoted';
      /** The DECODED value — what the server actually receives. */
      readonly value: string;
      /**
       * The SOURCE slice between the quotes, escapes intact.
       *
       * Kept alongside the decoded value because ClickHouse echoes a bad fragment back in
       * whichever spelling it feels like, and `pa\'ss` and `pa''ss` are the same secret as
       * `pa'ss`. Redaction has to blank all of them; see {@link extractStatementSecrets}.
       */
      readonly raw: string;
      readonly quote: "'" | '"' | '`';
    }
  | { readonly kind: 'punct'; readonly value: string };

const WORD_START = /[A-Za-z_]/;
const WORD_BODY = /[A-Za-z0-9_$]/;

/**
 * ClickHouse's C-style escape table — the SINGLE source of truth for both directions.
 *
 * Reading it wrong is a redaction hole, not a cosmetic bug: a decoder that turns every
 * `\c` into `c` decodes `\n` to the letter `n`, so a credential whose value contains a
 * newline is extracted in a spelling the server never emits, and the real decoded form
 * survives into the retained error text. Both directions therefore come from this one
 * table: {@link decodeEscape} reads it, {@link escapeClickHouseString} inverts it, and a
 * raw source spelling and its decoded value round-trip.
 *
 * Each entry is `[<character after the backslash>, <what the server decodes it to>]`, per
 * https://clickhouse.com/docs/sql-reference/syntax#string. Handled outside the table
 * because neither is a single character mapping: `\xHH` (a byte, see {@link decodeEscape})
 * and `\N` (documented as "reserved, does nothing" — `SELECT 'a\Nb'` returns `ab`, so it
 * decodes to the empty string).
 *
 * @see https://clickhouse.com/docs/sql-reference/syntax#string
 */
const CLICKHOUSE_ESCAPES: ReadonlyArray<readonly [escape: string, decoded: string]> = [
  ['a', '\x07'], // alert
  ['b', '\b'], // backspace
  ['e', '\x1b'], // escape character
  ['f', '\f'], // form feed
  ['n', '\n'], // line feed
  ['r', '\r'], // carriage return
  ['t', '\t'], // horizontal tab
  ['v', '\v'], // vertical tab
  ['0', '\0'], // null character
  ['\\', '\\'],
  ["'", "'"], // `''` is the other spelling, resolved by the tokenizer's doubling branch
  ['"', '"'],
  ['`', '`'],
  ['/', '/'],
  ['=', '='],
];

const ESCAPE_DECODE = new Map(CLICKHOUSE_ESCAPES);

/**
 * The inverse table, restricted to the characters a single-quoted literal cannot carry
 * verbatim: the backslash, the single quote, and the control characters the table names
 * (every one of them is `<= 31`, which is how ClickHouse itself decides to drop the
 * backslash). A `"`, a backtick, a `/` or an `=` needs no escape inside `'…'`, so the
 * source spelling ClickHouse would echo for those is the character itself.
 */
const ESCAPE_ENCODE = new Map(
  CLICKHOUSE_ESCAPES.filter(
    ([, decoded]) => decoded === '\\' || decoded === "'" || decoded <= '\x1f'
  ).map(([escape, decoded]): readonly [string, string] => [decoded, `\\${escape}`])
);

const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;

/**
 * Decode the one backslash escape starting at `index` (which points AT the backslash).
 *
 * Returns the decoded text and how many SOURCE characters it consumed, so the tokenizer
 * can keep the raw slice and the decoded value in step.
 *
 * The default branch is the one the previous implementation got wrong, and the
 * documentation is explicit about it: "The backslash loses its special meaning i.e. it is
 * interpreted literally should it precede characters other than the ones listed below."
 * So an unlisted `\c` decodes to BOTH characters — `\z` is a backslash and a `z`, not a
 * `z` — which is what lets `'Hello 100\%'` reach a `LIKE` pattern intact.
 *
 * @see https://clickhouse.com/docs/sql-reference/syntax#string
 */
function decodeEscape(statement: string, index: number): { text: string; consumed: number } {
  const next = statement[index + 1];
  // A trailing backslash: nothing follows it to escape, so it is itself.
  if (next === undefined) return { text: '\\', consumed: 1 };
  if (next === 'x') {
    // `\xHH`: an 8-bit character. Exactly two hex digits, as the server's own parser
    // reads. Anything else is not the escape, so the backslash stays literal.
    const hex = statement.slice(index + 2, index + 4);
    if (HEX_PAIR.test(hex)) {
      return { text: String.fromCharCode(Number.parseInt(hex, 16)), consumed: 4 };
    }
    return { text: '\\x', consumed: 2 };
  }
  // `\N` is reserved and does nothing: `SELECT 'a\Nb'` returns `ab`.
  if (next === 'N') return { text: '', consumed: 2 };
  const decoded = ESCAPE_DECODE.get(next);
  if (decoded !== undefined) return { text: decoded, consumed: 2 };
  return { text: `\\${next}`, consumed: 2 };
}

/**
 * The C-style SOURCE spelling of a decoded value, inverting {@link CLICKHOUSE_ESCAPES}.
 *
 * `decode(escapeClickHouseString(value)) === value` for every value, which is the property
 * redaction needs: a secret's raw and decoded spellings have to be two views of one string,
 * or one of them survives into an error message.
 */
export function escapeClickHouseString(value: string): string {
  let escaped = '';
  for (const char of value) {
    escaped += ESCAPE_ENCODE.get(char) ?? char;
  }
  return escaped;
}

/**
 * Split a statement into words, quoted values and single punctuation characters.
 *
 * Comments (`--`, `#`, `/* … *\/`) are dropped. Quoted values are returned DECODED — the
 * doubling and backslash escapes ClickHouse accepts are resolved — because both callers
 * compare against the value the server sees. The SOURCE slice is returned as well, because
 * the server may echo back either spelling.
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
      const start = index;
      // An unterminated literal ends at the end of the statement, and its source slice with it.
      let end = statement.length;
      while (index < statement.length) {
        const current = statement[index] as string;
        if (current === '\\') {
          // ClickHouse accepts C-style escapes inside quoted values; the table in
          // CLICKHOUSE_ESCAPES is what says how each one decodes.
          const { text, consumed } = decodeEscape(statement, index);
          value += text;
          index += consumed;
          continue;
        }
        if (current === quote) {
          if (statement[index + 1] === quote) {
            // Doubled quote: an escaped quote, not the end of the value.
            value += quote;
            index += 2;
            continue;
          }
          end = index;
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push({ kind: 'quoted', value, raw: statement.slice(start, end), quote });
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

/** `'` doubled, the spelling `''` comes from. */
function doubleQuoteEscaped(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Every spelling of one literal that could appear in the server's output.
 *
 * A credential containing a quote, a backslash or a control character has TWO source
 * spellings (`pa\'ss` and `pa''ss`) plus the decoded value (`pa'ss`), and ClickHouse echoes
 * back whichever one it feels like — frequently the source form, since what it is
 * complaining about is the text it was given. Redacting only the decoded value therefore
 * leaves the escaped form of the secret sitting in the error. All of them are returned; for
 * the overwhelmingly common literal that contains none of those characters they collapse to
 * a single string.
 *
 * The re-escaped form comes from {@link escapeClickHouseString}, which inverts the very
 * table the decoder read, so the decoded value and its C-style spelling are guaranteed to be
 * two views of one string rather than two independently-guessed ones.
 */
function secretForms(token: ClickHouseSqlToken | undefined): readonly string[] {
  if (token === undefined || token.kind === 'punct') return [];
  if (token.kind === 'word') return [token.value];
  return [
    token.value,
    token.raw,
    escapeClickHouseString(token.value),
    doubleQuoteEscaped(token.value),
  ];
}

/**
 * Every value in the SUBMITTED statement that must not survive into a captured message,
 * in every spelling it could be echoed in, LONGEST FIRST.
 *
 * Deliberately over-broad: EVERY single-quoted literal counts, not only the ones a
 * keyword introduces. That is the whole point — the case keyword matching misses is the
 * positional one, `S3('https://…', '<key id>', '<secret>', 'CSV')`, where nothing in the
 * text says which argument is the credential. Redacting a harmless literal costs a word
 * of an error message; leaking the other kind costs the key.
 *
 * Longest first so that replacing one form cannot leave a shorter form of the same secret
 * stranded inside what is left of a longer one.
 */
export function extractStatementSecrets(statement: string): readonly string[] {
  const tokens = tokenizeClickHouseSql(statement);
  const secrets = new Set<string>();

  const add = (values: readonly string[]) => {
    for (const value of values) {
      if (value.length >= MIN_SECRET_LENGTH) secrets.add(value);
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === 'quoted' && token.quote === "'") {
      add(secretForms(token));
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
    add(secretForms(tokens[cursor]));
  }

  return [...secrets].sort(
    (left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0)
  );
}
