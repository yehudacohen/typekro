/**
 * Live proof for issue #193: the always-on KRO label-propagation guard.
 *
 * Bootstraps the TypeKro runtime (which installs KRO and, with it, the guard)
 * and then exercises the four behaviours the guard exists for, using real
 * ServiceAccount tokens rather than impersonation so the API server sees the
 * usernames the policy's `matchConditions` actually compares against:
 *
 *   (a) a non-KRO caller CREATEs objects carrying the ownership labels →
 *       stripped, including a Service selector and a workload's pod template;
 *   (b) the KRO controller ServiceAccount CREATEs the same objects → kept;
 *   (c) a non-KRO caller UPDATEs an object KRO applied → labels survive;
 *   (d) a non-KRO caller UPDATEs an object and introduces the labels →
 *       stripped, which is the operator that re-copies them every reconcile.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import * as k8s from '@kubernetes/client-node';
import { typeKroRuntimeBootstrap } from '../../src/compositions/typekro-runtime/index.js';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { KRO_OWNERSHIP_LABELS } from '../../src/core/kro/labels.js';
import {
  DEFAULT_KRO_SERVICE_ACCOUNT,
  LABEL_PROPAGATION_GUARD_NAME,
} from '../../src/factories/kubernetes/admission/label-propagation-guard.js';
import {
  createBunCompatibleKubernetesObjectApi,
  createBunCompatibleRbacAuthorizationV1Api,
} from '../../src/core/kubernetes/index.js';
import { simple } from '../../src/factories/simple/index.js';
import { assertNoForeignApplySetLabels } from '../utils/kro-ownership-labels.js';
import {
  createCoreV1ApiClient,
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  type TestNamespaceLease,
} from './shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

// The runtime bootstrap installs Flux and KRO from scratch.
setDefaultTimeout(1_500_000);

const KRO_NAMESPACE = 'kro-system';

const GuardFixtureSpecSchema = type({ name: 'string', namespace: 'string' });
type GuardFixtureSpec = typeof GuardFixtureSpecSchema.infer;

/** The smallest graph that gives KRO one object to apply. */
const guardFixture = kubernetesComposition(
  {
    name: 'guard-fixture',
    apiVersion: 'test.typekro.dev/v1alpha1',
    kind: 'GuardFixture',
    spec: GuardFixtureSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const configMap = simple.ConfigMap({
      id: 'fixtureConfig',
      name: spec.name,
      namespace: spec.namespace,
      data: { guarded: 'true' },
    });
    return { ready: Cel.expr<boolean>(configMap.metadata.uid, ' != ""') };
  }
);
const OWNERSHIP_LABELS: Record<string, string> = {
  'applyset.kubernetes.io/part-of': 'applyset-test',
  'applyset.kubernetes.io/id': 'applyset-test-id',
  'kro.run/owned': 'true',
  'kro.run/node-id': 'cache',
  'kro.run/kro-version': '0.9.2',
};

/**
 * Mint a real token for a ServiceAccount and return an object API bound to it.
 * The guard keys on `request.userInfo.username`, so the caller identity has to
 * be genuine — an impersonation header or a differently-privileged admin
 * client would not exercise the same code path.
 */
async function apiAsServiceAccount(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  serviceAccount: string
): Promise<k8s.KubernetesObjectApi> {
  const core = createCoreV1ApiClient(kubeConfig);
  const token = await core.createNamespacedServiceAccountToken({
    namespace,
    name: serviceAccount,
    body: {
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenRequest',
      spec: { expirationSeconds: 3600, audiences: [] },
    } as k8s.AuthenticationV1TokenRequest,
  });

  const cluster = kubeConfig.getCurrentCluster();
  if (!cluster) throw new Error('No current cluster in the integration kubeconfig');

  const scoped = new k8s.KubeConfig();
  scoped.loadFromOptions({
    clusters: [{ ...cluster, skipTLSVerify: true }],
    users: [{ name: serviceAccount, token: token.status?.token }],
    contexts: [{ name: 'scoped', cluster: cluster.name, user: serviceAccount }],
    currentContext: 'scoped',
  });
  return createBunCompatibleKubernetesObjectApi(scoped);
}

