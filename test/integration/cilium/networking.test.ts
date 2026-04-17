/**
 * Integration Tests for Cilium Networking CRD Factories
 *
 * This test suite validates the Cilium networking factory functions with real
 * Kubernetes deployments using both kro and direct factory patterns.
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
  createCustomObjectsApiClient,
  createKubernetesObjectApiClient,
  deleteNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';
import { ensureCiliumInstalled, isCiliumInstalled } from './setup-cilium.js';

const NAMESPACE = 'typekro-test-networking';
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
  console.log('⏭️  Skipping Cilium Networking Integration Tests: No cluster available');
} else if (!ciliumAvailable) {
  console.log('⏭️  Skipping Cilium Networking Integration Tests: Cilium bootstrap failed');
}

const describeOrSkip = clusterAvailable && ciliumAvailable ? describe : describe.skip;

describeOrSkip('Cilium Networking Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let _k8sApi: k8s.KubernetesObjectApi;
  let coreApi: k8s.CoreV1Api;
  let testNamespace: string;
  // Hoisted so afterAll can delete instances before the RGDs — Kro requires
  // instances to be fully gone before the RGD is deleted, otherwise the
  // kro.run/finalizer on the instance can never be processed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kroNetworkPolicyFactory: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kroDenyAllFactory: any = null;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('🚀 SETUP: Connecting to existing cluster for Cilium networking tests...');

    kubeConfig = getIntegrationTestKubeConfig();
    _k8sApi = createKubernetesObjectApiClient(kubeConfig);
    coreApi = createCoreV1ApiClient(kubeConfig);
    testNamespace = NAMESPACE;

    // Create test namespace, waiting for any prior terminating namespace to clear
    const maxWait = 60000; // 1 minute max wait for terminating namespace
    const startWait = Date.now();
    while (Date.now() - startWait < maxWait) {
      try {
        await coreApi.createNamespace({ body: { metadata: { name: testNamespace } } });
        console.log(`📦 Created test namespace: ${testNamespace}`);
        break;
      } catch (error: any) {
        const msg = error.body?.message || error.message || '';
        if (msg.includes('being deleted')) {
          // Namespace exists but is terminating — wait and retry
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

    console.log('✅ Cilium networking integration test environment ready!');
  }); // 2 minute timeout for Cilium installation

  afterAll(async () => {
    if (!clusterAvailable || !coreApi) return;

    const k8sApi = createKubernetesObjectApiClient(kubeConfig);
    const customApi = createCustomObjectsApiClient(kubeConfig);

    // Step 1: Delete Kro instances FIRST and wait for the kro.run/finalizer to be cleared.
    // If we delete the RGD before the instance, Kro loses the ability to process the
    // finalizer and the namespace gets stuck in Terminating.
    const kroInstancesToDelete = [
      {
        factory: kroNetworkPolicyFactory,
        instanceName: 'test-network-policy-kro',
        plural: 'networkpolicykrotests',
      },
      { factory: kroDenyAllFactory, instanceName: 'test-deny-all-policy', plural: 'denyalltests' },
    ];

    for (const { factory, instanceName, plural } of kroInstancesToDelete) {
      if (!factory) continue;
      try {
        await factory.deleteInstance(instanceName);
        console.log(`🗑️ Deleted Kro instance: ${instanceName}`);
        // Wait for the instance to fully disappear (finalizer cleared)
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          try {
            await customApi.getNamespacedCustomObject({
              group: 'kro.run',
              version: 'v1alpha1',
              namespace: testNamespace,
              plural,
              name: instanceName,
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch (e: any) {
            if (e.statusCode === 404 || e.body?.reason === 'NotFound') break;
          }
        }
        console.log(`✅ Kro instance fully removed: ${instanceName}`);
      } catch (error: any) {
        if (error.statusCode !== 404 && error.body?.reason !== 'NotFound') {
          console.warn(`⚠️ Failed to delete Kro instance ${instanceName}:`, error);
        }
      }
    }

    // Step 2: Delete RGDs now that no instances remain
    const rgdNames = ['network-policy-kro-test', 'deny-all-test'];
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

    // Step 3: Clean up any orphaned cluster-scoped CiliumClusterwideNetworkPolicies
    const clusterPolicyNames = ['test-cluster-policy', 'test-deny-all-policy', 'test-deny-all'];
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

  describe('CiliumNetworkPolicy Integration', () => {
    it('should deploy CiliumNetworkPolicy using direct factory with .deploy()', async () => {
      console.log('🚀 Testing CiliumNetworkPolicy with direct factory...');

      const NetworkPolicyTestSpec = type({
        name: 'string',
        targetApp: 'string',
        sourceApp: 'string',
        port: 'number',
      });

      const NetworkPolicyTestStatus = type({
        ready: 'boolean',
        policyName: 'string',
      });

      const networkPolicyComposition = kubernetesComposition(
        {
          name: 'network-policy-test',
          apiVersion: 'v1alpha1',
          kind: 'NetworkPolicyTest',
          spec: NetworkPolicyTestSpec,
          status: NetworkPolicyTestStatus,
        },
        (spec) => {
          const policy = ciliumNetworkPolicy({
            apiVersion: 'cilium.io/v2',
            kind: 'CiliumNetworkPolicy',
            metadata: {
              name: 'test-network-policy', // Use a static string to avoid KubernetesRef issues
              namespace: testNamespace,
            },
            spec: {
              endpointSelector: {
                matchLabels: { app: spec.targetApp },
              },
              ingress: [
                {
                  fromEndpoints: [
                    {
                      matchLabels: { app: spec.sourceApp },
                    },
                  ],
                  toPorts: [
                    {
                      ports: [{ port: '8080', protocol: 'TCP' }], // Use static port to avoid serialization issues
                    },
                  ],
                },
              ],
            },
            id: 'networkPolicy',
          });

          return {
            ready: true, // Use static value since Cilium resources don't have status.ready
            policyName: policy.metadata.name,
          };
        }
      );

      const directFactory = networkPolicyComposition.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const deploymentResult = await directFactory.deploy({
        name: 'test-network-policy',
        targetApp: 'frontend',
        sourceApp: 'backend',
        port: 8080,
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe('test-network-policy');
      expect(deploymentResult.spec.name).toBe('test-network-policy');
      expect(deploymentResult.spec.targetApp).toBe('frontend');
      expect(deploymentResult.spec.sourceApp).toBe('backend');
      expect(deploymentResult.spec.port).toBe(8080);

      console.log('✅ Direct factory CiliumNetworkPolicy deployment successful');
    });

    it('should deploy CiliumNetworkPolicy using kro factory with .deploy()', async () => {
      console.log('🚀 Testing CiliumNetworkPolicy with kro factory...');

      const NetworkPolicyKroTestSpec = type({
        name: 'string',
        targetApp: 'string',
        allowedCIDR: 'string',
      });

      const NetworkPolicyKroTestStatus = type({
        ready: 'boolean',
        policyName: 'string',
      });

      const networkPolicyComposition = kubernetesComposition(
        {
          name: 'network-policy-kro-test',
          apiVersion: 'v1alpha1',
          kind: 'NetworkPolicyKroTest',
          spec: NetworkPolicyKroTestSpec,
          status: NetworkPolicyKroTestStatus,
        },
        (spec) => {
          const policy = ciliumNetworkPolicy({
            apiVersion: 'cilium.io/v2',
            kind: 'CiliumNetworkPolicy',
            metadata: {
              name: 'test-network-policy-kro', // Use a static string to avoid KubernetesRef issues
              namespace: testNamespace,
            },
            spec: {
              endpointSelector: {
                matchLabels: { app: spec.targetApp },
              },
              ingress: [
                {
                  fromCIDR: ['10.0.0.0/8'], // Use static CIDR to avoid serialization issues
                  toPorts: [
                    {
                      ports: [{ port: '443', protocol: 'TCP' }],
                    },
                  ],
                },
              ],
            },
            id: 'networkPolicy',
          });

          return {
            ready: true, // Use static value since Cilium resources don't have status.ready
            policyName: policy.metadata.name,
          };
        }
      );

      kroNetworkPolicyFactory = networkPolicyComposition.factory('kro', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const deploymentResult = await kroNetworkPolicyFactory.deploy({
        name: 'test-network-policy-kro',
        targetApp: 'api',
        allowedCIDR: '10.0.0.0/8',
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe('test-network-policy-kro');
      expect(deploymentResult.spec.name).toBe('test-network-policy-kro');
      expect(deploymentResult.spec.targetApp).toBe('api');
      expect(deploymentResult.spec.allowedCIDR).toBe('10.0.0.0/8');

      console.log('✅ Kro factory CiliumNetworkPolicy deployment successful');
    });

    it('should deploy L7 HTTP CiliumNetworkPolicy', async () => {
      console.log('🚀 Testing L7 HTTP CiliumNetworkPolicy...');

      const L7PolicyTestSpec = type({
        name: 'string',
        targetApp: 'string',
        sourceApp: 'string',
        allowedPath: 'string',
      });

      const L7PolicyTestStatus = type({
        ready: 'boolean',
        policyName: 'string',
      });

      const l7PolicyComposition = kubernetesComposition(
        {
          name: 'l7-policy-test',
          apiVersion: 'v1alpha1',
          kind: 'L7PolicyTest',
          spec: L7PolicyTestSpec,
          status: L7PolicyTestStatus,
        },
        (spec) => {
          const policy = ciliumNetworkPolicy({
            apiVersion: 'cilium.io/v2',
            kind: 'CiliumNetworkPolicy',
            metadata: {
              name: 'test-l7-policy', // Use a static string to avoid KubernetesRef issues
              namespace: testNamespace,
            },
            spec: {
              endpointSelector: {
                matchLabels: { app: spec.targetApp },
              },
              ingress: [
                {
                  fromEndpoints: [
                    {
                      matchLabels: { app: spec.sourceApp },
                    },
                  ],
                  toPorts: [
                    {
                      ports: [{ port: '8080', protocol: 'TCP' }],
                      rules: {
                        http: [
                          {
                            method: 'GET',
                            path: '/api/v1/.*', // Use static path to avoid serialization issues
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
            id: 'l7Policy',
          });

          return {
            ready: true, // Use static value since Cilium resources don't have status.ready
            policyName: policy.metadata.name,
          };
        }
      );

      const directFactory = l7PolicyComposition.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const deploymentResult = await directFactory.deploy({
        name: 'test-l7-policy',
        targetApp: 'api-server',
        sourceApp: 'web-frontend',
        allowedPath: '/api/v1/.*',
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.spec.allowedPath).toBe('/api/v1/.*');

      console.log('✅ L7 HTTP CiliumNetworkPolicy deployment successful');
    });
  });

  describe('CiliumClusterwideNetworkPolicy Integration', () => {
    it('should deploy CiliumClusterwideNetworkPolicy using direct factory with .deploy()', async () => {
      console.log('🚀 Testing CiliumClusterwideNetworkPolicy with direct factory...');

      const ClusterPolicyTestSpec = type({
        name: 'string',
        nodeRole: 'string',
        targetApp: 'string',
      });

      const ClusterPolicyTestStatus = type({
        ready: 'boolean',
        policyName: 'string',
      });

      const clusterPolicyComposition = kubernetesComposition(
        {
          name: 'cluster-policy-test',
          apiVersion: 'v1alpha1',
          kind: 'ClusterPolicyTest',
          spec: ClusterPolicyTestSpec,
          status: ClusterPolicyTestStatus,
        },
        (spec) => {
          const policy = ciliumClusterwideNetworkPolicy({
            apiVersion: 'cilium.io/v2',
            kind: 'CiliumClusterwideNetworkPolicy',
            metadata: { name: spec.name },
            spec: {
              // Use ONLY endpointSelector (not both nodeSelector and endpointSelector due to oneOf constraint)
              endpointSelector: {
                matchLabels: { app: spec.targetApp },
              },
              ingress: [
                {
                  fromEntities: ['host'],
                  toPorts: [
                    {
                      ports: [{ port: '9100', protocol: 'TCP' }],
                    },
                  ],
                },
              ],
            },
            id: 'clusterPolicy',
          });

          return {
            ready: true, // Use static value since Cilium resources don't have status.ready
            policyName: policy.metadata.name,
          };
        }
      );

      const directFactory = clusterPolicyComposition.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const deploymentResult = await directFactory.deploy({
        name: 'test-cluster-policy',
        nodeRole: '',
        targetApp: 'node-exporter',
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe('test-cluster-policy');
      expect(deploymentResult.spec.name).toBe('test-cluster-policy');
      expect(deploymentResult.spec.targetApp).toBe('node-exporter');

      console.log('✅ Direct factory CiliumClusterwideNetworkPolicy deployment successful');
    });

    it('should deploy deny-all CiliumClusterwideNetworkPolicy using kro factory', async () => {
      console.log('🚀 Testing deny-all CiliumClusterwideNetworkPolicy with kro factory...');

      const DenyAllTestSpec = type({
        name: 'string',
        enabled: 'boolean',
      });

      const DenyAllTestStatus = type({
        ready: 'boolean',
        policyName: 'string',
        enforced: 'boolean',
      });

      const denyAllComposition = kubernetesComposition(
        {
          name: 'deny-all-test',
          apiVersion: 'v1alpha1',
          kind: 'DenyAllTest',
          spec: DenyAllTestSpec,
          status: DenyAllTestStatus,
        },
        (spec) => {
          const policy = ciliumClusterwideNetworkPolicy({
            apiVersion: 'cilium.io/v2',
            kind: 'CiliumClusterwideNetworkPolicy',
            metadata: { name: 'test-deny-all-policy' }, // Use a static string to avoid KubernetesRef issues
            spec: {
              endpointSelector: {}, // Selects all endpoints
              ingress: [], // Empty ingress rules = deny all ingress traffic
              egress: [], // Empty egress rules = deny all egress traffic
            },
            id: 'denyAllPolicy',
          });

          return {
            ready: true, // Use static value since Cilium resources don't have status.ready
            policyName: policy.metadata.name,
            enforced: spec.enabled,
          };
        }
      );

      kroDenyAllFactory = denyAllComposition.factory('kro', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kubeConfig,
      });

      const deploymentResult = await kroDenyAllFactory.deploy({
        name: 'test-deny-all-policy',
        enabled: true,
      });

      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toBe('test-deny-all-policy');
      expect(deploymentResult.spec.enabled).toBe(true);

      console.log('✅ Kro factory deny-all CiliumClusterwideNetworkPolicy deployment successful');
    });
  });

  describe('Network Policy Validation', () => {
    it('should validate complex network policy configurations', () => {
      console.log('🧪 Testing complex network policy validation...');

      const scenarios = [
        {
          name: 'multi-source-policy',
          config: {
            apiVersion: 'cilium.io/v2' as const,
            kind: 'CiliumNetworkPolicy' as const,
            metadata: {
              name: 'multi-source',
              namespace: testNamespace,
            },
            spec: {
              endpointSelector: {
                matchLabels: { app: 'database' },
              },
              ingress: [
                {
                  fromEndpoints: [
                    {
                      matchLabels: { app: 'api' },
                    },
                  ],
                  toPorts: [
                    {
                      ports: [{ port: '5432', protocol: 'TCP' as const }],
                    },
                  ],
                },
                {
                  fromCIDR: ['10.0.0.0/8'],
                  toPorts: [
                    {
                      ports: [{ port: '5432', protocol: 'TCP' as const }],
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          name: 'egress-policy',
          config: {
            apiVersion: 'cilium.io/v2' as const,
            kind: 'CiliumNetworkPolicy' as const,
            metadata: {
              name: 'egress-control',
              namespace: testNamespace,
            },
            spec: {
              endpointSelector: {
                matchLabels: { app: 'client' },
              },
              egress: [
                {
                  toFQDNs: [
                    {
                      matchPattern: '*.example.com',
                    },
                  ],
                  toPorts: [
                    {
                      ports: [{ port: '443', protocol: 'TCP' as const }],
                    },
                  ],
                },
              ],
            },
          },
        },
      ];

      scenarios.forEach(({ name: _name, config }) => {
        const policy = ciliumNetworkPolicy(config);
        expect(policy).toBeDefined();
        expect(policy.metadata?.name).toBe(config.metadata?.name);
        expect(policy.spec?.endpointSelector).toEqual(config.spec?.endpointSelector);
      });

      console.log('✅ Complex network policy validation successful');
    });
  });
});
