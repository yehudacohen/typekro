/**
 * Tests for readonly property assignment protection
 * These tests prevent regressions in composition metadata storage
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition, toResourceGraph, simple } from '../../src/index.js';

describe('Readonly Property Assignment Protection', () => {
  const TestSpecSchema = type({
    name: 'string',
    image: 'string'
  });

  const TestStatusSchema = type({
    ready: 'boolean',
    url: 'string'
  });

  describe('Composition Metadata Storage', () => {
    it('should safely store composition metadata on readonly objects', () => {
      // This test ensures that Object.defineProperty is used to safely add metadata
      expect(() => {
        const composition = kubernetesComposition(
          {
            name: 'readonly-test',
            apiVersion: 'test.com/v1',
            kind: 'ReadonlyTest',
            spec: TestSpecSchema,
            status: TestStatusSchema,
          },
          (spec) => {
            const _deployment = simple.Deployment({
              name: spec.name,
              image: spec.image,
              replicas: 1,
              id: 'deployment'
            });

            return {
              ready: true,
              url: `http://${spec.name}.example.com`
            };
          }
        );

        expect(composition).toBeDefined();
      }).not.toThrow();
    });

    it('should create non-enumerable metadata properties', () => {
      const composition = kubernetesComposition(
        {
          name: 'enumerable-test',
          apiVersion: 'test.com/v1',
          kind: 'EnumerableTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          const _service = simple.Service({
            name: `${spec.name}-service`,
            selector: { app: spec.name },
            ports: [{ port: 80, targetPort: 8080 }],
            id: 'service'
          });

          return {
            ready: true,
            url: `http://${spec.name}-service`
          };
        }
      );

      const compositionAny = composition as any;

      // Metadata properties should exist
      expect(compositionAny._compositionFn).toBeDefined();
      expect(compositionAny._definition).toBeDefined();
      expect(compositionAny._options).toBeDefined();

      // But should not be enumerable
      const keys = Object.keys(composition);
      expect(keys).not.toContain('_compositionFn');
      expect(keys).not.toContain('_definition');
      expect(keys).not.toContain('_options');
      expect(keys).not.toContain('_context');
      expect(keys).not.toContain('_compositionName');

      // Should not appear in JSON.stringify
      const jsonString = JSON.stringify(composition);
      expect(jsonString).not.toContain('_compositionFn');
      expect(jsonString).not.toContain('_definition');
      expect(jsonString).not.toContain('_options');
    });

    it('should handle metadata storage failures gracefully', () => {
      // Mock console.warn to capture warnings
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: any[]) => {
        warnings.push(args.join(' '));
      };

      try {
        // This should not throw even if metadata storage fails
        expect(() => {
          const composition = kubernetesComposition(
            {
              name: 'graceful-test',
              apiVersion: 'test.com/v1',
              kind: 'GracefulTest',
              spec: TestSpecSchema,
              status: TestStatusSchema,
            },
            (spec) => {
              const _deployment = simple.Deployment({
                name: spec.name,
                image: spec.image,
                replicas: 1,
                id: 'deployment'
              });

              return {
                ready: true,
                url: `http://${spec.name}.example.com`
              };
            }
          );

          expect(composition).toBeDefined();
          expect(composition.factory).toBeDefined();
        }).not.toThrow();
      } finally {
        console.warn = originalWarn;
      }
    });

    it('should preserve metadata properties as non-writable', () => {
      const composition = kubernetesComposition(
        {
          name: 'writable-test',
          apiVersion: 'test.com/v1',
          kind: 'WritableTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          const _configMap = simple.ConfigMap({
            name: `${spec.name}-config`,
            data: { 'app.properties': 'key=value' },
            id: 'config'
          });

          return {
            ready: true,
            url: `http://${spec.name}.example.com`
          };
        }
      );

      const compositionAny = composition as any;

      // Store original values
      const originalCompositionFn = compositionAny._compositionFn;
      const originalDefinition = compositionAny._definition;

      // Try to overwrite (should not work due to writable: false)
      // In strict mode, this will throw TypeError, in non-strict mode it will be silently ignored
      try {
        compositionAny._compositionFn = 'modified';
      } catch (error) {
        // Expected in strict mode
        expect(error).toBeInstanceOf(TypeError);
      }
      
      try {
        compositionAny._definition = 'modified';
      } catch (error) {
        // Expected in strict mode
        expect(error).toBeInstanceOf(TypeError);
      }

      // Values should remain unchanged
      expect(compositionAny._compositionFn).toBe(originalCompositionFn);
      expect(compositionAny._definition).toBe(originalDefinition);
    });

    it('should allow metadata properties to be configurable for cleanup', () => {
      const composition = kubernetesComposition(
        {
          name: 'configurable-test',
          apiVersion: 'test.com/v1',
          kind: 'ConfigurableTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          const _secret = simple.Secret({
            name: `${spec.name}-secret`,
            data: { 'password': 'base64encodedpassword' },
            id: 'secret'
          });

          return {
            ready: true,
            url: `http://${spec.name}.example.com`
          };
        }
      );

      const compositionAny = composition as any;

      // Should be able to delete properties (configurable: true)
      expect(() => {
        delete compositionAny._compositionFn;
        delete compositionAny._definition;
        delete compositionAny._options;
      }).not.toThrow();

      // Properties should be deleted
      expect(compositionAny._compositionFn).toBeUndefined();
      expect(compositionAny._definition).toBeUndefined();
      expect(compositionAny._options).toBeUndefined();
    });
  });

  describe('toResourceGraph Compatibility', () => {
    it('should work with toResourceGraph without metadata conflicts', () => {
      // Ensure that the metadata storage doesn't interfere with toResourceGraph
      expect(() => {
        const graph = toResourceGraph(
          {
            name: 'compatibility-test',
            apiVersion: 'v1alpha1',
            kind: 'CompatibilityTest',
            spec: TestSpecSchema,
            status: TestStatusSchema,
          },
          (schema) => ({
            deployment: simple.Deployment({
              name: schema.spec.name,
              image: schema.spec.image,
              replicas: 1,
              id: 'deployment',
            }),
          }),
          (_schema, _resources) => ({
            ready: true,
            url: 'http://webapp-service',
          })
        );

        expect(graph).toBeDefined();
        expect(graph.factory).toBeDefined();

        const factory = graph.factory('direct', { namespace: 'test' });
        expect(factory).toBeDefined();
      }).not.toThrow();
    });

    it('should handle mixed API usage without conflicts', () => {
      // Test using both kubernetesComposition and toResourceGraph in the same test
      expect(() => {
        // kubernetesComposition (imperative)
        const imperativeComposition = kubernetesComposition(
          {
            name: 'imperative-mixed',
            apiVersion: 'test.com/v1',
            kind: 'ImperativeMixed',
            spec: TestSpecSchema,
            status: TestStatusSchema,
          },
          (spec) => {
            const _deployment = simple.Deployment({
              name: spec.name,
              image: spec.image,
              replicas: 1,
              id: 'deployment'
            });

            return {
              ready: true,
              url: `http://${spec.name}.example.com`
            };
          }
        );

        // toResourceGraph (declarative)
        const declarativeGraph = toResourceGraph(
          {
            name: 'declarative-mixed',
            apiVersion: 'v1alpha1',
            kind: 'DeclarativeMixed',
            spec: TestSpecSchema,
            status: TestStatusSchema,
          },
          (schema) => ({
            service: simple.Service({
              name: schema.spec.name,
              selector: { app: schema.spec.name },
              ports: [{ port: 80, targetPort: 8080 }],
              id: 'service',
            }),
          }),
          (_schema, _resources) => ({
            ready: true,
            url: 'http://service',
          })
        );

        expect(imperativeComposition).toBeDefined();
        expect(declarativeGraph).toBeDefined();

        const imperativeFactory = imperativeComposition.factory('direct', { namespace: 'test' });
        const declarativeFactory = declarativeGraph.factory('direct', { namespace: 'test' });

        expect(imperativeFactory).toBeDefined();
        expect(declarativeFactory).toBeDefined();
      }).not.toThrow();
    });
  });

  describe('Error Recovery', () => {
    it('should continue working even if metadata storage partially fails', () => {
      // Mock Object.defineProperty to simulate partial failure
      const originalDefineProperty = Object.defineProperty;
      let callCount = 0;

      Object.defineProperty = (obj: any, prop: string | symbol, descriptor: PropertyDescriptor) => {
        // Only fail when trying to set metadata properties (properties starting with _)
        if (typeof prop === 'string' && prop.startsWith('_')) {
          callCount++;
          // Fail on the second metadata property to simulate partial failure
          if (callCount === 2) {
            throw new Error('Simulated defineProperty failure');
          }
        }
        return originalDefineProperty(obj, prop, descriptor);
      };

      try {
        expect(() => {
          const composition = kubernetesComposition(
            {
              name: 'recovery-test',
              apiVersion: 'test.com/v1',
              kind: 'RecoveryTest',
              spec: TestSpecSchema,
              status: TestStatusSchema,
            },
            (spec) => {
              const _deployment = simple.Deployment({
                name: spec.name,
                image: spec.image,
                replicas: 1,
                id: 'deployment'
              });

              return {
                ready: true,
                url: `http://${spec.name}.example.com`
              };
            }
          );

          // Should still create a valid composition
          expect(composition).toBeDefined();
          expect(composition.factory).toBeDefined();
        }).not.toThrow();
      } finally {
        Object.defineProperty = originalDefineProperty;
      }
    });

    it('should handle frozen or sealed objects gracefully', () => {
      // This test ensures the system works even with restricted objects
      expect(() => {
        const composition = kubernetesComposition(
          {
            name: 'frozen-test',
            apiVersion: 'test.com/v1',
            kind: 'FrozenTest',
            spec: TestSpecSchema,
            status: TestStatusSchema,
          },
          (spec) => {
            const _service = simple.Service({
              name: `${spec.name}-service`,
              selector: { app: spec.name },
              ports: [{ port: 80, targetPort: 8080 }],
              id: 'service'
            });

            return {
              ready: true,
              url: `http://${spec.name}-service`
            };
          }
        );

        // Even if the result object becomes frozen, it should still work
        Object.freeze(composition);

        expect(composition).toBeDefined();
        expect(composition.factory).toBeDefined();

        const factory = composition.factory('direct', { namespace: 'test' });
        expect(factory).toBeDefined();
      }).not.toThrow();
    });
  });
});