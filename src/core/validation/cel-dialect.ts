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
 * Identifying a shortfall *somewhere* in a rejected expression is not by itself
 * a divergence, because the parse may have failed for an unrelated reason: the
 * shortfall in `"x".size() +` is real and the expression is still unfinished,
 * and cel-go refuses it exactly as cel-js does. So the divergence bucket is
 * earned rather than assumed — every identified shortfall is rewritten into a
 * spelling of the same spec production that cel-js does have (`"x".size()` into
 * `__typekro_recv0.size()`, `1e3` into `0.0`), the rest of the text is left
 * untouched, and cel-js is asked again. Only a rewrite that parses proves the
 * shortfall was the whole reason; anything else falls to `cel-js-parse-failure`.
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
 * What the bar does **not** license is a claim about what KRO ultimately does
 * with the field. Every rule here reasons about the grammar and about published
 * engine behaviour; none of them models cel-go's *type checker*, which runs
 * after the parse with KRO's type environment and function set and rejects
 * plenty of grammatical CEL — `1.string()` parses on any conformant grammar and
 * the checker still refuses it, `string` being a global conversion function
 * rather than a member, and an unknown member function goes the same way. So a
 * finding says "direct mode can never evaluate this field" where that is proven,
 * and leaves KRO's verdict open. A rule stays a `divergence` on the strength of
 * the disagreement it does establish: the engines differ on the *form*, at a
 * stage that needs no type environment, which makes the emitted CEL defective
 * for one of the two targets TypeKro serializes for whatever the other decides.
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
      "cel-js 0.8.2 is not a conformant CEL parser. Its `atomicExpression` rule (dist/parser.js) allows a postfix `.`/`[` only after an Identifier — plus one index after a list literal, and any postfix after a map literal — while the spec's `Member = Primary | Member \".\" SELECTOR [\"(\" [ExprList] \")\"] | Member \"[\" Expr \"]\"` allows a postfix on *any* Member, and `Primary` includes `LITERAL` and `\"(\" Expr \")\"` (cel-spec doc/langdef.md, \"Syntax\"). Its lexer is short of the spec's `FLOAT_LIT` (no EXPONENT form) and `STRING_LIT`/`BYTES_LIT` (no `r`/`R`/`b`/`B` prefix, no triple-quoted form). Each form is confirmed to fail `parse()` and is grammatical CEL. The entry fires only once the *whole* expression is shown to be grammatical: the identified forms are replaced by same-production spellings cel-js does have and cel-js is asked again, and only a rewrite cel-js accepts whole — every character lexed, the token stream parsed — establishes that the shortfall is the sole obstruction rather than one of several problems in the text. What that proves is that the grammar permits the form and cel-js's refusal is its own shortfall, so direct mode can never evaluate the field; it is a divergence in the form rather than a defect in the expression. It does not establish what KRO then does with the field: cel-go parses the form, but its type checker runs afterwards with KRO's type environment and function set, which this module does not model — `1.string()` is grammatical and cel-go's checker still rejects it, `string` being a global conversion function rather than a member",
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
      "cel-js's parser rejected the text and nothing above accounts for it: either no confirmed cel-js shortfall was identified, or one was and rewriting it away still left text cel-js refuses — which means the expression has a further problem of its own, and an expression that is ungrammatical elsewhere is rejected by cel-go too. A cel-js parse failure on its own says only that *direct mode* cannot evaluate the field: cel-js is not a conformant CEL grammar, so it establishes nothing about cel-go or KRO. Reported so the field is visible, never failed",
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

/**
 * Every bracket pair in one expression, resolved once in a single stack pass.
 *
 * The walks in this module ask "where does the bracket at `i` close?" from a
 * dozen places and, for the receiver detectors, from *every* opener in the text.
 * Answering each of those by scanning forward from the opener is quadratic in
 * the nesting depth, which is exactly the shape a runaway nested composition
 * produces: 8k levels of `(` in 16 KiB of expression cost 8k scans of 16 KiB
 * each. One stack pass answers all of them in O(1) apiece.
 *
 * Only `close` is carried. A reverse `open` map and a per-character `depth` map
 * are cheap to fill and nothing in this module reads either — the walks descend
 * from openers, never from closers, and the depth that matters here is the
 * recursion depth of the walk ({@link CEL_DIALECT_MAX_NESTING_DEPTH}), not the
 * bracket depth of a character. Two more typed arrays per expression would be
 * 6 bytes per character of garbage on the serialization path for no reader.
 */
interface BracketIndex {
  /** For an opener at `i`, the index of its matching closer; -1 everywhere else. */
  readonly close: Int32Array;
}

/** Counters behind {@link celDialectWorkStats}; see it for why they exist. */
let workIndexBuilds = 0;
let workIndexedCharacters = 0;
let workLookups = 0;

/**
 * What the last run (or runs) of the check cost, in units that do not depend on
 * the machine it ran on.
 *
 * Wall-clock is the wrong instrument for the property that actually matters
 * here — that the work is linear in the length of the expression rather than
 * quadratic in its nesting — because a slow CI box and a quadratic regression
 * look alike. These counters do not: `indexedCharacters` is the total text
 * scanned to build bracket indexes and `lookups` the total number of "where
 * does this close?" questions asked, so doubling the input must roughly double
 * both.
 */
export interface CelDialectWorkStats {
  /** How many bracket indexes were built. */
  readonly indexBuilds: number;
  /** Total characters scanned across those builds. */
  readonly indexedCharacters: number;
  /** Total bracket-match questions answered out of an index. */
  readonly lookups: number;
}

/** Read the work counters. */
export function celDialectWorkStats(): CelDialectWorkStats {
  return {
    indexBuilds: workIndexBuilds,
    indexedCharacters: workIndexedCharacters,
    lookups: workLookups,
  };
}

/** Zero the work counters, so one check can be measured on its own. */
export function resetCelDialectWorkStats(): void {
  workIndexBuilds = 0;
  workIndexedCharacters = 0;
  workLookups = 0;
}

/**
 * Resolve every bracket pair in `text` in one left-to-right stack pass.
 *
 * A closer that does not match the opener on top of the stack is text no scan
 * could have got past either: a walk forward from any opener still on the stack
 * would reach this character with the same pending brackets and give up, so all
 * of them are recorded unmatched and the stack is cleared. An opener that starts
 * *after* the offending closer is unaffected, which is what a forward scan from
 * it would also have found.
 */
function buildBracketIndex(text: string): BracketIndex {
  workIndexBuilds += 1;
  workIndexedCharacters += text.length;

  const close = new Int32Array(text.length).fill(-1);
  const stack: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === '(' || character === '[' || character === '{') {
      stack.push(index);
      continue;
    }
    const opener = CLOSERS[character];
    if (opener === undefined) continue;
    const top = stack.length === 0 ? -1 : (stack[stack.length - 1] as number);
    if (top >= 0 && text[top] === opener) {
      stack.pop();
      close[top] = index;
      continue;
    }
    stack.length = 0;
  }
  return { close };
}

