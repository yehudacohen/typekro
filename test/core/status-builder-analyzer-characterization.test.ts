/**
 * Characterization tests for StatusBuilderAnalyzer
 *
 * These tests capture the CURRENT behavior of status-builder-analyzer.ts as a
 * safety net for future refactoring (Phase 2). They test through the public API
 * and exercise private methods via observable side effects.
 *
 * Organized by public method:
 *   1. StatusBuilderAnalyzer.analyzeStatusBuilder() — main analysis entry point
 *   2. StatusBuilderAnalyzer.analyzeReturnObjectWithMagicProxy() — runtime ref analysis
 *   3. StatusBuilderAnalyzer.analyzeNestedReturnObjectStructure() — recursive analysis
 *   4. StatusBuilderAnalyzer.generateStatusContextCel() — ref-to-CEL generation
 *   5. analyzeStatusBuilderForToResourceGraph() — convenience wrapper
 *
 * @see src/core/expressions/factory/status-builder-analyzer.ts
 */

import { describe, expect, it } from 'bun:test';
import {
  analyzeReturnObjectWithMagicProxy,
  analyzeStatusBuilder,
  analyzeStatusBuilderForToResourceGraph,
  generateStatusContextCel,
  StatusBuilderAnalyzer,
} from '../../src/core/expressions/factory/status-builder-analyzer.js';
import type { OptionalityContext } from '../../src/core/expressions/magic-proxy/optionality-handler.js';
import type { KubernetesRef } from '../../src/core/types/common.js';
import type { Enhanced } from '../../src/core/types/kubernetes.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a KubernetesRef-like object for generateStatusContextCel tests */
function makeRef(resourceId: string, fieldPath: string): KubernetesRef<unknown> {
  const obj: Record<string | symbol, unknown> = {};
  Object.defineProperty(obj, KUBERNETES_REF_BRAND, { value: true, enumerable: false });
  Object.defineProperty(obj, 'resourceId', { value: resourceId, enumerable: true });
  Object.defineProperty(obj, 'fieldPath', { value: fieldPath, enumerable: true });
  return obj as unknown as KubernetesRef<unknown>;
}

/** Create an OptionalityContext for testing */
function makeOptionalityContext(overrides: Partial<OptionalityContext> = {}): OptionalityContext {
  return {
    type: 'status' as const,
    availableReferences: {},
    factoryType: 'kro' as const,
    dependencies: [],
    useKroConditionals: true,
    generateHasChecks: true,
    conservativeNullSafety: true,
    ...overrides,
  };
}

/** Check that a value is a branded CelExpression */
function isCelExpr(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as any)[CEL_EXPRESSION_BRAND] === true &&
    typeof (value as any).expression === 'string'
  );
}

// ===========================================================================
// 1. StatusBuilderAnalyzer.analyzeStatusBuilder()
// ===========================================================================

