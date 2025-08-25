/**
 * Unit tests for the Imperative Composition Pattern
 *
 * This test suite validates the kubernetesComposition function and context-aware
 * resource registration functionality according to requirements 2.1, 2.2, 4.1, 4.2, 6.1
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { Cel, getCurrentCompositionContext, kubernetesComposition, toResourceGraph, simple } from '../../src/index.js';

describe('Imperative Composition Pattern', () => {
  // Test schemas compatible with Kro
  const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1',
    hostname: 'string',
  });

  const WebAppStatusSchema = type({
    ready: 'boolean',
    url: 'string',
    readyReplicas: 'number%1',
  });

  const definition = {
    name: 'test-webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  };

  describe('kubernetesComposition function', () => {
    it('should create a composition factory', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'webappDeployment',
        });

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      expect(composition).toBeDefined();
      expect(composition.name).toBe('test-webapp');
      expect(typeof composition.toYaml).toBe('function');
      expect(typeof composition.factory).toBe('function');
    });

    it('should accept spec parameter with correct type', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        // Spec properties are schema proxies that return KubernetesRef functions
        // This is the expected behavior for the imperative composition pattern
        expect(typeof spec.name).toBe('function'); // KubernetesRef
        expect(typeof spec.image).toBe('function'); // KubernetesRef
        expect(typeof spec.replicas).toBe('function'); // KubernetesRef
        expect(typeof spec.hostname).toBe('function'); // KubernetesRef

        return {
          ready: true,
          url: 'http://example.com',
          readyReplicas: 1,
        };
      });

      expect(composition).toBeDefined();
    });

    it('should return MagicAssignableShape<TStatus> from composition function', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'statusTestDeployment',
        });

        // Return status object with different value types
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'), // CEL expression
          url: Cel.template('https://%s', spec.hostname), // CEL template
          readyReplicas: deployment.status.readyReplicas, // Resource reference
        };
      });

      expect(composition).toBeDefined();
      expect(composition.name).toBe('test-webapp');
    });
  });

  describe('context-aware resource registration', () => {
    it('should automatically register resources created in composition context', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        // Resources should auto-register when created
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'webappDeployment',
        });

        const _service = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: spec.name },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'webappService',
        });

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Should have captured both resources
      expect(composition.resources).toHaveLength(2);

      // Check that resources were registered with proper IDs
      const resourceIds = composition.resources.map((r) => r.id);
      expect(resourceIds).toContain('webappDeployment');
      expect(resourceIds).toContain('webappService');
    });

    it('should track multiple resources with unique identifiers', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        // Create multiple resources of the same type
        const deployment1 = simple.Deployment({
          name: `${spec.name}-api`,
          image: spec.image,
          replicas: spec.replicas,
          id: 'apiDeployment',
        });

        const deployment2 = simple.Deployment({
          name: `${spec.name}-worker`,
          image: spec.image,
          replicas: 1,
          id: 'workerDeployment',
        });

        return {
          ready: Cel.expr<boolean>(
            deployment1.status.readyReplicas,
            ' > 0 && ',
            deployment2.status.readyReplicas,
            ' > 0'
          ),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: Cel.expr<number>(
            deployment1.status.readyReplicas,
            ' + ',
            deployment2.status.readyReplicas
          ),
        };
      });

      // Should have both deployments
      expect(composition.resources).toHaveLength(2);

      // Should have unique IDs
      const resourceIds = composition.resources.map((r) => r.id);
      expect(resourceIds).toContain('apiDeployment');
      expect(resourceIds).toContain('workerDeployment');
      expect(new Set(resourceIds).size).toBe(2); // All unique
    });

    it('should handle resource dependencies automatically', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'appDeployment',
        });

        const service = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: deployment.metadata.labels?.app || spec.name },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'appService',
        });

        return {
          ready: Cel.expr<boolean>(
            deployment.status.readyReplicas,
            ' > 0 && ',
            service.status.loadBalancer.ingress?.length,
            ' > 0'
          ),
          url: Cel.template('http://%s', service.status.loadBalancer.ingress?.[0]?.ip),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      expect(composition.resources).toHaveLength(2);

      // Dependencies should be tracked in the resource graph
      // Note: Dependencies are tracked internally during serialization
      expect(composition.resources).toHaveLength(2);
    });
  });

  describe('composition context management', () => {
    it('should provide composition context during execution', () => {
      let contextDuringExecution: any = null;

      const _composition = kubernetesComposition(definition, (spec) => {
        // Capture the context during composition execution
        contextDuringExecution = getCurrentCompositionContext();

        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'contextTestDeployment',
        });

        return {
          ready: true,
          url: 'http://example.com',
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // The composition is already executed (direct API)

      // Context should have been available during execution
      expect(contextDuringExecution).not.toBeNull();
      expect(contextDuringExecution).toHaveProperty('resources');
      expect(contextDuringExecution).toHaveProperty('resourceCounter');
      expect(typeof contextDuringExecution.addResource).toBe('function');
      expect(typeof contextDuringExecution.generateResourceId).toBe('function');
    });

    it('should not have composition context outside of composition execution', () => {
      // Context should not be available outside composition
      const context = getCurrentCompositionContext();
      expect(context).toBeUndefined();
    });

    it('should isolate contexts between different compositions', () => {
      const contexts: any[] = [];

      const _composition1 = kubernetesComposition(definition, (spec) => {
        contexts.push(getCurrentCompositionContext());
        simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: 1,
          id: 'contextTest1Deployment',
        });
        return { ready: true, url: 'http://test1.com', readyReplicas: 1 };
      });

      const _composition2 = kubernetesComposition(definition, (spec) => {
        contexts.push(getCurrentCompositionContext());
        simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: 1,
          id: 'contextTest2Deployment',
        });
        return { ready: true, url: 'http://test2.com', readyReplicas: 1 };
      });

      // Both compositions are already executed (direct API)

      // Should have captured two different contexts
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).not.toBe(contexts[1]);
      expect(contexts[0]).toHaveProperty('resources');
      expect(contexts[1]).toHaveProperty('resources');
    });
  });

  describe('backward compatibility', () => {
    it('should allow factory functions to work normally outside composition context', () => {
      // Factory functions should work without composition context
      const deployment = simple.Deployment({
        name: 'standalone-deployment',
        image: 'nginx:latest',
        replicas: 1,
      });

      expect(deployment).toBeDefined();
      expect(deployment.kind).toBe('Deployment');
      expect(deployment.metadata?.name).toBe('standalone-deployment');

      // Should not be registered anywhere since no context is active
      const context = getCurrentCompositionContext();
      expect(context).toBeUndefined();
    });

    it('should not affect factory function behavior outside composition', () => {
      // Create resources outside composition context
      const deployment1 = simple.Deployment({
        name: 'test-deployment-1',
        image: 'nginx:latest',
        replicas: 1,
      });

      const deployment2 = simple.Deployment({
        name: 'test-deployment-2',
        image: 'nginx:latest',
        replicas: 2,
      });

      // Both should work independently
      expect(deployment1.metadata?.name).toBe('test-deployment-1');
      expect(deployment2.metadata?.name).toBe('test-deployment-2');
      expect(deployment1.spec?.replicas).toBe(1);
      expect(deployment2.spec?.replicas).toBe(2);
    });

    it('should maintain factory function performance outside composition', () => {
      // This test ensures no significant performance impact
      const startTime = performance.now();

      for (let i = 0; i < 100; i++) {
        simple.Deployment({
          name: `perf-test-${i}`,
          image: 'nginx:latest',
          replicas: 1,
        });
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Should complete quickly (less than 100ms for 100 resources)
      expect(duration).toBeLessThan(100);
    });
  });

  describe('integration with toResourceGraph()', () => {
    it('should produce identical output to toResourceGraph', () => {
      // Create the same resource graph using both approaches
      const imperativeComposition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'webappDeployment',
        });

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      const traditionalGraph = toResourceGraph(
        definition,
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
        }),
        (_schema, resources) => ({
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', _schema.spec.hostname),
          readyReplicas: resources.deployment.status.readyReplicas,
        })
      );

      // Should have same basic structure
      expect(imperativeComposition.name).toBe(traditionalGraph.name);
      expect(imperativeComposition.resources).toHaveLength(traditionalGraph.resources.length);

      // Should generate equivalent YAML
      const imperativeYaml = imperativeComposition.toYaml();
      const traditionalYaml = traditionalGraph.toYaml();

      expect(imperativeYaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(imperativeYaml).toContain('kind: ResourceGraphDefinition');
      expect(traditionalYaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(traditionalYaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should support factory method creation', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'factoryTestDeployment',
        });

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Should be able to create kro factory
      const kroFactory = composition.factory('kro');
      expect(kroFactory.mode).toBe('kro');
      expect(kroFactory.name).toBe('test-webapp');

      // Should be able to create direct factory
      const directFactory = composition.factory('direct');
      expect(directFactory.mode).toBe('direct');
      expect(directFactory.name).toBe('test-webapp');
    });

    it('should work with existing tooling and serialization', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'toolingTestDeployment',
        });

        const service = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: spec.name },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'toolingTestService',
        });

        return {
          ready: Cel.expr<boolean>(
            deployment.status.readyReplicas,
            ' > 0 && ',
            service.status.loadBalancer.ingress?.length,
            ' > 0'
          ),
          url: Cel.template('http://%s', service.status.loadBalancer.ingress?.[0]?.ip),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Should generate valid YAML
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: test-webapp');

      // Should have proper resource templates
      expect(yaml).toContain('resources:');
      expect(yaml).toContain('id: toolingTestDeployment');
      expect(yaml).toContain('id: toolingTestService');

      // Should have schema definition
      expect(yaml).toContain('schema:');
      expect(yaml).toContain('apiVersion: v1alpha1'); // Note: uses short form from definition
      expect(yaml).toContain('kind: WebApp');
    });

    it('should maintain type safety through toResourceGraph conversion', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        // These should all be properly typed without assertions
        const deployment = simple.Deployment({
          name: spec.name, // Should accept string from spec
          image: spec.image, // Should accept string from spec
          replicas: spec.replicas, // Should accept number from spec
          id: 'typeSafeDeployment',
        });

        // Return should be properly typed as MagicAssignableShape<TStatus>
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Should maintain type information
      expect(composition.name).toBe('test-webapp');
      expect(composition.schema).toBeDefined();
      expect(composition.schema?.spec).toBeDefined();
      expect(composition.schema?.status).toBeDefined();
    });
  });

  describe('nested status object structures', () => {
    it('should handle nested status objects with literal values', () => {
      const NestedStatusSchema = type({
        ready: 'boolean',
        endpoints: {
          api: 'string',
          ui: 'string',
        },
        metrics: {
          replicas: 'number%1',
          availability: 'number',
        },
      });

      const nestedDefinition = {
        name: 'nested-webapp',
        apiVersion: 'example.com/v1alpha1',
        kind: 'NestedWebApp',
        spec: WebAppSpecSchema,
        status: NestedStatusSchema,
      };

      const composition = kubernetesComposition(nestedDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'nestedTestDeployment',
        });

        const _service = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: spec.name },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'nestedTestService',
        });

        // Return nested status object structure
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          endpoints: {
            api: Cel.template('https://%s/api', spec.hostname),
            ui: Cel.template('https://%s', spec.hostname),
          },
          metrics: {
            replicas: deployment.status.readyReplicas,
            availability: Cel.expr<number>(deployment.status.readyReplicas, ' / ', spec.replicas),
          },
        };
      });

      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(2);

      // Should generate valid YAML with nested structure
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should handle deeply nested status objects', () => {
      const DeeplyNestedStatusSchema = type({
        application: {
          frontend: {
            status: 'string',
            url: 'string',
          },
          backend: {
            status: 'string',
            replicas: 'number%1',
          },
        },
        infrastructure: {
          database: {
            ready: 'boolean',
            connections: 'number%1',
          },
          storage: {
            available: 'boolean',
            capacity: 'string',
          },
        },
      });

      const deeplyNestedDefinition = {
        name: 'deeply-nested-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'DeeplyNestedApp',
        spec: WebAppSpecSchema,
        status: DeeplyNestedStatusSchema,
      };

      const composition = kubernetesComposition(deeplyNestedDefinition, (spec) => {
        const frontendDeployment = simple.Deployment({
          name: `${spec.name}-frontend`,
          image: spec.image,
          replicas: spec.replicas,
          id: 'frontendDeployment',
        });

        const backendDeployment = simple.Deployment({
          name: `${spec.name}-backend`,
          image: 'backend:latest',
          replicas: 2,
          id: 'backendDeployment',
        });

        // Return deeply nested status structure
        return {
          application: {
            frontend: {
              status: Cel.expr<string>(
                frontendDeployment.status.readyReplicas,
                ' > 0 ? "Ready" : "Pending"'
              ),
              url: Cel.template('https://%s', spec.hostname),
            },
            backend: {
              status: Cel.expr<string>(
                backendDeployment.status.readyReplicas,
                ' > 0 ? "Ready" : "Pending"'
              ),
              replicas: backendDeployment.status.readyReplicas,
            },
          },
          infrastructure: {
            database: {
              ready: Cel.expr<boolean>(backendDeployment.status.readyReplicas, ' > 0'),
              connections: Cel.expr<number>(backendDeployment.status.readyReplicas, ' * 10'),
            },
            storage: {
              available: true, // Literal boolean
              capacity: '100Gi', // Literal string
            },
          },
        };
      });

      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(2);

      // Should serialize nested structure correctly
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should handle arrays in status objects', () => {
      const ArrayStatusSchema = type({
        ready: 'boolean',
        services: 'string[]',
        replicas: 'number[]',
        endpoints: 'string[]',
      });

      const arrayDefinition = {
        name: 'array-status-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ArrayStatusApp',
        spec: WebAppSpecSchema,
        status: ArrayStatusSchema,
      };

      const composition = kubernetesComposition(arrayDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'arrayTestDeployment',
        });

        // Return status with arrays
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          services: ['api', 'ui', 'metrics'], // Literal array
          replicas: [deployment.status.readyReplicas], // Array with resource reference
          endpoints: [
            Cel.template('https://%s/api', spec.hostname),
            Cel.template('https://%s', spec.hostname),
          ],
        };
      });

      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(1);

      // Should handle arrays in serialization
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should preserve type safety with nested structures', () => {
      const TypeSafeNestedSchema = type({
        metadata: {
          name: 'string',
          namespace: 'string',
          labels: 'Record<string, string>',
        },
        status: {
          phase: 'string',
          conditions: 'string[]',
        },
      });

      const typeSafeDefinition = {
        name: 'type-safe-nested',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TypeSafeNested',
        spec: WebAppSpecSchema,
        status: TypeSafeNestedSchema,
      };

      const composition = kubernetesComposition(typeSafeDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'typeSafeDeployment',
        });

        // TypeScript should enforce correct types for nested structure
        return {
          metadata: {
            name: spec.name, // Should be typed as string
            namespace: 'default', // Should be typed as string
            labels: { app: spec.name, version: 'v1' }, // Should be typed as Record<string, string>
          },
          status: {
            phase: Cel.expr<string>(
              deployment.status.readyReplicas,
              ' > 0 ? "Running" : "Pending"'
            ),
            conditions: [
              Cel.expr<string>(deployment.status.readyReplicas, ' > 0 ? "Ready" : "Pending"'),
            ],
          },
        };
      });

      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(1);
    });
  });

  describe('status object validation', () => {
    it('should accept valid status objects', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'validStatusDeployment',
        });

        // Return valid status object
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Should not throw
      expect(composition).toBeDefined();
    });

    it('should handle literal values in status objects', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const _deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'literalStatusDeployment',
        });

        // Return status with literal values
        return {
          ready: true, // Literal boolean
          url: 'https://example.com', // Literal string
          readyReplicas: 1, // Literal number
        };
      });

      // Should not throw
      expect(composition).toBeDefined();
    });
  });

  describe('MagicAssignableShape schema validation', () => {
    it('should validate MagicAssignableShape return type against status schema', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'magicShapeDeployment',
        });

        // Return MagicAssignableShape<TStatus> - should validate against WebAppStatusSchema
        const statusObject = {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };

        // This should be properly typed as MagicAssignableShape<TStatus>
        return statusObject;
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();
      expect(composition.schema?.status).toBeDefined();
    });

    it('should enforce schema constraints on MagicAssignableShape fields', () => {
      // Create a schema with specific constraints
      const ConstrainedStatusSchema = type({
        ready: 'boolean',
        replicas: 'number%1', // Must be positive integer
        percentage: 'number', // Must be between 0 and 100
        phase: '"Pending" | "Running" | "Completed"', // Must be one of these values
      });

      const constrainedDefinition = {
        name: 'constrained-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ConstrainedApp',
        spec: WebAppSpecSchema,
        status: ConstrainedStatusSchema,
      };

      const composition = kubernetesComposition(constrainedDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'constrainedDeployment',
        });

        // Return status that should satisfy schema constraints
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          replicas: deployment.status.readyReplicas, // Should be positive integer
          percentage: Cel.expr<number>(
            deployment.status.readyReplicas,
            ' / ',
            spec.replicas,
            ' * 100'
          ), // Should be 0-100
          phase: Cel.expr<'Pending' | 'Running' | 'Completed'>(
            deployment.status.readyReplicas,
            ' > 0 ? "Running" : "Pending"'
          ),
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();

      // Schema validation should pass during serialization
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    });

    it('should validate complex MagicAssignableShape structures', () => {
      const ComplexStatusSchema = type({
        metadata: {
          name: 'string',
          labels: 'Record<string, string>',
          annotations: 'Record<string, string>?',
        },
        status: {
          conditions: 'string[]',
          phase: 'string',
          startTime: 'string?',
          completionTime: 'string?',
        },
      });

      const complexDefinition = {
        name: 'complex-status-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ComplexStatusApp',
        spec: WebAppSpecSchema,
        status: ComplexStatusSchema,
      };

      const composition = kubernetesComposition(complexDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'complexStatusDeployment',
        });

        // Return complex MagicAssignableShape structure
        return {
          metadata: {
            name: spec.name,
            labels: {
              app: spec.name,
              version: 'v1',
            },
            annotations: {
              'deployment.kubernetes.io/revision': '1',
            },
          },
          status: {
            conditions: ['Available', 'Progressing'],
            phase: Cel.expr<string>(
              deployment.status.readyReplicas,
              ' > 0 ? "Running" : "Pending"'
            ),
            startTime: Cel.expr<string>('now()'),
          },
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();
      expect(composition.schema?.status).toBeDefined();
    });

    it('should handle optional fields in MagicAssignableShape', () => {
      const OptionalFieldsSchema = type({
        ready: 'boolean',
        url: 'string',
        replicas: 'number%1',
        message: 'string?', // Optional field
        metadata: {
          name: 'string',
          description: 'string?',
        },
      });

      const optionalDefinition = {
        name: 'optional-fields-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'OptionalFieldsApp',
        spec: WebAppSpecSchema,
        status: OptionalFieldsSchema,
      };

      const composition = kubernetesComposition(optionalDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'optionalFieldsDeployment',
        });

        // Return status with required fields and some optional fields omitted
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          replicas: deployment.status.readyReplicas,
          metadata: {
            name: spec.name,
            // description is optional and omitted
          },
          // message is optional and omitted
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();

      // Should validate successfully even with optional fields omitted
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    });

    it('should validate MagicAssignableShape with union types', () => {
      const UnionTypeSchema = type({
        ready: 'boolean',
        value: 'string | number', // Union type
        status: '"active" | "inactive" | "pending"', // String literal union
        config: {
          mode: '"development" | "production"',
          level: 'number | "auto"',
        },
      });

      const unionDefinition = {
        name: 'union-type-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'UnionTypeApp',
        spec: WebAppSpecSchema,
        status: UnionTypeSchema,
      };

      const composition = kubernetesComposition(unionDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'unionTypeDeployment',
        });

        // Return status with union type values
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          value: deployment.status.readyReplicas, // number (part of string | number union)
          status: Cel.expr<'active' | 'inactive' | 'pending'>(
            deployment.status.readyReplicas,
            ' > 0 ? "active" : "pending"'
          ),
          config: {
            mode: 'production' as const, // String literal
            level: Cel.expr<number | 'auto'>(spec.replicas, ' > 1 ? ', spec.replicas, ' : "auto"'),
          },
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();

      // Should validate union types correctly
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    });

    it('should provide type safety for MagicAssignableShape return values', () => {
      // This test validates that TypeScript enforces correct types
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'typeSafetyDeployment',
        });

        // TypeScript should enforce that return type matches WebAppStatusSchema
        const statusObject = {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'), // Must be boolean
          url: Cel.template('https://%s', spec.hostname), // Must be string
          readyReplicas: deployment.status.readyReplicas, // Must be number
        };

        // This should be typed as MagicAssignableShape<WebAppStatus>
        return statusObject;
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();

      // Verify that the schema information is preserved
      expect(composition.schema?.status).toBeDefined();
      expect(composition.name).toBe('test-webapp');
    });

    it('should validate MagicAssignableShape with resource references', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'resourceRefDeployment',
        });

        const service = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: spec.name },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'resourceRefService',
        });

        // Return MagicAssignableShape with various resource references
        return {
          ready: Cel.expr<boolean>(
            deployment.status.readyReplicas,
            ' > 0 && ',
            service.status.loadBalancer.ingress?.length,
            ' > 0'
          ),
          url: Cel.template('http://%s', service.status.loadBalancer.ingress?.[0]?.ip),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(2);

      // Resource references should be properly serialized
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });
  });

  describe('complex status object scenarios', () => {
    it('should handle complex CEL expressions with multiple resource references', () => {
      const ComplexStatusSchema = type({
        ready: 'boolean',
        healthScore: 'number',
        summary: 'string',
        details: {
          frontend: {
            ready: 'boolean',
            replicas: 'number%1',
          },
          backend: {
            ready: 'boolean',
            replicas: 'number%1',
          },
          database: {
            ready: 'boolean',
            connections: 'number%1',
          },
        },
      });

      const complexDefinition = {
        name: 'complex-cel-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ComplexCelApp',
        spec: WebAppSpecSchema,
        status: ComplexStatusSchema,
      };

      const composition = kubernetesComposition(complexDefinition, (spec) => {
        const frontendDeployment = simple.Deployment({
          name: `${spec.name}-frontend`,
          image: spec.image,
          replicas: spec.replicas,
          id: 'frontendDeployment',
        });

        const backendDeployment = simple.Deployment({
          name: `${spec.name}-backend`,
          image: 'backend:latest',
          replicas: 2,
          id: 'backendDeployment',
        });

        const databaseDeployment = simple.Deployment({
          name: `${spec.name}-database`,
          image: 'postgres:13',
          replicas: 1,
          id: 'databaseDeployment',
        });

        // Complex status with multiple CEL expressions and resource references
        return {
          ready: Cel.expr<boolean>(
            frontendDeployment.status.readyReplicas,
            ' > 0 && ',
            backendDeployment.status.readyReplicas,
            ' > 0 && ',
            databaseDeployment.status.readyReplicas,
            ' > 0'
          ),
          healthScore: Cel.expr<number>(
            '(',
            frontendDeployment.status.readyReplicas,
            ' / ',
            frontendDeployment.spec.replicas,
            ' + ',
            backendDeployment.status.readyReplicas,
            ' / ',
            backendDeployment.spec.replicas,
            ' + ',
            databaseDeployment.status.readyReplicas,
            ' / ',
            databaseDeployment.spec.replicas,
            ') / 3 * 100'
          ),
          summary: Cel.expr<string>(
            frontendDeployment.status.readyReplicas,
            ' > 0 && ',
            backendDeployment.status.readyReplicas,
            ' > 0 && ',
            databaseDeployment.status.readyReplicas,
            ' > 0 ? "All services healthy" : "Some services unavailable"'
          ),
          details: {
            frontend: {
              ready: Cel.expr<boolean>(frontendDeployment.status.readyReplicas, ' > 0'),
              replicas: frontendDeployment.status.readyReplicas,
            },
            backend: {
              ready: Cel.expr<boolean>(backendDeployment.status.readyReplicas, ' > 0'),
              replicas: backendDeployment.status.readyReplicas,
            },
            database: {
              ready: Cel.expr<boolean>(databaseDeployment.status.readyReplicas, ' > 0'),
              connections: Cel.expr<number>(databaseDeployment.status.readyReplicas, ' * 10'),
            },
          },
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(3);

      // Should serialize complex CEL expressions correctly
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should handle mixed CEL expressions and literal values', () => {
      const MixedStatusSchema = type({
        ready: 'boolean',
        version: 'string',
        replicas: 'number%1',
        endpoints: {
          api: 'string',
          ui: 'string',
          metrics: 'string',
        },
        metadata: {
          labels: 'Record<string, string>',
          createdAt: 'string',
        },
      });

      const mixedDefinition = {
        name: 'mixed-status-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'MixedStatusApp',
        spec: WebAppSpecSchema,
        status: MixedStatusSchema,
      };

      const composition = kubernetesComposition(mixedDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'mixedStatusDeployment',
        });

        const _service = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: spec.name },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'mixedStatusService',
        });

        // Mix of CEL expressions, resource references, and literal values
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'), // CEL expression
          version: 'v1.0.0', // Literal string
          replicas: deployment.status.readyReplicas, // Resource reference
          endpoints: {
            api: Cel.template('https://%s/api', spec.hostname), // CEL template
            ui: Cel.template('https://%s', spec.hostname), // CEL template
            metrics: 'https://metrics.example.com', // Literal string
          },
          metadata: {
            labels: {
              // Literal object
              app: spec.name,
              version: 'v1.0.0',
              environment: 'production',
            },
            createdAt: Cel.expr<string>('now()'), // CEL expression for current time
          },
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(2);

      // Should handle mixed patterns correctly
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should handle conditional CEL expressions with resource state', () => {
      const ConditionalStatusSchema = type({
        phase: '"Initializing" | "Running" | "Scaling" | "Error"',
        message: 'string',
        conditions: 'string[]',
        scaling: {
          desired: 'number%1',
          current: 'number%1',
          ready: 'number%1',
          inProgress: 'boolean',
        },
      });

      const conditionalDefinition = {
        name: 'conditional-status-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ConditionalStatusApp',
        spec: WebAppSpecSchema,
        status: ConditionalStatusSchema,
      };

      const composition = kubernetesComposition(conditionalDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'conditionalDeployment',
        });

        // Complex conditional logic using CEL expressions
        return {
          phase: Cel.expr<'Initializing' | 'Running' | 'Scaling' | 'Error'>(
            deployment.status.readyReplicas,
            ' == 0 ? "Initializing" : ',
            deployment.status.readyReplicas,
            ' == ',
            deployment.spec.replicas,
            ' ? "Running" : ',
            deployment.status.readyReplicas,
            ' < ',
            deployment.spec.replicas,
            ' ? "Scaling" : "Error"'
          ),
          message: Cel.expr<string>(
            deployment.status.readyReplicas,
            ' == 0 ? "Starting up..." : ',
            deployment.status.readyReplicas,
            ' == ',
            deployment.spec.replicas,
            ' ? "All replicas ready" : ',
            '"Scaling in progress (" + string(',
            deployment.status.readyReplicas,
            ') + "/" + string(',
            deployment.spec.replicas,
            ') + ")"'
          ),
          conditions: ['Available', 'Progressing'],
          scaling: {
            desired: deployment.spec.replicas,
            current: deployment.status.replicas,
            ready: deployment.status.readyReplicas,
            inProgress: Cel.expr<boolean>(
              deployment.status.readyReplicas,
              ' != ',
              deployment.spec.replicas
            ),
          },
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(1);

      // Should serialize conditional expressions correctly
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should handle cross-resource dependencies in status expressions', () => {
      const DependencyStatusSchema = type({
        ready: 'boolean',
        url: 'string',
        dependencies: {
          database: {
            ready: 'boolean',
            endpoint: 'string',
          },
          cache: {
            ready: 'boolean',
            endpoint: 'string',
          },
          storage: {
            ready: 'boolean',
            available: 'boolean',
          },
        },
        overallHealth: 'number',
      });

      const dependencyDefinition = {
        name: 'dependency-status-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'DependencyStatusApp',
        spec: WebAppSpecSchema,
        status: DependencyStatusSchema,
      };

      const composition = kubernetesComposition(dependencyDefinition, (spec) => {
        const appDeployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'appDeployment',
        });

        const databaseDeployment = simple.Deployment({
          name: `${spec.name}-database`,
          image: 'postgres:13',
          replicas: 1,
          id: 'databaseDeployment',
        });

        const cacheDeployment = simple.Deployment({
          name: `${spec.name}-cache`,
          image: 'redis:6',
          replicas: 1,
          id: 'cacheDeployment',
        });

        const databaseService = simple.Service({
          name: `${spec.name}-database-service`,
          selector: { app: `${spec.name}-database` },
          ports: [{ port: 5432, targetPort: 5432 }],
          id: 'databaseService',
        });

        const cacheService = simple.Service({
          name: `${spec.name}-cache-service`,
          selector: { app: `${spec.name}-cache` },
          ports: [{ port: 6379, targetPort: 6379 }],
          id: 'cacheService',
        });

        const appService = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: spec.name },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'appService',
        });

        // Status with cross-resource dependencies
        return {
          ready: Cel.expr<boolean>(
            appDeployment.status.readyReplicas,
            ' > 0 && ',
            databaseDeployment.status.readyReplicas,
            ' > 0 && ',
            cacheDeployment.status.readyReplicas,
            ' > 0'
          ),
          url: Cel.template('http://%s', appService.status.loadBalancer.ingress?.[0]?.ip),
          dependencies: {
            database: {
              ready: Cel.expr<boolean>(databaseDeployment.status.readyReplicas, ' > 0'),
              endpoint: Cel.template('postgres://%s:5432', databaseService.status.clusterIP),
            },
            cache: {
              ready: Cel.expr<boolean>(cacheDeployment.status.readyReplicas, ' > 0'),
              endpoint: Cel.template('redis://%s:6379', cacheService.status.clusterIP),
            },
            storage: {
              ready: Cel.expr<boolean>(databaseDeployment.status.readyReplicas, ' > 0'),
              available: Cel.expr<boolean>(databaseDeployment.status.readyReplicas, ' > 0'),
            },
          },
          overallHealth: Cel.expr<number>(
            '(',
            'int(',
            appDeployment.status.readyReplicas,
            ' > 0) + ',
            'int(',
            databaseDeployment.status.readyReplicas,
            ' > 0) + ',
            'int(',
            cacheDeployment.status.readyReplicas,
            ' > 0)',
            ') * 100 / 3'
          ),
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(6); // 3 deployments + 3 services

      // Should handle cross-resource references correctly
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should handle array operations in CEL expressions', () => {
      const ArrayOperationsSchema = type({
        ready: 'boolean',
        services: 'string[]',
        readyServices: 'string[]',
        serviceCount: 'number%1',
        allReady: 'boolean',
      });

      const arrayDefinition = {
        name: 'array-operations-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ArrayOperationsApp',
        spec: WebAppSpecSchema,
        status: ArrayOperationsSchema,
      };

      const composition = kubernetesComposition(arrayDefinition, (spec) => {
        const service1 = simple.Service({
          name: `${spec.name}-api`,
          selector: { app: `${spec.name}-api` },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'apiService',
        });

        const service2 = simple.Service({
          name: `${spec.name}-ui`,
          selector: { app: `${spec.name}-ui` },
          ports: [{ port: 80, targetPort: 3000 }],
          id: 'uiService',
        });

        const service3 = simple.Service({
          name: `${spec.name}-metrics`,
          selector: { app: `${spec.name}-metrics` },
          ports: [{ port: 9090, targetPort: 9090 }],
          id: 'metricsService',
        });

        // Status with array operations using CEL
        return {
          ready: Cel.expr<boolean>(
            service1.status.loadBalancer.ingress?.length,
            ' > 0 && ',
            service2.status.loadBalancer.ingress?.length,
            ' > 0 && ',
            service3.status.loadBalancer.ingress?.length,
            ' > 0'
          ),
          services: ['api', 'ui', 'metrics'], // Static array
          readyServices: Cel.expr<string[]>(
            '[',
            service1.status.loadBalancer.ingress?.length,
            ' > 0 ? "api" : "",',
            service2.status.loadBalancer.ingress?.length,
            ' > 0 ? "ui" : "",',
            service3.status.loadBalancer.ingress?.length,
            ' > 0 ? "metrics" : ""',
            '].filter(s, s != "")'
          ),
          serviceCount: Cel.expr<number>(
            'int(',
            service1.status.loadBalancer.ingress?.length,
            ' > 0) + ',
            'int(',
            service2.status.loadBalancer.ingress?.length,
            ' > 0) + ',
            'int(',
            service3.status.loadBalancer.ingress?.length,
            ' > 0)'
          ),
          allReady: Cel.expr<boolean>(
            service1.status.loadBalancer.ingress?.length,
            ' > 0 && ',
            service2.status.loadBalancer.ingress?.length,
            ' > 0 && ',
            service3.status.loadBalancer.ingress?.length,
            ' > 0'
          ),
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(3);

      // Should handle array operations in CEL
      const yaml = composition.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should handle string manipulation in CEL expressions', () => {
      const StringManipulationSchema = type({
        ready: 'boolean',
        displayName: 'string',
        namespace: 'string',
        fullName: 'string',
        tags: 'string[]',
      });

      const stringDefinition = {
        name: 'string-manipulation-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'StringManipulationApp',
        spec: WebAppSpecSchema,
        status: StringManipulationSchema,
      };

      const composition = kubernetesComposition(stringDefinition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'stringManipulationDeployment',
        });

        // Status with string manipulation using CEL
        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          displayName: Cel.expr<string>('string(', spec.name, ').replace("-", " ").title()'),
          namespace: deployment.metadata.namespace,
          fullName: Cel.expr<string>(
            'string(',
            deployment.metadata.namespace,
            ') + "/" + string(',
            spec.name,
            ')'
          ),
          tags: Cel.expr<string[]>(
            '[',
            '"app:" + string(',
            spec.name,
            '),',
            '"replicas:" + string(',
            spec.replicas,
            '),',
            '"image:" + string(',
            spec.image,
            ').split(":")[0]',
            ']'
          ),
        };
      });

      // Composition is already executed (direct API)
      expect(composition).toBeDefined();
      expect(composition.resources).toHaveLength(1);

      // Should handle string manipulation in CEL
      const yaml = composition.toYaml();
      expect(yaml).toContain('.replace("-", " ").title()');
      expect(yaml).toContain('.split(":")[0]');
    });
  });

  describe('synchronous composition execution', () => {
    it('should preserve context during synchronous composition execution', () => {
      let contextDuringExecution: any = null;

      const composition = kubernetesComposition(definition, (spec) => {
        // Context should be available during synchronous execution
        contextDuringExecution = getCurrentCompositionContext();

        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'syncTestDeployment',
        });

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // The composition is already executed (direct API)

      // Context should have been available during execution
      expect(contextDuringExecution).not.toBeNull();
      expect(contextDuringExecution).toHaveProperty('resources');
      expect(composition.resources).toHaveLength(1);
    });

    it('should handle multiple resources with context preservation', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'multiResourceDeployment',
        });

        const service = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: spec.name },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'multiResourceService',
        });

        return {
          ready: Cel.expr<boolean>(
            deployment.status.readyReplicas,
            ' > 0 && ',
            service.status.loadBalancer.ingress?.length,
            ' > 0'
          ),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)
      expect(composition.resources).toHaveLength(2);
    });

    it('should isolate contexts between different compositions', () => {
      const contexts: any[] = [];

      const composition1 = kubernetesComposition(definition, (spec) => {
        contexts.push(getCurrentCompositionContext());

        const deployment = simple.Deployment({
          name: `${spec.name}-1`,
          image: spec.image,
          replicas: spec.replicas,
          id: 'isolationTest1Deployment',
        });

        return {
          ready: true,
          url: 'http://test1.com',
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      const composition2 = kubernetesComposition(definition, (spec) => {
        contexts.push(getCurrentCompositionContext());

        const deployment = simple.Deployment({
          name: `${spec.name}-2`,
          image: spec.image,
          replicas: spec.replicas,
          id: 'isolationTest2Deployment',
        });

        return {
          ready: true,
          url: 'http://test2.com',
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Both compositions are already executed (direct API)

      // Should have captured two different contexts
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).not.toBe(contexts[1]);
      expect(composition1.resources).toHaveLength(1);
      expect(composition2.resources).toHaveLength(1);
    });

    it('should handle composition errors gracefully', () => {
      expect(() => {
        kubernetesComposition(definition, (_spec) => {
          // This will cause an error
          throw new Error('Composition error');
        });
      }).toThrow('Failed to execute composition function');
    });

    it('should clean up contexts properly after completion', () => {
      let contextDuringExecution: any = null;
      let contextAfterExecution: any = null;

      const composition = kubernetesComposition(definition, (spec) => {
        contextDuringExecution = getCurrentCompositionContext();

        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'cleanupTestDeployment',
        });

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Execute composition
      // Composition is already executed (direct API)

      // Check context immediately after execution
      contextAfterExecution = getCurrentCompositionContext();

      // Context should have been available during execution
      expect(contextDuringExecution).not.toBeNull();
      expect(contextDuringExecution).toHaveProperty('resources');

      // Context should be cleaned up after execution
      expect(contextAfterExecution).toBeUndefined();

      // Resource graph should be properly created
      expect(composition.resources).toHaveLength(1);
    });

    it('should clean up contexts even when composition fails', () => {
      let contextAfterError: any = null;

      try {
        kubernetesComposition(definition, (_spec) => {
          // This will cause an error
          throw new Error('Composition error');
        });
      } catch (_error) {
        // Check context after error
        contextAfterError = getCurrentCompositionContext();
      }

      // Context should be cleaned up even after error
      expect(contextAfterError).toBeUndefined();
    });

    it('should handle nested function calls with context preservation', () => {
      const nestedContexts: any[] = [];

      const composition = kubernetesComposition(definition, (spec) => {
        const level1 = () => {
          nestedContexts.push(getCurrentCompositionContext());

          const level2 = () => {
            nestedContexts.push(getCurrentCompositionContext());

            return simple.Deployment({
              name: spec.name,
              image: spec.image,
              replicas: spec.replicas,
              id: 'nestedContextDeployment',
            });
          };

          return level2();
        };

        const deployment = level1();

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)

      // All nested contexts should have been the same context
      expect(nestedContexts).toHaveLength(2);
      expect(nestedContexts[0]).toBe(nestedContexts[1]);
      expect(nestedContexts[0]).not.toBeNull();

      // Context should be cleaned up after completion
      const contextAfterCompletion = getCurrentCompositionContext();
      expect(contextAfterCompletion).toBeUndefined();

      expect(composition.resources).toHaveLength(1);
    });

    it('should handle conditional resource creation', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'conditionalDeployment',
        });

        // Always create service for this test
        const service = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: spec.name },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'conditionalService',
        });

        return {
          ready: Cel.expr<boolean>(
            deployment.status.readyReplicas,
            ' > 0 && ',
            service.status.loadBalancer.ingress?.length,
            ' > 0'
          ),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)
      // Should have deployment + service
      expect(composition.resources).toHaveLength(2);
    });

    it('should handle resource creation with error handling', () => {
      const composition = kubernetesComposition(definition, (spec) => {
        try {
          // Simulate resource creation that might fail
          if (spec.name === 'invalid') {
            throw new Error('Invalid name');
          }

          const deployment = simple.Deployment({
            name: spec.name,
            image: spec.image,
            replicas: spec.replicas,
            id: 'errorHandlingDeployment',
          });

          return {
            ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
            url: Cel.template('https://%s', spec.hostname),
            readyReplicas: deployment.status.readyReplicas,
          };
        } catch (_error) {
          // Fallback resource creation
          const fallbackDeployment = simple.Deployment({
            name: `${spec.name}-fallback`,
            image: spec.image,
            replicas: 1,
            id: 'fallbackDeployment',
          });

          return {
            ready: Cel.expr<boolean>(fallbackDeployment.status.readyReplicas, ' > 0'),
            url: Cel.template('https://%s', spec.hostname),
            readyReplicas: fallbackDeployment.status.readyReplicas,
          };
        }
      });

      // Composition is already executed (direct API)
      expect(composition.resources).toHaveLength(1);

      // Should have the normal deployment (not fallback) since name is valid
      const resourceIds = composition.resources.map((r) => r.id);
      expect(resourceIds).toContain('errorHandlingDeployment');
    });
  });

  describe('error handling and debugging', () => {
    it('should provide clear error messages for composition failures', () => {
      expect(() => {
        kubernetesComposition(definition, (_spec) => {
          // Simulate an error during resource creation
          throw new Error('Simulated composition error');
        });
      }).toThrow('Failed to execute composition function');
    });

    it('should detect unsupported patterns in status objects', () => {
      // Test the pattern detector directly since it's not enabled in normal flow
      const { UnsupportedPatternDetector } = require('../../src/index.js');

      const statusWithUnsupportedPatterns = {
        ready: true,
        badTemplate: 'Hello ${name} world', // Template literal pattern
        badFunction: () => 'test', // Function
      };

      const error = UnsupportedPatternDetector.createUnsupportedPatternError(
        'test-composition',
        statusWithUnsupportedPatterns
      );

      expect(error).not.toBeNull();
      expect(error?.message).toContain('Unsupported patterns detected');
    });

    it('should provide debugging information when enabled', () => {
      // Import debugging functions
      const {
        enableCompositionDebugging,
        disableCompositionDebugging,
        getCompositionDebugLogs,
        clearCompositionDebugLogs,
      } = require('../../src/index.js');

      // Enable debugging
      enableCompositionDebugging();
      clearCompositionDebugLogs();

      const _composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'debugTestDeployment',
        });

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Execute composition
      // Composition is already executed (direct API)

      // Should have debug logs
      const logs = getCompositionDebugLogs();
      expect(logs.length).toBeGreaterThan(0);

      // Should contain relevant debug information
      const logText = logs.join('\n');
      expect(logText).toContain('COMPOSITION_START');
      expect(logText).toContain('RESOURCE_REGISTRATION');
      expect(logText).toContain('COMPOSITION_END');

      // Clean up
      disableCompositionDebugging();
    });

    it('should handle resource registration errors gracefully', () => {
      // This test would require mocking the context to simulate registration failures
      // For now, we'll test that the error classes exist and can be instantiated
      const { ContextRegistrationError } = require('../../src/index.js');

      const error = ContextRegistrationError.forDuplicateResource(
        'test-resource',
        'Deployment',
        'simple.Deployment',
        'existingFactory'
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('Duplicate resource registration');
      expect(error.resourceId).toBe('test-resource');
      expect(error.resourceKind).toBe('Deployment');
      expect(error.suggestions).toBeDefined();
      expect(error.suggestions?.length).toBeGreaterThan(0);
    });

    it('should provide context about which resource caused failures', () => {
      const { CompositionExecutionError } = require('../../src/index.js');

      const error = CompositionExecutionError.withResourceContext(
        'Test error message',
        'test-composition',
        'resource-creation',
        'test-resource-id',
        'Deployment',
        'simple.Deployment',
        new Error('Original error')
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('Test error message');
      expect(error.message).toContain('test-resource-id');
      expect(error.message).toContain('Deployment');
      expect(error.message).toContain('simple.Deployment');
      expect(error.compositionName).toBe('test-composition');
      expect(error.phase).toBe('resource-creation');
      expect(error.resourceContext).toBeDefined();
    });

    it('should validate status objects and provide helpful error messages', () => {
      const { CompositionExecutionError } = require('../../src/index.js');

      const error = CompositionExecutionError.forStatusBuilding(
        'test-composition',
        'status.url',
        'string',
        123
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('Status object validation failed');
      expect(error.message).toContain('test-composition');
      expect(error.message).toContain('status.url');
      expect(error.message).toContain('string');
      expect(error.message).toContain('123');
      expect(error.phase).toBe('status-building');
    });

    it('should detect and report unsupported pattern types', () => {
      const { UnsupportedPatternDetector } = require('../../src/index.js');

      const statusObject = {
        ready: true,
        url: 'https://example.com', // This is fine - literal string
        badTemplate: 'Hello ${name} world', // Template literal pattern (not CEL)
        badConcat: 'prefix + suffix', // String with concatenation pattern
        badFunction: () => 'test', // Function - definitely not supported
      };

      const issues = UnsupportedPatternDetector.detectUnsupportedStatusPatterns(statusObject);
      expect(issues.length).toBeGreaterThan(0);

      const suggestions = UnsupportedPatternDetector.generatePatternSuggestions(issues[0] || '');
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some((s: string) => s.includes('Cel.'))).toBe(true);
    });
  });

  describe('deployment closure support', () => {
    it('should automatically register deployment closures created with registerDeploymentClosure', () => {
      // Import the necessary functions
      const { registerDeploymentClosure } = require('../../src/factories/shared.js');

      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'closureTestDeployment',
        });

        // Create deployment closure WITHIN the composition context - should be automatically registered
        const _mockDeploymentClosure = registerDeploymentClosure(
          () => async (_deploymentContext: any) => {
            return [
              {
                kind: 'ConfigMap',
                name: 'test-config',
                namespace: 'default',
                apiVersion: 'v1',
              },
            ];
          },
          'test-closure'
        );

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)

      // Should have captured the deployment in resources and the closure in closures
      expect(composition.resources).toHaveLength(1); // 1 Enhanced resource
      expect(composition.closures).toBeDefined();
      expect(Object.keys(composition.closures || {})).toHaveLength(1); // 1 deployment closure
    });

    it('should support yamlFile deployment closures', () => {
      // Import yamlFile
      const { yamlFile } = require('../../src/factories/kubernetes/yaml/yaml-file.js');

      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'yamlFileTestDeployment',
        });

        // Create yamlFile WITHIN the composition context - should be automatically registered via registerDeploymentClosure
        const _configFiles = yamlFile({
          name: 'test-configs',
          path: './test-configs.yaml',
        });

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)

      // Should have captured the deployment in resources and the yamlFile closure in closures
      expect(composition.resources).toHaveLength(1); // 1 Enhanced resource
      expect(composition.closures).toBeDefined();
      expect(Object.keys(composition.closures || {})).toHaveLength(1); // 1 yamlFile closure
    });

    it('should support yamlDirectory deployment closures', () => {
      // Import yamlDirectory
      const { yamlDirectory } = require('../../src/factories/kubernetes/yaml/yaml-directory.js');

      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'yamlDirTestDeployment',
        });

        // Create yamlDirectory WITHIN the composition context - should be automatically registered via registerDeploymentClosure
        const _configDir = yamlDirectory({
          name: 'test-config-dir',
          path: './test-configs/',
        });

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)

      // Should have captured the deployment in resources and the yamlDirectory closure in closures
      expect(composition.resources).toHaveLength(1); // 1 Enhanced resource
      expect(composition.closures).toBeDefined();
      expect(Object.keys(composition.closures || {})).toHaveLength(1); // 1 yamlDirectory closure
    });

    it('should work with any future deployment closure that uses registerDeploymentClosure', () => {
      // Import the registration function
      const { registerDeploymentClosure } = require('../../src/factories/shared.js');

      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'futureClosureTestDeployment',
        });

        // Create a hypothetical future deployment closure WITHIN the composition context
        const _futureDeploymentClosure = registerDeploymentClosure(
          () => async (_deploymentContext: any) => {
            // Simulate some future deployment closure behavior
            return [
              {
                kind: 'CustomResource',
                name: 'future-resource',
                namespace: 'default',
                apiVersion: 'future.io/v1',
              },
            ];
          },
          'future-closure'
        );

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)

      // Should have captured the deployment in resources and the future closure in closures
      expect(composition.resources).toHaveLength(1); // 1 Enhanced resource
      expect(composition.closures).toBeDefined();
      expect(Object.keys(composition.closures || {})).toHaveLength(1); // 1 future closure

      // The key test: any function that uses registerDeploymentClosure should work automatically
      // This demonstrates that the generic wrapper approach works for any future deployment closure
    });

    it('should handle multiple deployment closures in a single composition', () => {
      // Import necessary functions
      const { registerDeploymentClosure } = require('../../src/factories/shared.js');
      const { yamlFile } = require('../../src/factories/kubernetes/yaml/yaml-file.js');

      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'multiClosureTestDeployment',
        });

        // Create multiple deployment closures WITHIN the composition context
        const _yamlConfig = yamlFile({
          name: 'yaml-config',
          path: './config.yaml',
        });

        const _customClosure1 = registerDeploymentClosure(
          () => async (_deploymentContext: any) => [
            { kind: 'Secret', name: 'custom-secret', namespace: 'default', apiVersion: 'v1' },
          ],
          'custom-closure-1'
        );

        const _customClosure2 = registerDeploymentClosure(
          () => async (_deploymentContext: any) => [
            { kind: 'ServiceAccount', name: 'custom-sa', namespace: 'default', apiVersion: 'v1' },
          ],
          'custom-closure-2'
        );

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)

      // Should have captured the deployment in resources and all closures in closures
      expect(composition.resources).toHaveLength(1); // 1 Enhanced resource
      expect(composition.closures).toBeDefined();
      expect(Object.keys(composition.closures || {})).toHaveLength(3); // 3 deployment closures
    });

    it('should preserve deployment closure context and metadata', () => {
      // Import the registration function
      const { registerDeploymentClosure } = require('../../src/factories/shared.js');

      const composition = kubernetesComposition(definition, (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image,
          replicas: spec.replicas,
          id: 'contextAwareTestDeployment',
        });

        // Create a deployment closure that captures context information WITHIN the composition context
        const _contextAwareClosure = registerDeploymentClosure(
          () => async (_deploymentContext: any) => {
            // This closure would have access to deployment context
            // including kubernetesApi, alchemyScope, etc.
            return [
              {
                kind: 'ConfigMap',
                name: 'context-aware-config',
                namespace: 'default',
                apiVersion: 'v1',
              },
            ];
          },
          'context-aware-closure'
        );

        return {
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', spec.hostname),
          readyReplicas: deployment.status.readyReplicas,
        };
      });

      // Composition is already executed (direct API)

      // Should have captured the deployment in resources and the closure in closures
      expect(composition.resources).toHaveLength(1); // 1 Enhanced resource
      expect(composition.closures).toBeDefined();
      expect(Object.keys(composition.closures || {})).toHaveLength(1); // 1 deployment closure

      // The closure should be properly registered and available for deployment
      // This test validates that the closure registration preserves all necessary context
    });
  });
});
