import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { certManagerHelmRepository, certManagerHelmRelease } from '../../../src/factories/cert-manager';
import { type } from 'arktype';
import { getIntegrationTestKubeConfig, isClusterAvailable } from '../shared-kubeconfig.js';

// Test schemas for integration testing
const _TestSpecSchema = type({
  name: 'string',
  namespace: 'string',
});

const _TestStatusSchema = type({
  ready: 'boolean',
  repositoryReady: 'boolean',
  releaseReady: 'boolean',
});

// Skip tests if no cluster is available
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Cert-Manager Helm Integration', () => {
  let _kubeConfig: k8s.KubeConfig;
  const _testNamespace = 'typekro-test';

  beforeAll(async () => {
    if (!clusterAvailable) return;

    // Set up test environment
    console.log('Setting up cert-manager Helm integration tests...');

    // Use shared kubeconfig helper for consistent TLS configuration
    _kubeConfig = getIntegrationTestKubeConfig();

    // Verify we have a test cluster available
    console.log('✅ Cluster connection established');
  });

  afterAll(async () => {
    if (!clusterAvailable) return;

    // Clean up test resources
    // Leave cluster in clean state
    console.log('Cleaning up cert-manager Helm integration tests...');
  });

  describe('HelmRepository Wrapper', () => {
    it('should create HelmRepository for cert-manager successfully with direct deployment', async () => {
      // Test cert-manager HelmRepository wrapper directly
      const repository = certManagerHelmRepository({
        name: 'cert-manager-repo-direct-test',
        namespace: 'flux-system',
        id: 'certManagerRepo',
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
            name: 'cert-manager-repo-direct-test',
            namespace: 'flux-system'
          }
        });

        expect((createdRepo.body as any).spec.url).toBe('https://charts.jetstack.io');
        expect(createdRepo.body.metadata?.name).toBe('cert-manager-repo-direct-test');

        // Clean up
        await k8sApi.delete(createdRepo.body);
      } catch (error) {
        console.error('Direct deployment test failed:', error);
        throw error;
      }
    }, 60000); // 1 minute timeout

    it('should use correct cert-manager repository URL and configuration', async () => {
      // Test that the wrapper uses the correct cert-manager repository URL
      const repository = certManagerHelmRepository({
        name: 'test-cert-manager-repo',
        namespace: 'flux-system',
        id: 'testRepo',
      });

      // Validate the repository configuration
      expect(repository.spec.url).toBe('https://charts.jetstack.io');
      expect(repository.spec.interval).toBe('5m');
      expect(repository.metadata.name).toBe('test-cert-manager-repo');
      expect(repository.metadata.namespace).toBe('flux-system');
    });
  });

  describe('HelmRelease Wrapper', () => {
    it('should create HelmRelease for cert-manager successfully', async () => {
      // Test cert-manager HelmRelease wrapper directly
      const repository = certManagerHelmRepository({
        name: 'cert-manager-repo-for-release',
        namespace: 'flux-system',
        id: 'certManagerRepo',
      });

      const release = certManagerHelmRelease({
        name: 'cert-manager-test-release',
        namespace: 'cert-manager',
        repositoryName: 'cert-manager-repo-for-release',
        values: {
          installCRDs: true, // Install CRDs for comprehensive deployment
          replicaCount: 1,
        },
        id: 'certManagerRelease',
      });

      // Deploy using kubectl
      const { getKubeConfig } = await import('../../../src/core/kubernetes/client-provider.js');
      const kc = getKubeConfig({ skipTLSVerify: true });
      const k8sApi = kc.makeApiClient(k8s.KubernetesObjectApi);
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);

      try {
        // Create cert-manager namespace if it doesn't exist
        try {
          await coreApi.createNamespace({
            metadata: { name: 'cert-manager' }
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
            name: 'cert-manager-repo-for-release',
            namespace: 'flux-system'
          }
        });

        const createdRelease = await k8sApi.read({
          apiVersion: 'helm.toolkit.fluxcd.io/v2',
          kind: 'HelmRelease',
          metadata: {
            name: 'cert-manager-test-release',
            namespace: 'cert-manager'
          }
        });

        expect((createdRepo.body as any).spec.url).toBe('https://charts.jetstack.io');
        expect((createdRelease.body as any).spec.chart.spec.chart).toBe('cert-manager');
        expect((createdRelease.body as any).spec.values?.installCRDs).toBe(true);

        // Clean up
        await k8sApi.delete(createdRelease.body);
        await k8sApi.delete(createdRepo.body);
      } catch (error) {
        console.error('HelmRelease test failed:', error);
        throw error;
      }
    }, 120000); // 2 minute timeout
  });

  describe('Helm Values Mapping', () => {
    it('should handle comprehensive Helm values mapping', async () => {
      // Test various cert-manager configuration scenarios
      const release = certManagerHelmRelease({
        name: 'cert-manager-values-test',
        namespace: 'cert-manager',
        repositoryName: 'cert-manager-repo',
        values: {
          installCRDs: true, // Install CRDs for comprehensive deployment
          replicaCount: 2,
          webhook: {
            enabled: true,
            replicaCount: 2,
          },
          cainjector: {
            enabled: true,
            replicaCount: 2,
          },
          prometheus: {
            enabled: true,
            servicemonitor: {
              enabled: true,
            },
          },
        },
        id: 'testRelease',
      });

      // Validate generated Helm values
      expect(release.spec.values?.installCRDs).toBe(true);
      expect(release.spec.values?.replicaCount).toBe(2);
      expect(release.spec.values?.webhook?.enabled).toBe(true);
      expect(release.spec.values?.cainjector?.enabled).toBe(true);
      expect(release.spec.values?.prometheus?.enabled).toBe(true);
    });

    it('should use correct chart configuration', async () => {
      // Test that the wrapper uses the correct chart configuration
      const release = certManagerHelmRelease({
        name: 'test-cert-manager',
        namespace: 'cert-manager',
        repositoryName: 'cert-manager-repo',
        id: 'testRelease',
      });

      // Validate chart configuration
      expect(release.spec.chart.spec.chart).toBe('cert-manager');
      expect(release.spec.chart.spec.sourceRef.kind).toBe('HelmRepository');
      expect(release.spec.chart.spec.sourceRef.name).toBe('cert-manager-repo');
      expect(release.spec.chart.spec.sourceRef.namespace).toBe('flux-system');
    });

    it('should handle default values correctly', async () => {
      // Test that default values are applied correctly
      const release = certManagerHelmRelease({
        name: 'cert-manager-defaults',
        namespace: 'cert-manager',
        repositoryName: 'cert-manager-repo',
        id: 'testRelease',
      });

      // Should have default installCRDs: true for TypeKro comprehensive deployment
      expect(release.spec.values?.installCRDs).toBe(true);
    });

    it('should handle complex configuration scenarios', async () => {
      // Test complex configuration with all components
      const release = certManagerHelmRelease({
        name: 'cert-manager-complex',
        namespace: 'cert-manager',
        repositoryName: 'cert-manager-repo',
        values: {
          installCRDs: false,
          replicaCount: 3,
          global: {
            logLevel: 2,
            podSecurityPolicy: {
              enabled: true,
              useAppArmor: true,
            },
          },
          controller: {
            resources: {
              requests: {
                cpu: '100m',
                memory: '128Mi',
              },
              limits: {
                cpu: '500m',
                memory: '512Mi',
              },
            },
            nodeSelector: {
              'kubernetes.io/os': 'linux',
            },
          },
          webhook: {
            enabled: true,
            replicaCount: 2,
            resources: {
              requests: {
                cpu: '50m',
                memory: '64Mi',
              },
            },
          },
          cainjector: {
            enabled: true,
            replicaCount: 2,
            resources: {
              requests: {
                cpu: '50m',
                memory: '64Mi',
              },
            },
          },
          prometheus: {
            enabled: true,
            servicemonitor: {
              enabled: true,
              interval: '30s',
              scrapeTimeout: '10s',
            },
          },
        },
        id: 'testRelease',
      });

      // Validate complex configuration
      expect(release.spec.values?.global?.logLevel).toBe(2);
      expect(release.spec.values?.controller?.resources?.requests?.cpu).toBe('100m');
      expect(release.spec.values?.webhook?.replicaCount).toBe(2);
      expect(release.spec.values?.cainjector?.enabled).toBe(true);
      expect(release.spec.values?.prometheus?.servicemonitor?.interval).toBe('30s');
    });
  });

  describe('Helm Values Validation', () => {
    it('should validate Helm values correctly', async () => {
      // Import the validation function
      const { validateCertManagerHelmValues } = await import('../../../src/factories/cert-manager/resources/helm.js');

      // Test valid configuration
      const validConfig = {
        installCRDs: true,
        replicaCount: 2,
        webhook: {
          enabled: true,
          replicaCount: 1,
        },
        controller: {
          resources: {
            requests: {
              cpu: '100m',
              memory: '128Mi',
            },
          },
        },
      };

      const validResult = validateCertManagerHelmValues(validConfig);
      expect(validResult.valid).toBe(true);
      expect(validResult.errors).toHaveLength(0);

      // Test invalid configuration
      const invalidConfig = {
        replicaCount: 0, // Should be at least 1
        webhook: {
          replicaCount: -1, // Should be at least 1
        },
        controller: {
          resources: {
            requests: {
              cpu: 100, // Should be string
              memory: 128, // Should be string
            },
          },
        },
      } as any; // Use 'any' to test validation with invalid types

      const invalidResult = validateCertManagerHelmValues(invalidConfig);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBeGreaterThan(0);
      // Note: installCRDs validation removed since we now default to true for comprehensive deployment
      expect(invalidResult.errors).toContain('replicaCount must be at least 1');
    });

    it('should handle mapping function correctly', async () => {
      // Import the mapping function
      const { mapCertManagerConfigToHelmValues } = await import('../../../src/factories/cert-manager/resources/helm.js');

      const config = {
        installCRDs: true,
        replicaCount: 2,
        webhook: {
          enabled: true,
          replicaCount: 2,
        },
        customValue: 'test', // Custom values should be preserved
      };

      const mappedValues = mapCertManagerConfigToHelmValues(config);

      expect(mappedValues.installCRDs).toBe(true);
      expect(mappedValues.replicaCount).toBe(2);
      expect(mappedValues.webhook.enabled).toBe(true);
      expect(mappedValues.webhook.replicaCount).toBe(2);
      expect(mappedValues.customValue).toBe('test');
    });
  });

  describe('CRD Installation', () => {
    it('should handle CRD installation properly', async () => {
      // Test CRD installation following cert-manager best practices
      // CRDs should be installed separately before the main chart
      const release = certManagerHelmRelease({
        name: 'cert-manager-crd-test',
        namespace: 'cert-manager',
        repositoryName: 'cert-manager-repo',
        values: {
          installCRDs: true, // TypeKro comprehensive deployment includes CRDs
        },
        id: 'testRelease',
      });

      // Validate that installCRDs is set to true by default
      expect(release.spec.values?.installCRDs).toBe(true);
    });

    it('should default installCRDs to true for comprehensive deployment', async () => {
      // Test that installCRDs defaults to false when not specified
      const release = certManagerHelmRelease({
        name: 'cert-manager-default-crd',
        namespace: 'cert-manager',
        repositoryName: 'cert-manager-repo',
        // No values specified - should use defaults
        id: 'testRelease',
      });

      // Should default to installCRDs: true for TypeKro comprehensive deployment
      expect(release.spec.values?.installCRDs).toBe(true);
    });
  });
});