describe('StatusBuilderAnalyzer.analyzeStatusBuilder()', () => {
  const analyzer = new StatusBuilderAnalyzer();

  describe('static value fields', () => {
    it('analyzes static string literal field', () => {
      const resources: Record<string, Enhanced<any, any>> = {};
      const statusBuilder = (_s: any, _r: any) => ({ phase: 'Running' });
      const result = analyzer.analyzeStatusBuilder(statusBuilder, resources);

      expect(result.valid).toBe(true);
      expect(result.statusMappings.phase).toBe('Running');
      expect(result.fieldAnalysis.size).toBe(1);

      const fieldResult = result.fieldAnalysis.get('phase')!;
      expect(fieldResult.valid).toBe(true);
      expect(fieldResult.requiresConversion).toBe(false);
      expect(fieldResult.dependencies).toHaveLength(0);
    });

    it('analyzes static number literal field', () => {
      const result = analyzer.analyzeStatusBuilder((_s: any, _r: any) => ({ count: 42 }), {});
      expect(result.valid).toBe(true);
      expect(result.statusMappings.count).toBe(42);
    });

    it('analyzes static boolean true field', () => {
      const result = analyzer.analyzeStatusBuilder((_s: any, _r: any) => ({ ready: true }), {});
      expect(result.valid).toBe(true);
      expect(result.statusMappings.ready).toBe(true);
    });

    it('analyzes static boolean false field', () => {
      const result = analyzer.analyzeStatusBuilder((_s: any, _r: any) => ({ enabled: false }), {});
      expect(result.valid).toBe(true);
      expect(result.statusMappings.enabled).toBe(false);
    });

    it('analyzes static null field', () => {
      const result = analyzer.analyzeStatusBuilder((_s: any, _r: any) => ({ value: null }), {});
      expect(result.valid).toBe(true);
      expect(result.statusMappings.value).toBeNull();
    });

    it('analyzes empty return object', () => {
      const result = analyzer.analyzeStatusBuilder((_s: any, _r: any) => ({}), {});
      expect(result.valid).toBe(true);
      expect(result.fieldAnalysis.size).toBe(0);
      expect(Object.keys(result.statusMappings)).toHaveLength(0);
    });

    it('analyzes multiple static fields', () => {
      const result = analyzer.analyzeStatusBuilder(
        (_s: any, _r: any) => ({ a: 'x', b: 1, c: true }),
        {}
      );
      expect(result.valid).toBe(true);
      expect(result.statusMappings.a).toBe('x');
      expect(result.statusMappings.b).toBe(1);
      expect(result.statusMappings.c).toBe(true);
      expect(result.fieldAnalysis.size).toBe(3);
    });

    it('analyzes static object expression', () => {
      const result = analyzer.analyzeStatusBuilder(
        (_s: any, _r: any) => ({ config: { debug: false, timeout: 30 } }),
        {}
      );
      expect(result.valid).toBe(true);
      const configField = result.fieldAnalysis.get('config');
      expect(configField).toBeDefined();
      expect(configField!.inferredType).toBe('object');
      // The static value should be captured
      expect(result.statusMappings.config).toEqual({ debug: false, timeout: 30 });
    });
  });

  describe('result structure', () => {
    it('returns all expected fields in the result', () => {
      const result = analyzer.analyzeStatusBuilder(
        (_s: any, _r: any) => ({ phase: 'Running' }),
        {}
      );

      expect(result.fieldAnalysis).toBeInstanceOf(Map);
      expect(typeof result.statusMappings).toBe('object');
      expect(Array.isArray(result.allDependencies)).toBe(true);
      expect(Array.isArray(result.resourceReferences)).toBe(true);
      expect(Array.isArray(result.schemaReferences)).toBe(true);
      expect(Array.isArray(result.sourceMap)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
      expect(typeof result.valid).toBe('boolean');
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(typeof result.originalSource).toBe('string');
    });

    it('captures the original source of the status builder function', () => {
      const fn = (_s: any, _r: any) => ({ phase: 'Running' });
      const result = analyzer.analyzeStatusBuilder(fn, {});
      expect(result.originalSource).toBe(fn.toString());
    });
  });

  describe('error handling', () => {
    it('returns valid:false when function returns non-object', () => {
      // A function that returns a string should fail
      const fn = (_s: any, _r: any) => 'hello';
      const result = analyzer.analyzeStatusBuilder(fn as any, {});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns valid:false with errors for unparseable function', () => {
      // Simulate an edge case where function source parsing fails
      // by passing a function with unusual characteristics
      const fn = Object.assign(() => {}, {
        toString: () => '<<invalid javascript>>',
      });
      const result = analyzer.analyzeStatusBuilder(fn as any, {});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('field analysis details', () => {
    it('field analysis includes confidence for static fields', () => {
      const result = analyzer.analyzeStatusBuilder(
        (_s: any, _r: any) => ({ phase: 'Running' }),
        {}
      );
      const field = result.fieldAnalysis.get('phase')!;
      expect(field.confidence).toBe(1.0);
    });

    it('field analysis includes inferredType for string literal', () => {
      const result = analyzer.analyzeStatusBuilder(
        (_s: any, _r: any) => ({ phase: 'Running' }),
        {}
      );
      const field = result.fieldAnalysis.get('phase')!;
      expect(field.inferredType).toBe('string');
    });

    it('field analysis includes inferredType for number literal', () => {
      const result = analyzer.analyzeStatusBuilder((_s: any, _r: any) => ({ count: 42 }), {});
      const field = result.fieldAnalysis.get('count')!;
      expect(field.inferredType).toBe('number');
    });

    it('field analysis includes inferredType for boolean literal', () => {
      const result = analyzer.analyzeStatusBuilder((_s: any, _r: any) => ({ ready: true }), {});
      const field = result.fieldAnalysis.get('ready')!;
      expect(field.inferredType).toBe('boolean');
    });
  });
});

// ===========================================================================
// 2. StatusBuilderAnalyzer.analyzeReturnObjectWithMagicProxy()
// ===========================================================================

describe('StatusBuilderAnalyzer.analyzeReturnObjectWithMagicProxy()', () => {
  const analyzer = new StatusBuilderAnalyzer();

  describe('static values', () => {
    it('converts string value to CEL string literal', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy({ phase: 'Running' }, {});
      expect(result.errors).toHaveLength(0);
      expect(isCelExpr(result.statusMappings.phase)).toBe(true);
      expect(result.statusMappings.phase.expression).toBe('"Running"');
    });

    it('converts number value to CEL number literal', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy({ count: 42 }, {});
      expect(result.statusMappings.count.expression).toBe('42');
    });

    it('converts boolean value to CEL boolean literal', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy({ ready: true }, {});
      expect(result.statusMappings.ready.expression).toBe('true');
    });

    it('converts null to CEL null', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy({ val: null }, {});
      expect(result.statusMappings.val.expression).toBe('null');
    });

    it('converts array to CEL array literal', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy({ items: [1, 2, 3] }, {});
      expect(result.statusMappings.items.expression).toBe('[1, 2, 3]');
    });

    it('converts nested object to CEL object literal', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy({ cfg: { a: 1 } }, {});
      expect(result.statusMappings.cfg.expression).toBe('{"a": 1}');
    });

    it('returns empty results for empty object', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy({}, {});
      expect(Object.keys(result.statusMappings)).toHaveLength(0);
      expect(result.dependencies).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('returns error for null input', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy(null, {});
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns error for string input', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy('hello', {});
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns error for undefined input', () => {
      const result = analyzer.analyzeReturnObjectWithMagicProxy(undefined, {});
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

// ===========================================================================
// 3. StatusBuilderAnalyzer.analyzeNestedReturnObjectStructure()
// ===========================================================================

describe('StatusBuilderAnalyzer.analyzeNestedReturnObjectStructure()', () => {
  const analyzer = new StatusBuilderAnalyzer();

  it('flattens flat objects with dot-separated paths', () => {
    const result = analyzer.analyzeNestedReturnObjectStructure({ phase: 'Running', count: 42 }, {});
    expect(result.structureErrors).toHaveLength(0);
    expect(result.flattenedMappings.phase).toBeDefined();
    expect(result.flattenedMappings.phase.expression).toBe('"Running"');
    expect(result.flattenedMappings.count.expression).toBe('42');
  });

  it('flattens one-level nested objects', () => {
    const result = analyzer.analyzeNestedReturnObjectStructure({ health: { ready: true } }, {});
    expect(result.flattenedMappings['health.ready']).toBeDefined();
    expect(result.flattenedMappings['health.ready'].expression).toBe('true');
  });

  it('flattens deeply nested objects with multi-level paths', () => {
    const result = analyzer.analyzeNestedReturnObjectStructure({ a: { b: { c: 42 } } }, {});
    expect(result.flattenedMappings['a.b.c']).toBeDefined();
    expect(result.flattenedMappings['a.b.c'].expression).toBe('42');
  });

  it('returns error when depth exceeds maxDepth', () => {
    const deepAnalyzer = new StatusBuilderAnalyzer(undefined, { maxDepth: 0 });
    const result = deepAnalyzer.analyzeNestedReturnObjectStructure(
      { a: { b: 1 } },
      {},
      undefined,
      1 // Start at depth 1, which exceeds maxDepth 0
    );
    expect(result.structureErrors.length).toBeGreaterThan(0);
  });

  it('returns empty results for null input', () => {
    const result = analyzer.analyzeNestedReturnObjectStructure(null, {});
    expect(Object.keys(result.flattenedMappings)).toHaveLength(0);
    expect(result.structureErrors).toHaveLength(0);
  });

  it('returns empty results for array input', () => {
    const result = analyzer.analyzeNestedReturnObjectStructure([1, 2, 3], {});
    expect(Object.keys(result.flattenedMappings)).toHaveLength(0);
  });
});

// ===========================================================================
// 4. StatusBuilderAnalyzer.generateStatusContextCel()
// ===========================================================================

describe('StatusBuilderAnalyzer.generateStatusContextCel()', () => {
  const analyzer = new StatusBuilderAnalyzer();

  describe('schema references', () => {
    it('generates schema-prefixed CEL for __schema__ refs', () => {
      const ref = makeRef('__schema__', 'spec.name');
      const context = makeOptionalityContext();
      const result = analyzer.generateStatusContextCel(ref, context);

      expect(isCelExpr(result)).toBe(true);
      expect(result.expression).toContain('schema.spec.name');
    });

    it('schema spec fields are not hydration-required', () => {
      const ref = makeRef('__schema__', 'spec.name');
      const context = makeOptionalityContext();
      const result = analyzer.generateStatusContextCel(ref, context);

      // Schema refs should have direct-access strategy (not hydration)
      expect((result as any).metadata?.requiresHydration).toBe(false);
    });
  });

  describe('resource status references', () => {
    it('generates resource-prefixed CEL for resource status refs', () => {
      const ref = makeRef('myDeployment', 'status.readyReplicas');
      const context = makeOptionalityContext();
      const result = analyzer.generateStatusContextCel(ref, context);

      expect(isCelExpr(result)).toBe(true);
      expect(result.expression).toContain('myDeployment');
      expect(result.expression).toContain('readyReplicas');
    });

    it('applies null-safety with Kro conditionals (?.)', () => {
      const ref = makeRef('myDeployment', 'status.readyReplicas');
      const context = makeOptionalityContext({
        useKroConditionals: true,
        generateHasChecks: false,
      });
      const result = analyzer.generateStatusContextCel(ref, context);

      // Status fields with kro conditionals should use ?. for null safety
      expect(result.expression).toContain('?.');
    });

    it('applies has() checks when generateHasChecks is true and kro conditionals disabled', () => {
      const ref = makeRef('myDeployment', 'status.readyReplicas');
      const context = makeOptionalityContext({
        useKroConditionals: false,
        generateHasChecks: true,
      });
      const result = analyzer.generateStatusContextCel(ref, context);

      expect(result.expression).toContain('has(');
    });

    it('uses plain expression when both safety mechanisms are disabled', () => {
      const ref = makeRef('myDeployment', 'status.readyReplicas');
      const context = makeOptionalityContext({
        useKroConditionals: false,
        generateHasChecks: false,
      });
      const result = analyzer.generateStatusContextCel(ref, context);

      expect(result.expression).toBe('resources.myDeployment.status.readyReplicas');
    });
  });

  describe('field type inference', () => {
    it('infers boolean type for readyReplicas (ready keyword takes precedence over replicas)', () => {
      // Note: inferStatusFieldType checks 'ready' before 'replicas', so
      // 'status.readyReplicas' matches 'ready' first and returns 'boolean'
      const ref = makeRef('deploy', 'status.readyReplicas');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any).type).toBe('boolean');
    });

    it('infers number type for replicas-only fields', () => {
      const ref = makeRef('deploy', 'status.replicas');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any).type).toBe('number');
    });

    it('infers boolean type for ready fields', () => {
      const ref = makeRef('deploy', 'status.ready');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any).type).toBe('boolean');
    });

    it('infers array type for conditions fields', () => {
      const ref = makeRef('deploy', 'status.conditions');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any).type).toBe('array');
    });

    it('infers string type for phase fields', () => {
      const ref = makeRef('deploy', 'status.phase');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any).type).toBe('string');
    });

    it('infers string type for IP fields', () => {
      const ref = makeRef('svc', 'status.loadBalancer.ingress.ip');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any).type).toBe('string');
    });
  });

  describe('field availability estimation (via metadata)', () => {
    it('schema references have immediate availability', () => {
      const ref = makeRef('__schema__', 'spec.name');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any).metadata?.isStatusContext).toBe(true);
    });

    it('resource status references require hydration', () => {
      const ref = makeRef('deploy', 'status.readyReplicas');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any).metadata?.requiresHydration).toBe(true);
    });

    it('resource spec references do not require hydration', () => {
      const ref = makeRef('deploy', 'spec.replicas');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any).metadata?.requiresHydration).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles empty field path', () => {
      const ref = makeRef('deploy', '');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect(isCelExpr(result)).toBe(true);
      expect(result.expression).toContain('resources.deploy');
    });

    it('returns CelExpression-branded result', () => {
      const ref = makeRef('deploy', 'status.ready');
      const result = analyzer.generateStatusContextCel(ref, makeOptionalityContext());
      expect((result as any)[CEL_EXPRESSION_BRAND]).toBe(true);
    });
  });
});

