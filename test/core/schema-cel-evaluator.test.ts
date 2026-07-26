import { describe, expect, it } from 'bun:test';

import { CEL_EXPRESSION_BRAND } from '../../src/core/constants/brands.js';
import { evaluateSchemaCelExpression } from '../../src/core/deployment/schema-cel-evaluator.js';
import type { CelExpression } from '../../src/core/types/common.js';

function template(expression: string): CelExpression<string> {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    __isTemplate: true,
  };
}

describe('schema CEL evaluator', () => {
  it('evaluates schema-only mixed templates segment by segment', () => {
    const result = evaluateSchemaCelExpression(
      template('http://${schema.spec.name}-api.${schema.spec.namespace}.svc:4444'),
      { name: 'identity', namespace: 'ory-system' }
    );

    expect(result).toBe('http://identity-api.ory-system.svc:4444');
  });

  it('supports conditional expressions and braces inside quoted template branches', () => {
    const result = evaluateSchemaCelExpression(
      template('${has(schema.spec.namespace) ? schema.spec.namespace : "fallback-{default}"}-api'),
      { name: 'identity' }
    );

    expect(result).toBe('fallback-{default}-api');
  });

  it('preserves scalar types for non-template schema expressions', () => {
    const expression: CelExpression<number> = {
      [CEL_EXPRESSION_BRAND]: true,
      expression: 'schema.spec.replicas + 1',
    };

    expect(evaluateSchemaCelExpression(expression, { replicas: 2 })).toBe(3);
  });

  it('does not evaluate escaped literal interpolation text', () => {
    const result = evaluateSchemaCelExpression(
      template('prefix-\\${schema.spec.secret}-${schema.spec.name}'),
      { name: 'identity', secret: 'must-not-appear' }
    );

    expect(result).toBe('prefix-${schema.spec.secret}-identity');
  });

  it('rejects unterminated template interpolation', () => {
    expect(() =>
      evaluateSchemaCelExpression(template('http://${schema.spec.name'), { name: 'identity' })
    ).toThrow('Unterminated CEL template interpolation');
  });
});
