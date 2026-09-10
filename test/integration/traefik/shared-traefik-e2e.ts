/**
 * Assertions shared by the Traefik direct-mode and KRO-mode integration
 * suites.
 *
 * They live here so the two modes are held to the SAME bar: the same status
 * contract, the same in-cluster HelmRelease values, and the same pod ground
 * truth. A mode-specific assertion would let one mode pass on weaker evidence
 * than the other, which is exactly what these suites exist to rule out.
 *
 * Everything goes through the shared Bun-compatible Kubernetes clients — no
 * `kubectl` — so the assertions stay correct when only the harness is running.
 */
import { expect } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';

import { TRAEFIK_POD_NAME_LABEL_VALUE } from '../../../src/factories/traefik/constants.js';
import { createCoreV1ApiClient, createCustomObjectsApiClient } from '../shared-kubeconfig.js';

/** Every field `TraefikBootstrapStatusSchema` declares. */
export interface ObservedTraefikStatus {
  ready?: boolean;
  failed?: boolean;
  phase?: string;
  serviceName?: string;
  version?: string;
  loadBalancer?: { hostname?: string; ip?: string };
}

/** The `spec` of a Flux HelmRelease as read back from the API server. */
export interface ObservedHelmRelease {
  spec?: {
    chart?: { spec?: { chart?: string; version?: string } };
    targetNamespace?: string;
    releaseName?: string;
    install?: { crds?: string };
    upgrade?: { crds?: string };
    values?: Record<string, Record<string, unknown> | unknown>;
  };
  status?: { history?: { chartVersion?: string }[] };
}

/**
 * Assert every field the bootstrap status schema declares.
 *
 * `expectedLoadBalancer` is the address shape the environment can actually
 * produce: kind has no load-balancer controller, so a `ClusterIP` entrypoint
 * Service yields the documented empty pair, and a written-back address yields
 * that address. Either way the PROJECTION is exercised — the assertion is
 * never "the field is missing".
 */
export function assertTraefikStatusContract(
  status: ObservedTraefikStatus | undefined,
  expected: {
    serviceName: string;
    chartVersion: string;
    loadBalancer: { hostname: string; ip: string };
  }
): void {
  expect(status).toBeDefined();
  expect(status?.ready).toBe(true);
  expect(status?.failed).toBe(false);
  expect(status?.phase).toBe('Ready');
  expect(status?.serviceName).toBe(expected.serviceName);
  // `version` is the chart version FLUX INSTALLED, read off the release's
  // history — not an echo of the request and not a deploy-time literal.
  expect(status?.version).toBe(expected.chartVersion);
  expect(status?.loadBalancer).toBeDefined();
  expect(status?.loadBalancer?.hostname).toBe(expected.loadBalancer.hostname);
  expect(status?.loadBalancer?.ip).toBe(expected.loadBalancer.ip);
}

/**
 * Assert the values Flux is actually reconciling, read back from the cluster.
 *
 * Local YAML proves serialization; only the in-cluster object proves the RGD,
 * KRO's expression evaluation and the Flux handoff produced the chart config
 * this factory promises.
 */
