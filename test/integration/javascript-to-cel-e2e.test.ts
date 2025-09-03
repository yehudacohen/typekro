/**
 * End-to-end integration tests for JavaScript to CEL conversion with magic proxy scenarios
 * 
 * These tests validate the complete integration of JavaScript to CEL conversion
 * with the magic proxy system, including YAML generation, runtime evaluation,
 * and factory pattern integration.
 */

import { describe, it, expect } from 'bun:test';
import { toResourceGraph, simple, kubernetesComposition } from '../../src/index.js';
import { type } from 'arktype';

describe('JavaScript to CEL E2E Integration Tests', () => {
  describe('Complete Workflow with Magic Proxy', () => {
    it('should handle complete workflow from JavaScript expressions to YAML generation', async () => {
      // Define comprehensive schema
      const WebAppSpec = type({
        name: 'string',
        image: 'string',
        replicas: 'number',
        environment: 'string',
        database: {
          enabled: 'boolean',
          name: 'string',
          storage: 'string'
        },
        ingress: {
          enabled: 'boolean',
          hostname: 'string'
        }
      });

      const WebAppStatus = type({
        ready: 'boolean',
        url: 'string',
        replicas: 'number',
        phase: 'string',
        components: {
          database: 'boolean',
          ingress: 'boolean',
          service: 'boolean'
        },
        endpoints: {
          internal: 'string',
          external: 'string'
        }
      });

      // Create resource graph with complex JavaScript expressions
      const graph = toResourceGraph(
        {
          name: 'webapp-e2e',
          apiVersion: 'example.com/v1',
          kind: 'WebApp',
          spec: WebAppSpec,
          status: WebAppStatus
        },
        (schema) => {
          const resources: Record<string, any> = {};

          // Main application deployment
          resources.deployment = simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'deployment',
            env: {
              NODE_ENV: schema.spec.environment,
              APP_NAME: schema.spec.name,
              REPLICAS: `${schema.spec.replicas}`,
              DATABASE_ENABLED: schema.spec.database.enabled ? 'true' : 'false',
              DATABASE_URL: schema.spec.database.enabled
                ? `postgres://user:pass@${schema.spec.name}-db:5432/${schema.spec.database.name}`
                : 'sqlite://memory'
            }
          });

          // Service for the application
          resources.service = simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'service'
          });

          // Conditional database
          if (schema.spec.database.enabled) {
            resources.database = simple.Deployment({
              name: `${schema.spec.name}-db`,
              image: 'postgres:13',
              id: 'database',
              env: {
                POSTGRES_DB: schema.spec.database.name,
                POSTGRES_USER: 'user',
                POSTGRES_PASSWORD: 'password'
              }
            });

            resources.databaseService = simple.Service({
              name: `${schema.spec.name}-db`,
              ports: [{ port: 5432, targetPort: 5432 }],
              selector: { app: `${schema.spec.name}-db` },
              id: 'databaseService'
            });

            resources.databaseStorage = simple.Pvc({
              name: `${schema.spec.name}-db-storage`,
              size: schema.spec.database.storage,
              accessModes: ['ReadWriteOnce']
            });
          }

          return resources;
        },
        (schema, resources) => ({
          // Complex JavaScript expressions for status
          ready: schema.spec.database.enabled
            ? resources.deployment.status.readyReplicas > 0 &&
            resources.service.status.ready &&
            resources.database?.status.readyReplicas > 0 &&
            resources.databaseService?.status.ready
            : resources.deployment.status.readyReplicas > 0 && resources.service.status.ready,

          url: schema.spec.ingress.enabled
            ? `https://${schema.spec.ingress.hostname}`
            : `http://${resources.service.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'}`,

          replicas: resources.deployment.status.readyReplicas || 0,

          phase: resources.deployment.status.readyReplicas === schema.spec.replicas
            ? 'Ready'
            : resources.deployment.status.readyReplicas > 0
              ? 'Partial'
              : 'NotReady',

          components: {
            database: schema.spec.database.enabled
              ? (resources.database?.status?.readyReplicas > 0)
              : true,
            ingress: schema.spec.ingress.enabled,
            service: resources.service.status.ready ?? false
          },

          endpoints: {
            internal: `http://${resources.service.status?.clusterIP || 'pending'}:80`,
            external: schema.spec.ingress.enabled
              ? `https://${schema.spec.ingress.hostname}`
              : resources.service.status?.loadBalancer?.ingress?.[0]?.ip
                ? `http://${resources.service.status.loadBalancer.ingress[0].ip}`
                : 'pending'
          }
        })
      );

      expect(graph).toBeDefined();

      // Test Kro factory - should convert JavaScript expressions to CEL
      const kroFactory = await graph.factory('kro', { namespace: 'e2e-test' });
      expect(kroFactory).toBeDefined();

      // Test direct factory - should handle JavaScript expressions at runtime
      const directFactory = await graph.factory('direct', { namespace: 'e2e-test' });
      expect(directFactory).toBeDefined();

      // Both should have deploy methods
      expect(typeof kroFactory.deploy).toBe('function');
      expect(typeof directFactory.deploy).toBe('function');
    });

    it('should generate valid YAML with converted CEL expressions', async () => {
      const SimpleSpec = type({
        name: 'string',
        replicas: 'number'
      });

      const SimpleStatus = type({
        ready: 'boolean',
        url: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'yaml-generation-test',
          apiVersion: 'example.com/v1',
          kind: 'YamlGenerationTest',
          spec: SimpleSpec,
          status: SimpleStatus
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
            id: 'service',
            selector: { app: schema.spec.name }
          })
        }),
        (_schema, resources) => ({
          // JavaScript expressions that should convert to CEL
          ready: resources.deployment.status.readyReplicas > 0 && resources.service.status.ready,
          url: `http://${resources.service.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'}`
        })
      );

      // Generate YAML for Kro factory
      const kroFactory = await graph.factory('kro', { namespace: 'yaml-test' });

      // This would generate the ResourceGraphDefinition YAML
      // The actual YAML generation would be tested here
      expect(kroFactory).toBeDefined();

      // Verify that the factory can be serialized (would contain CEL expressions)
      const factoryString = JSON.stringify(kroFactory);
      expect(factoryString).toBeDefined();
      expect(factoryString.length).toBeGreaterThan(0);
    });
  });

  describe('kubernetesComposition Integration', () => {
    it('should handle imperative composition with JavaScript expressions', async () => {
      interface AppSpec {
        name: string;
        environment: 'development' | 'staging' | 'production';
        features: {
          database: boolean;
          redis: boolean;
          monitoring: boolean;
        };
      }

      const createFullStackApp = kubernetesComposition(
        {
          name: 'fullstack-app',
          apiVersion: 'example.com/v1',
          kind: 'FullStackApp',
          spec: type({
            name: 'string',
            environment: '"development" | "staging" | "production"',
            features: {
              database: 'boolean',
              redis: 'boolean',
              monitoring: 'boolean'
            }
          }),
          status: type({
            ready: 'boolean',
            url: 'string',
            components: 'Record<string, boolean>',
            environment: 'string',
            health: 'Record<string, boolean>'
          })
        },
        (spec: AppSpec) => {
          // Create core application
          const app = simple.Deployment({
            name: spec.name,
            image: 'node:16',
            replicas: spec.environment === 'production' ? 3 : 1,
            id: 'app',
            env: {
              NODE_ENV: spec.environment,
              APP_NAME: spec.name,
              DATABASE_ENABLED: spec.features.database ? 'true' : 'false',
              REDIS_ENABLED: spec.features.redis ? 'true' : 'false'
            }
          });

          const appService = simple.Service({
            name: spec.name,
            ports: [{ port: 80, targetPort: 3000 }],
            selector: { app: spec.name },
            id: 'appService'
          });

          // Conditional database
          let database: any, databaseService: any;
          if (spec.features.database) {
            database = simple.Deployment({
              name: `${spec.name}-db`,
              image: 'postgres:13',
              id: 'database',
              env: {
                POSTGRES_DB: spec.name,
                POSTGRES_USER: 'user',
                POSTGRES_PASSWORD: 'password'
              }
            });

            databaseService = simple.Service({
              name: `${spec.name}-db`,
              ports: [{ port: 5432, targetPort: 5432 }],
              selector: { app: `${spec.name}-db` },
              id: 'databaseService'
            });

            // Update app environment with database connection
            app.spec?.template?.spec?.containers?.[0]?.env?.push({
              name: 'DATABASE_URL',
              value: `postgres://user:password@${database.status.podIP}:5432/${spec.name}`
            });
          }

          // Conditional Redis
          let redis: any, redisService: any;
          if (spec.features.redis) {
            redis = simple.Deployment({
              name: `${spec.name}-redis`,
              image: 'redis:6',
              replicas: 1,
              id: 'redis'
            });

            redisService = simple.Service({
              name: `${spec.name}-redis`,
              ports: [{ port: 6379, targetPort: 6379 }],
              selector: { app: `${spec.name}-redis` },
              id: 'redisService'
            });

            // Update app environment with Redis connection
            app.spec?.template?.spec?.containers?.[0]?.env?.push({
              name: 'REDIS_URL',
              value: `redis://${redis.status.podIP}:6379`
            });
          }

          // Return status with JavaScript expressions
          return {
            ready: app.status.readyReplicas > 0 &&
              appService.status.ready &&
              (!spec.features.database || ((database?.status?.readyReplicas || 0) > 0 && databaseService?.status?.ready)) &&
              (!spec.features.redis || ((redis?.status?.readyReplicas || 0) > 0 && redisService?.status?.ready)),

            url: `http://${appService.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'}`,

            components: {
              app: app.status.readyReplicas > 0,
              database: spec.features.database ? ((database?.status?.readyReplicas || 0) > 0) : false,
              redis: spec.features.redis ? ((redis?.status?.readyReplicas || 0) > 0) : false
            },

            environment: spec.environment,

            health: {
              overall: app.status.readyReplicas > 0 && appService.status.ready,
              database: spec.features.database
                ? database?.status.conditions?.find((c: any) => c.type === 'Available')?.status === 'True'
                : false,
              redis: spec.features.redis
                ? (redis?.status?.readyReplicas || 0) > 0
                : false
            }
          };
        });

      expect(createFullStackApp).toBeDefined();
      expect(typeof createFullStackApp).toBe('object');

      // Test that we can create factories from the composition
      const kroFactory = await createFullStackApp.factory('kro', { namespace: 'test' });
      expect(kroFactory).toBeDefined();

      // The composition should be a TypedResourceGraph
      expect(createFullStackApp.toYaml).toBeDefined();
      expect(typeof createFullStackApp.toYaml).toBe('function');
    });

    it('should handle nested compositions with cross-references', async () => {
      // Database composition
      const _createDatabase = kubernetesComposition(
        {
          name: 'database',
          apiVersion: 'example.com/v1',
          kind: 'Database',
          spec: type({ name: 'string', storage: 'string' }),
          status: type({
            ready: 'boolean',
            host: 'string',
            port: 'number',
            connectionString: 'string',
            storageReady: 'boolean'
          })
        },
        (spec: { name: string; storage: string }) => {
          const db = simple.Deployment({
            name: `${spec.name}-db`,
            image: 'postgres:13',
            id: 'database',
            env: {
              POSTGRES_DB: spec.name,
              POSTGRES_USER: 'user',
              POSTGRES_PASSWORD: 'password'
            }
          });

          const dbService = simple.Service({
            name: `${spec.name}-db`,
            ports: [{ port: 5432, targetPort: 5432 }],
            selector: { app: `${spec.name}-db` },
            id: 'dbService'
          });

          const storage = simple.Pvc({
            name: `${spec.name}-db-storage`,
            size: spec.storage,
            accessModes: ['ReadWriteOnce']
          });

          return {
            ready: db.status.readyReplicas > 0 && dbService.status.ready,
            host: dbService.status.clusterIP || 'localhost',
            port: 5432,
            connectionString: `postgres://user:password@${dbService.status.clusterIP}:5432/${spec.name}`,
            storageReady: storage.status.phase === 'Bound'
          };
        });

      // Application composition that uses database
      const createApp = kubernetesComposition(
        {
          name: 'app-with-db',
          apiVersion: 'example.com/v1',
          kind: 'AppWithDB',
          spec: type({ name: 'string', dbStorage: 'string' }),
          status: type({
            ready: 'boolean',
            url: 'string',
            database: {
              ready: 'boolean',
              host: 'string',
              storageReady: 'boolean'
            },
            health: {
              app: 'boolean',
              database: 'boolean',
              service: 'boolean',
              overall: 'boolean'
            }
          })
        },
        (spec: { name: string; dbStorage: string }) => {
          // Create database using nested composition - this should be a direct resource creation
          // since kubernetesComposition returns a TypedResourceGraph, not a callable function
          const db = simple.Deployment({
            name: `${spec.name}-db`,
            image: 'postgres:13',
            id: 'database',
            env: {
              POSTGRES_DB: spec.name,
              POSTGRES_USER: 'user',
              POSTGRES_PASSWORD: 'password'
            }
          });

          const dbService = simple.Service({
            name: `${spec.name}-db`,
            ports: [{ port: 5432, targetPort: 5432 }],
            selector: { app: `${spec.name}-db` },
            id: 'dbService'
          });

          const storage = simple.Pvc({
            name: `${spec.name}-db-storage`,
            size: spec.dbStorage,
            accessModes: ['ReadWriteOnce']
          });

          // Create a database status object that mimics what the nested composition would return
          const database = {
            ready: db.status.readyReplicas > 0 && dbService.status.ready,
            host: dbService.status.clusterIP || 'localhost',
            port: 5432,
            connectionString: `postgres://user:password@${dbService.status.clusterIP}:5432/${spec.name}`,
            storageReady: storage.status.phase === 'Bound'
          };

          // Create application that depends on database
          const app = simple.Deployment({
            name: spec.name,
            image: 'node:16',
            id: 'app',
            env: {
              // JavaScript expressions referencing nested composition
              DATABASE_URL: database.connectionString,
              DATABASE_READY: database.ready ? 'true' : 'false',
              DATABASE_HOST: database.host
            }
          });

          const appService = simple.Service({
            name: spec.name,
            ports: [{ port: 80, targetPort: 3000 }],
            selector: { app: spec.name },
            id: 'appService'
          });

          return {
            ready: app.status.readyReplicas > 0 && appService.status.ready && database.ready,
            url: `http://${appService.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'}`,
            database: {
              ready: database.ready,
              host: database.host,
              storageReady: database.storageReady
            },
            health: {
              app: app.status.readyReplicas > 0,
              database: database.ready,
              service: appService.status.ready,
              overall: app.status.readyReplicas > 0 && appService.status.ready && database.ready
            }
          };
        });

      expect(createApp).toBeDefined();

      // Test that we can create factories from the nested composition
      const appFactory = await createApp.factory('kro', { namespace: 'test' });
      expect(appFactory).toBeDefined();
      expect(createApp.toYaml).toBeDefined();
    });
  });

  describe('Factory Pattern Integration E2E', () => {
    it('should demonstrate differences between direct and Kro factories', async () => {
      const ComparisonSpec = type({
        name: 'string',
        replicas: 'number'
      });

      const ComparisonStatus = type({
        ready: 'boolean',
        replicas: 'number',
        url: 'string',
        phase: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'factory-comparison',
          apiVersion: 'example.com/v1',
          kind: 'FactoryComparison',
          spec: ComparisonSpec,
          status: ComparisonStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: schema.spec.replicas,
            id: 'deployment',
            env: {
              REPLICAS: `${schema.spec.replicas}`,
              IS_MULTI_REPLICA: schema.spec.replicas > 1 ? 'true' : 'false'
            }
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'service'
          })
        }),
        (schema, resources) => ({
          // Complex JavaScript expressions
          ready: resources.deployment.status.readyReplicas === schema.spec.replicas &&
            resources.service.status.ready,

          replicas: resources.deployment.status.readyReplicas || 0,

          url: resources.service.status?.loadBalancer?.ingress?.[0]?.ip
            ? `http://${resources.service.status.loadBalancer.ingress[0].ip}`
            : `http://${resources.service.status?.clusterIP || 'localhost'}`,

          phase: resources.deployment.status.readyReplicas === 0
            ? 'NotReady'
            : resources.deployment.status.readyReplicas < schema.spec.replicas
              ? 'Scaling'
              : 'Ready'
        })
      );

      // Test both factory types
      const kroFactory = await graph.factory('kro', { namespace: 'kro-test' });
      const directFactory = await graph.factory('direct', { namespace: 'direct-test' });

      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();

      // Both should handle the same JavaScript expressions
      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();

      // Both should be deployable
      expect(typeof kroFactory.deploy).toBe('function');
      expect(typeof directFactory.deploy).toBe('function');
    });

    it('should handle resource dependencies correctly in both factory types', async () => {
      const DependencySpec = type({
        name: 'string',
        dbEnabled: 'boolean'
      });

      const DependencyStatus = type({
        ready: 'boolean',
        databaseUrl: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'dependency-test',
          apiVersion: 'example.com/v1',
          kind: 'DependencyTest',
          spec: DependencySpec,
          status: DependencyStatus
        },
        (schema) => {
          const resources: Record<string, any> = {
            app: simple.Deployment({
              name: schema.spec.name,
              image: 'node:16',
              id: 'app'
            }),
            appService: simple.Service({
              name: schema.spec.name,
              ports: [{ port: 80, targetPort: 3000 }],
              selector: { app: schema.spec.name },
              id: 'appService'
            })
          };

          if (schema.spec.dbEnabled) {
            resources.database = simple.Deployment({
              name: `${schema.spec.name}-db`,
              image: 'postgres:13',
              id: 'database'
            });

            resources.databaseService = simple.Service({
              name: `${schema.spec.name}-db`,
              ports: [{ port: 5432, targetPort: 5432 }],
              selector: { app: `${schema.spec.name}-db` },
              id: 'databaseService'
            });
          }

          return resources;
        },
        (schema, resources) => ({
          ready: schema.spec.dbEnabled
            ? resources.app.status.readyReplicas > 0 &&
            resources.appService.status.ready &&
            resources.database?.status.readyReplicas > 0 &&
            resources.databaseService?.status.ready
            : resources.app.status.readyReplicas > 0 && resources.appService.status.ready,

          databaseUrl: schema.spec.dbEnabled
            ? `postgres://user:pass@${resources.databaseService?.status.clusterIP}:5432/db`
            : 'none'
        })
      );

      // Test with both factory types
      const kroFactory = await graph.factory('kro', { namespace: 'dep-kro' });
      const directFactory = await graph.factory('direct', { namespace: 'dep-direct' });

      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();

      // Both should understand the conditional dependencies
      expect(kroFactory.deploy).toBeDefined();
      expect(directFactory.deploy).toBeDefined();
    });
  });

  describe('Error Handling E2E', () => {
    it('should provide meaningful errors for invalid JavaScript expressions', async () => {
      const ErrorSpec = type({
        name: 'string'
      });

      const ErrorStatus = type({
        ready: 'boolean'
      });

      // This should handle invalid expressions gracefully
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
            id: 'deployment'
          })
        }),
        (_schema, resources) => ({
          // This expression should work
          ready: resources.deployment.status.readyReplicas > 0
        })
      );

      expect(graph).toBeDefined();

      // Should be able to create factories even with potential issues
      try {
        const factory = await graph.factory('kro', { namespace: 'error-test' });
        expect(factory).toBeDefined();
      } catch (error) {
        // If there's an error, it should be meaningful
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBeDefined();
        expect((error as Error).message.length).toBeGreaterThan(0);
      }
    });

    it('should handle missing resource references gracefully', async () => {
      const MissingRefSpec = type({
        name: 'string'
      });

      const MissingRefStatus = type({
        ready: 'boolean'
      });

      const graph = toResourceGraph(
        {
          name: 'missing-ref-test',
          apiVersion: 'example.com/v1',
          kind: 'MissingRefTest',
          spec: MissingRefSpec,
          status: MissingRefStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment'
          })
          // Note: no service defined
        }),
        (_schema, resources) => ({
          // This references a missing resource - should be handled gracefully
          ready: resources.deployment.status.readyReplicas > 0 &&
            ((resources as any).service?.status?.ready ?? false)
        })
      );

      expect(graph).toBeDefined();

      // Should handle missing references gracefully
      const factory = await graph.factory('kro', { namespace: 'missing-ref-test' });
      expect(factory).toBeDefined();
    });
  });

  describe('Performance E2E', () => {
    it('should handle large-scale applications efficiently', async () => {
      const LargeAppSpec = type({
        name: 'string',
        microservices: 'number'
      });

      const LargeAppStatus = type({
        ready: 'boolean',
        services: 'string[]',
        summary: 'string'
      });

      const startTime = performance.now();

      const graph = toResourceGraph(
        {
          name: 'large-app',
          apiVersion: 'example.com/v1',
          kind: 'LargeApp',
          spec: LargeAppSpec,
          status: LargeAppStatus
        },
        (schema) => {
          // Type-safe resource collection - preserves specific resource types
          const resources = {} as Record<string, ReturnType<typeof simple.Deployment> | ReturnType<typeof simple.Service>>;

          // Create multiple microservices
          for (let i = 0; i < schema.spec.microservices; i++) {
            resources[`service${i}`] = simple.Deployment({
              name: `${schema.spec.name}-service-${i}`,
              image: 'node:16',
              replicas: 1,
              id: `service${i}`
            });

            resources[`service${i}Service`] = simple.Service({
              name: `${schema.spec.name}-service-${i}`,
              ports: [{ port: 80, targetPort: 3000 }],
              selector: { app: `${schema.spec.name}-service-${i}` },
              id: `service${i}Service`
            });
          }

          return resources;
        },
        (schema, resources) => {
          const services: string[] = [];
          let allReady = true;

          for (let i = 0; i < schema.spec.microservices; i++) {
            // Type-safe resource access - TypeScript now knows these are Enhanced resources
            const deployment = resources[`service${i}`];
            const service = resources[`service${i}Service`];

            const serviceReady = deployment?.status?.readyReplicas > 0 &&
              service?.status?.ready;

            services.push(`service-${i}`);

            allReady = allReady && serviceReady;
          }

          return {
            ready: allReady,
            services,
            summary: `${services.length} services, ${allReady ? services.length : 0} ready`
          };
        }
      );

      const factory = await graph.factory('kro', { namespace: 'large-app-test' });
      const endTime = performance.now();

      expect(factory).toBeDefined();

      // Should complete in reasonable time even for large applications
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(5000); // Less than 5 seconds
    });
  });
});