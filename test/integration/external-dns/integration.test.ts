import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import {
  externalDnsHelmRepository,
  externalDnsHelmRelease,
} from '../../../src/factories/external-dns';
import { type } from 'arktype';
import {
  createCoreV1ApiClient,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  ensureNamespaceExists,
  deleteNamespaceIfExists,
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

    // Get AWS credentials from default profile
    let awsAccessKeyId: string;
    let awsSecretAccessKey: string;

    try {
      awsAccessKeyId = execSync('aws configure get aws_access_key_id', {
        encoding: 'utf-8',
      }).trim();
      awsSecretAccessKey = execSync('aws configure get aws_secret_access_key', {
        encoding: 'utf-8',
      }).trim();

      if (!awsAccessKeyId || !awsSecretAccessKey) {
        throw new Error('AWS credentials not found');
      }
    } catch (_error) {
      console.log('⏭️  Skipping test: AWS credentials not configured');
      return; // Skip test if no credentials
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
    try {
      await coreApi.createNamespacedSecret({
        namespace: 'external-dns',
        body: {
          metadata: { name: 'aws-route53-credentials' },
          stringData: {
            'access-key-id': awsAccessKeyId,
            'secret-access-key': awsSecretAccessKey,
          },
        } as k8s.V1Secret
      });
    } catch (e: any) {
      if (e.statusCode !== 409) {
        // Ignore AlreadyExists errors
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

  it('should support dual deployment strategies', async () => {
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

    // Test kro factory creation and deployment
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

    // Test direct deployment first
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

    // Test kro deployment - this should work properly
    const kroInstance = await kroFactory.deploy({
      name: 'external-dns-dual-kro',
      namespace: 'external-dns',
      provider: 'aws',
      domainFilters: ['dual-strategy-kro.example.com'],
      policy: 'upsert-only',
      dryRun: true,
    });

    // Validate kro deployment
    expect(kroInstance).toBeDefined();
    expect(kroInstance.metadata.name).toBe('external-dns-dual-kro');
    expect(kroInstance.spec.provider).toBe('aws');
    expect(kroInstance.spec.dryRun).toBe(true);

    // Clean up both instances
    await kroFactory.deleteInstance('external-dns-dual-kro');

    // Validate status fields
    expect(directInstance.status).toBeDefined();
    expect(typeof directInstance.status.ready).toBe('boolean');
    expect(directInstance.status.dnsProvider).toBe('aws');
    expect(directInstance.status.policy).toBe('upsert-only');
    expect(directInstance.status.dryRun).toBe(true);

    // Clean up - skip for now due to cleanup bug
    // await directFactory.deleteInstance('external-dns-dual-direct');
  });

  it('should handle DNS record management correctly', async () => {
    // Test DNS record management with test credentials (dryRun mode)
    // Test DNS record management through external-dns bootstrap composition
    // Note: This test validates the composition structure rather than actual DNS records
    // since we use dryRun mode to avoid making real DNS changes

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
  }, 60000); // 1 minute timeout

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
    expect(awsRelease.spec.values?.provider).toBe('aws');
    expect(awsRelease.spec.values?.aws?.region).toBe('us-east-1');
    expect(awsRelease.spec.values?.aws?.zoneType).toBe('public');
    expect(awsRelease.spec.values?.domainFilters).toEqual(['aws.example.com']);
    expect(awsRelease.spec.values?.policy).toBe('sync');

    // Validate Cloudflare configuration
    expect(cloudflareRelease.spec.values?.provider).toBe('cloudflare');
    expect(cloudflareRelease.spec.values?.cloudflare?.proxied).toBe(true);
    expect(cloudflareRelease.spec.values?.domainFilters).toEqual(['cloudflare.example.com']);
    expect(cloudflareRelease.spec.values?.policy).toBe('upsert-only');

    // Both should have dry-run enabled for testing
    expect(awsRelease.spec.values?.dryRun).toBe(true);
    expect(cloudflareRelease.spec.values?.dryRun).toBe(true);
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
    expect(secureRelease.spec.values?.aws?.credentials?.secretName).toBe(
      'aws-external-dns-credentials'
    );
    expect(secureRelease.spec.values?.aws?.credentials?.accessKeyIdKey).toBe('access-key-id');
    expect(secureRelease.spec.values?.aws?.credentials?.secretAccessKeyKey).toBe(
      'secret-access-key'
    );

    // Ensure dry-run is enabled for security
    expect(secureRelease.spec.values?.dryRun).toBe(true);
  });
});