/** Grant a ServiceAccount write access to one namespace. */
async function grantNamespaceAdmin(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  serviceAccountNamespace: string,
  serviceAccount: string
): Promise<void> {
  const rbac = createBunCompatibleRbacAuthorizationV1Api(kubeConfig);
  await rbac.createNamespacedRoleBinding({
    namespace,
    body: {
      metadata: { name: `guard-test-${serviceAccount}` },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'admin' },
      subjects: [
        { kind: 'ServiceAccount', name: serviceAccount, namespace: serviceAccountNamespace },
      ],
    },
  });
}

function labelsOf(object: unknown): Record<string, string> {
  return (object as { metadata?: { labels?: Record<string, string> } }).metadata?.labels ?? {};
}

function ownershipLabelsOn(labels: Record<string, string>): string[] {
  return KRO_OWNERSHIP_LABELS.filter((key) => labels[key] !== undefined);
}

function serviceManifest(namespace: string, name: string) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace, labels: { app: name, ...OWNERSHIP_LABELS } },
    spec: {
      selector: { app: name, 'kro.run/owned': 'true' },
      ports: [{ port: 6379, targetPort: 6379 }],
    },
  };
}

function deploymentManifest(namespace: string, name: string) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace, labels: { app: name, ...OWNERSHIP_LABELS } },
    spec: {
      replicas: 0,
      selector: { matchLabels: { app: name, 'kro.run/owned': 'true' } },
      template: {
        metadata: { labels: { app: name, 'kro.run/owned': 'true', 'kro.run/node-id': 'cache' } },
        spec: { containers: [{ name: 'pause', image: 'registry.k8s.io/pause:3.10' }] },
      },
    },
  };
}

function configMapManifest(namespace: string, name: string) {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace, labels: { app: name, ...OWNERSHIP_LABELS } },
    data: {},
  };
}

