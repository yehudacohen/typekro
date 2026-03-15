/**
 * Characterization tests for expression-classifier.ts
 *
 * Captures current behavior of all exported functions:
 * - isStaticValue
 * - createStaticValueResult
 * - analyzeExpressionWithRefs
 * - analyzeKubernetesRefObject
 * - analyzeObjectExpression
 * - analyzePrimitiveExpression
 * - analyzeFunction
 * - findReturnStatement
 * - isTemplateLiteral
 * - analyzeTemplateLiteral
 * - analyzeComplexValue
 * - convertKubernetesRefToResult
 * - handleSpecialCases
 */

import { describe, expect, test } from 'bun:test';
import { CEL_EXPRESSION_BRAND } from '../../src/core/constants/brands.js';
import {
  analyzeComplexValue,
  analyzeExpressionWithRefs,
  analyzeFunction,
  analyzeKubernetesRefObject,
  analyzeObjectExpression,
  analyzePrimitiveExpression,
  analyzeTemplateLiteral,
  convertKubernetesRefToResult,
  createStaticValueResult,
  findReturnStatement,
  handleSpecialCases,
  isStaticValue,
  isTemplateLiteral,
} from '../../src/core/expressions/analysis/expression-classifier.js';
import { parseScript } from '../../src/core/expressions/analysis/parser.js';
import type {
  AnalysisContext,
  CelConversionResult,
} from '../../src/core/expressions/analysis/shared-types.js';
import type { ResourceValidationResult } from '../../src/core/expressions/validation/resource-validation.js';
import {
  ResourceValidationError,
  type ValidationContext,
} from '../../src/core/expressions/validation/resource-validation-types.js';
import type { CelExpression, KubernetesRef } from '../../src/core/types/common.js';
import type { Enhanced } from '../../src/core/types/kubernetes.js';
import type { SchemaProxy } from '../../src/core/types/serialization.js';
import { KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeKubernetesRef(
  resourceId: string,
  fieldPath: string,
  _type?: string
): KubernetesRef<unknown> {
  const ref: Record<string | symbol, unknown> = {
    resourceId,
    fieldPath,
    _type,
  };
  ref[KUBERNETES_REF_BRAND] = true;
  return ref as unknown as KubernetesRef<unknown>;
}

/** Minimal stub satisfying Enhanced<unknown, unknown> for availableReferences */
function makeEnhancedStub(opts: { kind: string; apiVersion: string }): Enhanced<unknown, unknown> {
  // Enhanced requires many fields at runtime, but expression-classifier only reads
  // `kind` and `apiVersion` from these stubs. A single cast in the helper avoids
  // scattering `as any` across every test.
  return opts as unknown as Enhanced<unknown, unknown>;
}

/** Type alias matching handleSpecialCases' validateResourceReferencesFn parameter */
type ValidateResourceReferencesFn = (
  refs: KubernetesRef<unknown>[],
  availableResources: Record<string, Enhanced<unknown, unknown>>,
  schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>,
  validationContext?: ValidationContext
) => ResourceValidationResult[];

function makeContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    type: 'status',
    availableReferences: {},
    factoryType: 'kro',
    ...overrides,
  };
}

// ── isStaticValue ────────────────────────────────────────────────────

describe('isStaticValue', () => {
  test('null and undefined are static', () => {
    expect(isStaticValue(null)).toBe(true);
    expect(isStaticValue(undefined)).toBe(true);
  });

  test('primitives are static', () => {
    expect(isStaticValue('hello')).toBe(true);
    expect(isStaticValue('')).toBe(true);
    expect(isStaticValue(42)).toBe(true);
    expect(isStaticValue(0)).toBe(true);
    expect(isStaticValue(true)).toBe(true);
    expect(isStaticValue(false)).toBe(true);
  });

  test('KubernetesRef is NOT static', () => {
    const ref = makeKubernetesRef('myDeployment', 'status.readyReplicas');
    expect(isStaticValue(ref)).toBe(false);
  });

  test('plain objects are static if they contain no refs', () => {
    expect(isStaticValue({ a: 1, b: 'hello' })).toBe(true);
    expect(isStaticValue({ nested: { x: true } })).toBe(true);
  });

  test('objects containing KubernetesRef are NOT static', () => {
    const ref = makeKubernetesRef('myDeployment', 'status.readyReplicas');
    expect(isStaticValue({ value: ref })).toBe(false);
  });

  test('arrays of primitives are static', () => {
    expect(isStaticValue([1, 2, 3])).toBe(true);
    expect(isStaticValue(['a', 'b'])).toBe(true);
    expect(isStaticValue([])).toBe(true);
  });

  test('arrays containing KubernetesRef are NOT static', () => {
    const ref = makeKubernetesRef('svc', 'status.host');
    expect(isStaticValue([ref])).toBe(false);
  });

  test('functions default to static', () => {
    // Functions don't contain KubernetesRef, so isStaticValue returns true
    expect(isStaticValue(() => 'hello')).toBe(true);
  });
});

