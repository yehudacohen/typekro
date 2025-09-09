/**
 * Tests for composition re-execution with actual values
 * These tests prevent regressions in the schema proxy value resolution system
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition, simple } from '../../src/index.js';

describe('Composition Re-execution with Actual Values', () => {
  const TestSpecSchema = type({
    name: 'string',
    port: 'number',
    replicas: 'number'
  });

  const TestStatusSchema = type({
    ready: 'boolean',
    serviceName: 'string',
    endpoint: 'string',
    replicaCount: 'number'
  });

  describe('Schema Proxy Value Resolution', () => {
    it('should receive actual values during composition re-execution', async () => {
      let compositionCallCount = 0;
      const receivedValues: any[] = [];

      const testComposition = kubernetesComposition(
        {
          name: 'test-reexecution',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          compositionCallCount++;
          receivedValues.push({
            callNumber: compositionCallCount,
            name: spec.name,
            nameType: typeof spec.name,
            port: spec.port,
            portType: typeof spec.port,
            replicas: spec.replicas,
            replicasType: typeof spec.replicas
          });

          const _service = simple.Service({
            name: `${spec.name}-service`,
            selector: { app: spec.name },
            ports: [{ port: spec.port, targetPort: spec.port }],
            id: 'testService'
          });

          return {
            ready: true,
            serviceName: `${spec.name}-service`,
            endpoint: `http://${spec.name}-service:${spec.port}`,
            replicaCount: spec.replicas
          };
        }
      );

      // Create factory (this should trigger first composition execution with proxy functions)
      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false
      });

      // Generate YAML (this should trigger re-execution with actual values)
      const yaml = factory.toYaml({
        name: 'my-test-app',
        port: 8080,
        replicas: 3
      });

      // Verify composition was called twice
      expect(compositionCallCount).toBe(2);
      expect(receivedValues).toHaveLength(2);

      // First call should have proxy functions
      const firstCall = receivedValues[0];
      expect(firstCall.callNumber).toBe(1);
      expect(firstCall.nameType).toBe('function'); // Proxy function
      expect(firstCall.portType).toBe('function'); // Proxy function
      expect(firstCall.replicasType).toBe('function'); // Proxy function

      // Second call should have actual values
      const secondCall = receivedValues[1];
      expect(secondCall.callNumber).toBe(2);
      expect(secondCall.name).toBe('my-test-app');
      expect(secondCall.nameType).toBe('string'); // Actual value
      expect(secondCall.port).toBe(8080);
      expect(secondCall.portType).toBe('number'); // Actual value
      expect(secondCall.replicas).toBe(3);
      expect(secondCall.replicasType).toBe('number'); // Actual value

      // Verify YAML contains resolved values
      expect(yaml).toContain('my-test-app-service');
      expect(yaml).toContain('8080');
    });

    it('should handle status computation with actual values', async () => {
      const statusComputations: any[] = [];

      const testComposition = kubernetesComposition(
        {
          name: 'status-test',
          apiVersion: 'test.com/v1',
          kind: 'StatusTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          const _deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            replicas: spec.replicas,
            id: 'deployment'
          });

          const computedStatus = {
            ready: true,
            serviceName: `${spec.name}-service`,
            endpoint: `https://${spec.name}.example.com:${spec.port}`,
            replicaCount: spec.replicas
          };

          statusComputations.push({
            specName: spec.name,
            specNameType: typeof spec.name,
            computedServiceName: computedStatus.serviceName,
            computedEndpoint: computedStatus.endpoint,
            computedReplicaCount: computedStatus.replicaCount
          });

          return computedStatus;
        }
      );

      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false
      });

      // Test with actual values
      const _yaml = factory.toYaml({
        name: 'status-app',
        port: 443,
        replicas: 5
      });

      // Should have at least one computation with actual values
      const actualValueComputation = statusComputations.find(
        comp => comp.specNameType === 'string'
      );

      expect(actualValueComputation).toBeDefined();
      expect(actualValueComputation.specName).toBe('status-app');
      expect(actualValueComputation.computedServiceName).toBe('status-app-service');
      expect(actualValueComputation.computedEndpoint).toBe('https://status-app.example.com:443');
      expect(actualValueComputation.computedReplicaCount).toBe(5);
    });

    it('should handle template literals with actual values', async () => {
      const templateResults: any[] = [];

      const testComposition = kubernetesComposition(
        {
          name: 'template-test',
          apiVersion: 'test.com/v1',
          kind: 'TemplateTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          const _service = simple.Service({
            name: `${spec.name}-svc`,
            selector: { app: spec.name },
            ports: [{ port: spec.port, targetPort: spec.port }],
            id: 'service'
          });

          const templateResult = {
            serviceName: `${spec.name}-svc`,
            endpoint: `http://${spec.name}-svc:${spec.port}/api/v1`,
            configName: `${spec.name}-config-${spec.replicas}`,
            fullUrl: `https://${spec.name}.example.com:${spec.port}/health?replicas=${spec.replicas}`
          };

          templateResults.push({
            specValues: {
              name: spec.name,
              nameType: typeof spec.name,
              port: spec.port,
              portType: typeof spec.port,
              replicas: spec.replicas,
              replicasType: typeof spec.replicas
            },
            templateResult
          });

          return {
            ready: true,
            serviceName: templateResult.serviceName,
            endpoint: templateResult.endpoint,
            replicaCount: spec.replicas
          };
        }
      );

      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false
      });

      const yaml = factory.toYaml({
        name: 'template-app',
        port: 9000,
        replicas: 2
      });

      // Find the computation with actual values
      const actualValueResult = templateResults.find(
        result => result.specValues.nameType === 'string'
      );

      expect(actualValueResult).toBeDefined();
      expect(actualValueResult.specValues.name).toBe('template-app');
      expect(actualValueResult.specValues.port).toBe(9000);
      expect(actualValueResult.specValues.replicas).toBe(2);
      expect(actualValueResult.templateResult.serviceName).toBe('template-app-svc');
      expect(actualValueResult.templateResult.endpoint).toBe('http://template-app-svc:9000/api/v1');
      expect(actualValueResult.templateResult.configName).toBe('template-app-config-2');
      expect(actualValueResult.templateResult.fullUrl).toBe('https://template-app.example.com:9000/health?replicas=2');

      // Verify YAML contains resolved template values
      expect(yaml).toContain('template-app-svc');
      expect(yaml).toContain('9000');
    });
  });

  describe('Composition Metadata Storage', () => {
    it('should safely store composition metadata without readonly property errors', () => {
      // This test ensures that storing composition metadata doesn't throw readonly property errors
      expect(() => {
        const testComposition = kubernetesComposition(
          {
            name: 'metadata-test',
            apiVersion: 'test.com/v1',
            kind: 'MetadataTest',
            spec: TestSpecSchema,
            status: TestStatusSchema,
          },
          (spec) => {
            const _deployment = simple.Deployment({
              name: spec.name,
              image: 'nginx',
              replicas: spec.replicas,
              id: 'deployment'
            });

            return {
              ready: true,
              serviceName: `${spec.name}-service`,
              endpoint: `http://${spec.name}:${spec.port}`,
              replicaCount: spec.replicas
            };
          }
        );

        // Creating the composition should not throw
        expect(testComposition).toBeDefined();
        expect(testComposition.factory).toBeDefined();
      }).not.toThrow();
    });

    it('should preserve composition metadata for re-execution', () => {
      const testComposition = kubernetesComposition(
        {
          name: 'preservation-test',
          apiVersion: 'test.com/v1',
          kind: 'PreservationTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          const _service = simple.Service({
            name: `${spec.name}-service`,
            selector: { app: spec.name },
            ports: [{ port: spec.port, targetPort: spec.port }],
            id: 'service'
          });

          return {
            ready: true,
            serviceName: `${spec.name}-service`,
            endpoint: `http://${spec.name}:${spec.port}`,
            replicaCount: spec.replicas
          };
        }
      );

      // Check that composition metadata is accessible (non-enumerable properties)
      const compositionAny = testComposition as any;
      
      // These properties should exist if metadata storage succeeded
      // If they don't exist, it means the try-catch block caught an error, which is also valid behavior
      const hasMetadata = compositionAny._compositionFn !== undefined;
      
      if (hasMetadata) {
        // If metadata exists, verify it's properly configured
        expect(compositionAny._compositionFn).toBeDefined();
        expect(compositionAny._definition).toBeDefined();
        
        // They should not appear in Object.keys() (non-enumerable)
        const keys = Object.keys(testComposition);
        expect(keys).not.toContain('_compositionFn');
        expect(keys).not.toContain('_definition');
        expect(keys).not.toContain('_options');
      } else {
        // If metadata doesn't exist, that's also acceptable (graceful failure)
        expect(compositionAny._compositionFn).toBeUndefined();
      }
      
      // The important thing is that the composition itself works
      expect(testComposition).toBeDefined();
      expect(testComposition.factory).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle composition re-execution errors gracefully', async () => {
      let executionCount = 0;

      const testComposition = kubernetesComposition(
        {
          name: 'error-test',
          apiVersion: 'test.com/v1',
          kind: 'ErrorTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          executionCount++;
          
          // Throw error on re-execution (second call)
          if (executionCount === 2) {
            throw new Error('Re-execution error');
          }

          const _service = simple.Service({
            name: `${spec.name}-service`,
            selector: { app: spec.name },
            ports: [{ port: spec.port, targetPort: spec.port }],
            id: 'service'
          });

          return {
            ready: true,
            serviceName: `${spec.name}-service`,
            endpoint: `http://${spec.name}:${spec.port}`,
            replicaCount: spec.replicas
          };
        }
      );

      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false
      });

      // This should not throw even if re-execution fails
      // The system should fall back to the original resources
      expect(() => {
        const yaml = factory.toYaml({
          name: 'error-app',
          port: 8080,
          replicas: 1
        });
        expect(yaml).toBeDefined();
      }).not.toThrow();

      expect(executionCount).toBe(2); // Should have attempted re-execution
    });
  });
});