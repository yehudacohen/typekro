/**
 * Dual-dialect compatibility check for emitted status CEL.
 *
 * TypeKro emits one CEL expression per dynamic status field and then runs it
 * through **two different engines**: `cel-js` evaluates it locally in direct
 * mode, and `cel-go` (inside the KRO controller, with KRO's type environment)
 * evaluates it in Kro mode. The two disagree in ways that only surface when the
 * expression meets real data on a live cluster — one engine returns a value and
 * the other rejects the expression or blows up on a missing field.
 *
 * This module runs every emitted status expression through cel-js's own parser
 * **and** a curated denylist of the divergences we have confirmed, so an
 * expression that only one engine accepts fails at serialization time with the
 * expression, the status leaf it came from, and the dialect that rejects it.
 *
 * ## cel-js's parser is not the CEL grammar
 *
 * cel-js 0.8.2 parses a proper subset of CEL, so a `parse()` failure is a fact
 * about **direct mode only**. Its `atomicExpression` rule takes a postfix
 * `.`/`[` after an identifier (and after a map literal, and one index after a
 * list literal) and nowhere else, while the spec's `Member` production takes a
 * postfix on any `Member` and `Primary` includes both `LITERAL` and
 * `"(" Expr ")"` — so `"x".size()`, `[1,2].size()`, `(a).b` and `size(a).b` are
 * all valid CEL that cel-js rejects, and its lexer has neither the exponent
 * `FLOAT_LIT` form nor the `r`/`b`/triple-quoted `STRING_LIT` forms. Inferring
 * "cel-go would reject this too" from a cel-js parse failure is therefore
 * unsound, and the parse half does not do it: it sorts a failure into
 * `not-valid-cel` (a form the *spec's* grammar has no token or production for),
 * `cel-js-rejects-spec-cel` (a positively identified cel-js shortfall — a real
 * divergence) or `cel-js-parse-failure` (no verdict beyond direct mode).
 *
 * ## Why a denylist rather than a real cel-go
 *
 * cel-go is a Go library; there is no in-process cel-go for a TypeScript
 * serializer to consult, and shelling out to one would make `toYaml()` depend
 * on a Go toolchain. The denylist is therefore a deliberately *curated*,
 * documented set of confirmed divergences rather than a general type checker.
 * It is meant to grow: each rule below records what was observed and on which
 * engine, so a new entry can be justified the same way.
 *
 * ## What may fail strict mode
 *
 * A rule may fail strict mode only when the two engines genuinely **diverge** on
 * the form: there is data for which one engine yields a value and the other does
 * not. That bar rules out two tempting kinds of rule, and both are deliberately
 * excluded rather than merely unwritten.
 *
 * - **Anything that needs a CEL *type* to be a divergence.** Syntax does not
 *   establish a type. `x[0]` is a list index against one schema and a map lookup
 *   against another; `"k" in e` is fine when `e` is a map and rejected when
 *   cel-go's type env has typed `e` as a message. The real types live in the
 *   referenced resources' Kubernetes schemas, and nothing at this call site has
 *   them: the check receives the serialized status map — expression text naming
 *   graph resources by id — and TypeKro's `Enhanced<>` types are erased before
 *   serialization runs. A rule that guesses a type from bracket shape fails
 *   strict mode on valid CEL, so such rules are reported as notes instead.
 * - **Forms both engines treat the same.** Indexing a required list inside a
 *   logical chain is the worked example: `size(l) > 0 && l[0].f != ""` returns
 *   `false` on an empty `l` in both engines (cel-js short-circuits, cel-go
 *   absorbs the error under a deciding `false`), and an out-of-range index
 *   errors on both. Nothing diverges, so nothing is reported.
 *
 * Findings that do not clear the bar are still worth surfacing, so each rule
 * declares a {@link CelDialectFindingKind}: `divergence` findings abort
 * serialization in strict mode, `note` findings never do and are logged in both
 * modes. Strictness otherwise follows the shared CEL diagnostics convention
 * (`strictCelDiagnostics` factory option, `TYPEKRO_STRICT_CEL=1`).
 */

import { parse } from 'cel-js';
import {
  collectCelLambdaScopes,
  isCelLambdaLocalAt,
  maskCelStringLiterals,
} from '../references/cel-lexical-scanner.js';

/**
 * The CEL engine that rejects — or diverges on — an expression.
 *
 * `'both'` marks a form neither engine accepts, which is a defect but not a
 * divergence. `'unchecked'` is not an engine at all: it marks a finding where no
 * verdict was reached, because the expression was past the analysis budget.
 */
export type CelDialect = 'cel-js' | 'cel-go' | 'both' | 'unchecked';

/**
 * Whether a finding may fail strict mode.
 *
 * - `divergence` — the two engines demonstrably disagree on this form, with no
 *   appeal to a type the checker cannot see. Fails strict mode.
 * - `note` — worth reporting, but not a proven divergence: either both engines
 *   reject the form (a defect, but the same defect on each), or the divergence
 *   is conditional on a type the checker has no way to establish, or no verdict
 *   was reached at all. Never fails strict mode, in either strictness setting.
 */
export type CelDialectFindingKind = 'divergence' | 'note';

/** Identifier for a curated dual-dialect rule. */
export type CelDialectRuleId =
  | 'not-valid-cel'
  | 'cel-js-rejects-spec-cel'
  | 'cel-js-parse-failure'
  | 'has-index-argument'
  | 'in-on-list-entry'
  | 'guard-after-use-in-logical-chain'
  | 'heterogeneous-map-literal'
  | 'expression-too-large';

/**
 * Largest expression this module will analyze, in characters.
 *
 * Both halves of the check cost roughly a microsecond per character — cel-js's
 * parser dominates — so the cost is linear in the length of the expression and
 * the only way it can run away is for the expression itself to run away.
 *
 * The budget is set from what TypeKro actually emits. Across the unit suite the
 * median status expression is under 100 characters, the 99th percentile is
 * ~1.6k, and the largest authored one is ~3.3k. 16 KiB leaves roughly five
 * times the headroom over the largest real expression while capping the check
 * at ~16ms for any single leaf.
 *
 * Anything past this is not an authored status field. The known source is a
 * nested composition whose inlined status re-expands into itself, doubling per
 * level until the depth limit stops it — which yields a multi-megabyte
 * expression that no engine can use: cel-js needs seconds to parse it on every
 * direct-mode reconcile, and a ResourceGraphDefinition carrying it is past the
 * Kubernetes object size limit, so the API server refuses it outright.
 */
export const CEL_DIALECT_MAX_EXPRESSION_LENGTH = 16_384;

/**
 * How many levels of bracket nesting the span walks will descend.
 *
 * Both the lazy-region blanking and the logical-chain walk recurse once per
 * nested group, and they now run on text cel-js could not parse — where a
 * runaway `((((…` is exactly the shape that shows up. Nesting is bounded by the
 * expression length, so 16 KiB of open parens is 8k levels of recursion and a
 * blown stack; the parse gate used to hide that by returning first.
 *
 * 64 is far past anything an emitted status expression reaches — the deepest in
 * the unit suite is single digits — and stopping the descent only means a
 * finding deeper than that is not reported, which is the safe direction.
 */
