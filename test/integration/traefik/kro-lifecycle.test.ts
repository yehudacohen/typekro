/**
 * Traefik edge — KRO-mode lifecycle suite (#186).
 *
 * The direct-mode suite next door proves the composition deploys. This one
 * proves the graph-native path, which is a different set of failure modes
 * entirely: the RGD has to be accepted by KRO's CEL validator, KRO has to
 * generate the CRD and reconcile the children, KRO's cel-go has to evaluate
 * the status expressions (a separate engine from the `cel-js` evaluator direct
 * mode uses), and KRO's finalizer has to release the graph on delete.
 *
 * Skips cleanly when no cluster is reachable, exactly like the direct suite;
 * `REQUIRE_CLUSTER_TESTS=true` makes it fail instead. It participates in
 * `bun run test:integration:required` through the shared cluster-availability
 * convention and `getIntegrationTestKubeConfig()` — no private opt-in flag.
 *
 * WHAT IS PROVEN END TO END
 * 1. `factory('kro')` deploys and the ResourceGraphDefinition reaches
 *    `Active`.
 * 2. The KRO instance becomes ready, and EVERY field the status schema
 *    declares is hydrated ON THE LIVE CR — the object a GitOps consumer reads,
 *    not just the client-side proxy. `version` proves the HelmRelease
 *    projection; `loadBalancer` proves the owned-Service projection.
 * 3. The HelmRelease KRO generated carries the expected final `spec.values` —
 *    the security pins, `service.enabled: false`, and `CreateReplace` on both
 *    CRD actions — with nothing left unresolved.
 * 4. Pod ground truth: every Traefik pod Running, every container ready,
 *    restarts inside budget.
 * 5. `loadBalancer` projects a real address once one exists. kind assigns
 *    none, so the address is written onto the owned Service's status
 *    subresource the way a cloud controller would, and the LIVE CR is polled
 *    until KRO's own CEL reports it.
 * 6. `deleteInstance()` completes and KRO's finalizer releases the instance,
 *    the RGD, the HelmRelease and the composition-owned namespace.
 *
 * PREREQUISITES for a live pass: a cluster with the TypeKro runtime (Flux
 * source + helm controllers and KRO, i.e. the `bun run scripts/e2e-setup.ts`
 * environment) and outbound access to https://traefik.github.io/charts and the
 * `traefik` image.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';

import { DEFAULT_TRAEFIK_CHART_VERSION } from '../../../src/factories/traefik/constants.js';
import { traefikBootstrap } from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import {
  createCoreV1ApiClient,
  createCustomObjectsApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  runWithExpectedTestNamespace,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';
import { waitUntilGone } from '../shared-absence.js';
import {
  assertTraefikHelmReleaseValues,
  assertTraefikPodsHealthy,
  assertTraefikStatusContract,
  type ObservedTraefikStatus,
  readHelmRelease,
} from './shared-traefik-e2e.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

// A chart install plus KRO reconciliation plus a finalizer-gated teardown does
// not fit in bun's five-second hook default.
setDefaultTimeout(1_500_000);

/** KRO's generated plural for the `TraefikBootstrap` kind. */
const INSTANCE_PLURAL = 'traefikbootstraps';
/** The RGD name is the composition name. */
const RGD_NAME = 'traefik-bootstrap';

