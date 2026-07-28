import { compile as compileExpression } from 'angular-expressions';

import type { CelExpression } from '../types/common.js';
import type { KroCompatibleType } from '../types/serialization.js';

function hasSchemaValue(fieldPath: string, spec: KroCompatibleType): boolean {
  const parts = fieldPath.replace(/^spec\./, '').split('.');
  let current: unknown = spec;

  for (const part of parts) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current !== undefined;
}

/**
 * Apply evaluator-only rewrites to CEL source while preserving quoted data
 * byte-for-byte. Structured defaults are embedded as CEL object literals, so
 * function-looking text inside their string values must never be rewritten.
 */
function rewriteOutsideQuotedStrings(
  expression: string,
  rewrite: (unquotedSource: string) => string
): string {
  let result = '';
  let unquotedStart = 0;

  for (let index = 0; index < expression.length; index++) {
    const quote = expression[index];
    if (quote !== '"' && quote !== "'") continue;

    result += rewrite(expression.slice(unquotedStart, index));

    let end = index + 1;
    let escaped = false;
    for (; end < expression.length; end++) {
      const character = expression[end];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        end++;
        break;
      }
    }

    result += expression.slice(index, end);
    unquotedStart = end;
    index = end - 1;
  }

  return result + rewrite(expression.slice(unquotedStart));
}

function prepareSchemaExpression(expression: string): string {
  const schemaPath = '[a-zA-Z_$][\\w$]*(?:\\.[a-zA-Z_$][\\w$]*)*';

  return rewriteOutsideQuotedStrings(expression, (unquotedSource) => {
    let prepared = unquotedSource;
    prepared = prepared.replace(
      new RegExp(`\\bhas\\((?:schema\\.)?spec\\.(${schemaPath})\\)`, 'g'),
      '__has("$1")'
    );
    prepared = prepared.replace(
      new RegExp(`\\b(?:schema\\.)?spec\\.(${schemaPath})\\.orValue\\(`, 'g'),
      '__orValue($1, '
    );
    prepared = prepared.replace(/\bstring\(/g, '__string(');
    prepared = prepared.replace(/\bdyn\(/g, '__dyn(');
    prepared = prepared.replace(/schema\.spec\.(\w+)/g, '$1');
    prepared = prepared.replace(/\bspec\.(\w+)/g, '$1');
    return prepared;
  });
}

function createEvaluationScope(spec: KroCompatibleType): Record<string, unknown> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, spec as object, {
      __has: (path: string) => hasSchemaValue(path, spec),
      __orValue: (value: unknown, defaultValue: unknown) => value ?? defaultValue,
      __string: (value: unknown) => String(value ?? ''),
      // KRO uses dyn() only for static type widening; it is runtime identity.
      __dyn: (value: unknown) => value,
      omit: () => undefined,
    })
  );
}

function interpolationEnd(template: string, start: number): number {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = start + 2; index < template.length; index++) {
    const character = template[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return index;
  }

  throw new Error(`Unterminated CEL template interpolation at offset ${start}.`);
}

function evaluateSchemaTemplate(expression: string, spec: KroCompatibleType): string {
  const scope = createEvaluationScope(spec);
  let result = '';
  let cursor = 0;

  while (cursor < expression.length) {
    let start = expression.indexOf('${', cursor);
    while (start > cursor) {
      let backslashes = 0;
      for (let index = start - 1; index >= cursor && expression[index] === '\\'; index--) {
        backslashes++;
      }
      if (backslashes % 2 === 0) break;
      result += `${expression.slice(cursor, start - 1)}\${`;
      cursor = start + 2;
      start = expression.indexOf('${', cursor);
    }
    if (start === -1) {
      result += expression.slice(cursor);
      break;
    }
    result += expression.slice(cursor, start);
    const end = interpolationEnd(expression, start);
    const inner = expression.slice(start + 2, end);
    const evaluator = compileExpression(prepareSchemaExpression(inner));
    result += String(evaluator(scope) ?? '');
    cursor = end + 1;
  }

  return result;
}

/** Safely evaluate a schema-only CEL expression against one concrete instance spec. */
export function evaluateSchemaCelExpression(
  celExpression: CelExpression,
  spec: KroCompatibleType
): unknown {
  if (celExpression.__isTemplate && celExpression.expression.includes('${')) {
    return evaluateSchemaTemplate(celExpression.expression, spec);
  }
  const evaluator = compileExpression(prepareSchemaExpression(celExpression.expression));
  return evaluator(createEvaluationScope(spec)) as unknown;
}