const CEL_DIALECT_MAX_NESTING_DEPTH = 64;

/** A single dual-dialect incompatibility found in an emitted expression. */
export interface CelDialectFinding {
  /** Which curated rule matched. */
  readonly rule: CelDialectRuleId;
  /** Whether this finding may fail strict mode. */
  readonly kind: CelDialectFindingKind;
  /** The engine that rejects or diverges on this expression. */
  readonly dialect: CelDialect;
  /** The status leaf path the expression was emitted for. */
  readonly field: string;
  /** The emitted CEL expression. */
  readonly expression: string;
  /** The offending fragment, when the rule can isolate one. */
  readonly fragment?: string;
  /** What the engine does with it. */
  readonly message: string;
  /** How to write it so both engines accept it. */
  readonly suggestion: string;
}

/**
 * The curated denylist.
 *
 * Every entry names the engine that rejects the form, whether the entry counts
 * as a divergence, and the observation behind it. Keep this table and
 * {@link checkCelDialectCompatibility} in step.
 */
export const CEL_DIALECT_RULES: readonly {
  readonly id: CelDialectRuleId;
  readonly kind: CelDialectFindingKind;
  readonly dialect: CelDialect;
  readonly summary: string;
  readonly observed: string;
}[] = [
  {
    id: 'has-index-argument',
    kind: 'divergence',
    dialect: 'cel-js',
    summary: 'has() applied to an index expression',
    observed:
      'cel-js raises "has() does not support atomic expressions" whenever the operand of has() is an index — `has(list[0].field)` and `has(map["k"].field)` alike, so this is about the shape of the macro argument and not about the type of what is indexed. cel-go\'s has() macro accepts any select expression, index included',
  },
  {
    id: 'guard-after-use-in-logical-chain',
    kind: 'divergence',
    dialect: 'cel-js',
    summary: 'a has() guard placed to the right of the access it guards, in the operator\'s guarding polarity',
    observed:
      'cel-go absorbs an error in one operand of && / || when the other operand decides the result, regardless of order; cel-js evaluates left to right and propagates the error before the guard is ever reached. The divergence needs no type: the guard itself says the author expects the path to be absent sometimes. Which form is the guard follows the operator: `&&` is decided by `false`, so `has(p)` guards there, while `||` is decided by `true`, so `!has(p)` is the guarding form and the late-guard mirror',
  },
  {
    id: 'heterogeneous-map-literal',
    kind: 'divergence',
    dialect: 'cel-js',
    summary: 'a CEL map literal whose values are not all of one type',
    observed:
      'cel-js pins a map literal\'s value type to that of its first entry and throws "invalid_argument: <value>" on the first entry that differs (cel-js 0.8.2, `mapExpression` in its visitor), so `{"name": "http", "port": 80}` cannot be evaluated at all; cel-go types the literal as `map(string, dyn)` when the entry types differ and evaluates it. The divergence needs no schema: the differing types are written out in the literal itself. Lists are unaffected — cel-js evaluates `[1, "a"]` — and a single-entry or empty map is always fine',
  },
  {
    id: 'in-on-list-entry',
    kind: 'note',
    dialect: 'cel-go',
    summary: '`in` applied to something that may be a typed list entry',
    observed:
      "KRO's cel-go type env types a *message* list entry as a message rather than a map and reports \"no matching overload for '@in'\", where cel-js accepts it. Whether the entry here is a message or a map is a fact about the referenced resource's schema, which this check cannot see, so the form is reported for information rather than failed",
  },
  {
    id: 'cel-js-rejects-spec-cel',
    kind: 'divergence',
    dialect: 'cel-js',
    summary: 'a form the CEL grammar permits and cel-js is known not to parse',
    observed:
      "cel-js 0.8.2 is not a conformant CEL parser. Its `atomicExpression` rule (dist/parser.js) allows a postfix `.`/`[` only after an Identifier — plus one index after a list literal, and any postfix after a map literal — while the spec's `Member = Primary | Member \".\" SELECTOR [\"(\" [ExprList] \")\"] | Member \"[\" Expr \"]\"` allows a postfix on *any* Member, and `Primary` includes `LITERAL` and `\"(\" Expr \")\"` (cel-spec doc/langdef.md, \"Syntax\"). Its lexer is short of the spec's `FLOAT_LIT` (no EXPONENT form) and `STRING_LIT`/`BYTES_LIT` (no `r`/`R`/`b`/`B` prefix, no triple-quoted form). Each form below is confirmed to fail `parse()` and is grammatical CEL, so cel-go parses it: the field resolves under KRO and direct mode can never evaluate it. That is a divergence, not a defect in the expression",
  },
  {
    id: 'not-valid-cel',
    kind: 'note',
    dialect: 'both',
    summary: 'the text contains something no CEL grammar accepts',
    observed:
      "matched against the spec's own lexical and syntactic grammar rather than against an engine: `=` outside `==`/`!=`/`<=`/`>=` is not a CEL token at all (the punctuation list in cel-spec doc/langdef.md is `() [] {} . , ? : || && ! < <= >= > == != in + - * / %`), `$` is in neither the punctuation list nor `IDENT`, and a `?` with no matching `:` cannot close `Expr = ConditionalOr [\"?\" ConditionalOr \":\" Expr]`. These are the converter-leakage forms — `===`, `!==`, `=>`, `${`, `?.`, `?[`. Neither engine can evaluate them, so this is a defect rather than a divergence. Note cel-js's *lexer* silently drops a character it has no token for, so `a === b` reaches its parser as `a == b` and \"parses\" — this check therefore runs whether or not cel-js parsed",
  },
  {
    id: 'cel-js-parse-failure',
    kind: 'note',
    dialect: 'cel-js',
    summary: 'cel-js cannot parse the expression and no positive verdict was reached',
    observed:
      "cel-js's parser rejected the text and neither the non-CEL token scan nor the confirmed cel-js-limitation checks explain why. A cel-js parse failure on its own says only that *direct mode* cannot evaluate the field: cel-js is not a conformant CEL grammar, so it establishes nothing about cel-go or KRO. Reported so the field is visible, never failed",
  },
  {
    id: 'expression-too-large',
    kind: 'note',
    dialect: 'unchecked',
    summary: 'the expression is past the analysis budget, so neither half of the check ran',
    observed:
      'a nested composition whose inlined status re-expands into itself doubles the expression per level, reaching megabytes; parsing one costs seconds per call and the ResourceGraphDefinition carrying it is past the Kubernetes object size limit. No dialect verdict was reached, so there is no divergence to report',
  },
] as const;

/** True when any finding in the set may fail strict mode. */
export function hasCelDialectDivergence(findings: readonly CelDialectFinding[]): boolean {
  return findings.some((found) => found.kind === 'divergence');
}

