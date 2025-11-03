/**
 * Unit tests for the callable composition API
 *
 * Tests the core functionality of compositions being callable as functions
 * for nested composition patterns.
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition, simple } from '../../src/index.js';

describe('Callable Composition API', () => {
  describe('Basic Callable Functionality', () => {
    it('should make compositions callable as functions', () => {
      const TestSpec = type({
        name: 'string',
        replicas: 'number%1',
      });

      const TestStatus = type({
        ready: 'boolean',
        replicas: 'number%1',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'test-composition',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'TestComposition',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            replicas: spec.replicas,
            id: 'deployment',
          });

          return {
            ready: deployment.status.readyReplicas >= spec.replicas,
            replicas: deployment.status.readyReplicas || 0,
          };
        }
      );

      // Should be callable as a function
      expect(typeof testComposition).toBe('function');

      // Should also have factory methods
      expect(typeof testComposition.factory).toBe('function');
      expect(typeof testComposition.toYaml).toBe('function');
      expect(testComposition.name).toBe('test-composition');
    });

    it('should return NestedCompositionResource when called', () => {
      const SimpleSpec = type({
        name: 'string',
      });

      const SimpleStatus = type({
        ready: 'boolean',
      });

      const simpleComposition = kubernetesComposition(
        {
          name: 'simple-composition',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'SimpleComposition',
          spec: SimpleSpec,
          status: SimpleStatus,
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

      // Call the composition as a function
      const result = simpleComposition({ name: 'test-app' });

      // Should return a NestedCompositionResource
      expect(result).toBeDefined();
      expect(result.spec).toEqual({ name: 'test-app' });
      expect(result.__compositionId).toBeDefined();
      expect(typeof result.__compositionId).toBe('string');
      expect(Array.isArray(result.__resources)).toBe(true);

      // Should have a status proxy
      expect(result.status).toBeDefined();
      expect(typeof result.status).toBe('object');
    });

    it('should provide type-safe status access through proxy', () => {
      const DatabaseSpec = type({
        name: 'string',
        storage: 'string',
      });

      const DatabaseStatus = type({
        ready: 'boolean',
        connectionString: 'string',
        phase: 'string',
      });

      const databaseComposition = kubernetesComposition(
        {
          name: 'database-composition',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'DatabaseComposition',
          spec: DatabaseSpec,
          status: DatabaseStatus,
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
            phase: deployment.status.phase || 'Pending',
          };
        }
      );

      const database = databaseComposition({
        name: 'test-db',
        storage: '10Gi',
      });

      // Status should be accessible and type-safe
      expect(database.status).toBeDefined();

      // These should be KubernetesRef objects for CEL generation
      const readyRef = database.status.ready;
      const connectionRef = database.status.connectionString;
      const phaseRef = database.status.phase;

      expect(readyRef).toBeDefined();
      expect(connectionRef).toBeDefined();
      expect(phaseRef).toBeDefined();

      // Should have the nested composition flag for CEL generation
      expect((readyRef as any).__nestedComposition).toBe(true);
      expect((connectionRef as any).__nestedComposition).toBe(true);
      expect((phaseRef as any).__nestedComposition).toBe(true);
    });
  });

  describe('Nested Composition Integration', () => {
    it('should work within other compositions', () => {
      // Create a nested composition
      const ServiceSpec = type({
        name: 'string',
        port: 'number%1',
      });

      const ServiceStatus = type({
        ready: 'boolean',
        endpoint: 'string',
      });

      const serviceComposition = kubernetesComposition(
        {
          name: 'service-composition',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'ServiceComposition',
          spec: ServiceSpec,
          status: ServiceStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            id: 'deployment',
          });

          const service = simple.Service({
            name: spec.name,
            selector: { app: spec.name },
            ports: [{ port: spec.port, targetPort: 80 }],
            id: 'service',
          });

          return {
            ready: deployment.status.readyReplicas >= 1,
            endpoint: `http://${service.status.clusterIP}:${spec.port}`,
          };
        }
      );

      // Create a parent composition that uses the nested composition
      const AppSpec = type({
        name: 'string',
        serviceName: 'string',
      });

      const AppStatus = type({
        ready: 'boolean',
        serviceReady: 'boolean',
        serviceEndpoint: 'string',
      });

      const appComposition = kubernetesComposition(
        {
          name: 'app-composition',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'AppComposition',
          spec: AppSpec,
          status: AppStatus,
        },
        (spec) => {
          // Call the nested composition
          const service = serviceComposition({
            name: spec.serviceName,
            port: 80,
          });

          const frontend = simple.Deployment({
            name: spec.name,
            image: 'frontend:latest',
            env: {
              SERVICE_URL: service.status.endpoint, // Cross-composition reference
            },
            id: 'frontend',
          });

          return {
            ready: service.status.ready && frontend.status.readyReplicas >= 1,
            serviceReady: service.status.ready,
            serviceEndpoint: service.status.endpoint,
          };
        }
      );

      // Should not throw when creating the composition
      expect(() => {
        const factory = appComposition.factory('kro', { namespace: 'test' });
        const yaml = factory.toYaml();
        expect(yaml).toContain('kind: ResourceGraphDefinition');
      }).not.toThrow();
    });

    it('should handle multiple nested composition instances', () => {
      const WorkerSpec = type({
        name: 'string',
        replicas: 'number%1',
      });

      const WorkerStatus = type({
        ready: 'boolean',
        activeReplicas: 'number%1',
      });

      const workerComposition = kubernetesComposition(
        {
          name: 'worker-composition',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'WorkerComposition',
          spec: WorkerSpec,
          status: WorkerStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'worker:latest',
            replicas: spec.replicas,
            id: 'deployment',
          });

          return {
            ready: deployment.status.readyReplicas >= spec.replicas,
            activeReplicas: deployment.status.readyReplicas || 0,
          };
        }
      );

      const ClusterSpec = type({
        name: 'string',
      });

      const ClusterStatus = type({
        ready: 'boolean',
        totalReplicas: 'number%1',
        allWorkersReady: 'boolean',
      });

      const clusterComposition = kubernetesComposition(
        {
          name: 'cluster-composition',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'ClusterComposition',
          spec: ClusterSpec,
          status: ClusterStatus,
        },
        (spec) => {
          // Create multiple instances of the nested composition
          const worker1 = workerComposition({
            name: `${spec.name}-worker-1`,
            replicas: 3,
          });

          const worker2 = workerComposition({
            name: `${spec.name}-worker-2`,
            replicas: 2,
          });

          const worker3 = workerComposition({
            name: `${spec.name}-worker-3`,
            replicas: 1,
          });

          return {
            ready: worker1.status.ready && worker2.status.ready && worker3.status.ready,
            totalReplicas:
              worker1.status.activeReplicas +
              worker2.status.activeReplicas +
              worker3.status.activeReplicas,
            allWorkersReady: worker1.status.ready && worker2.status.ready && worker3.status.ready,
          };
        }
      );

      // Should generate valid YAML with multiple nested compositions
      expect(() => {
        const factory = clusterComposition.factory('kro', { namespace: 'test' });
        const yaml = factory.toYaml();

        expect(yaml).toContain('kind: ResourceGraphDefinition');
        expect(yaml).toContain('${'); // Should contain CEL expressions

        // Should reference the nested composition status fields
        expect(yaml).toMatch(/worker\d+\.status\./);
      }).not.toThrow();
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle compositions with complex status expressions', () => {
      const ComplexSpec = type({
        name: 'string',
        threshold: 'number%1',
      });

      const ComplexStatus = type({
        ready: 'boolean',
        phase: 'string',
        score: 'number%1',
        metadata: {
          lastUpdated: 'string',
          version: 'string',
        },
      });

      const complexComposition = kubernetesComposition(
        {
          name: 'complex-composition',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'ComplexComposition',
          spec: ComplexSpec,
          status: ComplexStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'complex-app:latest',
            id: 'deployment',
          });

          return {
            ready:
              deployment.status.readyReplicas >= 1 &&
              deployment.status.readyReplicas >= spec.threshold,
            phase: deployment.status.phase || 'Unknown',
            score: (deployment.status.readyReplicas || 0) * 10,
            metadata: {
              lastUpdated: new Date().toISOString(),
              version: '1.0.0',
            },
          };
        }
      );

      const parentComposition = kubernetesComposition(
        {
          name: 'parent-complex',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'ParentComplex',
          spec: type({ name: 'string' }),
          status: type({
            complexReady: 'boolean',
            complexPhase: 'string',
            complexScore: 'number%1',
            lastUpdated: 'string',
          }),
        },
        (spec) => {
          const complex = complexComposition({
            name: spec.name,
            threshold: 2,
          });

          return {
            complexReady: complex.status.ready,
            complexPhase: complex.status.phase,
            complexScore: complex.status.score,
            lastUpdated: complex.status.metadata.lastUpdated,
          };
        }
      );

      // Should handle nested object access in status
      expect(() => {
        const factory = parentComposition.factory('kro', { namespace: 'test' });
        const yaml = factory.toYaml();
        expect(yaml).toContain('${');
      }).not.toThrow();
    });

    it('should maintain type safety across nested calls', () => {
      const TypedSpec = type({
        name: 'string',
        config: {
          enabled: 'boolean',
          timeout: 'number%1',
        },
      });

      const TypedStatus = type({
        ready: 'boolean',
        config: {
          applied: 'boolean',
          effectiveTimeout: 'number%1',
        },
      });

      const typedComposition = kubernetesComposition(
        {
          name: 'typed-composition',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'TypedComposition',
          spec: TypedSpec,
          status: TypedStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'app:latest',
            id: 'deployment',
          });

          return {
            ready: spec.config.enabled && deployment.status.readyReplicas >= 1,
            config: {
              applied: spec.config.enabled,
              effectiveTimeout: spec.config.timeout,
            },
          };
        }
      );

      // Call with properly typed spec
      const result = typedComposition({
        name: 'test-app',
        config: {
          enabled: true,
          timeout: 30,
        },
      });

      // Should maintain type safety
      expect(result.spec.name).toBe('test-app');
      expect(result.spec.config.enabled).toBe(true);
      expect(result.spec.config.timeout).toBe(30);

      // Status should be accessible with proper typing
      expect(result.status.ready).toBeDefined();
      expect(result.status.config.applied).toBeDefined();
      expect(result.status.config.effectiveTimeout).toBeDefined();
    });
  });

  describe('Factory Integration', () => {
    it('should work with both direct and kro factories', () => {
      const FactoryTestSpec = type({
        name: 'string',
      });

      const FactoryTestStatus = type({
        ready: 'boolean',
      });

      const factoryTestComposition = kubernetesComposition(
        {
          name: 'factory-test',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'FactoryTest',
          spec: FactoryTestSpec,
          status: FactoryTestStatus,
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

      // Should work with direct factory
      expect(() => {
        const directFactory = factoryTestComposition.factory('direct', { namespace: 'test' });
        expect(directFactory).toBeDefined();
        expect(directFactory.mode).toBe('direct');
      }).not.toThrow();

      // Should work with kro factory
      expect(() => {
        const kroFactory = factoryTestComposition.factory('kro', { namespace: 'test' });
        expect(kroFactory).toBeDefined();
        expect(kroFactory.mode).toBe('kro');
      }).not.toThrow();
    });

    it('should generate valid YAML for nested compositions', () => {
      const SimpleNestedSpec = type({
        name: 'string',
      });

      const SimpleNestedStatus = type({
        ready: 'boolean',
      });

      const simpleNested = kubernetesComposition(
        {
          name: 'simple-nested',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'SimpleNested',
          spec: SimpleNestedSpec,
          status: SimpleNestedStatus,
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

      const parentWithNested = kubernetesComposition(
        {
          name: 'parent-with-nested',
          apiVersion: 'test.example.com/v1alpha1',
          kind: 'ParentWithNested',
          spec: type({ name: 'string' }),
          status: type({ nestedReady: 'boolean' }),
        },
        (spec) => {
          const nested = simpleNested({ name: spec.name });

          return {
            nestedReady: nested.status.ready,
          };
        }
      );

      const factory = parentWithNested.factory('kro', { namespace: 'test' });
      const yaml = factory.toYaml();

      // Should contain ResourceGraphDefinition
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');

      // Should contain the nested deployment resource
      expect(yaml).toContain('kind: Deployment');
      // Should contain CEL expressions for flattened resources
      expect(yaml).toContain('${');
      expect(yaml).toMatch(/\$\{.*\.status\./);

      // Should not contain invalid resource names
      expect(yaml).not.toContain('name: ready');
      expect(yaml).not.toContain('name: nestedReady');

      // The nested composition resources should be flattened into the parent
      expect(yaml).toContain('image: nginx');
    });
  });
});
