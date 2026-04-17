import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
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
    const { execSync } = require('node:child_process');

    // Verify and export AWS credentials from any source (env vars, profiles, SSO, etc.)
    let awsAccessKeyId: string;
    let awsSecretAccessKey: string;
    let awsSessionToken: string | undefined;
    try {
      execSync('aws sts get-caller-identity', { encoding: 'utf-8', timeout: 10000 });
      // Export resolved credentials (works with SSO, env vars, profiles, instance roles)
      const envOutput = execSync('aws configure export-credentials --format env-no-export', {
        encoding: 'utf-8', timeout: 10000,
      });
      const envMap = Object.fromEntries(
        envOutput.trim().split('\n').map((line: string) => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq), line.slice(eq + 1)];
        })
      );
      awsAccessKeyId = envMap.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
      awsSecretAccessKey = envMap.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
      awsSessionToken = envMap.AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN;
      if (!awsAccessKeyId || !awsSecretAccessKey) throw new Error('empty');
    } catch {
      console.log('⏭️  Skipping test: no valid AWS credentials (run: aws sts get-caller-identity)');
      return;
    }

    // Create the namespace first
    const coreApi = createCoreV1ApiClient(kubeConfig);
    try {
      await coreApi.createNamespace({
        body: { metadata: { name: 'external-dns' } },
      });
    } catch (_e) {
      // Namespace may already exist
    }

    // Deploy the secret with real AWS credentials
    // Use replace strategy to handle existing secrets from previous test runs
    try {
      // First try to delete existing secret
      await coreApi.deleteNamespacedSecret({
        name: 'aws-route53-credentials',
        namespace: 'external-dns',
      });
    } catch (_e) {
      // Secret may not exist, ignore
    }

    try {
      await coreApi.createNamespacedSecret({
        namespace: 'external-dns',
        body: {
          metadata: { name: 'aws-route53-credentials' },
          stringData: {
            'access-key-id': awsAccessKeyId,
            'secret-access-key': awsSecretAccessKey,
            ...(awsSessionToken ? { 'session-token': awsSessionToken } : {}),
          },
        } as k8s.V1Secret,
      });
    } catch (e: any) {
      if (e.body?.code !== 409 && e.statusCode !== 409) {
        // Ignore AlreadyExists errors (409)
        throw e;
      }
    }

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

  it.skip('should support dual deployment strategies', async () => {
    // Test both kro and direct deployment strategies using proper bootstrap composition
    // Note: Credentials secret already created in previous test
    const { externalDnsBootstrap } = await import(
      '../../../src/factories/external-dns/compositions/external-dns-bootstrap.js'
    );

    // Test direct deployment strategy
    const directFactory = externalDnsBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true, // Wait for ready
      timeout: 180000, // 3 minutes
      kubeConfig: kubeConfig,
    });

    // Test kro factory creation (but not deployment)
    // NOTE: Kro deployment of HelmRelease with arbitrary spec.values is not supported
    // because Kro requires a schema for all fields, and HelmRelease spec.values is arbitrary.
    // This is a known limitation documented in external-manifest-compatibility.md
    const kroFactory = externalDnsBootstrap.factory('kro', {
      namespace: testNamespace,
      waitForReady: true, // Wait for ready
      timeout: 180000, // 3 minutes
      kubeConfig: kubeConfig,
    });

    // Both factories should be created successfully
    expect(directFactory.mode).toBe('direct');
    expect(kroFactory.mode).toBe('kro');
    expect(directFactory.namespace).toBe(testNamespace);
    expect(kroFactory.namespace).toBe(testNamespace);

    // Test direct deployment
    const directInstance = await directFactory.deploy({
      name: 'external-dns-dual-direct',
      namespace: 'external-dns',
      provider: 'aws',
      domainFilters: ['dual-strategy.example.com'],
      policy: 'upsert-only',
      dryRun: true,
    });

    // Validate direct deployment structure and status
    expect(directInstance).toBeDefined();
    expect(directInstance.metadata.name).toBe('external-dns-dual-direct');
    expect(directInstance.spec.provider).toBe('aws');
    expect(directInstance.spec.dryRun).toBe(true);

    // Skip Kro deployment test - Kro cannot handle HelmRelease with arbitrary spec.values
    // The Kro controller fails with: "error getting field schema for path spec.values.dryRun"
    // This is expected behavior - Kro requires schemas for all fields
    console.log('⏭️  Skipping Kro deployment: HelmRelease spec.values not supported by Kro');

    // Validate status fields
    expect(directInstance.status).toBeDefined();
    expect(typeof directInstance.status.ready).toBe('boolean');
    expect(directInstance.status.dnsProvider).toBe('aws');
    expect(directInstance.status.policy).toBe('upsert-only');
    expect(directInstance.status.dryRun).toBe(true);

    // Clean up
    // await directFactory.deleteInstance('external-dns-dual-direct');
  }, 360000); // 6 minute timeout for dual deployment (kro takes longer)

  it('should handle DNS record management correctly', async () => {
    // External-dns with provider: 'aws' requires valid AWS credentials to start.
    // The pod will crash-loop without them, causing a 180s timeout.
    // Use sts get-caller-identity to verify credentials from any source
    // (env vars, profiles, SSO, instance roles, etc.).
    const { execSync } = require('node:child_process');
    try {
      execSync('aws sts get-caller-identity', { encoding: 'utf-8', timeout: 10000 });
    } catch {
      throw new Error(
        'Valid AWS credentials required for external-dns integration test.\n' +
        'Options:\n' +
        '  • aws sso login --profile <your-profile>\n' +
        '  • export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...\n' +
        '  • aws configure\n' +
        'Verify with: aws sts get-caller-identity'
      );
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
