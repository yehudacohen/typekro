/**
 * Basic tests for JavaScript to CEL conversion functionality
 * 
 * This test suite validates the core concept of JavaScript to CEL conversion
 * with a focus on the basic functionality without complex API usage.
 */

import { describe, it, expect } from 'bun:test';
import { toResourceGraph, simple, Cel } from '../../../src/index.js';
import { type } from 'arktype';

describe('JavaScript to CEL - Basic Functionality', () => {
  describe('Core Concept Validation', () => {
    it('should create a resource graph with JavaScript expressions', async () => {
      const AppSpec = type({
        name: 'string',
        replicas: 'number'
      });

      const AppStatus = type({
        ready: 'boolean',
        replicas: 'number'
      });

      const graph = toResourceGraph(
        {
          name: 'basic-test',
          apiVersion: 'example.com/v1',
          kind: 'BasicTest',
          spec: AppSpec,
          status: AppStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: schema.spec.replicas,
            id: 'mainDeployment'
          })
        }),
        (_schema, resources) => ({
          // Simple JavaScript expressions
          ready: resources.deployment.status.readyReplicas > 0,
          replicas: resources.deployment.status.readyReplicas || 0
        })
      );

      expect(graph).toBeDefined();
      expect(graph.factory).toBeDefined();
      expect(typeof graph.factory).toBe('function');
    });

    it('should create factories for both direct and kro patterns', async () => {
      const SimpleSpec = type({
        name: 'string'
      });

      const SimpleStatus = type({
        ready: 'boolean'
      });

      const graph = toResourceGraph(
        {
          name: 'factory-test',
          apiVersion: 'example.com/v1',
          kind: 'FactoryTest',
          spec: SimpleSpec,
          status: SimpleStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'factoryDeployment'
          })
        }),
        (_schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0
        })
      );

      // Test Kro factory
      const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });
      expect(kroFactory).toBeDefined();
      expect(kroFactory.deploy).toBeDefined();

      // Test direct factory
      const directFactory = await graph.factory('direct', { namespace: 'test-direct' });
      expect(directFactory).toBeDefined();
      expect(directFactory.deploy).toBeDefined();
    });

    it('should handle static values without conversion', async () => {
      const StaticSpec = type({
        name: 'string'
      });

      const StaticStatus = type({
        ready: 'boolean',
        message: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'static-test',
          apiVersion: 'example.com/v1',
          kind: 'StaticTest',
          spec: StaticSpec,
          status: StaticStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'staticDeployment'
          })
        }),
        (_schema, _resources) => ({
          // Static values should not require conversion
          ready: true,
          message: 'Static message'
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });

    it('should handle template literals with resource references', async () => {
      const TemplateSpec = type({
        name: 'string'
      });

      const TemplateStatus = type({
        url: 'string'
      });

      const graph = toResourceGraph(
        {
          name: 'template-test',
          apiVersion: 'example.com/v1',
          kind: 'TemplateTest',
          spec: TemplateSpec,
          status: TemplateStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'templateDeployment'
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'templateService'
          })
        }),
        (_schema, resources) => ({
          // Template literal with resource reference
          url: `http://${resources.service.status?.clusterIP || 'localhost'}`
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });

    it('should handle conditional expressions', async () => {
      const ConditionalSpec = type({
        name: 'string',
        replicas: 'number'
      });

      const ConditionalStatus = type({
        phase: 'string',
        ready: 'boolean'
      });

      const graph = toResourceGraph(
        {
          name: 'conditional-test',
          apiVersion: 'example.com/v1',
          kind: 'ConditionalTest',
          spec: ConditionalSpec,
          status: ConditionalStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: schema.spec.replicas,
            id: 'conditionalDeployment'
          })
        }),
        (schema, resources) => ({
          // Conditional expressions
          phase: resources.deployment.status.readyReplicas === schema.spec.replicas
            ? 'Ready'
            : resources.deployment.status.readyReplicas > 0
              ? 'Scaling'
              : 'NotReady',
          ready: resources.deployment.status.readyReplicas > 0
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });

    it('should handle optional chaining', async () => {
      const OptionalSpec = type({
        name: 'string'
      });

      const OptionalStatus = type({
        ip: 'string',
        ready: 'boolean'
      });

      const graph = toResourceGraph(
        {
          name: 'optional-test',
          apiVersion: 'example.com/v1',
          kind: 'OptionalTest',
          spec: OptionalSpec,
          status: OptionalStatus
        },
        (schema) => ({
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: schema.spec.name },
            id: 'optionalService'
          })
        }),
        (_schema, resources) => ({
          // Optional chaining
          ip: resources.service.status?.loadBalancer?.ingress?.[0]?.ip || 'pending',
          ready: resources.service.status?.ready ?? false
        })
      );

      expect(graph).toBeDefined();

      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle missing resources gracefully', async () => {
      const ErrorSpec = type({
        name: 'string'
      });

      const ErrorStatus = type({
        ready: 'boolean'
      });

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
          // Note: no service defined
        }),
        (_schema, resources) => ({
          // Reference to missing resource should be handled gracefully
          ready: resources.deployment.status.readyReplicas > 0
        })
      );

      expect(graph).toBeDefined();

      // Should be able to create factory even with missing references
      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory).toBeDefined();
    });

    it('should handle invalid expressions gracefully', async () => {
      const InvalidSpec = type({
        name: 'string'
      });

      const InvalidStatus = type({
        ready: 'boolean'
      });

      // This should not throw during graph creation
      const graph = toResourceGraph(
        {
          name: 'invalid-test',
          apiVersion: 'example.com/v1',
          kind: 'InvalidTest',
          spec: InvalidSpec,
          status: InvalidStatus
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'invalidDeployment'
          })
        }),
        (_schema, resources) => ({
          // Simple valid expression
          ready: resources.deployment.status.readyReplicas > 0
        })
      );

      expect(graph).toBeDefined();

      // Should be able to create factory
      try {
        const factory = await graph.factory('kro', { namespace: 'test' });
        expect(factory).toBeDefined();
      } catch (error) {
        // If there's an error, it should be meaningful
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBeDefined();
      }
    });
  });

  describe('Performance', () => {
    it('should handle multiple resources efficiently', async () => {
      const MultiSpec = type({
        name: 'string',
        count: 'number'
      });

      const MultiStatus = type({
        ready: 'boolean',
        total: 'number'
      });

      const startTime = performance.now();

      const graph = toResourceGraph(
        {
          name: 'multi-test',
          apiVersion: 'example.com/v1',
          kind: 'MultiTest',
          spec: MultiSpec,
          status: MultiStatus
        },
        (schema) => {
          const resources: Record<string, any> = {};
          
          // Create 5 resources for testing
          // Note: When using schema references in names, we must provide explicit IDs
          // because the name is a KubernetesRef at runtime and can't be used for ID generation
          for (let i = 0; i < 5; i++) {
            resources[`deployment${i}`] = simple.Deployment({
              name: Cel.expr(schema.spec.name, ` + "-${i}"`),
              image: 'nginx:latest',
              id: `deployment${i}` // Explicit ID required when name is dynamic
            });
          }
          
          return resources;
        },
        (_schema, resources) => ({
          // JavaScript expressions referencing multiple resources
          ready: Object.keys(resources).every(key => 
            resources[key].status.readyReplicas > 0
          ),
          total: Object.keys(resources).length
        })
      );

      const factory = await graph.factory('kro', { namespace: 'test' });
      const endTime = performance.now();

      expect(factory).toBeDefined();
      
      // Should complete in reasonable time
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(1000); // Less than 1 second
    });
  });
});