/** A `[start, end)` slice of an expression. */
interface Span {
  readonly start: number;
  readonly end: number;
}

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchingParen(text: string, open: number): number {
  const stack: string[] = [];
  for (let index = open; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === '(' || character === '[' || character === '{') {
      stack.push(character);
      continue;
    }
    const opener = CLOSERS[character];
    if (opener !== undefined) {
      if (stack.pop() !== opener) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

/**
 * Split `[start, end)` on the given separators, ignoring anything nested inside
 * brackets. Separators are matched as whole tokens.
 */
function splitTopLevel(masked: string, span: Span, separators: readonly string[]): Span[] {
  const parts: Span[] = [];
  let depth = 0;
  let partStart = span.start;
  let index = span.start;
  while (index < span.end) {
    const character = masked[index] as string;
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 0) {
      const separator = separators.find((candidate) => masked.startsWith(candidate, index));
      if (separator !== undefined) {
        parts.push({ start: partStart, end: index });
        index += separator.length;
        partStart = index;
        continue;
      }
    }
    index += 1;
  }
  parts.push({ start: partStart, end: span.end });
  return parts;
}

/** Top-level parenthesized groups inside a span, as interior spans. */
function parenGroups(masked: string, span: Span): Span[] {
  const groups: Span[] = [];
  let index = span.start;
  while (index < span.end) {
    if (masked[index] === '(') {
      const close = matchingParen(masked, index);
      if (close < 0 || close > span.end) break;
      groups.push({ start: index + 1, end: close });
      index = close + 1;
      continue;
    }
    index += 1;
  }
  return groups;
}

const DOTTED_PATH = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g;

function blankRange(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(Math.max(0, end - start)) + text.slice(end);
}

/**
 * Blank out the regions of an expression that are *not* part of the enclosing
 * logical chain's eager evaluation:
 *
 * - **Collection-macro bodies.** `list.exists(c, ...)` binds `c` per entry, and
 *   a `has(c.x)` in one operand's lambda says nothing about another operand's
 *   lambda variable of the same name.
 * - **Nested ternaries.** A parenthesized group containing a top-level `?` is
 *   lazy in both engines, so its branches cannot make the chain diverge. The
 *   group is analyzed on its own by the recursion in `checkLogicalChain`.
 *
 * Offsets are preserved so spans stay valid against the original expression.
 */
function blankLazyRegions(masked: string): string {
  let blanked = masked;
  for (const scope of collectCelLambdaScopes(masked)) {
    blanked = blankRange(blanked, scope.bodyStart, scope.bodyEnd);
  }
  const blankTernaryGroups = (span: Span, depth: number): void => {
    if (depth > CEL_DIALECT_MAX_NESTING_DEPTH) return;
    let index = span.start;
    while (index < span.end) {
      if (blanked[index] === '(') {
        const close = matchingParen(blanked, index);
        if (close < 0 || close > span.end) return;
        const interior = { start: index + 1, end: close };
        if (splitTopLevel(blanked, interior, ['?']).length > 1) {
          blanked = blankRange(blanked, interior.start, interior.end);
        } else {
          blankTernaryGroups(interior, depth + 1);
        }
        index = close + 1;
        continue;
      }
      index += 1;
    }
  };
  blankTernaryGroups({ start: 0, end: blanked.length }, 0);
  return blanked;
}

/**
 * Which operator joins the operands of a chain.
 *
 * The two differ in their *absorbing* value — the one that lets cel-go decide
 * the chain without the other operand — and that is the whole reason polarity
 * matters. `&&` is absorbed by `false`, `||` by `true`.
 */
type ChainMode = 'and' | 'or';

const GUARD_OPERAND = /^has\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)\s*$/;

/**
 * Read one operand as a possibly-negated `has()` guard.
 *
 * Deliberately whole-operand: the operand has to reduce, after stripping
 * whitespace, `!` operators and balanced enclosing parentheses, to exactly
 * `has(<dotted path>)`. That is what makes the *polarity* readable. A `has()`
 * buried in a larger boolean operand — `has(p) == true`, `x || has(p)` inside a
 * conjunct — has no single polarity with respect to the enclosing chain, so it
 * is not read as a guard in either direction: it neither establishes a path nor
 * is reported as a late guard.
 *
 * Group negation is handled to the extent the masked-span machinery allows:
 * `!has(p)`, `!(has(p))` and `!!has(p)` all parse, because stripping is purely
 * lexical and each step keeps the operand a single `has()`. `!(has(p) && q)`
 * does not, and is treated as "not a guard" rather than guessed at — negating a
 * compound is not a statement about `p` on its own.
 */
function chainGuard(blanked: string, span: Span): { path: string; negated: boolean } | undefined {
  let text = blanked.slice(span.start, span.end).trim();
  let negated = false;
  for (;;) {
    if (text.startsWith('!')) {
      negated = !negated;
      text = text.slice(1).trim();
      continue;
    }
    if (text.startsWith('(') && matchingParen(text, 0) === text.length - 1) {
      text = text.slice(1, -1).trim();
      continue;
    }
    break;
  }
  const path = GUARD_OPERAND.exec(text)?.[1];
  return path === undefined ? undefined : { path, negated };
}

/**
 * The path an operand guards for the operands to its right, if any.
 *
 * A guard only guards when its truth value is the chain's absorbing value
 * exactly where the path is missing: `has(p)` is `false` when `p` is absent, so
 * it guards in an `&&` chain; `!has(p)` is `true` when `p` is absent, so it
 * guards in an `||` chain. A guard of the wrong polarity — `!has(p)` in `&&`,
 * `has(p)` in `||` — establishes nothing, because the chain carries on into the
 * access precisely when the path is absent.
 *
 * The same predicate decides the divergent *late* guard, and for the same
 * reason: a late guard diverges only when cel-go's absorption of the earlier
 * error is what decides the chain. In `p.f == 1 && has(p)` cel-go yields
 * `false` where cel-js errors — a divergence — while in `p.f == 1 && !has(p)`
 * cel-go's absorbed error meets a `true` and stays an error, which is what
 * cel-js does too.
 */
function guardsEstablishedBy(blanked: string, span: Span, mode: ChainMode): string[] {
  const guard = chainGuard(blanked, span);
  if (guard === undefined) return [];
  return guard.negated === (mode === 'or') ? [guard.path] : [];
}

/** True when `guard` covers `path` — the same path, or an ancestor of it. */
function guardCovers(guard: string, path: string): boolean {
  return path === guard || path.startsWith(`${guard}.`);
}

/**
 * True when a guard already written to the left makes a later one redundant.
 *
 * The direction matters and is the opposite of {@link guardCovers}. Covering a
 * path is about *reaching* it: `has(a.status)` covers the dereference
 * `a.status.list[0]` because it guards an ancestor of it. Establishing a guard
 * is about *presence*: only a guard at least as specific as the later one says
 * the later one's path exists.
 *
 * So `has(a.status)` does not establish `has(a.status.list)` — the status object
 * being present says nothing about the list — while `has(a.status.list.deeper)`
 * does, because CEL evaluates the receiver of a `has()` before testing the last
 * field: for `has(a.status.list.deeper)` to have returned true rather than
 * errored, `a.status.list` had to be present.
 *
 * @param earlier A guard written to the left of the operand in question.
 * @param later The guard written to its right.
 */
function guardEstablishes(earlier: string, later: string): boolean {
  return guardCovers(later, earlier);
}

