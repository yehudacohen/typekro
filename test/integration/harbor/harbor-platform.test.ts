/**
 * Opt-in official Harbor + Rook/Ceph + OCI end-to-end proof.
 *
 * Prerequisite: run the retained Rook platform fixture first:
 *
 *   RUN_ROOK_PLATFORM_INTEGRATION=true KEEP_ROOK_PLATFORM=true bun test \
 *     test/integration/rook/ceph-platform.test.ts
 *
 * Then run:
 *
 *   RUN_HARBOR_PLATFORM_INTEGRATION=true KEEP_HARBOR_PLATFORM=true bun test \
 *     test/integration/harbor/harbor-platform.test.ts
 *
 * Direct lifecycle can be qualified against an isolated installation with:
 *
 *   RUN_HARBOR_PLATFORM_INTEGRATION=true HARBOR_DEPLOYMENT_MODE=direct bun test \
 *     test/integration/harbor/harbor-platform.test.ts
 *
 * An opt-in TYPEKRO_HARBOR_CONSUMER_SCRIPT runs after the fixture passes and
 * before TypeKro-first teardown. It receives only non-secret installation
 * connection fields through TYPEKRO_HARBOR_TEST_INSTALLATION and the selected
 * context through TYPEKRO_HARBOR_TEST_CONTEXT.
 * TYPEKRO_HARBOR_SHARED_EXTERNAL_CONSUMER=true creates a disposable installation
 * at one explicit external connection, runs the injected consumer hook against
 * it, then deletes only test-owned resources on the prerequisite TypeKro
 * Rook/Ceph platform.
 *
 * Retained mode is deliberate: Chirp consumes that shared registry platform.
 * Non-retained runs use unique namespaces, project, bucket, and NodePorts and
 * perform TypeKro-first teardown without touching the retained installation.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { KubernetesObject, V1Secret } from '@kubernetes/client-node';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import {
  clearContainerCache,
  container,
  harbor as harborRegistry,
  kubernetesSecretRegistryCredentials,
} from '../../../src/core/containers/index.js';
import { patchResourceWithCorrectContentType } from '../../../src/core/deployment/k8s-helpers.js';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createHarborKubernetesStore,
  deleteHarborProject,
  HarborApiClient,
  harborLocalInstallation,
  prepareHarborRookS3Binding,
  reconcileHarborProject,
} from '../../../src/factories/harbor/index.js';
import type { HarborLocalInstallationConfig } from '../../../src/factories/harbor/types.js';
import {
  rookBucketStorageClass,
  rookObjectStorageClaim,
} from '../../../src/factories/rook/index.js';
import {
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createCustomObjectsApiClient,
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  ensureFluxInstalled,
  ensureSharedPrerequisiteNamespace,
  isClusterAvailable,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';
import { runIntegrationConsumer } from '../shared-consumer-process.js';

const requested = process.env.RUN_HARBOR_PLATFORM_INTEGRATION === 'true';
const describeOrSkip = requested && (await isClusterAvailable()) ? describe : describe.skip;
const retainPlatform = process.env.KEEP_HARBOR_PLATFORM === 'true';
const consumerScript = process.env.TYPEKRO_HARBOR_CONSUMER_SCRIPT;
const sharedExternalConsumer = process.env.TYPEKRO_HARBOR_SHARED_EXTERNAL_CONSUMER === 'true';
const deploymentMode = process.env.HARBOR_DEPLOYMENT_MODE === 'direct' ? 'direct' : 'kro';
if (process.env.HARBOR_STORAGE_BACKEND || process.env.TYPEKRO_HARBOR_CONSUMER_OWNS_INSTALLATION) {
  throw new Error(
    'The Harbor fixture requires its Rook/Ceph prerequisite; disposable S3 and consumer-owned fixture modes were removed.'
  );
}
if (
  sharedExternalConsumer &&
  (!consumerScript ||
    retainPlatform ||
    deploymentMode !== 'direct' ||
    (process.env.HARBOR_NODE_PORT && process.env.HARBOR_NODE_PORT !== '32080'))
) {
  throw new Error(
    'The shared external Harbor consumer requires direct mode, port 32080, and one consumer script.'
  );
}
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const fixedExternalBinding = retainPlatform || sharedExternalConsumer;
const suffix = fixedExternalBinding ? 'harbor' : `harbor-${runId}`;
const controlNamespace =
  `typekro-${suffix}-${sharedExternalConsumer ? 'registry' : 'platform'}-control`.slice(0, 63);
const harborNamespace = `typekro-${suffix}-registry`.slice(0, 63);
const clientNamespace = `typekro-${suffix}-clients`.slice(0, 63);
const storageClassName = 'typekro-harbor-bucket-retain';
const disposableStorageClassName = `typekro-${suffix}-bucket-delete`.slice(0, 63);
const activeStorageClassName = retainPlatform ? storageClassName : disposableStorageClassName;
const claimName = retainPlatform
  ? 'harbor-registry-storage'
  : `harbor-storage-${runId}`.slice(0, 63);
const installationName = fixedExternalBinding ? 'harbor' : `harbor-${runId}`.slice(0, 63);
const projectName = retainPlatform ? 'chirp-live' : `chirp-${runId}`.slice(0, 63);
const bucketName = `typekro-${suffix}-registry`.slice(0, 63);
const port = Number(process.env.HARBOR_NODE_PORT ?? (fixedExternalBinding ? 32_080 : 32_082));
function localPublishHost(): string {
  const route = execFileSync('route', ['-n', 'get', 'default'], { encoding: 'utf8' });
  const interfaceName = /^\s*interface:\s*(\S+)/mu.exec(route)?.[1];
  const address =
    interfaceName &&
    networkInterfaces()[interfaceName]?.find(
      (candidate) => candidate.family === 'IPv4' && !candidate.internal
    )?.address;
  if (!address)
    throw new Error('The owned Harbor test has no reachable default-route IPv4 host address.');
  return address;
}
// The ordinary route uses a directly reachable NodePort. The shared consumer
// route uses a test-scoped host forward when the selected node is not reachable.
let apiOrigin = '';
let registryHost = '';
let registryOrigin = '';
let sharedHostForward: ReturnType<typeof spawn> | undefined;
async function startSharedHostForward(context: string): Promise<void> {
  if (!sharedExternalConsumer) return;
  const host = localPublishHost();
  const child = spawn(
    'kubectl',
    [
      '--context',
      context,
      'port-forward',
      '-n',
      harborNamespace,
      'service/harbor',
      `${port}:80`,
      '--address',
      host,
    ],
    { stdio: 'ignore' }
  );
  sharedHostForward = child;
  let forwardError: Error | undefined;
  child.once('error', (cause) => {
    forwardError = cause;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (forwardError) throw forwardError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Disposable shared Harbor forward exited before readiness.');
    try {
      const response = await fetch(`${apiOrigin}/api/v2.0/ping`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok && (await response.text()) === 'Pong') return;
    } catch {
      /* Wait for kubectl to bind the test-owned service. */
    }
    await Bun.sleep(200);
  }
  throw new Error('Disposable shared Harbor forward did not become ready.');
}

