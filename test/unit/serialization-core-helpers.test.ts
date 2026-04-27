/**
 * Unit tests for internal helper functions in serialization/core.ts
 *
 * These functions will be extracted during the ARCH-H2 refactor.
 * Tests ensure no regressions during the extraction.
 */

import { describe, expect, test } from 'bun:test';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import { getResourceId } from '../../src/core/metadata/index.js';
// Ensure FactoryRegistry is populated before tests. Factory registrations
// happen via side effects at module scope. Import the Kubernetes factory
// modules directly (the barrel re-export in factories/index.js may be
// tree-shaken when no named exports are consumed).
import '../../src/factories/kubernetes/workloads/deployment.js';
import '../../src/factories/kubernetes/workloads/stateful-set.js';
import '../../src/factories/kubernetes/networking/service.js';
import '../../src/factories/kubernetes/networking/ingress.js';
import '../../src/factories/kubernetes/config/config-map.js';
import '../../src/factories/kubernetes/config/secret.js';
// HelmRelease is auto-registered when createResource() is called with kind: HelmRelease.
// For test isolation, register it explicitly.
import { registerFactory, getKindInfo } from '../../src/core/resources/factory-registry.js';
registerFactory({ factoryName: 'HelmRelease', kind: 'HelmRelease', apiVersion: 'helm.toolkit.fluxcd.io/v2' });
import {
  analyzeStatusMappingTypes,
  analyzeValueType,
  createStubResource,
  detectAndPreserveCelExpressions,
  isLikelyStaticObject,
  mergePreservedCelExpressions,
  separateResourcesAndClosures,
} from '../../src/core/serialization/core.js';
import { serializeStatusMappingsToCel } from '../../src/core/serialization/cel-references.js';
import { separateStatusFields } from '../../src/core/validation/cel-validator.js';

/**
 * Typed wrapper for separateResourcesAndClosures that accepts plain objects.
 * The function internally uses `as any` casts anyway, so this is safe for testing.
 */
const separate = (input: Record<string, unknown>) =>
  separateResourcesAndClosures(input as Parameters<typeof separateResourcesAndClosures>[0]);

// =============================================================================
// Test Helpers
// =============================================================================

/** Create a mock Enhanced resource (has kind + apiVersion like K8s objects) */
function makeEnhanced(kind: string, apiVersion = 'v1') {
  return {
    kind,
    apiVersion,
    metadata: { name: `test-${kind.toLowerCase()}` },
    spec: {},
    status: {},
  };
}

