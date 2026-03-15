/**
 * Cross-Resource Integration Tests for Cilium Networking
 *
 * This test suite validates cross-resource references, dependency resolution,
 * and integration with TypeKro features for Cilium networking resources.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import {
  ciliumClusterwideNetworkPolicy,
  ciliumNetworkPolicy,
} from '../../../src/factories/cilium/resources/networking.js';
import {
  createCoreV1ApiClient,
  createKubernetesObjectApiClient,
  deleteNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';
import { ensureCiliumInstalled, isCiliumInstalled } from './setup-cilium.js';

const NAMESPACE = 'typekro-test-cross-resource';
const clusterAvailable = isClusterAvailable();

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
  console.log('⏭️  Skipping Cilium Cross-Resource Integration Tests: No cluster available');
} else if (!ciliumAvailable) {
  console.log('⏭️  Skipping Cilium Cross-Resource Integration Tests: Cilium bootstrap failed');
}

const describeOrSkip = clusterAvailable && ciliumAvailable ? describe : describe.skip;

describeOrSkip('Cilium Cross-Resource Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let _k8sApi: k8s.KubernetesObjectApi;
  let coreApi: k8s.CoreV1Api;
  let testNamespace: string;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log(
      '🚀 SETUP: Connecting to existing cluster for Cilium cross-resource integration tests...'
    );

    kubeConfig = getIntegrationTestKubeConfig();
    _k8sApi = createKubernetesObjectApiClient(kubeConfig);
    coreApi = createCoreV1ApiClient(kubeConfig);
    testNamespace = NAMESPACE;

    // Create test namespace, waiting for any prior terminating namespace to clear
    const maxWait = 60000;
    const startWait = Date.now();
    while (Date.now() - startWait < maxWait) {
      try {
        await coreApi.createNamespace({ body: { metadata: { name: testNamespace } } });
        console.log(`📦 Created test namespace: ${testNamespace}`);
        break;
      } catch (error: any) {
        const msg = error.body?.message || error.message || '';
        if (msg.includes('being deleted')) {
          console.log(`⏳ Waiting for terminating namespace ${testNamespace} to clear...`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        if (error.body?.reason === 'AlreadyExists' || error.statusCode === 409) {
          console.log(`📦 Test namespace ${testNamespace} already exists`);
          break;
        }
        throw error;
      }
    }

    console.log('✅ Cilium cross-resource integration test environment ready!');
  });

  afterAll(async () => {
    if (!clusterAvailable || !coreApi) return;

    const k8sApi = createKubernetesObjectApiClient(kubeConfig);

    // 1. Delete RGDs FIRST — Kro controller will cascade-delete instances and their child resources
    const rgdNames = ['multi-policy-app'];
    for (const name of rgdNames) {
      try {
        await k8sApi.delete({
          apiVersion: 'kro.run/v1alpha1',
          kind: 'ResourceGraphDefinition',
          metadata: { name },
        });
        console.log(`🗑️ Deleted RGD: ${name}`);
      } catch (error: any) {
        if (error.statusCode !== 404 && error.body?.code !== 404) {
          console.log(`⚠️ Could not delete RGD ${name}: ${error.message}`);
        }
      }
    }

    // 2. Wait for Kro to cascade-delete instances and child resources
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // 3. Clean up any orphaned cluster-scoped CiliumClusterwideNetworkPolicies
    const clusterPolicyNames = [
      'test-cluster-policy',
      'complex-app-cluster-security',
      'test-multi-policy-cluster-policy',
    ];
    for (const name of clusterPolicyNames) {
      try {
        await k8sApi.delete({
          apiVersion: 'cilium.io/v2',
          kind: 'CiliumClusterwideNetworkPolicy',
          metadata: { name },
        });
        console.log(`🗑️ Deleted CiliumClusterwideNetworkPolicy: ${name}`);
      } catch (error: any) {
        if (error.statusCode !== 404 && error.body?.code !== 404) {
          console.log(
            `⚠️ Could not delete CiliumClusterwideNetworkPolicy ${name}: ${error.message}`
          );
        }
      }
    }

    // 4. Clean up test namespace and wait for completion (deletes all namespaced resources)
    try {
      await deleteNamespaceAndWait(testNamespace, kubeConfig);
    } catch (error: any) {
      console.log(`⚠️ Could not delete test namespace: ${error.message}`);
    }
  });

  describe('Cross-Resource References and Dependency Resolution', () => {
    it('should handle cross-resource references between Kubernetes and Cilium resources', async () => {
      console.log(
        '🚀 Testing cross-resource references between Kubernetes and Cilium resources...'
      );

      const NetworkPolicyWithReferencesSpec = type({
        appName: 'string',
        targetPort: 'number',
      });

      const NetworkPolicyWithReferencesStatus = type({
        ready: 'boolean',
        policyName: 'string',
        targetApp: 'string',
        targetPort: 'number',
      });

      const networkPolicyComposition = kubernetesComposition(
        {
          name: 'network-policy-with-refs',
          apiVersion: 'v1alpha1',
          kind: 'NetworkPolicyWithReferences',
          spec: NetworkPolicyWithReferencesSpec,
          status: NetworkPolicyWithReferencesStatus,
        },
        (spec) => {
          // Create Cilium network policy with cross-references
          const _networkPolicy = ciliumNetworkPolicy({
            apiVersion: 'cilium.io/v2',
            kind: 'CiliumNetworkPolicy',
            metadata: {
              name: `${spec.appName}-cross-ref-policy`,
              namespace: testNamespace,
            },
            spec: {
              endpointSelector: {
                matchLabels: { app: spec.appName },
              },
              ingress: [
                {
                  fromEndpoints: [
                    {
                      matchLabels: { role: 'frontend' },
                    },
                  ],
                  toPorts: [
                    {
                      ports: [{ port: '8080', protocol: 'TCP' }],
                    },
                  ],
                },
              ],
            },
            id: 'networkPolicy',
          });

          return {
            ready: true, // Static value for integration test
            policyName: `${spec.appName}-cross-ref-policy`,
            targetApp: spec.appName,
            targetPort: spec.targetPort,
          };
        }
      );

      const directFactory = networkPolicyComposition.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const deploymentResult = await directFactory.deploy({
        appName: 'test-cross-ref-app',
        targetPort: 8080,
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe('test-cross-ref-app');
      expect(deploymentResult.spec.appName).toBe('test-cross-ref-app');
      expect(deploymentResult.spec.targetPort).toBe(8080);

      // Verify cross-resource references in status
      expect(deploymentResult.status.policyName).toBe('test-cross-ref-app-cross-ref-policy');
      expect(deploymentResult.status.targetApp).toBe('test-cross-ref-app');
      expect(deploymentResult.status.targetPort).toBe(8080);

      console.log(
        '✅ Cross-resource references between Kubernetes and Cilium resources successful'
      );
    });

    it('should handle dependency resolution with multiple Cilium policies', async () => {
      console.log('🚀 Testing dependency resolution with multiple Cilium policies...');

      const MultiPolicyAppSpec = type({
        name: 'string',
        tier: 'string',
        enableGlobalPolicy: 'boolean',
      });

      const MultiPolicyAppStatus = type({
        ready: 'boolean',
        namespacePolicyName: 'string',
        clusterPolicyName: 'string',
        policiesApplied: 'number',
      });

      const multiPolicyComposition = kubernetesComposition(
        {
          name: 'multi-policy-app',
          apiVersion: 'v1alpha1',
          kind: 'MultiPolicyApp',
          spec: MultiPolicyAppSpec,
          status: MultiPolicyAppStatus,
        },
        (spec) => {
          // Create namespace-scoped policy
          const _namespacePolicy = ciliumNetworkPolicy({
            apiVersion: 'cilium.io/v2',
            kind: 'CiliumNetworkPolicy',
            metadata: {
              name: `${spec.name}-namespace-policy`,
              namespace: testNamespace,
            },
            spec: {
              endpointSelector: {
                matchLabels: {
                  app: spec.name,
                  tier: spec.tier,
                },
              },
              ingress: [
                {
                  fromEndpoints: [
                    {
                      matchLabels: { tier: spec.tier },
                    },
                  ],
                  toPorts: [
                    {
                      ports: [{ port: '8080', protocol: 'TCP' }],
                    },
                  ],
                },
              ],
            },
            id: 'namespacePolicy',
          });

          // Conditionally create cluster-wide policy
          const _clusterPolicy = spec.enableGlobalPolicy
            ? ciliumClusterwideNetworkPolicy({
                apiVersion: 'cilium.io/v2',
                kind: 'CiliumClusterwideNetworkPolicy',
                metadata: {
                  name: `${spec.name}-cluster-policy`,
                },
                spec: {
                  endpointSelector: {
                    matchLabels: { app: spec.name },
                  },
                  ingress: [
                    {
                      fromEntities: ['host'],
                      toPorts: [
                        {
                          ports: [{ port: '9090', protocol: 'TCP' }],
                        },
                      ],
                    },
                  ],
                },
                id: 'clusterPolicy',
              })
            : null;

          return {
            ready: true, // Static value for integration test
            namespacePolicyName: `${spec.name}-namespace-policy`,
            clusterPolicyName: spec.enableGlobalPolicy ? `${spec.name}-cluster-policy` : 'none',
            policiesApplied: spec.enableGlobalPolicy ? 2 : 1,
          };
        }
      );

      const kroFactory = multiPolicyComposition.factory('kro', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
        hydrateStatus: true,
      });

      const deploymentResult = await kroFactory.deploy({
        name: 'test-multi-policy',
        tier: 'backend',
        enableGlobalPolicy: true,
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe('test-multi-policy');
      expect(deploymentResult.spec.tier).toBe('backend');
      expect(deploymentResult.spec.enableGlobalPolicy).toBe(true);

      // Verify dependency resolution worked correctly
      expect(deploymentResult.status.namespacePolicyName).toBe(
        'test-multi-policy-namespace-policy'
      );
      expect(deploymentResult.status.clusterPolicyName).toBe('test-multi-policy-cluster-policy');
      expect(deploymentResult.status.policiesApplied).toBe(2);

      console.log('✅ Dependency resolution with multiple Cilium policies successful');
    });
  });

  describe('Serialization and YAML Generation', () => {
    it('should generate valid YAML for complex Cilium compositions', async () => {
      console.log('🚀 Testing YAML generation for complex Cilium compositions...');

      const ComplexNetworkingSpec = type({
        appName: 'string',
        environment: 'string',
        securityLevel: 'string',
      });

      const ComplexNetworkingStatus = type({
        ready: 'boolean',
        securityPoliciesCount: 'number',
        networkingConfigured: 'boolean',
      });

      const complexNetworkingComposition = kubernetesComposition(
        {
          name: 'complex-networking',
          apiVersion: 'v1alpha1',
          kind: 'ComplexNetworking',
          spec: ComplexNetworkingSpec,
          status: ComplexNetworkingStatus,
        },
        (spec) => {
          // Create multiple network policies with different configurations
          const _ingressPolicy = ciliumNetworkPolicy({
            apiVersion: 'cilium.io/v2',
            kind: 'CiliumNetworkPolicy',
            metadata: {
              name: `${spec.appName}-ingress-policy`,
              namespace: testNamespace,
            },
            spec: {
              endpointSelector: {
                matchLabels: {
                  app: spec.appName,
                  environment: spec.environment,
                },
              },
              ingress: [
                {
                  fromEndpoints: [
                    {
                      matchLabels: { role: 'frontend' },
                    },
                  ],
                  toPorts: [
                    {
                      ports: [{ port: '8080', protocol: 'TCP' }],
                      rules: {
                        http: [
                          {
                            method: 'GET',
                            path: '/api/.*',
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
            id: 'ingressPolicy',
          });

          const _egressPolicy = ciliumNetworkPolicy({
            apiVersion: 'cilium.io/v2',
            kind: 'CiliumNetworkPolicy',
            metadata: {
              name: `${spec.appName}-egress-policy`,
              namespace: testNamespace,
            },
            spec: {
              endpointSelector: {
                matchLabels: {
                  app: spec.appName,
                  environment: spec.environment,
                },
              },
              egress: [
                {
                  toEndpoints: [
                    {
                      matchLabels: { role: 'database' },
                    },
                  ],
                  toPorts: [
                    {
                      ports: [{ port: '5432', protocol: 'TCP' }],
                    },
                  ],
                },
                {
                  toFQDNs: [
                    {
                      matchPattern: '*.amazonaws.com',
                    },
                  ],
                  toPorts: [
                    {
                      ports: [{ port: '443', protocol: 'TCP' }],
                    },
                  ],
                },
              ],
            },
            id: 'egressPolicy',
          });

          // Conditional cluster-wide policy for high security environments
          const _clusterSecurityPolicy =
            spec.securityLevel === 'high'
              ? ciliumClusterwideNetworkPolicy({
                  apiVersion: 'cilium.io/v2',
                  kind: 'CiliumClusterwideNetworkPolicy',
                  metadata: {
                    name: `${spec.appName}-cluster-security`,
                  },
                  spec: {
                    endpointSelector: {
                      matchLabels: {
                        app: spec.appName,
                        'security-level': 'high',
                      },
                    },
                    ingress: [
                      {
                        fromEntities: ['host'],
                        toPorts: [
                          {
                            ports: [{ port: '22', protocol: 'TCP' }],
                          },
                        ],
                      },
                    ],
                    egress: [
                      {
                        toEntities: ['world'],
                        toPorts: [
                          {
                            ports: [{ port: '443', protocol: 'TCP' }],
                          },
                        ],
                      },
                    ],
                  },
                  id: 'clusterSecurityPolicy',
                })
              : null;

          return {
            ready: true, // Static value for integration test
            securityPoliciesCount: 2, // Always 2 for this test (ingress + egress policies)
            networkingConfigured: true,
          };
        }
      );

      // Test YAML generation
      const yamlOutput = complexNetworkingComposition.toYaml();
      expect(yamlOutput).toBeDefined();
      expect(typeof yamlOutput).toBe('string');
      expect(yamlOutput).toContain('apiVersion: kro.run/v1alpha1');
      expect(yamlOutput).toContain('kind: ResourceGraphDefinition');
      expect(yamlOutput).toContain('CiliumNetworkPolicy');

      // Test factory creation and deployment
      const directFactory = complexNetworkingComposition.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const deploymentResult = await directFactory.deploy({
        appName: 'complex-app',
        environment: 'production',
        securityLevel: 'high',
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.status.securityPoliciesCount).toBe(2);
      expect(deploymentResult.status.networkingConfigured).toBe(true);

      console.log('✅ YAML generation for complex Cilium compositions successful');
    }, 600000); // 10 minutes - CiliumNetworkPolicy deployment can be slow under contention
  });

  describe('TypeKro Feature Integration', () => {
    it('should validate TypeScript type safety and IDE experience', () => {
      console.log('🧪 Testing TypeScript type safety and IDE experience...');

      // Test that all factory functions are properly typed
      const networkPolicy = ciliumNetworkPolicy({
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {
          name: 'test-policy',
          namespace: 'default',
        },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'test' },
          },
          ingress: [
            {
              fromEndpoints: [
                {
                  matchLabels: { role: 'frontend' },
                },
              ],
              toPorts: [
                {
                  ports: [{ port: '8080', protocol: 'TCP' }],
                },
              ],
            },
          ],
        },
      });

      const clusterPolicy = ciliumClusterwideNetworkPolicy({
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumClusterwideNetworkPolicy',
        metadata: {
          name: 'test-cluster-policy',
        },
        spec: {
          endpointSelector: {
            matchLabels: { tier: 'system' },
          },
          ingress: [
            {
              fromEntities: ['host'],
              toPorts: [
                {
                  ports: [{ port: '9090', protocol: 'TCP' }],
                },
              ],
            },
          ],
        },
      });

      // Verify type safety - these should all be properly typed
      expect(networkPolicy.metadata?.name).toBe('test-policy');
      expect(networkPolicy.metadata?.namespace).toBe('default');
      expect(networkPolicy.spec?.endpointSelector?.matchLabels?.app).toBe('test');

      expect(clusterPolicy.metadata?.name).toBe('test-cluster-policy');
      expect(clusterPolicy.spec?.endpointSelector?.matchLabels?.tier).toBe('system');

      // Verify readiness evaluators are attached
      expect(networkPolicy.readinessEvaluator).toBeDefined();
      expect(clusterPolicy.readinessEvaluator).toBeDefined();

      console.log('✅ TypeScript type safety and IDE experience validation successful');
    });
  });
});
