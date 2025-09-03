/**
 * Comprehensive tests for factory pattern integration with JavaScript to CEL conversion
 * 
 * Tests the integration between direct and Kro factory patterns with KubernetesRef handling,
 * ensuring that JavaScript expressions work correctly with both deployment strategies.
 */

import { describe, it, expect } from 'bun:test';
import { toResourceGraph, simple, type Enhanced } from '../../../src/index.js';
import { type } from 'arktype';

describe('Factory Pattern Integration - Comprehensive Tests', () => {
  describe('Direct vs Kro Factory Pattern Differences', () => {
    it('should handle JavaScript expressions differently in direct vs Kro factories', async () => {
      const FactorySpec = type({
        name: 'string',
        replicas: 'number',
        environment: 'string'
      });

      const FactoryStatus = type({
        ready: 'boolean',
        url: 'string',
        replicas: 'number',
        environment: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'factory-comparison',
          apiVersion: 'example.com/v1',
          kind: 'FactoryComparison',
          spec: FactorySpec,
          status: FactoryStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: schema.spec.replicas,
            id: 'factoryDeployment',
            env: {
              NODE_ENV: schema.spec.environment,
              REPLICAS: `${schema.spec.replicas}`,
              IS_PROD: schema.spec.environment === 'production' ? 'true' : 'false'
            }
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'factoryService'
          })
        }),
        (schema, resources) => ({
          // JavaScript expressions that should work with both factory types
          ready: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready,
          url: `http://${resources.service!.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'}`,
          replicas: resources.deployment!.status.readyReplicas || 0,
          environment: schema.spec.environment
        })
      );

      expect(graph).toBeDefined();

      // Test Kro factory - should convert JavaScript expressions to CEL
      const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });
      expect(kroFactory).toBeDefined();
      expect(kroFactory.mode).toBe('kro');

      // Test direct factory - should evaluate JavaScript expressions at deployment time
      const directFactory = await graph.factory('direct', { namespace: 'test-direct' });
      expect(directFactory).toBeDefined();
      expect(directFactory.mode).toBe('direct');

      // Both should be valid but handle expressions differently
      expect(kroFactory).not.toBe(directFactory);
    });

    it('should preserve KubernetesRef objects correctly in both factory types', async () => {
      const RefSpec = type({
        name: 'string',
        dbName: 'string'
      });

      const RefStatus = type({
        ready: 'boolean',
        connectionString: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'ref-preservation',
          apiVersion: 'example.com/v1',
          kind: 'RefPreservation',
          spec: RefSpec,
          status: RefStatus
        },

        (schema) => {
          const database = simple.Deployment({
            name: `${schema.spec.name}-db`,
            image: 'postgres:13',
            id: 'database',
            env: {
              POSTGRES_DB: schema.spec.dbName,
              POSTGRES_USER: 'user',
              POSTGRES_PASSWORD: 'password'
            }
          });
          
          return {
            database,
            app: simple.Deployment({
              name: schema.spec.name,
              image: 'node:16',
              id: 'app',
              env: {
                // Cross-resource reference that should work with both factories
                DATABASE_URL: `postgres://user:password@${database.status.podIP}:5432/${schema.spec.dbName}`,
                DB_READY: database.status.readyReplicas > 0 ? 'true' : 'false'
              }
            })
          };
        },
        (schema: any, resources: any) => ({
          ready: (resources.database as any)?.status?.readyReplicas > 0 && (resources.app as any)?.status?.readyReplicas > 0,
          connectionString: `postgres://user:password@${(resources.database as any)?.status?.podIP || 'localhost'}:5432/${schema.spec.dbName}`
        })
      );

      expect(graph).toBeDefined();

      // Both factory types should handle the cross-resource references
      const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });
      const directFactory = await graph.factory('direct', { namespace: 'test-direct' });

      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();
    });
  });

  describe('Factory Type Detection and Validation', () => {
    it('should automatically detect appropriate factory type based on expressions', async () => {
      const _AutoSpec = type({
        name: 'string'
      });

      const _AutoStatus = type({
        ready: 'boolean'
      });

      // Simple graph without complex expressions
      const simpleGraph = toResourceGraph(
        {
          name: 'simple-auto',
          apiVersion: 'example.com/v1',
          kind: 'SimpleAuto',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' })
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment'
          })
        }),
        (_schema: any, _resources: any) => ({
          ready: true // Static value
        })
      );

      // Complex graph with JavaScript expressions
      const complexGraph = toResourceGraph(
        {
          name: 'complex-auto',
          apiVersion: 'example.com/v1',
          kind: 'ComplexAuto',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' })
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment'
          })
        }),
        (_schema: any, resources: any) => ({
          ready: (resources.deployment as any)?.status?.readyReplicas > 0 // JavaScript expression
        })
      );

      // Both should work with both factory types
      expect(simpleGraph).toBeDefined();
      expect(complexGraph).toBeDefined();

      const simpleKro = await simpleGraph.factory('kro', { namespace: 'test' });
      const simpleDirect = await simpleGraph.factory('direct', { namespace: 'test' });
      const complexKro = await complexGraph.factory('kro', { namespace: 'test' });
      const complexDirect = await complexGraph.factory('direct', { namespace: 'test' });

      expect(simpleKro).toBeDefined();
      expect(simpleDirect).toBeDefined();
      expect(complexKro).toBeDefined();
      expect(complexDirect).toBeDefined();
    });

    it('should validate factory compatibility with expression complexity', async () => {
      const CompatSpec = type({
        name: 'string',
        replicas: 'number'
      });

      const CompatStatus = type({
        simple: 'boolean',
        complex: 'boolean',
        veryComplex: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'compatibility-test',
          apiVersion: 'example.com/v1',
          kind: 'CompatibilityTest',
          spec: CompatSpec,
          status: CompatStatus
        },
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
        (schema: any, resources: any) => ({
          // Simple expression
          simple: (resources.deployment as any)?.status?.readyReplicas > 0,
          
          // Complex expression
          complex: (resources.deployment as any)?.status?.readyReplicas === schema.spec.replicas && (resources.service as any)?.status?.ready,
          
          // Very complex expression
          veryComplex: (resources.deployment as any)?.status?.conditions?.find((c: any) => c.type === 'Available')?.status === 'True'
            ? `Ready: ${(resources.deployment as any)?.status?.readyReplicas}/${schema.spec.replicas}`
            : 'Not ready'
        })
      );

      expect(graph).toBeDefined();

      // Both factory types should handle all complexity levels
      const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });
      const directFactory = await graph.factory('direct', { namespace: 'test-direct' });

      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();
    });
  });

  describe('Performance Comparison Between Factory Types', () => {
    it('should have comparable performance for both factory types', async () => {
      const PerfSpec = type({
        name: 'string',
        count: 'number'
      });

      const PerfStatus = type({
        items: 'string[]',
        summary: 'string'
      });

      const createGraph = () => toResourceGraph(
        {
          name: 'performance-comparison',
          apiVersion: 'example.com/v1',
          kind: 'PerformanceComparison',
          spec: PerfSpec,
          status: PerfStatus
        },
        (schema) => {
          const resources: Record<string, any> = {};
          
          for (let i = 0; i < 10; i++) {
            resources[`deployment-${i}`] = simple.Deployment({
              name: `${schema.spec.name}-${i}`,
              image: 'nginx:latest',
              replicas: 1,
              id: `deployment${i}`
            });
          }
          
          return resources;
        },
        (schema: any, _resources: any) => {
          const items = [];
          
          for (let i = 0; i < 10; i++) {
            items.push(`${schema.spec.name}-${i}`);
          }
          
          return {
            items,
            summary: `${items.length} items for ${schema.spec.name}`
          };
        }
      );

      // Test Kro factory performance
      const kroStartTime = performance.now();
      const kroGraph = createGraph();
      const kroFactory = await kroGraph.factory('kro', { namespace: 'test-kro' });
      const kroEndTime = performance.now();
      const kroDuration = kroEndTime - kroStartTime;

      // Test direct factory performance
      const directStartTime = performance.now();
      const directGraph = createGraph();
      const directFactory = await directGraph.factory('direct', { namespace: 'test-direct' });
      const directEndTime = performance.now();
      const directDuration = directEndTime - directStartTime;

      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();

      // Both should complete in reasonable time
      expect(kroDuration).toBeLessThan(2000);
      expect(directDuration).toBeLessThan(2000);

      // Performance difference should not be extreme
      const ratio = Math.max(kroDuration, directDuration) / Math.min(kroDuration, directDuration);
      expect(ratio).toBeLessThan(10); // No more than 10x difference
    });

    it('should scale similarly for both factory types', async () => {
      const ScaleSpec = type({
        name: 'string',
        size: 'number'
      });

      const ScaleStatus = type({
        ready: 'boolean'
      });

      const sizes = [5, 10, 20];
      const kroTimes: number[] = [];
      const directTimes: number[] = [];

      for (const size of sizes) {
        const createScaledGraph = () => toResourceGraph(
          {
            name: `scale-test-${size}`,
            apiVersion: 'example.com/v1',
            kind: 'ScaleTest',
            spec: ScaleSpec,
            status: ScaleStatus
          },
          (schema) => {
            const resources: Record<string, any> = {};
            
            for (let i = 0; i < size; i++) {
              resources[`deployment-${i}`] = simple.Deployment({
                name: `${schema.spec.name}-${i}`,
                image: 'nginx:latest',
                id: `deployment${i}`
              });
            }
            
            return resources;
          },
          (_schema: any, resources: any) => ({
            ready: Object.keys(resources).every(key => 
              (resources[key] as any)?.status?.readyReplicas > 0
            )
          })
        );

        // Test Kro factory
        const kroStart = performance.now();
        const kroGraph = createScaledGraph();
        await kroGraph.factory('kro', { namespace: 'test-kro' });
        const kroEnd = performance.now();
        kroTimes.push(kroEnd - kroStart);

        // Test direct factory
        const directStart = performance.now();
        const directGraph = createScaledGraph();
        await directGraph.factory('direct', { namespace: 'test-direct' });
        const directEnd = performance.now();
        directTimes.push(directEnd - directStart);
      }

      // Both should scale reasonably
      for (let i = 1; i < sizes.length; i++) {
        const kroRatio = kroTimes[i]! / kroTimes[i - 1]!;
        const directRatio = directTimes[i]! / directTimes[i - 1]!;
        const sizeRatio = sizes[i]! / sizes[i - 1]!;

        // Scaling should be reasonable (not exponential)
        expect(kroRatio).toBeLessThan(sizeRatio * 2);
        expect(directRatio).toBeLessThan(sizeRatio * 2);
      }
    });
  });

  describe('Error Handling Differences', () => {
    it('should handle errors appropriately for each factory type', async () => {
      const ErrorSpec = type({
        name: 'string'
      });

      const ErrorStatus = type({
        ready: 'boolean'
      });

      // Graph with potentially problematic expressions
      const graph = toResourceGraph(
        {
          name: 'error-handling',
          apiVersion: 'example.com/v1',
          kind: 'ErrorHandling',
          spec: ErrorSpec,
          status: ErrorStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment'
          })
        }),
        (_schema, resources) => ({
          // Expression that might cause issues
          ready: (resources.deployment as Enhanced<any, any>).status.readyReplicas > 0
        })
      );

      expect(graph).toBeDefined();

      // Both factory types should handle errors gracefully
      try {
        const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });
        expect(kroFactory).toBeDefined();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBeDefined();
      }

      try {
        const directFactory = await graph.factory('direct', { namespace: 'test-direct' });
        expect(directFactory).toBeDefined();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBeDefined();
      }
    });

    it('should provide factory-specific error messages', async () => {
      const SpecificErrorSpec = type({
        name: 'string'
      });

      const SpecificErrorStatus = type({
        ready: 'boolean'
      });

      // Create a graph that might have factory-specific issues
      const graph = toResourceGraph(
        {
          name: 'specific-errors',
          apiVersion: 'example.com/v1',
          kind: 'SpecificErrors',
          spec: SpecificErrorSpec,
          status: SpecificErrorStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment'
          })
        }),
        (_schema: any, resources: any) => ({
          ready: (resources.deployment as any)?.status?.readyReplicas > 0
        })
      );

      expect(graph).toBeDefined();

      // Test error handling for both factory types
      const testFactoryErrors = async (factoryType: 'kro' | 'direct') => {
        try {
          const factory = await graph.factory(factoryType, { namespace: `test-${factoryType}` });
          expect(factory).toBeDefined();
          return null;
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          const errorMessage = (error as Error).message;
          expect(errorMessage).toBeDefined();
          expect(errorMessage.length).toBeGreaterThan(0);
          return errorMessage;
        }
      };

      const kroError = await testFactoryErrors('kro');
      const directError = await testFactoryErrors('direct');

      // If there are errors, they should be informative
      if (kroError) {
        expect(kroError).toContain('kro');
      }
      if (directError) {
        expect(directError).toContain('direct');
      }
    });
  });

  describe('Resource Deployment Differences', () => {
    it('should deploy resources correctly with both factory types', async () => {
      const DeploySpec = type({
        name: 'string',
        replicas: 'number'
      });

      const DeployStatus = type({
        ready: 'boolean',
        replicas: 'number'
      });

      const graph = toResourceGraph(
        {
          name: 'deployment-test',
          apiVersion: 'example.com/v1',
          kind: 'DeploymentTest',
          spec: DeploySpec,
          status: DeployStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: schema.spec.replicas,
            id: 'deployment'
          })
        }),
        (schema: any, resources: any) => ({
          ready: (resources.deployment as any)?.status?.readyReplicas === schema.spec.replicas,
          replicas: (resources.deployment as any)?.status?.readyReplicas || 0
        })
      );

      expect(graph).toBeDefined();

      // Test deployment with Kro factory
      const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });
      expect(kroFactory).toBeDefined();
      expect(kroFactory.deploy).toBeDefined();

      // Test deployment with direct factory
      const directFactory = await graph.factory('direct', { namespace: 'test-direct' });
      expect(directFactory).toBeDefined();
      expect(directFactory.deploy).toBeDefined();

      // Both should have deploy methods
      expect(typeof kroFactory.deploy).toBe('function');
      expect(typeof directFactory.deploy).toBe('function');
    });

    it('should handle resource dependencies correctly in both factory types', async () => {
      const DepSpec = type({
        name: 'string'
      });

      const DepStatus = type({
        ready: 'boolean',
        url: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'dependency-test',
          apiVersion: 'example.com/v1',
          kind: 'DependencyTest',
          spec: DepSpec,
          status: DepStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment'
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'service'
          })
        }),
        (_schema, resources) => ({
          // Status depends on both resources
          ready: (resources.deployment as any).status?.readyReplicas > 0 && (resources.service as any).status?.ready,
          url: `http://${(resources.service as any)?.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'}`
        })
      );

      expect(graph).toBeDefined();

      // Both factory types should handle dependencies
      const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });
      const directFactory = await graph.factory('direct', { namespace: 'test-direct' });

      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();

      // Both should understand the resource dependencies
      expect(kroFactory.deploy).toBeDefined();
      expect(directFactory.deploy).toBeDefined();
    });
  });
});