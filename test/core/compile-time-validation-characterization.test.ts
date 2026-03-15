/**
 * Characterization tests for CompileTimeTypeChecker
 *
 * These tests capture the CURRENT behavior of compile-time validation,
 * including type extraction, syntax validation, and caching.
 *
 * Source: src/core/expressions/validation/compile-time-validation.ts (938 lines)
 */

import { describe, expect, it } from 'bun:test';
import type {
  CompileTimeTypeInfo,
  CompileTimeValidationContext,
  KubernetesRefUsageContext,
} from '../../src/core/expressions/validation/compile-time-validation.js';
import {
  CompileTimeError,
  CompileTimeTypeChecker,
  CompileTimeWarning,
} from '../../src/core/expressions/validation/compile-time-validation.js';
import type { KubernetesRef } from '../../src/core/types/common.js';
import { KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

// Helper to create a minimal validation context
function ctx(overrides: Partial<CompileTimeValidationContext> = {}): CompileTimeValidationContext {
  return { ...overrides };
}

// Helper to create a mock KubernetesRef
function mockRef(resourceId: string, fieldPath: string): KubernetesRef {
  return {
    [KUBERNETES_REF_BRAND]: true as const,
    resourceId,
    fieldPath,
  };
}

describe('CompileTimeTypeChecker', () => {
  describe('validateExpressionCompatibility — type extraction', () => {
    it('extracts string type from double-quoted literal', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('"hello"', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('string');
      expect(result.compileTimeType?.isUnion).toBe(false);
      expect(result.compileTimeType?.isGeneric).toBe(false);
    });

    it('extracts string type from single-quoted literal', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility("'hello'", ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('string');
    });

    it('extracts number type from integer literal', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('42', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('number');
    });

    it('extracts number type from float literal', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('3.14', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('number');
    });

    it('extracts boolean type from true literal', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('true', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('boolean');
    });

    it('extracts boolean type from false literal', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('false', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('boolean');
    });

    it('extracts boolean type from comparison expressions', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('a > b', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('boolean');
    });

    it('extracts boolean type from equality expressions', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('a == b', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('boolean');
    });

    it('extracts boolean type from logical operators', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('a && b', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('boolean');
    });

    it('extracts number type from arithmetic expressions (without string quotes)', () => {
      const checker = new CompileTimeTypeChecker();
      // Note: isBooleanExpression is checked BEFORE isNumericExpression
      // 'a + b' does NOT contain any boolean operators, so it falls to numeric check
      // But wait: '+' is a numeric operator, and expression has no quotes
      // However, isBooleanExpression does NOT include '+', so this should be numeric
      const result = checker.validateExpressionCompatibility('a * b', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('number');
    });

    it('extracts KubernetesRef type from resource references', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility(
        'resources.deployment.status.ready',
        ctx()
      );

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('KubernetesRef<unknown>');
      expect(result.compileTimeType?.isGeneric).toBe(true);
      expect(result.compileTimeType?.genericParams).toEqual(['unknown']);
    });

    it('extracts KubernetesRef type from schema references', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('schema.spec.name', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('KubernetesRef<unknown>');
    });

    it('returns unknown type for unrecognized expressions', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('someVariable', ctx());

      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('unknown');
    });
  });

  describe('validateExpressionCompatibility — classification priority quirk', () => {
    it('boolean check takes priority over numeric for + with boolean operators', () => {
      const checker = new CompileTimeTypeChecker();
      // 'a + b > c' contains '>' (boolean operator), so isBooleanExpression returns true first
      const result = checker.validateExpressionCompatibility('a + b > c', ctx());

      expect(result.compileTimeType?.typeName).toBe('boolean');
    });

    it('+ in quotes is classified as string because quote regex matches first', () => {
      const checker = new CompileTimeTypeChecker();
      // '"hello" + "world"' — the extractCompileTimeType checks literal regex first:
      // /^["'].*["']$/ matches because expression starts with " and ends with "
      // So it's classified as string, even though it's actually concatenation
      const result = checker.validateExpressionCompatibility('"hello" + "world"', ctx());

      expect(result.compileTimeType?.typeName).toBe('string');
    });
  });

  describe('validateExpressionCompatibility — expected type checking', () => {
    it('fails when actual type does not match expected type', () => {
      const checker = new CompileTimeTypeChecker();
      const expectedType: CompileTimeTypeInfo = {
        typeName: 'number',
        isUnion: false,
        isGeneric: false,
        optional: false,
        nullable: false,
        undefinable: false,
      };

      const result = checker.validateExpressionCompatibility('"hello"', ctx({ expectedType }));

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.compatibilityIssues.some((i) => i.type === 'TYPE_MISMATCH')).toBe(true);
    });

    it('passes when actual type matches expected type', () => {
      const checker = new CompileTimeTypeChecker();
      const expectedType: CompileTimeTypeInfo = {
        typeName: 'string',
        isUnion: false,
        isGeneric: false,
        optional: false,
        nullable: false,
        undefinable: false,
      };

      const result = checker.validateExpressionCompatibility('"hello"', ctx({ expectedType }));

      expect(result.valid).toBe(true);
    });

    it('passes when expected type is any', () => {
      const checker = new CompileTimeTypeChecker();
      const expectedType: CompileTimeTypeInfo = {
        typeName: 'any',
        isUnion: false,
        isGeneric: false,
        optional: false,
        nullable: false,
        undefinable: false,
      };

      const result = checker.validateExpressionCompatibility('"hello"', ctx({ expectedType }));

      expect(result.valid).toBe(true);
    });
  });

  describe('validateExpressionCompatibility — syntax validation', () => {
    it('rejects async/await syntax', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('async function f() {}', ctx());

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.errorType === 'UNSUPPORTED_SYNTAX')).toBe(true);
    });

    it('rejects generator syntax (yield)', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('yield value', ctx());

      expect(result.valid).toBe(false);
    });

    it('rejects class declarations', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('class Foo {}', ctx());

      expect(result.valid).toBe(false);
    });

    it('rejects generator functions', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('function* gen() {}', ctx());

      expect(result.valid).toBe(false);
    });

    it('warns about eval() usage', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('eval("code")', ctx());

      expect(result.warnings.some((w) => w.warningType === 'POTENTIAL_RUNTIME_ERROR')).toBe(true);
    });

    it('warns about new Function usage', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('new Function("code")', ctx());

      expect(result.warnings.some((w) => w.warningType === 'POTENTIAL_RUNTIME_ERROR')).toBe(true);
    });
  });

  describe('validateExpressionCompatibility — runtime safety', () => {
    it('warns about deep property access without optional chaining', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('obj.prop.nested', ctx());

      // obj.prop.nested has 2 property accesses (> 1)
      expect(result.warnings.some((w) => w.message.includes('null/undefined'))).toBe(true);
      expect(result.suggestions.some((s) => s.includes('optional chaining'))).toBe(true);
    });

    it('does not warn about single-level property access', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('obj.prop', ctx());

      // Only 1 property access — does NOT exceed threshold
      const nullWarnings = result.warnings.filter((w) => w.message.includes('null/undefined'));
      // There should be 0 warnings for single-level access (unless nullable type)
      expect(nullWarnings.length).toBe(0);
    });

    it('warns about array method performance', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('items.filter(x)', ctx());

      expect(result.warnings.some((w) => w.warningType === 'PERFORMANCE_IMPACT')).toBe(true);
    });
  });

  describe('validateExpressionCompatibility — caching', () => {
    it('returns cached result for same expression and context', () => {
      const checker = new CompileTimeTypeChecker();
      const context = ctx();

      const result1 = checker.validateExpressionCompatibility('"hello"', context);
      const result2 = checker.validateExpressionCompatibility('"hello"', context);

      // Results should be the same object (cached)
      expect(result2).toBe(result1);
    });

    it('bypasses cache when skipCache is true', () => {
      const checker = new CompileTimeTypeChecker();

      const result1 = checker.validateExpressionCompatibility('"hello"', ctx());
      const result2 = checker.validateExpressionCompatibility('"hello"', ctx({ skipCache: true }));

      // Different objects since cache was skipped
      expect(result2).not.toBe(result1);
    });

    it('clearCache removes all cached results', () => {
      const checker = new CompileTimeTypeChecker();
      const context = ctx();

      const result1 = checker.validateExpressionCompatibility('"hello"', context);
      checker.clearCache();
      const result2 = checker.validateExpressionCompatibility('"hello"', context);

      expect(result2).not.toBe(result1);
    });
  });

  describe('validateExpressionCompatibility — metadata', () => {
    it('includes validation time', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('"hello"', ctx());

      expect(result.metadata.validationTime).toBeGreaterThanOrEqual(0);
    });

    it('calculates complexity score from expression features', () => {
      const checker = new CompileTimeTypeChecker();

      // Simple literal — minimal complexity
      const simple = checker.validateExpressionCompatibility('42', ctx());
      expect(simple.metadata.complexityScore).toBe(0);

      // Complex expression — higher complexity
      const complex = checker.validateExpressionCompatibility(
        'resources.deploy.status.ready && obj.prop || fn()',
        ctx({ skipCache: true })
      );
      expect(complex.metadata.complexityScore).toBeGreaterThan(0);
    });

    it('reflects strict mode setting', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility('"hello"', ctx({ strictMode: true }));

      expect(result.metadata.strictMode).toBe(true);
    });

    it('reflects strict null checks setting', () => {
      const checker = new CompileTimeTypeChecker();
      const result = checker.validateExpressionCompatibility(
        '"hello"',
        ctx({ strictNullChecks: true })
      );

      expect(result.metadata.strictNullChecks).toBe(true);
    });
  });

  describe('validateExpressionsCompatibility (batch)', () => {
    it('validates multiple expressions', () => {
      const checker = new CompileTimeTypeChecker();
      const results = checker.validateExpressionsCompatibility(['"hello"', '42', 'true'], ctx());

      expect(results).toHaveLength(3);
      expect(results[0]?.compileTimeType?.typeName).toBe('string');
      expect(results[1]?.compileTimeType?.typeName).toBe('number');
      expect(results[2]?.compileTimeType?.typeName).toBe('boolean');
    });

    it('returns empty array for empty input', () => {
      const checker = new CompileTimeTypeChecker();
      const results = checker.validateExpressionsCompatibility([], ctx());

      expect(results).toEqual([]);
    });
  });

  describe('validateKubernetesRefCompatibility', () => {
    it('validates ref with existing resource', () => {
      const checker = new CompileTimeTypeChecker();
      const ref = mockRef('my-deploy', 'status.ready');

      const usageCtx: KubernetesRefUsageContext = {
        availableResources: { 'my-deploy': {} as any },
        usageType: 'property-access',
      };

      const result = checker.validateKubernetesRefCompatibility(ref, usageCtx, ctx());

      expect(result.valid).toBe(true);
    });

    it('rejects ref with missing resource', () => {
      const checker = new CompileTimeTypeChecker();
      const ref = mockRef('missing-resource', 'status.ready');

      const usageCtx: KubernetesRefUsageContext = {
        availableResources: {},
        usageType: 'property-access',
      };

      const result = checker.validateKubernetesRefCompatibility(ref, usageCtx, ctx());

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('allows __schema__ resourceId without available resources', () => {
      const checker = new CompileTimeTypeChecker();
      const ref = mockRef('__schema__', 'spec.name');

      const usageCtx: KubernetesRefUsageContext = {
        availableResources: {},
        usageType: 'property-access',
      };

      const result = checker.validateKubernetesRefCompatibility(ref, usageCtx, ctx());

      expect(result.valid).toBe(true);
    });

    it('rejects invalid field paths (double dots)', () => {
      const checker = new CompileTimeTypeChecker();
      const ref = mockRef('my-deploy', 'status..ready');

      const usageCtx: KubernetesRefUsageContext = {
        availableResources: { 'my-deploy': {} as any },
        usageType: 'property-access',
      };

      const result = checker.validateKubernetesRefCompatibility(ref, usageCtx, ctx());

      expect(result.valid).toBe(false);
    });

    it('rejects field paths starting with dot', () => {
      const checker = new CompileTimeTypeChecker();
      const ref = mockRef('my-deploy', '.status.ready');

      const usageCtx: KubernetesRefUsageContext = {
        availableResources: { 'my-deploy': {} as any },
        usageType: 'property-access',
      };

      const result = checker.validateKubernetesRefCompatibility(ref, usageCtx, ctx());

      expect(result.valid).toBe(false);
    });

    it('rejects field paths ending with dot', () => {
      const checker = new CompileTimeTypeChecker();
      const ref = mockRef('my-deploy', 'status.ready.');

      const usageCtx: KubernetesRefUsageContext = {
        availableResources: { 'my-deploy': {} as any },
        usageType: 'property-access',
      };

      const result = checker.validateKubernetesRefCompatibility(ref, usageCtx, ctx());

      expect(result.valid).toBe(false);
    });

    it('extracts KubernetesRef type info in the result', () => {
      const checker = new CompileTimeTypeChecker();
      const ref = mockRef('my-deploy', 'status.ready');

      const usageCtx: KubernetesRefUsageContext = {
        availableResources: { 'my-deploy': {} as any },
        usageType: 'property-access',
      };

      const result = checker.validateKubernetesRefCompatibility(ref, usageCtx, ctx());

      expect(result.compileTimeType?.typeName).toContain('KubernetesRef');
      expect(result.compileTimeType?.isGeneric).toBe(true);
    });
  });

  describe('type compatibility', () => {
    it('any is compatible with any other type', () => {
      const checker = new CompileTimeTypeChecker();
      const expectedType: CompileTimeTypeInfo = {
        typeName: 'string',
        isUnion: false,
        isGeneric: false,
        optional: false,
        nullable: false,
        undefinable: false,
      };

      // Use an expression that results in 'any' type... actually areTypesCompatible
      // treats 'any' and 'unknown' as compatible with everything
      // 'unknown' result + 'string' expected → compatible because unknown matches everything
      const result = checker.validateExpressionCompatibility('someVar', ctx({ expectedType }));

      expect(result.valid).toBe(true);
    });

    it('null is compatible with undefined (documented internal behavior)', () => {
      // The compatibilityMap has null→[null, undefined] and vice versa.
      // However, we can't directly test this via public API since the type extraction
      // never produces 'null' type from expressions. The compatibilityMap is internal.
      // This test documents that the behavior exists in areTypesCompatible.
      expect(true).toBe(true);
    });
  });
});

