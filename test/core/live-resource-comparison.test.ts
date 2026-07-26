import { describe, expect, it } from 'bun:test';
import { setMetadataField } from '../../src/core/metadata/index.js';
import { registerFactory } from '../../src/core/resources/factory-registry.js';
import {
  compareKubernetesResources,
  diffCanonicalValues,
} from '../../src/core/resources/live-comparison.js';
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';
import { networkPolicy } from '../../src/factories/kubernetes/networking/network-policy.js';

describe('canonical desired/live resource comparison', () => {
  it('normalizes NetworkPolicy empty arrays and API-server metadata without semantic drift', () => {
    const desired = networkPolicy({
      id: 'policy',
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'deny-ingress', namespace: 'apps' },
      spec: { podSelector: {}, ingress: [] },
    });
    const live: KubernetesResource = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'deny-ingress',
        namespace: 'apps',
        uid: '1234',
        resourceVersion: '99',
        generation: 4,
        creationTimestamp: new Date('2026-07-22T00:00:00Z'),
        labels: { 'typekro.io/factory': 'fixture' },
      },
      spec: { podSelector: {}, policyTypes: ['Ingress'] },
      status: { observedGeneration: 4 },
    };

    const comparison = compareKubernetesResources(desired, live);

    expect(comparison.equal).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(comparison.canonicalizers).toEqual([
      {
        id: 'kubernetes.networking.k8s.io/network-policy',
        revision: '1',
        stage: 'desired',
        factoryName: 'NetworkPolicy',
      },
      {
        id: 'kubernetes.networking.k8s.io/network-policy-comparison',
        revision: '1',
        stage: 'live-comparison',
        factoryName: 'NetworkPolicy',
      },
    ]);
  });

  it('reports exact deterministic paths while ignoring fields owned only by live state', () => {
    const desired: KubernetesResource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'settings' },
      data: { mode: 'strict' },
    };
    const live: KubernetesResource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'settings', labels: { injected: 'true' } },
      data: { mode: 'permissive', injected: 'controller-value' },
    };

    const comparison = compareKubernetesResources(desired, live, { includeValues: true });

    expect(comparison.equal).toBe(false);
    expect(comparison.differences).toEqual([
      expect.objectContaining({
        path: '$.data.mode',
        kind: 'value-mismatch',
        desired: expect.objectContaining({ preview: '"strict"' }),
        live: expect.objectContaining({ preview: '"permissive"' }),
      }),
    ]);
  });

  it('redacts Secret bytes even when value previews are requested', () => {
    const desired: KubernetesResource = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'credentials' },
      data: { password: 'c2VjcmV0' },
    };
    const live: KubernetesResource = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'credentials' },
      data: { password: 'Y2hhbmdlZA==' },
    };

    const comparison = compareKubernetesResources(desired, live, { includeValues: true });
    const difference = comparison.differences[0];

    expect(difference).toEqual(
      expect.objectContaining({ path: '$.data.password', kind: 'value-mismatch' })
    );
    expect(difference?.desired).toEqual({ type: 'string', redacted: true });
    expect(difference?.live).toEqual({ type: 'string', redacted: true });
    expect(JSON.stringify(comparison)).not.toContain('c2VjcmV0');
    expect(JSON.stringify(comparison)).not.toContain('Y2hhbmdlZA');
  });

  it('supports exact value comparison when additional live fields are meaningful', () => {
    expect(
      diffCanonicalValues(
        { spec: { replicas: 2 } },
        { spec: { replicas: 2, mode: 'extra' } },
        { ignoreAdditionalLiveFields: false }
      )
    ).toEqual([
      expect.objectContaining({
        path: '$.spec.mode',
        kind: 'unexpected-live-value',
      }),
    ]);
  });

  it('rejects nondeterministic live canonicalizers', () => {
    let invocation = 0;
    registerFactory({
      factoryName: 'NondeterministicLiveWidget',
      apiVersion: 'testing.typekro.dev/v1',
      kind: 'NondeterministicLiveWidget',
      liveCanonicalizer: {
        id: 'testing.typekro.dev/nondeterministic-live-widget',
        revision: '1',
        canonicalize: (resource) => ({ ...resource, nonce: invocation++ }),
      },
    });
    const desired: KubernetesResource = {
      apiVersion: 'testing.typekro.dev/v1',
      kind: 'NondeterministicLiveWidget',
      metadata: { name: 'fixture' },
      spec: {},
    };
    setMetadataField(desired, 'factoryName', 'NondeterministicLiveWidget');

    expect(() => compareKubernetesResources(desired, desired)).toThrow(
      'produced different outputs for identical inputs'
    );
  });

  it('requires exact factory provenance for a hooked GVK with multiple factories', () => {
    const canonicalize = (resource: KubernetesResource): KubernetesResource => resource;
    for (const factoryName of ['AmbiguousComparisonA', 'AmbiguousComparisonB']) {
      registerFactory({
        factoryName,
        apiVersion: 'testing.typekro.dev/v1',
        kind: 'AmbiguousComparison',
        liveCanonicalizer: {
          id: 'testing.typekro.dev/ambiguous-comparison',
          revision: '1',
          canonicalize,
        },
      });
    }
    const resource: KubernetesResource = {
      apiVersion: 'testing.typekro.dev/v1',
      kind: 'AmbiguousComparison',
      metadata: { name: 'fixture' },
      spec: {},
    };

    expect(() => compareKubernetesResources(resource, resource)).toThrow(
      'multiple factories are registered'
    );
    expect(
      compareKubernetesResources(resource, resource, { factoryName: 'AmbiguousComparisonA' }).equal
    ).toBe(true);
  });

  it('rejects explicit or retained factory provenance that is not registered', () => {
    const resource: KubernetesResource = {
      apiVersion: 'testing.typekro.dev/v1',
      kind: 'UnregisteredComparison',
      metadata: { name: 'fixture' },
      spec: {},
    };

    expect(() =>
      compareKubernetesResources(resource, resource, { factoryName: 'MissingFactory' })
    ).toThrow('Factory provenance MissingFactory is not registered');

    setMetadataField(resource, 'factoryName', 'MissingFactory');
    expect(() => compareKubernetesResources(resource, resource)).toThrow(
      'Factory provenance MissingFactory is not registered'
    );
  });
});
