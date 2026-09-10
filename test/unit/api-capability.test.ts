import { afterEach, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import {
  type ApiGroupDiscovery,
  CLUSTER_CAPABILITY_CACHE_MAX_ENTRIES,
  type ClusterCapabilityRequirement,
  clusterCapabilityCacheSize,
  clusterIdentity,
  getCachedClusterCapability,
  getCurrentDeployTarget,
  listDeployTimeCapabilities,
  registerDeployTimeCapability,
  resetClusterCapabilityCache,
  resolveClusterCapability,
  resolveDeployTimeCapabilities,
  runWithDeployTarget,
} from '../../src/core/kubernetes/api-capability.js';

const REQUIREMENT: ClusterCapabilityRequirement = {
  id: 'test-capability',
  group: 'example.io',
  kind: 'Widget',
  versions: ['v1', 'v1beta1'],
};

function fakeKubeConfig(overrides: Record<string, unknown> = {}): k8s.KubeConfig {
  return {
    getCurrentCluster: () => ({
      name: 'fake',
      server: 'https://fake.invalid:6443',
      caData: 'ca',
      skipTLSVerify: false,
      ...overrides,
    }),
  } as unknown as k8s.KubeConfig;
}

function fakeDiscovery(served: Record<string, string[]>): ApiGroupDiscovery & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async servedKinds(group, version) {
      calls.push(`${group}/${version}`);
      return served[`${group}/${version}`];
    },
  };
}

afterEach(() => {
  resetClusterCapabilityCache();
});

describe('clusterIdentity', () => {
  it('is stable for the same cluster and differs across servers', () => {
    const first = fakeKubeConfig();
    const second = fakeKubeConfig();
    expect(clusterIdentity(first)).toBe(clusterIdentity(second) as string);
    expect(clusterIdentity(fakeKubeConfig({ server: 'https://other.invalid:6443' }))).not.toBe(
      clusterIdentity(first)
    );
  });

  it('is undefined when no current cluster is set', () => {
    expect(
      clusterIdentity({ getCurrentCluster: () => null } as unknown as k8s.KubeConfig)
    ).toBeUndefined();
  });

  it('is undefined when reading the current cluster throws', () => {
    const broken = {
      getCurrentCluster: () => {
        throw new Error('no kubeconfig');
      },
    } as unknown as k8s.KubeConfig;
    expect(clusterIdentity(broken)).toBeUndefined();
  });
});