/** Dotted paths dereferenced in a span, excluding those that are `has()` arguments. */
function dereferencedPaths(masked: string, span: Span): string[] {
  let slice = masked.slice(span.start, span.end);
  // Blank out has() arguments: naming a path inside has() is not a dereference.
  const pattern = /\bhas\s*\(/g;
  let match: RegExpExecArray | null = pattern.exec(slice);
  const blanks: [number, number][] = [];
  while (match !== null) {
    const open = slice.indexOf('(', match.index);
    const close = matchingParen(slice, open);
    if (close > open) blanks.push([match.index, close + 1]);
    match = pattern.exec(slice);
  }
  for (const [start, end] of blanks.reverse()) {
    slice = slice.slice(0, start) + ' '.repeat(end - start) + slice.slice(end);
  }
  return [...slice.matchAll(DOTTED_PATH)].map((found) => found[0]);
}

function finding(
  rule: CelDialectRuleId,
  field: string,
  expression: string,
  fragment: string | undefined,
  message: string,
  suggestion: string
): CelDialectFinding {
  const entry = CEL_DIALECT_RULES.find((candidate) => candidate.id === rule);
  return {
    rule,
    kind: entry?.kind ?? 'note',
    dialect: entry?.dialect ?? 'cel-js',
    field,
    expression,
    ...(fragment === undefined ? {} : { fragment }),
    message,
    suggestion,
  };
}

/**
 * Rule: `has()` whose argument is an index expression.
 *
 * Any index counts, numeric or string-keyed. That is not an inference about what
 * is being indexed: cel-js rejects the *shape* of the macro argument, throwing
 * "has() does not support atomic expressions" for `has(list[0].f)` and
 * `has(map["k"].f)` alike, while cel-go's has() accepts any select expression.
 * The divergence is established without knowing a single type.
 */
function checkHasIndexArgument(
  expression: string,
  masked: string,
  field: string,
  findings: CelDialectFinding[]
): void {
  const pattern = /\bhas\s*\(/g;
  let match: RegExpExecArray | null = pattern.exec(masked);
  while (match !== null) {
    const open = masked.indexOf('(', match.index);
    const close = matchingParen(masked, open);
    if (close > open && masked.slice(open + 1, close).includes('[')) {
      const fragment = expression.slice(match.index, close + 1);
      findings.push(
        finding(
          'has-index-argument',
          field,
          expression,
          fragment,
          'cel-js rejects has() whose operand is an index expression ("has() does not support atomic expressions") while cel-go accepts it, so this field resolves under KRO and never in direct mode',
          'Select entries with `list.filter(entry, has(entry.field))` inside a lazy ternary — Cel.firstWhereHas() emits exactly that'
        )
      );
    }
    match = pattern.exec(masked);
  }
}

/**
 * A value that is exactly one whole CEL string literal and nothing else.
 *
 * This is cel-js's own `StringLiteral` token pattern anchored to the entire
 * value: either quote style, `\`-escapes, no newline inside. It is deliberately
 * *not* derived from the masked text. `maskCelStringLiterals` overwrites the
 * open quote, the interior and the close quote alike with spaces, and ordinary
 * inter-token whitespace is spaces already, so a masked string is
 * indistinguishable from a run of blanks and the closing quote's offset is not
 * recoverable from the mask — `"a" "b"` and `"a b"` mask identically. Re-lexing
 * the one token off the original text is what actually settles where the
 * literal ends.
 *
 * cel-js's grammar has no raw (`r"..."`), bytes (`b"..."`) or triple-quoted
 * string form, and nothing in the tree emits one, so a value opening with `r` or
 * `b` simply fails to match here and is left unclassified — the safe direction.
 */
const WHOLE_STRING_LITERAL = /^(?:"(?:[^"\n\\]|\\[\s\S])*"|'(?:[^'\n\\]|\\[\s\S])*')$/;

/**
 * The CEL type a value expression visibly *is*, when the syntax settles it.
 *
 * Only *whole* literals are classified, and that is a statement about the entire
 * value rather than about its first character. A value that merely *opens* with
 * a literal is a different type as often as not: `"x".size()` and `[1,2].size()`
 * are ints, `"s".startsWith("t")` is a bool, and `"x" + y` is a string only by
 * luck. So a string value has to match {@link WHOLE_STRING_LITERAL} end to end,
 * and a list or map value is whole only when `matchingParen` of its opening
 * bracket lands on the value's last character. Numbers, bools and `null` are
 * anchored patterns already and stay as they are. `1 + 2` starts with a digit
 * and is still not classified, because the point is to be certain rather than
 * clever: an identifier, a call, a ternary or any arithmetic yields `undefined`
 * and takes its entry out of the comparison entirely.
 *
 * `masked` is what a bracket is matched against, so a `]` or `}` sitting inside
 * a string cannot pose as the closer; the classification itself reads
 * `expression`, since masking is what erases the quotes that make a value a
 * string. `span` indexes both.
 *
 * `int` and `double` are separate classes because cel-js separates them —
 * `{"a": 1, "b": 2.5}` is as rejected as `{"a": 1, "b": "x"}`.
 */
function literalTypeClass(expression: string, masked: string, span: Span): string | undefined {
  let start = span.start;
  let end = span.end;
  while (start < end && /\s/.test(expression[start] as string)) start += 1;
  while (end > start && /\s/.test(expression[end - 1] as string)) end -= 1;
  if (start === end) return undefined;

  const value = expression.slice(start, end);
  if (value === 'true' || value === 'false') return 'bool';
  if (value === 'null') return 'null';
  if (/^-?\d+u$/.test(value)) return 'uint';
  if (/^-?\d+$/.test(value)) return 'int';
  if (/^-?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return 'double';
  if (WHOLE_STRING_LITERAL.test(value)) return 'string';
  if (value.startsWith('[') && matchingParen(masked, start) === end - 1) return 'list';
  if (value.startsWith('{') && matchingParen(masked, start) === end - 1) return 'map';
  return undefined;
}

/**
 * Rule: a map literal whose entry values are not all of the same CEL type.
 *
 * Every `{...}` in the expression is checked, nested ones included, and the
 * classification is purely syntactic: two entries have to carry *visibly*
 * different literal types before anything is reported, so a map whose values
 * are identifiers or calls is left alone even though cel-js may still refuse it
 * at runtime. Under-reporting is the deliberate direction — the alternative is
 * failing strict mode on a map the checker merely cannot read.
 *
 * Masking matters here: `masked` settles the structure, since a `,` or `:`
 * inside a string is not a separator, while the classification reads the
 * original text, since masking is what erases the quotes that make a value a
 * string. Offsets are shared, so the same spans index both, and
 * {@link literalTypeClass} is handed the span rather than the sliced text so it
 * can consult either one.
 */
function checkHeterogeneousMapLiteral(
  expression: string,
  masked: string,
  field: string,
  findings: CelDialectFinding[]
): void {
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== '{') continue;
    const close = matchingParen(masked, index);
    if (close < 0) continue;

    const classes = new Map<string, string>();
    for (const entry of splitTopLevel(masked, { start: index + 1, end: close }, [','])) {
      const [, afterKey] = splitTopLevel(masked, entry, [':']);
      if (afterKey === undefined) continue;
      const span: Span = { start: afterKey.start, end: entry.end };
      const found = literalTypeClass(expression, masked, span);
      if (found !== undefined && !classes.has(found)) {
        classes.set(found, expression.slice(span.start, span.end).trim());
      }
    }

    if (classes.size > 1) {
      const [first, second] = [...classes.entries()];
      findings.push(
        finding(
          'heterogeneous-map-literal',
          field,
          expression,
          expression.slice(index, close + 1),
          `this map literal mixes ${first?.[0]} (${first?.[1]}) and ${second?.[0]} (${second?.[1]}) values. cel-js takes the map's value type from its first entry and throws "invalid_argument" on the first entry that differs, so it cannot evaluate this map at all; cel-go types the literal as map(string, dyn) and evaluates it. The field resolves under KRO and never in direct mode`,
          'Give the entries one value type — `string(...)` around the odd ones out is usually enough — or reference an object of the right shape instead of writing a literal, which is what a KubernetesRef or CEL expression of that type does'
        )
      );
    }
  }
}

