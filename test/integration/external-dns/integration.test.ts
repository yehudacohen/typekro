import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { execSync } from 'node:child_process';
import { type } from 'arktype';
import {
  externalDnsHelmRelease,
  externalDnsHelmRepository,
} from '../../../src/factories/external-dns';
import {
  createCoreV1ApiClient,
  deleteNamespaceIfExists,
  ensureNamespaceExists,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

interface ResourceGraphInspectable {
  createResourceGraphForInstance(spec: Record<string, unknown>): {
    resources: Array<{
      manifest: {
        kind?: string;
        spec?: { values?: Record<string, unknown> };
      };
    }>;
  };
}

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function loadAwsCredentials(): AwsCredentials | undefined {
  try {
    execSync('aws sts get-caller-identity', { encoding: 'utf-8', timeout: 10000 });
    const envOutput = execSync('aws configure export-credentials --format env-no-export', {
      encoding: 'utf-8',
      timeout: 10000,
    });
    const envMap = Object.fromEntries(
      envOutput.trim().split('\n').map((line: string) => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq), line.slice(eq + 1)];
      })
    );
    const accessKeyId = envMap.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
    const secretAccessKey = envMap.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
    const sessionToken = envMap.AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN;

    if (!accessKeyId || !secretAccessKey) return undefined;
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  } catch {
    return undefined;
  }
}

function loadAwsCredentialsOrSkip(): AwsCredentials | undefined {
  const credentials = loadAwsCredentials();
  if (credentials) return credentials;

  const message = 'no valid AWS credentials (run: aws sts get-caller-identity)';
  if (process.env.REQUIRE_AWS_EXTERNAL_DNS === 'true') {
    throw new Error(`External-DNS AWS integration is required, but ${message}`);
  }

  console.log(`⏭️  Skipping test: ${message}`);
  return undefined;
}

async function installAwsCredentialsSecret(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  credentials: AwsCredentials
): Promise<void> {
  await ensureNamespaceExists(namespace, kubeConfig);
  const coreApi = createCoreV1ApiClient(kubeConfig);

  try {
    await coreApi.deleteNamespacedSecret({
      name: 'aws-route53-credentials',
      namespace,
    });
  } catch (_e) {
    // Secret may not exist from a prior run.
  }

  await coreApi.createNamespacedSecret({
    namespace,
    body: {
      metadata: { name: 'aws-route53-credentials' },
      stringData: {
        'access-key-id': credentials.accessKeyId,
        'secret-access-key': credentials.secretAccessKey,
        ...(credentials.sessionToken ? { 'session-token': credentials.sessionToken } : {}),
      },
    } as k8s.V1Secret,
  });
}

// Test schemas for integration testing
const _ExternalDnsTestSpecSchema = type({
  name: 'string',
  namespace: 'string',
  provider: 'string',
  domainFilters: 'string[]',
});

const _ExternalDnsTestStatusSchema = type({
  ready: 'boolean',
  deploymentReady: 'boolean',
  dnsRecordsManaged: 'number',
});

