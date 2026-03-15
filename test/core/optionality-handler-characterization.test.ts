/**
 * Characterization tests for EnhancedTypeOptionalityHandler
 *
 * These tests capture the CURRENT behavior of optionality-handler.ts as a
 * safety net for future refactoring (Phase 2). They test through the public API
 * and exercise private methods via observable side effects.
 *
 * Organized by public method:
 *   1. analyzeOptionalityRequirements() — optionality detection for KubernetesRefs
 *   2. generateNullSafeCelExpression() — null-safe CEL generation
 *   3. handleOptionalChainingWithEnhancedTypes() — optional chaining support
 *   4. detectNullSafetyRequirements() — Enhanced resource null-safety detection
 *   5. generateCelWithHasChecks() — has() check CEL generation
 *   6. integrateWithFieldHydrationTiming() — hydration-aware expressions
 *   7. handleUndefinedToDefinedTransitions() — transition handling
 *
 * @see src/core/expressions/magic-proxy/optionality-handler.ts
 */

import { describe, expect, it } from 'bun:test';
import {
  EnhancedTypeOptionalityHandler,
  type OptionalityAnalysisResult,
  type OptionalityContext,
} from '../../src/core/expressions/magic-proxy/optionality-handler.js';
import type { FieldHydrationState } from '../../src/core/expressions/magic-proxy/optionality-types.js';
import { createResource } from '../../src/core/proxy/create-resource.js';
import type { Enhanced } from '../../src/core/types/kubernetes.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';
import { isKubernetesRef } from '../../src/utils/type-guards.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a KubernetesRef-like object */
function makeRef(resourceId: string, fieldPath: string): any {
  const fn = () => {};
  Object.defineProperty(fn, KUBERNETES_REF_BRAND, { value: true });
  Object.defineProperty(fn, 'resourceId', { value: resourceId });
  Object.defineProperty(fn, 'fieldPath', { value: fieldPath });
  return fn;
}

/** Create an OptionalityContext for testing */
function makeContext(overrides: Partial<OptionalityContext> = {}): OptionalityContext {
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

/** Create an Enhanced resource for testing */
function makeEnhanced(kind = 'Deployment', name = 'test-app'): Enhanced<any, any> {
  return createResource({
    apiVersion: 'apps/v1',
    kind,
    metadata: { name },
    spec: { replicas: 3, image: 'nginx' } as any,
    status: { readyReplicas: 3 } as any,
  });
}

/** Check if value has CEL expression brand */
function isCelExpr(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as any)[CEL_EXPRESSION_BRAND] === true &&
    typeof (value as any).expression === 'string'
  );
}

// ===========================================================================
// 1. analyzeOptionalityRequirements()
// ===========================================================================

