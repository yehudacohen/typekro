import { afterEach, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import {
  type ApiGroupDiscovery,
  CLUSTER_CAPABILITY_CACHE_MAX_ENTRIES,
  CLUSTER_CAPABILITY_CACHE_TTL_MS,
  CLUSTER_CAPABILITY_UNKNOWN_CACHE_TTL_MS,
  type ClusterCapabilityRequirement,
  clusterCapabilityCacheSize,
  clusterIdentity,
  type DiscoveryFailure,
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

/**
 * Discovery over a literal `group/version → kinds` map.
 *
 * A group version present in `served` answers with that kind list (a 200); one
 * present in `failures` could not be reached at all; anything else answers 404.
 */
function fakeDiscovery(
  served: Record<string, string[]>,
  failures: Record<string, DiscoveryFailure> = {}
): ApiGroupDiscovery & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async servedKinds(group, version) {
      const groupVersion = `${group}/${version}`;
      calls.push(groupVersion);
      const failure = failures[groupVersion];
      if (failure) {
        return { status: 'unknown', failure, message: `${failure} talking to ${groupVersion}` };
      }
      const kinds = served[groupVersion];
      if (kinds) return { status: 'served', kinds };
      return { status: 'unserved' };
    },
  };
}

/** Every candidate group version fails the same way. */
function unreachableDiscovery(failure: DiscoveryFailure) {
  return fakeDiscovery(
    {},
    { 'example.io/v1': failure, 'example.io/v1beta1': failure }
  );
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

  it('reports unserved for a 200 list that does not contain the kind', async () => {
    // The group version exists — 1.32/1.33 serve admissionregistration/v1 for
    // webhook configs — it just does not carry this kind. That is an answer.
    const resolution = await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery: fakeDiscovery({
        'example.io/v1': ['SomethingElse'],
        'example.io/v1beta1': ['SomethingElse'],
      }),
    });
    expect(resolution.status).toBe('unserved');
    expect(getCachedClusterCapability(REQUIREMENT, 'cluster-a')?.status).toBe('unserved');
  });

  it('caches a definitive 404 as unserved', async () => {
    const resolution = await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery: fakeDiscovery({}),
    });
    expect(resolution.status).toBe('unserved');
    expect(getCachedClusterCapability(REQUIREMENT, 'cluster-a')).toEqual(resolution);
  });

  it.each([['forbidden'], ['unreachable'], ['timeout'], ['other']] as const)(
    'reports unknown rather than unserved when discovery fails (%s)',
    async (failure) => {
      const resolution = await resolveClusterCapability(REQUIREMENT, {
        clusterId: 'cluster-a',
        discovery: unreachableDiscovery(failure),
      });

      expect(resolution.status).toBe('unknown');
      expect(resolution.status === 'unknown' && resolution.failure).toBe(failure);
      // The reason must not claim anything about what the cluster serves.
      const reason = resolution.status === 'unknown' ? resolution.reason : '';
      expect(reason).toContain('discovery against the cluster failed');
      expect(reason).not.toContain('does not serve');
    }
  );

  it('does not let an unknown answer a later call — a retry re-probes and can serve', async () => {
    const failing = unreachableDiscovery('forbidden');
    expect(
      (await resolveClusterCapability(REQUIREMENT, { clusterId: 'cluster-a', discovery: failing }))
        .status
    ).toBe('unknown');

    // Same cluster key, no refresh flag, RBAC now fixed. The stored unknown is
    // a failure note, not an answer, so it must not short-circuit this.
    const recovered = fakeDiscovery({ 'example.io/v1': ['Widget'] });
    expect(
      await resolveClusterCapability(REQUIREMENT, { clusterId: 'cluster-a', discovery: recovered })
    ).toEqual({ status: 'served', apiVersion: 'example.io/v1' });
    expect(recovered.calls).toEqual(['example.io/v1']);
  });

  it('keeps the unknown reportable so a caller can say discovery failed', async () => {
    await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery: unreachableDiscovery('unreachable'),
    });
    // Readable by the reporting path — that is the whole reason it is retained.
    expect(getCachedClusterCapability(REQUIREMENT, 'cluster-a')?.status).toBe('unknown');
  });

  it('expires an unknown far sooner than a real answer', async () => {
    await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery: unreachableDiscovery('timeout'),
      unknownTtlMs: -1,
    });
    expect(getCachedClusterCapability(REQUIREMENT, 'cluster-a')).toBeUndefined();
    expect(CLUSTER_CAPABILITY_UNKNOWN_CACHE_TTL_MS).toBeLessThan(CLUSTER_CAPABILITY_CACHE_TTL_MS);
  });

  it('is unknown when the served version is checked but a candidate could not be', async () => {
    // v1 answered 404, v1beta1 could not be reached. The kind may well be
    // served at v1beta1, so "not served" would be a fabrication.
    const resolution = await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery: fakeDiscovery({}, { 'example.io/v1beta1': 'forbidden' }),
    });
    expect(resolution.status).toBe('unknown');
  });

  it('still serves when an earlier candidate failed but a later one serves the kind', async () => {
    const resolution = await resolveClusterCapability(REQUIREMENT, {
      clusterId: 'cluster-a',
      discovery: fakeDiscovery({ 'example.io/v1beta1': ['Widget'] }, { 'example.io/v1': 'timeout' }),
    });
    expect(resolution).toEqual({ status: 'served', apiVersion: 'example.io/v1beta1' });
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
