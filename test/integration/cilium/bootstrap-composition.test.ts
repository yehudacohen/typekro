/**
 * Integration Tests for Cilium Bootstrap Composition
 *
 * This test suite validates the complete Cilium bootstrap composition
 * with real Kubernetes deployments using both kro and direct factory patterns.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { ciliumHelmRepository, ciliumHelmRelease, mapCiliumConfigToHelmValues } from '../../../src/factories/cilium/resources/helm.js';
import { Cel } from '../../../src/core/references/cel.js';
// import type { CiliumBootstrapConfig } from '../../../src/factories/cilium/types.js';
import { getIntegrationTestKubeConfig, isClusterAvailable } from '../shared-kubeconfig.js';

const _CLUSTER_NAME = 'typekro-e2e-test'; // Use same cluster as setup script
const NAMESPACE = 'typekro-test'; // Use same namespace as setup script
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

// Test schemas for bootstrap composition
const CiliumStackSpec = type({
  name: 'string',
  clusterName: 'string',
  clusterId: 'number',
  version: 'string',
  enableEncryption: 'boolean',
  enableHubble: 'boolean',
});

const CiliumStackStatus = type({
  phase: 'string',
  ready: 'boolean',
  agentReady: 'boolean',
  operatorReady: 'boolean',
  hubbleReady: 'boolean',
  version: 'string',
  encryptionEnabled: 'boolean',
  endpoints: {
    health: 'string',
    metrics: 'string',
  },
  cni: {
    configPath: 'string',
    socketPath: 'string',
  },
});

describeOrSkip('Cilium Bootstrap Composition Integration', () => {
  let kubeConfig: k8s.KubeConfig;
  let _k8sApi: k8s.KubernetesObjectApi;
  let testNamespace: string;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('🚀 SETUP: Connecting to existing cluster for Cilium bootstrap tests...');

    // Use shared kubeconfig helper for consistent TLS configuration
    kubeConfig = getIntegrationTestKubeConfig();
    _k8sApi = kubeConfig.makeApiClient(k8s.KubernetesObjectApi);
    testNamespace = NAMESPACE; // Use the standard test namespace

    console.log('✅ Cilium bootstrap integration test environment ready!');
  });

  describe('Bootstrap Composition Creation', () => {
    it('should create a valid bootstrap composition', () => {
      console.log('🧪 Testing Cilium bootstrap composition creation...');

      const ciliumStack = kubernetesComposition(
        {
          name: 'cilium-stack',
          apiVersion: 'v1alpha1', // Let Kro add the kro.run group automatically
          kind: 'CiliumStack',
          spec: CiliumStackSpec,
          status: CiliumStackStatus,
        },
        (spec) => {
          // Create Cilium Helm repository
          const _helmRepo = ciliumHelmRepository({
            name: 'cilium',
            namespace: 'flux-system',
            id: 'ciliumRepo',
          });

          // Create Cilium Helm release that references the repository
          const _helmRelease = ciliumHelmRelease({
            name: 'cilium',
            namespace: 'kube-system',
            version: '1.18.1', // Use static version to avoid schema reference issues
            repositoryName: 'cilium', // Must match the repository name above
            repositoryNamespace: 'flux-system', // Must match the repository namespace above
            values: mapCiliumConfigToHelmValues({
              name: 'cilium',
              cluster: {
                name: 'test-cluster',
                id: 1,
              },
              security: {
                encryption: {
                  enabled: true,
                  type: 'wireguard',
                },
              },
              observability: {
                hubble: {
                  enabled: false,
                  relay: { enabled: false },
                  ui: { enabled: false },
                },
              },
            }),
            id: 'helmRelease', // Must match variable name for kubernetesComposition
          });

          // Return status with simple expressions that work with Kro CEL
          return {
            phase: Cel.expr('has(helmRelease.status) ? "Ready" : "Installing"'),
            ready: Cel.expr('has(helmRelease.status)'),
            agentReady: Cel.expr('has(helmRelease.status)'),
            operatorReady: Cel.expr('has(helmRelease.status)'),
            hubbleReady: Cel.expr('has(helmRelease.status)'),
            version: '1.18.1', // Use static version to avoid schema reference issues
            encryptionEnabled: true, // Use static value to avoid schema reference issues
            endpoints: {
              health: 'http://cilium-agent:9879/healthz',
              metrics: 'http://cilium-agent:9962/metrics',
            },
            cni: {
              configPath: '/etc/cni/net.d/05-cilium.conflist',
              socketPath: '/var/run/cilium/cilium.sock',
            },
          };
        }
      );

      expect(ciliumStack).toBeDefined();
      expect(ciliumStack.name).toBe('cilium-stack');

      console.log('✅ Bootstrap composition creation successful');
    });

    it('should deploy bootstrap composition using direct factory with .deploy()', async () => {
      console.log('🚀 Testing Cilium bootstrap composition with direct factory...');

      const ciliumStack = kubernetesComposition(
        {
          name: 'cilium-bootstrap-direct',
          apiVersion: 'v1alpha1', // Let Kro add the kro.run group automatically
          kind: 'CiliumBootstrapDirect',
          spec: CiliumStackSpec,
          status: CiliumStackStatus,
        },
        (spec) => {
          const _helmRepo = ciliumHelmRepository({
            name: 'cilium-direct',
            namespace: testNamespace,
            id: 'ciliumRepo',
          });

          const _helmRelease = ciliumHelmRelease({
            name: 'cilium-direct',
            namespace: 'kube-system',
            version: '1.18.1', // Use static version to avoid schema reference issues
            repositoryName: 'cilium-direct', // Must match the repository name above
            repositoryNamespace: testNamespace, // Must match the repository namespace above
            values: mapCiliumConfigToHelmValues({
              name: 'cilium-direct',
              cluster: {
                name: 'test-cluster-direct',
                id: 1,
              },
              security: {
                encryption: {
                  enabled: true,
                  type: 'wireguard',
                },
              },
            }),
            id: 'helmRelease', // Must match variable name for kubernetesComposition
          });

          return {
            phase: Cel.expr('has(helmRelease.status) ? "Ready" : "Installing"'),
            ready: Cel.expr('has(helmRelease.status)'),
            agentReady: Cel.expr('has(helmRelease.status)'),
            operatorReady: Cel.expr('has(helmRelease.status)'),
            hubbleReady: Cel.expr('has(helmRelease.status)'),
            version: '1.18.1', // Use static version to avoid schema reference issues
            encryptionEnabled: true, // Use static value to avoid schema reference issues
            endpoints: {
              health: 'http://cilium-agent:9879/healthz',
              metrics: 'http://cilium-agent:9962/metrics',
            },
            cni: {
              configPath: '/etc/cni/net.d/05-cilium.conflist',
              socketPath: '/var/run/cilium/cilium.sock',
            },
          };
        }
      );

      // Test with direct factory
      const directFactory = await ciliumStack.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const deploymentResult = await directFactory.deploy({
        name: 'test-cilium-direct',
        clusterName: 'test-cluster-direct',
        clusterId: 1,
        version: '1.18.1',
        enableEncryption: true,
        enableHubble: false,
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe('test-cilium-direct');
      expect(deploymentResult.spec.name).toBe('test-cilium-direct');
      expect(deploymentResult.spec.clusterName).toBe('test-cluster-direct');
      expect(deploymentResult.spec.enableEncryption).toBe(true);

      console.log('✅ Direct factory bootstrap composition deployment successful');
    });

    it('should deploy bootstrap composition using kro factory with .deploy()', async () => {
      console.log('🚀 Testing Cilium bootstrap composition with kro factory...');

      const ciliumStack = kubernetesComposition(
        {
          name: 'cilium-bootstrap-kro',
          apiVersion: 'v1alpha1', // Let Kro add the kro.run group automatically
          kind: 'CiliumBootstrapKro',
          spec: CiliumStackSpec,
          status: CiliumStackStatus,
        },
        (spec) => {
          const _helmRepo = ciliumHelmRepository({
            name: 'cilium-kro',
            namespace: testNamespace,
            id: 'ciliumRepo',
          });

          const _helmRelease = ciliumHelmRelease({
            name: 'cilium-kro',
            namespace: 'kube-system',
            version: '1.18.1', // Use static version to avoid schema reference issues
            repositoryName: 'cilium-kro', // Must match the repository name above
            repositoryNamespace: testNamespace, // Must match the repository namespace above
            values: mapCiliumConfigToHelmValues({
              name: 'cilium-kro',
              cluster: {
                name: 'test-cluster-kro',
                id: 2,
              },
              networking: {
                kubeProxyReplacement: 'strict', // This maps to true in Helm values
              },
            }),
            id: 'helmRelease', // Must match variable name for kubernetesComposition
          });

          return {
            phase: Cel.expr('has(helmRelease.status) ? "Ready" : "Installing"'),
            ready: Cel.expr('has(helmRelease.status)'),
            agentReady: Cel.expr('has(helmRelease.status)'),
            operatorReady: Cel.expr('has(helmRelease.status)'),
            hubbleReady: Cel.expr('has(helmRelease.status)'),
            version: '1.18.1', // Use static version to avoid schema reference issues
            encryptionEnabled: false, // Use static value to avoid schema reference issues
            endpoints: {
              health: 'http://cilium-agent:9879/healthz',
              metrics: 'http://cilium-agent:9962/metrics',
            },
            cni: {
              configPath: '/etc/cni/net.d/05-cilium.conflist',
              socketPath: '/var/run/cilium/cilium.sock',
            },
          };
        }
      );

      // Test with kro factory
      const kroFactory = await ciliumStack.factory('kro', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const deploymentResult = await kroFactory.deploy({
        name: 'test-cilium-kro',
        clusterName: 'test-cluster-kro',
        clusterId: 2,
        version: '1.18.1',
        enableEncryption: false,
        enableHubble: true,
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe('test-cilium-kro');
      expect(deploymentResult.spec.name).toBe('test-cilium-kro');
      expect(deploymentResult.spec.clusterName).toBe('test-cluster-kro');
      expect(deploymentResult.spec.enableHubble).toBe(true);

      console.log('✅ Kro factory bootstrap composition deployment successful');
    });
  });

  describe('Configuration Integration', () => {
    it('should handle various configuration scenarios', () => {
      console.log('🧪 Testing various Cilium configuration scenarios...');

      const scenarios = [
        {
          name: 'minimal-config',
          config: {
            name: 'cilium-minimal',
            cluster: { name: 'minimal', id: 1 },
          },
        },
        {
          name: 'encryption-enabled',
          config: {
            name: 'cilium-encrypted',
            cluster: { name: 'encrypted', id: 2 },
            security: {
              encryption: { enabled: true, type: 'wireguard' as const },
            },
          },
        },
        {
          name: 'hubble-enabled',
          config: {
            name: 'cilium-hubble',
            cluster: { name: 'hubble', id: 3 },
            observability: {
              hubble: { enabled: true },
            },
          },
        },
      ];

      scenarios.forEach(({ name, config }) => {
        const helmValues = mapCiliumConfigToHelmValues(config);
        expect(helmValues.cluster).toEqual(config.cluster);

        if (config.security?.encryption) {
          expect(helmValues.encryption?.enabled).toBe(true);
          expect(helmValues.encryption?.type).toBe('wireguard');
        }

        if (config.observability?.hubble) {
          expect(helmValues.hubble?.enabled).toBe(true);
        }
      });

      console.log('✅ Configuration scenarios validation successful');
    });
  });
});