/** Create a mock DeploymentClosure (function matching DeploymentClosure signature) */
function makeClosure(name = 'test-closure') {
  const fn = async (_ctx: unknown) => {
    return [] as unknown[];
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

/** Create a CelExpression-like object */
function makeCelExpr(expression: string) {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
  };
}

/** Create a KubernetesRef-like object */
function makeKubeRef(resourceId: string, fieldPath: string) {
  return {
    [KUBERNETES_REF_BRAND]: true,
    resourceId,
    fieldPath,
  };
}

// =============================================================================
// separateResourcesAndClosures
// =============================================================================

describe('separateResourcesAndClosures', () => {
  test('separates Enhanced resources from closures', () => {
    const deployment = makeEnhanced('Deployment', 'apps/v1');
    const closure = makeClosure('install');

    const result = separate({ myDeploy: deployment, installCRDs: closure });

    expect(Object.keys(result.resources)).toEqual(['myDeploy']);
    expect(Object.keys(result.closures)).toEqual(['installCRDs']);
    // Verify identity via reference equality
    expect(result.resources.myDeploy === (deployment as never)).toBe(true);
    expect(result.closures.installCRDs === (closure as never)).toBe(true);
  });

  test('handles empty input', () => {
    const result = separate({});
    expect(Object.keys(result.resources)).toHaveLength(0);
    expect(Object.keys(result.closures)).toHaveLength(0);
  });

  test('all resources, no closures', () => {
    const svc = makeEnhanced('Service');
    const deploy = makeEnhanced('Deployment', 'apps/v1');

    const result = separate({ svc, deploy });

    expect(Object.keys(result.resources)).toHaveLength(2);
    expect(Object.keys(result.closures)).toHaveLength(0);
  });

  test('all closures, no resources', () => {
    const c1 = makeClosure('c1');
    const c2 = makeClosure('c2');

    const result = separate({ setup: c1, teardown: c2 });

    expect(Object.keys(result.resources)).toHaveLength(0);
    expect(Object.keys(result.closures)).toHaveLength(2);
  });

  test('unknown value types (no kind/apiVersion) go to resources for backward compat', () => {
    const unknownObj = { foo: 'bar' };
    const result = separate({ mystery: unknownObj });

    expect(Object.keys(result.resources)).toEqual(['mystery']);
    expect(Object.keys(result.closures)).toHaveLength(0);
  });

  test('primitive values go to resources for backward compat', () => {
    const result = separate({ num: 42, str: 'hello' });

    expect(Object.keys(result.resources)).toHaveLength(2);
    expect(Object.keys(result.closures)).toHaveLength(0);
  });

  test('object with kind but no apiVersion goes to resources', () => {
    const partial = { kind: 'Deployment' };
    const result = separate({ partial });

    // Has kind but no apiVersion → falls to unknown → resources
    expect(Object.keys(result.resources)).toEqual(['partial']);
  });

  test('mixed resources and closures preserve order of keys', () => {
    const r1 = makeEnhanced('Service');
    const c1 = makeClosure('c1');
    const r2 = makeEnhanced('Deployment', 'apps/v1');
    const c2 = makeClosure('c2');

    const result = separate({ alpha: r1, beta: c1, gamma: r2, delta: c2 });

    expect(Object.keys(result.resources)).toEqual(['alpha', 'gamma']);
    expect(Object.keys(result.closures)).toEqual(['beta', 'delta']);
  });
});

// =============================================================================
// createStubResource
// =============================================================================

describe('createStubResource', () => {
  test('creates stub for known factory types', () => {
    const stub = createStubResource('Deployment', 'my-deploy');
    expect(stub).not.toBeNull();
    expect(stub!.apiVersion).toBe('apps/v1');
    expect(stub!.kind).toBe('Deployment');
    expect((stub!.metadata as Record<string, unknown>).name).toBe('my-deploy');
    expect((stub!.metadata as Record<string, unknown>).labels).toEqual({});
  });

  test('returns null for unknown factory types', () => {
    const stub = createStubResource('UnknownCRD', 'my-resource');
    expect(stub).toBeNull();
  });

  test('stores resourceId in WeakMap metadata (not as object property)', () => {
    const stub = createStubResource('Service', 'my-svc');
    expect(stub).not.toBeNull();

    // Not visible in Object.keys
    expect(Object.keys(stub!)).not.toContain('__resourceId');

    // Accessible via WeakMap metadata
    expect(getResourceId(stub!)).toBe('my-svc');

    // Not stored as a property on the object
    expect(stub!).not.toHaveProperty('__resourceId');
  });

  test('creates stubs for factory names registered in FactoryRegistry', () => {
    const testFactories = [
      { name: 'Deployment', apiVersion: 'apps/v1', kind: 'Deployment' },
      { name: 'Service', apiVersion: 'v1', kind: 'Service' },
      { name: 'ConfigMap', apiVersion: 'v1', kind: 'ConfigMap' },
      { name: 'Secret', apiVersion: 'v1', kind: 'Secret' },
      { name: 'HelmRelease', apiVersion: 'helm.toolkit.fluxcd.io/v2', kind: 'HelmRelease' },
    ];
    for (const { name, apiVersion, kind } of testFactories) {
      const info = getKindInfo(name);
      expect(info).toBeDefined();
      const stub = createStubResource(name, `test-${name.toLowerCase()}`);
      expect(stub).not.toBeNull();
      expect(stub!.apiVersion).toBe(apiVersion);
      expect(stub!.kind).toBe(kind);
    }
  });

  test('FactoryRegistry contains expected Kubernetes types', () => {
    expect(getKindInfo('Deployment')).toBeDefined();
    expect(getKindInfo('Service')).toBeDefined();
    expect(getKindInfo('ConfigMap')).toBeDefined();
    expect(getKindInfo('Secret')).toBeDefined();
    expect(getKindInfo('HelmRelease')).toBeDefined();
    expect(getKindInfo('HelmRelease')?.apiVersion).toBe('helm.toolkit.fluxcd.io/v2');
  });

  test('stub does not include spec field', () => {
    const stub = createStubResource('Deployment', 'my-deploy');
    expect(stub).not.toBeNull();
    expect(stub!.spec).toBeUndefined();
  });

  test('stub is not frozen or sealed', () => {
    const stub = createStubResource('ConfigMap', 'my-cm');
    expect(stub).not.toBeNull();
    expect(Object.isFrozen(stub!)).toBe(false);
    expect(Object.isSealed(stub!)).toBe(false);
  });
});

// =============================================================================
// detectAndPreserveCelExpressions
// =============================================================================

describe('detectAndPreserveCelExpressions', () => {
  test('detects CEL expressions at top level', () => {
    const celExpr = makeCelExpr('deployment.status.readyReplicas > 0');
    const statusMappings = {
      ready: celExpr,
      name: 'static-value',
    };

    const result = detectAndPreserveCelExpressions(statusMappings);

    expect(result.hasExistingCel).toBe(true);
    expect(result.preservedMappings.ready).toBe(celExpr);
    expect(Object.keys(result.preservedMappings)).toHaveLength(1);
  });

  test('detects CEL expressions in nested objects', () => {
    const celExpr = makeCelExpr('resource.status.phase == "Ready"');
    const statusMappings = {
      nested: {
        deep: {
          phase: celExpr,
        },
      },
    };

    const result = detectAndPreserveCelExpressions(statusMappings);

    expect(result.hasExistingCel).toBe(true);
    expect(result.preservedMappings['nested.deep.phase']).toBe(celExpr);
  });

  test('returns false when no CEL expressions exist', () => {
    const statusMappings = {
      name: 'static',
      count: 42,
      enabled: true,
    };

    const result = detectAndPreserveCelExpressions(statusMappings);

    expect(result.hasExistingCel).toBe(false);
    expect(Object.keys(result.preservedMappings)).toHaveLength(0);
  });

  test('handles null/undefined input gracefully', () => {
    expect(
      detectAndPreserveCelExpressions(null as unknown as Record<string, unknown>).hasExistingCel
    ).toBe(false);
    expect(
      detectAndPreserveCelExpressions(undefined as unknown as Record<string, unknown>)
        .hasExistingCel
    ).toBe(false);
  });

  test('handles non-object input gracefully', () => {
    expect(
      detectAndPreserveCelExpressions('string' as unknown as Record<string, unknown>).hasExistingCel
    ).toBe(false);
    expect(
      detectAndPreserveCelExpressions(42 as unknown as Record<string, unknown>).hasExistingCel
    ).toBe(false);
  });

  test('skips arrays (CEL in arrays not detected)', () => {
    const celExpr = makeCelExpr('some.expr');
    const statusMappings = {
      items: [celExpr],
    };

    const result = detectAndPreserveCelExpressions(statusMappings);

    // Arrays are skipped by design
    expect(result.hasExistingCel).toBe(false);
  });

  test('classifies status arrays containing CEL as dynamic', () => {
    const celExpr = makeCelExpr('deployment.status.phase');

    const result = separateStatusFields({ phases: [celExpr] });

    expect(result.staticFields).toEqual({});
    expect(result.dynamicFields.phases).toEqual([celExpr]);
  });

  test('serializes status arrays recursively', () => {
    const result = serializeStatusMappingsToCel({
      phases: [makeCelExpr('deployment.status.phase'), 'static'],
    });

    expect(result.phases).toEqual(['${deployment.status.phase}', '${"static"}']);
  });

  test('detects multiple CEL expressions', () => {
    const cel1 = makeCelExpr('expr1');
    const cel2 = makeCelExpr('expr2');
    const statusMappings = {
      phase: cel1,
      ready: cel2,
      name: 'static',
    };

    const result = detectAndPreserveCelExpressions(statusMappings);

    expect(result.hasExistingCel).toBe(true);
    expect(Object.keys(result.preservedMappings)).toHaveLength(2);
    expect(result.preservedMappings.phase).toBe(cel1);
    expect(result.preservedMappings.ready).toBe(cel2);
  });

  test('preserves existing expressions passed in', () => {
    const existing = { 'old.path': makeCelExpr('old') };
    const newCel = makeCelExpr('new');
    const statusMappings = { fresh: newCel };

    const result = detectAndPreserveCelExpressions(statusMappings, existing);

    expect(result.preservedMappings['old.path']).toBeDefined();
    expect(result.preservedMappings.fresh).toBe(newCel);
  });

  test('empty object returns no CEL', () => {
    const result = detectAndPreserveCelExpressions({});
    expect(result.hasExistingCel).toBe(false);
    expect(Object.keys(result.preservedMappings)).toHaveLength(0);
  });
});

// =============================================================================
// mergePreservedCelExpressions
// =============================================================================

describe('mergePreservedCelExpressions', () => {
  test('merges preserved CEL into analyzed mappings', () => {
    const analyzed = { name: 'static', count: 42 };
    const celExpr = makeCelExpr('resource.status.phase');
    const preserved = { phase: celExpr };

    const result = mergePreservedCelExpressions(analyzed, preserved);

    expect(result.name).toBe('static');
    expect(result.count).toBe(42);
    expect(result.phase).toBe(celExpr);
  });

  test('preserved CEL overrides analyzed values', () => {
    const celExpr = makeCelExpr('correct expression');
    const analyzed = { phase: 'wrong-static-value' };
    const preserved = { phase: celExpr };

    const result = mergePreservedCelExpressions(analyzed, preserved);

    expect(result.phase).toBe(celExpr);
  });

  test('creates nested path structure', () => {
    const celExpr = makeCelExpr('deep.value');
    const analyzed = {};
    const preserved = { 'a.b.c': celExpr };

    const result = mergePreservedCelExpressions(analyzed, preserved);

    const resultA = (result as Record<string, unknown>).a as Record<string, unknown>;
    const resultAB = resultA.b as Record<string, unknown>;
    expect(resultAB.c).toBe(celExpr);
  });

  test('preserves existing nested objects when merging', () => {
    const celExpr = makeCelExpr('new.expr');
    const analyzed = {
      a: { existing: 'value' },
    };
    const preserved = { 'a.added': celExpr };

    const result = mergePreservedCelExpressions(analyzed, preserved);

    const resultAObj = (result as Record<string, unknown>).a as Record<string, unknown>;
    expect(resultAObj.existing).toBe('value');
    expect(resultAObj.added).toBe(celExpr);
  });

  test('handles empty preserved mappings', () => {
    const analyzed = { name: 'test' };
    const result = mergePreservedCelExpressions(analyzed, {});

    expect(result).toEqual({ name: 'test' });
  });

  test('handles empty analyzed mappings', () => {
    const celExpr = makeCelExpr('expr');
    const result = mergePreservedCelExpressions({}, { field: celExpr });

    expect(result.field).toBe(celExpr);
  });

  test('overwrites non-object intermediate path parts', () => {
    const celExpr = makeCelExpr('override');
    const analyzed = { a: 'was-a-string' };
    const preserved = { 'a.b': celExpr };

    const result = mergePreservedCelExpressions(analyzed, preserved);

    // 'a' was a string but gets overwritten with {} to create nested path
    expect(((result as Record<string, unknown>).a as Record<string, unknown>).b).toBe(celExpr);
  });

  test('skips empty path parts', () => {
    const celExpr = makeCelExpr('expr');
    // Path with double dots produces empty parts
    const preserved = { 'a..b': celExpr };

    const result = mergePreservedCelExpressions({}, preserved);

    // Empty parts skipped, so effectively 'a.b'
    expect(((result as Record<string, unknown>).a as Record<string, unknown>).b).toBe(celExpr);
  });

  test('does not mutate original analyzed mappings', () => {
    const analyzed = { name: 'original' };
    const celExpr = makeCelExpr('expr');
    const preserved = { added: celExpr };

    mergePreservedCelExpressions(analyzed, preserved);

    // Original should not have the new field
    expect((analyzed as Record<string, unknown>).added).toBeUndefined();
  });
});

// =============================================================================
// analyzeValueType
// =============================================================================

describe('analyzeValueType', () => {
  test('identifies CEL expressions (confidence 1.0)', () => {
    const result = analyzeValueType(makeCelExpr('some.expr'));
    expect(result.type).toBe('celExpression');
    expect(result.confidence).toBe(1.0);
    expect(result.requiresConversion).toBe(false);
  });

  test('identifies KubernetesRef (confidence 1.0)', () => {
    const result = analyzeValueType(makeKubeRef('deploy', 'status.ready'));
    expect(result.type).toBe('kubernetesRef');
    expect(result.confidence).toBe(1.0);
    expect(result.requiresConversion).toBe(true);
  });

  test('identifies string as static (confidence 1.0)', () => {
    const result = analyzeValueType('hello');
    expect(result.type).toBe('staticValue');
    expect(result.confidence).toBe(1.0);
  });

  test('identifies number as static (confidence 1.0)', () => {
    const result = analyzeValueType(42);
    expect(result.type).toBe('staticValue');
    expect(result.confidence).toBe(1.0);
  });

  test('identifies boolean as static (confidence 1.0)', () => {
    const result = analyzeValueType(true);
    expect(result.type).toBe('staticValue');
    expect(result.confidence).toBe(1.0);
  });

  test('identifies null as static (confidence 1.0)', () => {
    const result = analyzeValueType(null);
    expect(result.type).toBe('staticValue');
    expect(result.confidence).toBe(1.0);
  });

  test('identifies undefined as static (confidence 1.0)', () => {
    const result = analyzeValueType(undefined);
    expect(result.type).toBe('staticValue');
    expect(result.confidence).toBe(1.0);
  });

  test('identifies array with KubernetesRef (confidence 1.0 via deep check)', () => {
    // containsKubernetesRefs does a deep check and catches the ref before
    // we reach the array-specific branch, so confidence is 1.0
    const result = analyzeValueType([makeKubeRef('r1', 'status.x')]);
    expect(result.type).toBe('kubernetesRef');
    expect(result.confidence).toBe(1.0);
    expect(result.requiresConversion).toBe(true);
  });

  test('identifies array with CEL expressions (confidence 0.9)', () => {
    const result = analyzeValueType([makeCelExpr('expr')]);
    expect(result.type).toBe('celExpression');
    expect(result.confidence).toBe(0.9);
  });

  test('identifies static array (confidence 0.8)', () => {
    const result = analyzeValueType([1, 2, 3]);
    expect(result.type).toBe('staticValue');
    expect(result.confidence).toBe(0.8);
  });

  test('identifies object with all primitive values as static (confidence 0.7)', () => {
    const result = analyzeValueType({ name: 'test', count: 5 });
    expect(result.type).toBe('staticValue');
    expect(result.confidence).toBe(0.7);
  });

  test('identifies object with nested objects as complex (confidence 0.5)', () => {
    const result = analyzeValueType({ nested: { deep: { value: [1, 2] } } });
    expect(result.type).toBe('complexExpression');
    expect(result.confidence).toBe(0.5);
  });

  test('identifies object with CEL expression values (confidence 0.8)', () => {
    const result = analyzeValueType({ field: makeCelExpr('expr') });
    expect(result.type).toBe('celExpression');
    expect(result.confidence).toBe(0.8);
  });

  test('identifies object with KubernetesRef values (confidence 1.0 via deep check)', () => {
    // containsKubernetesRefs does a deep check and catches the ref before
    // we reach the object-specific branch, so confidence is 1.0
    const result = analyzeValueType({ ref: makeKubeRef('r1', 'field') });
    expect(result.type).toBe('kubernetesRef');
    expect(result.confidence).toBe(1.0);
    expect(result.requiresConversion).toBe(true);
  });

  test('mixed array: KubernetesRef takes priority over CEL', () => {
    const result = analyzeValueType([makeCelExpr('expr'), makeKubeRef('r1', 'status')]);
    expect(result.type).toBe('kubernetesRef');
  });

  test('empty array is static', () => {
    const result = analyzeValueType([]);
    expect(result.type).toBe('staticValue');
    expect(result.confidence).toBe(0.8);
  });

  test('empty object is static', () => {
    const result = analyzeValueType({});
    expect(result.type).toBe('staticValue');
    expect(result.confidence).toBe(0.7);
  });

  test('returns value in result', () => {
    const obj = { test: true };
    const result = analyzeValueType(obj);
    expect(result.value).toBe(obj);
  });
});

// =============================================================================
// isLikelyStaticObject
// =============================================================================

describe('isLikelyStaticObject', () => {
  test('all-primitive values object is static', () => {
    expect(isLikelyStaticObject({ name: 'test', count: 5, enabled: true })).toBe(true);
  });

  test('empty object is static (vacuously true)', () => {
    expect(isLikelyStaticObject({})).toBe(true);
  });

  test('null values count as primitive', () => {
    expect(isLikelyStaticObject({ a: null, b: 'test' })).toBe(true);
  });

  test('undefined values count as primitive', () => {
    expect(isLikelyStaticObject({ a: undefined, b: 42 })).toBe(true);
  });

  test('object with nested object is not all-primitive', () => {
    const obj = { nested: { value: 1 } };
    // Has nested object → not all primitive
    // But has no common static keys → false
    expect(isLikelyStaticObject(obj)).toBe(false);
  });

  test('object with common static keys and nested object is static', () => {
    const obj = { name: 'test', config: { nested: true } };
    // Has 'name' (common static key) and <= 10 values → true
    expect(isLikelyStaticObject(obj)).toBe(true);
  });

  test('returns false for arrays', () => {
    expect(isLikelyStaticObject([1, 2, 3])).toBe(false);
  });

  test('returns false for null', () => {
    expect(isLikelyStaticObject(null)).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isLikelyStaticObject(undefined)).toBe(false);
  });

  test('returns false for non-objects', () => {
    expect(isLikelyStaticObject('string')).toBe(false);
    expect(isLikelyStaticObject(42)).toBe(false);
    expect(isLikelyStaticObject(true)).toBe(false);
  });

  test('common static keys are case-insensitive', () => {
    expect(isLikelyStaticObject({ Name: 'test', Config: {} })).toBe(true);
    expect(isLikelyStaticObject({ TYPE: 'foo', Bar: {} })).toBe(true);
    expect(isLikelyStaticObject({ VERSION: '1.0', data: {} })).toBe(true);
  });

  test('object with >10 values and common keys but not all primitive is not static', () => {
    const obj: Record<string, unknown> = { name: 'test' };
    for (let i = 0; i < 11; i++) {
      obj[`field${i}`] = { nested: true };
    }
    // Has 12 values > 10 threshold, even with 'name' key
    expect(isLikelyStaticObject(obj)).toBe(false);
  });

  test('object with <=10 values and common keys is static', () => {
    const obj: Record<string, unknown> = { id: '123' };
    for (let i = 0; i < 8; i++) {
      obj[`field${i}`] = { nested: true };
    }
    // Has 9 values <= 10 and 'id' key → true
    expect(isLikelyStaticObject(obj)).toBe(true);
  });

  test('no common static keys and not all primitive → not static', () => {
    expect(isLikelyStaticObject({ foo: { bar: 1 }, baz: { qux: 2 } })).toBe(false);
  });
});

