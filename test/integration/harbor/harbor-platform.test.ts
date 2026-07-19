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
 * Retained mode is deliberate: Chirp consumes that shared registry platform.
 * Non-retained runs use unique namespaces, project, bucket, and NodePorts and
 * perform TypeKro-first teardown without touching the retained installation.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { V1Secret } from '@kubernetes/client-node';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import {
  clearContainerCache,
  container,
  harbor as harborRegistry,
  kubernetesSecretRegistryCredentials,
} from '../../../src/core/containers/index.js';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { createBunCompatibleCoreV1Api } from '../../../src/core/kubernetes/index.js';
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
  deleteNamespaceAndWait,
  ensureNamespaceExists,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const requested = process.env.RUN_HARBOR_PLATFORM_INTEGRATION === 'true';
const describeOrSkip = requested && isClusterAvailable() ? describe : describe.skip;
const retainPlatform = process.env.KEEP_HARBOR_PLATFORM === 'true';
const deploymentMode = process.env.HARBOR_DEPLOYMENT_MODE === 'direct' ? 'direct' : 'kro';
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const suffix = retainPlatform ? 'harbor' : `harbor-${runId}`;
const controlNamespace = `typekro-${suffix}-platform-control`.slice(0, 63);
const harborNamespace = `typekro-${suffix}-registry`.slice(0, 63);
const clientNamespace = `typekro-${suffix}-clients`.slice(0, 63);
const storageClassName = 'typekro-harbor-bucket-retain';
const disposableStorageClassName = `typekro-${suffix}-bucket-delete`.slice(0, 63);
const activeStorageClassName = retainPlatform ? storageClassName : disposableStorageClassName;
const claimName = retainPlatform
  ? 'harbor-registry-storage'
  : `harbor-storage-${runId}`.slice(0, 63);
const installationName = retainPlatform ? 'harbor' : `harbor-${runId}`.slice(0, 63);
const projectName = retainPlatform ? 'chirp-live' : `chirp-${runId}`.slice(0, 63);
const port = Number(process.env.HARBOR_NODE_PORT ?? (retainPlatform ? 32_080 : 32_082));
// The official NodePort is reachable from both the host and BuildKit through
// the OrbStack Kubernetes node. Host-side port-forwarding is intentionally not
// part of the registry lifecycle proof.
let apiOrigin = '';
let registryHost = '';
let registryOrigin = '';

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

