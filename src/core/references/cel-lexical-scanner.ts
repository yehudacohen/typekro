/** Preserve offsets while hiding quoted CEL data from reference scanners. */
export function maskCelStringLiterals(expression: string): string {
  const characters = [...expression];
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote === undefined) {
      if (character === '"' || character === "'") {
        quote = character;
        characters[index] = ' ';
      }
      continue;
    }
    characters[index] = ' ';
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === quote) {
      quote = undefined;
    }
  }
  return characters.join('');
}

/** Half-open `[start, end)` range of one closed CEL string literal, quotes included. */
export interface CelStringLiteralSpan {
  readonly start: number;
  readonly end: number;
}

/** CEL `IDENT ::= [_a-zA-Z][_a-zA-Z0-9]*` — first character, then the rest. */
const CEL_IDENT_START = /[A-Za-z_]/;
const IDENT_CHARACTER = /[A-Za-z0-9_]/;

/** The four `STRING_LIT` delimiters, longest first so `"""` beats `"`. */
const CEL_STRING_DELIMITERS = ['"""', "'''", '"', "'"] as const;

/**
 * End of the `STRING_LIT`/`BYTES_LIT` token starting at `at`, or `at` for none.
 *
 * The langdef lexis (cel-spec `doc/langdef.md`) is
 * `STRING_LIT ::= [rR]? ( '"' ~('"'|NEWLINE)* '"' | "'" ~("'"|NEWLINE)* "'"`
 * `| '"""' ~'"""'* '"""' | "'''" ~"'''"* "'''" )` and
 * `BYTES_LIT ::= [bB] STRING_LIT`. cel-go accepts the two prefix letters in
 * either order and in either case, so at most one of each is taken. A prefix
 * letter with no quote behind it is not a string at all and is handed back for
 * `IDENT` to consume, which is what makes `b + "x"` an identifier, an operator
 * and a string rather than a bytes literal.
 *
 * Escapes are lexed in the NON-raw forms only: cel-go's lexer spells the raw
 * forms `RAW '"' ~["\n\r]* '"'`, with no `ESC_SEQ` alternative, so the `"` in
 * `r"a\"` CLOSES the literal. A single-delimiter form cannot span a newline; a
 * triple-quoted one can, and closes at the first matching triple. An
 * unterminated literal is not a token — the caller then steps over the opening
 * quote as ordinary text, which is the behaviour marker-laden template text
 * depends on.
 */
function celStringLiteralEnd(text: string, at: number): number {
  let index = at;
  let raw = false;
  let bytes = false;
  for (let take = 0; take < 2; take += 1) {
    const character = text[index];
    if (!raw && (character === 'r' || character === 'R')) {
      raw = true;
      index += 1;
    } else if (!bytes && (character === 'b' || character === 'B')) {
      bytes = true;
      index += 1;
    } else break;
  }

  const delimiter = CEL_STRING_DELIMITERS.find((candidate) => text.startsWith(candidate, index));
  if (delimiter === undefined) return at;

  for (let scan = index + delimiter.length; scan < text.length; scan += 1) {
    const character = text[scan] as string;
    if (!raw && character === '\\') {
      if (scan + 1 >= text.length) return at;
      scan += 1;
      continue;
    }
    if (delimiter.length === 1 && (character === '\n' || character === '\r')) return at;
    if (text.startsWith(delimiter, scan)) return scan + delimiter.length;
  }
  return at;
}

/** What a masked region of an expression is: quoted data, or a line comment. */
type CelLiteralRegionKind = 'string' | 'comment';

/** One closed literal or comment, as the source-ordered walk found it. */
interface CelLiteralRegion extends CelStringLiteralSpan {
  readonly kind: CelLiteralRegionKind;
}

/**
 * End of the `COMMENT ::= '//' ~NEWLINE*` starting at `at`, or `at` for none.
 *
 * The comment stops BEFORE its newline, so masking one never disturbs the line
 * structure of a multi-line expression.
 */
function celLineCommentEnd(text: string, at: number): number {
  if (text[at] !== '/' || text[at + 1] !== '/') return at;
  const newline = text.slice(at).search(/[\r\n]/);
  return newline < 0 ? text.length : at + newline;
}

/**
 * Locate every closed string literal AND every line comment, in ONE
 * source-ordered walk.
 *
 * Two orderings are what a strings-only scan gets wrong, and both fall out of
 * walking in source order: a `//` INSIDE a string literal is part of the
 * literal and opens no comment (`"a // b"` is a string), and a quote INSIDE a
 * comment is part of the comment and opens no literal (`// it's` does not open
 * one, where a strings-only scan would flip the masking of everything after
 * that apostrophe).
 */