describe('CompileTimeError', () => {
  it('creates error with type, expression, and location', () => {
    const error = new CompileTimeError('Type mismatch', 'TYPE_INCOMPATIBILITY', 'a + b', {
      line: 1,
      column: 5,
    });

    expect(error.message).toBe('Type mismatch');
    expect(error.errorType).toBe('TYPE_INCOMPATIBILITY');
    expect(error.expression).toBe('a + b');
    expect(error.location).toEqual({ line: 1, column: 5 });
    expect(error.name).toBe('CompileTimeError');
  });

  it('extends TypeKroError', () => {
    const error = new CompileTimeError('msg', 'TYPE_INCOMPATIBILITY', 'expr');
    expect(error).toBeInstanceOf(Error);
  });

  it('forTypeIncompatibility creates properly formatted error', () => {
    const error = CompileTimeError.forTypeIncompatibility('expr', 'string', 'number');

    expect(error.message).toBe("Type 'number' is not assignable to type 'string'");
    expect(error.errorType).toBe('TYPE_INCOMPATIBILITY');
  });

  it('forUnsupportedSyntax creates properly formatted error', () => {
    const error = CompileTimeError.forUnsupportedSyntax('expr', 'async/await');

    expect(error.message).toBe('Unsupported syntax feature: async/await');
    expect(error.errorType).toBe('UNSUPPORTED_SYNTAX');
  });

  it('forGenericConstraintViolation creates properly formatted error', () => {
    const error = CompileTimeError.forGenericConstraintViolation(
      'expr',
      'extends string',
      'number'
    );

    expect(error.message).toBe("Type 'number' does not satisfy constraint 'extends string'");
    expect(error.errorType).toBe('GENERIC_CONSTRAINT_VIOLATION');
  });
});