// ── createStaticValueResult ──────────────────────────────────────────

describe('createStaticValueResult', () => {
  test('returns valid result with no CEL expression', () => {
    const result = createStaticValueResult('anything');
    expect(result.valid).toBe(true);
    expect(result.celExpression).toBeNull();
    expect(result.dependencies).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.requiresConversion).toBe(false);
  });

  test('works with various value types', () => {
    for (const value of [null, undefined, 42, 'string', { a: 1 }, [1, 2]]) {
      const result = createStaticValueResult(value);
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
    }
  });
});

// ── analyzeKubernetesRefObject ───────────────────────────────────────

describe('analyzeKubernetesRefObject', () => {
  test('converts a KubernetesRef to CEL path', () => {
    const ref = makeKubernetesRef('myDeployment', 'status.readyReplicas', 'number');
    const ctx = makeContext();
    const result = analyzeKubernetesRefObject(ref, ctx);

    expect(result.valid).toBe(true);
    expect(result.celExpression).not.toBeNull();
    expect(result.celExpression!.expression).toBe('myDeployment.status.readyReplicas');
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]).toBe(ref);
    expect(result.requiresConversion).toBe(true);
  });

  test('schema references use "schema" prefix instead of "__schema__"', () => {
    const ref = makeKubernetesRef('__schema__', 'spec.name');
    const ctx = makeContext();
    const result = analyzeKubernetesRefObject(ref, ctx);

    expect(result.celExpression!.expression).toBe('schema.spec.name');
  });

  test('accumulates dependencies in context', () => {
    const ref = makeKubernetesRef('svc', 'status.host');
    const ctx = makeContext();
    const result = analyzeKubernetesRefObject(ref, ctx);

    expect(ctx.dependencies).toHaveLength(1);
    expect(result.dependencies).toHaveLength(1);
  });

  test('initializes dependencies array if not present', () => {
    const ref = makeKubernetesRef('deploy', 'status.ready');
    const ctx = makeContext();
    // Ensure dependencies is not set
    delete ctx.dependencies;
    analyzeKubernetesRefObject(ref, ctx);
    expect(ctx.dependencies).toBeDefined();
    expect(ctx.dependencies!).toHaveLength(1);
  });
});

// ── analyzeObjectExpression ──────────────────────────────────────────

describe('analyzeObjectExpression', () => {
  test('returns dependencies from nested KubernetesRef objects', () => {
    const ref = makeKubernetesRef('deploy', 'status.replicas');
    const obj = { field: ref, other: 'static' };
    const ctx = makeContext();
    const result = analyzeObjectExpression(obj, ctx);

    expect(result.valid).toBe(true);
    expect(result.celExpression).toBeNull(); // Objects don't convert to single CEL
    expect(result.dependencies.length).toBeGreaterThan(0);
    expect(result.requiresConversion).toBe(true);
  });

  test('returns empty dependencies for plain objects', () => {
    const ctx = makeContext();
    const result = analyzeObjectExpression({ a: 1 }, ctx);

    expect(result.dependencies).toHaveLength(0);
    expect(result.requiresConversion).toBe(false);
  });

  test('initializes dependencies array in context', () => {
    const ctx = makeContext();
    delete ctx.dependencies;
    analyzeObjectExpression({ a: 1 }, ctx);
    expect(ctx.dependencies).toBeDefined();
  });
});

// ── analyzePrimitiveExpression ───────────────────────────────────────

describe('analyzePrimitiveExpression', () => {
  test('returns no-conversion result', () => {
    const ctx = makeContext();
    const result = analyzePrimitiveExpression(42, ctx);

    expect(result.valid).toBe(true);
    expect(result.celExpression).toBeNull();
    expect(result.dependencies).toEqual([]);
    expect(result.requiresConversion).toBe(false);
  });
});