async function kubectlRead(args: string[], timeout = 60_000): Promise<string> {
  const proc = Bun.spawn(['kubectl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr || stdout);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function ensureSecret(
  name: string,
  stringData: Readonly<Record<string, string>>
): Promise<void> {
  const store = createHarborKubernetesStore({ skipTLSVerify: true });
  await store.upsertSecret({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace: harborNamespace,
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
  `official Harbor platform (${deploymentMode}) backed by retained Rook/Ceph object storage`,
  () => {
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
    let harborDeployed = false;
    let claimDeployed = false;
    let projectReconciled = false;
    let bucketClassDeployed = false;

    beforeAll(async () => {
      const prerequisite = await kubectlRead([
        'get',
        'storageclass',
        storageClassName,
        '-o',
        'jsonpath={.provisioner}',
      ]).catch(() => '');
      if (prerequisite !== 'typekro-harbor-ceph.ceph.rook.io/bucket') {
        throw new Error(
          `Harbor integration requires the retained Rook platform StorageClass ${storageClassName}; ` +
            'run the Rook platform integration with KEEP_ROOK_PLATFORM=true first.'
        );
      }
      if (!retainPlatform) {
        await ensureNamespaceExists(controlNamespace, kubeConfig);
        await bucketClassFactory.deploy({ name: 'bucket-class' });
        bucketClassDeployed = true;
      }
      const nodes = JSON.parse(await kubectlRead(['get', 'nodes', '-o', 'json'])) as {
        items?: Array<{ status?: { addresses?: Array<{ type?: string; address?: string }> } }>;
      };
      const nodeAddress = nodes.items
        ?.flatMap((node) => node.status?.addresses ?? [])
        .find(
          (address) =>
            address.type === 'InternalIP' &&
            typeof address.address === 'string' &&
            address.address.includes('.')
        )?.address;
      if (!nodeAddress) throw new Error('OrbStack Kubernetes node has no InternalIP address.');
      registryHost = `${nodeAddress}:${port}`;
      registryOrigin = `http://${registryHost}`;
      apiOrigin = registryOrigin;
      await ensureNamespaceExists(harborNamespace, kubeConfig);
      await ensureNamespaceExists(clientNamespace, kubeConfig);
      testSecrets = await loadOrCreateHarborTestSecrets(store);
      const claim = await claimFactory.deploy({
        name: claimName,
        namespace: harborNamespace,
        storageClassName: activeStorageClassName,
        bucket: { name: `typekro-${suffix}-registry`.slice(0, 63), mode: 'generated' },
      });
      claimDeployed = true;
      expect(claim.status).toMatchObject({ ready: true, phase: 'Bound' });
      const storage = await prepareHarborRookS3Binding({
        sourceNamespace: harborNamespace,
        claimName,
        targetNamespace: harborNamespace,
        targetSecretName: secretNames.storage,
        kubeConfig: { skipTLSVerify: true },
        rootDirectory: '/registry',
      });
      expect(storage.existingSecret).toBe(secretNames.storage);
      await ensureHarborSecrets();
    });

    afterAll(async () => {
      if (retainPlatform) return;
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
      if (harborDeployed) {
        await harborFactory
          .deleteInstance(installationName)
          .catch((error) => cleanupErrors.push(error));
      }
      if (claimDeployed) {
        await claimFactory.deleteInstance(claimName).catch((error) => cleanupErrors.push(error));
      }
      if (bucketClassDeployed) {
        await bucketClassFactory
          .deleteInstance('bucket-class', { scopes: ['cluster'], includeUnscopedResources: true })
          .catch((error) => cleanupErrors.push(error));
      }
      await deleteNamespaceAndWait(harborNamespace, kubeConfig, 600_000).catch((error) =>
        cleanupErrors.push(error)
      );
      await deleteNamespaceAndWait(clientNamespace, kubeConfig, 600_000).catch((error) =>
        cleanupErrors.push(error)
      );
      if (!retainPlatform) {
        await deleteNamespaceAndWait(controlNamespace, kubeConfig, 600_000).catch((error) =>
          cleanupErrors.push(error)
        );
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Harbor integration cleanup failed');
      }
    });

    it(`installs the official chart through ${deploymentMode} mode with schema-complete status`, async () => {
      const storage = await prepareHarborRookS3Binding({
        sourceNamespace: harborNamespace,
        claimName,
        targetNamespace: harborNamespace,
        targetSecretName: secretNames.storage,
        kubeConfig: { skipTLSVerify: true },
        rootDirectory: '/registry',
      });
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
          ...storage,
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
      const installation = await harborFactory.deploy(desired);
      harborDeployed = true;
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
      expect(installation.status.observedGeneration).toBeGreaterThan(0);
      expect(installation.status.conditions.length).toBeGreaterThan(0);
      const ping = await fetch(`${apiOrigin}/api/v2.0/ping`);
      expect(await ping.text()).toBe('Pong');

      // Exercise an actual factory update. waitForReady must not reuse the prior
      // generation's Ready condition while Flux is still reconciling the new
      // HelmRelease generation.
      const updated = await harborFactory.deploy({ ...desired, metricsEnabled: true });
      expect(updated.status).toMatchObject({ ready: true, failed: false, phase: 'Ready' });
      expect(updated.status.observedGeneration).toBeGreaterThanOrEqual(
        installation.status.observedGeneration
      );
      if (deploymentMode === 'kro') {
        const owner = JSON.parse(
          await kubectlRead([
            'get',
            'harborlocalinstallation',
            installationName,
            '-n',
            controlNamespace,
            '-o',
            'json',
          ])
        ) as {
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
      expect(
        await kubectlRead([
          'get',
          'helmrelease',
          installationName,
          '-n',
          harborNamespace,
          '-o',
          'jsonpath={.spec.values.metrics.enabled}',
        ])
      ).toBe('true');

      // Restart one official Harbor component and prove bounded recovery.
      await kubectlRead([
        'rollout',
        'restart',
        `deployment/${installationName}-core`,
        '-n',
        harborNamespace,
      ]);
      await kubectlRead(
        [
          'rollout',
          'status',
          `deployment/${installationName}-core`,
          '-n',
          harborNamespace,
          '--timeout=300s',
        ],
        330_000
      );
      expect(await (await fetch(`${apiOrigin}/api/v2.0/ping`)).text()).toBe('Pong');
    });

    it('reconciles a private project and purpose-scoped robot credentials idempotently', async () => {
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
    });

    it('pushes once through container(), verifies the registry digest, and exposes the artifact', async () => {
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

      const coreApi = createBunCompatibleCoreV1Api(kubeConfig);
      const pullPod = `harbor-pull-${runId}`.slice(0, 63);
      await coreApi.createNamespacedPod({
        namespace: clientNamespace,
        body: {
          metadata: { name: pullPod },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'proof',
                image:
                  'gcr.io/go-containerregistry/crane@sha256:1b1fb24d2b1bb27a9daf81a588157e68463876904e8e537a812edba6284fb252',
                command: ['/ko-app/crane'],
                args: ['digest', '--insecure', first.imageUri],
                env: [{ name: 'DOCKER_CONFIG', value: '/docker' }],
                volumeMounts: [{ name: 'registry-auth', mountPath: '/docker', readOnly: true }],
              },
            ],
            volumes: [
              {
                name: 'registry-auth',
                secret: {
                  secretName: secretNames.robotPull,
                  items: [{ key: '.dockerconfigjson', path: 'config.json' }],
                },
              },
            ],
          },
        },
      });
      try {
        await kubectlRead(
          [
            'wait',
            '--for=jsonpath={.status.phase}=Succeeded',
            `pod/${pullPod}`,
            '-n',
            clientNamespace,
            '--timeout=300s',
          ],
          330_000
        );
        expect(await kubectlRead(['logs', pullPod, '-n', clientNamespace])).toBe(digest);
      } finally {
        await coreApi
          .deleteNamespacedPod({ namespace: clientNamespace, name: pullPod })
          .catch(() => undefined);
      }

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
    });
  }
);