// ===========================================================================
// 5. analyzeStatusBuilderForToResourceGraph() (convenience function)
// ===========================================================================

describe('analyzeStatusBuilderForToResourceGraph()', () => {
  it('returns all expected fields', () => {
    const result = analyzeStatusBuilderForToResourceGraph(
      (_s: any, _r: any) => ({ phase: 'Running' }),
      {}
    );

    expect(typeof result.statusMappings).toBe('object');
    expect(Array.isArray(result.dependencies)).toBe(true);
    expect(Array.isArray(result.hydrationOrder)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(typeof result.valid).toBe('boolean');
    expect(typeof result.requiresConversion).toBe('boolean');
  });

  it('reports requiresConversion=false for static-only builders', () => {
    const result = analyzeStatusBuilderForToResourceGraph(
      (_s: any, _r: any) => ({ phase: 'Running', count: 42 }),
      {}
    );
    expect(result.requiresConversion).toBe(false);
  });

  it('returns hydrationOrder array', () => {
    const result = analyzeStatusBuilderForToResourceGraph(
      (_s: any, _r: any) => ({ a: 'x', b: 'y' }),
      {}
    );
    expect(Array.isArray(result.hydrationOrder)).toBe(true);
    expect(result.hydrationOrder).toContain('a');
    expect(result.hydrationOrder).toContain('b');
  });

  it('accepts factoryType parameter', () => {
    const resultKro = analyzeStatusBuilderForToResourceGraph(
      (_s: any, _r: any) => ({ phase: 'Running' }),
      {},
      undefined,
      'kro'
    );
    const resultDirect = analyzeStatusBuilderForToResourceGraph(
      (_s: any, _r: any) => ({ phase: 'Running' }),
      {},
      undefined,
      'direct'
    );

    // Both should be valid
    expect(resultKro.valid).toBe(true);
    expect(resultDirect.valid).toBe(true);
  });

  it('returns valid=false for non-object returning builder', () => {
    const result = analyzeStatusBuilderForToResourceGraph(
      (_s: any, _r: any) => 'not-an-object' as any,
      {}
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 6. analyzeStatusBuilder() convenience function
// ===========================================================================

describe('analyzeStatusBuilder() convenience function', () => {
  it('returns StatusBuilderAnalysisResult structure', () => {
    const result = analyzeStatusBuilder((_s: any, _r: any) => ({ phase: 'Running' }), {});

    expect(result.fieldAnalysis).toBeInstanceOf(Map);
    expect(typeof result.statusMappings).toBe('object');
    expect(Array.isArray(result.allDependencies)).toBe(true);
    expect(typeof result.valid).toBe('boolean');
  });

  it('passes options through to analyzer', () => {
    const result = analyzeStatusBuilder(
      (_s: any, _r: any) => ({ phase: 'Running' }),
      {},
      undefined,
      { deepAnalysis: false, performOptionalityAnalysis: false }
    );

    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// 7. analyzeReturnObjectWithMagicProxy() convenience function
// ===========================================================================

describe('analyzeReturnObjectWithMagicProxy() convenience function', () => {
  it('converts static object fields to CelExpressions', () => {
    const result = analyzeReturnObjectWithMagicProxy({ phase: 'Running' }, {});

    expect(result.errors).toHaveLength(0);
    expect(isCelExpr(result.statusMappings.phase)).toBe(true);
    expect(result.statusMappings.phase.expression).toBe('"Running"');
  });

  it('returns empty results for empty object', () => {
    const result = analyzeReturnObjectWithMagicProxy({}, {});
    expect(Object.keys(result.statusMappings)).toHaveLength(0);
    expect(result.dependencies).toHaveLength(0);
  });
});

// ===========================================================================
// 8. generateStatusContextCel() convenience function
// ===========================================================================

describe('generateStatusContextCel() convenience function', () => {
  it('generates CEL with schema prefix for schema refs', () => {
    const ref = makeRef('__schema__', 'spec.name');
    const result = generateStatusContextCel(ref, makeOptionalityContext());
    expect(isCelExpr(result)).toBe(true);
    expect(result.expression).toContain('schema.spec.name');
  });

  it('generates CEL with resources prefix for resource refs', () => {
    const ref = makeRef('myDeployment', 'status.readyReplicas');
    const result = generateStatusContextCel(ref, makeOptionalityContext());
    expect(isCelExpr(result)).toBe(true);
    // With kro conditionals enabled, ?. is applied: resources?.myDeployment?.status?.readyReplicas
    expect(result.expression).toContain('myDeployment');
    expect(result.expression).toContain('readyReplicas');
  });
});
