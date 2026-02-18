/**
 * Test suite for Networking Factory Functions
 *
 * This tests ingress and network policy factories with their readiness evaluation.
 */

import { describe, expect, it } from 'bun:test';
import type { V1Ingress, V1NetworkPolicy } from '@kubernetes/client-node';
import { ingress } from '../../src/factories/kubernetes/networking/ingress.js';
import { networkPolicy } from '../../src/factories/kubernetes/networking/network-policy.js';

describe('Networking Factories', () => {
  describe('Ingress Factory', () => {
    const createTestIngress = (name: string = 'test-ingress'): V1Ingress => ({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name, namespace: 'default' },
      spec: {
        rules: [
          {
            host: 'example.com',
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: 'backend-service',
                      port: { number: 80 },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    it('should create ingress with proper readiness evaluator', () => {
      const ingressResource = createTestIngress();
      const enhanced = ingress(ingressResource);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('Ingress');
      expect(enhanced.apiVersion).toBe('networking.k8s.io/v1');
      expect(enhanced.metadata!.name).toBe('test-ingress');
      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate as ready when load balancer has endpoints', () => {
      const ingressResource = createTestIngress('ready-ingress');
      const enhanced = ingress(ingressResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      const readyState = {
        status: {
          loadBalancer: {
            ingress: [{ ip: '192.168.1.100' }, { hostname: 'lb.example.com' }],
          },
        },
      };

      const result = evaluator(readyState);
      expect(result.ready).toBe(true);
      // Evaluator reports the first endpoint's ip/hostname
      expect(result.message).toContain('192.168.1.100');
    });

    it('should evaluate as not ready when no load balancer endpoints and not processed', () => {
      const ingressResource = createTestIngress('pending-ingress');
      const enhanced = ingress(ingressResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Resource without resourceVersion/generation (not yet processed by controller)
      const pendingState = {
        metadata: {
          name: 'pending-ingress',
          // No resourceVersion or generation - not yet processed
        },
        status: {
          loadBalancer: {
            ingress: [], // No endpoints yet
          },
        },
      };

      const result = evaluator(pendingState);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('WaitingForController');
      expect(result.message).toBe('Waiting for ingress controller to process the resource');
    });

    it('should evaluate as ready when processed by controller even without load balancer', () => {
      const ingressResource = createTestIngress('processed-ingress');
      const enhanced = ingress(ingressResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Resource with resourceVersion and generation but no observedGeneration
      // should NOT be considered ready — resourceVersion is set by API server, not controller
      const processedState = {
        metadata: {
          name: 'processed-ingress',
          resourceVersion: '12345',
          generation: 1,
        },
        status: {
          loadBalancer: {
            ingress: [], // No endpoints yet
          },
        },
      };

      const notReadyResult = evaluator(processedState);
      expect(notReadyResult.ready).toBe(false);
      expect(notReadyResult.reason).toBe('WaitingForController');

      // Resource with observedGeneration matching generation IS ready
      const observedState = {
        metadata: {
          name: 'processed-ingress',
          resourceVersion: '12345',
          generation: 1,
        },
        status: {
          observedGeneration: 1,
          loadBalancer: {
            ingress: [],
          },
        },
      };

      const readyResult = evaluator(observedState);
      expect(readyResult.ready).toBe(true);
      expect(readyResult.message).toContain('observedGeneration matches generation');
    });

    it('should handle missing status gracefully', () => {
      const ingressResource = createTestIngress('no-status');
      const enhanced = ingress(ingressResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Test with null status — not ready
      const nullStatusResult = evaluator({ status: null, metadata: {} });
      expect(nullStatusResult.ready).toBe(false);
      expect(nullStatusResult.reason).toBe('WaitingForController');

      // Test with undefined status — not ready
      const undefinedStatusResult = evaluator({ status: undefined, metadata: {} });
      expect(undefinedStatusResult.ready).toBe(false);
      expect(undefinedStatusResult.reason).toBe('WaitingForController');

      // Test with missing status entirely — not ready
      const noStatusResult = evaluator({ metadata: {} });
      expect(noStatusResult.ready).toBe(false);
      expect(noStatusResult.reason).toBe('WaitingForController');

      // Test with resourceVersion but no observedGeneration — still not ready
      // resourceVersion is set by the API server, not by the ingress controller
      const processedNoStatusResult = evaluator({
        metadata: { resourceVersion: '12345', generation: 1 },
      });
      expect(processedNoStatusResult.ready).toBe(false);
      expect(processedNoStatusResult.reason).toBe('WaitingForController');
    });

    it('should handle missing load balancer gracefully', () => {
      const ingressResource = createTestIngress('no-lb');
      const enhanced = ingress(ingressResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // No loadBalancer field and not processed — not ready
      const noLoadBalancerNotProcessed = {
        metadata: {
          name: 'no-lb',
        },
        status: {},
      };

      const notProcessedResult = evaluator(noLoadBalancerNotProcessed);
      expect(notProcessedResult.ready).toBe(false);
      expect(notProcessedResult.reason).toBe('WaitingForController');
      expect(notProcessedResult.message).toBe(
        'Waiting for ingress controller to process the resource'
      );

      // No loadBalancer field, has resourceVersion + generation but NO observedGeneration
      // resourceVersion/generation are set by the API server, NOT by the controller
      // Without observedGeneration, we can't confirm the controller has processed the resource
      const noLoadBalancerNoObservedGen = {
        metadata: {
          name: 'no-lb',
          resourceVersion: '12345',
          generation: 1,
        },
        status: {},
      };

      const noObservedGenResult = evaluator(noLoadBalancerNoObservedGen);
      expect(noObservedGenResult.ready).toBe(false);
      expect(noObservedGenResult.reason).toBe('WaitingForController');

      // No loadBalancer but observedGeneration matches generation — controller has acknowledged
      const noLoadBalancerWithObservedGen = {
        metadata: {
          name: 'no-lb',
          generation: 1,
        },
        status: {
          observedGeneration: 1,
        },
      };

      const observedGenResult = evaluator(noLoadBalancerWithObservedGen);
      expect(observedGenResult.ready).toBe(true);
      expect(observedGenResult.message).toContain('observedGeneration matches generation');
    });

    it('should handle multiple load balancer ingress endpoints', () => {
      const ingressResource = createTestIngress('multi-endpoint');
      const enhanced = ingress(ingressResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      const multiEndpointState = {
        status: {
          loadBalancer: {
            ingress: [
              { ip: '10.0.0.1' },
              { ip: '10.0.0.2' },
              { hostname: 'primary.example.com' },
              { hostname: 'secondary.example.com' },
              { ip: '10.0.0.3', hostname: 'combined.example.com' },
            ],
          },
        },
      };

      const result = evaluator(multiEndpointState);
      expect(result.ready).toBe(true);
      // Evaluator reports the first endpoint's ip/hostname
      expect(result.message).toContain('10.0.0.1');
    });

    it('should provide detailed readiness messages', () => {
      const ingressResource = createTestIngress('detailed-messages');
      const enhanced = ingress(ingressResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Test single endpoint with IP
      const singleEndpointState = {
        status: {
          loadBalancer: {
            ingress: [{ ip: '203.0.113.1' }],
          },
        },
      };

      const singleResult = evaluator(singleEndpointState);
      expect(singleResult.ready).toBe(true);
      expect(singleResult.message).toBe('Ingress has load balancer endpoint: 203.0.113.1');

      // Test single endpoint with hostname
      const hostnameEndpointState = {
        status: {
          loadBalancer: {
            ingress: [{ hostname: 'test.example.com' }],
          },
        },
      };

      const hostnameResult = evaluator(hostnameEndpointState);
      expect(hostnameResult.ready).toBe(true);
      expect(hostnameResult.message).toBe('Ingress has load balancer endpoint: test.example.com');

      // Test LB ingress entries with no ip or hostname — still provisioning
      const emptyEntriesState = {
        status: {
          loadBalancer: {
            ingress: [{}],
          },
        },
      };

      const emptyResult = evaluator(emptyEntriesState);
      expect(emptyResult.ready).toBe(false);
      expect(emptyResult.reason).toBe('LoadBalancerProvisioning');
    });

    it.skip('should handle readiness evaluation errors', () => {
      const ingressResource = createTestIngress('error-handling');
      const enhanced = ingress(ingressResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Test with malformed input that might cause errors
      const _errorScenarios = [null, undefined, 'invalid-string', 42, { status: 'invalid-status' }];

      // Test just with truly invalid input that will hit the catch block
      const result = evaluator({ invalidField: 'this will cause errors when accessing .status' });
      expect(result.ready).toBe(false);
      expect(result.reason).toContain('Error checking Ingress status');
    });

    it('should handle default metadata when missing', () => {
      const ingressWithoutMetadata: V1Ingress = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        // metadata is missing
        spec: {
          rules: [
            {
              host: 'default.example.com',
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: {
                      service: {
                        name: 'default-service',
                        port: { number: 80 },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      } as any;

      const enhanced = ingress(ingressWithoutMetadata);
      expect(enhanced.metadata!.name).toBe('unnamed-ingress');
    });

    it('should preserve original ingress specification', () => {
      const originalIngress = createTestIngress('preservation-test');
      const enhanced = ingress(originalIngress);

      // Verify all original properties are preserved
      expect(enhanced.spec).toEqual(originalIngress.spec! as any);
      expect(enhanced.metadata!.name).toBe('preservation-test');
      expect(enhanced.metadata!.namespace).toBe('default');
      expect(enhanced.apiVersion).toBe('networking.k8s.io/v1');
      expect(enhanced.kind).toBe('Ingress');
    });
  });

  describe('NetworkPolicy Factory', () => {
    const createTestNetworkPolicy = (name: string = 'test-policy'): V1NetworkPolicy => ({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name, namespace: 'default' },
      spec: {
        podSelector: {
          matchLabels: { app: 'web' },
        },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            _from: [
              {
                podSelector: {
                  matchLabels: { app: 'frontend' },
                },
              },
            ],
            ports: [
              {
                protocol: 'TCP',
                port: 8080,
              },
            ],
          },
        ],
        egress: [
          {
            to: [
              {
                podSelector: {
                  matchLabels: { app: 'database' },
                },
              },
            ],
            ports: [
              {
                protocol: 'TCP',
                port: 5432,
              },
            ],
          },
        ],
      },
    });

    it('should create network policy with correct structure', () => {
      const policyResource = createTestNetworkPolicy();
      const enhanced = networkPolicy(policyResource);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('NetworkPolicy');
      expect(enhanced.apiVersion).toBe('networking.k8s.io/v1');
      expect(enhanced.metadata!.name).toBe('test-policy');
      expect(enhanced.metadata!.namespace).toBe('default');
    });

    it('should set proper apiVersion and kind', () => {
      const policyResource = createTestNetworkPolicy('version-test');
      const enhanced = networkPolicy(policyResource);

      expect(enhanced.apiVersion).toBe('networking.k8s.io/v1');
      expect(enhanced.kind).toBe('NetworkPolicy');
    });

    it('should handle missing metadata gracefully', () => {
      const policyWithoutMetadata: V1NetworkPolicy = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        // metadata is missing
        spec: {
          podSelector: {
            matchLabels: { app: 'test' },
          },
          policyTypes: ['Ingress'],
        },
      } as any;

      const enhanced = networkPolicy(policyWithoutMetadata);
      expect(enhanced.metadata!.name).toBe('unnamed-networkpolicy');
    });

    it('should preserve complex network policy specifications', () => {
      const complexPolicy: V1NetworkPolicy = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
          name: 'complex-policy',
          namespace: 'production',
          labels: {
            tier: 'security',
            environment: 'prod',
          },
          annotations: {
            'policy.example.com/description': 'Complex network policy for production',
          },
        },
        spec: {
          podSelector: {
            matchLabels: { app: 'api-server' },
          },
          policyTypes: ['Ingress', 'Egress'],
          ingress: [
            {
              _from: [
                {
                  podSelector: {
                    matchLabels: { app: 'frontend' },
                  },
                },
                {
                  namespaceSelector: {
                    matchLabels: { name: 'monitoring' },
                  },
                },
              ],
              ports: [
                {
                  protocol: 'TCP',
                  port: 8080,
                },
                {
                  protocol: 'TCP',
                  port: 9090,
                },
              ],
            },
          ],
          egress: [
            {
              to: [
                {
                  podSelector: {
                    matchLabels: { app: 'database' },
                  },
                },
              ],
              ports: [
                {
                  protocol: 'TCP',
                  port: 5432,
                },
              ],
            },
            {
              // Allow DNS
              to: [],
              ports: [
                {
                  protocol: 'UDP',
                  port: 53,
                },
              ],
            },
          ],
        },
      };

      const enhanced = networkPolicy(complexPolicy);

      // Verify all properties are preserved
      expect(enhanced.metadata).toEqual(complexPolicy.metadata! as any);
      expect(enhanced.spec).toEqual(complexPolicy.spec! as any);
      expect(enhanced.spec!.ingress).toHaveLength(1);
      expect(enhanced.spec!.egress).toHaveLength(2);
      expect(enhanced.spec?.ingress?.[0]?._from).toHaveLength(2);
      expect(enhanced.spec?.ingress?.[0]?.ports).toHaveLength(2);
    });

    it('should handle minimal network policy specifications', () => {
      const minimalPolicy: V1NetworkPolicy = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'minimal-policy' },
        spec: {
          podSelector: {}, // Empty selector matches all pods
        },
      };

      const enhanced = networkPolicy(minimalPolicy);
      expect(enhanced.spec?.podSelector).toEqual({} as any);
      expect(enhanced.metadata!.name).toBe('minimal-policy');
    });

    it('should maintain resource structure for various policy types', () => {
      // Ingress-only policy
      const ingressOnlyPolicy = createTestNetworkPolicy('ingress-only');
      ingressOnlyPolicy.spec!.policyTypes = ['Ingress'];
      delete ingressOnlyPolicy.spec!.egress;

      const ingressOnlyEnhanced = networkPolicy(ingressOnlyPolicy);
      expect(ingressOnlyEnhanced.spec.policyTypes).toEqual(['Ingress']);
      expect(ingressOnlyEnhanced.spec.egress).toBeDefined();

      // Egress-only policy
      const egressOnlyPolicy = createTestNetworkPolicy('egress-only');
      egressOnlyPolicy.spec!.policyTypes = ['Egress'];
      delete egressOnlyPolicy.spec!.ingress;

      const egressOnlyEnhanced = networkPolicy(egressOnlyPolicy);
      expect(egressOnlyEnhanced.spec.policyTypes).toEqual(['Egress']);
      expect(egressOnlyEnhanced.spec.ingress).toBeDefined();
    });

    it('should work with different pod selector patterns', () => {
      // Empty selector (matches all pods)
      const allPodsPolicy = createTestNetworkPolicy('all-pods');
      allPodsPolicy.spec!.podSelector = {};

      const allPodsEnhanced = networkPolicy(allPodsPolicy);
      expect(allPodsEnhanced.spec.podSelector).toEqual({} as any);

      // Label-based selector
      const labelSelectorPolicy = createTestNetworkPolicy('label-selector');
      labelSelectorPolicy.spec!.podSelector = {
        matchLabels: { app: 'web', tier: 'frontend' },
      };

      const labelSelectorEnhanced = networkPolicy(labelSelectorPolicy);
      expect(labelSelectorEnhanced.spec.podSelector.matchLabels).toEqual({
        app: 'web',
        tier: 'frontend',
      });

      // Expression-based selector
      const expressionSelectorPolicy = createTestNetworkPolicy('expression-selector');
      expressionSelectorPolicy.spec!.podSelector = {
        matchExpressions: [
          {
            key: 'environment',
            operator: 'In',
            values: ['production', 'staging'],
          },
        ],
      };

      const expressionSelectorEnhanced = networkPolicy(expressionSelectorPolicy);
      expect(expressionSelectorEnhanced.spec.podSelector.matchExpressions).toHaveLength(1);
      expect(expressionSelectorEnhanced.spec?.podSelector?.matchExpressions?.[0]?.operator).toBe(
        'In'
      );
    });
  });

  describe('Factory Integration', () => {
    it('should create both ingress and network policy in the same namespace', () => {
      const testIngress = ingress({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: { name: 'app-ingress', namespace: 'production' },
        spec: {
          rules: [
            {
              host: 'app.example.com',
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: {
                      service: {
                        name: 'app-service',
                        port: { number: 80 },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      });

      const testPolicy = networkPolicy({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'app-policy', namespace: 'production' },
        spec: {
          podSelector: {
            matchLabels: { app: 'web-app' },
          },
          policyTypes: ['Ingress'],
        },
      });

      expect(testIngress.metadata.namespace).toBe('production');
      expect(testPolicy.metadata.namespace).toBe('production');
      expect(testIngress.kind).toBe('Ingress');
      expect(testPolicy.kind).toBe('NetworkPolicy');
    });

    it('should maintain independence between different networking resources', () => {
      const ingress1 = ingress({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: { name: 'ingress-1' },
        spec: { rules: [] },
      });

      const ingress2 = ingress({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: { name: 'ingress-2' },
        spec: { rules: [] },
      });

      const policy1 = networkPolicy({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'policy-1' },
        spec: { podSelector: {} },
      });

      // Each resource should maintain its own identity
      expect(ingress1.metadata.name).toBe('ingress-1');
      expect(ingress2.metadata.name).toBe('ingress-2');
      expect(policy1.metadata.name).toBe('policy-1');

      // Resources should not interfere with each other
      expect(ingress1).not.toBe(ingress2);
      expect(ingress1).not.toBe(policy1);
      expect(ingress2).not.toBe(policy1);
    });
  });
});
