/**
 * Characterization tests for ReferenceResolver (resolver.ts)
 *
 * These tests capture the CURRENT behavior of the reference resolver's
 * property preservation, cloning, and pure utility methods as a safety
 * net for the WeakMap migration (Phase 2.6).
 *
 * Focus areas:
 *   1. resolveReferences — property preservation after cloning
 *   2. filterInternalFields — __ prefix and function stripping
 *   3. selectiveClone — Symbol brand preservation
 *   4. hasReferences — KubernetesRef/CelExpression detection
 *   5. extractFieldValue — dot-notation field access
 *   6. parseResourceId — resource ID format parsing
 *   7. restoreBrands — Symbol brand restoration
 *   8. Error classes — construction
 *
 * Note: Many methods are private. We test them through the public API where
 * possible, and through the class instance where needed.
 *
 * @see src/core/references/resolver.ts
 */

import { describe, expect, it } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import {
  getReadinessEvaluator as getReadinessEvaluatorFromMeta,
  getResourceId,
} from '../../src/core/metadata/index.js';
import {
  CelExpressionError,
  ReferenceResolutionError,
  ReferenceResolver,
} from '../../src/core/references/resolver.js';
import type { CelExpression, KubernetesRef } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal KubeConfig for test instantiation */
function createTestKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'test', server: 'https://localhost:6443', skipTLSVerify: true }],
    users: [{ name: 'test', token: 'test-token' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  });
  return kc;
}

/** Create a mock k8s API that throws (we don't test cluster queries here) */
function createMockK8sApi(): k8s.KubernetesObjectApi {
  return {
    read: () => {
      throw new Error('Not expected to reach cluster in unit tests');
    },
  } as unknown as k8s.KubernetesObjectApi;
}

function createResolver(mode: 'direct' | 'kro' = 'direct'): ReferenceResolver {
  return new ReferenceResolver(createTestKubeConfig(), mode, createMockK8sApi());
}

/** Build a branded KubernetesRef */
function makeRef(resourceId: string, fieldPath: string): KubernetesRef {
  const ref = { resourceId, fieldPath } as Record<string, unknown>;
  Object.defineProperty(ref, KUBERNETES_REF_BRAND, { value: true, enumerable: false });
  return ref as unknown as KubernetesRef;
}

/** Build a branded CelExpression */
function makeCel(expression: string): CelExpression {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
  } as CelExpression;
}

// ===========================================================================
// 1. resolveReferences — property preservation
// ===========================================================================

describe('ReferenceResolver.resolveReferences()', () => {
  it('returns resource as-is when it has no references', async () => {
    const resolver = createResolver();
    const resource = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'test' }, id: 'cm' };
    const result = await resolver.resolveReferences(resource, {
      deployedResources: [],
      kubeClient: createTestKubeConfig(),
      timeout: 5000,
    });
    // When no references, returns the exact same object
    expect(result).toBe(resource);
  });

  it('preserves __resourceId as non-enumerable after cloning', async () => {
    const resolver = createResolver();
    const resource: Record<string, unknown> = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test' },
      id: 'svc',
      // Include a KubernetesRef so hasReferences returns true and cloning triggers
      spec: { port: makeRef('someDeployment', 'spec.port') },
    };
    Object.defineProperty(resource, '__resourceId', {
      value: 'serviceTest',
      enumerable: false,
    });

    const ctx = {
      deployedResources: [
        {
          id: 'someDeployment',
          kind: 'Deployment',
          name: 'some',
          namespace: 'default',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'some' },
            spec: { port: 8080 },
            status: {},
          },
          status: 'deployed' as const,
          deployedAt: new Date(),
        },
      ],
      kubeClient: createTestKubeConfig(),
      timeout: 5000,
    };

    const result = await resolver.resolveReferences(resource, ctx);
    // __resourceId should be preserved in WeakMap metadata
    expect(getResourceId(result)).toBe('serviceTest');
    // Should NOT appear as an object property
    expect(Object.keys(result)).not.toContain('__resourceId');
  });

  it('preserves readinessEvaluator in WeakMap after cloning', async () => {
    const resolver = createResolver();
    const evaluator = () => ({ ready: true, message: 'ok' });
    const resource: Record<string, unknown> = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test' },
      id: 'cm',
      data: { ref: makeRef('dep', 'status.ready') },
    };
    Object.defineProperty(resource, 'readinessEvaluator', {
      value: evaluator,
      enumerable: false,
    });

    const ctx = {
      deployedResources: [
        {
          id: 'dep',
          kind: 'Deployment',
          name: 'dep',
          namespace: 'default',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'dep' },
            status: { ready: true },
          },
          status: 'deployed' as const,
          deployedAt: new Date(),
        },
      ],
      kubeClient: createTestKubeConfig(),
      timeout: 5000,
    };

    const result = await resolver.resolveReferences(resource, ctx);
    // readinessEvaluator should be preserved in WeakMap
    expect(getReadinessEvaluatorFromMeta(result)).toBe(evaluator);
    // Should NOT appear as an enumerable property
    expect(Object.keys(result)).not.toContain('readinessEvaluator');
  });
});