// =============================================================================
// analyzeStatusMappingTypes
// =============================================================================

describe('analyzeStatusMappingTypes', () => {
  test('categorizes flat status mappings correctly', () => {
    const celExpr = makeCelExpr('deploy.status.phase');
    const kubeRef = makeKubeRef('deploy', 'status.readyReplicas');

    const result = analyzeStatusMappingTypes({
      phase: celExpr,
      replicas: kubeRef,
      name: 'my-app',
    });

    expect(result.celExpressionFields).toContain('phase');
    expect(result.kubernetesRefFields).toContain('replicas');
    expect(result.staticValueFields).toContain('name');
  });

  test('handles empty input', () => {
    const result = analyzeStatusMappingTypes({});
    expect(result.kubernetesRefFields).toHaveLength(0);
    expect(result.celExpressionFields).toHaveLength(0);
    expect(result.staticValueFields).toHaveLength(0);
    expect(result.complexExpressionFields).toHaveLength(0);
  });

  test('handles null/undefined input', () => {
    const result = analyzeStatusMappingTypes(null as unknown as Record<string, unknown>);
    expect(result.kubernetesRefFields).toHaveLength(0);

    const result2 = analyzeStatusMappingTypes(undefined as unknown as Record<string, unknown>);
    expect(result2.kubernetesRefFields).toHaveLength(0);
  });

  test('recursively analyzes nested objects', () => {
    const result = analyzeStatusMappingTypes({
      outer: {
        inner: 'static',
      },
    });

    // Both outer (as complex/static) and inner (static via dotted key) should appear
    expect(result.analysisDetails).toHaveProperty('outer');
    // The key is literally 'outer.inner' (dotted string), not nested property access
    expect(result.analysisDetails['outer.inner']).toBeDefined();
  });

  test('provides analysis details with confidence scores', () => {
    const celExpr = makeCelExpr('expr');
    const result = analyzeStatusMappingTypes({
      phase: celExpr,
      count: 42,
    });

    const phaseDetail = result.analysisDetails.phase;
    expect(phaseDetail).toBeDefined();
    expect(phaseDetail?.type).toBe('celExpression');
    expect(phaseDetail?.confidence).toBe(1.0);

    const countDetail = result.analysisDetails.count;
    expect(countDetail).toBeDefined();
    expect(countDetail?.type).toBe('staticValue');
    expect(countDetail?.confidence).toBe(1.0);
  });

  test('uses dotted path notation', () => {
    const result = analyzeStatusMappingTypes({
      a: { b: 'static' },
    });

    const detail = result.analysisDetails['a.b'];
    expect(detail).toBeDefined();
    expect(detail?.type).toBe('staticValue');
  });

  test('handles all four value type categories', () => {
    const result = analyzeStatusMappingTypes({
      cel: makeCelExpr('expr'),
      ref: makeKubeRef('r', 'f'),
      static: 'value',
      complex: { nested: { deep: [1, 2] } },
    });

    expect(result.celExpressionFields.length).toBeGreaterThan(0);
    expect(result.kubernetesRefFields.length).toBeGreaterThan(0);
    expect(result.staticValueFields.length).toBeGreaterThan(0);
    // complex might appear as static or complex depending on heuristic
    expect(result.complexExpressionFields.length + result.staticValueFields.length).toBeGreaterThan(
      0
    );
  });
});