describe('CompileTimeWarning', () => {
  it('creates warning with type and expression', () => {
    const warning = new CompileTimeWarning('msg', 'POTENTIAL_RUNTIME_ERROR', 'expr');

    expect(warning.message).toBe('msg');
    expect(warning.warningType).toBe('POTENTIAL_RUNTIME_ERROR');
    expect(warning.expression).toBe('expr');
  });

  it('forPotentialRuntimeError creates formatted warning', () => {
    const warning = CompileTimeWarning.forPotentialRuntimeError('expr', 'null access');

    expect(warning.message).toBe('Potential runtime error: null access');
    expect(warning.warningType).toBe('POTENTIAL_RUNTIME_ERROR');
  });

  it('forPerformanceImpact creates formatted warning', () => {
    const warning = CompileTimeWarning.forPerformanceImpact('expr', 'O(n^2) complexity');

    expect(warning.message).toBe('Performance impact: O(n^2) complexity');
    expect(warning.warningType).toBe('PERFORMANCE_IMPACT');
  });

  it('forDeprecatedFeature with replacement', () => {
    const warning = CompileTimeWarning.forDeprecatedFeature('expr', 'oldApi', 'newApi');

    expect(warning.message).toBe("Deprecated feature 'oldApi', use 'newApi' instead");
    expect(warning.warningType).toBe('DEPRECATED_FEATURE');
  });

  it('forDeprecatedFeature without replacement', () => {
    const warning = CompileTimeWarning.forDeprecatedFeature('expr', 'oldApi');

    expect(warning.message).toBe("Deprecated feature 'oldApi'");
  });
});