describe('EnhancedTypeOptionalityHandler.analyzeOptionalityRequirements()', () => {
  const handler = new EnhancedTypeOptionalityHandler();

  it('returns empty array for non-ref expression', () => {
    const results = handler.analyzeOptionalityRequirements('hello', makeContext());
    expect(results).toHaveLength(0);
  });

  it('returns empty array for null expression', () => {
    const results = handler.analyzeOptionalityRequirements(null, makeContext());
    expect(results).toHaveLength(0);
  });

  it('analyzes a single KubernetesRef for status field', () => {
    const ref = makeRef('myDeploy', 'status.readyReplicas');
    const results = handler.analyzeOptionalityRequirements(ref, makeContext());

    expect(results.length).toBeGreaterThanOrEqual(1);
    const first = results[0]!;
    expect(first.resourceId).toBe('myDeploy');
    expect(first.fieldPath).toBe('status.readyReplicas');
    expect(first.potentiallyUndefined).toBe(true);
    expect(first.isSchemaReference).toBe(false);
  });

  it('marks status fields as requiring null safety with conservative mode', () => {
    const ref = makeRef('deploy', 'status.conditions');
    const results = handler.analyzeOptionalityRequirements(
      ref,
      makeContext({ conservativeNullSafety: true })
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.requiresNullSafety).toBe(true);
  });

  it('marks schema references as schema references', () => {
    const ref = makeRef('__schema__', 'spec.name');
    const results = handler.analyzeOptionalityRequirements(ref, makeContext());

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.isSchemaReference).toBe(true);
  });

  it('provides a reason for the optionality determination', () => {
    const ref = makeRef('deploy', 'status.phase');
    const results = handler.analyzeOptionalityRequirements(ref, makeContext());

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.reason).toBeDefined();
    expect(typeof results[0]!.reason).toBe('string');
    expect(results[0]!.reason!.length).toBeGreaterThan(0);
  });

  it('provides confidence value between 0 and 1', () => {
    const ref = makeRef('deploy', 'status.phase');
    const results = handler.analyzeOptionalityRequirements(ref, makeContext());

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.confidence).toBeGreaterThanOrEqual(0);
    expect(results[0]!.confidence).toBeLessThanOrEqual(1);
  });

  it('generates suggestedCelPattern when null safety is required', () => {
    const ref = makeRef('deploy', 'status.readyReplicas');
    const results = handler.analyzeOptionalityRequirements(
      ref,
      makeContext({ conservativeNullSafety: true })
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    if (results[0]!.requiresNullSafety) {
      expect(results[0]!.suggestedCelPattern).toBeDefined();
      expect(typeof results[0]!.suggestedCelPattern).toBe('string');
    }
  });

  it('core metadata fields (name, uid) are not potentially undefined', () => {
    const ref = makeRef('deploy', 'metadata.name');
    const results = handler.analyzeOptionalityRequirements(
      ref,
      makeContext({ conservativeNullSafety: false })
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.potentiallyUndefined).toBe(false);
  });

  it('optional metadata fields (labels) are potentially undefined', () => {
    const ref = makeRef('deploy', 'metadata.labels');
    const results = handler.analyzeOptionalityRequirements(ref, makeContext());

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.potentiallyUndefined).toBe(true);
  });

  it('optional spec fields (replicas) are potentially undefined', () => {
    const ref = makeRef('deploy', 'spec.replicas');
    const results = handler.analyzeOptionalityRequirements(ref, makeContext());

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.potentiallyUndefined).toBe(true);
  });
});

// ===========================================================================
// 2. generateNullSafeCelExpression()
// ===========================================================================

describe('EnhancedTypeOptionalityHandler.generateNullSafeCelExpression()', () => {
  const handler = new EnhancedTypeOptionalityHandler();

  it('returns valid result when no null-safety is required', () => {
    const ref = makeRef('__schema__', 'spec.name');
    const optionalityResults: OptionalityAnalysisResult[] = [
      {
        kubernetesRef: ref,
        potentiallyUndefined: false,
        requiresNullSafety: false,
        hasOptionalChaining: false,
        fieldPath: 'spec.name',
        resourceId: '__schema__',
        isSchemaReference: true,
        confidence: 0.9,
        reason: 'Schema reference',
        suggestedCelPattern: undefined,
      },
    ];

    const result = handler.generateNullSafeCelExpression(ref, optionalityResults, makeContext());

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid result with null-safety when required', () => {
    const ref = makeRef('deploy', 'status.readyReplicas');
    const optionalityResults: OptionalityAnalysisResult[] = [
      {
        kubernetesRef: ref,
        potentiallyUndefined: true,
        requiresNullSafety: true,
        hasOptionalChaining: false,
        fieldPath: 'status.readyReplicas',
        resourceId: 'deploy',
        isSchemaReference: false,
        confidence: 0.6,
        reason: 'Status field',
        suggestedCelPattern: undefined,
      },
    ];

    const result = handler.generateNullSafeCelExpression(ref, optionalityResults, makeContext());

    expect(result.valid).toBe(true);
    expect(result.celExpression).toBeDefined();
  });

  it('includes dependencies in result', () => {
    const ref = makeRef('deploy', 'status.phase');
    const optionalityResults: OptionalityAnalysisResult[] = [
      {
        kubernetesRef: ref,
        potentiallyUndefined: false,
        requiresNullSafety: false,
        hasOptionalChaining: false,
        fieldPath: 'status.phase',
        resourceId: 'deploy',
        isSchemaReference: false,
        confidence: 0.8,
        reason: 'Test',
        suggestedCelPattern: undefined,
      },
    ];

    const result = handler.generateNullSafeCelExpression(ref, optionalityResults, makeContext());

    expect(result.dependencies).toHaveLength(1);
    expect(isKubernetesRef(result.dependencies[0])).toBe(true);
  });

  it('sets requiresConversion=true when optionality results exist', () => {
    const ref = makeRef('deploy', 'status.phase');
    const optionalityResults: OptionalityAnalysisResult[] = [
      {
        kubernetesRef: ref,
        potentiallyUndefined: false,
        requiresNullSafety: false,
        hasOptionalChaining: false,
        fieldPath: 'status.phase',
        resourceId: 'deploy',
        isSchemaReference: false,
        confidence: 0.8,
        reason: 'Test',
        suggestedCelPattern: undefined,
      },
    ];

    const result = handler.generateNullSafeCelExpression(ref, optionalityResults, makeContext());

    expect(result.requiresConversion).toBe(true);
  });

  it('sets requiresConversion=false when no optionality results', () => {
    const result = handler.generateNullSafeCelExpression('static string', [], makeContext());

    expect(result.requiresConversion).toBe(false);
  });
});

