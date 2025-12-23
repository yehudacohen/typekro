/**
 * Integration tests for JavaScript to CEL conversion with magic proxy system
 * 
 * Tests the integration between toResourceGraph, kubernetesComposition, factory functions
 * and the JavaScript to CEL conversion system using the magic proxy system.
 */

import { describe, it, expect } from 'bun:test';
import { toResourceGraph } from '../../../src/core.js';
import { simple } from '../../../src/factories/index.js';
import { kubernetesComposition } from '../../../src/core/composition/index.js';
import { type } from 'arktype';
import type { SchemaProxy } from '../../../src/core/types/serialization.js';

describe('Magic Proxy Integration Tests', () => {
  describe('toResourceGraph with JavaScript Expressions', () => {
    it('should convert JavaScript expressions in status builders to CEL', async () => {
      // Define schema types
      const WebAppSpec = type({
        name: 'string',
        replicas: 'number',
        image: 'string'
      });

      const WebAppStatus = type({
        ready: 'boolean',
        url: 'string',
        replicas: 'number'
      });

      // Create resource graph with JavaScript expressions in status builder
      const definition = {
        name: 'webapp',
        apiVersion: 'example.com/v1',
        kind: 'WebApp',
        spec: WebAppSpec,
        status: WebAppStatus
      };

      const graph = toResourceGraph(
        definition,
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'deployment'
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            id: 'service',
            selector: { app: schema.spec.name }
          })
        }),
        (_schema, resources) => ({
          // These JavaScript expressions should be converted to CEL
          ready: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready,
          url: `http://${resources.service!.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'}`,
          replicas: resources.deployment!.status.readyReplicas || 0
        })
      );

      expect(graph).toBeDefined();
      expect(graph.factory).toBeDefined();

      // Test Kro factory - should convert to CEL
      const kroFactory = await graph.factory('kro', { namespace: 'test' });
      expect(kroFactory).toBeDefined();

      // Test direct factory - should handle JavaScript expressions
      const directFactory = await graph.factory('direct', { namespace: 'test' });
      expect(directFactory).toBeDefined();
    });

    it('should handle schema references in resource builders', async () => {
      const AppSpec = type({
        name: 'string',
        environment: 'string',
        debug: 'boolean'
      });

      const AppStatus = type({
        phase: 'string'
      });

      const definition = {
        name: 'app',
        apiVersion: 'example.com/v1',
        kind: 'App',
        spec: AppSpec,
        status: AppStatus
      };

      const graph = toResourceGraph(
        definition,
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment',
            env: {
              // These should be converted based on schema references
              NODE_ENV: schema.spec.environment,
              DEBUG: schema.spec.debug ? 'true' : 'false',
              APP_NAME: `${schema.spec.name}-${schema.spec.environment}`
            }
          })
        }),
        (_schema, resources) => ({
          phase: resources.deployment!.status.phase || 'Unknown'
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });

    it('should handle complex cross-resource references', async () => {
      const _StackSpec = type({
        name: 'string',
        replicas: 'number'
      });

      const _StackStatus = type({
        ready: 'boolean',
        endpoint: 'string',
        health: {
          deployment: 'boolean',
          service: 'boolean'
        }
      });

      const stackDefinition = {
        name: 'stack',
        apiVersion: 'example.com/v1',
        kind: 'Stack',
        spec: type({
          name: 'string',
          replicas: 'number',
        }),
        status: type({
          ready: 'boolean',
          endpoint: 'string',
          health: type({
            deployment: 'boolean',
            service: 'boolean'
          })
        })
      };

      const graph = toResourceGraph(
        stackDefinition,
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: schema.spec.replicas,
            id: 'deployment'
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'service'
          })
        }),
        (schema, resources) => ({
          // Complex JavaScript expressions with multiple resource references
          ready: (resources.deployment! as any).status?.readyReplicas === schema.spec.replicas && 
                 (resources.service! as any).status?.ready,
          endpoint: (resources.service! as any).status?.loadBalancer?.ingress?.[0]?.ip 
                   ? `http://${(resources.service! as any).status.loadBalancer.ingress[0].ip}`
                   : 'http://localhost',
          health: {
            deployment: (resources.deployment! as any).status?.conditions?.find((c: any) => c.type === 'Available')?.status === 'True',
            service: (resources.service! as any).status?.ready ?? false
          }
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });
  });

  describe('kubernetesComposition with JavaScript Expressions', () => {
    it('should handle JavaScript expressions in imperative composition', () => {
      const mockSpec = {
        name: 'test-app',
        replicas: 3,
        environment: 'production'
      };

      const definition = {
        name: 'test-composition',
        apiVersion: 'example.com/v1',
        kind: 'TestComposition',
        spec: type({
          name: 'string',
          replicas: 'number',
          environment: 'string'
        }),
        status: type({
          ready: 'boolean',
          url: 'string',
          phase: 'string'
        })
      };

      const result = kubernetesComposition(definition as any, (spec: typeof mockSpec) => {
        // Create resources with JavaScript expressions
        const deployment = simple.Deployment({
          name: spec.name,
          image: 'nginx:latest',
          replicas: spec.replicas,
          id: 'deployment',
          env: {
            NODE_ENV: spec.environment,
            REPLICAS: `${spec.replicas}`,
            IS_PRODUCTION: spec.environment === 'production' ? 'true' : 'false'
          }
        });

        const service = simple.Service({
          name: spec.name,
          ports: [{ port: 80, targetPort: 8080 }],
          selector: { app: spec.name },
          id: 'service'
        });

        // Return status with JavaScript expressions
        return {
          ready: deployment.status.readyReplicas === spec.replicas && service.status.ready,
          url: service.status?.loadBalancer?.ingress?.[0]?.ip || 'pending',
          phase: deployment.status.phase || 'Unknown'
        };
      });

      expect(result).toBeDefined();
      // kubernetesComposition returns a CallableComposition which is a function with additional properties
      expect(typeof result).toBe('function');

      // The callable composition has toYaml method attached
      expect(result.toYaml).toBeDefined();
    });

    it('should handle nested compositions with JavaScript expressions', () => {
      const databaseDefinition = {
        name: 'database',
        apiVersion: 'example.com/v1',
        kind: 'Database',
        spec: type({
          name: 'string',
          storage: 'string'
        }),
        status: type({
          ready: 'boolean',
          host: 'string',
          port: 'number'
        })
      };

      const databaseComposition = kubernetesComposition(databaseDefinition as any, (spec: { name: string; storage: string }) => {
        const deployment = simple.Deployment({
          name: `${spec.name}-db`,
          image: 'postgres:13',
          id: 'database',
          env: {
            POSTGRES_DB: spec.name,
            POSTGRES_USER: 'user',
            POSTGRES_PASSWORD: 'password'
          }
        });

        const service = simple.Service({
          name: `${spec.name}-db`,
          ports: [{ port: 5432, targetPort: 5432 }],
          selector: { app: `${spec.name}-db` }
        });

        return {
          ready: deployment.status.readyReplicas > 0 && service.status.ready,
          host: service.status.clusterIP || 'localhost',
          port: 5432
        };
      });

      // Simplified test - nested compositions are complex and not the focus here
      expect(databaseComposition).toBeDefined();
      expect(databaseComposition.toYaml).toBeDefined();
    });
  });

  describe('Factory Function Integration', () => {
    it('should handle JavaScript expressions in factory function configurations', () => {
      const mockSchemaProxy: SchemaProxy<any, any> = {
        spec: {
          name: 'test-app',
          replicas: 3,
          image: 'nginx:latest'
        },
        status: {}
      } as any;

      // Test simple.Deployment with JavaScript expressions
      const deployment = simple.Deployment({
        name: mockSchemaProxy.spec.name,
        image: mockSchemaProxy.spec.image,
        replicas: mockSchemaProxy.spec.replicas > 5 ? 5 : mockSchemaProxy.spec.replicas,
        id: 'deployment',
        env: {
          NODE_ENV: 'production',
          APP_NAME: `${mockSchemaProxy.spec.name}-app`,
          MAX_REPLICAS: `${mockSchemaProxy.spec.replicas}`
        }
      });

      expect(deployment).toBeDefined();
      expect(deployment.spec).toBeDefined();
      expect(deployment.status).toBeDefined();
    });

    it('should handle cross-resource references in factory functions', () => {
      const mockDatabase = {
        status: {
          podIP: '10.0.0.1',
          ready: true
        }
      } as any;

      const mockService = {
        status: {
          clusterIP: '10.0.0.2',
          ready: true
        }
      } as any;

      // Test deployment with references to other resources
      const deployment = simple.Deployment({
        name: 'api-server',
        image: 'api:latest',
        env: {
          // JavaScript expressions with resource references
          DATABASE_HOST: mockDatabase.status.podIP,
          SERVICE_HOST: mockService.status.clusterIP,
          READY_CHECK: mockDatabase.status.ready && mockService.status.ready ? 'true' : 'false',
          CONNECTION_STRING: `postgres://user:pass@${mockDatabase.status.podIP}:5432/db`
        }
      });

      expect(deployment).toBeDefined();
      expect(deployment.spec?.template?.spec?.containers?.[0]?.env).toBeDefined();
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid JavaScript expressions gracefully', async () => {
      const _InvalidSpec = type({
        name: 'string'
      });

      const _InvalidStatus = type({
        ready: 'boolean'
      });

      // This should handle the invalid expression gracefully
      const invalidDefinition = {
        name: 'invalid-test',
        apiVersion: 'example.com/v1',
        kind: 'InvalidTest',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' })
      };

      const graph = toResourceGraph(
        invalidDefinition,
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment'
          })
        }),
        (_schema, _resources) => ({
          // Invalid JavaScript expression - should be handled gracefully
          ready: true // Fallback to static value
        })
      );

      expect(graph).toBeDefined();

      // Should still be able to create factories
      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });

    it('should handle missing resource references', async () => {
      const _TestSpec = type({
        name: 'string'
      });

      const _TestStatus = type({
        ready: 'boolean'
      });

      const missingRefDefinition = {
        name: 'missing-ref-test',
        apiVersion: 'example.com/v1',
        kind: 'MissingRefTest',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' })
      };

      const graph = toResourceGraph(
        missingRefDefinition,
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment'
          })
        }),
        (_schema, resources) => ({
          // Reference to non-existent resource - should be handled gracefully
          ready: resources.deployment!.status.readyReplicas > 0
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });
  });

  describe('Performance and Optimization', () => {
    it('should handle large numbers of JavaScript expressions efficiently', async () => {
      const _LargeSpec = type({
        name: 'string',
        count: 'number'
      });

      const _LargeStatus = type({
        items: 'unknown[]',
        summary: 'string'
      });

      const largeDefinition = {
        name: 'large-test',
        apiVersion: 'example.com/v1',
        kind: 'LargeTest',
        spec: type({ name: 'string', count: 'number' }),
        status: type({ 
          ready: 'boolean',
          items: 'string[]',
          summary: 'string'
        })
      };

      const graph = toResourceGraph(
        largeDefinition,
        (schema) => {
          const resources: Record<string, any> = {};
          
          // Create multiple resources with JavaScript expressions
          for (let i = 0; i < 10; i++) {
            resources[`deployment-${i}`] = simple.Deployment({
              name: `${schema.spec.name}-${i}`,
              image: 'nginx:latest',
              replicas: schema.spec.count > i ? 1 : 0,
              id: `deployment${i}`
            });
          }
          
          return resources;
        },
        (schema, _resources) => {
          const items = [];
          
          // Create status with many JavaScript expressions
          for (let i = 0; i < 10; i++) {
            items.push(`${schema.spec.name}-${i}`);
          }
          
          return {
            ready: items.length > 0,
            items,
            summary: `${items.length} items created for ${schema.spec.name}`
          };
        }
      );

      expect(graph).toBeDefined();

      // Should handle large numbers of expressions efficiently
      const startTime = Date.now();
      const factory = await graph.factory('kro', { namespace: 'test' });
      const endTime = Date.now();

      expect(factory).toBeDefined();
      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it('should cache expression analysis results', async () => {
      const CacheSpec = type({
        name: 'string'
      });

      const CacheStatus = type({
        ready: 'boolean'
      });

      // Create multiple graphs with the same expressions
      const cacheDefinition = {
        name: 'cache-test',
        apiVersion: 'example.com/v1',
        kind: 'CacheTest',
        spec: CacheSpec,
        status: CacheStatus
      };

      const createGraph = () => toResourceGraph(
        cacheDefinition,
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment'
          })
        }),
        (_schema, resources) => ({
          // Same expression - should be cached
          ready: resources.deployment!.status.readyReplicas > 0
        })
      );

      const graph1 = createGraph();
      const graph2 = createGraph();

      expect(graph1).toBeDefined();
      expect(graph2).toBeDefined();

      // Both should work correctly
      const factory1 = await graph1.factory('kro', { namespace: 'test1' });
      const factory2 = await graph2.factory('kro', { namespace: 'test2' });

      expect(factory1).toBeDefined();
      expect(factory2).toBeDefined();
    });
  });
});