describe('resolveClusterCapability', () => {
  it('picks the first served version in preference order', async () => {
    const discovery = fakeDiscovery({
      'example.io/v1': ['Widget'],
      'example.io/v1beta1': ['Widget'],
    });
    expect(
      await resolveClusterCapability(REQUIREMENT, { clusterId: 'cluster-a', discovery })
    ).toEqual({ status: 'served', apiVersion: 'example.io/v1' });
    // Stopped as soon as it had an answer.
    expect(discovery.calls).toEqual(['example.io/v1']);
  });

  it('falls through to the beta version when GA does not serve the kind', async () => {
    const discovery = fakeDiscovery({
      'example.io/v1': ['SomethingElse'],
      'example.io/v1beta1': ['Widget'],
    });
    expect(
      await resolveClusterCapability(REQUIREMENT, { clusterId: 'cluster-a', discovery })
    ).toEqual({ status: 'served', apiVersion: 'example.io/v1beta1' });
  });

  it('reports unserved rather than guessing a version', async () => {
    const resolution = await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery: fakeDiscovery({}),
    });
    expect(resolution.status).toBe('unserved');
    expect(resolution.status === 'unserved' && resolution.reason).toContain('example.io/v1beta1');
  });

  it('never answers one cluster from another cluster cache entry', async () => {
    await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery: fakeDiscovery({ 'example.io/v1': ['Widget'] }),
    });
    const bDiscovery = fakeDiscovery({ 'example.io/v1beta1': ['Widget'] });
    const b = await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-b',
      discovery: bDiscovery,
    });

    expect(b).toEqual({ status: 'served', apiVersion: 'example.io/v1beta1' });
    expect(bDiscovery.calls.length).toBeGreaterThan(0);
    expect(getCachedClusterCapability(REQUIREMENT, 'cluster-a')).toEqual({
      status: 'served',
      apiVersion: 'example.io/v1',
    });
  });

  it('serves a repeat call from the cache and re-asks on refresh', async () => {
    const discovery = fakeDiscovery({ 'example.io/v1': ['Widget'] });
    await resolveClusterCapability(REQUIREMENT, { clusterId: 'cluster-a', discovery });
    await resolveClusterCapability(REQUIREMENT, { clusterId: 'cluster-a', discovery });
    expect(discovery.calls).toHaveLength(1);

    await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery,
      refresh: true,
    });
    expect(discovery.calls).toHaveLength(2);
  });

  it('expires an entry once its lifetime is up', async () => {
    const discovery = fakeDiscovery({ 'example.io/v1': ['Widget'] });
    await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery,
      ttlMs: -1,
    });
    expect(getCachedClusterCapability(REQUIREMENT, 'cluster-a')).toBeUndefined();
  });

  it('keeps the cache bounded across many clusters', async () => {
    const discovery = fakeDiscovery({ 'example.io/v1': ['Widget'] });
    for (let index = 0; index < CLUSTER_CAPABILITY_CACHE_MAX_ENTRIES + 10; index++) {
      await resolveClusterCapability(REQUIREMENT, { clusterId: `cluster-${index}`, discovery });
    }
    expect(clusterCapabilityCacheSize()).toBe(CLUSTER_CAPABILITY_CACHE_MAX_ENTRIES);
    // The oldest cluster was evicted; the newest is still there.
    expect(getCachedClusterCapability(REQUIREMENT, 'cluster-0')).toBeUndefined();
    expect(
      getCachedClusterCapability(REQUIREMENT, `cluster-${CLUSTER_CAPABILITY_CACHE_MAX_ENTRIES + 9}`)
    ).toEqual({ status: 'served', apiVersion: 'example.io/v1' });
  });

  it('resets to empty', async () => {
    await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery: fakeDiscovery({ 'example.io/v1': ['Widget'] }),
    });
    resetClusterCapabilityCache();
    expect(clusterCapabilityCacheSize()).toBe(0);
    expect(getCachedClusterCapability(REQUIREMENT, 'cluster-a')).toBeUndefined();
  });
});

describe('deploy-time capability registry', () => {
  it('registers idempotently', () => {
    registerDeployTimeCapability(REQUIREMENT);
    registerDeployTimeCapability(REQUIREMENT);
    const matching = listDeployTimeCapabilities().filter((entry) => entry.id === REQUIREMENT.id);
    expect(matching).toHaveLength(1);
  });

  it('resolves every registered requirement and returns the cluster identity', async () => {
    registerDeployTimeCapability(REQUIREMENT);
    const kubeConfig = fakeKubeConfig();
    const clusterId = await resolveDeployTimeCapabilities(kubeConfig, {
      discovery: fakeDiscovery({ 'example.io/v1beta1': ['Widget'] }),
    });

    expect(clusterId).toBe(clusterIdentity(kubeConfig) as string);
    expect(getCachedClusterCapability(REQUIREMENT, clusterId as string)).toEqual({
      status: 'served',
      apiVersion: 'example.io/v1beta1',
    });
  });

  it('resolves nothing when the kubeconfig names no cluster', async () => {
    registerDeployTimeCapability(REQUIREMENT);
    const discovery = fakeDiscovery({ 'example.io/v1': ['Widget'] });
    const clusterId = await resolveDeployTimeCapabilities(
      { getCurrentCluster: () => null } as unknown as k8s.KubeConfig,
      { discovery }
    );
    expect(clusterId).toBeUndefined();
    expect(discovery.calls).toHaveLength(0);
  });
});

describe('deploy target context', () => {
  it('is undefined outside a deployment', () => {
    expect(getCurrentDeployTarget()).toBeUndefined();
  });

  it('is visible to synchronous code inside the deployment', () => {
    const seen = runWithDeployTarget('cluster-a', () => getCurrentDeployTarget());
    expect(seen).toBe('cluster-a');
    expect(getCurrentDeployTarget()).toBeUndefined();
  });

  it('keeps concurrent deployments to different clusters apart', async () => {
    const observe = async (clusterId: string): Promise<string | undefined> =>
      runWithDeployTarget(clusterId, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getCurrentDeployTarget();
      });

    expect(await Promise.all([observe('cluster-a'), observe('cluster-b')])).toEqual([
      'cluster-a',
      'cluster-b',
    ]);
  });
});