describeOrSkip('KRO label-propagation guard (#193)', () => {
  let kubeConfig: k8s.KubeConfig;
  let objectApi: k8s.KubernetesObjectApi;
  let operatorApi: k8s.KubernetesObjectApi;
  let kroApi: k8s.KubernetesObjectApi;
  let bootstrapStatus: Record<string, unknown> | undefined;
  let lease: TestNamespaceLease | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const testNamespace = `typekro-guard-${suffix}`;
  const operatorServiceAccount = 'fake-operator';

  beforeAll(async () => {
    kubeConfig = getIntegrationTestKubeConfig();
    objectApi = createKubernetesObjectApiClient(kubeConfig);

    // Install Flux + KRO + the guard.
    const bootstrap = typeKroRuntimeBootstrap({ namespace: 'flux-system' });
    const factory = await bootstrap.factory('direct', {
      namespace: 'flux-system',
      skipTLSVerify: true,
      timeout: 900_000,
      waitForReady: true,
    });
    const instance = await factory.deploy({ namespace: 'flux-system' });
    bootstrapStatus = (instance as { status?: Record<string, unknown> }).status;

    lease = await createTestNamespace(testNamespace, kubeConfig);

    const core = createCoreV1ApiClient(kubeConfig);
    await core.createNamespacedServiceAccount({
      namespace: testNamespace,
      body: { metadata: { name: operatorServiceAccount, namespace: testNamespace } },
    });
    await grantNamespaceAdmin(kubeConfig, testNamespace, testNamespace, operatorServiceAccount);
    await grantNamespaceAdmin(
      kubeConfig,
      testNamespace,
      KRO_NAMESPACE,
      DEFAULT_KRO_SERVICE_ACCOUNT
    );

    operatorApi = await apiAsServiceAccount(kubeConfig, testNamespace, operatorServiceAccount);
    kroApi = await apiAsServiceAccount(kubeConfig, KRO_NAMESPACE, DEFAULT_KRO_SERVICE_ACCOUNT);
  });

  afterAll(async () => {
    if (lease) await deleteTestNamespaceAndWait(lease, kubeConfig);
  });

  it('installs the policy and its binding, and the exempted ServiceAccount exists', async () => {
    const policy = await objectApi.read({
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'MutatingAdmissionPolicy',
      metadata: { name: LABEL_PROPAGATION_GUARD_NAME },
    });
    expect(policy.metadata?.name).toBe(LABEL_PROPAGATION_GUARD_NAME);

    const binding = await objectApi.read({
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'MutatingAdmissionPolicyBinding',
      metadata: { name: LABEL_PROPAGATION_GUARD_NAME },
    });
    expect((binding as { spec?: { policyName?: string } }).spec?.policyName).toBe(
      LABEL_PROPAGATION_GUARD_NAME
    );

    // The exemption is only real if the ServiceAccount the KRO chart creates is
    // the one the policy names.
    const core = createCoreV1ApiClient(kubeConfig);
    const serviceAccount = await core.readNamespacedServiceAccount({
      namespace: KRO_NAMESPACE,
      name: DEFAULT_KRO_SERVICE_ACCOUNT,
    });
    expect(serviceAccount.metadata?.name).toBe(DEFAULT_KRO_SERVICE_ACCOUNT);
  });

  it('projects status.labelPropagationGuard as active, from the policy resource', async () => {
    const value = bootstrapStatus?.labelPropagationGuard;

    if (typeof value === 'string') {
      expect(value).toBe('active');
      return;
    }

    // Direct mode hands back the unresolved projection for every CEL status
    // leaf (`phase` and `components.kroSystem` come back the same way). Assert
    // what the field promises instead: it is a projection over the policy's
    // uid (#188 — a literal would have been dropped), and that uid is non-empty
    // on the cluster, so the expression evaluates to "active".
    const expression = (value as { expression?: string } | undefined)?.expression ?? '';
    expect(expression).toBe(
      'labelPropagationGuardPolicy.metadata.uid != "" ? "active" : "unavailable"'
    );

    const policy = await objectApi.read({
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'MutatingAdmissionPolicy',
      metadata: { name: LABEL_PROPAGATION_GUARD_NAME },
    });
    expect(policy.metadata?.uid).toBeTruthy();
  });

  it('(a) strips the ownership labels from objects a non-KRO caller creates', async () => {
    const service = await operatorApi.create(serviceManifest(testNamespace, 'operator-svc'));
    expect(ownershipLabelsOn(labelsOf(service))).toEqual([]);
    expect(
      Object.keys(
        (service as { spec?: { selector?: Record<string, string> } }).spec?.selector ?? {}
      )
    ).toEqual(['app']);

    const configMap = await operatorApi.create(configMapManifest(testNamespace, 'operator-cm'));
    expect(ownershipLabelsOn(labelsOf(configMap))).toEqual([]);

    const deployment = (await operatorApi.create(
      deploymentManifest(testNamespace, 'operator-deploy')
    )) as {
      spec?: {
        selector?: { matchLabels?: Record<string, string> };
        template?: { metadata?: { labels?: Record<string, string> } };
      };
    };
    expect(ownershipLabelsOn(labelsOf(deployment))).toEqual([]);
    expect(ownershipLabelsOn(deployment.spec?.selector?.matchLabels ?? {})).toEqual([]);
    expect(ownershipLabelsOn(deployment.spec?.template?.metadata?.labels ?? {})).toEqual([]);
    // The selector and the template must still agree, or the object would have
    // been rejected outright.
    expect(deployment.spec?.selector?.matchLabels).toEqual({ app: 'operator-deploy' });
  });

  it('(b) leaves the labels alone when the KRO controller is the caller', async () => {
    const configMap = await kroApi.create(configMapManifest(testNamespace, 'kro-applied-cm'));
    expect(ownershipLabelsOn(labelsOf(configMap)).sort()).toEqual([...KRO_OWNERSHIP_LABELS].sort());

    const service = await kroApi.create(serviceManifest(testNamespace, 'kro-applied-svc'));
    expect(
      (service as { spec?: { selector?: Record<string, string> } }).spec?.selector?.[
        'kro.run/owned'
      ]
    ).toBe('true');
  });

  it('(c) keeps the labels when a non-KRO caller updates a KRO-applied object', async () => {
    const current = await objectApi.read({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'kro-applied-cm', namespace: testNamespace },
    });
    const updated = await operatorApi.replace({
      ...current,
      metadata: {
        ...current.metadata,
        annotations: { ...(current.metadata?.annotations ?? {}), 'guard-test/touched': 'yes' },
      },
    });
    expect(ownershipLabelsOn(labelsOf(updated)).sort()).toEqual([...KRO_OWNERSHIP_LABELS].sort());
    expect(updated.metadata?.annotations?.['guard-test/touched']).toBe('yes');
  });

  it('(d) strips the labels an operator re-copies on UPDATE', async () => {
    const current = await objectApi.read({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'operator-cm', namespace: testNamespace },
    });
    const updated = await operatorApi.replace({
      ...current,
      metadata: {
        ...current.metadata,
        labels: { ...(current.metadata?.labels ?? {}), ...OWNERSHIP_LABELS },
      },
    });
    expect(ownershipLabelsOn(labelsOf(updated))).toEqual([]);
  });

  it('(d2) strips a label re-introduced alongside one the object already has', async () => {
    const current = await objectApi.read({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'kro-applied-cm', namespace: testNamespace },
    });
    const updated = await operatorApi.replace({
      ...current,
      metadata: {
        ...current.metadata,
        labels: { ...(current.metadata?.labels ?? {}), 'kro.run/synced-by': 'operator' },
      },
    });
    // The pre-existing ownership labels stay; the guard only ever removes what
    // this caller is introducing, and `kro.run/synced-by` is not in the set.
    expect(ownershipLabelsOn(labelsOf(updated)).sort()).toEqual([...KRO_OWNERSHIP_LABELS].sort());
    expect(labelsOf(updated)['kro.run/synced-by']).toBe('operator');
  });
});