describeOrSkip('Traefik bootstrap — KRO mode lifecycle', () => {
  const runId = crypto.randomUUID().slice(0, 8);
  /** Namespace the composition OWNS. Hoisted out of the RGD as a sibling. */
  const installNs = `traefik-kro-${runId}`;
  /** Namespace holding the KRO instance CR. Never a child of its own graph. */
  const instanceNs = `traefik-kro-cr-${runId}`;
  const instanceName = 'traefik';
  const ASSIGNED_HOSTNAME = 'edge-kro.example.test';

  let kubeConfig: k8s.KubeConfig;
  let factory: ReturnType<typeof traefikBootstrap.factory> | undefined;
  let deployed = false;
  let deletedByTest = false;
  /** Leases for harness-created namespaces only. */
  const namespaceLeases: TestNamespaceLease[] = [];
  /** Lease for the composition-owned namespace, captured by the wrapper. */
  const ownedNamespaceLeases: TestNamespaceLease[] = [];

  const baseSpec = {
    name: instanceName,
    namespace: installNs,
    // kind has no load-balancer controller, and the owned Service is part of
    // the graph, so `LoadBalancer` would block `waitForReady` on an address
    // nothing will assign. The LoadBalancer projection is exercised
    // deliberately in its own test below.
    service: { type: 'ClusterIP' as const },
    replicas: 1,
    providers: { crd: true },
    accessLogs: true,
    dashboard: false as const,
  };

  beforeAll(async () => {
    kubeConfig = getIntegrationTestKubeConfig();
    namespaceLeases.push(await createTestNamespace(instanceNs, kubeConfig));
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    // The delete test owns teardown when it ran; this is the safety net for a
    // failure before it.
    if (factory && deployed && !deletedByTest) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        instanceName,
        ownedNamespaceLeases,
        kubeConfig,
        300_000
      ).catch((error) => cleanupErrors.push(error));
    }
    for (const lease of namespaceLeases) {
      await deleteTestNamespaceAndWait(lease, kubeConfig, 180_000).catch((error) =>
        cleanupErrors.push(error)
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Traefik KRO integration cleanup failed');
    }
  });

  /** Read the live instance CR — the object a GitOps consumer sees. */
  async function readInstance(): Promise<{ status?: ObservedTraefikStatus }> {
    const customApi = createCustomObjectsApiClient(kubeConfig);
    const raw = (await customApi.getNamespacedCustomObject({
      group: 'kro.run',
      version: 'v1alpha1',
      namespace: instanceNs,
      plural: INSTANCE_PLURAL,
      name: instanceName,
    })) as { body?: { status?: ObservedTraefikStatus } } & { status?: ObservedTraefikStatus };
    return raw?.body ?? raw;
  }

  /** Poll the live CR until `predicate` holds, then return it. */
  async function waitForInstanceStatus(
    predicate: (status: ObservedTraefikStatus | undefined) => boolean,
    timeoutMs = 300_000
  ): Promise<{ status?: ObservedTraefikStatus }> {
    const deadline = Date.now() + timeoutMs;
    let live = await readInstance();
    while (!predicate(live.status) && Date.now() < deadline) {
      await Bun.sleep(5_000);
      live = await readInstance();
    }
    return live;
  }

  it('reaches RGD Active and hydrates every status field on the live CR', async () => {
    factory = traefikBootstrap.factory('kro', {
      namespace: instanceNs,
      waitForReady: true,
      timeout: 900_000,
      kubeConfig,
    });

    // The composition creates its OWN namespace, so ownership evidence has to
    // be captured even if the deployment fails part-way.
    const instance = await runWithExpectedTestNamespace(
      installNs,
      kubeConfig,
      (lease) => ownedNamespaceLeases.push(lease),
      async () => {
        const deployedInstance = await factory!.deploy(baseSpec);
        deployed = true;
        return deployedInstance;
      }
    );

    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');

    // 1. KRO accepted the RGD. An Inactive RGD is how a CEL path that does not
    // exist in the generated CRD shows up.
    const customApi = createCustomObjectsApiClient(kubeConfig);
    const rgdRaw = (await customApi.getClusterCustomObject({
      group: 'kro.run',
      version: 'v1alpha1',
      plural: 'resourcegraphdefinitions',
      name: RGD_NAME,
    })) as { body?: { status?: { state?: string; conditions?: unknown[] } } } & {
      status?: { state?: string; conditions?: unknown[] };
    };
    const rgd = rgdRaw?.body ?? rgdRaw;
    expect(rgd.status?.state).toBe('Active');

    // 2. Every declared status field, on the LIVE CR. KRO projects status a
    // reconcile after readiness, and `version` only appears once Flux has
    // recorded its first release, so poll for the last field to arrive.
    const live = await waitForInstanceStatus((status) => Boolean(status?.version));
    console.log('🔎 LIVE TraefikBootstrap status:', JSON.stringify(live.status, null, 2));

    assertTraefikStatusContract(live.status, {
      serviceName: instanceName,
      chartVersion: DEFAULT_TRAEFIK_CHART_VERSION,
      // Documented behavior for a non-LoadBalancer Service: the guarded CEL
      // reports the empty string rather than failing the whole status object.
      loadBalancer: { hostname: '', ip: '' },
    });
  }, 1_200_000);

  it('generates a HelmRelease whose final values carry the pins', async () => {
    const release = await readHelmRelease('flux-system', instanceName, kubeConfig);

    assertTraefikHelmReleaseValues(release, {
      instanceName,
      targetNamespace: installNs,
      chartVersion: DEFAULT_TRAEFIK_CHART_VERSION,
    });
    // The version the status projects is this release's own record.
    expect(release.status?.history?.[0]?.chartVersion).toBe(DEFAULT_TRAEFIK_CHART_VERSION);
  });

  it('runs healthy pods, not merely existing ones', async () => {
    // KRO applies the whole graph at once, so a couple of restarts while the
    // chart's dependencies settle are expected; a loop is not.
    await assertTraefikPodsHealthy(installNs, instanceName, kubeConfig, { maxRestarts: 10 });
  });

  it('owns the entrypoint Service and publishes only the two entrypoints', async () => {
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const owned = await coreApi.readNamespacedService({
      namespace: installNs,
      name: instanceName,
    });

    // A chart-created Service would carry `managed-by: Helm`. In KRO mode the
    // label says `kro`, not `typekro`: the RGD template declares `typekro`
    // (see the serialization tests) but the KRO controller stamps its own
    // `app.kubernetes.io/managed-by` on the graph children it applies. Either
    // graph engine is the point — what matters is that Helm did not create it.
    const managedBy = owned.metadata?.labels?.['app.kubernetes.io/managed-by'];
    expect(['typekro', 'kro']).toContain(managedBy);
    expect(owned.spec?.selector).toEqual({
      'app.kubernetes.io/name': 'traefik',
      'app.kubernetes.io/instance': instanceName,
    });
    // @security The internal `traefik` entrypoint serves /ping, metrics and the
    // (pinned off) dashboard, and is never published.
    expect((owned.spec?.ports ?? []).map((port) => port.name)).toEqual(['web', 'websecure']);

    const endpoints = await coreApi.readNamespacedEndpoints({
      namespace: installNs,
      name: instanceName,
    });
    const addresses = (endpoints.subsets ?? []).flatMap((subset) => subset.addresses ?? []);
    expect(addresses.length).toBeGreaterThan(0);
  });

  it("projects an assigned load-balancer address through KRO's own CEL", async () => {
    // The empty arm is asserted above. This is the populated arm, and it is
    // KRO's cel-go evaluating it — a different engine from direct mode's
    // cel-js, which is the whole reason this is worth proving twice.
    //
    // kind assigns no address, so the Service is switched to `LoadBalancer`
    // (the API server REFUSES `status.loadBalancer.ingress` on a `ClusterIP`
    // Service) and the address is written onto its status subresource the way
    // a cloud controller would. `waitForReady` is off for the switch because
    // nothing on kind will ever complete it.
    const switchFactory = traefikBootstrap.factory('kro', {
      namespace: instanceNs,
      waitForReady: false,
      timeout: 300_000,
      kubeConfig,
    });
    await switchFactory.deploy({ ...baseSpec, service: { type: 'LoadBalancer' as const } });

    const coreApi = createCoreV1ApiClient(kubeConfig);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const current = await coreApi.readNamespacedService({
        namespace: installNs,
        name: instanceName,
      });
      if (current.spec?.type === 'LoadBalancer') {
        await coreApi.replaceNamespacedServiceStatus({
          namespace: installNs,
          name: instanceName,
          body: {
            ...current,
            status: { loadBalancer: { ingress: [{ hostname: ASSIGNED_HOSTNAME }] } },
          },
        });
        break;
      }
      await Bun.sleep(5_000);
    }

    const live = await waitForInstanceStatus(
      (status) => status?.loadBalancer?.hostname === ASSIGNED_HOSTNAME
    );
    expect(live.status?.loadBalancer?.hostname).toBe(ASSIGNED_HOSTNAME);
    // The entry carries a hostname and no ip; the guarded CEL reports the
    // absent sibling as '' rather than taking the whole status object down.
    expect(live.status?.loadBalancer?.ip).toBe('');
    // ...and the rest of the contract is still hydrated.
    expect(live.status?.ready).toBe(true);
    expect(live.status?.version).toBe(DEFAULT_TRAEFIK_CHART_VERSION);
  }, 600_000);

  it('releases the instance, the RGD and the owned namespace on deleteInstance', async () => {
    expect(factory).toBeDefined();
    const result = await deleteTestFactoryInstanceAndRecoverNamespaces(
      factory!,
      instanceName,
      ownedNamespaceLeases,
      kubeConfig,
      300_000
    );
    deletedByTest = true;
    expect(result.status).toBe('complete');

    const customApi = createCustomObjectsApiClient(kubeConfig);
    const coreApi = createCoreV1ApiClient(kubeConfig);

    // The instance CR is gone, which means KRO's finalizer was released
    // rather than stranding the object in Terminating.
    expect(
      await waitUntilGone(() =>
        customApi.getNamespacedCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          namespace: instanceNs,
          plural: INSTANCE_PLURAL,
          name: instanceName,
        })
      )
    ).toBe(true);

    // The sole instance is gone, so the RGD goes with it.
    expect(
      await waitUntilGone(() =>
        customApi.getClusterCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          plural: 'resourcegraphdefinitions',
          name: RGD_NAME,
        })
      )
    ).toBe(true);

    // The graph children follow: the HelmRelease...
    expect(
      await waitUntilGone(() => readHelmRelease('flux-system', instanceName, kubeConfig))
    ).toBe(true);

    // ...and the namespace the composition owned, which TypeKro applies as a
    // hoisted sibling and tears down after the RGD.
    expect(
      await waitUntilGone(() => coreApi.readNamespace({ name: installNs }), 300_000)
    ).toBe(true);
  }, 900_000);
});