function celLiteralRegions(expression: string): CelLiteralRegion[] {
  const regions: CelLiteralRegion[] = [];
  let index = 0;
  while (index < expression.length) {
    const commentEnd = celLineCommentEnd(expression, index);
    if (commentEnd > index) {
      regions.push({ kind: 'comment', start: index, end: commentEnd });
      index = commentEnd;
      continue;
    }
    const literalEnd = celStringLiteralEnd(expression, index);
    if (literalEnd > index) {
      regions.push({ kind: 'string', start: index, end: literalEnd });
      index = literalEnd;
      continue;
    }
    if (CEL_IDENT_START.test(expression[index] as string)) {
      index += 1;
      while (index < expression.length && IDENT_CHARACTER.test(expression[index] as string)) {
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return regions;
}

/** Blank `regions` out of `expression`, one space per UTF-16 code unit. */
function blankRegions(expression: string, regions: readonly CelStringLiteralSpan[]): string {
  if (regions.length === 0) return expression;
  const characters = expression.split('');
  for (const region of regions) {
    for (let index = region.start; index < region.end; index += 1) {
      characters[index] = ' ';
    }
  }
  return characters.join('');
}

/**
 * Locate every CLOSED CEL string literal in `expression`, in source order.
 *
 * The whole `STRING_LIT`/`BYTES_LIT` family is recognised — `r`/`R`/`b`/`B`
 * prefixes in either order, the two triple-quoted forms, escapes in the non-raw
 * forms — and the span INCLUDES the prefix letters, because they are part of
 * the token.
 *
 * The walk is source-ordered and consumes an `IDENT` whole, which is what keeps
 * a prefix letter that merely ENDS an identifier from opening a literal:
 * `ab"x"` is the identifier `ab` followed by a string, never a bytes literal.
 * Restarting the scan at every character cannot make that distinction. A quote
 * inside a `//` comment opens no literal — see {@link celLiteralRegions}.
 *
 * A quote that is never terminated is NOT reported as a literal: callers run
 * over text that is not always well-formed CEL — marker-laden strings derived
 * from template literals may carry a bare apostrophe (`it's ready`) — and
 * swallowing the rest of such a string would silently suppress substitutions
 * in real expression text. Offsets index UTF-16 code units so a caller can
 * splice by them.
 */
export function celStringLiteralSpans(expression: string): CelStringLiteralSpan[] {
  return celLiteralRegions(expression)
    .filter((region) => region.kind === 'string')
    .map(({ start, end }) => ({ start, end }));
}

/**
 * Blank out every CLOSED CEL string literal AND every `//` line comment.
 *
 * This is what a scanner that REWRITES an expression must read: a token inside
 * quoted data is not a reference, and neither is one inside a comment. Offsets
 * and length are preserved exactly — one space per UTF-16 code unit, newlines
 * left in place — so a caller may match over the masked copy and splice
 * replacements into the original text at the reported offsets.
 */
export function maskClosedCelLiteralsAndComments(expression: string): string {
  return blankRegions(expression, celLiteralRegions(expression));
}

export interface CelLambdaScope {
  readonly variable: string;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/**
 * Locate each lexical CEL collection-macro body without treating a lambda
 * identifier as expression-global.
 */
export function collectCelLambdaScopes(expression: string): CelLambdaScope[] {
  const scopes: CelLambdaScope[] = [];
  const macroPattern = /\.(?:all|exists|exists_one|map|filter)\s*\(/g;
  let match: RegExpExecArray | null = macroPattern.exec(expression);

  while (match !== null) {
    const openParen = expression.indexOf('(', match.index);
    const parsed = parseCelMacroArguments(expression, openParen);
    if (parsed) {
      const variable = expression.slice(parsed.firstArgumentStart, parsed.firstArgumentEnd).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
        scopes.push({
          variable,
          bodyStart: parsed.bodyStart,
          bodyEnd: parsed.closeParen,
        });
      }
    }
    match = macroPattern.exec(expression);
  }
  return scopes;
}

export function isCelLambdaLocalAt(
  identifier: string,
  offset: number,
  scopes: readonly CelLambdaScope[]
): boolean {
  return scopes.some(
    (scope) => scope.variable === identifier && offset >= scope.bodyStart && offset < scope.bodyEnd
  );
}

function parseCelMacroArguments(
  expression: string,
  openParen: number
):
  | {
      readonly firstArgumentStart: number;
      readonly firstArgumentEnd: number;
      readonly bodyStart: number;
      readonly closeParen: number;
    }
  | undefined {
  if (openParen < 0 || expression[openParen] !== '(') return undefined;

  const stack: string[] = ['('];
  let firstComma: number | undefined;
  for (let index = openParen + 1; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === '(' || character === '[' || character === '{') {
      stack.push(character);
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      const expected = character === ')' ? '(' : character === ']' ? '[' : '{';
      if (stack.at(-1) !== expected) return undefined;
      stack.pop();
      if (stack.length === 0) {
        if (firstComma === undefined) return undefined;
        return {
          firstArgumentStart: openParen + 1,
          firstArgumentEnd: firstComma,
          bodyStart: firstComma + 1,
          closeParen: index,
        };
      }
      continue;
    }
    if (character === ',' && stack.length === 1 && firstComma === undefined) {
      firstComma = index;
    }
  }
  return undefined;
}
