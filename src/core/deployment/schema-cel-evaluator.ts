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

function prepareSchemaExpression(expression: string): string {
  let prepared = expression;
  const schemaPath = '[a-zA-Z_$][\\w$]*(?:\\.[a-zA-Z_$][\\w$]*)*';

  prepared = prepared.replace(
    new RegExp(`\\bhas\\((?:schema\\.)?spec\\.(${schemaPath})\\)`, 'g'),
    '__has("$1")'
  );
  prepared = prepared.replace(
    new RegExp(`\\b(?:schema\\.)?spec\\.(${schemaPath})\\.orValue\\(([^()]*)\\)`, 'g'),
    '__orValue($1, $2)'
  );
  prepared = prepared.replace(/\bstring\(/g, '__string(');
  prepared = prepared.replace(/schema\.spec\.(\w+)/g, '$1');
  prepared = prepared.replace(/\bspec\.(\w+)/g, '$1');
  return prepared;
}

function createEvaluationScope(spec: KroCompatibleType): Record<string, unknown> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, spec as object, {
      __has: (path: string) => hasSchemaValue(path, spec),
      __orValue: (value: unknown, defaultValue: unknown) => value ?? defaultValue,
      __string: (value: unknown) => String(value ?? ''),
      omit: () => undefined,
    })
  );
}

/** Safely evaluate a schema-only CEL expression against one concrete instance spec. */
export function evaluateSchemaCelExpression(
  celExpression: CelExpression,
  spec: KroCompatibleType
): unknown {
  const evaluator = compileExpression(prepareSchemaExpression(celExpression.expression));
  return evaluator(createEvaluationScope(spec)) as unknown;
}