// ===========================================================================
// 3. handleOptionalChainingWithEnhancedTypes()
// ===========================================================================

describe('EnhancedTypeOptionalityHandler.handleOptionalChainingWithEnhancedTypes()', () => {
  const handler = new EnhancedTypeOptionalityHandler();

  it('returns valid result for non-ref expression', () => {
    const result = handler.handleOptionalChainingWithEnhancedTypes('static', makeContext());

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid result for KubernetesRef expression', () => {
    const ref = makeRef('deploy', 'status.readyReplicas');
    const result = handler.handleOptionalChainingWithEnhancedTypes(ref, makeContext());

    expect(result.valid).toBe(true);
  });

  it('includes dependencies for KubernetesRef', () => {
    const ref = makeRef('deploy', 'status.phase');
    const result = handler.handleOptionalChainingWithEnhancedTypes(ref, makeContext());

    expect(result.dependencies.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 4. detectNullSafetyRequirements()
// ===========================================================================

describe('EnhancedTypeOptionalityHandler.detectNullSafetyRequirements()', () => {
  const handler = new EnhancedTypeOptionalityHandler();

  it('returns a Map of resource IDs to analysis results', () => {
    const deploy = makeEnhanced('Deployment', 'my-app');
    const result = handler.detectNullSafetyRequirements({ deploymentMyApp: deploy }, makeContext());

    expect(result).toBeInstanceOf(Map);
  });

  it('detects null-safety requirements for Enhanced resources', () => {
    const deploy = makeEnhanced('Deployment', 'my-app');
    const result = handler.detectNullSafetyRequirements({ deploymentMyApp: deploy }, makeContext());

    // Should have results for the common field paths it checks
    expect(result.size).toBeGreaterThanOrEqual(1);
  });

  it('returns empty Map when no resources provided', () => {
    const result = handler.detectNullSafetyRequirements({}, makeContext());
    expect(result.size).toBe(0);
  });

  it('analysis results for each resource contain field path and null-safety info', () => {
    const deploy = makeEnhanced('Deployment', 'my-app');
    const result = handler.detectNullSafetyRequirements({ deploymentMyApp: deploy }, makeContext());

    for (const [_resourceId, analyses] of result) {
      for (const analysis of analyses) {
        expect(typeof analysis.fieldPath).toBe('string');
        expect(typeof analysis.requiresNullSafety).toBe('boolean');
        expect(typeof analysis.potentiallyUndefined).toBe('boolean');
      }
    }
  });

  it('marks status fields as requiring null safety', () => {
    const deploy = makeEnhanced('Deployment', 'my-app');
    const result = handler.detectNullSafetyRequirements(
      { deploymentMyApp: deploy },
      makeContext({ conservativeNullSafety: true })
    );

    const analyses = result.get('deploymentMyApp');
    expect(analyses).toBeDefined();

    const statusFieldAnalyses = analyses!.filter((a) => a.fieldPath.startsWith('status.'));
    // All status fields should be potentially undefined
    for (const analysis of statusFieldAnalyses) {
      expect(analysis.potentiallyUndefined).toBe(true);
    }
  });
});

// ===========================================================================
// 5. generateCelWithHasChecks()
// ===========================================================================

describe('EnhancedTypeOptionalityHandler.generateCelWithHasChecks()', () => {
  const handler = new EnhancedTypeOptionalityHandler();

  it('returns basic CEL when no fields require checks', () => {
    const result = handler.generateCelWithHasChecks('hello', [], makeContext());

    expect(isCelExpr(result)).toBe(true);
  });

  it('generates has() checks for fields requiring null-safety', () => {
    const ref = makeRef('deploy', 'status.readyReplicas');
    const optionalityResults: OptionalityAnalysisResult[] = [
      {
        kubernetesRef: ref,
        potentiallyUndefined: true,
        requiresNullSafety: true,
        hasOptionalChaining: false,
        fieldPath: 'status.readyReplicas',
        resourceId: 'deploy',
        isSchemaReference: false,
        confidence: 0.6,
        reason: 'Status field',
        suggestedCelPattern: undefined,
      },
    ];

    const result = handler.generateCelWithHasChecks(ref, optionalityResults, makeContext());

    expect(isCelExpr(result)).toBe(true);
    expect(result.expression).toContain('has(');
    expect(result.expression).toContain('deploy');
  });

  it('generates nested has() checks for dotted field paths', () => {
    const ref = makeRef('deploy', 'status.conditions.ready');
    const optionalityResults: OptionalityAnalysisResult[] = [
      {
        kubernetesRef: ref,
        potentiallyUndefined: true,
        requiresNullSafety: true,
        hasOptionalChaining: false,
        fieldPath: 'status.conditions.ready',
        resourceId: 'deploy',
        isSchemaReference: false,
        confidence: 0.6,
        reason: 'Status field',
        suggestedCelPattern: undefined,
      },
    ];

    const result = handler.generateCelWithHasChecks(ref, optionalityResults, makeContext());

    expect(isCelExpr(result)).toBe(true);
    // Should have multiple has() checks for the nested path
    const hasCount = (result.expression.match(/has\(/g) || []).length;
    expect(hasCount).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// 6. integrateWithFieldHydrationTiming()
// ===========================================================================

describe('EnhancedTypeOptionalityHandler.integrateWithFieldHydrationTiming()', () => {
  const handler = new EnhancedTypeOptionalityHandler();

  it('returns all expected fields in result', () => {
    const result = handler.integrateWithFieldHydrationTiming(
      'some expression',
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    expect(result).toHaveProperty('preHydrationExpression');
    expect(result).toHaveProperty('postHydrationExpression');
    expect(result).toHaveProperty('hydrationDependentExpression');
    expect(result).toHaveProperty('transitionHandlers');
    expect(Array.isArray(result.transitionHandlers)).toBe(true);
  });

  it('returns null expressions for non-ref expression', () => {
    const result = handler.integrateWithFieldHydrationTiming(
      'static string',
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    // Non-ref expressions should still return valid structure
    expect(result.preHydrationExpression).toBeDefined();
    expect(result.postHydrationExpression).toBeDefined();
  });

  it('generates transition handlers for KubernetesRef expressions', () => {
    const ref = makeRef('deploy', 'status.readyReplicas');
    const hydrationStates = new Map<string, FieldHydrationState>();

    const result = handler.integrateWithFieldHydrationTiming(ref, hydrationStates, makeContext());

    // Should have at least one transition handler for unhydrated -> hydrating
    expect(result.transitionHandlers.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 7. handleUndefinedToDefinedTransitions()
// ===========================================================================

describe('EnhancedTypeOptionalityHandler.handleUndefinedToDefinedTransitions()', () => {
  const handler = new EnhancedTypeOptionalityHandler();

  it('returns valid result for non-ref expression', () => {
    const result = handler.handleUndefinedToDefinedTransitions(
      'static',
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns transition plan with phases for ref expressions', () => {
    const ref = makeRef('deploy', 'status.readyReplicas');
    const result = handler.handleUndefinedToDefinedTransitions(
      ref,
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    expect(result.valid).toBe(true);
    expect(result.transitionPlan).toBeDefined();
    expect(Array.isArray(result.transitionPlan.phases)).toBe(true);
    expect(Array.isArray(result.transitionPlan.criticalFields)).toBe(true);
    expect(typeof result.transitionPlan.totalDuration).toBe('number');
  });

  it('categorizes readyReplicas as early phase with critical fields', () => {
    const ref = makeRef('deploy', 'status.readyReplicas');
    const result = handler.handleUndefinedToDefinedTransitions(
      ref,
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    const earlyPhase = result.transitionPlan.phases.find((p) => p.name === 'early');
    expect(earlyPhase).toBeDefined();
    expect(earlyPhase!.isCritical).toBe(true);
  });

  it('categorizes metadata fields as immediate phase', () => {
    const ref = makeRef('deploy', 'metadata.name');
    const result = handler.handleUndefinedToDefinedTransitions(
      ref,
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    const immediatePhase = result.transitionPlan.phases.find((p) => p.name === 'immediate');
    expect(immediatePhase).toBeDefined();
  });

  it('categorizes schema refs as immediate phase', () => {
    const ref = makeRef('__schema__', 'spec.name');
    const result = handler.handleUndefinedToDefinedTransitions(
      ref,
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    const immediatePhase = result.transitionPlan.phases.find((p) => p.name === 'immediate');
    expect(immediatePhase).toBeDefined();
  });

  it('returns phase expressions map', () => {
    const ref = makeRef('deploy', 'status.phase');
    const result = handler.handleUndefinedToDefinedTransitions(
      ref,
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    expect(result.phaseExpressions).toBeInstanceOf(Map);
  });

  it('returns watch expressions array', () => {
    const ref = makeRef('deploy', 'status.phase');
    const result = handler.handleUndefinedToDefinedTransitions(
      ref,
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    expect(Array.isArray(result.watchExpressions)).toBe(true);
    // Should have at least one watch expression for the ref
    if (result.watchExpressions.length > 0) {
      expect(isCelExpr(result.watchExpressions[0])).toBe(true);
      expect(result.watchExpressions[0]!.expression).toContain('has(');
    }
  });

  it('returns fallback expressions map', () => {
    const ref = makeRef('deploy', 'status.readyReplicas');
    const result = handler.handleUndefinedToDefinedTransitions(
      ref,
      new Map<string, FieldHydrationState>(),
      makeContext()
    );

    expect(result.fallbackExpressions).toBeInstanceOf(Map);
    // Critical phases should have 'false' fallback
    for (const [_phaseName, fallbackExpr] of result.fallbackExpressions) {
      expect(isCelExpr(fallbackExpr)).toBe(true);
    }
  });
});

// ===========================================================================
// 8. Optionality confidence calculation (via analyzeOptionalityRequirements)
// ===========================================================================

describe('Optionality confidence calculation', () => {
  const handler = new EnhancedTypeOptionalityHandler();

  it('schema references have higher confidence than status fields', () => {
    const schemaRef = makeRef('__schema__', 'spec.name');
    const statusRef = makeRef('deploy', 'status.readyReplicas');

    const schemaResults = handler.analyzeOptionalityRequirements(schemaRef, makeContext());
    const statusResults = handler.analyzeOptionalityRequirements(statusRef, makeContext());

    expect(schemaResults.length).toBeGreaterThanOrEqual(1);
    expect(statusResults.length).toBeGreaterThanOrEqual(1);
    expect(schemaResults[0]!.confidence).toBeGreaterThan(statusResults[0]!.confidence);
  });

  it('confidence is boosted when hydration states are provided', () => {
    const ref = makeRef('deploy', 'spec.image');
    const withoutHydration = handler.analyzeOptionalityRequirements(
      ref,
      makeContext({ hydrationStates: undefined })
    );
    const withHydration = handler.analyzeOptionalityRequirements(
      ref,
      makeContext({ hydrationStates: new Map() })
    );

    expect(withoutHydration.length).toBeGreaterThanOrEqual(1);
    expect(withHydration.length).toBeGreaterThanOrEqual(1);
    expect(withHydration[0]!.confidence).toBeGreaterThanOrEqual(withoutHydration[0]!.confidence);
  });
});