// Skip tests if no cluster is available
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('External-DNS Integration Tests', () => {
  const testNamespace = 'typekro-test-external-dns';
  let kubeConfig: k8s.KubeConfig;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('Setting up external-dns integration tests...');
    kubeConfig = getIntegrationTestKubeConfig();
    console.log('✅ Cluster connection established');

    // Create test namespace
    await ensureNamespaceExists(testNamespace, kubeConfig);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    console.log('Cleaning up external-dns integration tests...');
    await deleteNamespaceIfExists(testNamespace, kubeConfig);
  });

  it('should deploy external-dns ecosystem successfully', async () => {
    // Test complete external-dns ecosystem deployment with real AWS credentials
    const { externalDnsBootstrap } = await import(
      '../../../src/factories/external-dns/compositions/external-dns-bootstrap.js'
    );
    const credentials = loadAwsCredentialsOrSkip();
    if (!credentials) {
      return;
    }

    await installAwsCredentialsSecret(kubeConfig, 'external-dns', credentials);

    const directFactory = externalDnsBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true, // Wait for ready with real credentials
      timeout: 180000, // 3 minutes for Helm installation
      kubeConfig: kubeConfig,
    });

    const instance = await directFactory.deploy({
      name: 'external-dns-ecosystem-test',
      namespace: 'external-dns',
      provider: 'aws',
      domainFilters: ['test.example.com'],
      policy: 'upsert-only',
      dryRun: true, // dry-run mode - no actual DNS changes
    });

    // Validate ecosystem deployment - check that the bootstrap composition worked
    expect(instance).toBeDefined();
    expect(instance.kind).toBe('EnhancedResource');
    expect(instance.metadata.name).toBe('external-dns-ecosystem-test');
    expect(instance.spec.provider).toBe('aws');
    expect(instance.spec.domainFilters).toEqual(['test.example.com']);
    expect(instance.spec.dryRun).toBe(true);

    // Validate status fields are present and properly typed
    expect(instance.status).toBeDefined();
    expect(typeof instance.status.ready).toBe('boolean');
    expect(instance.status.dnsProvider).toBe('aws');
    expect(instance.status.policy).toBe('upsert-only');
    expect(instance.status.dryRun).toBe(true);
    expect(instance.status.endpoints).toBeDefined();
    expect(typeof instance.status.endpoints.metrics).toBe('string');
    expect(typeof instance.status.endpoints.healthz).toBe('string');
    expect(instance.status.records).toBeDefined();
    expect(typeof instance.status.records.managed).toBe('number');

    // Note: status.ready may be false initially as HelmRelease takes time to reach Ready phase
    // This is expected behavior - the resources are deployed but may not be ready immediately

    // Note: Cleanup is handled by the test framework
  }, 180000); // 3 minute timeout for complete ecosystem deployment

  it('should handle TypeKro features integration', async () => {
    // Test external-dns resources with kubernetesComposition and toResourceGraph
    const repository = externalDnsHelmRepository({
      name: 'external-dns-typekro-test',
      namespace: 'flux-system',
      id: 'testRepo',
    });

    const release = externalDnsHelmRelease({
      name: 'external-dns-typekro-test',
      namespace: 'external-dns',
      repositoryName: 'external-dns-typekro-test',
      values: {
        provider: 'aws',
        domainFilters: ['typekro.example.com'],
        policy: 'upsert-only',
        dryRun: true,
      },
      id: 'testRelease',
    });

    // Validate serialization to YAML
    expect(repository.kind).toBe('HelmRepository');
    expect(repository.apiVersion).toBe('source.toolkit.fluxcd.io/v1');
    expect(release.kind).toBe('HelmRelease');
    expect(release.apiVersion).toBe('helm.toolkit.fluxcd.io/v2');

    // Validate configuration
    expect(repository.spec.url).toBe('https://kubernetes-sigs.github.io/external-dns/');
    expect(release.spec.chart.spec.chart).toBe('external-dns');
    expect(release.spec.values?.provider).toBe('aws');
    expect(release.spec.values?.dryRun).toBe(true);
  });

  it('bootstrap should be provider-aware and forward advanced schema fields into Helm values', async () => {
    const { externalDnsBootstrap } = await import(
      '../../../src/factories/external-dns/compositions/external-dns-bootstrap.js'
    );

    const directFactory = externalDnsBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: false,
      kubeConfig,
    });
    const graph = (directFactory as unknown as ResourceGraphInspectable).createResourceGraphForInstance({
      name: 'external-dns-cloudflare-bootstrap',
      namespace: 'external-dns',
      provider: 'cloudflare',
      domainFilters: ['cloudflare.example.com'],
      policy: 'sync',
      dryRun: true,
      txtOwnerId: 'typekro-test',
      interval: '30s',
      logLevel: 'debug',
    });

    const helmRelease = graph.resources.find((resource) => resource.manifest.kind === 'HelmRelease')
      ?.manifest;
    const values = helmRelease?.spec?.values as Record<string, unknown> | undefined;

    expect(values?.provider).toBe('cloudflare');
    expect(values?.domainFilters).toEqual(['cloudflare.example.com']);
    expect(values?.policy).toBe('sync');
    expect(values?.dryRun).toBe(true);
    expect(values?.txtOwnerId).toBe('typekro-test');
    expect(values?.interval).toBe('30s');
    expect(values?.logLevel).toBe('debug');
    expect(values?.env).toBeUndefined();
  });

  it('bootstrap supports KRO paths with values emitted at spec.values', async () => {
    const { externalDnsBootstrap } = await import(
      '../../../src/factories/external-dns/compositions/external-dns-bootstrap.js'
    );

    expect(() => externalDnsBootstrap.toYaml()).not.toThrow();
    expect(() => externalDnsBootstrap.factory('kro')).not.toThrow();
  });

  it('bootstrap deploys through KRO and reconciles dynamic Helm values at runtime', async () => {
    const credentials = loadAwsCredentialsOrSkip();
    if (!credentials) {
      return;
    }

    const { externalDnsBootstrap } = await import(
      '../../../src/factories/external-dns/compositions/external-dns-bootstrap.js'
    );

    const kroNamespace = `${testNamespace}-kro`;
    const appNamespace = `${testNamespace}-runtime`;
    const instanceName = 'external-dns-kro-values';
    let deleteInstance: (() => Promise<unknown>) | undefined;

    try {
      await ensureNamespaceExists(kroNamespace, kubeConfig);
      await installAwsCredentialsSecret(kubeConfig, appNamespace, credentials);

      const kroFactory = externalDnsBootstrap.factory('kro', {
        namespace: kroNamespace,
        waitForReady: true,
        timeout: 300000,
        kubeConfig,
      });
      deleteInstance = () => kroFactory.deleteInstance(instanceName);

      const instance = await kroFactory.deploy({
        name: instanceName,
        namespace: appNamespace,
        provider: 'aws',
        domainFilters: ['kro-runtime.example.com'],
        policy: 'upsert-only',
        dryRun: true,
        txtOwnerId: 'typekro-kro-test',
        interval: '1m',
        logLevel: 'debug',
      });

      expect(instance.spec.provider).toBe('aws');
      expect(instance.spec.domainFilters).toEqual(['kro-runtime.example.com']);
      expect(instance.spec.dryRun).toBe(true);
      expect(instance.status.ready).toBe(true);
      expect(instance.status.dnsProvider).toBe('aws');
      expect(instance.status.policy).toBe('upsert-only');
    } finally {
      if (deleteInstance) {
        try {
          await deleteInstance();
        } catch (e) {
          console.error('⚠️ KRO deleteInstance failed:', (e as Error).message);
        }
      }
      try {
        await deleteNamespaceIfExists(appNamespace, kubeConfig);
      } catch (_e) {
        // Namespace cleanup is best-effort after failed deploys.
      }
      try {
        await deleteNamespaceIfExists(kroNamespace, kubeConfig);
      } catch (_e) {
        // Namespace cleanup is best-effort after failed deploys.
      }
    }
  }, 420000);

  it('exposes direct and KRO strategies for bootstrap composition', async () => {
    const { externalDnsBootstrap } = await import(
      '../../../src/factories/external-dns/compositions/external-dns-bootstrap.js'
    );

    const directFactory = externalDnsBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: false,
      kubeConfig: kubeConfig,
    });

    expect(directFactory.mode).toBe('direct');
    expect(directFactory.namespace).toBe(testNamespace);

    const kroFactory = externalDnsBootstrap.factory('kro', {
      namespace: testNamespace,
      waitForReady: false,
      kubeConfig: kubeConfig,
    });
    expect(kroFactory.mode).toBe('kro');
  });

  it('should handle DNS record management correctly', async () => {
    // External-dns with provider: 'aws' requires valid AWS credentials to start.
    // The pod will crash-loop without them, causing a 180s timeout.
    // Use sts get-caller-identity to verify credentials from any source
    // (env vars, profiles, SSO, instance roles, etc.).
    if (!loadAwsCredentialsOrSkip()) {
      return;
    }

    const { externalDnsBootstrap } = await import(
      '../../../src/factories/external-dns/compositions/external-dns-bootstrap.js'
    );

    const directFactory = externalDnsBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true, // Wait for ready
      timeout: 180000, // 3 minutes
      kubeConfig: kubeConfig,
    });

    const instance = await directFactory.deploy({
      name: 'external-dns-dns-test',
      namespace: 'external-dns',
      provider: 'aws',
      domainFilters: ['test.example.com', 'example.org'],
      policy: 'sync',
      dryRun: true, // Important: use dry-run to avoid actual DNS changes
      txtOwnerId: 'typekro-test',
    });

    // Validate DNS configuration
    expect(instance.spec.provider).toBe('aws');
    expect(instance.spec.domainFilters).toEqual(['test.example.com', 'example.org']);
    expect(instance.spec.policy).toBe('sync');
    expect(instance.spec.dryRun).toBe(true);
    expect(instance.spec.txtOwnerId).toBe('typekro-test');

    // Validate status reflects DNS configuration
    expect(instance.status.dnsProvider).toBe('aws');
    expect(instance.status.policy).toBe('sync');
    expect(instance.status.dryRun).toBe(true);
    expect(instance.status.records).toBeDefined();
    expect(typeof instance.status.records.managed).toBe('number');

    // Note: In a real deployment, external-dns would manage actual DNS records
    // This test validates the TypeKro composition structure and configuration
  }, 300000); // 5 minutes — factory deploys HelmRelease with waitForReady, needs chart pull + pod startup

  it('should validate provider configurations correctly', async () => {
    // Test different provider configurations
    const awsRelease = externalDnsHelmRelease({
      name: 'external-dns-aws-test',
      namespace: 'external-dns',
      repositoryName: 'external-dns-repo',
      values: {
        provider: 'aws',
        aws: {
          region: 'us-east-1',
          zoneType: 'public',
        },
        domainFilters: ['aws.example.com'],
        policy: 'sync',
        dryRun: true,
      },
      id: 'awsRelease',
    });

    const cloudflareRelease = externalDnsHelmRelease({
      name: 'external-dns-cloudflare-test',
      namespace: 'external-dns',
      repositoryName: 'external-dns-repo',
      values: {
        provider: 'cloudflare',
        cloudflare: {
          proxied: true,
        },
        domainFilters: ['cloudflare.example.com'],
        policy: 'upsert-only',
        dryRun: true,
      },
      id: 'cloudflareRelease',
    });

    // Validate AWS configuration
    const awsValues = awsRelease.spec.values as {
      provider?: string;
      aws?: { region?: string; zoneType?: string; credentials?: Record<string, string> };
      domainFilters?: string[];
      policy?: string;
      dryRun?: boolean;
    } | undefined;
    expect(awsValues?.provider).toBe('aws');
    expect(awsValues?.aws?.region).toBe('us-east-1');
    expect(awsValues?.aws?.zoneType).toBe('public');
    expect(awsValues?.domainFilters).toEqual(['aws.example.com']);
    expect(awsValues?.policy).toBe('sync');

    // Validate Cloudflare configuration
    const cloudflareValues = cloudflareRelease.spec.values as {
      provider?: string;
      cloudflare?: { proxied?: boolean };
      domainFilters?: string[];
      policy?: string;
      dryRun?: boolean;
    } | undefined;
    expect(cloudflareValues?.provider).toBe('cloudflare');
    expect(cloudflareValues?.cloudflare?.proxied).toBe(true);
    expect(cloudflareValues?.domainFilters).toEqual(['cloudflare.example.com']);
    expect(cloudflareValues?.policy).toBe('upsert-only');

    // Both should have dry-run enabled for testing
    expect(awsValues?.dryRun).toBe(true);
    expect(cloudflareValues?.dryRun).toBe(true);
  });

  it('should handle security and credentials properly', async () => {
    // Test credential handling via Kubernetes secrets
    const secureRelease = externalDnsHelmRelease({
      name: 'external-dns-secure-test',
      namespace: 'external-dns',
      repositoryName: 'external-dns-repo',
      values: {
        provider: 'aws',
        aws: {
          region: 'us-east-1',
          credentials: {
            secretName: 'aws-external-dns-credentials',
            accessKeyIdKey: 'access-key-id',
            secretAccessKeyKey: 'secret-access-key',
          },
        },
        domainFilters: ['secure.example.com'],
        policy: 'upsert-only',
        dryRun: true,
      },
      id: 'secureRelease',
    });

    // Validate credential configuration
    const secureValues = secureRelease.spec.values as {
      aws?: { credentials?: { secretName?: string; accessKeyIdKey?: string; secretAccessKeyKey?: string } };
    } | undefined;
    expect(secureValues?.aws?.credentials?.secretName).toBe(
      'aws-external-dns-credentials'
    );
    expect(secureValues?.aws?.credentials?.accessKeyIdKey).toBe('access-key-id');
    expect(secureValues?.aws?.credentials?.secretAccessKeyKey).toBe(
      'secret-access-key'
    );

    // Ensure dry-run is enabled for security
    expect(secureRelease.spec.values?.dryRun).toBe(true);
  });
});
