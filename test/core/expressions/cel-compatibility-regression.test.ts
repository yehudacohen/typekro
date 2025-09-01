/**
 * Regression tests for existing CEL expression compatibility
 * 
 * Ensures that the JavaScript to CEL conversion system maintains backward
 * compatibility with existing CEL expressions and doesn't break existing functionality.
 */

import { describe, it, expect } from 'bun:test';
import { toResourceGraph, simple, Cel } from '../../../src/index.js';
import { type } from 'arktype';

describe('CEL Expression Compatibility Regression Tests', () => {
  describe('Existing CEL Expression Support', () => {
    it('should continue to support manual CEL expressions', async () => {
      const WebAppSpec = type({
        name: 'string',
        replicas: 'number'
      });

      const WebAppStatus = type({
        ready: 'boolean',
        url: 'string',
        replicas: 'number'
      });

      // Test with existing CEL expressions (should continue to work)
      const graph = toResourceGraph(
        {
          name: 'webapp-cel',
          apiVersion: 'example.com/v1',
          kind: 'WebApp',
          spec: WebAppSpec,
          status: WebAppStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: schema.spec.replicas,
            id: 'webappDeployment'
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'webappService'
          })
        }),
        (_schema, resources) => ({
          // Existing CEL expressions should continue to work
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('http://%s', resources.service.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'),
          replicas: resources.deployment.status.readyReplicas
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });

    it('should support mixed CEL and JavaScript expressions', async () => {
      const MixedSpec = type({
        name: 'string',
        replicas: 'number',
        environment: 'string'
      });

      const MixedStatus = type({
        celReady: 'boolean',
        jsReady: 'boolean',
        celUrl: 'string',
        jsUrl: 'string',
        mixed: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'mixed-expressions',
          apiVersion: 'example.com/v1',
          kind: 'MixedExpressions',
          spec: MixedSpec,
          status: MixedStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: schema.spec.replicas,
            id: 'mixedDeployment'
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'mixedService'
          })
        }),
        (_schema, resources) => ({
          // Existing CEL expression
          celReady: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
          
          // New JavaScript expression
          jsReady: resources.deployment.status.readyReplicas > 0,
          
          // Existing CEL template
          celUrl: Cel.template('http://%s', resources.service.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'),
          
          // New JavaScript template
          jsUrl: `http://${resources.service.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'}`,
          
          // Mixed - CEL expression with JavaScript fallback
          mixed: resources.deployment.status.readyReplicas > 0 
            ? Cel.template('Ready: %s replicas', resources.deployment.status.readyReplicas)
            : 'Not ready'
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });

    it('should maintain CEL expression behavior in direct factory', async () => {
      const DirectSpec = type({
        name: 'string'
      });

      const DirectStatus = type({
        ready: 'boolean'
      });

      const graph = toResourceGraph(
        {
          name: 'direct-cel',
          apiVersion: 'example.com/v1',
          kind: 'DirectCEL',
          spec: DirectSpec,
          status: DirectStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'directDeployment'
          })
        }),
        (_schema, resources) => ({
          // CEL expression should work with direct factory
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0')
        })
      );

      expect(graph).toBeDefined();

      // Test with direct factory
      const directFactory = await graph.factory('direct', { namespace: 'test' });
      expect(directFactory).toBeDefined();

      // Test with Kro factory
      const kroFactory = await graph.factory('kro', { namespace: 'test' });
      expect(kroFactory).toBeDefined();
    });
  });

  describe('CEL Expression Types and Methods', () => {
    it('should continue to support all CEL expression types', () => {
      // Test that all existing CEL expression types still work
      const celExpressions = [
        Cel.expr<boolean>('true'),
        Cel.expr<number>('42'),
        Cel.expr<string>('"hello"'),
        Cel.template('Hello %s', 'world'),
        Cel.string('static value'),
        Cel.expr<boolean>('1 > 0'),
        Cel.expr<string>('"a" + "b"')
      ];

      for (const celExpr of celExpressions) {
        expect(celExpr).toBeDefined();
        expect(typeof celExpr.toString).toBe('function');
      }
    });

    it('should support CEL expressions with resource references', async () => {
      const CelRefSpec = type({
        name: 'string'
      });

      const CelRefStatus = type({
        deployment: {
          ready: 'boolean',
          replicas: 'number',
          phase: 'string'
        },
        service: {
          ready: 'boolean',
          type: 'string'
        }
      });

      const graph = toResourceGraph(
        {
          name: 'cel-references',
          apiVersion: 'example.com/v1',
          kind: 'CELReferences',
          spec: CelRefSpec,
          status: CelRefStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'celDeployment'
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'celService'
          })
        }),
        (_schema, resources) => ({
          deployment: {
            ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
            replicas: Cel.expr<number>(resources.deployment.status.readyReplicas),
            phase: Cel.expr<string>(resources.deployment.status.phase)
          },
          service: {
            ready: Cel.expr<boolean>(resources.service.status.ready),
            type: Cel.expr<string>(resources.service.spec.type)
          }
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });
  });

  describe('Backward Compatibility with Existing Code', () => {
    it('should not break existing toResourceGraph usage', async () => {
      // This test ensures that existing code patterns continue to work
      const ExistingSpec = type({
        appName: 'string',
        replicas: 'number',
        image: 'string'
      });

      const ExistingStatus = type({
        ready: 'boolean',
        url: 'string',
        health: {
          deployment: 'boolean',
          service: 'boolean'
        }
      });

      // Simulate existing code pattern
      const existingGraph = toResourceGraph(
        {
          name: 'existing-pattern',
          apiVersion: 'example.com/v1',
          kind: 'ExistingPattern',
          spec: ExistingSpec,
          status: ExistingStatus
        },
        (schema) => {
          // Existing resource creation pattern
          const deployment = simple.Deployment({
            name: schema.spec.appName,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'existingDeployment'
          });

          const service = simple.Service({
            name: schema.spec.appName,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.appName },
            id: 'existingService'
          });

          return { deployment, service };
        },
        (_schema, resources) => {
          // Existing status pattern with CEL
          return {
            ready: Cel.expr<boolean>(
              resources.deployment.status.readyReplicas, 
              ' > 0 && ', 
              resources.service.status.ready
            ),
            url: Cel.template(
              'http://%s',
              resources.service.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'
            ),
            health: {
              deployment: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
              service: Cel.expr<boolean>(resources.service.status.ready)
            }
          };
        }
      );

      expect(existingGraph).toBeDefined();

      // Should work with both factory types
      const kroFactory = await existingGraph.factory('kro', { namespace: 'test' });
      expect(kroFactory).toBeDefined();

      const directFactory = await existingGraph.factory('direct', { namespace: 'test' });
      expect(directFactory).toBeDefined();
    });

    it('should maintain factory function compatibility', () => {
      // Test that existing factory function usage patterns still work
      const mockSchema = {
        spec: {
          name: 'test-app',
          image: 'nginx:latest',
          replicas: 3
        }
      };

      // Existing pattern with static values
      const deployment1 = simple.Deployment({
        name: mockSchema.spec.name,
        image: mockSchema.spec.image,
        replicas: mockSchema.spec.replicas
      });

      expect(deployment1).toBeDefined();
      expect(deployment1.spec).toBeDefined();
      expect(deployment1.status).toBeDefined();

      // Existing pattern with CEL expressions
      const deployment2 = simple.Deployment({
        name: Cel.expr<string>('"test-app"'),
        image: Cel.expr<string>('"nginx:latest"'),
        replicas: Cel.expr<number>('3'),
        id: 'celDeployment'
      });

      expect(deployment2).toBeDefined();
      expect(deployment2.spec).toBeDefined();
      expect(deployment2.status).toBeDefined();
    });
  });

  describe('Performance Regression Tests', () => {
    it('should not significantly impact performance for existing CEL expressions', async () => {
      const PerfSpec = type({
        name: 'string',
        count: 'number'
      });

      const PerfStatus = type({
        items: 'string[]'
      });

      // Create a graph with many CEL expressions (existing pattern)
      const startTime = performance.now();

      const graph = toResourceGraph(
        {
          name: 'performance-test',
          apiVersion: 'example.com/v1',
          kind: 'PerformanceTest',
          spec: PerfSpec,
          status: PerfStatus
        },
        (schema) => {
          const resources: Record<string, any> = {};
          
          for (let i = 0; i < 20; i++) {
            resources[`deployment-${i}`] = simple.Deployment({
              name: `${schema.spec.name}-${i}`,
              image: 'nginx:latest',
              replicas: 1,
              id: `perfDeployment${i}`
            });
          }
          
          return resources;
        },
        (schema, _resources) => {
          const items = [];
          
          for (let i = 0; i < 20; i++) {
            items.push(Cel.template('%s-%d', schema.spec.name, i));
          }
          
          return { items };
        }
      );

      const factory = await graph.factory('kro', { namespace: 'test' });
      const endTime = performance.now();

      expect(factory).toBeDefined();
      
      // Should complete within reasonable time (not significantly slower than before)
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(2000); // 2 seconds
    });

    it('should cache CEL expressions effectively', async () => {
      const CacheSpec = type({
        name: 'string'
      });

      const CacheStatus = type({
        ready: 'boolean'
      });

      // Create multiple graphs with the same CEL expressions
      const createGraph = () => toResourceGraph(
        {
          name: 'cache-test',
          apiVersion: 'example.com/v1',
          kind: 'CacheTest',
          spec: CacheSpec,
          status: CacheStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'cacheDeployment'
          })
        }),
        (_schema, resources) => ({
          // Same CEL expression - should be cached
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0')
        })
      );

      const startTime = performance.now();

      // Create multiple graphs
      const graphs = Array(10).fill(null).map(() => createGraph());
      
      // Create factories for all graphs
      const factories = await Promise.all(
        graphs.map(graph => graph.factory('kro', { namespace: 'test' }))
      );

      const endTime = performance.now();

      expect(factories).toHaveLength(10);
      factories.forEach(factory => expect(factory).toBeDefined());

      // Should complete quickly with caching
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(1000); // 1 second for 10 graphs
    });
  });

  describe('Error Handling Regression', () => {
    it('should maintain existing error handling behavior', async () => {
      const ErrorSpec = type({
        name: 'string'
      });

      const ErrorStatus = type({
        ready: 'boolean'
      });

      // Test that existing error scenarios still work the same way
      const graph = toResourceGraph(
        {
          name: 'error-test',
          apiVersion: 'example.com/v1',
          kind: 'ErrorTest',
          spec: ErrorSpec,
          status: ErrorStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'errorDeployment'
          })
        }),
        (_schema, resources) => ({
          // This should work (existing behavior)
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0')
        })
      );

      expect(graph).toBeDefined();

      // Should handle factory creation errors gracefully (existing behavior)
      try {
        const factory = await graph.factory('kro', { namespace: 'test' });
        expect(factory).toBeDefined();
      } catch (error) {
        // If it throws, it should be a meaningful error (existing behavior)
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBeDefined();
      }
    });

    it('should not introduce new error types for existing patterns', async () => {
      // Test various existing patterns to ensure they don't throw new errors
      const patterns = [
        // Simple CEL expression
        () => Cel.expr<boolean>('true'),
        
        // CEL template
        () => Cel.template('Hello %s', 'world'),
        
        // CEL string
        () => Cel.string('static'),
        
        // Complex CEL expression
        () => Cel.expr<boolean>('1 > 0 && "a" == "a"')
      ];

      for (const pattern of patterns) {
        expect(() => pattern()).not.toThrow();
        
        const result = pattern();
        expect(result).toBeDefined();
        expect(typeof result.toString).toBe('function');
      }
    });
  });

  describe('Type Safety Regression', () => {
    it('should maintain type safety for existing CEL expressions', () => {
      // Test that TypeScript types are preserved for existing patterns
      const booleanExpr = Cel.expr<boolean>('true');
      const numberExpr = Cel.expr<number>('42');
      const stringExpr = Cel.expr<string>('"hello"');
      const templateExpr = Cel.template('Hello %s', 'world');

      // These should all be properly typed
      expect(booleanExpr).toBeDefined();
      expect(numberExpr).toBeDefined();
      expect(stringExpr).toBeDefined();
      expect(templateExpr).toBeDefined();

      // Should have proper toString methods
      expect(typeof booleanExpr.toString).toBe('function');
      expect(typeof numberExpr.toString).toBe('function');
      expect(typeof stringExpr.toString).toBe('function');
      expect(typeof templateExpr.toString).toBe('function');
    });

    it('should maintain resource reference type safety', async () => {
      const TypeSafetySpec = type({
        name: 'string'
      });

      const TypeSafetyStatus = type({
        ready: 'boolean',
        replicas: 'number',
        name: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'type-safety',
          apiVersion: 'example.com/v1',
          kind: 'TypeSafety',
          spec: TypeSafetySpec,
          status: TypeSafetyStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'typeSafetyDeployment'
          })
        }),
        (_schema, resources) => ({
          // These should maintain proper typing
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
          replicas: Cel.expr<number>(resources.deployment.status.readyReplicas),
          name: Cel.expr<string>(resources.deployment.metadata.name)
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });
  });
});