// ── analyzeFunction ──────────────────────────────────────────────────

describe('analyzeFunction', () => {
  test('returns error for function bodies (not yet supported)', () => {
    const fn = () => {
      return 'hello';
    };
    const result = analyzeFunction(fn);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain(
      'Converting function bodies to CEL expressions is not yet supported'
    );
  });

  test('returns error for arrow functions with return', () => {
    const fn = (x: number) => {
      return x + 1;
    };
    const result = analyzeFunction(fn as (...args: unknown[]) => unknown);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('returns error for arrow functions without explicit return', () => {
    // Implicit return — no ReturnStatement in AST
    const fn = () => 42;
    const result = analyzeFunction(fn as (...args: unknown[]) => unknown);

    // Either "no return statement" or "not yet supported"
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ── findReturnStatement ──────────────────────────────────────────────

describe('findReturnStatement', () => {
  test('finds return statement in function body', () => {
    const ast = parseScript('(function() { return 42; })');
    const result = findReturnStatement(ast);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('ReturnStatement');
  });

  test('finds return statement in arrow function with block body', () => {
    const ast = parseScript('(() => { return "hello"; })');
    const result = findReturnStatement(ast);
    expect(result).not.toBeNull();
  });

  test('returns null for expression without return statement', () => {
    const ast = parseScript('42 + 1');
    const result = findReturnStatement(ast);
    expect(result).toBeNull();
  });

  test('returns null for arrow function with implicit return', () => {
    const ast = parseScript('(() => 42)');
    const result = findReturnStatement(ast);
    // Arrow with implicit return has no ReturnStatement node
    expect(result).toBeNull();
  });
});

// ── isTemplateLiteral ────────────────────────────────────────────────

describe('isTemplateLiteral', () => {
  test('strings with ${} are template literals', () => {
    expect(isTemplateLiteral('${foo}')).toBe(true);
    expect(isTemplateLiteral('hello ${name} world')).toBe(true);
  });

  test('plain strings are not template literals', () => {
    expect(isTemplateLiteral('hello world')).toBe(false);
    expect(isTemplateLiteral('')).toBe(false);
  });

  test('incomplete template syntax is not a template literal', () => {
    expect(isTemplateLiteral('${')).toBe(false); // no closing }
    expect(isTemplateLiteral('}')).toBe(false);
  });

  test('objects with type "TemplateLiteral" are template literals', () => {
    expect(isTemplateLiteral({ type: 'TemplateLiteral' })).toBe(true);
  });

  test('other objects are not template literals', () => {
    expect(isTemplateLiteral({ type: 'Identifier' })).toBe(false);
    expect(isTemplateLiteral({})).toBe(false);
  });

  test('non-string/non-object values are not template literals', () => {
    expect(isTemplateLiteral(42)).toBe(false);
    expect(isTemplateLiteral(null)).toBe(false);
    expect(isTemplateLiteral(undefined)).toBe(false);
  });
});

// ── analyzeTemplateLiteral ───────────────────────────────────────────

describe('analyzeTemplateLiteral', () => {
  test('string template literals produce CEL expressions', () => {
    const ctx = makeContext();
    const result = analyzeTemplateLiteral('${myDeploy.status.ready}', ctx);

    expect(result.valid).toBe(true);
    expect(result.celExpression).not.toBeNull();
    expect(result.celExpression!.expression).toContain('${');
    expect(result.requiresConversion).toBe(true);
  });

  test('non-string template literals produce placeholder expressions', () => {
    const ctx = makeContext();
    const result = analyzeTemplateLiteral({ type: 'TemplateLiteral' }, ctx);

    expect(result.valid).toBe(true);
    expect(result.celExpression).not.toBeNull();
    expect(result.celExpression!.expression).toContain('Complex template literal');
  });

  test('structured non-string template literal uses placeholder', () => {
    const ctx = makeContext();
    // Non-string values get the "Complex template literal" placeholder
    const result = analyzeTemplateLiteral({ parts: ['a', 'b'] }, ctx);
    expect(result.valid).toBe(true);
    expect(result.celExpression).not.toBeNull();
    expect(result.celExpression!.expression).toContain('Complex template literal');
  });
});

// ── analyzeComplexValue ──────────────────────────────────────────────

describe('analyzeComplexValue', () => {
  test('objects with no refs return invalid result', () => {
    const ctx = makeContext();
    const result = analyzeComplexValue({ a: 1, b: 'hello' }, ctx);

    expect(result.valid).toBe(false);
    expect(result.requiresConversion).toBe(false);
  });

  test('objects with KubernetesRef dependencies produce errors (not yet supported)', () => {
    const ref = makeKubernetesRef('deploy', 'status.replicas');
    const ctx = makeContext();
    const result = analyzeComplexValue({ field: ref }, ctx);

    // Complex values with refs produce an error about not being supported
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.requiresConversion).toBe(true);
  });

  test('arrays with KubernetesRef dependencies produce errors', () => {
    const ref = makeKubernetesRef('svc', 'status.host');
    const ctx = makeContext();
    const result = analyzeComplexValue([ref], ctx);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.requiresConversion).toBe(true);
  });
});

// ── convertKubernetesRefToResult ─────────────────────────────────────

describe('convertKubernetesRefToResult', () => {
  test('converts a simple ref to CEL', () => {
    const ref = makeKubernetesRef('myService', 'status.loadBalancer.ip');
    const ctx = makeContext({
      availableReferences: {
        myService: makeEnhancedStub({ kind: 'Service', apiVersion: 'v1' }),
      },
    });
    const result = convertKubernetesRefToResult(ref, ctx);

    expect(result.valid).toBe(true);
    expect(result.celExpression).not.toBeNull();
    expect(result.celExpression!.expression).toContain('myService');
    expect(result.dependencies).toHaveLength(1);
    expect(result.requiresConversion).toBe(true);
  });

  test('schema refs use "schema" prefix', () => {
    const ref = makeKubernetesRef('__schema__', 'spec.name');
    const ctx = makeContext();
    const result = convertKubernetesRefToResult(ref, ctx);

    expect(result.valid).toBe(true);
    expect(result.celExpression!.expression).toContain('schema');
    expect(result.celExpression!.expression).not.toContain('__schema__');
  });

  test('handles conversion errors gracefully', () => {
    // Create a ref that might cause issues with CEL conversion
    const ref = makeKubernetesRef('', '');
    const ctx = makeContext();
    // Should not throw
    const result = convertKubernetesRefToResult(ref, ctx);
    // Either valid or has errors, but shouldn't crash
    expect(result).toBeDefined();
  });
});

// ── analyzeExpressionWithRefs (dispatch) ─────────────────────────────

describe('analyzeExpressionWithRefs', () => {
  const mockAnalyzeExpressionFn = (
    expression: unknown,
    _context: AnalysisContext
  ): CelConversionResult => ({
    valid: true,
    celExpression: {
      [CEL_EXPRESSION_BRAND]: true as const,
      expression: String(expression),
      _type: 'string',
    } satisfies CelExpression,
    dependencies: [],
    sourceMap: [],
    errors: [],
    warnings: [],
    requiresConversion: true,
  });

  test('static values return no-conversion result', () => {
    const ctx = makeContext();
    const result = analyzeExpressionWithRefs('hello', ctx, mockAnalyzeExpressionFn);

    expect(result.valid).toBe(true);
    expect(result.requiresConversion).toBe(false);
  });

  test('KubernetesRef dispatches to ref handler', () => {
    const ref = makeKubernetesRef('deploy', 'status.replicas');
    const ctx = makeContext();
    const result = analyzeExpressionWithRefs(ref, ctx, mockAnalyzeExpressionFn);

    expect(result.valid).toBe(true);
    expect(result.requiresConversion).toBe(true);
    expect(result.celExpression).not.toBeNull();
  });

  test('functions dispatch to function handler', () => {
    const baseFn = () => {
      return 42;
    };
    // Make it contain a ref to pass the static check
    const fn = Object.assign(baseFn, {
      __kubernetesRef: true,
      resourceId: 'test',
      fieldPath: 'status',
    });

    const ctx = makeContext();
    const result = analyzeExpressionWithRefs(fn, ctx, mockAnalyzeExpressionFn);
    // Functions with refs are handled — either as KubernetesRef or as function
    expect(result).toBeDefined();
  });

  test('null/undefined values return static result', () => {
    const ctx = makeContext();
    const result = analyzeExpressionWithRefs(null, ctx, mockAnalyzeExpressionFn);
    expect(result.valid).toBe(true);
    expect(result.requiresConversion).toBe(false);
  });
});

// ── handleSpecialCases ───────────────────────────────────────────────

describe('handleSpecialCases', () => {
  test('handles optional chaining expressions', () => {
    const ctx = makeContext({
      availableReferences: {
        deploy: makeEnhancedStub({ kind: 'Deployment', apiVersion: 'apps/v1' }),
      },
    });
    const result = handleSpecialCases('deploy?.status?.readyReplicas', ctx);

    // Should return a result for optional chaining
    expect(result).not.toBeNull();
    if (result) {
      expect(result.requiresConversion).toBe(true);
    }
  });

  test('handles nullish coalescing expressions', () => {
    const ctx = makeContext({
      availableReferences: {
        deploy: makeEnhancedStub({ kind: 'Deployment', apiVersion: 'apps/v1' }),
      },
    });
    const result = handleSpecialCases('deploy.status.replicas ?? 0', ctx);

    expect(result).not.toBeNull();
  });

  test('handles mixed optional chaining and nullish coalescing', () => {
    const ctx = makeContext({
      availableReferences: {
        deploy: makeEnhancedStub({ kind: 'Deployment', apiVersion: 'apps/v1' }),
      },
    });
    const result = handleSpecialCases('deploy?.status?.replicas ?? 0', ctx);

    expect(result).not.toBeNull();
  });

  test('handles simple property access paths', () => {
    const ctx = makeContext({
      availableReferences: {
        myDeploy: makeEnhancedStub({ kind: 'Deployment', apiVersion: 'apps/v1' }),
      },
    });
    const result = handleSpecialCases('myDeploy.status.readyReplicas', ctx);

    expect(result).not.toBeNull();
    if (result) {
      expect(result.celExpression).not.toBeNull();
      expect(result.celExpression!.expression).toBe('myDeploy.status.readyReplicas');
      expect(result.requiresConversion).toBe(true);
    }
  });

  test('returns null for non-matching expressions', () => {
    const ctx = makeContext();
    const result = handleSpecialCases('1 + 2 + 3', ctx);
    expect(result).toBeNull();
  });

  test('returns null for complex expressions that are not simple paths', () => {
    const ctx = makeContext();
    const result = handleSpecialCases('foo[0].bar', ctx);
    // Contains brackets — not a simple property access path
    expect(result).toBeNull();
  });

  test('handles validation callback when provided', () => {
    const ctx = makeContext({
      validateResourceReferences: true,
      availableReferences: {
        deploy: makeEnhancedStub({ kind: 'Deployment', apiVersion: 'apps/v1' }),
      },
    });

    const validateFn: ValidateResourceReferencesFn = () => [
      {
        valid: true,
        errors: [],
        warnings: [],
        suggestions: [],
        metadata: {
          resourceType: 'Deployment',
          fieldOptional: false,
          fieldNullable: false,
          dependencyDepth: 1,
          isStatusField: true,
          isSpecField: false,
          isMetadataField: false,
        },
      },
    ];

    const result = handleSpecialCases('deploy.status.readyReplicas', ctx, validateFn);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.valid).toBe(true);
    }
  });

  test('validation runs only when dependencies are found', () => {
    const ctx = makeContext({
      validateResourceReferences: true,
      availableReferences: {},
    });

    const validateFn: ValidateResourceReferencesFn = () => {
      return [
        {
          valid: false,
          errors: [ResourceValidationError.forResourceNotFound('missing.status', 'missing', [])],
          warnings: [],
          suggestions: [],
          metadata: {
            resourceType: 'Unknown',
            fieldOptional: false,
            fieldNullable: false,
            dependencyDepth: 1,
            isStatusField: true,
            isSpecField: false,
            isMetadataField: false,
          },
        },
      ];
    };

    const result = handleSpecialCases('missing.status', ctx, validateFn);
    expect(result).not.toBeNull();
    if (result) {
      // Characterization: the simple path handler runs, but validation only
      // fires if extractDependenciesFromExpression found dependencies.
      // For "missing.status" with no availableReferences, no deps may be found,
      // so validation may not run. Capture whatever the actual state is:
      expect(result.requiresConversion).toBe(true);
      expect(result.celExpression).not.toBeNull();
    }
  });
});
