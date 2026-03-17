/**
 * Characterization tests for CelTypeInferenceEngine
 *
 * These tests capture the CURRENT behavior of the type inference engine,
 * including any quirks. They serve as a safety net for refactoring.
 *
 * Source: src/core/expressions/validation/type-inference.ts (1,156 lines)
 */

import { describe, expect, it } from 'bun:test';
import type { TypeInferenceContext } from '../../src/core/expressions/validation/type-inference.js';
import {
  CelTypeInferenceEngine,
  TypeInferenceError,
  TypeInferenceWarning,
} from '../../src/core/expressions/validation/type-inference.js';
import type { TypeInfo } from '../../src/core/expressions/validation/type-safety.js';
import type { CelExpression } from '../../src/core/types/common.js';
import { CEL_EXPRESSION_BRAND } from '../../src/shared/brands.js';

// Helper to create a CelExpression object
function celExpr(expression: string): CelExpression {
  return {
    [CEL_EXPRESSION_BRAND]: true as const,
    expression,
  };
}

// Helper to create a minimal TypeInferenceContext
function createContext(overrides: Partial<TypeInferenceContext> = {}): TypeInferenceContext {
  return {
    availableResources: {},
    factoryType: 'direct',
    ...overrides,
  };
}

describe('CelTypeInferenceEngine', () => {
  describe('constructor', () => {
    it('initializes with builtin types without error', () => {
      const engine = new CelTypeInferenceEngine();
      expect(engine).toBeDefined();
    });
  });

  describe('inferType — literal expressions', () => {
    it('infers string literal type from double-quoted string', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('"hello"'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('string');
      expect(result.resultType.optional).toBe(false);
      expect(result.resultType.nullable).toBe(false);
      expect(result.confidence).toBe(1.0);
    });

    it('infers string literal type from single-quoted string', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr("'hello'"), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('string');
      expect(result.confidence).toBe(1.0);
    });

    it('infers integer literal type', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('42'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('number');
      expect(result.confidence).toBe(1.0);
    });

    it('infers float literal type', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('3.14'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('number');
      expect(result.confidence).toBe(1.0);
    });

    it('infers boolean true literal', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('true'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
      expect(result.confidence).toBe(1.0);
    });

    it('infers boolean false literal', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('false'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
      expect(result.confidence).toBe(1.0);
    });

    it('infers null literal type', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('null'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('null');
      expect(result.resultType.nullable).toBe(true);
      expect(result.confidence).toBe(1.0);
    });

    it('returns unknown for unrecognized literals with low confidence', () => {
      const engine = new CelTypeInferenceEngine();
      // 'someIdentifier' is not a literal, resource ref, schema ref, function call,
      // binary op, or conditional — falls through to default unknown
      const result = engine.inferType(celExpr('someIdentifier'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('unknown');
      expect(result.confidence).toBe(0.1);
    });
  });

  describe('inferType — binary operations', () => {
    it('infers boolean type for comparison operators (>)', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('a > 0'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
    });

    it('infers boolean type for equality operators (==)', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('a == b'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
    });

    it('infers boolean type for inequality operators (!=)', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('a != b'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
    });

    it('infers boolean type for logical AND (&&)', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('a && b'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
    });

    it('infers boolean type for logical OR (||)', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('a || b'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
    });

    it('infers number type for addition (+)', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('a + b'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('number');
    });

    it('reduces confidence for binary operations (0.9 factor)', () => {
      const engine = new CelTypeInferenceEngine();
      // Operands are unknown identifiers (confidence 0.1), so result = 0.1 * 0.9 = 0.09
      const result = engine.inferType(celExpr('a > b'), createContext());

      expect(result.success).toBe(true);
      expect(result.confidence).toBeCloseTo(0.09, 5);
    });

    it('increments complexity score for binary operations', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('a > b'), createContext());

      expect(result.metadata.complexityScore).toBeGreaterThanOrEqual(1);
    });

    it('returns unknown type for unsupported operators like -', () => {
      const engine = new CelTypeInferenceEngine();
      // '-' is not registered in operatorTypes, so getOperatorResultType returns null
      const result = engine.inferType(celExpr('a - b'), createContext());

      expect(result.success).toBe(true);
      // '-' is in the isBinaryOperation check but NOT in operatorTypes map
      // So it finds the operator but getOperatorResultType returns null
      expect(result.resultType.typeName).toBe('unknown');
    });

    it('handles operator precedence — finds lowest-precedence operator first', () => {
      const engine = new CelTypeInferenceEngine();
      // findMainOperator searches in order: ||, &&, ==, !=, >, <, >=, <=, +, -, *, /
      // So for "a > 0 && b > 0", it should find && first
      const result = engine.inferType(celExpr('a > 0 && b > 0'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
    });
  });

  describe('inferType — function calls', () => {
    it('infers boolean return type for has() function', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('has(field)'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
      expect(result.confidence).toBe(0.8);
    });

    it('infers number return type for size() function', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('size(list)'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('number');
      expect(result.confidence).toBe(0.8);
    });

    it('tracks function usage in metadata', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('has(field)'), createContext());

      expect(result.metadata.functionsUsed).toContain('has');
    });

    it('returns error for unknown functions', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('unknownFunc(arg)'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('unknown');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.confidence).toBe(0);
    });

    it('adds complexity score of 2 for function calls', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('has(field)'), createContext());

      expect(result.metadata.complexityScore).toBe(2);
    });
  });

  describe('inferType — resource references', () => {
    it('returns error for resource reference with no matching resource in context', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(
        celExpr('resources.myDeployment.status.readyReplicas'),
        createContext()
      );

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('unknown');
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('tracks resource references in metadata', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(
        celExpr('resources.myDeployment.status.readyReplicas'),
        createContext()
      );

      // extractResourceReferences runs first, then analyzeResourceReference also adds
      expect(result.metadata.resourceReferences.length).toBeGreaterThan(0);
      expect(result.metadata.resourceReferences).toContain(
        'resources.myDeployment.status.readyReplicas'
      );
    });

    it('detects optional chaining in resource references', () => {
      const engine = new CelTypeInferenceEngine();
      // Note: The tokenizer splits on whitespace. 'resources.myDeploy?.status' is one token.
      // extractResourceReferences regex wouldn't match ? but isResourceReference would still match.
      const result = engine.inferType(celExpr('resources.myDeploy?.status.ready'), createContext());

      // Even without a matching resource, extractResourceReferences detects ?.
      expect(result.metadata.usesOptionalChaining).toBe(true);
    });

    it('returns unknown for malformed resource reference (no field path)', () => {
      const engine = new CelTypeInferenceEngine();
      // 'resources.myDeploy' has no third component — regex requires resources.X.Y
      const result = engine.inferType(celExpr('resources.myDeploy'), createContext());

      expect(result.success).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('inferType — schema references', () => {
    it('returns unknown when no schema proxy is provided', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('schema.spec.name'), createContext({}));

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('unknown');
      expect(result.resultType.optional).toBe(false);
    });

    it('tracks schema references in metadata', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('schema.spec.name'), createContext());

      expect(result.metadata.schemaReferences.length).toBeGreaterThan(0);
    });

    it('infers type from schema proxy values', () => {
      const engine = new CelTypeInferenceEngine();
      const schemaProxy = { spec: { name: 'test', replicas: 3, enabled: true } };
      const result = engine.inferType(
        celExpr('schema.spec.name'),
        createContext({ schemaProxy: schemaProxy as any })
      );

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('string');
      expect(result.confidence).toBe(0.9);
    });

    it('infers number type from schema proxy', () => {
      const engine = new CelTypeInferenceEngine();
      const schemaProxy = { spec: { replicas: 3 } };
      const result = engine.inferType(
        celExpr('schema.spec.replicas'),
        createContext({ schemaProxy: schemaProxy as any })
      );

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('number');
    });

    it('infers boolean type from schema proxy', () => {
      const engine = new CelTypeInferenceEngine();
      const schemaProxy = { spec: { enabled: true } };
      const result = engine.inferType(
        celExpr('schema.spec.enabled'),
        createContext({ schemaProxy: schemaProxy as any })
      );

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
    });

    it('returns unknown optional for missing schema path', () => {
      const engine = new CelTypeInferenceEngine();
      const schemaProxy = { spec: { name: 'test' } };
      const result = engine.inferType(
        celExpr('schema.spec.nonexistent'),
        createContext({ schemaProxy: schemaProxy as any })
      );

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('unknown');
      expect(result.resultType.optional).toBe(true);
    });
  });

  describe('inferType — conditional expressions', () => {
    it('infers union type for ternary with different branch types', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('condition ? "yes" : 42'), createContext());

      expect(result.success).toBe(true);
      // Unify string and number → union
      expect(result.resultType.typeName).toBe('string | number');
      expect(result.resultType.unionTypes).toHaveLength(2);
    });

    it('infers single type when both branches have same type', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('condition ? "yes" : "no"'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('string');
    });

    it('adds complexity score of 2 for conditional expressions', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('condition ? "yes" : "no"'), createContext());

      expect(result.metadata.complexityScore).toBeGreaterThanOrEqual(2);
    });

    it('reduces confidence for conditional expressions (0.9 factor)', () => {
      const engine = new CelTypeInferenceEngine();
      // Branches are string literals (confidence 1.0), condition is unknown (0.1)
      // Result = min(0.1, 1.0, 1.0) * 0.9 = 0.09
      const result = engine.inferType(celExpr('condition ? "yes" : "no"'), createContext());

      expect(result.confidence).toBeCloseTo(0.09, 5);
    });
  });

  describe('inferType — error handling', () => {
    it('returns failure result when expression object has no expression property', () => {
      const engine = new CelTypeInferenceEngine();
      const badExpr = { [CEL_EXPRESSION_BRAND]: true as const } as any;
      const result = engine.inferType(badExpr, createContext());

      expect(result.success).toBe(false);
      expect(result.resultType.typeName).toBe('unknown');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.confidence).toBe(0);
    });
  });

  describe('inferType — metadata extraction', () => {
    it('extracts resource references from complex expressions', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(
        celExpr('resources.deploy.status.ready > 0'),
        createContext()
      );

      expect(result.metadata.resourceReferences).toContain('resources.deploy.status.ready');
    });

    it('extracts schema references from complex expressions', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('schema.spec.replicas > 0'), createContext());

      expect(result.metadata.schemaReferences).toContain('schema.spec.replicas');
    });

    it('detects optional chaining in expressions', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('resources.deploy?.status.ready'), createContext());

      expect(result.metadata.usesOptionalChaining).toBe(true);
    });

    it('empty metadata for simple literals', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('"hello"'), createContext());

      expect(result.metadata.functionsUsed).toEqual([]);
      expect(result.metadata.resourceReferences).toEqual([]);
      expect(result.metadata.schemaReferences).toEqual([]);
      expect(result.metadata.usesOptionalChaining).toBe(false);
      expect(result.metadata.canReturnNull).toBe(false);
      expect(result.metadata.complexityScore).toBe(0);
    });
  });

  describe('inferTypes — batch inference', () => {
    it('infers types for multiple expressions', () => {
      const engine = new CelTypeInferenceEngine();
      const results = engine.inferTypes(
        [celExpr('"hello"'), celExpr('42'), celExpr('true')],
        createContext()
      );

      expect(results).toHaveLength(3);
      expect(results[0]?.resultType.typeName).toBe('string');
      expect(results[1]?.resultType.typeName).toBe('number');
      expect(results[2]?.resultType.typeName).toBe('boolean');
    });

    it('returns empty array for empty input', () => {
      const engine = new CelTypeInferenceEngine();
      const results = engine.inferTypes([], createContext());

      expect(results).toEqual([]);
    });
  });

  describe('validateTypeCompatibility', () => {
    it('returns valid for exact type match', () => {
      const engine = new CelTypeInferenceEngine();
      const source: TypeInfo = { typeName: 'string', optional: false, nullable: false };
      const target: TypeInfo = { typeName: 'string', optional: false, nullable: false };

      const result = engine.validateTypeCompatibility(source, target);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('returns valid when target is any type', () => {
      const engine = new CelTypeInferenceEngine();
      const source: TypeInfo = { typeName: 'string', optional: false, nullable: false };
      const target: TypeInfo = { typeName: 'any', optional: false, nullable: false };

      const result = engine.validateTypeCompatibility(source, target);

      expect(result.valid).toBe(true);
    });

    it('returns valid with warning for implicit conversion', () => {
      const engine = new CelTypeInferenceEngine();
      // null assigned to nullable target — assignable but requires implicit conversion
      const source: TypeInfo = { typeName: 'null', optional: false, nullable: true };
      const target: TypeInfo = { typeName: 'string', optional: false, nullable: true };

      const result = engine.validateTypeCompatibility(source, target);

      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('returns invalid for incompatible types', () => {
      const engine = new CelTypeInferenceEngine();
      const source: TypeInfo = { typeName: 'string', optional: false, nullable: false };
      const target: TypeInfo = { typeName: 'number', optional: false, nullable: false };

      const result = engine.validateTypeCompatibility(source, target);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('includes conversion suggestion for incompatible types', () => {
      const engine = new CelTypeInferenceEngine();
      const source: TypeInfo = { typeName: 'string', optional: false, nullable: false };
      const target: TypeInfo = { typeName: 'number', optional: false, nullable: false };

      const result = engine.validateTypeCompatibility(source, target);

      expect(result.suggestions).toContain('Convert string to number');
    });

    it('allows undefined to optional target', () => {
      const engine = new CelTypeInferenceEngine();
      const source: TypeInfo = { typeName: 'undefined', optional: true, nullable: false };
      const target: TypeInfo = { typeName: 'string', optional: true, nullable: false };

      const result = engine.validateTypeCompatibility(source, target);

      expect(result.valid).toBe(true);
    });
  });

  describe('TypeInferenceError', () => {
    it('creates error with message and expression', () => {
      const error = new TypeInferenceError('test error', 'a > b');

      expect(error.message).toBe('test error');
      expect(error.celExpression).toBe('a > b');
      expect(error.name).toBe('TypeInferenceError');
      expect(error).toBeInstanceOf(Error);
    });

    it('includes location when provided', () => {
      const error = new TypeInferenceError('test', 'expr', { start: 0, end: 5 });

      expect(error.location).toEqual({ start: 0, end: 5 });
    });

    it('creates error via forUnknownFunction static method', () => {
      const error = TypeInferenceError.forUnknownFunction('expr', 'myFunc');

      expect(error.message).toBe('Unknown CEL function: myFunc');
      expect(error.celExpression).toBe('expr');
    });

    it('creates error via forIncompatibleOperands static method', () => {
      const left: TypeInfo = { typeName: 'string', optional: false, nullable: false };
      const right: TypeInfo = { typeName: 'number', optional: false, nullable: false };
      const error = TypeInferenceError.forIncompatibleOperands('expr', '+', left, right);

      expect(error.message).toBe("Incompatible operands for operator '+': string and number");
    });

    it('creates error via forUnresolvableReference static method', () => {
      const error = TypeInferenceError.forUnresolvableReference('expr', 'resources.missing.field');

      expect(error.message).toBe('Cannot resolve reference: resources.missing.field');
    });
  });

  describe('TypeInferenceWarning', () => {
    it('creates warning with message and expression', () => {
      const warning = new TypeInferenceWarning('test warning', 'a > b');

      expect(warning.message).toBe('test warning');
      expect(warning.celExpression).toBe('a > b');
    });

    it('creates warning via forPotentialNullDereference', () => {
      const warning = TypeInferenceWarning.forPotentialNullDereference('expr', 'ref.field');

      expect(warning.message).toBe('Potential null dereference: ref.field');
    });

    it('creates warning via forImplicitTypeConversion', () => {
      const warning = TypeInferenceWarning.forImplicitTypeConversion('expr', 'number', 'string');

      expect(warning.message).toBe('Implicit type conversion from number to string');
    });

    it('includes location when provided', () => {
      const warning = new TypeInferenceWarning('msg', 'expr', { start: 10, end: 20 });

      expect(warning.location).toEqual({ start: 10, end: 20 });
    });
  });

  describe('tokenization quirks', () => {
    it('splits on whitespace — multi-word strings become multiple tokens', () => {
      const engine = new CelTypeInferenceEngine();
      // '"hello world"' becomes two tokens: ['"hello', 'world"']
      // This won't match the literal regex properly
      const result = engine.inferType(celExpr('"hello world"'), createContext());

      // The expression has no operator, no function call, not a resource/schema ref,
      // and the literal check joins back as '"hello world"' which DOES match /^["'].*["']$/
      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('string');
    });

    it('empty expression falls through to unknown', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr(''), createContext());

      expect(result.success).toBe(true);
      // Empty string → empty tokens after filtering → falls to default unknown
      expect(result.resultType.typeName).toBe('unknown');
      expect(result.confidence).toBe(0.1);
    });
  });

  describe('classification priority', () => {
    // The engine checks in order: binary op, function call, resource ref, schema ref,
    // literal, conditional. This matters when expressions match multiple patterns.

    it('binary operation takes priority over function call', () => {
      const engine = new CelTypeInferenceEngine();
      // 'has(x) && has(y)' matches both binary (&&) and function call (has())
      // Binary check comes first in analyzeExpression
      const result = engine.inferType(celExpr('has(x) && has(y)'), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
    });

    it('binary operation takes priority over resource reference', () => {
      const engine = new CelTypeInferenceEngine();
      // 'resources.deploy.status.ready > 0' matches both binary (>) and resource ref
      const result = engine.inferType(
        celExpr('resources.deploy.status.ready > 0'),
        createContext()
      );

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
    });
  });

  describe('edge cases', () => {
    it('handles expressions with only whitespace', () => {
      const engine = new CelTypeInferenceEngine();
      const result = engine.inferType(celExpr('   '), createContext());

      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('unknown');
    });

    it('handles very long expressions without crashing', () => {
      const engine = new CelTypeInferenceEngine();
      const longExpr = Array(100).fill('a > 0').join(' && ');
      const result = engine.inferType(celExpr(longExpr), createContext());

      expect(result.success).toBe(true);
    });

    it('handles nested conditional expressions', () => {
      const engine = new CelTypeInferenceEngine();
      // Simplified — the tokenizer/parser is basic, so nested ternaries
      // will only find the first ? and first : positions
      const result = engine.inferType(celExpr('a ? "x" : b ? "y" : "z"'), createContext());

      expect(result.success).toBe(true);
    });
  });
});
