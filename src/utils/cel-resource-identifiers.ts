import { parse } from 'cel-js';

import { KUBERNETES_REF_MARKER_SOURCE } from '../shared/brands.js';

const CEL_LAMBDA_MACROS = new Set(['all', 'exists', 'exists_one', 'filter', 'map']);
const KUBERNETES_REF_MARKER_PREFIX = /__KUBERNETES_REF_([A-Za-z_$][\w$]*)_/g;
const MAX_CEL_REFERENCE_CACHE_ENTRIES = 2_048;
const MAX_CANONICAL_EXPRESSION_CACHE_ENTRIES = 1_024;
const celReferenceCache = new Map<string, readonly CelRootReference[]>();
const canonicalExpressionCaches = new WeakMap<
  ReadonlyMap<string, string>,
  Map<string, string>
>();

interface CelToken {
  readonly image: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

interface BoundRange {
  readonly name: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface CelRootReference {
  readonly root: string;
  readonly segments: readonly string[];
  readonly startOffset: number;
  readonly endOffset: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function children(value: unknown): Record<string, unknown> | undefined {
  return record(record(value)?.children);
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function token(value: unknown): CelToken | undefined {
  const candidate = record(value);
  return candidate &&
    typeof candidate.image === 'string' &&
    typeof candidate.startOffset === 'number' &&
    typeof candidate.endOffset === 'number'
    ? {
        image: candidate.image,
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
      }
    : undefined;
}

function directIdentifier(value: unknown): CelToken | undefined {
  const identifierTokens = array(children(value)?.Identifier);
  return token(identifierTokens[0]);
}

function firstIdentifier(value: unknown): CelToken | undefined {
  const current = record(value);
  if (!current) return undefined;
  if (current.name === 'identifierExpression') {
    return directIdentifier(current);
  }
  for (const child of Object.values(current)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = firstIdentifier(item);
        if (found) return found;
      }
    } else {
      const found = firstIdentifier(child);
      if (found) return found;
    }
  }
  return undefined;
}

function nodeRange(value: unknown): { startOffset: number; endOffset: number } | undefined {
  let startOffset = Number.POSITIVE_INFINITY;
  let endOffset = Number.NEGATIVE_INFINITY;
  const visit = (current: unknown): void => {
    const currentToken = token(current);
    if (currentToken) {
      startOffset = Math.min(startOffset, currentToken.startOffset);
      endOffset = Math.max(endOffset, currentToken.endOffset);
      return;
    }
    const currentRecord = record(current);
    if (!currentRecord) return;
    for (const child of Object.values(currentRecord)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(value);
  return Number.isFinite(startOffset) && Number.isFinite(endOffset)
    ? { startOffset, endOffset }
    : undefined;
}

function collectBoundRanges(cst: unknown): BoundRange[] {
  const ranges: BoundRange[] = [];
  const visit = (value: unknown): void => {
    const current = record(value);
    if (!current) return;
    if (current.name === 'identifierDotExpression' || current.name === 'macrosExpression') {
      const currentChildren = children(current);
      const macro = token(array(currentChildren?.Identifier)[0])?.image;
      if (macro && CEL_LAMBDA_MACROS.has(macro)) {
        const bindingExpression = array(currentChildren?.arg)[0];
        const binding = firstIdentifier(bindingExpression);
        if (binding) {
          ranges.push({
            name: binding.image,
            startOffset: binding.startOffset,
            endOffset: binding.endOffset,
          });
          for (const body of array(currentChildren?.args)) {
            const range = nodeRange(body);
            if (range) ranges.push({ name: binding.image, ...range });
          }
        }
      }
    }
    for (const child of Object.values(current)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(cst);
  return ranges;
}

function collectRootReferences(
  cst: unknown,
  boundRanges: readonly BoundRange[]
): CelRootReference[] {
  const references: CelRootReference[] = [];
  const visit = (value: unknown): void => {
    const current = record(value);
    if (!current) return;
    if (current.name === 'identifierExpression') {
      const currentChildren = children(current);
      const root = token(array(currentChildren?.Identifier)[0]);
      if (
        root &&
        !boundRanges.some(
          (range) =>
            range.name === root.image &&
            root.startOffset >= range.startOffset &&
            root.endOffset <= range.endOffset
        )
      ) {
        const segments = array(currentChildren?.identifierDotExpression).flatMap((dot) => {
          const identifier = token(array(children(dot)?.Identifier)[0]);
          return identifier ? [identifier.image] : [];
        });
        references.push({
          root: root.image,
          segments,
          startOffset: root.startOffset,
          endOffset: root.endOffset,
        });
      }
    }
    for (const child of Object.values(current)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(cst);
  return references;
}

/**
 * Parse CEL and return root identifier references while excluding macro-local variables.
 *
 * String literals never appear as identifier nodes, so callers can safely use these offsets for
 * source-preserving rewrites without corrupting literal data.
 */
function analyzeCelRootReferences(expression: string): readonly CelRootReference[] {
  const parsed = parse(expression);
  if (!parsed.isSuccess) {
    const references: CelRootReference[] = [];
    for (const match of expression.matchAll(/\$\{([^{}]+)\}/g)) {
      const inner = match[1];
      const matchStart = match.index;
      if (inner === undefined || matchStart === undefined) continue;
      const innerOffset = matchStart + 2;
      references.push(
        ...celRootReferences(inner).map((reference) => ({
          ...reference,
          startOffset: reference.startOffset + innerOffset,
          endOffset: reference.endOffset + innerOffset,
        }))
      );
    }
    if (references.length > 0) return references;

    const lambdaNames = new Set<string>();
    let unquoted = '';
    let quote: '"' | "'" | null = null;
    let escaped = false;
    for (const char of expression) {
      if (quote) {
        unquoted += ' ';
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
        unquoted += ' ';
      } else {
        unquoted += char;
      }
    }
    for (const match of unquoted.matchAll(
      /(?:^|\.|\b)(?:all|exists|exists_one|filter|map)\s*\(\s*([A-Za-z_$][\w$]*)\s*,/g
    )) {
      if (match[1]) lambdaNames.add(match[1]);
    }
    const celKeywords = new Set(['true', 'false', 'null', 'in']);
    for (const match of unquoted.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const root = match[1];
      const startOffset = match.index;
      if (
        root === undefined ||
        startOffset === undefined ||
        lambdaNames.has(root) ||
        celKeywords.has(root)
      ) {
        continue;
      }
      const before = unquoted.slice(0, startOffset).trimEnd();
      const after = unquoted.slice(startOffset + root.length);
      if (
        before.endsWith('.') ||
        before.endsWith('?.') ||
        /^\s*\(/.test(after) ||
        /^\s*:/.test(after)
      ) {
        continue;
      }
      const segments: string[] = [];
      let remaining = after;
      while (true) {
        const segment = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(remaining);
        if (!segment?.[1]) break;
        segments.push(segment[1]);
        remaining = remaining.slice(segment[0].length);
      }
      references.push({
        root,
        segments,
        startOffset,
        endOffset: startOffset + root.length - 1,
      });
    }
    return references;
  }
  const boundRanges = collectBoundRanges(parsed.cst);
  return collectRootReferences(parsed.cst, boundRanges);
}

/**
 * Parse CEL and return root identifier references, memoized by source text.
 *
 * Nested-composition resolution revisits stable expressions many times. Caching at this shared
 * analysis boundary ensures syntax-aware consumers pay the parser cost once without coupling the
 * cache to any particular serializer recursion strategy.
 */
export function celRootReferences(expression: string): readonly CelRootReference[] {
  const cached = celReferenceCache.get(expression);
  if (cached) return cached;

  const references = analyzeCelRootReferences(expression);
  if (celReferenceCache.size >= MAX_CEL_REFERENCE_CACHE_ENTRIES) {
    const oldest = celReferenceCache.keys().next().value;
    if (oldest !== undefined) celReferenceCache.delete(oldest);
  }
  celReferenceCache.set(expression, references);
  return references;
}

/**
 * Extract resource references embedded in TypeKro's string-coercion marker format.
 */
export function kubernetesMarkerReferences(
  value: string
): readonly Pick<CelRootReference, 'root' | 'segments'>[] {
  const references: Pick<CelRootReference, 'root' | 'segments'>[] = [];
  for (const match of value.matchAll(new RegExp(KUBERNETES_REF_MARKER_SOURCE, 'g'))) {
    const root = match[1];
    const fieldPath = match[2];
    if (!root || root === '__schema__' || !fieldPath) continue;
    references.push({ root, segments: fieldPath.split('.') });
  }
  return references;
}

function rewriteMarkersOutsideStrings(
  expression: string,
  aliases: ReadonlyMap<string, string>
): string {
  let result = '';
  let chunkStart = 0;
  let index = 0;
  const rewriteChunk = (chunk: string): string =>
    chunk.replace(KUBERNETES_REF_MARKER_PREFIX, (match, resourceId: string) => {
      const canonicalId = aliases.get(resourceId);
      return canonicalId ? `__KUBERNETES_REF_${canonicalId}_` : match;
    });

  while (index < expression.length) {
    const quote = expression[index];
    if (quote !== '"' && quote !== "'") {
      index++;
      continue;
    }
    result += rewriteChunk(expression.slice(chunkStart, index));
    const quoteStart = index;
    const triple = expression.slice(index, index + 3) === quote.repeat(3);
    index += triple ? 3 : 1;
    let escaped = false;
    while (index < expression.length) {
      if (triple && expression.slice(index, index + 3) === quote.repeat(3)) {
        index += 3;
        break;
      }
      const char = expression[index];
      index++;
      if (!triple && escaped) {
        escaped = false;
      } else if (!triple && char === '\\') {
        escaped = true;
      } else if (!triple && char === quote) {
        break;
      }
    }
    result += expression.slice(quoteStart, index);
    chunkStart = index;
  }
  return result + rewriteChunk(expression.slice(chunkStart));
}

/**
 * Canonicalize resource roots in executable CEL while preserving literals and lambda bindings.
 */
export function canonicalizeCelResourceAliases(
  expression: string,
  aliases: ReadonlyMap<string, string>
): string {
  if (aliases.size === 0) return expression;
  let expressionCache = canonicalExpressionCaches.get(aliases);
  if (!expressionCache) {
    expressionCache = new Map();
    canonicalExpressionCaches.set(aliases, expressionCache);
  }
  const cached = expressionCache.get(expression);
  if (cached !== undefined) return cached;

  const withCanonicalMarkers = rewriteMarkersOutsideStrings(expression, aliases);
  const references = celRootReferences(withCanonicalMarkers);
  const replacements = references
    .flatMap((reference) => {
      const canonicalId = aliases.get(reference.root);
      return canonicalId && canonicalId !== reference.root ? [{ ...reference, canonicalId }] : [];
    })
    .sort((left, right) => right.startOffset - left.startOffset);
  let result = withCanonicalMarkers;
  for (const replacement of replacements) {
    result =
      result.slice(0, replacement.startOffset) +
      replacement.canonicalId +
      result.slice(replacement.endOffset + 1);
  }
  if (expressionCache.size >= MAX_CANONICAL_EXPRESSION_CACHE_ENTRIES) {
    const oldest = expressionCache.keys().next().value;
    if (oldest !== undefined) expressionCache.delete(oldest);
  }
  expressionCache.set(expression, result);
  return result;
}