/** Rule: `in` whose right-hand operand may be a typed list entry. */
function checkInOnListEntry(
  expression: string,
  masked: string,
  field: string,
  findings: CelDialectFinding[]
): void {
  const lambdaScopes = collectCelLambdaScopes(expression);
  const pattern = /\bin\b/g;
  let match: RegExpExecArray | null = pattern.exec(masked);
  while (match !== null) {
    let cursor = match.index + 2;
    while (cursor < masked.length && masked[cursor] === ' ') cursor += 1;
    const operandStart = cursor;
    let depth = 0;
    while (cursor < masked.length) {
      const character = masked[cursor] as string;
      if (character === '[' || character === '(' || character === '{') depth += 1;
      else if (character === ']' || character === ')' || character === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && !/[\w$.]/.test(character)) break;
      cursor += 1;
    }
    const operand = masked.slice(operandStart, cursor);
    const root = /^[A-Za-z_$][\w$]*/.exec(operand)?.[0];
    // Two shapes that *may* denote a single entry of a list: an index
    // expression, and a variable bound by a collection macro. Neither says what
    // the entry's CEL type is — `in` is correct on a map entry and rejected on a
    // message one, and that distinction lives in the resource's schema, which is
    // not reachable here. Hence a note rather than a strict-mode failure.
    const mayBeListEntry =
      operand.includes('[') ||
      (root !== undefined && isCelLambdaLocalAt(root, operandStart, lambdaScopes));
    if (operand.length > 0 && mayBeListEntry) {
      findings.push(
        finding(
          'in-on-list-entry',
          field,
          expression,
          expression.slice(match.index, cursor),
          `\`in\` is applied to '${operand}', which may be a single list entry. If KRO's cel-go type env types that entry as a message rather than a map it rejects \`in\` on it ("no matching overload for '@in'") where cel-js accepts it. Whether it does is a fact about the resource's schema, which this check cannot see — so this is reported, not failed`,
          'If the entry is a message, test the field with has() instead: `list.filter(entry, has(entry.field))`'
        )
      );
    }
    match = pattern.exec(masked);
  }
}

/**
 * The one rule that only makes sense across the operands of an `&&` / `||`
 * chain: a `has()` guard that sits to the right of the access it guards.
 *
 * A companion rule used to live here — `unguarded-index-in-logical-chain`,
 * flagging `list[0].f` inside a chain with no guard before it — and it has been
 * removed because it was not a divergence. On `size(l) > 0 && l[0].f != ""` with
 * an empty `l`, cel-js short-circuits on the `false` and never indexes, while
 * cel-go absorbs the index error under the deciding `false`: both return
 * `false`. On an out-of-range index with no deciding operand, both error. There
 * is no data that separates the engines, so indexing a required list is simply
 * valid on both and reporting it failed strict mode on correct CEL.
 *
 * ## The chain model
 *
 * `&&` binds tighter than `||`, so a span is read as a disjunction of
 * conjunctions: split on `||` first, and split each disjunct on `&&`.
 * Flattening the two into one operand list would let a guard in one `||`
 * disjunct reach an access in another, which it never does — `A || B && C` is
 * `A || (B && C)`, and nothing in `A` runs before `B`.
 *
 * Within one chain, guards carry left to right with the polarity
 * {@link guardsEstablishedBy} describes, and what an operand has established
 * carries *into* that operand's own nested chains and parenthesized groups: in
 * `has(p) && (p.f > 0 || x)` the group is only reached once `has(p)` held.
 *
 * ## Stated limits
 *
 * - Only a whole-operand `has()` is read as a guard, so a `has()` folded into a
 *   larger boolean operand neither establishes a path nor is reported as a late
 *   guard.
 * - Negation is lexical: `!has(p)`, `!(has(p))` and `!!has(p)` are understood;
 *   `!(has(p) && q)` is not read as a guard at all.
 * - Guards inside a collection-macro body or a lazy ternary group are blanked
 *   before this runs (see {@link blankLazyRegions}) and so never carry out of
 *   the region that binds them.
 *
 * Every limit is in the direction of reporting less, so what escapes the model
 * is a missed finding rather than a strict-mode failure on valid CEL.
 */
function checkLogicalChain(
  expression: string,
  masked: string,
  blanked: string,
  field: string,
  span: Span,
  established: readonly string[],
  findings: CelDialectFinding[],
  depth: number
): void {
  if (depth > CEL_DIALECT_MAX_NESTING_DEPTH) return;
  // Ternary branches are lazy in both engines, so each `?`/`:` part is its own
  // chain rather than an operand of the surrounding one.
  for (const part of splitTopLevel(masked, span, ['?', ':'])) {
    checkChain(expression, masked, blanked, field, part, established, findings, depth);
  }
}

/** One `||` or `&&` chain — or a single operand — with what already holds at it. */
function checkChain(
  expression: string,
  masked: string,
  blanked: string,
  field: string,
  span: Span,
  established: readonly string[],
  findings: CelDialectFinding[],
  depth: number
): void {
  if (depth > CEL_DIALECT_MAX_NESTING_DEPTH) return;
  // Precedence: `||` is the loosest operator, so it splits first and each
  // disjunct is then read as its own `&&` chain.
  const disjuncts = splitTopLevel(masked, span, ['||']);
  const conjuncts = disjuncts.length > 1 ? [] : splitTopLevel(masked, span, ['&&']);
  const mode: ChainMode | undefined =
    disjuncts.length > 1 ? 'or' : conjuncts.length > 1 ? 'and' : undefined;

  if (mode === undefined) {
    // Not a chain, but a parenthesized group inside it may hold one — and that
    // group inherits whatever this position already established.
    for (const group of parenGroups(masked, span)) {
      checkLogicalChain(expression, masked, blanked, field, group, established, findings, depth + 1);
    }
    return;
  }

  const operands = mode === 'or' ? disjuncts : conjuncts;
  const guards = operands.map((operand) => guardsEstablishedBy(blanked, operand, mode));
  let known: string[] = [...established];

  for (let index = 0; index < operands.length; index += 1) {
    const operand = operands[index] as Span;
    const after = guards.slice(index + 1).flat();
    const derefs = dereferencedPaths(blanked, operand);

    // A guard to the right of an access it covers is only harmless if something
    // to the left already established the same path. "Established" is not
    // "covered": a shallower earlier guard reaches the late guard's path without
    // saying it is present, so it cannot stand in for it.
    const lateGuard = after.find(
      (guard) =>
        derefs.some((path) => guardCovers(guard, path)) &&
        !known.some((earlier) => guardEstablishes(earlier, guard))
    );
    if (lateGuard !== undefined) {
      const guardText = mode === 'or' ? `!has(${lateGuard})` : `has(${lateGuard})`;
      findings.push(
        finding(
          'guard-after-use-in-logical-chain',
          field,
          expression,
          expression.slice(operand.start, operand.end).trim(),
          `${guardText} guards this operand but is written after it. cel-go absorbs the error either way; cel-js evaluates left to right and fails before reaching the guard`,
          `Move ${guardText} to the left of the access, or use a lazy ternary: has(${lateGuard}) ? (...) : <fallback>`
        )
      );
    }

    // Descend with what holds at this position: the `&&` chain nested inside an
    // `||` disjunct, and any parenthesized group.
    checkChain(expression, masked, blanked, field, operand, known, findings, depth + 1);
    known = [...known, ...(guards[index] as string[])];
  }
}

