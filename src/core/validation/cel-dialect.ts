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
  | 'has-index-argument'
  | 'in-on-list-entry'
  | 'guard-after-use-in-logical-chain'
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
    summary: 'a has() guard placed to the right of the access it guards',
    observed:
      'cel-go absorbs an error in one operand of && / || when the other operand decides the result, regardless of order; cel-js evaluates left to right and propagates the error before the guard is ever reached. The divergence needs no type: the guard itself says the author expects the path to be absent sometimes',
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
    id: 'not-valid-cel',
    kind: 'note',
    dialect: 'both',
    summary: 'the expression is not valid CEL at all',
    observed:
      "cel-js's own parser rejects it, and so would cel-go — the emitted text is JavaScript that leaked through the expression converter (`?.`, `?[`, a JS list literal). A real defect, and one direct mode can never evaluate, but the same defect on both engines rather than a divergence between them",
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
  const blankTernaryGroups = (span: Span): void => {
    let index = span.start;
    while (index < span.end) {
      if (blanked[index] === '(') {
        const close = matchingParen(blanked, index);
        if (close < 0 || close > span.end) return;
        const interior = { start: index + 1, end: close };
        if (splitTopLevel(blanked, interior, ['?']).length > 1) {
          blanked = blankRange(blanked, interior.start, interior.end);
        } else {
          blankTernaryGroups(interior);
        }
        index = close + 1;
        continue;
      }
      index += 1;
    }
  };
  blankTernaryGroups({ start: 0, end: blanked.length });
  return blanked;
}

/** Every `has(<dotted path>)` guard in a span, as its guarded path. */
function guardedPaths(masked: string, span: Span): string[] {
  const slice = masked.slice(span.start, span.end);
  const paths: string[] = [];
  const pattern = /\bhas\s*\(/g;
  let match: RegExpExecArray | null = pattern.exec(slice);
  while (match !== null) {
    const open = slice.indexOf('(', match.index);
    const close = matchingParen(slice, open);
    if (close > open) {
      const argument = slice.slice(open + 1, close).trim();
      if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(argument)) paths.push(argument);
    }
    match = pattern.exec(slice);
  }
  return paths;
}

/** True when `guard` covers `path` — the same path, or an ancestor of it. */
function guardCovers(guard: string, path: string): boolean {
  return path === guard || path.startsWith(`${guard}.`);
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
 */
function checkLogicalChain(
  expression: string,
  masked: string,
  blanked: string,
  field: string,
  span: Span,
  findings: CelDialectFinding[]
): void {
  // Ternary branches are lazy in both engines, so each `?`/`:` part is its own
  // chain rather than an operand of the surrounding one.
  for (const part of splitTopLevel(masked, span, ['?', ':'])) {
    const operands = splitTopLevel(masked, part, ['&&', '||']);
    if (operands.length > 1) {
      const guardsBefore: string[][] = [];
      const guardsAfter: string[][] = [];
      const allGuards = operands.map((operand) => guardedPaths(blanked, operand));
      for (let index = 0; index < operands.length; index += 1) {
        guardsBefore.push(allGuards.slice(0, index).flat());
        guardsAfter.push(allGuards.slice(index + 1).flat());
      }

      for (let index = 0; index < operands.length; index += 1) {
        const operand = operands[index] as Span;
        const before = guardsBefore[index] as string[];
        const after = guardsAfter[index] as string[];
        const derefs = dereferencedPaths(blanked, operand);

        const lateGuard = after.find(
          (guard) =>
            derefs.some((path) => guardCovers(guard, path)) &&
            !before.some((earlier) => guardCovers(earlier, guard))
        );
        if (lateGuard !== undefined) {
          findings.push(
            finding(
              'guard-after-use-in-logical-chain',
              field,
              expression,
              expression.slice(operand.start, operand.end).trim(),
              `has(${lateGuard}) guards this operand but is written after it. cel-go absorbs the error either way; cel-js evaluates left to right and fails before reaching the guard`,
              `Move has(${lateGuard}) to the left of the access, or use a lazy ternary: has(${lateGuard}) ? (...) : <fallback>`
            )
          );
        }
      }
    }

    // Recurse into parenthesized groups so a nested chain gets the same checks.
    for (const group of parenGroups(masked, part)) {
      checkLogicalChain(expression, masked, blanked, field, group, findings);
    }
  }
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

  // Half one: cel-js's own parser, used as a stand-in for the CEL grammar
  // itself. A syntax error here is not a cel-js quirk — the forms that reach it
  // in practice (`?.`, `?[`, a JavaScript list literal) are JavaScript that
  // leaked through the expression converter, and cel-go rejects them too. So it
  // is reported as a `note` naming both engines rather than as a divergence.
  let parsed: { isSuccess: boolean } | undefined;
  try {
    parsed = parse(trimmed);
  } catch {
    parsed = { isSuccess: false };
  }
  if (!parsed.isSuccess) {
    findings.push(
      finding(
        'not-valid-cel',
        field,
        trimmed,
        undefined,
        'this is not valid CEL: cel-js cannot parse it, and cel-go would not either. Direct mode can never evaluate this status field, and KRO will refuse the ResourceGraphDefinition',
        'Usually JavaScript that survived conversion — `?.`, `?[`, `.length`, or a `[...]` list literal. Write the CEL form instead: has() guards, `size()`, and a lazy ternary'
      )
    );
    // The pattern rules below assume a parseable expression.
    return findings;
  }

  // Half two: the curated cel-go/cel-js divergence denylist.
  const masked = maskCelStringLiterals(trimmed);
  checkHasIndexArgument(trimmed, masked, field, findings);
  checkInOnListEntry(trimmed, masked, field, findings);
  const blanked = blankLazyRegions(masked);
  checkLogicalChain(trimmed, masked, blanked, field, { start: 0, end: masked.length }, findings);
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
