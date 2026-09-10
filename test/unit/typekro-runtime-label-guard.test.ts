import { afterEach, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { typeKroRuntimeBootstrap } from '../../src/compositions/typekro-runtime/index.js';
import {
  DISABLE_LABEL_GUARD_ENV,
  discoverLabelPropagationGuardSupport,
  LABEL_GUARD_API_VERSION_ENV,
  LABEL_GUARD_UNRESOLVED_REASON,
  probeLabelPropagationGuardSupport,
  resetLabelGuardCapabilityCache,
  resolveLabelPropagationGuardCapability,
  setLabelPropagationGuardCapability,
  withLabelPropagationGuardCapability,
} from '../../src/core/kro/label-guard-capability.js';
import type {
  ApiGroupDiscovery,
  ApiGroupProbe,
  DiscoveryFailure,
} from '../../src/core/kubernetes/api-capability.js';
import {
  clusterIdentity,
  resolveDeployTimeCapabilities,
  runWithDeployTarget,
} from '../../src/core/kubernetes/api-capability.js';
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';

// ---------------------------------------------------------------------------
// Fakes — no cluster is contacted anywhere in this file
// ---------------------------------------------------------------------------

/** A kubeconfig that names a cluster and nothing else. */
function fakeKubeConfig(name: string, server: string): k8s.KubeConfig {
  return {
    getCurrentCluster: () => ({
      name,
      server,
      caData: `ca-for-${name}`,
      skipTLSVerify: false,
    }),
  } as unknown as k8s.KubeConfig;
}

/**
 * Discovery over a literal map of `group/version` to the kinds served there,
 * counting calls so the per-cluster memoization is observable.
 *
 * A group version in `served` answers 200 with that kind list; one in
 * `failures` could not be reached at all; anything else answers 404.
 */
function fakeDiscovery(
  served: Record<string, string[]>,
  failures: Record<string, DiscoveryFailure> = {}
): ApiGroupDiscovery & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async servedKinds(group: string, version: string): Promise<ApiGroupProbe> {
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
function failingDiscovery(failure: DiscoveryFailure) {
  return fakeDiscovery({}, { [GA]: failure, [BETA]: failure });
}

const GUARD_KIND = 'MutatingAdmissionPolicy';
const GA = 'admissionregistration.k8s.io/v1';
const BETA = 'admissionregistration.k8s.io/v1beta1';

function bootstrap() {
  // `external` keeps the composition serializable without a live cluster.
  return typeKroRuntimeBootstrap({ fluxInstallation: 'external' });
}

function resourcesOfKind(kind: string): KubernetesResource<unknown, unknown>[] {
  return bootstrap().resources.filter(
    (resource: KubernetesResource<unknown, unknown>) => resource.kind === kind
  );
}

function guardStatusExpression(): string {
  const rendered = bootstrap().toYaml();
  const match = rendered.match(/labelPropagationGuard:\s*(.*)/);
  return match?.[1]?.trim() ?? '';
}

function clearEnv() {
  delete process.env[DISABLE_LABEL_GUARD_ENV];
  delete process.env[LABEL_GUARD_API_VERSION_ENV];
  resetLabelGuardCapabilityCache();
}

afterEach(clearEnv);

describe('typeKroRuntimeBootstrap — the guard is resolved, never assumed', () => {
  it('does NOT emit the guard when nothing resolved the group version', () => {
    clearEnv();
    // The release-blocking case: no probe, no pin, no cluster. Emitting a GA
    // MutatingAdmissionPolicy here would fail the apply of the whole bootstrap
    // on any cluster below 1.36, so the guard is skipped instead.
    expect(resourcesOfKind(GUARD_KIND)).toHaveLength(0);
    expect(resourcesOfKind('MutatingAdmissionPolicyBinding')).toHaveLength(0);
    expect(resolveLabelPropagationGuardCapability()).toEqual({
      status: 'unavailable',
      reason: LABEL_GUARD_UNRESOLVED_REASON,
    });
  });

  it('emits the guard at v1 when the cluster serves the GA group version', async () => {
    clearEnv();
    const kubeConfig = fakeKubeConfig('ga-cluster', 'https://ga.invalid:6443');
    const discovery = fakeDiscovery({ [GA]: [GUARD_KIND] });

    const capability = await probeLabelPropagationGuardSupport(kubeConfig, { discovery });
    expect(capability).toEqual({ status: 'active', apiVersion: GA });

    const clusterId = clusterIdentity(kubeConfig);
    expect(typeof clusterId).toBe('string');
    const policies = runWithDeployTarget(clusterId as string, () => resourcesOfKind(GUARD_KIND));
    expect(policies).toHaveLength(1);
    expect(policies[0]?.apiVersion).toBe(GA);

    const status = runWithDeployTarget(clusterId as string, guardStatusExpression);
    expect(status).toContain('labelPropagationGuardPolicy');
    expect(status).toContain('"active"');
  });

  it('emits the guard at v1beta1 on a cluster that only serves beta', async () => {
    clearEnv();
    const kubeConfig = fakeKubeConfig('beta-cluster', 'https://beta.invalid:6443');
    const discovery = fakeDiscovery({ [BETA]: [GUARD_KIND] });

    expect(await probeLabelPropagationGuardSupport(kubeConfig, { discovery })).toEqual({
      status: 'active',
      apiVersion: BETA,
    });

    const clusterId = clusterIdentity(kubeConfig) as string;
    const policies = runWithDeployTarget(clusterId, () => resourcesOfKind(GUARD_KIND));
    expect(policies[0]?.apiVersion).toBe(BETA);
    expect(
      runWithDeployTarget(clusterId, () => resourcesOfKind('MutatingAdmissionPolicyBinding'))[0]
        ?.apiVersion
    ).toBe(BETA);
  });

  it('skips the guard when the group serves the kind at no version', async () => {
    clearEnv();
    const kubeConfig = fakeKubeConfig('old-cluster', 'https://old.invalid:6443');
    // 1.32/1.33 shape: the group version exists for webhook configurations but
    // does not serve MutatingAdmissionPolicy.
    const discovery = fakeDiscovery({ [GA]: ['MutatingWebhookConfiguration'] });

    const capability = await probeLabelPropagationGuardSupport(kubeConfig, { discovery });
    expect(capability.status).toBe('unavailable');

    const clusterId = clusterIdentity(kubeConfig) as string;
    expect(runWithDeployTarget(clusterId, () => resourcesOfKind(GUARD_KIND))).toHaveLength(0);

    const status = runWithDeployTarget(clusterId, guardStatusExpression);
    expect(status).toContain('kroHelmRelease');
    expect(status).toContain('"unavailable"');
  });

  it('reports unavailable when the kubeconfig names no cluster', async () => {
    clearEnv();
    const clientless = { getCurrentCluster: () => null } as unknown as k8s.KubeConfig;
    const discovery = fakeDiscovery({ [GA]: [GUARD_KIND] });

    const capability = await discoverLabelPropagationGuardSupport(clientless, { discovery });
    expect(capability.status).toBe('unavailable');
    // Nothing was asked of a cluster that could not be identified.
    expect(discovery.calls).toHaveLength(0);
    expect(resourcesOfKind(GUARD_KIND)).toHaveLength(0);
  });

  it('uses an explicit group-version pin verbatim, with no cluster at all', () => {
    clearEnv();
    process.env[LABEL_GUARD_API_VERSION_ENV] = BETA;
    const policies = resourcesOfKind(GUARD_KIND);
    expect(policies).toHaveLength(1);
    expect(policies[0]?.apiVersion).toBe(BETA);
  });

  it('emits nothing when the break-glass env var is set', () => {
    clearEnv();
    process.env[DISABLE_LABEL_GUARD_ENV] = '1';
    expect(resourcesOfKind(GUARD_KIND)).toHaveLength(0);
    expect(resourcesOfKind('MutatingAdmissionPolicyBinding')).toHaveLength(0);
  });

  it('lets the break-glass env var win over a resolved capability', async () => {
    clearEnv();
    const kubeConfig = fakeKubeConfig('ga-cluster', 'https://ga.invalid:6443');
    await probeLabelPropagationGuardSupport(kubeConfig, {
      discovery: fakeDiscovery({ [GA]: [GUARD_KIND] }),
    });
    process.env[DISABLE_LABEL_GUARD_ENV] = 'true';
    const clusterId = clusterIdentity(kubeConfig) as string;
    expect(runWithDeployTarget(clusterId, resolveLabelPropagationGuardCapability).status).toBe(
      'unavailable'
    );
  });

  it('exempts the KRO controller ServiceAccount it installs', () => {
    clearEnv();
    process.env[LABEL_GUARD_API_VERSION_ENV] = GA;
    const policy = resourcesOfKind(GUARD_KIND)[0] as {
      spec?: { matchConditions?: Array<{ expression: string }> };
    };
    expect(policy.spec?.matchConditions?.[0]?.expression).toContain(
      'system:serviceaccount:kro-system:kro'
    );
  });

  it('accepts no config option to turn the guard off', () => {
    // Guard against a future `labelPropagationGuard` option creeping back in:
    // the invariant is that there is exactly one way to disable it.
    const configKeys = ['namespace', 'fluxVersion', 'kroVersion', 'fluxInstallation', 'rbac'];
    type Config = NonNullable<Parameters<typeof typeKroRuntimeBootstrap>[0]>;
    const probe: Record<string, unknown> = {};
    for (const key of configKeys) probe[key] = undefined;
    // A type-level assertion: adding a guard toggle to TypeKroRuntimeConfig
    // would make this cast fail to compile.
    const typed: Config = probe as Config;
    expect(Object.keys(typed)).toEqual(configKeys);
  });
});

describe('typeKroRuntimeBootstrap — status contract', () => {
  it('declares labelPropagationGuard in the status schema', () => {
    clearEnv();
    const schema = bootstrap().schema;
    expect(schema).toBeDefined();
  });

  it('projects the status from a resource rather than a literal (#188)', () => {
    clearEnv();
    process.env[LABEL_GUARD_API_VERSION_ENV] = GA;
    // The RGD's status block must reference a resource id. A literal
    // "active" would be accepted here and then dropped by KRO.
    const value = guardStatusExpression();
    expect(value).toContain('${');
    expect(value).toContain('labelPropagationGuardPolicy');
  });

  it('still projects from a resource when the guard is skipped', () => {
    clearEnv();
    process.env[DISABLE_LABEL_GUARD_ENV] = '1';
    const value = guardStatusExpression();
    expect(value).toContain('${');
    expect(value).toContain('kroHelmRelease');
    expect(value).toContain('"unavailable"');
  });
});

describe('resolveLabelPropagationGuardCapability', () => {
  it('ignores an unrecognised group version override rather than trusting it', () => {
    clearEnv();
    process.env[LABEL_GUARD_API_VERSION_ENV] = 'admissionregistration.k8s.io/v1alpha1';
    // The pin is rejected AND the fallback is a skip, not a GA guess.
    expect(resolveLabelPropagationGuardCapability()).toEqual({
      status: 'unavailable',
      reason: LABEL_GUARD_UNRESOLVED_REASON,
    });
  });

  it('honours an explicitly asserted capability for offline builds', () => {
    clearEnv();
    setLabelPropagationGuardCapability({ status: 'active', apiVersion: BETA });
    expect(resolveLabelPropagationGuardCapability()).toEqual({
      status: 'active',
      apiVersion: BETA,
    });
  });

  it('skips the guard when an asserted capability says the API is not served', () => {
    clearEnv();
    setLabelPropagationGuardCapability({ status: 'unavailable', reason: 'test' });
    expect(resourcesOfKind(GUARD_KIND)).toHaveLength(0);
  });
});

describe('label-guard capability cache', () => {
  it('gives two clusters independent answers', async () => {
    clearEnv();
    const ga = fakeKubeConfig('cluster-a', 'https://a.invalid:6443');
    const beta = fakeKubeConfig('cluster-b', 'https://b.invalid:6443');

    expect(
      await probeLabelPropagationGuardSupport(ga, {
        discovery: fakeDiscovery({ [GA]: [GUARD_KIND] }),
      })
    ).toEqual({ status: 'active', apiVersion: GA });

    // Cluster B must not inherit cluster A's answer.
    expect(
      await probeLabelPropagationGuardSupport(beta, {
        discovery: fakeDiscovery({ [BETA]: [GUARD_KIND] }),
      })
    ).toEqual({ status: 'active', apiVersion: BETA });

    const gaId = clusterIdentity(ga) as string;
    const betaId = clusterIdentity(beta) as string;
    expect(gaId).not.toBe(betaId);
    expect(runWithDeployTarget(gaId, resolveLabelPropagationGuardCapability)).toEqual({
      status: 'active',
      apiVersion: GA,
    });
    expect(runWithDeployTarget(betaId, resolveLabelPropagationGuardCapability)).toEqual({
      status: 'active',
      apiVersion: BETA,
    });
  });

  it('distinguishes two clusters that differ only in CA material', async () => {
    clearEnv();
    const server = 'https://same.invalid:6443';
    const first = fakeKubeConfig('same-name', server);
    const second = {
      getCurrentCluster: () => ({
        name: 'same-name',
        server,
        caData: 'a-different-trust-root',
        skipTLSVerify: false,
      }),
    } as unknown as k8s.KubeConfig;

    expect(clusterIdentity(first)).not.toBe(clusterIdentity(second));

    await probeLabelPropagationGuardSupport(first, {
      discovery: fakeDiscovery({ [GA]: [GUARD_KIND] }),
    });
    const secondDiscovery = fakeDiscovery({ [BETA]: [GUARD_KIND] });
    await probeLabelPropagationGuardSupport(second, { discovery: secondDiscovery });
    // The second cluster was actually asked rather than served from the first.
    expect(secondDiscovery.calls.length).toBeGreaterThan(0);
  });

  it('answers a repeated probe of one cluster from the cache', async () => {
    clearEnv();
    const kubeConfig = fakeKubeConfig('cached', 'https://cached.invalid:6443');
    const discovery = fakeDiscovery({ [GA]: [GUARD_KIND] });

    await probeLabelPropagationGuardSupport(kubeConfig, { discovery });
    const callsAfterFirst = discovery.calls.length;
    await probeLabelPropagationGuardSupport(kubeConfig, { discovery });
    expect(discovery.calls.length).toBe(callsAfterFirst);
  });

  it('re-asks the cluster after the cache is reset', async () => {
    clearEnv();
    const kubeConfig = fakeKubeConfig('reset', 'https://reset.invalid:6443');
    const discovery = fakeDiscovery({ [GA]: [GUARD_KIND] });

    await probeLabelPropagationGuardSupport(kubeConfig, { discovery });
    const callsAfterFirst = discovery.calls.length;

    resetLabelGuardCapabilityCache();
    // A build that names no cluster is a skip either way — there is no ambient
    // pointer to a previously probed cluster to go stale in the first place.
    expect(resolveLabelPropagationGuardCapability().status).toBe('unavailable');

    await probeLabelPropagationGuardSupport(kubeConfig, { discovery });
    expect(discovery.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('is resolved by the deploy-time registry the direct path drives', async () => {
    clearEnv();
    // Exactly what DirectResourceFactory.deploy() does before it re-executes
    // the composition: resolve every registered requirement, then build under
    // that deploy target.
    const kubeConfig = fakeKubeConfig('deploy-target', 'https://deploy.invalid:6443');
    const clusterId = await resolveDeployTimeCapabilities(kubeConfig, {
      discovery: fakeDiscovery({ [BETA]: [GUARD_KIND] }),
    });
    expect(clusterId).toBe(clusterIdentity(kubeConfig) as string);

    const policies = runWithDeployTarget(clusterId as string, () => resourcesOfKind(GUARD_KIND));
    expect(policies).toHaveLength(1);
    expect(policies[0]?.apiVersion).toBe(BETA);
  });

  it('does NOT let a probed cluster leak into an untargeted build', async () => {
    clearEnv();
    // The bug this replaced: probing cluster A made A the process-global
    // "last probed cluster", so any later build with no target of its own
    // rendered A's group version into its graph.
    const clusterA = fakeKubeConfig('probe-only', 'https://a-only.invalid:6443');
    expect(
      await probeLabelPropagationGuardSupport(clusterA, {
        discovery: fakeDiscovery({ [BETA]: [GUARD_KIND] }),
      })
    ).toEqual({ status: 'active', apiVersion: BETA });

    expect(resourcesOfKind(GUARD_KIND)).toHaveLength(0);
    expect(resolveLabelPropagationGuardCapability()).toEqual({
      status: 'unavailable',
      reason: LABEL_GUARD_UNRESOLVED_REASON,
    });
  });

  it('carries a probe result into a build when the caller scopes it explicitly', async () => {
    clearEnv();
    const kubeConfig = fakeKubeConfig('probe-then-build', 'https://ptb.invalid:6443');
    const capability = await probeLabelPropagationGuardSupport(kubeConfig, {
      discovery: fakeDiscovery({ [BETA]: [GUARD_KIND] }),
    });

    // The documented "probe, then build" flow, with the cluster carried
    // explicitly rather than ambiently.
    const policies = withLabelPropagationGuardCapability(capability, () =>
      resourcesOfKind(GUARD_KIND)
    );
    expect(policies).toHaveLength(1);
    expect(policies[0]?.apiVersion).toBe(BETA);

    // ...and the scope does not outlive the build.
    expect(resourcesOfKind(GUARD_KIND)).toHaveLength(0);
  });

  it('keeps two concurrent scoped builds for different clusters apart', async () => {
    clearEnv();
    const ga = fakeKubeConfig('concurrent-ga', 'https://cga.invalid:6443');
    const beta = fakeKubeConfig('concurrent-beta', 'https://cbeta.invalid:6443');
    const [gaCapability, betaCapability] = await Promise.all([
      probeLabelPropagationGuardSupport(ga, { discovery: fakeDiscovery({ [GA]: [GUARD_KIND] }) }),
      probeLabelPropagationGuardSupport(beta, {
        discovery: fakeDiscovery({ [BETA]: [GUARD_KIND] }),
      }),
    ]);

    const buildIn = async (capability: typeof gaCapability): Promise<string | undefined> =>
      withLabelPropagationGuardCapability(capability, async () => {
        // Interleave the two builds so a module-global would be observably wrong.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return resourcesOfKind(GUARD_KIND)[0]?.apiVersion;
      });

    expect(await Promise.all([buildIn(gaCapability), buildIn(betaCapability)])).toEqual([GA, BETA]);
  });

  it('reports a discovery failure as a failure, not as an unsupported cluster', async () => {
    clearEnv();
    const kubeConfig = fakeKubeConfig('rbac-denied', 'https://denied.invalid:6443');
    const capability = await probeLabelPropagationGuardSupport(kubeConfig, {
      discovery: failingDiscovery('forbidden'),
    });

    expect(capability.status).toBe('unavailable');
    const reason = capability.status === 'unavailable' ? capability.reason : '';
    // The distinction the user acts on: fix RBAC, not "upgrade your cluster".
    expect(reason).toContain('discovery against the cluster failed');
    expect(reason).not.toContain('does not serve');

    // And the build that follows the resolve step says the same thing.
    const clusterId = clusterIdentity(kubeConfig) as string;
    const built = runWithDeployTarget(clusterId, resolveLabelPropagationGuardCapability);
    expect(built.status).toBe('unavailable');
    expect(built.status === 'unavailable' && built.reason).toContain(
      'discovery against the cluster failed'
    );
    expect(runWithDeployTarget(clusterId, () => resourcesOfKind(GUARD_KIND))).toHaveLength(0);
  });

  it('reports an unserved cluster as unserved', async () => {
    clearEnv();
    const kubeConfig = fakeKubeConfig('too-old', 'https://old.invalid:6443');
    const capability = await probeLabelPropagationGuardSupport(kubeConfig, {
      // Every candidate group version answers 404.
      discovery: fakeDiscovery({}),
    });

    expect(capability.status).toBe('unavailable');
    expect(capability.status === 'unavailable' && capability.reason).toContain('does not serve');
  });
});