// ── Real KRO writes ──────────────────────────────────────────────────────
//
// The block above proves the rule with a minted token for the KRO controller's
// ServiceAccount. This one proves it with the controller itself: a KRO-mode
// instance whose objects the real controller applies, next to a child a
// label-copying operator would have created for the same parent.

describeOrSkip('KRO label-propagation guard — real KRO-applied objects', () => {
  let kubeConfig: k8s.KubeConfig;
  let objectApi: k8s.KubernetesObjectApi;
  let operatorApi: k8s.KubernetesObjectApi;
  let kroFactory: { deploy: (spec: GuardFixtureSpec) => Promise<unknown> } | undefined;
  let appLease: TestNamespaceLease | undefined;
  let factoryLease: TestNamespaceLease | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const appNamespace = `typekro-guard-kro-${suffix}`;
  const factoryNamespace = `typekro-guard-cr-${suffix}`;
  const operatorServiceAccount = 'fake-operator';

  beforeAll(async () => {
    kubeConfig = getIntegrationTestKubeConfig();
    objectApi = createKubernetesObjectApiClient(kubeConfig);
    appLease = await createTestNamespace(appNamespace, kubeConfig);
    factoryLease = await createTestNamespace(factoryNamespace, kubeConfig);

    const core = createCoreV1ApiClient(kubeConfig);
    await core.createNamespacedServiceAccount({
      namespace: appNamespace,
      body: { metadata: { name: operatorServiceAccount, namespace: appNamespace } },
    });
    await grantNamespaceAdmin(kubeConfig, appNamespace, appNamespace, operatorServiceAccount);
    operatorApi = await apiAsServiceAccount(kubeConfig, appNamespace, operatorServiceAccount);

    kroFactory = guardFixture.factory('kro', {
      namespace: factoryNamespace,
      waitForReady: true,
      timeout: 300_000,
      kubeConfig,
    }) as typeof kroFactory;
    await kroFactory?.deploy({ name: 'guarded', namespace: appNamespace });
  });

  afterAll(async () => {
    for (const lease of [appLease, factoryLease]) {
      if (lease) await deleteTestNamespaceAndWait(lease, kubeConfig);
    }
  });

  it('KRO-applied objects keep every ownership label', async () => {
    const configMap = await objectApi.read({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'guarded', namespace: appNamespace },
    });
    const labels = labelsOf(configMap);
    expect(labels['kro.run/node-id']).toBeTruthy();
    expect(labels['applyset.kubernetes.io/part-of']).toBeTruthy();
  });

  it('a label-copying operator child in the same namespace carries none of them', async () => {
    // Exactly what Hyperspike Valkey does: clone the parent's label map onto a
    // child. The parent here is the object KRO just applied.
    const parent = await objectApi.read({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'guarded', namespace: appNamespace },
    });
    const child = await operatorApi.create({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'guarded-child',
        namespace: appNamespace,
        labels: { ...labelsOf(parent) },
      },
      data: {},
    });
    expect(ownershipLabelsOn(labelsOf(child))).toEqual([]);
  });

  it('the shared e2e assertion passes for the namespace', async () => {
    const sweep = await assertNoForeignApplySetLabels(kubeConfig, appNamespace);
    expect(sweep.kroApplied.map((entry) => entry.name)).toContain('guarded');
    expect(sweep.foreign.map((entry) => entry.name)).toContain('guarded-child');
  });
});
