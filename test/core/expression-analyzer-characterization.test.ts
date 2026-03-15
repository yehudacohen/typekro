/**
 * Characterization tests for CompositionExpressionAnalyzer
 *
 * These tests capture the CURRENT behavior of the expression analyzer,
 * including pattern detection, composition analysis, status building,
 * scope validation quirks, and pattern compatibility.
 *
 * KEY QUIRKS:
 * - detectCompositionPattern returns 'imperative' when AsyncLocalStorage
 *   has a context, regardless of function body.
 * - validateStatusShape always reports scope errors for non-__schema__
 *   KubernetesRefs because the internal MagicProxyScopeManager has no
 *   active scope (enterScope is never called externally).
 * - processCompositionByPattern always calls processCompositionStatus
 *   because both built-in configs have convertTocel: true.
 *
 * Source: src/core/expressions/composition/expression-analyzer.ts (618 lines)
 */

import { describe, expect, it } from 'bun:test';
import {
  createCompositionContext,
  runWithCompositionContext,
} from '../../src/core/composition/context.js';
import { CompositionExecutionError } from '../../src/core/errors.js';
import type { CompositionAnalysisResult } from '../../src/core/expressions/composition/expression-analyzer.js';
import { CompositionExpressionAnalyzer } from '../../src/core/expressions/composition/expression-analyzer.js';
import type { KubernetesRef } from '../../src/core/types/common.js';
import type { Enhanced } from '../../src/core/types/kubernetes.js';
import type {
  KroCompatibleType,
  MagicAssignableShape,
  SchemaProxy,
} from '../../src/core/types/serialization.js';
import { KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

/** Minimal schema proxy stub accepted by all analyzer methods. */
type TestSpec = Record<string, unknown>;
type TestStatus = Record<string, unknown>;
function mockSchemaProxy(): SchemaProxy<TestSpec, TestStatus> {
  return { spec: {} } as SchemaProxy<TestSpec, TestStatus>;
}

/** Strongly-typed KubernetesRef factory. */
function ref(resourceId: string, fieldPath: string): KubernetesRef<unknown> {
  return {
    [KUBERNETES_REF_BRAND]: true as const,
    resourceId,
    fieldPath,
  };
}

/** Cast a plain object to Enhanced for test mocking (the real type is a complex intersection). */
function mockEnhanced(obj: Record<string, unknown>): Enhanced<unknown, unknown> {
  return obj as Enhanced<unknown, unknown>;
}

/** Cast a plain object to MagicAssignableShape for status shape tests. */
function mockShape(obj: Record<string, unknown>): MagicAssignableShape<TestStatus> {
  return obj as MagicAssignableShape<TestStatus>;
}

/** Build a typed analysis result for getPatternRecommendations tests. */
function mockAnalysisResult(
  overrides: Partial<CompositionAnalysisResult<KroCompatibleType>> = {}
): CompositionAnalysisResult<KroCompatibleType> {
  return {
    statusShape: {} as MagicAssignableShape<KroCompatibleType>,
    kubernetesRefs: [],
    referencedResources: [],
    requiresCelConversion: false,
    conversionMetadata: {
      expressionsAnalyzed: 0,
      kubernetesRefsDetected: 0,
      celExpressionsGenerated: 0,
    },
    ...overrides,
  };
}

describe('CompositionExpressionAnalyzer', () => {
  describe('detectCompositionPattern', () => {
    it('returns declarative for simple arrow functions with no pattern keywords', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const fn = () => ({});

      const pattern = analyzer.detectCompositionPattern(fn);

      expect(pattern).toBe('declarative');
    });

    it('returns imperative for functions containing .addX( pattern', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const fn = { toString: () => 'function() { builder.addDeployment() }' };

      const pattern = analyzer.detectCompositionPattern(fn);

      expect(pattern).toBe('imperative');
    });

    it('returns imperative for functions containing registerX( pattern', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const fn = { toString: () => 'function() { registerResource() }' };

      const pattern = analyzer.detectCompositionPattern(fn);

      expect(pattern).toBe('imperative');
    });

    it('returns imperative for functions containing createX( pattern', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const fn = { toString: () => 'function() { createDeployment() }' };

      const pattern = analyzer.detectCompositionPattern(fn);

      expect(pattern).toBe('imperative');
    });

    it('returns imperative for functions containing simpleX( pattern', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const fn = { toString: () => 'function() { simpleDeployment() }' };

      const pattern = analyzer.detectCompositionPattern(fn);

      expect(pattern).toBe('imperative');
    });

    it('returns declarative for .add( without following word chars', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      // .add( does not match /.add\w+\(/ — needs at least one \w after "add"
      const fn = { toString: () => 'function() { builder.add() }' };

      const pattern = analyzer.detectCompositionPattern(fn);

      expect(pattern).toBe('declarative');
    });

    it('returns imperative when context parameter is provided', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const fn = () => ({});
      const ctx = createCompositionContext('test');

      const pattern = analyzer.detectCompositionPattern(fn, ctx);

      expect(pattern).toBe('imperative');
    });

    it('returns imperative when called inside runWithCompositionContext', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const fn = () => ({});
      const ctx = createCompositionContext('test');

      const pattern = runWithCompositionContext(ctx, () => {
        return analyzer.detectCompositionPattern(fn);
      });

      expect(pattern).toBe('imperative');
    });
  });

  describe('analyzeCompositionFunction', () => {
    it('analyzes a simple composition with no refs', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const compositionFn = (_spec: TestSpec) => ({ phase: 'ready' });

      const result = analyzer.analyzeCompositionFunction(compositionFn, schemaProxy);

      expect(result.statusShape).toBeDefined();
      expect(result.requiresCelConversion).toBe(false);
      expect(result.kubernetesRefs).toHaveLength(0);
    });

    it('detects KubernetesRef objects in status shape', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const testRef = ref('deploy', 'status.readyReplicas');
      const compositionFn = (_spec: TestSpec) => ({
        replicas: testRef,
      });

      const result = analyzer.analyzeCompositionFunction(compositionFn, schemaProxy);

      expect(result.kubernetesRefs.length).toBeGreaterThanOrEqual(1);
      expect(result.requiresCelConversion).toBe(true);
    });

    it('extracts referenced resources from context', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const ctx = createCompositionContext('test');
      ctx.addResource('myDeploy', mockEnhanced({ metadata: { name: 'test' } }));

      const compositionFn = (_spec: TestSpec) => ({ phase: 'ready' });
      const result = analyzer.analyzeCompositionFunction(compositionFn, schemaProxy, ctx);

      expect(result.referencedResources).toContain('myDeploy');
    });

    it('throws CompositionExecutionError when composition function throws', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const compositionFn = (_spec: TestSpec) => {
        throw new Error('boom');
      };

      expect(() => analyzer.analyzeCompositionFunction(compositionFn, schemaProxy)).toThrow(
        CompositionExecutionError
      );
    });

    it('includes conversionMetadata in result', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const compositionFn = (_spec: TestSpec) => ({ phase: 'ready' });

      const result = analyzer.analyzeCompositionFunction(compositionFn, schemaProxy);

      expect(result.conversionMetadata).toBeDefined();
      expect(typeof result.conversionMetadata.expressionsAnalyzed).toBe('number');
      expect(typeof result.conversionMetadata.kubernetesRefsDetected).toBe('number');
      expect(typeof result.conversionMetadata.celExpressionsGenerated).toBe('number');
    });
  });

  describe('analyzeCompositionFunctionWithPattern', () => {
    it('detects pattern automatically when not provided', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const compositionFn = (_spec: TestSpec) => ({ phase: 'ready' });

      const result = analyzer.analyzeCompositionFunctionWithPattern(compositionFn, schemaProxy);

      expect(result.pattern).toBe('declarative');
      expect(result.patternSpecificMetadata).toBeDefined();
    });

    it('uses explicit pattern when provided', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const compositionFn = (_spec: TestSpec) => ({ phase: 'ready' });

      const result = analyzer.analyzeCompositionFunctionWithPattern(
        compositionFn,
        schemaProxy,
        'imperative'
      );

      expect(result.pattern).toBe('imperative');
    });

    it('tracks resource creation for imperative pattern with context', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const ctx = createCompositionContext('test');
      const compositionFn = (_spec: TestSpec) => ({ phase: 'ready' });

      const result = analyzer.analyzeCompositionFunctionWithPattern(
        compositionFn,
        schemaProxy,
        'imperative',
        ctx
      );

      expect(result.patternSpecificMetadata.resourceCreationTracked).toBe(true);
      expect(result.patternSpecificMetadata.scopeValidationPerformed).toBe(true);
    });

    it('does not track resource creation for declarative pattern', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const compositionFn = (_spec: TestSpec) => ({ phase: 'ready' });

      const result = analyzer.analyzeCompositionFunctionWithPattern(
        compositionFn,
        schemaProxy,
        'declarative'
      );

      expect(result.patternSpecificMetadata.resourceCreationTracked).toBe(false);
      expect(result.patternSpecificMetadata.scopeValidationPerformed).toBe(false);
      expect(result.patternSpecificMetadata.sideEffectsDetected).toBe(false);
    });

    it('imperative without context falls through to non-tracking branch', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const compositionFn = (_spec: TestSpec) => ({ phase: 'ready' });

      // No context provided — even though pattern is imperative, trackResourceCreation
      // requires context to be truthy
      const result = analyzer.analyzeCompositionFunctionWithPattern(
        compositionFn,
        schemaProxy,
        'imperative'
      );

      expect(result.patternSpecificMetadata.resourceCreationTracked).toBe(false);
    });
  });

  describe('analyzeResourceCreation', () => {
    it('returns empty when no context is available', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const compositionFn = (_spec: TestSpec) => ({});

      const result = analyzer.analyzeResourceCreation(compositionFn, schemaProxy);

      expect(result.resourcesCreated).toEqual([]);
      expect(result.kubernetesRefsInResources).toEqual([]);
      expect(result.requiresCelConversion).toBe(false);
    });

    it('detects resources added during composition function execution', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const ctx = createCompositionContext('test');

      const compositionFn = (_spec: TestSpec) => {
        // Simulate adding a resource during composition
        ctx.addResource('newDeploy', mockEnhanced({ metadata: { name: 'new' } }));
        return {};
      };

      const result = analyzer.analyzeResourceCreation(compositionFn, schemaProxy, ctx);

      expect(result.resourcesCreated).toContain('newDeploy');
    });

    it('throws CompositionExecutionError when composition function throws', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaProxy = mockSchemaProxy();
      const ctx = createCompositionContext('test');
      const compositionFn = (_spec: TestSpec) => {
        throw new Error('creation failed');
      };

      expect(() => analyzer.analyzeResourceCreation(compositionFn, schemaProxy, ctx)).toThrow(
        CompositionExecutionError
      );
    });
  });

  describe('processCompositionStatus', () => {
    it('returns status shape unchanged for direct factory type', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const shape = mockShape({ phase: 'ready', count: 42 });

      const result = analyzer.processCompositionStatus(shape, 'direct');

      expect(result).toBe(shape);
    });

    it('processes status shape for kro factory type', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const shape = mockShape({ phase: 'ready' });

      const result = analyzer.processCompositionStatus(shape, 'kro');

      // Should return a processed shape (may or may not equal original)
      expect(result).toBeDefined();
    });

    it('defaults to kro factory type', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const shape = mockShape({ phase: 'ready' });

      // No factory type specified — defaults to 'kro'
      const result = analyzer.processCompositionStatus(shape);

      expect(result).toBeDefined();
    });
  });

  describe('processCompositionByPattern', () => {
    it('delegates to processCompositionStatus for imperative (convertTocel: true)', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const shape = mockShape({ phase: 'ready' });

      // Both patterns have convertTocel: true, so this always processes
      const result = analyzer.processCompositionByPattern(shape, 'imperative');

      expect(result).toBeDefined();
    });

    it('delegates to processCompositionStatus for declarative (convertTocel: true)', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const shape = mockShape({ phase: 'ready' });

      const result = analyzer.processCompositionByPattern(shape, 'declarative');

      expect(result).toBeDefined();
    });

    it('defaults to kro factory type', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const shape = mockShape({ simple: 'value' });

      // Should not throw — defaults to kro
      const result = analyzer.processCompositionByPattern(shape, 'declarative');

      expect(result).toBeDefined();
    });
  });

  describe('buildCompositionStatus', () => {
    it('returns comprehensive result with metadata', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const ctx = createCompositionContext('test');
      const shape = mockShape({ phase: 'ready' });

      const result = analyzer.buildCompositionStatus(shape, ctx);

      expect(result.processedStatus).toBeDefined();
      expect(result.kubernetesRefs).toBeDefined();
      expect(result.dependencies).toBeDefined();
      expect(result.conversionMetadata).toBeDefined();
      expect(typeof result.conversionMetadata.fieldsProcessed).toBe('number');
      expect(typeof result.conversionMetadata.kubernetesRefsFound).toBe('number');
      expect(typeof result.conversionMetadata.celExpressionsGenerated).toBe('number');
      expect(typeof result.conversionMetadata.crossResourceReferences).toBe('number');
    });

    it('excludes __schema__ refs from dependencies', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const ctx = createCompositionContext('test');
      const schemaRef = ref('__schema__', 'spec.name');
      const shape = mockShape({ name: schemaRef });

      const result = analyzer.buildCompositionStatus(shape, ctx);

      // __schema__ should NOT appear in dependencies
      expect(result.dependencies).not.toContain('__schema__');
    });

    it('returns shape unchanged for direct factory type', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const ctx = createCompositionContext('test');
      const shape = mockShape({ phase: 'ready' });

      const result = analyzer.buildCompositionStatus(shape, ctx, 'direct');

      expect(result.processedStatus).toBe(shape);
      expect(result.conversionMetadata.celExpressionsGenerated).toBe(0);
    });
  });

  describe('validateStatusShape', () => {
    it('returns valid for shapes with no KubernetesRefs', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const shape = mockShape({ phase: 'ready', count: 42 });

      const result = analyzer.validateStatusShape(shape);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('reports scope errors for non-schema KubernetesRefs (scope manager has no active scope)', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const testRef = ref('deploy', 'status.readyReplicas');
      const shape = mockShape({ replicas: testRef });

      const result = analyzer.validateStatusShape(shape);

      // The internal MagicProxyScopeManager has no enterScope() called,
      // so validateKubernetesRefScope always fails for non-__schema__ refs
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.isValid).toBe(false);
    });

    it('__schema__ refs also fail scope validation (scope manager does not special-case them)', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const schemaRef = ref('__schema__', 'spec.name');
      const shape = mockShape({ name: schemaRef });

      const result = analyzer.validateStatusShape(shape);

      // Even __schema__ refs fail — the scope manager has no active scope at all
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.isValid).toBe(false);
    });

    it('adds warnings for missing resources in context', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const testRef = ref('missingDeploy', 'status.phase');
      const shape = mockShape({ phase: testRef });
      const ctx = createCompositionContext('test');

      const result = analyzer.validateStatusShape(shape, ctx);

      // Should have warning about missingDeploy not being in context.resources
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('getter that throws is handled gracefully by analyzeMagicAssignableShape', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      // A getter that throws — the underlying analysis swallows it
      const badShape = mockShape(
        Object.create(null, {
          phase: {
            get() {
              throw new Error('getter exploded');
            },
            enumerable: true,
          },
        })
      );

      const result = analyzer.validateStatusShape(badShape);

      // analyzeMagicAssignableShape handles this gracefully → no errors
      expect(result.errors).toHaveLength(0);
      expect(result.isValid).toBe(true);
    });
  });

  describe('validatePatternCompatibility', () => {
    it('imperative + direct + no context → warnings', () => {
      const analyzer = new CompositionExpressionAnalyzer();

      const result = analyzer.validatePatternCompatibility('imperative', 'direct');

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.isCompatible).toBe(true);
    });

    it('imperative + kro → no warnings', () => {
      const analyzer = new CompositionExpressionAnalyzer();

      const result = analyzer.validatePatternCompatibility('imperative', 'kro');

      expect(result.isCompatible).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('declarative + kro → no warnings', () => {
      const analyzer = new CompositionExpressionAnalyzer();

      const result = analyzer.validatePatternCompatibility('declarative', 'kro');

      expect(result.isCompatible).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('imperative + direct + context → no warnings (context present)', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const ctx = createCompositionContext('test');

      const result = analyzer.validatePatternCompatibility('imperative', 'direct', ctx);

      // With context provided, the imperative+direct warning does not trigger
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('getPatternRecommendations', () => {
    it('recommends declarative when imperative has no refs', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const analysisResult = mockAnalysisResult();

      const recommendations = analyzer.getPatternRecommendations('imperative', analysisResult);

      expect(recommendations.length).toBeGreaterThan(0);
    });

    it('recommends breaking up when imperative has >10 referenced resources', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const analysisResult = mockAnalysisResult({
        kubernetesRefs: [ref('a', 'status.x')],
        referencedResources: Array.from({ length: 11 }, (_, i) => `res${i}`),
        requiresCelConversion: true,
        conversionMetadata: {
          expressionsAnalyzed: 11,
          kubernetesRefsDetected: 1,
          celExpressionsGenerated: 11,
        },
      });

      const recommendations = analyzer.getPatternRecommendations('imperative', analysisResult);

      expect(recommendations.some((r) => r.includes('breaking'))).toBe(true);
    });

    it('recommends imperative when declarative has refs', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const analysisResult = mockAnalysisResult({
        kubernetesRefs: [ref('deploy', 'status.phase')],
        referencedResources: ['deploy'],
        requiresCelConversion: true,
        conversionMetadata: {
          expressionsAnalyzed: 1,
          kubernetesRefsDetected: 1,
          celExpressionsGenerated: 1,
        },
      });

      const recommendations = analyzer.getPatternRecommendations('declarative', analysisResult);

      expect(recommendations.length).toBeGreaterThan(0);
    });

    it('returns no recommendations for declarative with no refs', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const analysisResult = mockAnalysisResult();

      const recommendations = analyzer.getPatternRecommendations('declarative', analysisResult);

      expect(recommendations).toHaveLength(0);
    });
  });

  describe('extractKubernetesRefsFromResource', () => {
    it('extracts branded KubernetesRef objects from resource', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const testRef = ref('deploy', 'status.phase');
      const resource = mockEnhanced({
        status: {
          phase: testRef,
        },
      });

      const refs = analyzer.extractKubernetesRefsFromResource(resource);

      expect(refs.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array for resource with no refs', () => {
      const analyzer = new CompositionExpressionAnalyzer();
      const resource = mockEnhanced({
        metadata: { name: 'test' },
        status: { phase: 'Running' },
      });

      const refs = analyzer.extractKubernetesRefsFromResource(resource);

      expect(refs).toEqual([]);
    });

    it('handles null/undefined resource gracefully', () => {
      const analyzer = new CompositionExpressionAnalyzer();

      // biome-ignore lint/suspicious/noExplicitAny: intentionally testing null input for graceful handling
      const refs = analyzer.extractKubernetesRefsFromResource(null as any);

      expect(refs).toEqual([]);
    });
  });
});