export function assertTraefikHelmReleaseValues(
  release: ObservedHelmRelease,
  expected: { instanceName: string; targetNamespace: string; chartVersion: string }
): void {
  expect(release.spec?.chart?.spec?.chart).toBe('traefik');
  expect(release.spec?.chart?.spec?.version).toBe(expected.chartVersion);
  expect(release.spec?.targetNamespace).toBe(expected.targetNamespace);
  // Unset, Flux would install under `<targetNamespace>-<name>`, spending part
  // of Helm's 53-character release-name budget on the install namespace.
  expect(release.spec?.releaseName).toBe(expected.instanceName);
  // Flux SKIPS a chart's crds/ on upgrade by default, which would strand the
  // traefik.io CRDs at the first-installed chart version.
  expect(release.spec?.install?.crds).toBe('CreateReplace');
  expect(release.spec?.upgrade?.crds).toBe('CreateReplace');

  const values = (release.spec?.values ?? {}) as Record<string, unknown>;
  const section = (key: string) => (values[key] ?? {}) as Record<string, unknown>;

  // @security The dashboard and the insecure API are pinned off, whatever any
  // values source asked for.
  expect(section('api').dashboard).toBe(false);
  expect(section('api').insecure).toBe(false);
  expect(section('api').debug).toBe(false);
  const ingressRoute = section('ingressRoute');
  expect((ingressRoute.dashboard as { enabled?: boolean } | undefined)?.enabled).toBe(false);
  expect((ingressRoute.healthcheck as { enabled?: boolean } | undefined)?.enabled).toBe(false);
  expect(section('podSecurityContext').runAsNonRoot).toBe(true);
  const securityContext = section('securityContext');
  expect(securityContext.readOnlyRootFilesystem).toBe(true);
  expect(securityContext.allowPrivilegeEscalation).toBe(false);
  expect((securityContext.capabilities as { drop?: string[] } | undefined)?.drop).toEqual(['ALL']);

  // The entrypoint Service is a TypeKro-owned resource, so the chart must not
  // create a second one competing for the same name.
  expect(section('service').enabled).toBe(false);
  expect(values.nameOverride).toBe(TRAEFIK_POD_NAME_LABEL_VALUE);
  expect(values.fullnameOverride).toBe(expected.instanceName);
  expect(values.instanceLabelOverride).toBe(expected.instanceName);
  // The internal entrypoint (dashboard, /ping, metrics) stays unpublished.
  const internalPort = section('ports').traefik as
    | { expose?: { default?: boolean } }
    | undefined;
  expect(internalPort?.expose?.default).toBe(false);

  // Nothing unresolved survived KRO/Flux serialization.
  const serialized = JSON.stringify(values);
  expect(serialized).not.toContain('${');
  expect(serialized).not.toContain('__KUBERNETES_REF_');
  expect(serialized).not.toContain('[object Object]');
}

/** Read a Flux HelmRelease through the shared custom-objects client. */
export async function readHelmRelease(
  namespace: string,
  name: string,
  kubeConfig: k8s.KubeConfig
): Promise<ObservedHelmRelease> {
  const customApi = createCustomObjectsApiClient(kubeConfig);
  const raw = (await customApi.getNamespacedCustomObject({
    group: 'helm.toolkit.fluxcd.io',
    version: 'v2',
    namespace,
    plural: 'helmreleases',
    name,
  })) as { body?: ObservedHelmRelease } & ObservedHelmRelease;
  return raw?.body ?? raw;
}

/**
 * Ground-truth pod health for a Traefik install.
 *
 * "A pod exists" is not evidence a proxy is serving: a CrashLooping pod exists.
 * Every pod must be `Running` with every container ready, and restarts must
 * stay inside a budget — KRO mode deploys everything at once, so a handful of
 * restarts while the chart's dependencies settle is normal and a runaway loop
 * is not.
 */
export async function assertTraefikPodsHealthy(
  namespace: string,
  instanceName: string,
  kubeConfig: k8s.KubeConfig,
  options: { maxRestarts?: number } = {}
): Promise<void> {
  const maxRestarts = options.maxRestarts ?? 10;
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const pods = await coreApi.listNamespacedPod({
    namespace,
    labelSelector:
      `app.kubernetes.io/name=${TRAEFIK_POD_NAME_LABEL_VALUE},` +
      `app.kubernetes.io/instance=${instanceName}`,
  });

  expect(pods.items.length).toBeGreaterThan(0);
  for (const pod of pods.items) {
    const podName = pod.metadata?.name ?? '<unnamed>';
    expect(pod.status?.phase, `pod ${podName} phase`).toBe('Running');

    const containers = pod.status?.containerStatuses ?? [];
    expect(containers.length, `pod ${podName} container statuses`).toBeGreaterThan(0);
    for (const container of containers) {
      expect(container.ready, `pod ${podName} container ${container.name} ready`).toBe(true);
      expect(
        container.restartCount ?? 0,
        `pod ${podName} container ${container.name} restarts`
      ).toBeLessThanOrEqual(maxRestarts);
    }
  }
}