/* ------------------------------------------------------------------------- *
 * The parse half.
 *
 * cel-js's `parse()` is the only CEL parser this module can call, and it is
 * **not** a conformant implementation of the CEL grammar. So a `parse()` failure
 * is never read as a verdict about cel-go: it is sorted into one of three
 * buckets, each of which stands on evidence of its own.
 *
 * The spec quoted throughout is cel-spec `doc/langdef.md`, section "Syntax"
 * (the EBNF) and its "Lexical Elements" subsection (the token definitions).
 * ------------------------------------------------------------------------- */

/** `[start, end)` of every string literal token in `expression`. */
function stringLiteralSpans(expression: string): Span[] {
  const spans: Span[] = [];
  let quote: '"' | "'" | undefined;
  let start = 0;
  let escaped = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index] as string;
    if (quote === undefined) {
      if (character === '"' || character === "'") {
        quote = character;
        start = index;
      }
      continue;
    }
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === quote) {
      spans.push({ start, end: index + 1 });
      quote = undefined;
    }
  }
  return spans;
}

/** Index of the next non-whitespace character at or after `from`, or -1. */
function nextNonSpace(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (!/\s/.test(text[index] as string)) return index;
  }
  return -1;
}

/** Index of the previous non-whitespace character before `from`, or -1. */
function previousNonSpace(text: string, from: number): number {
  for (let index = from - 1; index >= 0; index -= 1) {
    if (!/\s/.test(text[index] as string)) return index;
  }
  return -1;
}

const IDENT_CHARACTER = /[A-Za-z0-9_]/;

/** True when a `.` or `[` sits at `index`, i.e. a postfix member operator follows. */
function postfixFollows(masked: string, after: number): string | undefined {
  const index = nextNonSpace(masked, after);
  if (index < 0) return undefined;
  const character = masked[index] as string;
  return character === '.' || character === '[' ? character : undefined;
}

/** One confirmed cel-js shortfall against the spec grammar. */
interface SpecCelLimitation {
  readonly at: number;
  readonly fragment: string;
  readonly reason: string;
}

/**
 * Forms the CEL grammar permits that cel-js 0.8.2 provably cannot parse.
 *
 * Every entry here was confirmed two ways before it was written down: the form
 * is derivable from the spec's own productions (quoted per entry), and
 * `parse()` was actually called on it and failed. The unit suite re-asserts the
 * `parse()` half, so the day cel-js catches up the test fails rather than the
 * rule quietly over-reporting.
 *
 * Detection is deliberately conservative in one direction only: an unrecognized
 * shape yields nothing, because a false positive here fails strict mode on
 * valid CEL while a false negative merely leaves a `cel-js-parse-failure` note.
 */
function findSpecCelCelJsRejects(expression: string, masked: string): SpecCelLimitation[] {
  const found: SpecCelLimitation[] = [];
  const add = (at: number, end: number, reason: string): void => {
    found.push({ at, fragment: expression.slice(at, Math.min(end, at + 80)).trim(), reason });
  };

  // Spec: `Primary = ... | LITERAL`, and `Member = Member "." SELECTOR [...]`
  // | `Member "[" Expr "]"`, so a postfix applies to a literal primary. cel-js
  // consumes a StringLiteral as a bare `atomicExpression` alternative with no
  // postfix at all: `"x".size()`, `"a" .size()` and `"a"["b"]` all fail.
  for (const span of stringLiteralSpans(expression)) {
    const postfix = postfixFollows(masked, span.end);
    if (postfix !== undefined) {
      add(span.start, span.end + 24, 'a string literal used as the receiver of a member access');
    }
    // Spec: `STRING_LIT ::= [rR]? (...)` and `BYTES_LIT ::= [bB] STRING_LIT`.
    // cel-js has no raw-string and no bytes token, so the prefix lexes as a
    // one-character identifier and the parse fails.
    const before = previousNonSpace(expression, span.start);
    if (
      before === span.start - 1 &&
      /[rRbB]/.test(expression[before] as string) &&
      !IDENT_CHARACTER.test(expression[before - 1] ?? '')
    ) {
      add(before, span.end, 'a raw-string or bytes literal prefix, which cel-js has no token for');
    }
  }
  // Spec `STRING_LIT` also admits the triple-quoted forms; cel-js has neither.
  for (const quote of ['"""', "'''"]) {
    const at = expression.indexOf(quote);
    if (at >= 0) add(at, at + 24, 'a triple-quoted string literal, which cel-js has no token for');
  }

  // Spec: `Primary = "(" Expr ")"`, again a Member and so a legal receiver.
  // cel-js's `parenthesisExpression` takes no postfix: `(a).b` and `(a+b)[0]`
  // fail. A `(` that opens a *call* is a different production and is fine, so
  // only a grouping paren — one not preceded by an identifier character —
  // counts here.
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== '(') continue;
    const before = previousNonSpace(masked, index);
    const identifierCall = before >= 0 && IDENT_CHARACTER.test(masked[before] as string);
    const close = matchingParen(masked, index);
    if (close < 0 || postfixFollows(masked, close + 1) === undefined) continue;
    if (!identifierCall) {
      add(index, close + 24, 'a parenthesized expression used as the receiver of a member access');
      continue;
    }
    // A global function call — `size(a)`, `has(a.b)`, `int(a)` — is cel-js's
    // `macrosExpression`, which also takes no postfix, so `size(a).b` fails.
    // A *member* call (`a.map(x, x).size()`) is part of `identifierExpression`
    // and cel-js handles it, so a callee written after a `.` is left alone.
    let start = before;
    while (start >= 0 && IDENT_CHARACTER.test(masked[start] as string)) start -= 1;
    if (previousNonSpace(masked, start + 1) < 0 || (masked[start] as string) !== '.') {
      add(start + 1, close + 24, 'a global function call used as the receiver of a member access');
    }
  }

  // Spec: `Primary = "[" [ExprList] [","] "]"`, and a postfix applies to it.
  // cel-js's `listExpression` allows exactly one trailing index and no `.` at
  // all, so `[a,b].size()` and `[1,2][0].f` fail while `[1,2][0]` parses.
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== '[') continue;
    const before = previousNonSpace(masked, index);
    // An index expression, not a list literal, when something precedes it that
    // a postfix can attach to.
    if (before >= 0 && /[A-Za-z0-9_)\]}]/.test(masked[before] as string)) continue;
    const close = matchingParen(masked, index);
    if (close < 0) continue;
    if (postfixFollows(masked, close + 1) === '.') {
      add(index, close + 24, 'a list literal used as the receiver of a member access');
      continue;
    }
    // The one permitted index, then anything further is past what cel-js takes.
    if (postfixFollows(masked, close + 1) !== '[') continue;
    const second = matchingParen(masked, nextNonSpace(masked, close + 1));
    if (second > 0 && postfixFollows(masked, second + 1) !== undefined) {
      add(index, second + 24, 'a list literal with more than the one postfix cel-js allows');
    }
  }

  // Spec: `Primary = ... | LITERAL` covers the number, bool and null literals
  // too, so `1.string()`, `1.0.x`, `2u.x`, `true.x` and `null.x` are all
  // grammatical. cel-js consumes each as a bare token with no postfix.
  const literalReceiver =
    /(?<![A-Za-z0-9_.])(?:0[xX][0-9a-fA-F]+[uU]?|\d+(?:\.\d+)?[uU]?|true|false|null)\s*\.\s*[A-Za-z_]/g;
  for (const match of masked.matchAll(literalReceiver)) {
    add(
      match.index,
      match.index + match[0].length,
      'a number, bool or null literal used as the receiver of a member access'
    );
  }

  // Spec: `FLOAT_LIT ::= -? DIGIT* . DIGIT+ EXPONENT? | -? DIGIT+ EXPONENT`.
  // cel-js's `Float` token is `-?\d+\.\d+` with no exponent form, so `1e3`,
  // `1.5e-3` and `0.5e3` are all rejected.
  for (const match of masked.matchAll(/(?<![A-Za-z0-9_.])\d+(?:\.\d+)?[eE][+-]?\d+/g)) {
    add(
      match.index,
      match.index + match[0].length,
      'a float literal written with an exponent, which cel-js has no token for'
    );
  }

  return found.sort((left, right) => left.at - right.at);
}

