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
 * Strictness follows the same convention as the other CEL diagnostics
 * (`strictCelDiagnostics` factory option, `TYPEKRO_STRICT_CEL=1`): findings
 * abort serialization in strict mode and are logged as warnings otherwise.
 */

import { parse } from 'cel-js';
import {
  collectCelLambdaScopes,
  isCelLambdaLocalAt,
  maskCelStringLiterals,
} from '../references/cel-lexical-scanner.js';

/** The CEL engine that rejects — or diverges on — an expression. */
export type CelDialect = 'cel-js' | 'cel-go';

/** Identifier for a curated dual-dialect rule. */
export type CelDialectRuleId =
  | 'cel-js-parse'
  | 'has-index-argument'
  | 'in-on-list-entry'
  | 'guard-after-use-in-logical-chain'
  | 'unguarded-index-in-logical-chain';

/** A single dual-dialect incompatibility found in an emitted expression. */
export interface CelDialectFinding {
  /** Which curated rule matched. */
  readonly rule: CelDialectRuleId;
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
 * Every entry names the engine that rejects the form and the observation
 * behind it. Keep this table and {@link checkCelDialectCompatibility} in step.
 */
export const CEL_DIALECT_RULES: readonly {
  readonly id: CelDialectRuleId;
  readonly dialect: CelDialect;
  readonly summary: string;
  readonly observed: string;
}[] = [
  {
    id: 'cel-js-parse',
    dialect: 'cel-js',
    summary: 'the expression does not parse as CEL',
    observed: "cel-js's own parser rejects it, so direct mode can never evaluate this field",
  },
  {
    id: 'has-index-argument',
    dialect: 'cel-js',
    summary: 'has() applied to an index expression',
    observed:
      'cel-js raises "has() does not support atomic expressions" for has(list[0].field); cel-go accepts it',
  },
  {
    id: 'in-on-list-entry',
    dialect: 'cel-go',
    summary: '`in` applied to a typed list entry',
    observed:
      "KRO's cel-go type env types a list entry as a message, not a map, and reports \"no matching overload for '@in'\"; cel-js accepts it",
  },
  {
    id: 'guard-after-use-in-logical-chain',
    dialect: 'cel-js',
    summary: 'a has() guard placed to the right of the access it guards',
    observed:
      'cel-go absorbs an error in one operand of && / || when the other operand decides the result, regardless of order; cel-js evaluates left to right and propagates the error before the guard is ever reached',
  },
  {
    id: 'unguarded-index-in-logical-chain',
    dialect: 'cel-js',
    summary: 'an index expression inside && / || with no has() guard before it',
    observed:
      'the indexed list is optional in practice; cel-go absorbs the resulting error when the other operand is false, cel-js propagates it and takes the whole status field down',
  },
] as const;

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
/**
 * A *list* index: `list[0]`. Deliberately numeric-only — `map["key"]` is a map
 * lookup, which both engines reject identically on a missing key and so is not
 * a dialect divergence.
 */
const INDEXED_BASE = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\[\s*\d+\s*\]/g;

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
  const dialect = CEL_DIALECT_RULES.find((entry) => entry.id === rule)?.dialect ?? 'cel-js';
  return {
    rule,
    dialect,
    field,
    expression,
    ...(fragment === undefined ? {} : { fragment }),
    message,
    suggestion,
  };
}

/** Rule: `has()` whose argument is an index expression. */
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
          'cel-js rejects has() on an index expression ("has() does not support atomic expressions"), so this field can never resolve in direct mode',
          'Select entries with `list.filter(entry, has(entry.field))` inside a lazy ternary — Cel.firstWhereHas() emits exactly that'
        )
      );
    }
    match = pattern.exec(masked);
  }
}

/** Rule: `in` whose right-hand operand is a typed list entry. */
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
    const isListEntry =
      operand.includes('[') ||
      (root !== undefined && isCelLambdaLocalAt(root, operandStart, lambdaScopes));
    if (operand.length > 0 && isListEntry) {
      findings.push(
        finding(
          'in-on-list-entry',
          field,
          expression,
          expression.slice(match.index, cursor),
          "KRO's cel-go type env types a list entry as a message rather than a map and rejects `in` on it (\"no matching overload for '@in'\"), so the ResourceGraphDefinition is refused",
          'Test the field with has() instead: `list.filter(entry, has(entry.field))`'
        )
      );
    }
    match = pattern.exec(masked);
  }
}

/**
 * Rules that only make sense across the operands of one `&&` / `||` chain:
 * a guard that sits to the right of the access it guards, and an index
 * expression with no guard before it at all.
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
        const text = () => expression.slice(operand.start, operand.end).trim();

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
              text(),
              `has(${lateGuard}) guards this operand but is written after it. cel-go absorbs the error either way; cel-js evaluates left to right and fails before reaching the guard`,
              `Move has(${lateGuard}) to the left of the access, or use a lazy ternary: has(${lateGuard}) ? (...) : <fallback>`
            )
          );
          continue;
        }

        const indexedBase = [...blanked.slice(operand.start, operand.end).matchAll(INDEXED_BASE)]
          .map((found) => found[1] as string)
          .find((base) => !before.some((guard) => guardCovers(guard, base)));
        if (indexedBase !== undefined) {
          findings.push(
            finding(
              'unguarded-index-in-logical-chain',
              field,
              expression,
              text(),
              `'${indexedBase}' is indexed inside a logical chain with no has() guard before it. cel-go absorbs the error when the other operand decides the result; cel-js propagates it`,
              'Guard the list first, or select the entry with Cel.firstWhereHas(), which keeps the index inside a lazy ternary'
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

  // Half one: cel-js's own parser. A syntax error here means direct mode can
  // never evaluate this field, whatever KRO makes of it.
  let parsed: { isSuccess: boolean } | undefined;
  try {
    parsed = parse(trimmed);
  } catch {
    parsed = { isSuccess: false };
  }
  if (!parsed.isSuccess) {
    findings.push(
      finding(
        'cel-js-parse',
        field,
        trimmed,
        undefined,
        'cel-js cannot parse this expression, so direct mode can never evaluate this status field',
        'Check the expression against the CEL grammar; direct mode and Kro mode must both accept it'
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

/** Render findings as a multi-line report naming the leaf, dialect and expression. */
export function formatCelDialectFindings(findings: readonly CelDialectFinding[]): string {
  return findings
    .map(
      (found) =>
        `  status.${found.field}: rejected by ${found.dialect} [${found.rule}]\n` +
        `    ${found.message}\n` +
        (found.fragment ? `    at: ${found.fragment}\n` : '') +
        `    expression: ${found.expression}\n` +
        `    fix: ${found.suggestion}`
    )
    .join('\n');
}
