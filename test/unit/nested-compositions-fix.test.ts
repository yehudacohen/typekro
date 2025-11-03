import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition, simple } from '../../src/index.js';

describe('Nested Compositions Fix', () => {
  describe('Core Functionality', () => {
    it('should handle nested composition references without validation errors', () => {
      // Create a simple nested composition
      const databaseComposition = kubernetesComposition(
        {
          name: 'database',
          apiVersion: 'example.com/v1alpha1',
          kind: 'Database',
          spec: type({
            name: 'string',
            storage: 'string',
          }),
          status: type({
            ready: 'boolean',
            connectionString: 'string',
          }),
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'postgres:13',
            id: 'deployment',
          });

          return {
            ready: deployment.status.readyReplicas >= 1,
            connectionString: `postgresql://${spec.name}:5432/db`,
          };
        }
      );

      // Create a parent composition that uses the nested composition
      const appComposition = kubernetesComposition(
        {
          name: 'app',
          apiVersion: 'example.com/v1alpha1',
          kind: 'App',
          spec: type({
            name: 'string',
            dbName: 'string',
          }),
          status: type({
            ready: 'boolean',
            dbReady: 'boolean',
            url: 'string',
          }),
        },
        (spec) => {
          // This should work without validation errors
          const database = databaseComposition({
            name: spec.dbName,
            storage: '10Gi',
          });

          const webApp = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            env: {
              DATABASE_URL: database.status.connectionString, // Cross-composition reference
            },
            id: 'webapp',
          });

          return {
            ready: database.status.ready && webApp.status.readyReplicas >= 1, // Cross-composition reference
            dbReady: database.status.ready, // Cross-composition reference
            url: `https://${spec.name}.example.com`,
          };
        }
      );

      // This should not throw validation errors
      expect(() => {
        const factory = appComposition.factory('kro', { namespace: 'test' });
        const yaml = factory.toYaml();
        expect(yaml).toContain('kind: ResourceGraphDefinition');
      }).not.toThrow();
    });

    it('should correctly map variable names to nested composition resource IDs', () => {
      const nestedComposition = kubernetesComposition(
        {
          name: 'nested-service',
          apiVersion: 'example.com/v1alpha1',
          kind: 'NestedService',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            id: 'deployment',
          });

          return {
            ready: deployment.status.readyReplicas >= 1,
          };
        }
      );

      const parentComposition = kubernetesComposition(
        {
          name: 'parent-app',
          apiVersion: 'example.com/v1alpha1',
          kind: 'ParentApp',
          spec: type({ name: 'string' }),
          status: type({ allReady: 'boolean' }),
        },
        (spec) => {
          // Multiple nested composition instances with variable names that match the composition name
          const nestedService1 = nestedComposition({ name: `${spec.name}-a` });
          const nestedService2 = nestedComposition({ name: `${spec.name}-b` });

          return {
            // This should correctly resolve the variable names to resource IDs
            allReady: nestedService1.status.ready && nestedService2.status.ready,
          };
        }
      );

      // This should generate valid YAML without validation errors
      expect(() => {
        const factory = parentComposition.factory('kro', { namespace: 'test' });
        const yaml = factory.toYaml();

        // Should contain CEL expressions with correct resource references
        expect(yaml).toContain('${');
        expect(yaml).toContain('.status.ready');
        // The variable names should be converted to actual resource IDs (kebab-case format)
        expect(yaml).toMatch(/nested-service\d+\.status\.ready/); // Should contain actual resource IDs
      }).not.toThrow();
    });

    it('should not treat KubernetesRef objects as Enhanced resources', () => {
      const nestedComposition = kubernetesComposition(
        {
          name: 'service',
          apiVersion: 'example.com/v1alpha1',
          kind: 'Service',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean', endpoint: 'string' }),
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            id: 'deployment',
          });

          return {
            ready: deployment.status.readyReplicas >= 1,
            endpoint: `http://${spec.name}.example.com`,
          };
        }
      );

      const parentComposition = kubernetesComposition(
        {
          name: 'app',
          apiVersion: 'example.com/v1alpha1',
          kind: 'App',
          spec: type({ name: 'string' }),
          status: type({
            ready: 'boolean',
            endpoint: 'string',
          }),
        },
        (spec) => {
          const service = nestedComposition({ name: spec.name });

          return {
            // These KubernetesRef objects should NOT be treated as Enhanced resources
            ready: service.status.ready,
            endpoint: service.status.endpoint,
          };
        }
      );

      // This should work without creating invalid resources
      expect(() => {
        const factory = parentComposition.factory('kro', { namespace: 'test' });
        const yaml = factory.toYaml();

        // Should not contain resources named 'ready' or 'endpoint'
        expect(yaml).not.toContain('name: ready');
        expect(yaml).not.toContain('name: endpoint');

        // Should contain proper CEL expressions
        expect(yaml).toContain('${');
      }).not.toThrow();
    });
  });

  describe('Edge Cases and Regression Tests', () => {
    it('should handle complex nested status expressions without creating invalid resources', () => {
      const serviceComposition = kubernetesComposition(
        {
          name: 'service',
          apiVersion: 'example.com/v1alpha1',
          kind: 'Service',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean', phase: 'string', replicas: 'number' }),
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            id: 'deployment',
          });

          return {
            ready: deployment.status.readyReplicas >= 1,
            phase: deployment.status.phase || 'Pending',
            replicas: deployment.status.readyReplicas || 0,
          };
        }
      );

      const orchestratorComposition = kubernetesComposition(
        {
          name: 'orchestrator',
          apiVersion: 'example.com/v1alpha1',
          kind: 'Orchestrator',
          spec: type({ name: 'string' }),
          status: type({
            allReady: 'boolean',
            servicePhase: 'string',
            totalReplicas: 'number',
            complexExpression: 'boolean',
          }),
        },
        (spec) => {
          const service1 = serviceComposition({ name: `${spec.name}-svc1` });
          const service2 = serviceComposition({ name: `${spec.name}-svc2` });

          return {
            // Complex boolean expression with multiple nested references
            allReady:
              service1.status.ready && service2.status.ready && service1.status.replicas > 0,
            // Simple nested reference
            servicePhase: service1.status.phase,
            // Arithmetic expression with nested references
            totalReplicas: service1.status.replicas + service2.status.replicas,
            // Complex conditional expression
            complexExpression: service1.status.ready ? service2.status.replicas >= 1 : false,
          };
        }
      );

      // This should not create any resources named after status fields
      expect(() => {
        const factory = orchestratorComposition.factory('kro', { namespace: 'test' });
        const yaml = factory.toYaml();

        // Should not contain resources named after status fields
        expect(yaml).not.toContain('name: allReady');
        expect(yaml).not.toContain('name: servicePhase');
        expect(yaml).not.toContain('name: totalReplicas');
        expect(yaml).not.toContain('name: complexExpression');

        // Should contain proper CEL expressions
        expect(yaml).toContain('${');
        expect(yaml).toMatch(/service\d+\.status\./);
      }).not.toThrow();
    });

    it('should prevent KubernetesRef objects from being registered as resources', () => {
      const nestedComposition = kubernetesComposition(
        {
          name: 'nested',
          apiVersion: 'example.com/v1alpha1',
          kind: 'Nested',
          spec: type({ name: 'string' }),
          status: type({
            ready: 'boolean',
            endpoint: 'string',
            metadata: {
              name: 'string',
              namespace: 'string',
            },
          }),
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            id: 'deployment',
          });

          return {
            ready: deployment.status.readyReplicas >= 1,
            endpoint: `http://${spec.name}.example.com`,
            metadata: {
              name: deployment.metadata.name,
              namespace: deployment.metadata.namespace || 'default',
            },
          };
        }
      );

      const parentComposition = kubernetesComposition(
        {
          name: 'parent',
          apiVersion: 'example.com/v1alpha1',
          kind: 'Parent',
          spec: type({ name: 'string' }),
          status: type({
            nestedReady: 'boolean',
            nestedEndpoint: 'string',
            nestedName: 'string',
          }),
        },
        (spec) => {
          const nested = nestedComposition({ name: spec.name });

          return {
            // These should create KubernetesRef objects, not Enhanced resources
            nestedReady: nested.status.ready,
            nestedEndpoint: nested.status.endpoint,
            nestedName: nested.status.metadata.name,
          };
        }
      );

      expect(() => {
        const factory = parentComposition.factory('kro', { namespace: 'test' });
        const yaml = factory.toYaml();

        // Should not contain resources with KubernetesRef-like names
        expect(yaml).not.toContain('resourceId:');
        expect(yaml).not.toContain('fieldPath:');
        expect(yaml).not.toContain('__nestedComposition:');

        // Should contain proper CEL expressions
        expect(yaml).toContain('${');
        expect(yaml).toMatch(/nested\d+\.status\./);
      }).not.toThrow();
    });
  });
});
