/**
 * Characterization tests for ExpressionTypeValidator, TypeRegistry, TypeSafetyUtils
 *
 * These tests capture the CURRENT behavior of the type safety system,
 * supplementing the existing 86-line test file.
 *
 * Source: src/core/expressions/validation/type-safety.ts (681 lines)
 */

import { describe, expect, it } from 'bun:test';
import type { TypeInfo } from '../../src/core/expressions/validation/type-safety.js';
import {
  ExpressionTypeValidator,
  TypeRegistry,
  TypeSafetyUtils,
  TypeValidationError,
  TypeValidationWarning,
} from '../../src/core/expressions/validation/type-safety.js';
import type { KubernetesRef } from '../../src/core/types/common.js';
import type { Enhanced } from '../../src/core/types/kubernetes.js';
import { KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

// Helper to create a KubernetesRef
function mockRef(resourceId: string, fieldPath: string, _type?: unknown): KubernetesRef {
  return {
    [KUBERNETES_REF_BRAND]: true as const,
    resourceId,
    fieldPath,
    ...(_type !== undefined ? { _type } : {}),
  };
}

describe('ExpressionTypeValidator', () => {
  describe('validateExpression — type inference', () => {
    it('infers string type from double-quoted literals', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('"hello"', {});

      expect(result.valid).toBe(true);
      expect(result.resultType?.typeName).toBe('string');
    });

    it('infers string type from single-quoted literals', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression("'hello'", {});

      expect(result.valid).toBe(true);
      expect(result.resultType?.typeName).toBe('string');
    });

    it('infers string type from backtick literals', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('`hello`', {});

      expect(result.valid).toBe(true);
      expect(result.resultType?.typeName).toBe('string');
    });

    it('infers number type from integer literals', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('42', {});

      expect(result.valid).toBe(true);
      expect(result.resultType?.typeName).toBe('number');
    });

    it('infers number type from float literals', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('3.14', {});

      expect(result.valid).toBe(true);
      expect(result.resultType?.typeName).toBe('number');
    });

    it('infers boolean type from true', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('true', {});

      expect(result.valid).toBe(true);
      expect(result.resultType?.typeName).toBe('boolean');
    });

    it('infers boolean type from false', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('false', {});

      expect(result.valid).toBe(true);
      expect(result.resultType?.typeName).toBe('boolean');
    });

    it('infers null type from null literal', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('null', {});

      expect(result.valid).toBe(true);
      expect(result.resultType?.typeName).toBe('null');
      expect(result.resultType?.nullable).toBe(true);
    });

    it('infers null type from undefined literal', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('undefined', {});

      expect(result.valid).toBe(true);
      expect(result.resultType?.typeName).toBe('null');
    });

    it('infers boolean type from comparison operators', () => {
      const validator = new ExpressionTypeValidator();

      expect(validator.validateExpression('a > b', {}).resultType?.typeName).toBe('boolean');
      expect(validator.validateExpression('a < b', {}).resultType?.typeName).toBe('boolean');
      expect(validator.validateExpression('a >= b', {}).resultType?.typeName).toBe('boolean');
      expect(validator.validateExpression('a <= b', {}).resultType?.typeName).toBe('boolean');
      expect(validator.validateExpression('a == b', {}).resultType?.typeName).toBe('boolean');
      expect(validator.validateExpression('a != b', {}).resultType?.typeName).toBe('boolean');
      expect(validator.validateExpression('a && b', {}).resultType?.typeName).toBe('boolean');
      expect(validator.validateExpression('a || b', {}).resultType?.typeName).toBe('boolean');
    });

    it('infers string type from template literals with interpolation', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('hello ${name}', {});

      expect(result.resultType?.typeName).toBe('string');
    });

    it('resolves variable types from availableTypes', () => {
      const validator = new ExpressionTypeValidator();
      const types: Record<string, TypeInfo> = {
        myVar: { typeName: 'number', optional: false, nullable: false },
      };

      const result = validator.validateExpression('myVar', types);

      expect(result.resultType?.typeName).toBe('number');
    });

    it('follows property paths using availableTypes properties', () => {
      const validator = new ExpressionTypeValidator();
      const types: Record<string, TypeInfo> = {
        obj: {
          typeName: 'object',
          optional: false,
          nullable: false,
          properties: {
            name: { typeName: 'string', optional: false, nullable: false },
          },
        },
      };

      const result = validator.validateExpression('obj.name', types);

      expect(result.resultType?.typeName).toBe('string');
    });

    it('returns unknown for unresolvable property paths', () => {
      const validator = new ExpressionTypeValidator();
      const types: Record<string, TypeInfo> = {
        obj: {
          typeName: 'object',
          optional: false,
          nullable: false,
          properties: {},
        },
      };

      const result = validator.validateExpression('obj.nonexistent', types);

      expect(result.resultType?.typeName).toBe('unknown');
    });

    it('returns unknown for completely unknown expressions', () => {
      const validator = new ExpressionTypeValidator();
      const result = validator.validateExpression('unknownVar', {});

      expect(result.resultType?.typeName).toBe('unknown');
    });
  });

  describe('validateExpression — expected type validation', () => {
    it('passes when inferred type matches expected type', () => {
      const validator = new ExpressionTypeValidator();
      const expected: TypeInfo = { typeName: 'string', optional: false, nullable: false };

      const result = validator.validateExpression('"hello"', {}, expected);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails when inferred type does not match expected type', () => {
      const validator = new ExpressionTypeValidator();
      const expected: TypeInfo = { typeName: 'number', optional: false, nullable: false };

      const result = validator.validateExpression('"hello"', {}, expected);

      // string is NOT compatible with number
      // Wait — isTypeCompatible has special case: string expected + number/boolean actual → true
      // But here expected is number and actual is string, which is NOT one of the special cases
      expect(result.valid).toBe(false);
    });

    it('allows number coercion to string (implicit conversion)', () => {
      const validator = new ExpressionTypeValidator();
      const expected: TypeInfo = { typeName: 'string', optional: false, nullable: false };

      const result = validator.validateExpression('42', {}, expected);

      // isTypeCompatible: expected 'string', actual 'number' → true (implicit string conversion)
      expect(result.valid).toBe(true);
    });

    it('allows boolean coercion to string (implicit conversion)', () => {
      const validator = new ExpressionTypeValidator();
      const expected: TypeInfo = { typeName: 'string', optional: false, nullable: false };

      const result = validator.validateExpression('true', {}, expected);

      expect(result.valid).toBe(true);
    });

    it('allows any non-void type as boolean (truthy/falsy)', () => {
      const validator = new ExpressionTypeValidator();
      const expected: TypeInfo = { typeName: 'boolean', optional: false, nullable: false };

      // string → boolean is allowed via truthy/falsy conversion
      const result = validator.validateExpression('"hello"', {}, expected);

      expect(result.valid).toBe(true);
    });

    it('provides type conversion suggestion on mismatch', () => {
      const validator = new ExpressionTypeValidator();
      const expected: TypeInfo = { typeName: 'number', optional: false, nullable: false };

      const result = validator.validateExpression('"hello"', {}, expected);

      expect(result.suggestions.some((s) => s.includes('Convert to number'))).toBe(true);
    });
  });

  describe('validateExpression — null/optional access detection', () => {
    it('warns about property access on nullable types', () => {
      const validator = new ExpressionTypeValidator();
      const types: Record<string, TypeInfo> = {
        obj: { typeName: 'object', optional: false, nullable: true },
      };

      const result = validator.validateExpression('obj.name', types);

      expect(result.warnings.some((w) => w.message.includes('null/undefined'))).toBe(true);
    });

    it('warns about property access on optional types', () => {
      const validator = new ExpressionTypeValidator();
      const types: Record<string, TypeInfo> = {
        obj: { typeName: 'object', optional: true, nullable: false },
      };

      const result = validator.validateExpression('obj.name', types);

      expect(result.warnings.some((w) => w.message.includes('null/undefined'))).toBe(true);
    });

    it('does not warn when optional chaining is used', () => {
      const validator = new ExpressionTypeValidator();
      const types: Record<string, TypeInfo> = {
        obj: { typeName: 'object', optional: true, nullable: false },
      };

      const result = validator.validateExpression('obj?.name', types);

      const nullWarnings = result.warnings.filter((w) => w.message.includes('null/undefined'));
      expect(nullWarnings).toHaveLength(0);
    });

    it('does not warn for non-nullable types', () => {
      const validator = new ExpressionTypeValidator();
      const types: Record<string, TypeInfo> = {
        obj: { typeName: 'object', optional: false, nullable: false },
      };

      const result = validator.validateExpression('obj.name', types);

      const nullWarnings = result.warnings.filter((w) => w.message.includes('null/undefined'));
      expect(nullWarnings).toHaveLength(0);
    });
  });

  describe('validateKubernetesRef', () => {
    it('validates __schema__ ref with schema proxy', () => {
      const validator = new ExpressionTypeValidator();
      const ref = mockRef('__schema__', 'spec.name');

      const result = validator.validateKubernetesRef(ref, {}, {} as any);

      expect(result.valid).toBe(true);
    });

    it('fails __schema__ ref without schema proxy', () => {
      const validator = new ExpressionTypeValidator();
      const ref = mockRef('__schema__', 'spec.name');

      const result = validator.validateKubernetesRef(ref, {});

      expect(result.valid).toBe(false);
    });

    it('validates resource ref with available resource', () => {
      const validator = new ExpressionTypeValidator();
      const ref = mockRef('my-deploy', 'status.ready');
      const resources = { 'my-deploy': {} as Enhanced<any, any> };

      const result = validator.validateKubernetesRef(ref, resources);

      expect(result.valid).toBe(true);
    });

    it('fails resource ref with missing resource', () => {
      const validator = new ExpressionTypeValidator();
      const ref = mockRef('missing', 'status.ready');

      const result = validator.validateKubernetesRef(ref, {});

      expect(result.valid).toBe(false);
      expect(result.suggestions.some((s) => s.includes('Available resources'))).toBe(true);
    });

    it('infers result type from ref._type when available', () => {
      const validator = new ExpressionTypeValidator();
      const ref = mockRef('my-deploy', 'status.ready', 'boolean');
      const resources = { 'my-deploy': {} as Enhanced<any, any> };

      const result = validator.validateKubernetesRef(ref, resources);

      expect(result.resultType?.typeName).toBe('boolean');
    });

    it('defaults to unknown when ref._type is not available', () => {
      const validator = new ExpressionTypeValidator();
      const ref = mockRef('my-deploy', 'status.ready');
      const resources = { 'my-deploy': {} as Enhanced<any, any> };

      const result = validator.validateKubernetesRef(ref, resources);

      expect(result.resultType?.typeName).toBe('unknown');
    });
  });
});

