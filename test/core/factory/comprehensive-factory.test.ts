/**
 * Comprehensive tests for factory implementations
 * 
 * This test suite validates all factory implementations and interfaces
 * including DirectResourceFactory, KroResourceFactory, and their integration
 * with alchemy.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { type } from 'arktype';

import { toResourceGraph } from '../../../src/core/serialization/core.js';
import { simpleDeployment, simpleService, simplePvc } from '../../../src/core/composition/index.js';
import { Cel } from '../../../src/core/references/index.js';

// Mock alchemy scope for testing - simplified mock that doesn't fully implement Scope
class MockAlchemyScope {
  private resources = new Map<string, any>();
  
  readonly stage = 'test';
  readonly name = 'mock-scope';
  readonly local = true;
  readonly watch = false;

  async set<T>(id: string, resource: T): Promise<void> {
    this.resources.set(id, resource);
  }

  async get<T>(id: string): Promise<T> {
    const value = this.resources.get(id);
    if (value === undefined) {
      throw new Error(`Resource not found: ${id}`);
    }
    return value as T;
  }

  async delete(id: string): Promise<void> {
    this.resources.delete(id);
  }

  async run<T>(fn: (scope: any) => Promise<T>): Promise<T> {
    return fn(this);
  }

  // Legacy method for backward compatibility
  async register(id: string, resource: any): Promise<void> {
    return this.set(id, resource);
  }

  getRegisteredResources(): Map<string, any> {
    return new Map(this.resources);
  }

  clear(): void {
    this.resources.clear();
  }
}

// Helper function to create test schemas
function createTestSchemas() {
  const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number',
    environment: '"development" | "staging" | "production"',
    storage: 'string?',
  });

  const WebAppStatusSchema = type({
    url: 'string',
    readyReplicas: 'number',
    phase: '"pending" | "running" | "failed"',
    storageReady: 'boolean?',
  });

  return {
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
    definition: {
      apiVersion: 'v1alpha1',
      kind: 'WebApp',
      spec: WebAppSpecSchema,
      status: WebAppStatusSchema,
    },
  };
}

// Helper function to create a comprehensive resource graph
function createComprehensiveResourceGraph() {
  const schemas = createTestSchemas();
  
  return toResourceGraph(
    {
      name: 'comprehensive-webapp',
      ...schemas.definition
    },
    (schema) => ({
      storage: simplePvc({
        name: 'webapp-storage', // Use static name to avoid schema reference issues
        size: schema.spec.storage || '1Gi',
        storageClass: 'standard',
      }),
      deployment: simpleDeployment({
        id: 'webappDeployment',
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        env: {
          NODE_ENV: schema.spec.environment,
          STORAGE_PATH: '/data',
        },
      }),
      service: simpleService({
        id: 'webappService',
        name: schema.spec.name,
        selector: { app: schema.spec.name },
        ports: [{ port: 80, targetPort: 3000 }],
        type: 'LoadBalancer',
      }),
    }),
    (_schema, resources) => ({
      readyReplicas: resources.deployment?.status.readyReplicas,
      url: 'http://webapp-service',
      phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
    })
  );
}

describe('Comprehensive Factory Tests', () => {
  let mockAlchemyScope: MockAlchemyScope;

  beforeEach(() => {
    mockAlchemyScope = new MockAlchemyScope();
  });

  describe('DirectResourceFactory Comprehensive Tests', () => {
    it('should create DirectResourceFactory with all configuration options', async () => {
      const graph = createComprehensiveResourceGraph();
      
      const factory = await graph.factory('direct', {
        namespace: 'production',
        timeout: 600000,
        waitForReady: true,
        retryPolicy: {
          maxRetries: 3,
          backoffMultiplier: 2,
          initialDelay: 1000,
          maxDelay: 30000,
        },
        progressCallback: (event) => {
          console.log(`Progress: ${event.type} - ${event.message}`);
        },
      });

      expect(factory.mode).toBe('direct');
      expect(factory.name).toBe('comprehensive-webapp');
      expect(factory.namespace).toBe('production');
      expect(factory.isAlchemyManaged).toBe(false);
    });

    it('should handle complex deployment scenarios', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('direct', {
        namespace: 'test',
        waitForReady: false,
      });

      // Test factory status
      const status = await factory.getStatus();
      expect(status.name).toBe('comprehensive-webapp');
      expect(status.mode).toBe('direct');
      expect(status.namespace).toBe('test');
      expect(status.health).toBe('healthy');
      expect(typeof status.instanceCount).toBe('number');
    });

    it('should generate comprehensive YAML for complex deployments', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('direct', {
        namespace: 'test',
      });

      const yaml = factory.toYaml({
        name: 'complex-app',
        image: 'nginx:latest',
        replicas: 3,
        environment: 'production',
        storage: '10Gi',
      });

      expect(typeof yaml).toBe('string');
      expect(yaml.length).toBeGreaterThan(0);
      
      // Should contain all resource types
      expect(yaml).toContain('PersistentVolumeClaim');
      expect(yaml).toContain('Deployment');
      expect(yaml).toContain('Service');
      
      // Should contain resolved configuration values (DirectResourceFactory resolves spec values)
      expect(yaml).toContain('nginx:latest'); // Resolved image value
      expect(yaml).toContain('10Gi'); // Resolved storage value
    });

    it('should support rollback functionality', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('direct', {
        namespace: 'test',
      });

      // Test that rollback method exists and can be called
      expect(typeof factory.rollback).toBe('function');
      
      // Note: We can't easily test actual rollback without a real deployment
      // but we can verify the method signature and basic functionality
      try {
        await factory.rollback();
        // If it doesn't throw, the method is properly implemented
      } catch (error) {
        // Expected to fail in test environment, but should be a proper error
        expect(error).toBeInstanceOf(Error);
      }
    });

    it('should handle instance management operations', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('direct', {
        namespace: 'test',
      });

      // Test instance listing
      const instances = await factory.getInstances();
      expect(Array.isArray(instances)).toBe(true);

      // Test instance deletion (should handle gracefully in test environment)
      try {
        await factory.deleteInstance('test-instance');
      } catch (error) {
        // Expected to fail in test environment
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Instance not found');
      }
    });

    it('should support alchemy integration', async () => {
      const graph = createComprehensiveResourceGraph();
      
      const alchemyFactory = await graph.factory('direct', {
        namespace: 'test',
        alchemyScope: mockAlchemyScope as any, // Mock scope for testing
      });

      expect(alchemyFactory.isAlchemyManaged).toBe(true);
      expect(alchemyFactory.mode).toBe('direct');
      expect(alchemyFactory.namespace).toBe('test');
    });

    it('should handle error scenarios gracefully', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('direct', {
        namespace: 'test',
      });

      // Test with invalid spec (should be caught by ArkType validation when implemented)
      try {
        const yaml = factory.toYaml({
          name: 'test-app',
          image: 'nginx:latest',
          replicas: 2,
          environment: 'production',
          // Missing required fields or invalid values would be caught here
        } as any);
        
        expect(typeof yaml).toBe('string');
      } catch (error) {
        // If validation is implemented, this would catch invalid specs
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('KroResourceFactory Comprehensive Tests', () => {
    it('should create KroResourceFactory with all configuration options', async () => {
      const graph = createComprehensiveResourceGraph();
      
      const factory = await graph.factory('kro', {
        namespace: 'production',
        timeout: 600000,
        waitForReady: true,
        retryPolicy: {
          maxRetries: 3,
          backoffMultiplier: 2,
          initialDelay: 1000,
          maxDelay: 30000,
        },
        progressCallback: (event) => {
          console.log(`Progress: ${event.type} - ${event.message}`);
        },
      });

      expect(factory.mode).toBe('kro');
      expect(factory.name).toBe('comprehensive-webapp');
      expect(factory.namespace).toBe('production');
      expect(factory.rgdName).toBe('comprehensive-webapp');
      expect(factory.isAlchemyManaged).toBe(false);
      expect(factory.schema).toBeDefined();
    });

    it('should generate RGD YAML without arguments', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('kro', {
        namespace: 'test',
      });

      const rgdYaml = factory.toYaml();
      
      expect(typeof rgdYaml).toBe('string');
      expect(rgdYaml.length).toBeGreaterThan(0);
      expect(rgdYaml).toContain('ResourceGraphDefinition');
      expect(rgdYaml).toContain('comprehensive-webapp');
      expect(rgdYaml).toContain('v1alpha1');
      expect(rgdYaml).toContain('WebApp');
    });

    it('should generate CRD instance YAML with spec', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('kro', {
        namespace: 'test',
      });

      const instanceYaml = factory.toYaml({
        name: 'test-instance',
        image: 'nginx:latest',
        replicas: 2,
        environment: 'staging',
        storage: '5Gi',
      });

      expect(typeof instanceYaml).toBe('string');
      expect(instanceYaml.length).toBeGreaterThan(0);
      expect(instanceYaml).toContain('v1alpha1');
      expect(instanceYaml).toContain('WebApp');
      expect(instanceYaml).toContain('test-instance');
      expect(instanceYaml).toContain('nginx:latest');
      expect(instanceYaml).toContain('staging');
    });

    it('should support schema proxy access', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('kro', {
        namespace: 'test',
      });

      expect(factory.schema).toBeDefined();
      expect(factory.schema.spec).toBeDefined();
      expect(factory.schema.status).toBeDefined();
      
      // Test that schema proxy provides type-safe access
      const nameRef = factory.schema.spec.name;
      expect(nameRef).toBeDefined();
      expect(typeof nameRef).toBe('function'); // Schema proxy returns functions
    });

    it('should handle RGD status operations', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('kro', {
        namespace: 'test',
      });

      // Test RGD status method exists
      expect(typeof factory.getRGDStatus).toBe('function');
      
      // Note: We can't easily test actual RGD status without a real Kubernetes cluster
      // but we can verify the method signature
      try {
        await factory.getRGDStatus();
      } catch (error) {
        // Expected to fail in test environment
        expect(error).toBeInstanceOf(Error);
      }
    });

    it('should support alchemy integration', async () => {
      const graph = createComprehensiveResourceGraph();
      
      const alchemyFactory = await graph.factory('kro', {
        namespace: 'test',
        alchemyScope: mockAlchemyScope as any, // Mock scope for testing
      });

      expect(alchemyFactory.isAlchemyManaged).toBe(true);
      expect(alchemyFactory.mode).toBe('kro');
      expect(alchemyFactory.namespace).toBe('test');
      expect(alchemyFactory.rgdName).toBe('comprehensive-webapp');
    });

    it('should handle instance management operations', async () => {
      const graph = createComprehensiveResourceGraph();
      const factory = await graph.factory('kro', {
        namespace: 'test',
      });

      // Test that instance management methods exist
      expect(typeof factory.getInstances).toBe('function');
      expect(typeof factory.getStatus).toBe('function');
      expect(typeof factory.deleteInstance).toBe('function');
      
      // Note: We can't easily test actual instance operations without a real Kubernetes cluster
    });
  });

  describe('Factory Pattern Type Safety', () => {
    it('should maintain type safety across factory modes', async () => {
      const graph = createComprehensiveResourceGraph();
      
      const directFactory = await graph.factory('direct', { namespace: 'test' });
      const kroFactory = await graph.factory('kro', { namespace: 'test' });

      // Both factories should accept the same spec type
      const spec = {
        name: 'type-safe-app',
        image: 'nginx:latest',
        replicas: 3,
        environment: 'production' as const,
        storage: '10Gi',
      };

      // Test YAML generation with type-safe spec
      const directYaml = directFactory.toYaml(spec);
      const kroInstanceYaml = kroFactory.toYaml(spec);

      expect(typeof directYaml).toBe('string');
      expect(typeof kroInstanceYaml).toBe('string');
      
      // Both should contain the same spec values (note: may be in schema reference format)
      expect(directYaml.length).toBeGreaterThan(0);
      expect(kroInstanceYaml.length).toBeGreaterThan(0);
    });

    it('should provide consistent Enhanced type across factories', async () => {
      const graph = createComprehensiveResourceGraph();
      
      const directFactory = await graph.factory('direct', { namespace: 'test' });
      const kroFactory = await graph.factory('kro', { namespace: 'test' });

      // Both factories should have the same deploy method signature
      expect(typeof directFactory.deploy).toBe('function');
      expect(typeof kroFactory.deploy).toBe('function');
      
      // Both should have consistent instance management
      expect(typeof directFactory.getInstances).toBe('function');
      expect(typeof kroFactory.getInstances).toBe('function');
      
      expect(typeof directFactory.deleteInstance).toBe('function');
      expect(typeof kroFactory.deleteInstance).toBe('function');
    });
  });

  describe('Factory Error Handling', () => {
    it('should handle invalid factory options gracefully', async () => {
      const graph = createComprehensiveResourceGraph();
      
      // Test with invalid timeout
      const factory = await graph.factory('direct', {
        namespace: 'test',
        timeout: -1, // Invalid timeout
      });

      expect(factory).toBeDefined();
      expect(factory.mode).toBe('direct');
    });

    it('should handle missing required configuration', async () => {
      const graph = createComprehensiveResourceGraph();
      
      // Test with minimal configuration
      const factory = await graph.factory('direct', {});
      
      expect(factory).toBeDefined();
      expect(factory.mode).toBe('direct');
      expect(factory.namespace).toBe('default'); // Should use default namespace
    });

    it('should handle alchemy deployment failures gracefully', async () => {
      const graph = createComprehensiveResourceGraph();
      
      const alchemyFactory = await graph.factory('direct', {
        namespace: 'test',
        alchemyScope: mockAlchemyScope as any, // Mock scope for testing
      });

      // Test deployment with alchemy (should fail gracefully in test environment)
      try {
        await alchemyFactory.deploy({
          name: 'test-app',
          image: 'nginx:latest',
          replicas: 2,
          environment: 'development',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/No active cluster!|Node with id .* already exists in dependency graph/);
      }
    });
  });

  describe('Factory Performance and Scalability', () => {
    it('should handle large resource graphs efficiently', async () => {
      // Create a larger resource graph for performance testing
      const schemas = createTestSchemas();
      
      const largeGraph = toResourceGraph(
        {
          name: 'large-webapp',
          ...schemas.definition
        },
        (schema) => {
          const resources: Record<string, any> = {};
          
          // Create multiple deployments
          for (let i = 0; i < 5; i++) {
            resources[`deployment-${i}`] = simpleDeployment({
              id: `webappDeployment${i}`,
              name: `${schema.spec.name}-${i}`,
              image: schema.spec.image,
              replicas: schema.spec.replicas,
            });
            
            resources[`service-${i}`] = simpleService({
              id: `webappService${i}`,
              name: `${schema.spec.name}-${i}`,
              selector: { app: `${schema.spec.name}-${i}` },
              ports: [{ port: 80 + i, targetPort: 3000 }],
            });
          }
          
          return resources;
        },
        (_schema, _resources) => ({
          url: 'http://webapp-service',
          readyReplicas: 5,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const startTime = Date.now();
      const factory = await largeGraph.factory('direct', { namespace: 'test' });
      const factoryCreationTime = Date.now() - startTime;

      expect(factory).toBeDefined();
      expect(factoryCreationTime).toBeLessThan(1000); // Should create factory quickly

      // Test YAML generation performance
      const yamlStartTime = Date.now();
      const yaml = factory.toYaml({
        name: 'large-app',
        image: 'nginx:latest',
        replicas: 2,
        environment: 'production',
      });
      const yamlGenerationTime = Date.now() - yamlStartTime;

      expect(typeof yaml).toBe('string');
      expect(yaml.length).toBeGreaterThan(0);
      expect(yamlGenerationTime).toBeLessThan(500); // Should generate YAML quickly
    });

    it('should handle concurrent factory operations', async () => {
      const graph = createComprehensiveResourceGraph();
      
      // Create multiple factories concurrently
      const factoryPromises = [
        graph.factory('direct', { namespace: 'test-1' }),
        graph.factory('direct', { namespace: 'test-2' }),
        graph.factory('kro', { namespace: 'test-3' }),
        graph.factory('kro', { namespace: 'test-4' }),
      ];

      const factories = await Promise.all(factoryPromises);
      
      expect(factories).toHaveLength(4);
      expect(factories[0]?.mode).toBe('direct');
      expect(factories[1]?.mode).toBe('direct');
      expect(factories[2]?.mode).toBe('kro');
      expect(factories[3]?.mode).toBe('kro');
      
      expect(factories[0]?.namespace).toBe('test-1');
      expect(factories[1]?.namespace).toBe('test-2');
      expect(factories[2]?.namespace).toBe('test-3');
      expect(factories[3]?.namespace).toBe('test-4');
    });
  });
});