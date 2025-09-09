/**
 * Unit Tests for Cilium Networking CRD Factories
 *
 * This test suite validates the Cilium networking factory functions:
 * - CiliumNetworkPolicy factory and readiness evaluator
 * - CiliumClusterwideNetworkPolicy factory and readiness evaluator
 */

import { describe, it, expect } from 'bun:test';
import { 
  ciliumNetworkPolicy, 
  ciliumClusterwideNetworkPolicy,
  ciliumNetworkPolicyReadinessEvaluator,
  ciliumClusterwideNetworkPolicyReadinessEvaluator
} from '../../../src/factories/cilium/resources/networking.js';
import type { 
  CiliumNetworkPolicy,
  CiliumClusterwideNetworkPolicy
} from '../../../src/factories/cilium/types.js';

describe('Cilium Networking CRD Factories', () => {
  
  describe('CiliumNetworkPolicy Factory', () => {
    
    it('should create a basic CiliumNetworkPolicy', () => {
      const resource: CiliumNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {
          name: 'test-policy',
          namespace: 'default'
        },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'frontend' }
          },
          ingress: [{
            fromEndpoints: [{
              matchLabels: { app: 'backend' }
            }],
            toPorts: [{
              ports: [{ port: '8080', protocol: 'TCP' }]
            }]
          }]
        }
      };
      
      const policy = ciliumNetworkPolicy(resource);
      
      expect(policy).toBeDefined();
      expect(policy.apiVersion).toBe('cilium.io/v2');
      expect(policy.kind).toBe('CiliumNetworkPolicy');
      expect(policy.metadata?.name).toBe('test-policy');
      expect(policy.metadata?.namespace).toBe('default');
      expect(policy.spec?.endpointSelector?.matchLabels?.app).toBe('frontend');
      expect(policy.spec?.ingress).toHaveLength(1);
      expect(policy.spec?.ingress?.[0]?.fromEndpoints?.[0]?.matchLabels?.app).toBe('backend');
    });
    
    it('should create a CiliumNetworkPolicy with L7 HTTP rules', () => {
      const resource: CiliumNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {
          name: 'api-policy',
          namespace: 'production'
        },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'api' }
          },
          ingress: [{
            fromEndpoints: [{
              matchLabels: { app: 'frontend' }
            }],
            toPorts: [{
              ports: [{ port: '8080', protocol: 'TCP' }],
              rules: {
                http: [{
                  method: 'GET',
                  path: '/api/v1/.*'
                }, {
                  method: 'POST',
                  path: '/api/v1/users'
                }]
              }
            }]
          }]
        }
      };
      
      const policy = ciliumNetworkPolicy(resource);
      
      expect(policy.spec?.ingress?.[0]?.toPorts?.[0]?.rules?.http).toHaveLength(2);
      expect(policy.spec?.ingress?.[0]?.toPorts?.[0]?.rules?.http?.[0]?.method).toBe('GET');
      expect(policy.spec?.ingress?.[0]?.toPorts?.[0]?.rules?.http?.[0]?.path).toBe('/api/v1/.*');
      expect(policy.spec?.ingress?.[0]?.toPorts?.[0]?.rules?.http?.[1]?.method).toBe('POST');
    });
    
    it('should create a CiliumNetworkPolicy with egress rules', () => {
      const resource: CiliumNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {
          name: 'egress-policy'
        },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'client' }
          },
          egress: [{
            toEndpoints: [{
              matchLabels: { app: 'database' }
            }],
            toPorts: [{
              ports: [{ port: '5432', protocol: 'TCP' }]
            }]
          }, {
            toCIDR: ['10.0.0.0/8'],
            toPorts: [{
              ports: [{ port: '443', protocol: 'TCP' }]
            }]
          }]
        }
      };
      
      const policy = ciliumNetworkPolicy(resource);
      
      expect(policy.spec?.egress).toHaveLength(2);
      expect(policy.spec?.egress?.[0]?.toEndpoints?.[0]?.matchLabels?.app).toBe('database');
      expect(policy.spec?.egress?.[1]?.toCIDR).toContain('10.0.0.0/8');
    });
    
    it('should create a CiliumNetworkPolicy with FQDN rules', () => {
      const resource: CiliumNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: { name: 'fqdn-policy' },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'web-scraper' }
          },
          egress: [{
            toFQDNs: [{
              matchName: 'api.example.com'
            }, {
              matchPattern: '*.googleapis.com'
            }],
            toPorts: [{
              ports: [{ port: '443', protocol: 'TCP' }]
            }]
          }]
        }
      };
      
      const policy = ciliumNetworkPolicy(resource);
      
      expect(policy.spec?.egress?.[0]?.toFQDNs).toHaveLength(2);
      expect(policy.spec?.egress?.[0]?.toFQDNs?.[0]?.matchName).toBe('api.example.com');
      expect(policy.spec?.egress?.[0]?.toFQDNs?.[1]?.matchPattern).toBe('*.googleapis.com');
    });
    
    it('should default namespace to "default" if not provided', () => {
      const resource: CiliumNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: { name: 'test-policy' },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'test' }
          }
        }
      };
      
      const policy = ciliumNetworkPolicy(resource);
      
      expect(policy.metadata?.namespace).toBe('default');
    });
    
    it('should throw error if name is missing', () => {
      const resource = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {} as any, // Force empty metadata to test validation
        spec: {
          endpointSelector: {
            matchLabels: { app: 'test' }
          }
        }
      } as CiliumNetworkPolicy;
      
      expect(() => ciliumNetworkPolicy(resource)).toThrow('CiliumNetworkPolicy name is required');
    });
    
    it('should throw error if spec is missing', () => {
      const resource = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {
          name: 'test-policy'
        }
      } as CiliumNetworkPolicy;
      
      expect(() => ciliumNetworkPolicy(resource)).toThrow('CiliumNetworkPolicy spec is required');
    });
    
    it('should allow empty endpointSelector for selecting all endpoints', () => {
      const resource: CiliumNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: { name: 'test-policy' },
        spec: {
          endpointSelector: {} // Empty selector selects all endpoints
        }
      };
      
      const policy = ciliumNetworkPolicy(resource);
      expect(policy.spec?.endpointSelector).toEqual({});
    });
    
    it('should throw error if ingress rule has no source', () => {
      const resource: CiliumNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: { name: 'test-policy' },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'test' }
          },
          ingress: [{
            toPorts: [{
              ports: [{ port: '8080', protocol: 'TCP' }]
            }]
          }]
        }
      };
      
      expect(() => ciliumNetworkPolicy(resource)).toThrow('CiliumNetworkPolicy ingress rule 0 must specify at least one source');
    });
    
    it('should throw error if egress rule has no destination', () => {
      const resource: CiliumNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: { name: 'test-policy' },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'test' }
          },
          egress: [{
            toPorts: [{
              ports: [{ port: '8080', protocol: 'TCP' }]
            }]
          }]
        }
      };
      
      expect(() => ciliumNetworkPolicy(resource)).toThrow('CiliumNetworkPolicy egress rule 0 must specify at least one destination');
    });
    
  });
  
  describe('CiliumClusterwideNetworkPolicy Factory', () => {
    
    it('should create a basic CiliumClusterwideNetworkPolicy', () => {
      const resource: CiliumClusterwideNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumClusterwideNetworkPolicy',
        metadata: { name: 'cluster-deny-all' },
        spec: {
          endpointSelector: {}, // Selects all endpoints
          ingress: [] // Empty ingress = deny all
        },
      };
      
      const policy = ciliumClusterwideNetworkPolicy(resource);
      
      expect(policy).toBeDefined();
      expect(policy.apiVersion).toBe('cilium.io/v2');
      expect(policy.kind).toBe('CiliumClusterwideNetworkPolicy');
      expect(policy.metadata?.name).toBe('cluster-deny-all');
      // Cluster-scoped resources don't have namespace in the manifest
      expect(policy.metadata?.name).toBe('cluster-deny-all');
      expect(policy.spec?.ingress).toHaveLength(0);
    });
    
    it('should create a CiliumClusterwideNetworkPolicy with node selector', () => {
      const resource: CiliumClusterwideNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumClusterwideNetworkPolicy',
        metadata: { name: 'worker-node-policy' },
        spec: {
          nodeSelector: {
            matchLabels: { 'node-role.kubernetes.io/worker': '' }
          },
          endpointSelector: {
            matchLabels: { app: 'system-service' }
          },
          ingress: [{
            fromEntities: ['host'],
            toPorts: [{
              ports: [{ port: '9100', protocol: 'TCP' }]
            }]
          }]
        }
      };
      
      const policy = ciliumClusterwideNetworkPolicy(resource);
      
      expect(policy.spec?.nodeSelector?.matchLabels?.['node-role.kubernetes.io/worker']).toBe('');
      expect(policy.spec?.ingress?.[0]?.fromEntities).toContain('host');
    });
    
    it('should create a CiliumClusterwideNetworkPolicy with complex rules', () => {
      const resource: CiliumClusterwideNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumClusterwideNetworkPolicy',
        metadata: { name: 'complex-cluster-policy' },
        spec: {
          endpointSelector: {
            matchExpressions: [{
              key: 'security-level',
              operator: 'In',
              values: ['high', 'critical']
            }]
          },
          ingress: [{
            fromCIDR: ['10.0.0.0/8', '172.16.0.0/12'],
            toPorts: [{
              ports: [{ port: '443', protocol: 'TCP' }],
              rules: {
                http: [{
                  method: 'GET',
                  path: '/health'
                }]
              }
            }]
          }],
          egress: [{
            toEntities: ['world'],
            toPorts: [{
              ports: [{ port: '443', protocol: 'TCP' }]
            }]
          }]
        }
      };
      
      const policy = ciliumClusterwideNetworkPolicy(resource);
      
      expect(policy.spec?.endpointSelector?.matchExpressions?.[0]?.key).toBe('security-level');
      expect(policy.spec?.endpointSelector?.matchExpressions?.[0]?.operator).toBe('In');
      expect(policy.spec?.ingress?.[0]?.fromCIDR).toContain('10.0.0.0/8');
      expect(policy.spec?.egress?.[0]?.toEntities).toContain('world');
    });
    
    it('should throw error if name is missing', () => {
      const resource = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumClusterwideNetworkPolicy',
        metadata: {},
        spec: {
          endpointSelector: {}
        }
      } as CiliumClusterwideNetworkPolicy;
      
      expect(() => ciliumClusterwideNetworkPolicy(resource)).toThrow('CiliumClusterwideNetworkPolicy name is required');
    });
    
    it('should throw error if spec is missing', () => {
      const resource = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumClusterwideNetworkPolicy',
        metadata: {
          name: 'test-policy'
        }
      } as CiliumClusterwideNetworkPolicy;
      
      expect(() => ciliumClusterwideNetworkPolicy(resource)).toThrow('CiliumClusterwideNetworkPolicy spec is required');
    });
    
    it('should allow empty endpointSelector for selecting all endpoints', () => {
      const resource: CiliumClusterwideNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumClusterwideNetworkPolicy',
        metadata: { name: 'test-policy' },
        spec: {
          endpointSelector: {} // Empty selector selects all endpoints
        }
      };
      
      const policy = ciliumClusterwideNetworkPolicy(resource);
      expect(policy.spec?.endpointSelector).toEqual({});
    });
    
    it('should throw error if nodeSelector is invalid', () => {
      const resource: CiliumClusterwideNetworkPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumClusterwideNetworkPolicy',
        metadata: { name: 'test-policy' },
        spec: {
          nodeSelector: {}, // Empty selector
          endpointSelector: {
            matchLabels: { app: 'test' }
          }
        }
      };
      
      expect(() => ciliumClusterwideNetworkPolicy(resource)).toThrow('CiliumClusterwideNetworkPolicy nodeSelector must have matchLabels or matchExpressions');
    });
    
  });
  
  describe('CiliumNetworkPolicy Readiness Evaluator', () => {
    
    it('should return not ready when status is missing', () => {
      const resource = {
        metadata: { name: 'test-policy' },
        spec: {}
      };
      
      const result = ciliumNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(false);
      expect(result.message).toBe('CiliumNetworkPolicy status not available');
      expect(result.details?.phase).toBe('pending');
    });
    
    it('should return not ready when Ready condition is False', () => {
      const resource = {
        metadata: { name: 'test-policy' },
        spec: {},
        status: {
          conditions: [{
            type: 'Ready',
            status: 'False',
            reason: 'ValidationError',
            message: 'Invalid endpoint selector'
          }]
        }
      };
      
      const result = ciliumNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(false);
      expect(result.message).toBe('CiliumNetworkPolicy not ready: Invalid endpoint selector');
      expect(result.details?.condition?.reason).toBe('ValidationError');
    });
    
    it('should return ready when Ready condition is True', () => {
      const resource = {
        metadata: { name: 'test-policy' },
        spec: {},
        status: {
          conditions: [{
            type: 'Ready',
            status: 'True',
            reason: 'PolicyApplied',
            message: 'Policy successfully applied',
            lastTransitionTime: '2024-01-01T00:00:00Z'
          }]
        }
      };
      
      const result = ciliumNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(true);
      expect(result.message).toBe('CiliumNetworkPolicy is ready and applied');
      expect(result.details?.lastTransition).toBe('2024-01-01T00:00:00Z');
    });
    
    it('should handle state field when conditions are not available', () => {
      const resource = {
        metadata: { name: 'test-policy' },
        spec: {},
        status: {
          state: 'ready'
        }
      };
      
      const result = ciliumNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(true);
      expect(result.message).toBe('CiliumNetworkPolicy is ready');
      expect(result.details?.state).toBe('ready');
    });
    
    it('should handle error state', () => {
      const resource = {
        metadata: { name: 'test-policy' },
        spec: {},
        status: {
          state: 'error',
          message: 'Policy validation failed'
        }
      };
      
      const result = ciliumNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(false);
      expect(result.message).toBe('CiliumNetworkPolicy failed: Policy validation failed');
    });
    
    it('should handle pending state', () => {
      const resource = {
        metadata: { name: 'test-policy' },
        spec: {},
        status: {
          state: 'applying'
        }
      };
      
      const result = ciliumNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(false);
      expect(result.message).toBe('CiliumNetworkPolicy is being applied');
    });
    
    it('should handle unknown state', () => {
      const resource = {
        metadata: { name: 'test-policy' },
        spec: {},
        status: {
          state: 'unknown-state'
        }
      };
      
      const result = ciliumNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(false);
      expect(result.message).toBe('CiliumNetworkPolicy in unknown state: unknown-state');
    });
    
  });
  
  describe('CiliumClusterwideNetworkPolicy Readiness Evaluator', () => {
    
    it('should return not ready when status is missing', () => {
      const resource = {
        metadata: { name: 'cluster-policy' },
        spec: {}
      };
      
      const result = ciliumClusterwideNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(false);
      expect(result.message).toBe('CiliumClusterwideNetworkPolicy status not available');
    });
    
    it('should return ready when Ready condition is True', () => {
      const resource = {
        metadata: { name: 'cluster-policy' },
        spec: {},
        status: {
          conditions: [{
            type: 'Ready',
            status: 'True',
            reason: 'PolicyApplied',
            message: 'Cluster-wide policy successfully applied',
            lastTransitionTime: '2024-01-01T00:00:00Z'
          }]
        }
      };
      
      const result = ciliumClusterwideNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(true);
      expect(result.message).toBe('CiliumClusterwideNetworkPolicy is ready and applied cluster-wide');
      expect(result.details?.lastTransition).toBe('2024-01-01T00:00:00Z');
    });
    
    it('should handle cluster-wide applying state', () => {
      const resource = {
        metadata: { name: 'cluster-policy' },
        spec: {},
        status: {
          state: 'applying'
        }
      };
      
      const result = ciliumClusterwideNetworkPolicyReadinessEvaluator(resource);
      
      expect(result.ready).toBe(false);
      expect(result.message).toBe('CiliumClusterwideNetworkPolicy is being applied cluster-wide');
    });
    
  });
  
  describe('Factory Integration', () => {
    
    it('should create resources with embedded readiness evaluators', () => {
      const networkPolicy = ciliumNetworkPolicy({
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: { name: 'test-policy' },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'test' }
          }
        }
      });
      
      const clusterPolicy = ciliumClusterwideNetworkPolicy({
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumClusterwideNetworkPolicy',
        metadata: { name: 'cluster-policy' },
        spec: {
          endpointSelector: {
            matchLabels: { app: 'test' }
          }
        }
      });
      
      // Both should have readiness evaluators attached
      expect((networkPolicy as any).readinessEvaluator).toBeDefined();
      expect((clusterPolicy as any).readinessEvaluator).toBeDefined();
      
      // Test that evaluators work
      const networkResult = (networkPolicy as any).readinessEvaluator?.(networkPolicy);
      const clusterResult = (clusterPolicy as any).readinessEvaluator?.(clusterPolicy);
      
      expect(networkResult?.ready).toBe(false); // No status yet
      expect(clusterResult?.ready).toBe(false); // No status yet
    });
    
  });
  
});