/**
 * Integration Tests for Cilium Ecosystem Support
 *
 * This test suite provides end-to-end integration testing for the Cilium
 * ecosystem support, including real Kubernetes API interactions and
 * actual Cilium deployments in test clusters.
 *
 * These tests require a Kubernetes cluster to be available and are designed
 * to be run with the integration test harness using scripts/e2e-setup.sh.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/index.js';
import { ciliumHelmRepository, ciliumHelmRelease, mapCiliumConfigToHelmValues, validateCiliumHelmValues } from '../../../src/factories/cilium/resources/helm.js';
import type { CiliumBootstrapConfig } from '../../../src/factories/cilium/types.js';
import { getIntegrationTestKubeConfig, isClusterAvailable, createKubernetesObjectApiClient, createCustomObjectsApiClient, createCoreV1ApiClient } from '../shared-kubeconfig.js';
import { isCiliumInstalled } from './setup-cilium.js';

const NAMESPACE = 'typekro-test-integration'; // Use unique namespace for this test file
const clusterAvailable = isClusterAvailable();

// Check if both cluster and Cilium are available
let ciliumAvailable = false;
if (clusterAvailable) {
  try {
    ciliumAvailable = await isCiliumInstalled();
  } catch (error) {
    console.warn('Could not check Cilium availability:', error);
    ciliumAvailable = false;
  }
}

if (!clusterAvailable) {
  console.log('⏭️  Skipping Cilium Integration Tests: No cluster available');
} else if (!ciliumAvailable) {
  console.log('⏭️  Skipping Cilium Integration Tests: Cilium not installed in cluster');
}

const describeOrSkip = (clusterAvailable && ciliumAvailable) ? describe : describe.skip;

describeOrSkip('Cilium Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let _k8sApi: k8s.KubernetesObjectApi;
  let customObjectsApi: k8s.CustomObjectsApi;
  let coreApi: k8s.CoreV1Api;
  let testNamespace: string;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('🚀 SETUP: Connecting to existing cluster for Cilium tests...');

    // Use shared kubeconfig helper for consistent TLS configuration
    kubeConfig = getIntegrationTestKubeConfig();
    _k8sApi = createKubernetesObjectApiClient(kubeConfig);
    customObjectsApi = createCustomObjectsApiClient(kubeConfig);
    coreApi = createCoreV1ApiClient(kubeConfig);
    testNamespace = NAMESPACE; // Use the standard test namespace

    // Create test namespace if it doesn't exist
    try {
      await coreApi.createNamespace({ body: { metadata: { name: testNamespace } } });
      console.log(`📦 Created test namespace: ${testNamespace}`);
    } catch (error: any) {
      if (error.body?.reason === 'AlreadyExists' || error.statusCode === 409) {
        console.log(`📦 Test namespace ${testNamespace} already exists`);
      } else {
        throw error;
      }
    }

    console.log('✅ Cilium integration test environment ready!');
  });

  afterAll(async () => {
    if (!clusterAvailable || !coreApi) return;

    // Clean up test namespace
    try {
      await coreApi.deleteNamespace({ name: testNamespace });
      console.log(`🗑️ Deleted test namespace: ${testNamespace}`);
    } catch (error: any) {
      // Ignore errors during cleanup
      console.log(`⚠️ Could not delete test namespace: ${error.message}`);
    }
  });

  afterEach(async () => {
    if (!clusterAvailable) return;
    
    // Clean up test resources to prevent conflicts between tests
    try {
      console.log('🧹 Cleaning up test resources...');
      
      // Delete all HelmReleases in kube-system namespace that start with 'cilium-test-direct'
      await customObjectsApi.listNamespacedCustomObject({
        group: 'helm.toolkit.fluxcd.io',
        version: 'v2beta1',
        namespace: 'kube-system',
        plural: 'helmreleases'
      }).then(async (response: any) => {
        const items = response.items || [];
        for (const item of items) {
          if (item.metadata.name.startsWith('cilium-test-direct')) {
            await customObjectsApi.deleteNamespacedCustomObject({
              group: 'helm.toolkit.fluxcd.io',
              version: 'v2beta1',
              namespace: 'kube-system',
              plural: 'helmreleases',
              name: item.metadata.name
            });
          }
        }
      }).catch(() => {
        // Ignore errors - resources might not exist
      });

      // Delete all HelmRepositories in test namespace that start with 'cilium-test-direct'
      await customObjectsApi.listNamespacedCustomObject({
        group: 'source.toolkit.fluxcd.io',
        version: 'v1beta2',
        namespace: testNamespace,
        plural: 'helmrepositories'
      }).then(async (response: any) => {
        const items = response.items || [];
        for (const item of items) {
          if (item.metadata.name.startsWith('cilium-test-direct')) {
            await customObjectsApi.deleteNamespacedCustomObject({
              group: 'source.toolkit.fluxcd.io',
              version: 'v1beta2',
              namespace: testNamespace,
              plural: 'helmrepositories',
              name: item.metadata.name
            });
          }
        }
      }).catch(() => {
        // Ignore errors - resources might not exist
      });

      // Wait a moment for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log('✅ Test resource cleanup completed');
    } catch (error) {
      console.warn('⚠️ Test cleanup failed (non-critical):', error);
    }
  });

  describe('Helm Repository Integration', () => {
    it('should deploy HelmRepository using direct factory with .deploy()', async () => {
      console.log('🚀 Testing Cilium HelmRepository with direct factory...');

      // Create a composition for HelmRepository
      const CiliumRepoSpec = type({
        name: 'string',
        interval: 'string',
      });

      const CiliumRepoStatus = type({
        ready: 'boolean',
        url: 'string',
      });

      const ciliumRepoComposition = kubernetesComposition(
        {
          name: 'cilium-repo',
          apiVersion: 'platform.example.com/v1alpha1',
          kind: 'CiliumRepo',
          spec: CiliumRepoSpec,
          status: CiliumRepoStatus,
        },
        (spec) => {
          const _repo = ciliumHelmRepository({
            name: spec.name,
            namespace: testNamespace,
            interval: spec.interval || '5m',
            id: 'ciliumRepo',
          });

          // Simple JavaScript expressions - automatically converted to CEL
          return {
            ready: true, // Static value - will be hydrated by readiness evaluator
            url: 'https://helm.cilium.io/', // Use static value to avoid status expectation conflicts
          };
        }
      );

      // Test with direct factory
      const directFactory = ciliumRepoComposition.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const uniqueName = `cilium-test-direct-${Date.now()}`;
      const deploymentResult = await directFactory.deploy({
        name: uniqueName, // Use unique name to avoid conflicts
        interval: '1m',
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe(uniqueName);
      expect(deploymentResult.spec.name).toBe(uniqueName);

      console.log('✅ Direct factory deployment successful');
    });
  });

  describe('Helm Release Integration', () => {
    it('should deploy HelmRelease using direct factory with .deploy()', async () => {
      console.log('🚀 Testing Cilium HelmRelease with direct factory...');

      // Create a composition for HelmRelease
      const CiliumReleaseSpec = type({
        name: 'string',
        version: 'string',
        clusterName: 'string',
        clusterId: 'number',
      });

      const CiliumReleaseStatus = type({
        ready: 'boolean',
        phase: 'string',
      });

      const ciliumReleaseComposition = kubernetesComposition(
        {
          name: 'cilium-release',
          apiVersion: 'platform.example.com/v1alpha1',
          kind: 'CiliumRelease',
          spec: CiliumReleaseSpec,
          status: CiliumReleaseStatus,
        },
        (spec) => {
          const config: CiliumBootstrapConfig = {
            name: spec.name || 'cilium',
            cluster: {
              name: spec.clusterName || 'test',
              id: Math.min(Math.max(spec.clusterId || 1, 0), 255), // Ensure valid range 0-255
            },
            networking: {
              kubeProxyReplacement: 'strict',
            },
          };

          const helmValues = mapCiliumConfigToHelmValues(config);
          const validation = validateCiliumHelmValues(helmValues);
          
          if (!validation.valid) {
            throw new Error(`Invalid Helm values: ${validation.errors.join(', ')}`);
          }

          // WORKAROUND: Since the entire composition runs in status builder context,
          // spec values are KubernetesRef objects. For resource names, we need actual strings.
          // Use a fixed name for the repository to avoid the KubernetesRef issue.
          const ciliumName = 'cilium-test';
          const repoName = 'cilium-test-repo';
          

          
          const _ciliumRepo = ciliumHelmRepository({
            name: repoName,
            namespace: testNamespace,
            id: 'ciliumRepo',
          });

          const _ciliumRelease = ciliumHelmRelease({
            name: ciliumName,
            namespace: 'kube-system',
            version: spec.version || '1.18.1',
            repositoryName: repoName, // Must match the repository name above
            repositoryNamespace: testNamespace, // Must match the repository namespace above
            values: helmValues,
            id: 'ciliumRelease',
          });

          // Simple JavaScript expressions - automatically converted to CEL
          return {
            ready: true, // Static value - will be hydrated by readiness evaluator
            phase: 'Installing', // Static value - will be hydrated by readiness evaluator
          };
        }
      );

      // Test with direct factory
      const directFactory = ciliumReleaseComposition.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const uniqueName = `cilium-test-direct-${Date.now()}`;
      const deploymentResult = await directFactory.deploy({
        name: uniqueName,
        version: '1.18.1',
        clusterName: 'test-cluster',
        clusterId: 1,
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe(uniqueName);
      expect(deploymentResult.spec.name).toBe(uniqueName);

      console.log('✅ Direct factory HelmRelease deployment successful');
    });
  });

  describe('Configuration Validation Integration', () => {
    it('should validate comprehensive Cilium configuration', () => {
      console.log('🧪 Testing comprehensive Cilium configuration validation...');

      const comprehensiveConfig: CiliumBootstrapConfig = {
        name: 'cilium',
        cluster: {
          name: 'production-cluster',
          id: 42,
        },
        networking: {
          kubeProxyReplacement: 'strict',
          routingMode: 'native',
          tunnelProtocol: 'vxlan',
        },
        security: {
          encryption: {
            enabled: true,
            type: 'wireguard',
          },
          policyEnforcement: 'always',
        },
        observability: {
          hubble: {
            enabled: true,
          },
        },
      };

      const helmValues = mapCiliumConfigToHelmValues(comprehensiveConfig);
      const validation = validateCiliumHelmValues(helmValues);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);

      // Validate that key configuration sections are properly mapped
      expect(helmValues.cluster).toEqual({
        name: 'production-cluster',
        id: 42,
      });
      expect(helmValues.kubeProxyReplacement).toBe(true); // 'strict' maps to true
      expect(helmValues.routingMode).toBe('native');
      expect(helmValues.encryption?.enabled).toBe(true);
      expect(helmValues.encryption?.type).toBe('wireguard');
      expect(helmValues.policyEnforcement).toBe('always');
      expect(helmValues.hubble?.enabled).toBe(true);

      console.log('✅ Configuration validation successful');
    });
  });
});

// TODO: Add more comprehensive integration tests:
// - Test complete Cilium bootstrap composition
// - Test CRD factories when implemented
// - Test network policy enforcement with real traffic
// - Test BGP integration scenarios
// - Test load balancer and Gateway API functionality