describe('TypeRegistry', () => {
  it('registers and retrieves types', () => {
    const registry = new TypeRegistry();
    const typeInfo: TypeInfo = { typeName: 'string', optional: false, nullable: false };

    registry.registerType('myType', typeInfo);

    expect(registry.getType('myType')).toBe(typeInfo);
  });

  it('returns undefined for unregistered types', () => {
    const registry = new TypeRegistry();

    expect(registry.getType('nonexistent')).toBeUndefined();
  });

  it('registers and retrieves resource types', () => {
    const registry = new TypeRegistry();
    const typeInfo: TypeInfo = { typeName: 'Deployment', optional: false, nullable: false };

    registry.registerResourceType('my-deploy', typeInfo);

    expect(registry.getResourceType('my-deploy')).toBe(typeInfo);
  });

  it('registers and retrieves schema types', () => {
    const registry = new TypeRegistry();
    const typeInfo: TypeInfo = { typeName: 'string', optional: false, nullable: false };

    registry.registerSchemaType('spec.name', typeInfo);

    expect(registry.getSchemaType('spec.name')).toBe(typeInfo);
  });

  it('getAvailableTypes merges all type categories with correct prefixes', () => {
    const registry = new TypeRegistry();
    registry.registerType('myVar', { typeName: 'string', optional: false, nullable: false });
    registry.registerResourceType('deploy', {
      typeName: 'Deployment',
      optional: false,
      nullable: false,
    });
    registry.registerSchemaType('spec.name', {
      typeName: 'string',
      optional: false,
      nullable: false,
    });

    const all = registry.getAvailableTypes();

    expect(all['myVar']).toBeDefined();
    expect(all['resources.deploy']).toBeDefined();
    expect(all['schema.spec.name']).toBeDefined();
  });

  it('clear removes all types', () => {
    const registry = new TypeRegistry();
    registry.registerType('a', { typeName: 'string', optional: false, nullable: false });
    registry.registerResourceType('b', { typeName: 'number', optional: false, nullable: false });
    registry.registerSchemaType('c', { typeName: 'boolean', optional: false, nullable: false });

    registry.clear();

    expect(registry.getType('a')).toBeUndefined();
    expect(registry.getResourceType('b')).toBeUndefined();
    expect(registry.getSchemaType('c')).toBeUndefined();
    expect(Object.keys(registry.getAvailableTypes())).toHaveLength(0);
  });
});

