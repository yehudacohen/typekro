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

import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(900_000);
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import {
  ciliumHelmRelease,
  ciliumHelmRepository,
  mapCiliumConfigToHelmValues,
  validateCiliumHelmValues,
} from '../../../src/factories/cilium/resources/helm.js';
import type { CiliumBootstrapConfig } from '../../../src/factories/cilium/types.js';
import { kubernetesComposition } from '../../../src/index.js';
import {
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  TestFactoryCleanupRegistry,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';
import { ensureCiliumInstalled, isCiliumInstalled } from './setup-cilium.js';

const NAMESPACE = `typekro-test-integration-${crypto.randomUUID().slice(0, 8)}`;
const clusterAvailable = await isClusterAvailable();

// Ensure Cilium is bootstrapped, then verify it's available
let ciliumAvailable = false;
if (clusterAvailable) {
  try {
    await ensureCiliumInstalled();
    ciliumAvailable = await isCiliumInstalled();
  } catch (error) {
    console.warn('Could not bootstrap/check Cilium availability:', error);
    ciliumAvailable = false;
  }
}

if (!clusterAvailable) {
  console.log('⏭️  Skipping Cilium Integration Tests: No cluster available');
} else if (!ciliumAvailable) {
  console.log('⏭️  Skipping Cilium Integration Tests: Cilium bootstrap failed');
}

const describeOrSkip = clusterAvailable && ciliumAvailable ? describe : describe.skip;

describeOrSkip('Cilium Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let _k8sApi: k8s.KubernetesObjectApi;
  let testNamespace: string;
  let namespaceLease: TestNamespaceLease;
  const cleanupRegistry = new TestFactoryCleanupRegistry();

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('🚀 SETUP: Connecting to existing cluster for Cilium tests...');

    // Use shared kubeconfig helper for consistent TLS configuration
    kubeConfig = getIntegrationTestKubeConfig();
    _k8sApi = createKubernetesObjectApiClient(kubeConfig);
    testNamespace = NAMESPACE; // Use the standard test namespace
    namespaceLease = await createTestNamespace(testNamespace, kubeConfig);

    console.log('✅ Cilium integration test environment ready!');
  });

  afterAll(async () => {
    if (!clusterAvailable || !kubeConfig) return;
    await deleteTestNamespaceAndWait(namespaceLease, kubeConfig);
  });

  afterEach(async () => {
    if (!clusterAvailable) return;
    await cleanupRegistry.cleanup(kubeConfig, 60_000);
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

      // Test with direct factory — DO NOT waitForReady because HelmRepositories
      // created outside flux-system namespace won't be reconciled by Flux source-controller
      // (Flux only watches its own namespace by default). This test validates composition
      // creation, serialization, and K8s resource creation, not Flux reconciliation.
      const directFactory = ciliumRepoComposition.factory('direct', {
        namespace: testNamespace,
        waitForReady: false,
        timeout: 30000, // 30 seconds - just creating the K8s resource, no readiness wait
        kubeConfig: kubeConfig,
      });

      const uniqueName = `cilium-test-direct-${Date.now()}`;
      cleanupRegistry.track(directFactory, uniqueName);
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
        clusterId: '0 <= number.integer <= 255',
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
              // The schema validates the concrete instance value. Keep the symbolic
              // reference intact so both direct materialization and KRO lowering see it.
              id: spec.clusterId,
            },
            networking: {
              kubeProxyReplacement: 'strict',
            },
          };

          const helmValues = mapCiliumConfigToHelmValues(config);
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

      // Test with direct factory — DO NOT waitForReady because this deploys a second
      // Cilium HelmRelease into kube-system which conflicts with the existing installation.
      // The test validates composition creation, serialization, and deployment mechanics,
      // not actual Cilium pod readiness (which can't succeed with duplicate releases).
      const directFactory = ciliumReleaseComposition.factory('direct', {
        namespace: testNamespace,
        waitForReady: false,
        kubeConfig: kubeConfig,
      });

      const uniqueName = `cilium-test-direct-${Date.now()}`;
      cleanupRegistry.track(directFactory, uniqueName);
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
    }, 600000); // 10 minutes - HelmRelease chart pull + pod readiness under contention
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