const secretNames = {
  storage: 'typekro-harbor-s3',
  admin: 'typekro-harbor-admin',
  encryption: 'typekro-harbor-encryption',
  core: 'typekro-harbor-core',
  jobservice: 'typekro-harbor-jobservice',
  registry: 'typekro-harbor-registry-secret',
  registryCredentials: 'typekro-harbor-registry-credentials',
  xsrf: 'typekro-harbor-xsrf',
  robotPull: 'chirp-live-pull',
  robotPush: 'chirp-live-push',
} as const;

const disposableBucketClass = kubernetesComposition(
  {
    name: 'harbor-disposable-bucket-class',
    kind: 'HarborDisposableBucketClass',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  () => {
    rookBucketStorageClass({
      name: disposableStorageClassName,
      objectStoreName: 'harbor-object-store',
      objectStoreNamespace: 'typekro-harbor-ceph',
      operatorNamespace: 'typekro-rook-e2e-operator',
      reclaimPolicy: 'Delete',
      id: 'storageClass',
    });
    return { ready: true };
  }
);

interface HarborTestSecrets {
  adminPassword: string;
  encryptionKey: string;
  core: string;
  jobservice: string;
  registry: string;
  registryPassword: string;
  xsrf: string;
}

let testSecrets: HarborTestSecrets | undefined;

function activeTestSecrets(): HarborTestSecrets {
  if (!testSecrets) throw new Error('Harbor integration credentials were not initialized.');
  return testSecrets;
}

setDefaultTimeout(1_800_000);

async function ensureSecret(
  name: string,
  stringData: Readonly<Record<string, string>>,
  namespace = harborNamespace
): Promise<void> {
  const store = createHarborKubernetesStore({ skipTLSVerify: true });
  await store.upsertSecret({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/name': 'harbor',
        'app.kubernetes.io/managed-by': 'typekro-integration',
      },
    },
    type: 'Opaque',
    stringData: { ...stringData },
  });
}