describe('TypeSafetyUtils', () => {
  it('fromArkType returns unknown placeholder', () => {
    const result = TypeSafetyUtils.fromArkType({} as any);

    expect(result.typeName).toBe('unknown');
    expect(result.optional).toBe(false);
    expect(result.nullable).toBe(false);
  });

  it('fromEnhancedType extracts type from constructor name', () => {
    class FakeDeployment {}
    const enhanced = new FakeDeployment() as any;

    const result = TypeSafetyUtils.fromEnhancedType(enhanced);

    expect(result.typeName).toBe('FakeDeployment');
    expect(result.properties).toBeDefined();
    expect(result.properties?.metadata).toBeDefined();
    expect(result.properties?.spec).toBeDefined();
    expect(result.properties?.status).toBeDefined();
  });

  it('validateCelExpressionType returns valid with expected type', () => {
    const expected: TypeInfo = { typeName: 'boolean', optional: false, nullable: false };
    const result = TypeSafetyUtils.validateCelExpressionType({} as any, expected);

    expect(result.valid).toBe(true);
    expect(result.resultType).toBe(expected);
  });
});

describe('TypeValidationError', () => {
  it('creates with expression and type info', () => {
    const expected: TypeInfo = { typeName: 'string', optional: false, nullable: false };
    const actual: TypeInfo = { typeName: 'number', optional: false, nullable: false };
    const error = new TypeValidationError('mismatch', 'expr', expected, actual);

    expect(error.expression).toBe('expr');
    expect(error.expectedType).toBe(expected);
    expect(error.actualType).toBe(actual);
    expect(error.name).toBe('TypeValidationError');
  });

  it('forTypeMismatch formats message correctly', () => {
    const expected: TypeInfo = { typeName: 'string', optional: false, nullable: false };
    const actual: TypeInfo = { typeName: 'number', optional: false, nullable: false };
    const error = TypeValidationError.forTypeMismatch('expr', expected, actual);

    expect(error.message).toContain('string');
    expect(error.message).toContain('number');
  });

  it('forUndefinedProperty formats message correctly', () => {
    const objType: TypeInfo = { typeName: 'Deployment', optional: false, nullable: false };
    const error = TypeValidationError.forUndefinedProperty('expr', 'fakeProp', objType);

    expect(error.message).toContain('fakeProp');
    expect(error.message).toContain('Deployment');
  });

  it('forInvalidOperation formats message correctly', () => {
    const left: TypeInfo = { typeName: 'string', optional: false, nullable: false };
    const right: TypeInfo = { typeName: 'boolean', optional: false, nullable: false };
    const error = TypeValidationError.forInvalidOperation('expr', '+', left, right);

    expect(error.message).toContain('+');
    expect(error.message).toContain('string');
    expect(error.message).toContain('boolean');
  });
});

describe('TypeValidationWarning', () => {
  it('forPotentialNullAccess creates warning', () => {
    const warning = TypeValidationWarning.forPotentialNullAccess('expr');

    expect(warning.message).toContain('null/undefined');
    expect(warning.expression).toBe('expr');
  });

  it('forImplicitTypeCoercion includes from/to types', () => {
    const warning = TypeValidationWarning.forImplicitTypeCoercion('expr', 'number', 'string');

    expect(warning.message).toContain('number');
    expect(warning.message).toContain('string');
  });
});