/** One form no CEL grammar accepts, whichever engine reads it. */
interface NonCelToken {
  readonly at: number;
  readonly fragment: string;
  readonly reason: string;
}

/**
 * Text that is not CEL under the spec's own grammar, on any engine.
 *
 * The list is built from the spec rather than from an engine, and only from
 * *absences*: a character or sequence the lexical grammar has no token for, or
 * a production that cannot be completed. Nothing here is inferred from cel-js
 * having failed — indeed this runs whether cel-js parsed or not, because its
 * lexer silently drops a character it has no token for and hands `a === b` to
 * its parser as `a == b`.
 *
 * A trailing `.length` is deliberately *not* in this set. It is a plain
 * `Member "." SELECTOR`, grammatical on both engines; whether the field exists
 * is a question about a type this module cannot see.
 *
 * @param parsed Whether cel-js accepted the text. The unpaired-`?` check is
 *   gated on a failure only because a successful parse already proves every
 *   ternary is closed, so running it would be wasted work rather than unsound.
 */
function findNonCelTokens(expression: string, masked: string, parsed: boolean): NonCelToken[] {
  const found: NonCelToken[] = [];
  const add = (at: number, length: number, reason: string): void => {
    found.push({ at, fragment: expression.slice(at, at + Math.max(length, 8)).trim(), reason });
  };

  // The spec's punctuation list is `() [] {} . , ? : || && ! < <= >= > == != in
  // + - * / %`. There is no bare `=` in it and CEL has no assignment, so once
  // the four comparison operators that contain one are taken out, a remaining
  // `=` is a character no CEL token can carry: `===`, `!==`, `=>`, `a = b`.
  const withoutComparisons = masked.replace(/[=!<>]=/g, '  ');
  const stray = withoutComparisons.indexOf('=');
  if (stray >= 0) {
    add(
      Math.max(0, stray - 2),
      6,
      '`=` outside `==`, `!=`, `<=` or `>=` — CEL has no assignment operator and no `=` token, so `===`, `!==` and `=>` are all JavaScript'
    );
  }

  // `IDENT` is `[_a-zA-Z][_a-zA-Z0-9]*` and `$` is in neither it nor the
  // punctuation list, so a `${` is an un-substituted template placeholder.
  const template = masked.indexOf('${');
  if (template >= 0) {
    add(template, 8, '`${` — a template placeholder that was never substituted; `$` is not a CEL character');
  }

  // `Expr = ConditionalOr ["?" ConditionalOr ":" Expr]` is the only production
  // that consumes a `?`, and it always consumes a `:` with it. A top-level `?`
  // with no top-level `:` to close it cannot be parsed by any CEL grammar —
  // which is what `a?.b`, `a?[0]` and `a.?b` each reduce to, the `?` of
  // JavaScript optional chaining having no ternary behind it.
  if (!parsed) {
    let depth = 0;
    let questions = 0;
    let colons = 0;
    let firstQuestion = -1;
    for (let index = 0; index < masked.length; index += 1) {
      const character = masked[index] as string;
      if (character === '(' || character === '[' || character === '{') depth += 1;
      else if (character === ')' || character === ']' || character === '}') depth -= 1;
      else if (depth === 0 && character === '?') {
        questions += 1;
        if (firstQuestion < 0) firstQuestion = index;
      } else if (depth === 0 && character === ':') colons += 1;
    }
    if (questions > colons && firstQuestion >= 0) {
      add(
        firstQuestion,
        8,
        '`?` with no `:` to close the conditional — CEL spells optional access `a.b` behind a `has()` guard or a full `? :`, never as JavaScript optional chaining'
      );
    }
  }

  return found.sort((left, right) => left.at - right.at);
}

/**
 * Check one emitted status CEL expression against both dialects.
 *
 * @param expression The emitted CEL, without any `${...}` wrapper.
 * @param field The status leaf path the expression belongs to.
 */