async function htpasswd(username: string, password: string): Promise<string> {
  const proc = Bun.spawn(['htpasswd', '-i', '-B', '-n', username], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(`${password}\n`);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`htpasswd fixture preparation failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function ensureHarborSecrets(): Promise<void> {
  const secrets = activeTestSecrets();
  await Promise.all([
    ensureSecret(secretNames.admin, { HARBOR_ADMIN_PASSWORD: secrets.adminPassword }),
    ensureSecret(secretNames.encryption, { secretKey: secrets.encryptionKey }),
    ensureSecret(secretNames.core, { secret: secrets.core }),
    ensureSecret(secretNames.jobservice, { JOBSERVICE_SECRET: secrets.jobservice }),
    ensureSecret(secretNames.registry, { REGISTRY_HTTP_SECRET: secrets.registry }),
    ensureSecret(secretNames.xsrf, { CSRF_KEY: secrets.xsrf }),
    htpasswd('harbor_registry_user', secrets.registryPassword).then((encoded) =>
      ensureSecret(secretNames.registryCredentials, {
        REGISTRY_PASSWD: secrets.registryPassword,
        REGISTRY_HTPASSWD: encoded,
      })
    ),
  ]);
}

async function loadOrCreateHarborTestSecrets(
  store: ReturnType<typeof createHarborKubernetesStore>
): Promise<HarborTestSecrets> {
  const contracts = [
    ['adminPassword', secretNames.admin, 'HARBOR_ADMIN_PASSWORD'],
    ['encryptionKey', secretNames.encryption, 'secretKey'],
    ['core', secretNames.core, 'secret'],
    ['jobservice', secretNames.jobservice, 'JOBSERVICE_SECRET'],
    ['registry', secretNames.registry, 'REGISTRY_HTTP_SECRET'],
    ['registryPassword', secretNames.registryCredentials, 'REGISTRY_PASSWD'],
    ['xsrf', secretNames.xsrf, 'CSRF_KEY'],
  ] as const;
  const existing: Partial<HarborTestSecrets> = {};
  for (const [field, name, key] of contracts) {
    const encoded = (await store.readSecret(harborNamespace, name))?.data?.[key];
    if (encoded) existing[field] = Buffer.from(encoded, 'base64').toString('utf8');
  }
  const existingCount = Object.keys(existing).length;
  if (existingCount === contracts.length) return existing as HarborTestSecrets;
  if (existingCount > 0) {
    throw new Error(
      `Harbor integration found a partial credential fixture in ${harborNamespace}; refusing to rotate a running installation implicitly.`
    );
  }
  return {
    adminPassword: randomBytes(24).toString('base64url'),
    encryptionKey: randomBytes(8).toString('hex'),
    core: randomBytes(24).toString('base64url'),
    jobservice: randomBytes(24).toString('base64url'),
    registry: randomBytes(24).toString('base64url'),
    registryPassword: randomBytes(24).toString('base64url'),
    xsrf: randomBytes(16).toString('hex'),
  };
}

function assertSecretDoesNotContain(
  secret: V1Secret | undefined,
  forbidden: readonly string[]
): void {
  const serialized = JSON.stringify(secret?.metadata ?? {});
  for (const value of forbidden) expect(serialized).not.toContain(value);
}

describeOrSkip(
  `official Harbor platform (${deploymentMode}) backed by Rook/Ceph object storage`,
  () => {
    const t = it.skipIf(sharedExternalConsumer);
    const kubeConfig = getKubeConfig({ skipTLSVerify: true });
    const claimFactory = rookObjectStorageClaim.factory('direct', {
      namespace: harborNamespace,
      waitForReady: true,
      timeout: 600_000,
      kubeConfig,
    });
    const bucketClassFactory = disposableBucketClass.factory('direct', {
      namespace: controlNamespace,
      waitForReady: true,
      timeout: 120_000,
      kubeConfig,
    });
    const harborFactory =
      deploymentMode === 'direct'
        ? harborLocalInstallation.factory('direct', {
            namespace: controlNamespace,
            waitForReady: true,
            timeout: 1_500_000,
            kubeConfig,
          })
        : harborLocalInstallation.factory('kro', {
            namespace: controlNamespace,
            waitForReady: true,
            timeout: 1_500_000,
            kubeConfig,
          });
    const store = createHarborKubernetesStore({ skipTLSVerify: true });
    let harborAttempted = false;
    let claimDeployed = false;
    let projectReconciled = false;
    let bucketClassDeployed = false;
    let storageBinding: HarborLocalInstallationConfig['storage'] | undefined;
    const namespaceLeases: TestNamespaceLease[] = [];

    beforeAll(async () => {
      if (sharedExternalConsumer) {
        await ensureFluxInstalled({ kubeConfig, verbose: false });
      }
      const objectApi = createKubernetesObjectApiClient(kubeConfig);
      const storageClass = await objectApi
        .read({
          apiVersion: 'storage.k8s.io/v1',
          kind: 'StorageClass',
          metadata: { name: storageClassName },
        })
        .catch(() => undefined);
      const expectedProvisioner =
        process.env.TYPEKRO_HARBOR_BUCKET_PROVISIONER ?? 'typekro-harbor-ceph.ceph.rook.io/bucket';
      if (
        !storageClass ||
        (storageClass as { provisioner?: string }).provisioner !== expectedProvisioner
      ) {
        throw new Error(
          `Harbor integration requires the retained Rook platform StorageClass ${storageClassName}; ` +
            'run the Rook platform integration with KEEP_ROOK_PLATFORM=true first.'
        );
      }
      if (!retainPlatform) {
        namespaceLeases.push(await createTestNamespace(controlNamespace, kubeConfig));
        await bucketClassFactory.deploy({ name: 'bucket-class' });
        bucketClassDeployed = true;
      }
      const nodes = await createCoreV1ApiClient(kubeConfig).listNode();
      const nodeAddress = nodes.items
        ?.flatMap((node) => node.status?.addresses ?? [])
        .find(
          (address) =>
            address.type === 'InternalIP' &&
            typeof address.address === 'string' &&
            address.address.includes('.')
        )?.address;
      if (!nodeAddress) throw new Error('OrbStack Kubernetes node has no InternalIP address.');
      registryHost = `${sharedExternalConsumer ? localPublishHost() : nodeAddress}:${port}`;
      registryOrigin = `http://${registryHost}`;
      apiOrigin = registryOrigin;
      if (retainPlatform) {
        await ensureSharedPrerequisiteNamespace(harborNamespace, kubeConfig);
        await ensureSharedPrerequisiteNamespace(clientNamespace, kubeConfig);
      } else {
        namespaceLeases.push(
          ...(await Promise.all([
            createTestNamespace(harborNamespace, kubeConfig),
            createTestNamespace(clientNamespace, kubeConfig),
          ]))
        );
      }
      testSecrets = await loadOrCreateHarborTestSecrets(store);
      const claim = await claimFactory.deploy({
        name: claimName,
        namespace: harborNamespace,
        storageClassName: activeStorageClassName,
        bucket: { name: bucketName, mode: 'generated' },
      });
      claimDeployed = true;
      expect(claim.status).toMatchObject({ ready: true, phase: 'Bound' });
      storageBinding = await prepareHarborRookS3Binding({
        sourceNamespace: harborNamespace,
        claimName,
        targetNamespace: harborNamespace,
        targetSecretName: secretNames.storage,
        kubeConfig: { skipTLSVerify: true },
        rootDirectory: '/registry',
      });
      expect(storageBinding.existingSecret).toBe(secretNames.storage);
      await ensureHarborSecrets();
    });

    afterAll(async () => {
      if (retainPlatform) return;
      if (sharedHostForward) {
        sharedHostForward.kill('SIGTERM');
        sharedHostForward = undefined;
      }
      const cleanupErrors: unknown[] = [];
      if (projectReconciled) {
        const secrets = activeTestSecrets();
        const client = new HarborApiClient({
          endpoint: apiOrigin,
          allowPlainHttp: true,
          credentialProvider: async () => ({
            username: 'admin',
            password: secrets.adminPassword,
          }),
        });
        await deleteHarborProject(client, projectName, {
          confirmProjectName: projectName,
          purgeRepositories: true,
          secretNamespace: clientNamespace,
          robotSecretNames: [secretNames.robotPull, secretNames.robotPush],
          store,
        }).catch((error) => cleanupErrors.push(error));
      }
      if (harborAttempted) {
        console.log(`Cleaning test Harbor installation ${installationName}`);
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          harborFactory,
          installationName,
          [],
          kubeConfig,
          180_000
        ).catch((error) => cleanupErrors.push(error));
      }
      if (claimDeployed) {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          claimFactory,
          claimName,
          [],
          kubeConfig,
          120_000
        ).catch((error) => cleanupErrors.push(error));
      }
      if (bucketClassDeployed) {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          bucketClassFactory,
          'bucket-class',
          [],
          kubeConfig,
          120_000,
          { scopes: ['cluster'], includeUnscopedResources: true }
        ).catch((error) => cleanupErrors.push(error));
      }
      for (const lease of namespaceLeases) {
        console.log(`Cleaning test namespace ${lease.name}`);
        await deleteTestNamespaceAndWait(lease, kubeConfig, 30_000, 120_000).catch((error) =>
          cleanupErrors.push(error)
        );
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Harbor integration cleanup failed');
      }
    });

    it(`installs the official chart through ${deploymentMode} mode with schema-complete status`, async () => {
      if (!storageBinding) throw new Error('Harbor storage binding was not prepared.');
      const desired = {
        name: installationName,
        namespace: harborNamespace,
        namespaceOwnership: 'external',
        profile: 'local-development',
        exposure: {
          type: 'nodePort',
          externalUrl: registryOrigin,
          tls: { enabled: false, source: 'none' },
          nodePort: { http: port, https: port + 1 },
        },
        storage: {
          ...storageBinding,
          skipVerify: false,
          disableRedirect: true,
        },
        adminPasswordSecret: { name: secretNames.admin },
        componentSecrets: {
          encryptionKey: secretNames.encryption,
          core: secretNames.core,
          jobservice: secretNames.jobservice,
          registry: secretNames.registry,
          registryCredentials: secretNames.registryCredentials,
          xsrf: secretNames.xsrf,
        },
        trivyEnabled: false,
        metricsEnabled: false,
        values: {
          updateStrategy: { type: 'Recreate' },
          persistence: {
            persistentVolumeClaim: {
              database: { size: '1Gi' },
              redis: { size: '1Gi' },
            },
          },
        },
      } satisfies HarborLocalInstallationConfig;
      harborAttempted = true;
      const installation = await harborFactory.deploy(desired);
      expect(installation.status).toMatchObject({
        ready: true,
        failed: false,
        phase: 'Ready',
        endpoint: registryOrigin,
        chartVersion: '1.19.1',
        harborVersion: 'v2.15.1',
        profile: 'local-development',
        tlsEnabled: false,
        storageReady: true,
        databaseReady: true,
        cacheReady: true,
        networkPolicyReady: true,
      });
      expect(installation.status.release.observedGeneration).toBeGreaterThan(0);
      expect(installation.status.release.conditions.length).toBeGreaterThan(0);
      await startSharedHostForward(kubeConfig.getCurrentContext());
      const ping = await fetch(`${apiOrigin}/api/v2.0/ping`);
      expect(await ping.text()).toBe('Pong');
      if (sharedExternalConsumer) return;

      // Exercise an actual factory update. waitForReady must not reuse the prior
      // generation's Ready condition while Flux is still reconciling the new
      // HelmRelease generation.
      const updated = await harborFactory.deploy({ ...desired, metricsEnabled: true });
      expect(updated.status).toMatchObject({ ready: true, failed: false, phase: 'Ready' });
      expect(updated.status.release.observedGeneration).toBeGreaterThanOrEqual(
        installation.status.release.observedGeneration
      );
      if (deploymentMode === 'kro') {
        const owner = (await createCustomObjectsApiClient(kubeConfig).getNamespacedCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          namespace: controlNamespace,
          plural: 'harborlocalinstallations',
          name: installationName,
        })) as {
          metadata?: { generation?: number };
          status?: {
            conditions?: Array<{ type?: string; status?: string; observedGeneration?: number }>;
          };
        };
        const generation = owner.metadata?.generation ?? 0;
        const readyCondition = owner.status?.conditions?.find(
          (condition) => condition.type === 'Ready' || condition.type === 'InstanceSynced'
        );
        expect(generation).toBeGreaterThan(0);
        expect(readyCondition).toMatchObject({ status: 'True' });
        expect(readyCondition?.observedGeneration).toBeGreaterThanOrEqual(generation);
      }
      const helmRelease = (await createKubernetesObjectApiClient(kubeConfig).read({
        apiVersion: 'helm.toolkit.fluxcd.io/v2',
        kind: 'HelmRelease',
        metadata: { name: installationName, namespace: harborNamespace },
      })) as unknown as { spec?: { values?: { metrics?: { enabled?: boolean } } } };
      expect(helmRelease.spec?.values?.metrics?.enabled).toBe(true);

      // Restart one official Harbor component and prove bounded recovery.
      const appsApi = createAppsV1ApiClient(kubeConfig);
      const deploymentName = `${installationName}-core`;
      await patchResourceWithCorrectContentType(
        createKubernetesObjectApiClient(kubeConfig),
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: deploymentName, namespace: harborNamespace },
          spec: {
            template: {
              metadata: {
                annotations: { 'typekro.io/restarted-at': new Date().toISOString() },
              },
            },
          },
        } as KubernetesObject,
        'strategic'
      );
      const restartDeadline = Date.now() + 300_000;
      let deploymentReady = false;
      while (Date.now() < restartDeadline) {
        const deployment = await appsApi.readNamespacedDeployment({
          name: deploymentName,
          namespace: harborNamespace,
        });
        const desired = deployment.spec?.replicas ?? 1;
        if (
          (deployment.status?.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 0) &&
          (deployment.status?.updatedReplicas ?? 0) >= desired &&
          (deployment.status?.readyReplicas ?? 0) >= desired
        ) {
          deploymentReady = true;
          break;
        }
        await Bun.sleep(2_000);
      }
      expect(deploymentReady).toBe(true);
      expect(await (await fetch(`${apiOrigin}/api/v2.0/ping`)).text()).toBe('Pong');
    });

    t(
      'reconciles a private project and purpose-scoped robot credentials idempotently',
      async () => {
        const secrets = activeTestSecrets();
        const client = new HarborApiClient({
          endpoint: apiOrigin,
          allowPlainHttp: true,
          credentialProvider: async () => ({
            username: 'admin',
            password: secrets.adminPassword,
          }),
        });
        const options = {
          project: {
            name: projectName,
            public: false,
            storageLimitBytes: 5_000_000_000,
            autoScan: false,
            autoSbomGeneration: false,
            immutableTags: { repositoryPattern: '**', tagPattern: 'release-*' },
            retention: { keepMostRecent: 20 },
          },
          robots: [
            {
              name: `${projectName}-pull`,
              secretName: secretNames.robotPull,
              access: 'pull' as const,
            },
            {
              name: `${projectName}-push`,
              secretName: secretNames.robotPush,
              access: 'push' as const,
            },
          ],
          secretNamespace: clientNamespace,
          registry: registryOrigin,
          kubeConfig: { skipTLSVerify: true },
        };
        const first = await reconcileHarborProject(client, options);
        projectReconciled = true;
        const second = await reconcileHarborProject(client, options);
        expect(second).toEqual(first);
        expect(first.project).toBe(projectName);
        expect(first.robots).toHaveLength(2);
        const pullSecret = await store.readSecret(clientNamespace, secretNames.robotPull);
        const pushSecret = await store.readSecret(clientNamespace, secretNames.robotPush);
        expect(pullSecret?.type).toBe('kubernetes.io/dockerconfigjson');
        expect(pushSecret?.type).toBe('kubernetes.io/dockerconfigjson');
        assertSecretDoesNotContain(pushSecret, [secrets.adminPassword, secrets.registryPassword]);
      }
    );

    t(
      'pushes once through container(), verifies the registry digest, and exposes the artifact',
      async () => {
        clearContainerCache();
        const credentialProvider = kubernetesSecretRegistryCredentials({
          namespace: clientNamespace,
          name: secretNames.robotPush,
          registry: registryOrigin,
        });
        const options = {
          context: join(import.meta.dir, 'fixtures/oci-smoke'),
          imageName: 'typekro-oci-smoke',
          timeout: 600_000,
          progress: 'plain' as const,
          registry: harborRegistry({
            registry: registryOrigin,
            project: projectName,
            credentialProvider,
            tls: { plainHttp: true },
          }),
        };
        const first = await container(options);
        const second = await container(options);
        expect(second).toEqual(first);
        const digest = first.digest;
        expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        if (!digest) throw new Error('Remote Harbor build did not return a verified digest.');
        expect(first.imageUri).toBe(`${registryHost}/${projectName}/typekro-oci-smoke@${digest}`);
        expect(first.taggedImageUri).toContain(
          `${registryHost}/${projectName}/typekro-oci-smoke:sha-`
        );

        const pullPod = `harbor-pull-${runId}`.slice(0, 63);
        const pulledDigest = await runTestPodAndReadLogs(
          {
            namespace: clientNamespace,
            name: pullPod,
            image:
              'gcr.io/go-containerregistry/crane@sha256:1b1fb24d2b1bb27a9daf81a588157e68463876904e8e537a812edba6284fb252',
            command: ['/ko-app/crane'],
            args: ['digest', '--insecure', first.imageUri],
            env: [{ name: 'DOCKER_CONFIG', value: '/docker' }],
            volumeMounts: [{ name: 'registry-auth', mountPath: '/docker', readOnly: true }],
            volumes: [
              {
                name: 'registry-auth',
                secret: {
                  secretName: secretNames.robotPull,
                  items: [{ key: '.dockerconfigjson', path: 'config.json' }],
                },
              },
            ],
            timeoutMs: 300_000,
          },
          kubeConfig
        );
        expect(pulledDigest.trim()).toBe(digest);

        // The workload image must be fetched by the Kubernetes node using the
        // purpose-scoped pull Secret, not only by a client already running in a Pod.
        await runTestPodAndReadLogs(
          {
            namespace: clientNamespace,
            name: `harbor-kubelet-pull-${runId}`.slice(0, 63),
            image: first.imageUri,
            imagePullPolicy: 'Always',
            imagePullSecrets: [{ name: secretNames.robotPull }],
            timeoutMs: 300_000,
          },
          kubeConfig
        );

        const secrets = activeTestSecrets();
        const client = new HarborApiClient({
          endpoint: apiOrigin,
          allowPlainHttp: true,
          credentialProvider: async () => ({
            username: 'admin',
            password: secrets.adminPassword,
          }),
        });
        const artifact = await client.request<{ digest?: string }>({
          method: 'GET',
          path:
            `/projects/${projectName}/repositories/typekro-oci-smoke/artifacts/` +
            encodeURIComponent(digest),
        });
        expect(artifact.body?.digest).toBe(digest);
      }
    );

    (consumerScript ? it : it.skip)(
      'qualifies an opt-in exact-package consumer against the test-owned Harbor installation',
      async () => {
        if (!consumerScript || retainPlatform) {
          throw new Error(
            'The Harbor consumer hook requires a disposable test-owned installation.'
          );
        }
        if (!storageBinding) {
          throw new Error('The Harbor consumer hook has no selected storage binding.');
        }
        await runIntegrationConsumer(consumerScript, {
          env: {
            ...process.env,
            TYPEKRO_HARBOR_TEST_CONTEXT: kubeConfig.getCurrentContext(),
            TYPEKRO_HARBOR_TEST_INSTALLATION: JSON.stringify({
              name: installationName,
              namespace: harborNamespace,
              nodePort: port,
              registryOrigin,
              adminPasswordSecret: secretNames.admin,
              storageEndpoint: storageBinding.regionEndpoint,
            }),
          },
          // A shared hook may run two sequential 600-second consumer plans.
          // Keep its enclosing deadline above their sum and bounded by the suite.
          timeout: sharedExternalConsumer ? 1_260_000 : 600_000,
        });
      }
    );
  }
);