// ===========================================================================
// 2. Cache behavior
// ===========================================================================

describe('ReferenceResolver cache', () => {
  it('clearCache resets cache stats to 0', () => {
    const resolver = createResolver();
    resolver.clearCache();
    const stats = resolver.getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.keys).toEqual([]);
  });
});

// ===========================================================================
// 3. Error classes
// ===========================================================================

describe('ReferenceResolutionError', () => {
  it('includes resourceId and fieldPath in message', () => {
    const ref = makeRef('myDeploy', 'status.readyReplicas');
    const cause = new Error('not found');
    const err = new ReferenceResolutionError(ref, cause);
    expect(err.message).toContain('myDeploy');
    expect(err.message).toContain('status.readyReplicas');
    expect(err.message).toContain('not found');
    expect(err.name).toBe('ReferenceResolutionError');
    expect(err.cause).toBe(cause);
  });
});

describe('CelExpressionError', () => {
  it('includes expression in message', () => {
    const expr = makeCel('invalid.expr');
    const cause = new Error('parse failed');
    const err = new CelExpressionError(expr, cause);
    expect(err.message).toContain('invalid.expr');
    expect(err.message).toContain('parse failed');
    expect(err.name).toBe('CelExpressionError');
    expect(err.cause).toBe(cause);
  });
});

// ===========================================================================
// 4. Kro mode — CEL/ref to string conversion
// ===========================================================================

describe('ReferenceResolver in Kro mode', () => {
  it('converts KubernetesRef to ${resourceId.fieldPath} string', async () => {
    const resolver = createResolver('kro');
    const resource = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test' },
      id: 'svc',
      spec: { port: makeRef('deployment', 'spec.replicas') },
    };

    const ctx = {
      deployedResources: [],
      kubeClient: createTestKubeConfig(),
      timeout: 5000,
    };

    const result = await resolver.resolveReferences(resource, ctx);
    expect(result.spec.port).toBe('${deployment.spec.replicas}');
  });

  it('converts CelExpression to ${expression} string', async () => {
    const resolver = createResolver('kro');
    const resource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test' },
      id: 'cm',
      data: { ready: makeCel('dep.status.readyReplicas > 0') },
    };

    const ctx = {
      deployedResources: [],
      kubeClient: createTestKubeConfig(),
      timeout: 5000,
    };

    const result = await resolver.resolveReferences(resource, ctx);
    expect(result.data.ready).toBe('${dep.status.readyReplicas > 0}');
  });
});

// ===========================================================================
// 5. Direct mode — field extraction from deployed resources
// ===========================================================================

describe('ReferenceResolver in Direct mode', () => {
  it('resolves KubernetesRef from deployed resource', async () => {
    const resolver = createResolver('direct');
    const resource = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'app' },
      id: 'app',
      spec: { dbPort: makeRef('database', 'spec.port') },
    };

    const ctx = {
      deployedResources: [
        {
          id: 'database',
          kind: 'Service',
          name: 'db',
          namespace: 'default',
          manifest: {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name: 'db' },
            spec: { port: 5432 },
            status: {},
          },
          status: 'deployed' as const,
          deployedAt: new Date(),
        },
      ],
      kubeClient: createTestKubeConfig(),
      timeout: 5000,
    };

    const result = await resolver.resolveReferences(resource, ctx);
    expect(result.spec.dbPort).toBe(5432);
  });

  it('resolves nested field paths with dot notation', async () => {
    const resolver = createResolver('direct');
    const resource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test' },
      id: 'cm',
      data: { host: makeRef('svc', 'status.loadBalancer.ingress') },
    };

    const ctx = {
      deployedResources: [
        {
          id: 'svc',
          kind: 'Service',
          name: 'svc',
          namespace: 'default',
          manifest: {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name: 'svc' },
            status: { loadBalancer: { ingress: '10.0.0.1' } },
          },
          status: 'deployed' as const,
          deployedAt: new Date(),
        },
      ],
      kubeClient: createTestKubeConfig(),
      timeout: 5000,
    };

    const result = await resolver.resolveReferences(resource, ctx);
    expect(result.data.host).toBe('10.0.0.1');
  });

  it('resolves references using resourceKeyMapping', async () => {
    const resolver = createResolver('direct');
    const resource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test' },
      id: 'cm',
      data: { count: makeRef('webappDeploy', 'status.replicas') },
    };

    const resourceKeyMapping = new Map<string, unknown>();
    resourceKeyMapping.set('webappDeploy', {
      status: { replicas: 3 },
    });

    const ctx = {
      deployedResources: [],
      kubeClient: createTestKubeConfig(),
      timeout: 5000,
      resourceKeyMapping,
    };

    const result = await resolver.resolveReferences(resource, ctx);
    expect(result.data.count).toBe(3);
  });
});

// ===========================================================================
// 6. DeploymentMode export
// ===========================================================================

describe('DeploymentMode', () => {
  it('exports KRO and DIRECT constants', async () => {
    const { DeploymentMode } = await import('../../src/core/references/resolver.js');
    expect(DeploymentMode.KRO).toBe('kro');
    expect(DeploymentMode.DIRECT).toBe('direct');
  });
});