// =============================================================================
// Integration: detect + merge CEL expressions round-trip
// =============================================================================

describe('CEL expression detect → merge round-trip', () => {
  test('detect then merge preserves all CEL expressions', () => {
    const cel1 = makeCelExpr('resource.status.phase');
    const cel2 = makeCelExpr('resource.status.ready');

    const statusMappings = {
      phase: cel1,
      nested: {
        ready: cel2,
      },
      staticField: 'unchanged',
    };

    // Step 1: Detect
    const { preservedMappings } = detectAndPreserveCelExpressions(statusMappings);

    // Step 2: Simulate analysis producing different values
    const analyzed = {
      phase: 'wrong-analyzed-value',
      nested: {
        ready: false,
      },
      staticField: 'unchanged',
    };

    // Step 3: Merge — CEL should win
    const merged = mergePreservedCelExpressions(analyzed, preservedMappings);

    expect(merged.phase).toBe(cel1);
    expect(((merged as Record<string, unknown>).nested as Record<string, unknown>).ready).toBe(
      cel2
    );
    expect(merged.staticField).toBe('unchanged');
  });

  test('empty status mappings produce no-op round-trip', () => {
    const { hasExistingCel, preservedMappings } = detectAndPreserveCelExpressions({});
    expect(hasExistingCel).toBe(false);

    const analyzed = { name: 'test' };
    const merged = mergePreservedCelExpressions(analyzed, preservedMappings);

    expect(merged).toEqual({ name: 'test' });
  });
});