export function checkCelDialectCompatibility(
  expression: string,
  field: string
): CelDialectFinding[] {
  const findings: CelDialectFinding[] = [];
  const trimmed = expression.trim();
  if (trimmed.length === 0) return findings;

  // Budget gate, before either half. Both halves are linear in the length of
  // the expression, so an expression that has run away makes the check run away
  // with it — a 6MB one costs ~6.5s and, having no denylisted form in it,
  // reports nothing for the trouble. Refuse to spend serialization time on it
  // and report the size itself, which is the real defect.
  if (trimmed.length > CEL_DIALECT_MAX_EXPRESSION_LENGTH) {
    findings.push(
      finding(
        'expression-too-large',
        field,
        // Carry a bounded prefix rather than megabytes of text into the report.
        `${trimmed.slice(0, 200)}…`,
        undefined,
        `the expression is ${trimmed.length} characters, past the ${CEL_DIALECT_MAX_EXPRESSION_LENGTH} character dual-dialect analysis budget, so neither half of the check was run. An expression this size cannot be served by either engine: cel-js spends seconds parsing it on every direct-mode reconcile, and a ResourceGraphDefinition carrying it is past the Kubernetes object size limit`,
        'Shrink the status field. An expression this large is a runaway expansion rather than authored status — most often a nested composition whose inlined status re-expands into itself; give the inner composition an explicit status field and reference that instead'
      )
    );
    return findings;
  }

  const masked = maskCelStringLiterals(trimmed);

  // Half one: what cel-js's parser can and cannot be made to say.
  //
  // It can say that *direct mode* cannot evaluate the field, and nothing more.
  // cel-js 0.8.2 is not a conformant CEL grammar — it rejects `"x".size()`,
  // `[1,2].size()`, `(a).b` and `1e3`, all of which the spec permits — so a
  // parse failure on its own is no evidence at all about cel-go or KRO. The
  // three buckets below each carry their own evidence instead, and only the one
  // backed by a positive, spec-cited identification of valid CEL is a
  // divergence.
  let parsed: boolean;
  try {
    parsed = parse(trimmed).isSuccess === true;
  } catch {
    parsed = false;
  }

  // Bucket one: text no CEL grammar accepts. Built from the spec's own lexical
  // and syntactic grammar, never from cel-js's verdict, and so run whether or
  // not cel-js parsed — its lexer drops an unknown character silently, and
  // `a === b` reaches its parser as `a == b`.
  const nonCel = findNonCelTokens(trimmed, masked, parsed);
  const leak = nonCel[0];
  if (leak !== undefined) {
    findings.push(
      finding(
        'not-valid-cel',
        field,
        trimmed,
        leak.fragment,
        `this is not CEL under the language grammar, whichever engine reads it: ${leak.reason}. Both engines reject it, so direct mode can never evaluate this status field and KRO will refuse the ResourceGraphDefinition`,
        'Usually JavaScript that survived conversion. Write the CEL form instead: a has() guard rather than `?.`, an index rather than `?[`, `==` rather than `===`, and a resolved reference rather than an un-substituted template placeholder'
      )
    );
  } else if (!parsed) {
    // Bucket two: a cel-js parse failure that a positive check identifies as
    // grammatical CEL. This is the real divergence — KRO serves the field and
    // direct mode never will — so it may fail strict mode.
    const limitation = findSpecCelCelJsRejects(trimmed, masked)[0];
    if (limitation !== undefined) {
      findings.push(
        finding(
          'cel-js-rejects-spec-cel',
          field,
          trimmed,
          limitation.fragment,
          `cel-js cannot parse this, but the CEL grammar permits it: ${limitation.reason} (cel-spec doc/langdef.md, "Syntax"). cel-go parses this form, so the field resolves under KRO and direct mode can never evaluate it`,
          'Rewrite the receiver as an identifier chain — bind the literal or parenthesized value to a resource field, or use the global form of the call (`size(x)` rather than `x.size()`) — until cel-js supports the spec form'
        )
      );
    } else {
      // Bucket three: cel-js cannot parse it and nothing above explains why.
      // The only sound claim is about direct mode.
      findings.push(
        finding(
          'cel-js-parse-failure',
          field,
          trimmed,
          undefined,
          'cel-js cannot parse this expression, so direct mode cannot evaluate this field; the CEL specification may still permit it and the controller may still serve it. Verify against the spec grammar; if it is valid CEL, this is a cel-js limitation worth reporting upstream',
          'Check the expression against cel-spec doc/langdef.md. If the grammar permits it, the field works in Kro mode and only direct mode is affected — otherwise fix the emitted CEL'
        )
      );
    }
  }

  // Half two: the curated cel-go/cel-js divergence denylist. Every rule here is
  // regex- and bracket-mask-based rather than tree-based, so none of them needs
  // a parse and all of them run on text cel-js rejected — which is the point:
  // an expression cel-js merely cannot parse is still checked for the
  // divergences that would bite it under KRO.
  checkHasIndexArgument(trimmed, masked, field, findings);
  checkHeterogeneousMapLiteral(trimmed, masked, field, findings);
  checkInOnListEntry(trimmed, masked, field, findings);
  const blanked = blankLazyRegions(masked);
  checkLogicalChain(
    trimmed,
    masked,
    blanked,
    field,
    { start: 0, end: masked.length },
    [],
    findings,
    0
  );
  return findings;
}

/** Strip the KRO `${...}` wrapper from an emitted status value. */
function unwrapKroExpression(value: string): string | undefined {
  const match = /^\$\{([\s\S]*)\}$/.exec(value.trim());
  return match?.[1];
}

/**
 * Check every emitted status CEL expression in a serialized status map.
 *
 * Accepts the nested shape `serializeStatusMappingsToCel` produces: leaves are
 * `${...}`-wrapped CEL strings, and objects/arrays nest arbitrarily. Values
 * that carry no CEL are skipped, so plain literal status fields cost nothing.
 */
export function collectStatusCelDialectFindings(
  statusCel: Readonly<Record<string, unknown>>
): CelDialectFinding[] {
  const findings: CelDialectFinding[] = [];

  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const expression = unwrapKroExpression(value);
      if (expression !== undefined)
        findings.push(...checkCelDialectCompatibility(expression, path));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        walk(nested, path === '' ? key : `${path}.${key}`);
      }
    }
  };

  for (const [key, value] of Object.entries(statusCel)) walk(value, key);
  return findings;
}

/**
 * Longest expression or fragment a report will quote, in characters.
 *
 * The analysis budget already keeps `checkCelDialectCompatibility` from
 * returning an oversized `expression`, but the formatter is exported and takes
 * findings from wherever the caller got them — so it bounds what it quotes on
 * its own rather than trusting its input. A report is read by a human; past a
 * couple of lines per finding the excerpt stops helping and starts being the
 * thing that fills the log.
 */
export const CEL_DIALECT_MAX_EXCERPT_LENGTH = 400;

/** Quote at most {@link CEL_DIALECT_MAX_EXCERPT_LENGTH} characters of a snippet. */
function excerpt(text: string): string {
  return text.length <= CEL_DIALECT_MAX_EXCERPT_LENGTH
    ? text
    : `${text.slice(0, CEL_DIALECT_MAX_EXCERPT_LENGTH)}… (${text.length} characters)`;
}

/** How a finding's verdict reads at the head of its report entry. */
function verdict(found: CelDialectFinding): string {
  if (found.dialect === 'unchecked') return 'not checked';
  if (found.dialect === 'both') return 'rejected by both dialects';
  // A cel-js parse failure is a certainty about cel-js and says nothing at all
  // about the other engine, so it reads as neither "rejected" (which would
  // imply a verdict was reached on the form) nor "may be rejected".
  if (found.rule === 'cel-js-parse-failure') return 'not parseable by cel-js, cel-go unknown';
  return `${found.kind === 'divergence' ? 'rejected by' : 'may be rejected by'} ${found.dialect}`;
}

/** Render findings as a multi-line report naming the leaf, dialect and expression. */
export function formatCelDialectFindings(findings: readonly CelDialectFinding[]): string {
  return findings
    .map(
      (found) =>
        `  status.${found.field}: ${verdict(found)} [${found.rule}, ${found.kind}]\n` +
        `    ${found.message}\n` +
        (found.fragment ? `    at: ${excerpt(found.fragment)}\n` : '') +
        `    expression: ${excerpt(found.expression)}\n` +
        `    fix: ${found.suggestion}`
    )
    .join('\n');
}