/** Index of the bracket matching the one at `open`, or -1. */
function matchingParen(brackets: BracketIndex, open: number): number {
  workLookups += 1;
  return open >= 0 && open < brackets.close.length ? (brackets.close[open] as number) : -1;
}

/**
 * Split `[start, end)` on the given separators, ignoring anything nested inside
 * brackets. Separators are matched as whole tokens.
 *
 * A matched bracket group at depth zero is stepped over in one index lookup
 * rather than character by character, which is what keeps the recursive descent
 * in {@link checkChain} from re-reading the same nested text once per level. The
 * depth counter stays for the unbalanced case — a group whose closer is missing
 * or falls outside the span has no entry to jump to, and the old scan is then
 * exactly the right behaviour.
 */
function splitTopLevel(
  masked: string,
  span: Span,
  separators: readonly string[],
  brackets: BracketIndex
): Span[] {
  const parts: Span[] = [];
  let depth = 0;
  let partStart = span.start;
  let index = span.start;
  while (index < span.end) {
    const character = masked[index] as string;
    if (character === '(' || character === '[' || character === '{') {
      if (depth === 0) {
        const close = matchingParen(brackets, index);
        if (close >= 0 && close < span.end) {
          index = close + 1;
          continue;
        }
      }
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
function parenGroups(masked: string, span: Span, brackets: BracketIndex): Span[] {
  const groups: Span[] = [];
  let index = span.start;
  while (index < span.end) {
    if (masked[index] === '(') {
      const close = matchingParen(brackets, index);
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
 *
 * The bracket index is the one built for `masked`, and stays correct here
 * because every region blanked is a bracket *interior*: a lambda body runs from
 * after the macro's `(` to before its `)`, and a lazy ternary group is blanked
 * between its own parens. Blanking therefore only ever removes whole matched
 * pairs, so a bracket that survives into `blanked` still closes where the index
 * says it does, and a bracket that does not survive is a space nothing asks
 * about.
 */
function blankLazyRegions(masked: string, brackets: BracketIndex): string {
  let blanked = masked;
  for (const scope of collectCelLambdaScopes(masked)) {
    blanked = blankRange(blanked, scope.bodyStart, scope.bodyEnd);
  }
  const blankTernaryGroups = (span: Span, depth: number): void => {
    if (depth > CEL_DIALECT_MAX_NESTING_DEPTH) return;
    let index = span.start;
    while (index < span.end) {
      if (blanked[index] === '(') {
        const close = matchingParen(brackets, index);
        if (close < 0 || close > span.end) return;
        const interior = { start: index + 1, end: close };
        if (splitTopLevel(blanked, interior, ['?'], brackets).length > 1) {
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
function chainGuard(
  blanked: string,
  span: Span,
  brackets: BracketIndex
): { path: string; negated: boolean } | undefined {
  // Stripping narrows a span rather than re-slicing a string, so the enclosing
  // parens can be matched out of the shared index instead of rescanned.
  let start = span.start;
  let end = span.end;
  let negated = false;
  const trim = (): void => {
    while (start < end && /\s/.test(blanked[start] as string)) start += 1;
    while (end > start && /\s/.test(blanked[end - 1] as string)) end -= 1;
  };

  trim();
  while (start < end) {
    if (blanked[start] === '!') {
      negated = !negated;
      start += 1;
      trim();
      continue;
    }
    if (blanked[start] === '(' && matchingParen(brackets, start) === end - 1) {
      start += 1;
      end -= 1;
      trim();
      continue;
    }
    break;
  }
  const path = GUARD_OPERAND.exec(blanked.slice(start, end))?.[1];
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
function guardsEstablishedBy(
  blanked: string,
  span: Span,
  mode: ChainMode,
  brackets: BracketIndex
): string[] {
  const guard = chainGuard(blanked, span, brackets);
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
function dereferencedPaths(masked: string, span: Span, brackets: BracketIndex): string[] {
  let slice = masked.slice(span.start, span.end);
  // Blank out has() arguments: naming a path inside has() is not a dereference.
  // The scan runs over the whole text from `span.start` rather than over the
  // slice, so the shared bracket index answers where each `has(` closes; a
  // `has(` whose closer falls outside the span is left alone, which is what
  // matching inside the slice alone used to arrive at.
  const pattern = /\bhas\s*\(/g;
  pattern.lastIndex = span.start;
  const blanks: [number, number][] = [];
  let match: RegExpExecArray | null = pattern.exec(masked);
  while (match !== null && match.index < span.end) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(brackets, open);
    if (close > open && close < span.end) {
      blanks.push([match.index - span.start, close + 1 - span.start]);
    }
    match = pattern.exec(masked);
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
 *
 * What that establishes is that direct mode can never evaluate the field. It
 * does not establish that KRO does: cel-go's macro expansion is not its type
 * checker, and the checker runs afterwards with KRO's type environment. The
 * message says so rather than promising the field resolves under KRO.
 */
function checkHasIndexArgument(
  expression: string,
  masked: string,
  field: string,
  findings: CelDialectFinding[],
  brackets: BracketIndex
): void {
  const pattern = /\bhas\s*\(/g;
  let match: RegExpExecArray | null = pattern.exec(masked);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(brackets, open);
    if (close > open && masked.slice(open + 1, close).includes('[')) {
      const fragment = expression.slice(match.index, close + 1);
      findings.push(
        finding(
          'has-index-argument',
          field,
          expression,
          fragment,
          'cel-js rejects has() whose operand is an index expression ("has() does not support atomic expressions") while cel-go\'s has() macro accepts any select expression, index included. Direct mode can therefore never evaluate this field. Whether KRO evaluates it depends on cel-go\'s type checker and function environment, which this check does not model',
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
 * Brackets are matched out of `brackets`, which was built over the *masked*
 * text, so a `]` or `}` sitting inside a string cannot pose as the closer; the
 * classification itself reads `expression`, since masking is what erases the
 * quotes that make a value a string. Masking preserves offsets, so `span` and
 * the index address the same characters.
 *
 * `int` and `double` are separate classes because cel-js separates them —
 * `{"a": 1, "b": 2.5}` is as rejected as `{"a": 1, "b": "x"}`.
 */
function literalTypeClass(
  expression: string,
  span: Span,
  brackets: BracketIndex
): string | undefined {
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
  if (value.startsWith('[') && matchingParen(brackets, start) === end - 1) return 'list';
  if (value.startsWith('{') && matchingParen(brackets, start) === end - 1) return 'map';
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
 * can read the original while matching brackets out of the masked index.
 */
function checkHeterogeneousMapLiteral(
  expression: string,
  masked: string,
  field: string,
  findings: CelDialectFinding[],
  brackets: BracketIndex
): void {
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== '{') continue;
    const close = matchingParen(brackets, index);
    if (close < 0) continue;

    const classes = new Map<string, string>();
    for (const entry of splitTopLevel(masked, { start: index + 1, end: close }, [','], brackets)) {
      const [, afterKey] = splitTopLevel(masked, entry, [':'], brackets);
      if (afterKey === undefined) continue;
      const span: Span = { start: afterKey.start, end: entry.end };
      const found = literalTypeClass(expression, span, brackets);
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
          `this map literal mixes ${first?.[0]} (${first?.[1]}) and ${second?.[0]} (${second?.[1]}) values. cel-js takes the map's value type from its first entry and throws "invalid_argument" on the first entry that differs, so it cannot evaluate this map at all; cel-go types the literal as map(string, dyn) and evaluates it. Direct mode can therefore never evaluate this field. Whether KRO evaluates it depends on the rest of cel-go's type checking under KRO's environment, which this check does not model`,
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
  depth: number,
  brackets: BracketIndex
): void {
  if (depth > CEL_DIALECT_MAX_NESTING_DEPTH) return;
  // Ternary branches are lazy in both engines, so each `?`/`:` part is its own
  // chain rather than an operand of the surrounding one.
  for (const part of splitTopLevel(masked, span, ['?', ':'], brackets)) {
    checkChain(expression, masked, blanked, field, part, established, findings, depth, brackets);
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
  depth: number,
  brackets: BracketIndex
): void {
  if (depth > CEL_DIALECT_MAX_NESTING_DEPTH) return;
  // Precedence: `||` is the loosest operator, so it splits first and each
  // disjunct is then read as its own `&&` chain.
  const disjuncts = splitTopLevel(masked, span, ['||'], brackets);
  const conjuncts = disjuncts.length > 1 ? [] : splitTopLevel(masked, span, ['&&'], brackets);
  const mode: ChainMode | undefined =
    disjuncts.length > 1 ? 'or' : conjuncts.length > 1 ? 'and' : undefined;

  if (mode === undefined) {
    // Not a chain, but a parenthesized group inside it may hold one — and that
    // group inherits whatever this position already established.
    for (const group of parenGroups(masked, span, brackets)) {
      checkLogicalChain(
        expression,
        masked,
        blanked,
        field,
        group,
        established,
        findings,
        depth + 1,
        brackets
      );
    }
    return;
  }

  const operands = mode === 'or' ? disjuncts : conjuncts;
  const guards = operands.map((operand) => guardsEstablishedBy(blanked, operand, mode, brackets));
  let known: string[] = [...established];

  for (let index = 0; index < operands.length; index += 1) {
    const operand = operands[index] as Span;
    const after = guards.slice(index + 1).flat();
    const derefs = dereferencedPaths(blanked, operand, brackets);

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
    checkChain(expression, masked, blanked, field, operand, known, findings, depth + 1, brackets);
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

/**
 * How one identified fragment is rewritten into a form cel-js does parse.
 *
 * The rewrite is a **grammatical** substitution, not a semantic one: each kind
 * replaces a fragment with a different spelling of the *same spec production*,
 * so the rewritten text is grammatical exactly when the original was.
 *
 * - `receiver` — a literal, parenthesized group or global call used as the
 *   receiver of a member access, replaced by a bare identifier placeholder
 *   (`__typekro_recv0`, bound nowhere). The spec makes each of those a `Member`,
 *   and `IDENT` is a `Member` too, so the substitution keeps the production and
 *   drops only the part cel-js's `atomicExpression` cannot carry a postfix on.
 * - `string` — an `r`/`b`-prefixed or triple-quoted `STRING_LIT`, replaced by a
 *   plain double-quoted literal of the same width. Still a `LITERAL` Primary.
 * - `float` — an exponent `FLOAT_LIT`, replaced by cel-js's own `-?\d+\.\d+`
 *   float spelling of the same width. Still a `LITERAL` Primary.
 *
 * `string` and `float` are width-preserving by construction; `receiver` is not,
 * which is why rewrites are applied right to left (see
 * {@link rewriteAwayCelJsLimitations}).
 */
type CelJsRewriteKind = 'receiver' | 'string' | 'float';

/** The exact `[start, end)` of a fragment to rewrite, and how to rewrite it. */
interface SpecCelRewrite {
  readonly start: number;
  readonly end: number;
  readonly as: CelJsRewriteKind;
}

/** One confirmed cel-js shortfall against the spec grammar. */
interface SpecCelLimitation {
  readonly at: number;
  readonly fragment: string;
  readonly reason: string;
  /**
   * The rewrite that removes this shortfall, when one can be built. A shortfall
   * with no rewrite can never take part in a divergence proof — the safe
   * direction, since the proof is what licenses failing strict mode.
   */
  readonly rewrite?: SpecCelRewrite;
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
function findSpecCelCelJsRejects(
  expression: string,
  masked: string,
  brackets: BracketIndex
): SpecCelLimitation[] {
  const found: SpecCelLimitation[] = [];
  // `end` bounds the quoted *excerpt* and is deliberately generous — it runs past
  // the fragment so the reader sees what it was the receiver of. `rewrite` is the
  // exact span, which is a different thing and never guessed from `end`.
  const add = (at: number, end: number, reason: string, rewrite?: SpecCelRewrite): void => {
    found.push({
      at,
      fragment: expression.slice(at, Math.min(end, at + 80)).trim(),
      reason,
      ...(rewrite === undefined ? {} : { rewrite }),
    });
  };

  // Spec: `Primary = ... | LITERAL`, and `Member = Member "." SELECTOR [...]`
  // | `Member "[" Expr "]"`, so a postfix applies to a literal primary. cel-js
  // consumes a StringLiteral as a bare `atomicExpression` alternative with no
  // postfix at all: `"x".size()`, `"a" .size()` and `"a"["b"]` all fail.
  for (const span of stringLiteralSpans(expression)) {
    const postfix = postfixFollows(masked, span.end);
    if (postfix !== undefined) {
      add(span.start, span.end + 24, 'a string literal used as the receiver of a member access', {
        start: span.start,
        end: span.end,
        as: 'receiver',
      });
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
      add(before, span.end, 'a raw-string or bytes literal prefix, which cel-js has no token for', {
        start: before,
        end: span.end,
        as: 'string',
      });
    }
  }
  // Spec `STRING_LIT` also admits the triple-quoted forms; cel-js has neither.
  for (const quote of ['"""', "'''"]) {
    const at = expression.indexOf(quote);
    if (at < 0) continue;
    // The closing run is what makes the literal rewritable. Without one there is
    // no span to substitute, so the shortfall is recorded with no rewrite and
    // can never carry a divergence on its own.
    const closed = expression.indexOf(quote, at + quote.length);
    add(
      at,
      at + 24,
      'a triple-quoted string literal, which cel-js has no token for',
      closed < 0 ? undefined : { start: at, end: closed + quote.length, as: 'string' }
    );
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
    const close = matchingParen(brackets, index);
    if (close < 0 || postfixFollows(masked, close + 1) === undefined) continue;
    if (!identifierCall) {
      add(index, close + 24, 'a parenthesized expression used as the receiver of a member access', {
        start: index,
        end: close + 1,
        as: 'receiver',
      });
      continue;
    }
    // A global function call — `size(a)`, `has(a.b)`, `int(a)` — is cel-js's
    // `macrosExpression`, which also takes no postfix, so `size(a).b` fails.
    // A *member* call (`a.map(x, x).size()`) is part of `identifierExpression`
    // and cel-js handles it, so a callee written after a `.` is left alone.
    let start = before;
    while (start >= 0 && IDENT_CHARACTER.test(masked[start] as string)) start -= 1;
    if (previousNonSpace(masked, start + 1) < 0 || (masked[start] as string) !== '.') {
      add(
        start + 1,
        close + 24,
        'a global function call used as the receiver of a member access',
        { start: start + 1, end: close + 1, as: 'receiver' }
      );
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
    const close = matchingParen(brackets, index);
    if (close < 0) continue;
    if (postfixFollows(masked, close + 1) === '.') {
      add(index, close + 24, 'a list literal used as the receiver of a member access', {
        start: index,
        end: close + 1,
        as: 'receiver',
      });
      continue;
    }
    // The one permitted index, then anything further is past what cel-js takes.
    if (postfixFollows(masked, close + 1) !== '[') continue;
    const second = matchingParen(brackets, nextNonSpace(masked, close + 1));
    if (second > 0 && postfixFollows(masked, second + 1) !== undefined) {
      // The list *and* its one permitted index collapse into the placeholder:
      // `[1,2][0].f` is grammatical as `__typekro_recv0.f`, where rewriting the
      // list alone would leave `__typekro_recv0[0].f` — still past cel-js.
      add(index, second + 24, 'a list literal with more than the one postfix cel-js allows', {
        start: index,
        end: second + 1,
        as: 'receiver',
      });
    }
  }

  // Spec: `Primary = ... | LITERAL` covers the number, bool and null literals
  // too, so `1.string()`, `1.0.x`, `2u.x`, `true.x` and `null.x` are all
  // grammatical. cel-js consumes each as a bare token with no postfix.
  const literalReceiver =
    /(?<![A-Za-z0-9_.])(0[xX][0-9a-fA-F]+[uU]?|\d+(?:\.\d+)?[uU]?|true|false|null)\s*\.\s*[A-Za-z_]/g;
  for (const match of masked.matchAll(literalReceiver)) {
    // Only the literal itself is the receiver; the `.` and the selector after it
    // are the member access that stays.
    const literal = match[1] as string;
    add(
      match.index,
      match.index + match[0].length,
      'a number, bool or null literal used as the receiver of a member access',
      { start: match.index, end: match.index + literal.length, as: 'receiver' }
    );
  }

  // Spec: `FLOAT_LIT ::= -? DIGIT* . DIGIT+ EXPONENT? | -? DIGIT+ EXPONENT`.
  // cel-js's `Float` token is `-?\d+\.\d+` with no exponent form, so `1e3`,
  // `1.5e-3` and `0.5e3` are all rejected.
  for (const match of masked.matchAll(/(?<![A-Za-z0-9_.])\d+(?:\.\d+)?[eE][+-]?\d+/g)) {
    add(
      match.index,
      match.index + match[0].length,
      'a float literal written with an exponent, which cel-js has no token for',
      { start: match.index, end: match.index + match[0].length, as: 'float' }
    );
  }

  return found.sort((left, right) => left.at - right.at);
}

/**
 * Largest number of rewrite rounds {@link rewriteAwayCelJsLimitations} will run.
 *
 * One round removes every shortfall that is not nested inside another, so a
 * round is needed per level of nesting: `("x".size()).b` takes one (the outer
 * parenthesized receiver swallows the inner string one), `r"x".size()` takes two
 * (the raw prefix goes first, and only then is the plain literal visible as a
 * receiver). Real emitted status CEL reaches one. The cap exists so a pathological
 * expression cannot loop — each round either rewrites something or the loop
 * stops, and hitting the cap simply means no divergence is proven, which is the
 * safe direction.
 */
const CEL_DIALECT_MAX_REWRITE_ROUNDS = 8;

/** Receiver placeholders are bound nowhere; only their grammar matters. */
const CEL_JS_RECEIVER_PLACEHOLDER = '__typekro_recv';

/* ---------------------------------------------------------------------------
 * Lexical coverage: "cel-js parsed it" has to mean "cel-js read all of it".
 *
 * cel-js's `parse()` (dist/lib.js) calls `CELLexer.tokenize(expression)` and
 * then looks only at `parserInstance.errors` — `lexResult.errors` is discarded
 * unread. A chevrotain lexer skips a character it has no token for and carries
 * on, so every character cel-js has no token for is dropped silently before the
 * parser ever sees the text: `a === b` reaches the parser as `a == b` and
 * "parses", and so do `x.size() $` and `x.size() ☃`. Taking `isSuccess` as
 * proof that cel-js accepted the *text* is therefore wrong in exactly the
 * direction that matters here — a divergence proof is a claim about the whole
 * expression, and a parse that dropped part of it proves nothing about the part
 * it dropped.
 *
 * **Which route this takes, and why.** The first choice would be to ask cel-js
 * itself: `dist/tokens.js` exports both `CELLexer` and the `allTokens`
 * vocabulary, and `CELLexer.tokenize()` returns the `errors` that `parse()`
 * throws away. It is not reachable. cel-js 0.8.2's package.json declares
 * `"exports": { ".": "./dist/index.js" }` and nothing else, so
 * `cel-js/dist/tokens.js` does not resolve, and `index.js` re-exports only
 * `parse`, `evaluate` and the three error classes — no lexer, no token
 * vocabulary. The second choice, running chevrotain's own `Lexer` over that
 * vocabulary, needs the same unreachable export (and `chevrotain` is cel-js's
 * dependency, not TypeKro's). So this takes the third route: a coverage scanner
 * written from the CEL specification's own lexical grammar (cel-spec
 * doc/langdef.md, "Lexical Elements"), which walks the text and reports the
 * first character no CEL token can carry.
 *
 * That scanner is a superset of cel-js's lexer — it knows the raw, bytes and
 * triple-quoted `STRING_LIT` forms and the exponent `FLOAT_LIT` that cel-js has
 * no token for — and the superset direction is the safe one for both jobs it
 * does. As a *proof* gate it can only withhold a divergence, never invent one:
 * anything cel-js's lexer drops is a character cel-js has no token for, and the
 * only such characters the spec does have a token for are the four forms just
 * named, each of which the rewriter has already replaced by the time a proof is
 * checked. As a `not-valid-cel` input it reports only characters the **spec**
 * has no token for, which is a fact about the language rather than about either
 * engine, so it belongs in that bucket by the same standard as the rest of it.
 * ------------------------------------------------------------------------- */

/** `WHITESPACE ::= [\t\n\f\r ]+`. */
const CEL_WHITESPACE = /[\t\n\f\r ]/;
/** `DIGIT ::= [0-9]`. */
const CEL_DIGIT = /[0-9]/;
/** `HEXDIGIT ::= [0-9abcdefABCDEF]`. */
const CEL_HEXDIGIT = /[0-9a-fA-F]/;
/** The first character of `IDENT ::= [_a-zA-Z][_a-zA-Z0-9]*`. */
const CEL_IDENT_START = /[_A-Za-z]/;

/** The two-character operators in the spec's punctuation list. */
const CEL_PUNCTUATION_PAIRS = new Set(['||', '&&', '==', '!=', '<=', '>=']);
/** The one-character punctuation, once the pairs above are taken out. */
const CEL_PUNCTUATION_SINGLES = '()[]{}.,?:!<>+-*/%';

/**
 * End of the `STRING_LIT`/`BYTES_LIT` token starting at `at`, or `at` for none.
 *
 * `STRING_LIT ::= [rR]? ( '"' … '"' | "'" … "'" | '"""' … '"""' | "'''" … "'''" )`
 * and `BYTES_LIT ::= [bB] STRING_LIT`; cel-go accepts the two prefixes in
 * either order, so at most one of each is taken. A prefix with no quote behind
 * it is not a string at all and is handed back for `IDENT` to consume, which is
 * what makes `bar"x"` lex as an identifier and a string rather than as nothing.
 *
 * A `\` always consumes the character after it, raw literals included: the
 * spec's raw form suppresses escape *interpretation*, not escape *lexing*, so
 * `r"a\"b"` is one token in cel-go too. An unterminated literal, or a newline
 * inside a single-delimiter one, is not a token — the opening quote is then the
 * character nothing can carry, which is the honest place to point at.
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

  const delimiter = ['"""', "'''", '"', "'"].find((candidate) => text.startsWith(candidate, index));
  if (delimiter === undefined) return at;

  for (let scan = index + delimiter.length; scan < text.length; scan += 1) {
    const character = text[scan] as string;
    if (character === '\\') {
      if (scan + 1 >= text.length) return at;
      scan += 1;
      continue;
    }
    if (delimiter.length === 1 && (character === '\n' || character === '\r')) return at;
    if (text.startsWith(delimiter, scan)) return scan + delimiter.length;
  }
  return at;
}

/**
 * End of the `INT_LIT`/`UINT_LIT`/`FLOAT_LIT` token starting at `at`, or `at`.
 *
 * `INT_LIT ::= DIGIT+ | '0x' HEXDIGIT+`, `UINT_LIT ::= INT_LIT [uU]`,
 * `FLOAT_LIT ::= DIGIT* '.' DIGIT+ EXPONENT? | DIGIT+ EXPONENT` and
 * `EXPONENT ::= [eE] [+-]? DIGIT+`. The leading `-` the spec writes into each
 * form is consumed as punctuation instead, which changes no coverage verdict.
 * `0x` with no hex digit behind it falls through to the decimal form, because
 * cel-go's longest-match lexer reads that as `0` and the identifier `x`.
 */
function celNumberLiteralEnd(text: string, at: number): number {
  if (!CEL_DIGIT.test(text[at] ?? '')) return at;

  if (text[at] === '0' && (text[at + 1] === 'x' || text[at + 1] === 'X')) {
    let hex = at + 2;
    while (hex < text.length && CEL_HEXDIGIT.test(text[hex] as string)) hex += 1;
    if (hex > at + 2) return text[hex] === 'u' || text[hex] === 'U' ? hex + 1 : hex;
  }

  let end = at;
  while (end < text.length && CEL_DIGIT.test(text[end] as string)) end += 1;
  if (text[end] === '.' && CEL_DIGIT.test(text[end + 1] ?? '')) {
    end += 1;
    while (end < text.length && CEL_DIGIT.test(text[end] as string)) end += 1;
  }
  const exponent = /^[eE][+-]?[0-9]+/.exec(text.slice(end));
  if (exponent !== null) return end + exponent[0].length;
  return text[end] === 'u' || text[end] === 'U' ? end + 1 : end;
}

/** End of the one CEL token starting at `at`, or `at` when there is none. */
function celSpecTokenEnd(text: string, at: number): number {
  const character = text[at] as string;

  if (CEL_WHITESPACE.test(character)) {
    let end = at + 1;
    while (end < text.length && CEL_WHITESPACE.test(text[end] as string)) end += 1;
    return end;
  }

  // `COMMENT ::= '//' ~NEWLINE*`.
  if (character === '/' && text[at + 1] === '/') {
    const newline = text.slice(at).search(/[\r\n]/);
    return newline < 0 ? text.length : at + newline;
  }

  const string = celStringLiteralEnd(text, at);
  if (string > at) return string;

  const number = celNumberLiteralEnd(text, at);
  if (number > at) return number;

  if (CEL_IDENT_START.test(character)) {
    let end = at + 1;
    while (end < text.length && IDENT_CHARACTER.test(text[end] as string)) end += 1;
    return end;
  }

  if (CEL_PUNCTUATION_PAIRS.has(text.slice(at, at + 2))) return at + 2;
  return CEL_PUNCTUATION_SINGLES.includes(character) ? at + 1 : at;
}

/**
 * Offset of the first character of `text` no CEL token can carry, or `-1`.
 *
 * A `-1` means the spec's lexical grammar tiles the text end to end with no
 * gaps: every character belongs to a token, a comment or whitespace. That is
 * the property `parse()` does not check, and it is now required before anything
 * is read into a cel-js verdict.
 */
function firstUnlexableOffset(text: string): number {
  let index = 0;
  while (index < text.length) {
    const end = celSpecTokenEnd(text, index);
    if (end <= index) return index;
    index = end;
  }
  return -1;
}

/** What cel-js did with an expression: whether it read all of it, and parsed it. */
interface CelJsReading {
  /** cel-js's parser accepted the token stream its lexer handed it. */
  readonly parsed: boolean;
  /** Offset of the first character no CEL token can carry, or `-1` for none. */
  readonly unlexableAt: number;
}

/** Run cel-js's parser and the lexical coverage scan over the same text. */
function celJsReads(expression: string): CelJsReading {
  let parsed = false;
  try {
    parsed = parse(expression).isSuccess === true;
  } catch {
    parsed = false;
  }
  return { parsed, unlexableAt: firstUnlexableOffset(expression) };
}

/**
 * cel-js accepted the **whole** text: every character is carried by a CEL token
 * and the parser accepted the token stream.
 *
 * This — never `parse().isSuccess` on its own — is what "cel-js parses it" means
 * anywhere a verdict is drawn from it, whether that is a divergence proof or the
 * gate that decides an expression is established grammatical.
 */
function celJsAcceptsWhole(expression: string): boolean {
  const reading = celJsReads(expression);
  return reading.parsed && reading.unlexableAt < 0;
}

/**
 * How deep the swallowed-span check will recurse before giving up.
 *
 * A bracketed receiver span nested inside another bracketed receiver span costs
 * one level — `(("x".size()).b).c` is two — and each level asks cel-js about a
 * strictly shorter piece of text, so the recursion terminates on its own. The
 * cap bounds the *cost* rather than the termination: without it an adversarial
 * chain of nested receivers would re-parse a prefix of the expression once per
 * level, which is the quadratic shape this module has already had to fix once.
 * Real emitted status CEL reaches one level; giving up past eight only means no
 * divergence is proven, which is the safe direction.
 */
const CEL_DIALECT_MAX_SPAN_DEPTH = 8;

/**
 * Whether cel-js accepts the span a `receiver` rewrite is about to swallow.
 *
 * The rewrite replaces a whole bracketed span with one identifier, so the text
 * cel-js is asked about no longer contains it. Without this check the proof
 * inherits exactly the defect it was built to rule out: `(a &&).b`, `size(a +).b`
 * and `[1, ,2].size()` each rewrite to something cel-js parses — `__typekro_recv0.b`
 * — while the part that vanished is ungrammatical on any engine, so cel-go
 * refuses the original as readily as cel-js does and the "divergence" is a false
 * positive against strict mode.
 *
 * The span is held to the same bar as the whole expression, recursively: cel-js
 * accepts it outright, or a proof of its own establishes it. The recursion is
 * needed because a span can carry its own shortfall — `("x".size()).b` swallows
 * `("x".size())`, which cel-js cannot parse for a reason that *is* a divergence.
 *
 * Spans that carry no bracket — a string-literal receiver, an `r`/`b` prefix, a
 * triple-quoted literal, an exponent float, a number/bool/null receiver — are a
 * single literal token with no subexpression inside it to be ungrammatical, and
 * the lexical coverage scan over the original has already established that each
 * is a well-formed token. Everything a bracket could hide is checked: the
 * parenthesized group, the global call's argument list, and the list literal.
 */
function celJsAcceptsSwallowedSpan(text: string, rewrite: SpecCelRewrite, depth: number): boolean {
  if (rewrite.as !== 'receiver') return true;
  const span = text.slice(rewrite.start, rewrite.end);
  const spanMasked = maskCelStringLiterals(span);
  if (!/[([{]/.test(spanMasked)) return true;
  if (depth >= CEL_DIALECT_MAX_SPAN_DEPTH) return false;
  if (celJsAcceptsWhole(span)) return true;

  // Every receiver rewrite requires a postfix operator after its span, so `span`
  // is strictly shorter than `text` and the recursion cannot revisit it.
  const rewritten = rewriteAwayCelJsLimitations(
    span,
    spanMasked,
    buildBracketIndex(spanMasked),
    depth + 1
  );
  return rewritten.applied > 0 && celJsAcceptsWhole(rewritten.text);
}

/**
 * Rewrite every identified cel-js shortfall out of an expression, leaving the
 * rest of it byte for byte as it was.
 *
 * This is the evidence half of the `cel-js-rejects-spec-cel` bucket. A cel-js
 * parse failure plus a shortfall *somewhere* in the text proves nothing on its
 * own: the failure may be caused by a genuine syntax error elsewhere — `"x".size() +`
 * has a string-literal receiver in it and is also simply unfinished, and cel-go
 * rejects it as readily as cel-js does. Divergence needs the stronger claim that
 * the identified shortfalls are the *only* reason cel-js refuses the text, and
 * the way to establish that is to take them away and ask cel-js again.
 *
 * Each round re-runs the detector over the current text and applies the
 * outermost non-overlapping rewrites, right to left so the spans of the
 * not-yet-applied rewrites stay valid; the text is re-masked between rounds
 * because a rewrite can change where the string literals are. Overlapping
 * shortfalls — a string receiver inside a parenthesized receiver — resolve
 * outermost-first, and whatever is left over is picked up by the next round.
 *
 * A `receiver` rewrite over a bracketed span *swallows* that span: `(a && b).c`
 * becomes `__typekro_recv0.c`, and whatever was between the brackets is gone
 * from the text cel-js is asked about. That makes the same mistake the whole
 * proof exists to avoid, one level down — the parse says nothing about the part
 * it never saw — so a bracketed span is swallowed only once cel-js has been
 * shown to accept the span itself; see {@link celJsAcceptsSwallowedSpan}.
 */
function rewriteAwayCelJsLimitations(
  expression: string,
  masked: string,
  brackets: BracketIndex,
  depth = 0
): { readonly text: string; readonly applied: number } {
  let text = expression;
  let current = masked;
  let currentBrackets = brackets;
  let placeholders = 0;
  let applied = 0;

  for (let round = 0; round < CEL_DIALECT_MAX_REWRITE_ROUNDS; round += 1) {
    const candidates = findSpecCelCelJsRejects(text, current, currentBrackets)
      .map((limitation) => limitation.rewrite)
      .filter((rewrite): rewrite is SpecCelRewrite => rewrite !== undefined && rewrite.end > rewrite.start)
      .filter((rewrite) => celJsAcceptsSwallowedSpan(text, rewrite, depth))
      // Outermost first at a shared start, so a containing span wins and the
      // contained one is skipped rather than splitting the container in two.
      .sort((left, right) => left.start - right.start || right.end - left.end);

    const chosen: SpecCelRewrite[] = [];
    for (const candidate of candidates) {
      const overlaps = chosen.some(
        (taken) => candidate.start < taken.end && taken.start < candidate.end
      );
      if (!overlaps) chosen.push(candidate);
    }
    if (chosen.length === 0) break;

    // Numbered left to right, so a reader of the proof meets `__typekro_recv0`
    // before `__typekro_recv1`; `chosen` is already in source order.
    const replacements = chosen.map((rewrite) => {
      const width = rewrite.end - rewrite.start;
      if (rewrite.as === 'receiver') return `${CEL_JS_RECEIVER_PLACEHOLDER}${placeholders++}`;
      const filler = Math.max(1, width - 2);
      return rewrite.as === 'string'
        ? `"${'x'.repeat(filler)}"`
        : `0.${'0'.repeat(filler)}`;
    });

    // Applied right to left: a `receiver` rewrite changes the width of the text,
    // and splicing from the end keeps every earlier span indexing what it named.
    for (let index = chosen.length - 1; index >= 0; index -= 1) {
      const rewrite = chosen[index] as SpecCelRewrite;
      text = text.slice(0, rewrite.start) + (replacements[index] as string) + text.slice(rewrite.end);
      applied += 1;
    }
    current = maskCelStringLiterals(text);
    currentBrackets = buildBracketIndex(current);
  }

  return { text, applied };
}

/**
 * The rewrite, when cel-js accepts it whole — i.e. when it proves the divergence.
 *
 * "Accepts it whole" is {@link celJsAcceptsWhole} rather than `parse()`: a
 * rewrite that only "parses" because cel-js's lexer dropped a character it has
 * no token for proves nothing about the character it dropped, and the text the
 * proof is about is the text including that character. The original is held to
 * the same bar, so a proof is never built on top of an expression that is not
 * itself lexically CEL.
 */
function celJsParseProof(
  trimmed: string,
  masked: string,
  brackets: BracketIndex
): string | undefined {
  if (firstUnlexableOffset(trimmed) >= 0) return undefined;
  const rewritten = rewriteAwayCelJsLimitations(trimmed, masked, brackets);
  return rewritten.applied > 0 && celJsAcceptsWhole(rewritten.text) ? rewritten.text : undefined;
}

/**
 * Offset of the first character of `expression` no CEL token can carry, or `-1`
 * when the spec's lexical grammar covers the text end to end.
 *
 * Exported for the same reason {@link celDialectParseProof} is: the coverage
 * scan is half of what "cel-js parsed it" means here, so it has to be checkable
 * from outside rather than taken on trust. `-1` is the precondition for every
 * verdict this module draws from a cel-js parse — see
 * {@link firstUnlexableOffset} for why `parse()` alone is not enough.
 */
export function celDialectLexicalGap(expression: string): number {
  return firstUnlexableOffset(expression.trim());
}

/**
 * The rewritten expression a `cel-js-rejects-spec-cel` divergence stands on, or
 * `undefined` when there is none.
 *
 * Exported so the proof can be reproduced rather than taken on trust: the
 * returned text differs from `expression` only where a confirmed cel-js
 * shortfall was replaced by a same-production spelling cel-js has, cel-js's
 * lexer carries every character of it and cel-js parses it. An expression with
 * no identified shortfall, one whose own text is not lexically CEL, or one where
 * taking the shortfalls away still leaves text cel-js refuses, yields
 * `undefined` — and that is exactly the case the check refuses to call a
 * divergence.
 */
export function celDialectParseProof(expression: string): string | undefined {
  const trimmed = expression.trim();
  if (trimmed.length === 0 || trimmed.length > CEL_DIALECT_MAX_EXPRESSION_LENGTH) return undefined;
  const masked = maskCelStringLiterals(trimmed);
  const brackets = buildBracketIndex(masked);
  if (findSpecCelCelJsRejects(trimmed, masked, brackets).length === 0) return undefined;
  return celJsParseProof(trimmed, masked, brackets);
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
 * @param parsed Whether cel-js's *parser* accepted the token stream. The
 *   unpaired-`?` check is gated on a failure only because a successful parse
 *   already proves every ternary is closed — `?` and `:` are both cel-js tokens,
 *   so neither can be among the characters its lexer dropped — which makes
 *   running the check wasted work rather than unsound.
 * @param unlexableAt Offset of the first character no CEL token can carry, from
 *   {@link firstUnlexableOffset}, or `-1`. Reported here because "the lexical
 *   grammar has no token for this character" is a fact about the spec, not
 *   about an engine, which is the standard the rest of this bucket is held to.
 */
function findNonCelTokens(
  expression: string,
  masked: string,
  parsed: boolean,
  unlexableAt: number
): NonCelToken[] {
  const found: NonCelToken[] = [];
  const add = (at: number, length: number, reason: string): void => {
    found.push({ at, fragment: expression.slice(at, at + Math.max(length, 8)).trim(), reason });
  };

  if (unlexableAt >= 0) {
    const character = expression[unlexableAt] as string;
    add(
      unlexableAt,
      8,
      character === '"' || character === "'"
        ? 'an unterminated string literal — `STRING_LIT` has to close with the delimiter it opened with, and a single-quoted form cannot span a newline'
        : `\`${character}\` — a character the CEL lexical grammar has no token for: it is in neither \`IDENT\`, nor any literal form, nor the punctuation list`
    );
  }

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
  // Every bracket pair, resolved once. Both halves of the check walk the same
  // text repeatedly — the receiver detectors touch every opener in it — and
  // rescanning forward from each one is what used to make a deeply nested
  // expression quadratic.
  const brackets = buildBracketIndex(masked);

  // Half one: what cel-js's parser can and cannot be made to say.
  //
  // It can say that *direct mode* cannot evaluate the field, and nothing more.
  // cel-js 0.8.2 is not a conformant CEL grammar — it rejects `"x".size()`,
  // `[1,2].size()`, `(a).b` and `1e3`, all of which the spec permits — so a
  // parse failure on its own is no evidence at all about cel-go or KRO. The
  // three buckets below each carry their own evidence instead, and only the one
  // backed by a positive, spec-cited identification of valid CEL is a
  // divergence.
  //
  // "cel-js parsed it" means its lexer carried every character *and* its parser
  // accepted the token stream. `parse()` checks only the second half — it reads
  // `parserInstance.errors` and discards `lexResult.errors` — so a text whose
  // unknown characters its lexer dropped "parses" while cel-js never saw all of
  // it. `unlexableAt` is the missing half; see {@link firstUnlexableOffset}.
  const reading = celJsReads(trimmed);
  const parsed = reading.parsed && reading.unlexableAt < 0;

  // Bucket one: text no CEL grammar accepts. Built from the spec's own lexical
  // and syntactic grammar, never from cel-js's verdict, and so run whether or
  // not cel-js parsed — its lexer drops an unknown character silently, and
  // `a === b` reaches its parser as `a == b`.
  const nonCel = findNonCelTokens(trimmed, masked, reading.parsed, reading.unlexableAt);
  const leak = nonCel[0];
  // Hoisted out of bucket two: half two is gated on it. See the comment there.
  let proof: string | undefined;
  if (leak !== undefined) {
    findings.push(
      finding(
        'not-valid-cel',
        field,
        trimmed,
        leak.fragment,
        `this is not CEL under the language grammar, whichever engine reads it: ${leak.reason}. Both engines reject it at the parse, before any type environment is consulted, so direct mode can never evaluate this status field and cel-go cannot parse it inside the KRO controller either`,
        'Usually JavaScript that survived conversion. Write the CEL form instead: a has() guard rather than `?.`, an index rather than `?[`, `==` rather than `===`, and a resolved reference rather than an un-substituted template placeholder'
      )
    );
  } else if (!parsed) {
    // Bucket two: a cel-js parse failure that a positive check identifies as
    // grammatical CEL. This may fail strict mode.
    //
    // What it claims, exactly: the CEL grammar permits the form, cel-js's
    // refusal is cel-js's own shortfall, and direct mode can therefore never
    // evaluate this field. It does *not* claim the field resolves under KRO.
    // Parsing is not evaluating: cel-go's type checker runs after the parse with
    // KRO's type environment and function set, and it rejects plenty of
    // grammatical CEL — `1.string()` parses, but `string` is a global conversion
    // function rather than a member, so the checker refuses the call; an unknown
    // member function goes the same way. Nothing here models that checker, so
    // nothing here may speak for it.
    //
    // `divergence` is still the right kind under that weaker claim. The two
    // engines disagree on the *form*, at the parse stage both of them have and
    // which needs no type environment at all: the spec's grammar admits it,
    // cel-go implements that grammar, and cel-js does not. Direct mode is
    // therefore broken on an expression the language permits, whatever cel-go's
    // checker later decides — so the emitted CEL is defective for one of the two
    // targets TypeKro serializes for, which is what strict mode exists to catch.
    //
    // Finding a known cel-js shortfall *somewhere* in the text is not enough to
    // get here. A parse failure has exactly one cause the whole expression can
    // be blamed on, and an expression that carries a shortfall may also simply
    // be ungrammatical elsewhere — `"x".size() +`, `(a).b ==`, `"x".size())`.
    // cel-go rejects those too, so calling them divergences would fail strict
    // mode on genuinely invalid CEL. The stronger claim is the one that has to
    // hold: rewrite the identified shortfalls into spellings cel-js does have,
    // leaving everything else untouched, and ask cel-js again. Only if the
    // rewrite parses is the shortfall the *only* obstruction, which is what
    // makes the rest of the expression grammatical CEL and cel-go's acceptance
    // of it a fact rather than an inference.
    const limitation = findSpecCelCelJsRejects(trimmed, masked, brackets)[0];
    proof = limitation === undefined ? undefined : celJsParseProof(trimmed, masked, brackets);

    if (limitation !== undefined && proof !== undefined) {
      findings.push(
        finding(
          'cel-js-rejects-spec-cel',
          field,
          trimmed,
          limitation.fragment,
          `cel-js cannot parse this, but the CEL grammar permits it: ${limitation.reason} (cel-spec doc/langdef.md, "Syntax"). Replacing only that form with a spelling cel-js does have — \`${excerpt(proof)}\` — makes cel-js parse the whole expression, so nothing else in it is ungrammatical and the refusal is cel-js's shortfall alone. Direct mode can therefore never evaluate this field. Whether KRO evaluates it is a further question this check does not model: cel-go parses the form, but its type checker then runs with KRO's type environment and function set and may still reject it`,
          'Rewrite the receiver as an identifier chain — bind the literal or parenthesized value to a resource field, or use the global form of the call (`size(x)` rather than `x.size()`) — until cel-js supports the spec form'
        )
      );
    } else {
      // Bucket three: cel-js cannot parse it and nothing above explains why —
      // either no known shortfall was identified, or one was and taking it away
      // still left text cel-js refuses, which means something else in the
      // expression is at fault and no divergence is established. The only sound
      // claim either way is about direct mode.
      const unexplained =
        limitation === undefined
          ? 'Neither the non-CEL token scan nor the confirmed cel-js shortfalls account for the refusal'
          : `A confirmed cel-js shortfall was identified in it (${limitation.reason}), but rewriting that form into one cel-js does have still leaves the expression unparseable, so the shortfall is not the whole reason and nothing here is established beyond direct mode`;
      findings.push(
        finding(
          'cel-js-parse-failure',
          field,
          trimmed,
          undefined,
          `cel-js cannot parse this expression, so direct mode cannot evaluate this field; the CEL specification may still permit it, and the controller may still serve it. ${unexplained}. Verify against the spec grammar; if it is valid CEL, this is a cel-js limitation worth reporting upstream`,
          'Check the expression against cel-spec doc/langdef.md. If the grammar permits it, only direct mode is certainly affected — whether Kro mode serves the field also depends on cel-go\'s type checker under KRO\'s environment, which this check does not model. Otherwise fix the emitted CEL'
        )
      );
    }
  }

  // Half two: the curated cel-go/cel-js divergence denylist, gated on the
  // expression being established grammatical.
  //
  // Every rule here is regex- and bracket-mask-based rather than tree-based, so
  // none of them *needs* a parse to run — and that is exactly why the gate has
  // to be explicit. What each rule needs is not a parse tree but the structure
  // it reads off the text: `has-index-argument` wants the argument list of a
  // `has(` to be a real bracket pair, `heterogeneous-map-literal` wants `{`…`}`
  // to be a map literal, and `guard-after-use-in-logical-chain` wants the
  // top-level `&&`/`||` split to be the expression's actual operator chain. On
  // ungrammatical text none of that is established: `a?.b && has(list[0].f)` and
  // `foo(((( && has(list[0].f)` are not CEL at all, yet both used to report a
  // `has-index-argument` divergence and so could fail strict mode on text cel-go
  // rejects outright — the exact class of false positive this check exists to
  // avoid. cel-js merely failing to parse something is *not* that case, which is
  // the point the gate has to be careful about: cel-js is not a conformant
  // grammar, so its refusal alone establishes nothing either way.
  //
  // So the gate is grammaticality, established one of two ways:
  //
  //  - cel-js accepted the whole expression — its lexer carried every character
  //    and its parser took the token stream. cel-js's grammar is a subset of the
  //    spec's, so anything it accepts is CEL.
  //  - the rewrite proof succeeded. The proof text is grammatical CEL, and the
  //    original differs from it only inside the rewritten spans — each of which
  //    is itself either a single well-formed literal token or a bracketed span
  //    cel-js has separately been shown to accept (see
  //    {@link celJsAcceptsSwallowedSpan}). So the original is grammatical too.
  //
  // Under a proof the rules run over the **original** text, not the proof text.
  // That is both sound and necessary. Sound, because a rewrite substitutes a
  // same-production spelling for a balanced span: a `receiver` rewrite replaces
  // a whole bracket pair (or a quoted token) with an identifier and the `string`
  // and `float` rewrites replace one literal token with another, so no bracket
  // pair outside a rewritten span is opened, closed or re-paired, and no
  // top-level `&&`/`||`/`?`/`:` is added or removed — every operator a rewrite
  // takes away was inside a bracket pair and so was never part of the top-level
  // chain. Necessary, because the rules must be able to read *inside* the
  // rewritten spans: `has(list[0].f).x` collapses to `__typekro_recv0.x`, and
  // the `has()` the rule is looking for survives only in the original.
  //
  // On text that is neither parsed nor proven, nothing here runs — note-kind
  // rules included. A note about a map literal in text that is not CEL describes
  // a structure that is not there, and the expression is already reported by
  // half one.
  if (!(parsed || proof !== undefined)) return findings;

  checkHasIndexArgument(trimmed, masked, field, findings, brackets);
  checkHeterogeneousMapLiteral(trimmed, masked, field, findings, brackets);
  checkInOnListEntry(trimmed, masked, field, findings);
  const blanked = blankLazyRegions(masked, brackets);
  checkLogicalChain(
    trimmed,
    masked,
    blanked,
    field,
    { start: 0, end: masked.length },
    [],
    findings,
    0,
    brackets
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
