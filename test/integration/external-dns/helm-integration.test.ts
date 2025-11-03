import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { externalDnsHelmRepository, externalDnsHelmRelease } from '../../../src/factories/external-dns';
import { getIntegrationTestKubeConfig, isClusterAvailable } from '../shared-kubeconfig.js';

// Skip tests if no cluster is available
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('External-DNS Helm Integration', () => {
  const _testNamespace = 'typekro-test';
  let _kubeConfig: k8s.KubeConfig;
  
  beforeAll(async () => {
    if (!clusterAvailable) return;
    
    // Set up test environment
    console.log('Setting up external-dns Helm integration tests...');
    
    // Use shared kubeconfig helper for consistent TLS configuration
    _kubeConfig = getIntegrationTestKubeConfig();
    
    // Verify we have a test cluster available
    console.log('✅ Cluster connection established');
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    
    // Clean up test resources
    console.log('Cleaning up external-dns Helm integration tests...');
  });

  describe('HelmRepository Wrapper', () => {
    it('should create HelmRepository for external-dns successfully with direct deployment', async () => {
      // Test external-dns HelmRepository wrapper directly
      const repository = externalDnsHelmRepository({
        name: 'external-dns-repo-direct-test',
        namespace: 'flux-system',
        id: 'externalDnsRepo',
      });

      // Deploy the repository directly using kubectl
      const { getKubeConfig } = await import('../../../src/core/kubernetes/client-provider.js');
      const kc = getKubeConfig({ skipTLSVerify: true });
      const k8sApi = kc.makeApiClient(k8s.KubernetesObjectApi);

      try {
        // Apply the HelmRepository
        await k8sApi.create(repository);
        
        // Wait a bit for the repository to be processed
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check if the repository was created
        const createdRepo = await k8sApi.read({
          apiVersion: 'source.toolkit.fluxcd.io/v1',
          kind: 'HelmRepository',
          metadata: {
            name: 'external-dns-repo-direct-test',
            namespace: 'flux-system'
          }
        });
        
        expect((createdRepo.body as any).spec.url).toBe('https://kubernetes-sigs.github.io/external-dns/');
        expect(createdRepo.body.metadata?.name).toBe('external-dns-repo-direct-test');
        
        // Clean up
        await k8sApi.delete(createdRepo.body);
      } catch (error) {
        console.error('Direct deployment test failed:', error);
        throw error;
      }
    }, 60000); // 1 minute timeout

    it('should use correct external-dns repository URL and configuration', async () => {
      // Test that the wrapper uses the correct external-dns repository URL
      const repository = externalDnsHelmRepository({
        name: 'test-external-dns-repo',
        namespace: 'flux-system',
        id: 'testRepo',
      });

      // Validate the repository configuration
      expect(repository.spec.url).toBe('https://kubernetes-sigs.github.io/external-dns/');
      expect(repository.spec.interval).toBe('5m');
      expect(repository.metadata.name).toBe('test-external-dns-repo');
      expect(repository.metadata.namespace).toBe('flux-system');
    });
  });

  describe('HelmRelease Wrapper', () => {
    it('should create HelmRelease for external-dns successfully', async () => {
      // Test external-dns HelmRelease wrapper directly
      const repository = externalDnsHelmRepository({
        name: 'external-dns-repo-for-release',
        namespace: 'flux-system',
        id: 'externalDnsRepo',
      });

      const release = externalDnsHelmRelease({
        name: 'external-dns-test-release',
        namespace: 'external-dns',
        repositoryName: 'external-dns-repo-for-release',
        values: {
          provider: 'aws',
          aws: {
            region: 'us-east-1',
          },
          domainFilters: ['example.com'],
          policy: 'sync',
        },
        id: 'externalDnsRelease',
      });

      // Deploy using kubectl
      const { getKubeConfig } = await import('../../../src/core/kubernetes/client-provider.js');
      const kc = getKubeConfig({ skipTLSVerify: true });
      const k8sApi = kc.makeApiClient(k8s.KubernetesObjectApi);
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);

      try {
        // Create external-dns namespace if it doesn't exist
        try {
          await coreApi.createNamespace({
            metadata: { name: 'external-dns' }
          });
        } catch (_error) {
          // Namespace might already exist
        }

        // Apply the HelmRepository first
        await k8sApi.create(repository);
        
        // Wait for repository to be ready
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Apply the HelmRelease
        await k8sApi.create(release);
        
        // Validate the resources were created with correct configuration
        const createdRepo = await k8sApi.read({
          apiVersion: 'source.toolkit.fluxcd.io/v1',
          kind: 'HelmRepository',
          metadata: {
            name: 'external-dns-repo-for-release',
            namespace: 'flux-system'
          }
        });
        
        const createdRelease = await k8sApi.read({
          apiVersion: 'helm.toolkit.fluxcd.io/v2',
          kind: 'HelmRelease',
          metadata: {
            name: 'external-dns-test-release',
            namespace: 'external-dns'
          }
        });
        
        expect((createdRepo.body as any).spec.url).toBe('https://kubernetes-sigs.github.io/external-dns/');
        expect((createdRelease.body as any).spec.chart.spec.chart).toBe('external-dns');
        expect((createdRelease.body as any).spec.values?.provider).toBe('aws');
        
        // Clean up
        await k8sApi.delete(createdRelease.body);
        await k8sApi.delete(createdRepo.body);
      } catch (error) {
        console.error('HelmRelease test failed:', error);
        throw error;
      }
    }, 120000); // 2 minute timeout
  });

  describe('DNS Provider Configuration', () => {
    it('should handle comprehensive DNS provider configuration system', async () => {
      // Test various external-dns provider configurations
      const awsRelease = externalDnsHelmRelease({
        name: 'external-dns-aws',
        namespace: 'external-dns',
        repositoryName: 'external-dns-repo',
        values: {
          provider: 'aws',
          aws: {
            region: 'us-east-1',
            zoneType: 'public',
          },
          domainFilters: ['example.com'],
          policy: 'sync',
          txtOwnerId: 'my-cluster',
        },
        id: 'testRelease',
      });

      // Validate AWS configuration
      expect(awsRelease.spec.values?.provider).toBe('aws');
      expect(awsRelease.spec.values?.aws?.region).toBe('us-east-1');
      expect(awsRelease.spec.values?.domainFilters).toEqual(['example.com']);

      const cloudflareRelease = externalDnsHelmRelease({
        name: 'external-dns-cloudflare',
        namespace: 'external-dns',
        repositoryName: 'external-dns-repo',
        values: {
          provider: 'cloudflare',
          cloudflare: {
            proxied: true,
          },
          domainFilters: ['example.org'],
          policy: 'upsert-only',
        },
        id: 'testRelease',
      });

      // Validate Cloudflare configuration
      expect(cloudflareRelease.spec.values?.provider).toBe('cloudflare');
      expect(cloudflareRelease.spec.values?.cloudflare?.proxied).toBe(true);
      expect(cloudflareRelease.spec.values?.domainFilters).toEqual(['example.org']);
    });

    it('should use correct chart configuration', async () => {
      // Test that the wrapper uses the correct chart configuration
      const release = externalDnsHelmRelease({
        name: 'test-external-dns',
        namespace: 'external-dns',
        repositoryName: 'external-dns-repo',
        id: 'testRelease',
      });

      // Validate chart configuration
      expect(release.spec.chart.spec.chart).toBe('external-dns');
      expect(release.spec.chart.spec.sourceRef.kind).toBe('HelmRepository');
      expect(release.spec.chart.spec.sourceRef.name).toBe('external-dns-repo');
      expect(release.spec.chart.spec.sourceRef.namespace).toBe('flux-system');
    });

    it('should handle default values correctly', async () => {
      // Test that default values are applied correctly by checking the mapping function directly
      const { mapExternalDnsConfigToHelmValues } = await import('../../../src/factories/external-dns/resources/helm.js');
      
      // Test with minimal config - should get defaults
      const defaultValues = mapExternalDnsConfigToHelmValues({
        provider: 'aws',
        domainFilters: ['example.com']
      });
      expect(defaultValues.provider).toBe('aws');
      expect(defaultValues.domainFilters).toEqual(['example.com']);
      expect(defaultValues.policy).toBe('upsert-only'); // Default policy
      
      // Test with explicit config
      const explicitValues = mapExternalDnsConfigToHelmValues({
        provider: 'cloudflare',
        domainFilters: ['example.org'],
        policy: 'sync',
        txtOwnerId: 'my-cluster'
      });
      expect(explicitValues.provider).toBe('cloudflare');
      expect(explicitValues.domainFilters).toEqual(['example.org']);
      expect(explicitValues.policy).toBe('sync');
      expect(explicitValues.txtOwnerId).toBe('my-cluster');
    });
  });

  describe('Helm Values Validation', () => {
    it('should validate Helm values correctly', async () => {
      // Import the validation function
      const { validateExternalDnsHelmValues } = await import('../../../src/factories/external-dns/resources/helm.js');

      // Test valid configuration
      const validConfig = {
        provider: 'aws' as const,
        domainFilters: ['example.com'],
        policy: 'upsert-only' as const,
        aws: {
          region: 'us-east-1',
        },
      };

      const validResult = validateExternalDnsHelmValues(validConfig);
      expect(validResult.valid).toBe(true);
      expect(validResult.errors).toHaveLength(0);

      // Test invalid configuration
      const invalidConfig = {
        provider: 'invalid-provider', // Invalid provider
        domainFilters: [], // Empty domain filters
        policy: 'invalid-policy', // Invalid policy
      } as any; // Use 'any' to test validation with invalid types

      const invalidResult = validateExternalDnsHelmValues(invalidConfig);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBeGreaterThan(0);
      expect(invalidResult.errors).toContain('provider must be one of: aws, azure, cloudflare, google, digitalocean, linode, rfc2136, webhook, akamai, ns1, plural');
      expect(invalidResult.errors).toContain('domainFilters cannot be empty');
    });

    it('should handle mapping function correctly', async () => {
      // Import the mapping function
      const { mapExternalDnsConfigToHelmValues } = await import('../../../src/factories/external-dns/resources/helm.js');

      const config = {
        provider: 'aws' as const,
        domainFilters: ['example.com', 'example.org'],
        policy: 'sync' as const,
        aws: {
          region: 'us-west-2',
          zoneType: 'private' as const,
        },
        customValue: 'test', // Custom values should be preserved
      };

      const mappedValues = mapExternalDnsConfigToHelmValues(config);

      expect(mappedValues.provider).toBe('aws');
      expect(mappedValues.domainFilters).toEqual(['example.com', 'example.org']);
      expect(mappedValues.policy).toBe('sync');
      expect(mappedValues.aws.region).toBe('us-west-2');
      expect(mappedValues.aws.zoneType).toBe('private');
      expect(mappedValues.customValue).toBe('test');
    });
  });

  describe('Security and Credentials', () => {
    it('should handle provider credentials securely', async () => {
      // Test credential handling via Kubernetes secrets
      const release = externalDnsHelmRelease({
        name: 'external-dns-secure',
        namespace: 'external-dns',
        repositoryName: 'external-dns-repo',
        values: {
          provider: 'aws',
          aws: {
            region: 'us-east-1',
            credentials: {
              secretName: 'aws-credentials',
              accessKeyIdKey: 'access-key-id',
              secretAccessKeyKey: 'secret-access-key',
            },
          },
          domainFilters: ['secure.example.com'],
        },
        id: 'testRelease',
      });

      // Validate that credentials are referenced via secrets
      expect(release.spec.values?.aws?.credentials?.secretName).toBe('aws-credentials');
      expect(release.spec.values?.aws?.credentials?.accessKeyIdKey).toBe('access-key-id');
      expect(release.spec.values?.aws?.credentials?.secretAccessKeyKey).toBe('secret-access-key');
    });
  });
});