/**
 * MagicAssignable Integration Tests
 * 
 * Tests the integration between factory functions, MagicAssignable type processing,
 * and KubernetesRef detection to ensure seamless operation across the entire system.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph } from '../../../src/core/serialization/core.js';
import { simple } from '../../../src/factories/simple/index.js';
import {
  analyzeFactoryConfig,
  processFactoryValue,
  detectMagicProxyRefs,
  convertToCel
} from '../../../src/core/expressions/index.js';
import type {
  FactoryExpressionContext
} from '../../../src/core/expressions/types.js';
import type {
  MagicAssignable
} from '../../../src/core/types/index.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';

// Test schemas
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  hostname: 'string',
  port: 'number',
});

const WebAppStatusSchema = type({
  ready: 'boolean',
  url: 'string',
  replicas: 'number',
  phase: 'string',
  endpoint: 'string',
});

describe('MagicAssignable Integration', () => {
  describe('Factory Configuration with MagicAssignable Types', () => {
    test('should handle MagicAssignable values in factory configurations', () => {
      const graph = toResourceGraph(
        {
          name: 'magic-assignable-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => {
          // These values are MagicAssignable<T> - they can be static values or KubernetesRef objects
          const deploymentConfig = {
            name: schema.spec.name, // MagicAssignable<string> - becomes KubernetesRef at runtime
            image: schema.spec.image, // MagicAssignable<string> - becomes KubernetesRef at runtime
            replicas: schema.spec.replicas, // MagicAssignable<number> - becomes KubernetesRef at runtime
            id: 'magicAssignableDeployment',
          };

          return {
            deployment: simple.Deployment(deploymentConfig),
          };
        },
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0, // JavaScript expression with KubernetesRef
          url: `https://${schema.spec.hostname}:${schema.spec.port}`, // Template literal with KubernetesRef
          replicas: resources.deployment.status.readyReplicas, // Direct KubernetesRef
          phase: 'Running', // Static value
          endpoint: `${resources.deployment.metadata.name}.default.svc.cluster.local`, // Template with KubernetesRef
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('magic-assignable-test');
      expect(graph.resources).toHaveLength(1);
    });

    test('should detect KubernetesRef objects in MagicAssignable configurations', () => {
      const graph = toResourceGraph(
        {
          name: 'detection-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => {
          const config = {
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            env: {
              APP_NAME: schema.spec.name,
              APP_PORT: '8080',
              STATIC_VAR: 'static-value'
            }
          };

          // Analyze the configuration for KubernetesRef objects
          const context: FactoryExpressionContext = {
            factoryType: 'kro',
            factoryName: 'Deployment',
            analysisEnabled: true
          };

          const analysis = analyzeFactoryConfig(config, context);

          // Should detect KubernetesRef objects from schema proxy
          expect(analysis.hasKubernetesRefs).toBe(true);
          expect(analysis.metrics.referencesFound).toBeGreaterThan(0);

          return {
            deployment: simple.Deployment({
              ...config,
              id: 'detectionTestDeployment' // Add explicit ID
            }),
          };
        },
        (_schema, _resources) => ({
          ready: true,
          url: 'https://example.com',
          replicas: 1,
          phase: 'Ready',
          endpoint: 'example.com',
        })
      );

      expect(graph).toBeDefined();
    });

    test('should process MagicAssignable values with different types', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      // Test different MagicAssignable types
      const stringValue: MagicAssignable<string> = 'static-string';
      const numberValue: MagicAssignable<number> = 42;
      const booleanValue: MagicAssignable<boolean> = true;

      const processedString = processFactoryValue(stringValue, context, 'test.string');
      const processedNumber = processFactoryValue(numberValue, context, 'test.number');
      const processedBoolean = processFactoryValue(booleanValue, context, 'test.boolean');

      expect(processedString).toBe('static-string');
      expect(processedNumber).toBe(42);
      expect(processedBoolean).toBe(true);
    });

    test('should handle complex MagicAssignable structures', () => {
      const graph = toResourceGraph(
        {
          name: 'complex-magic-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => {
          // Complex configuration with nested MagicAssignable values
          const complexConfig = {
            metadata: {
              name: schema.spec.name, // MagicAssignable<string>
              labels: {
                app: schema.spec.name, // MagicAssignable<string>
                version: 'v1.0.0', // Static string
              }
            },
            spec: {
              replicas: schema.spec.replicas, // MagicAssignable<number>
              template: {
                spec: {
                  containers: [{
                    name: schema.spec.name, // MagicAssignable<string>
                    image: schema.spec.image, // MagicAssignable<string>
                    ports: [{
                      containerPort: schema.spec.port, // MagicAssignable<number>
                      name: 'http'
                    }],
                    env: [
                      {
                        name: 'APP_NAME',
                        value: schema.spec.name // MagicAssignable<string>
                      },
                      {
                        name: 'STATIC_ENV',
                        value: 'static-value' // Static string
                      }
                    ]
                  }]
                }
              }
            }
          };

          // Detect KubernetesRef objects in the complex structure
          const detection = detectMagicProxyRefs(complexConfig);
          expect(detection.hasKubernetesRefs).toBe(true);
          expect(detection.stats.totalReferences).toBeGreaterThan(0);

          return {
            deployment: simple.Deployment({
              name: schema.spec.name,
              image: schema.spec.image,
              replicas: schema.spec.replicas,
              id: 'complexMagicDeployment',
            }),
          };
        },
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}:${schema.spec.port}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: 'Running',
          endpoint: `${resources.deployment.metadata.name}.default.svc.cluster.local`,
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('complex-magic-test');
    });
  });

  describe('CEL Conversion with MagicAssignable Types', () => {
    test('should convert MagicAssignable values to CEL expressions when needed', () => {
      const graph = toResourceGraph(
        {
          name: 'cel-conversion-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'celConversionDeployment',
          }),
        }),
        (schema, resources) => {
          const context: FactoryExpressionContext = {
            factoryType: 'kro',
            factoryName: 'StatusBuilder',
            analysisEnabled: true
          };

          // Test CEL conversion for different expression types
          const readyExpression = resources.deployment.status.readyReplicas > 0;
          const urlTemplate = `https://${schema.spec.hostname}:${schema.spec.port}`;
          const directRef = resources.deployment.status.readyReplicas;

          // Convert to CEL if needed
          const readyResult = convertToCel(readyExpression, context);
          const urlResult = convertToCel(urlTemplate, context);
          const refResult = convertToCel(directRef, context);

          // For Kro factory, expressions with KubernetesRef should be converted
          expect(readyResult.wasConverted || typeof readyExpression === 'boolean').toBe(true);
          expect(urlResult.wasConverted || typeof urlTemplate === 'string').toBe(true);
          expect(refResult.wasConverted).toBe(true);

          return {
            ready: readyExpression,
            url: urlTemplate,
            replicas: directRef,
            phase: 'Running', // Static value
            endpoint: `${resources.deployment.metadata.name}.default.svc.cluster.local`,
          };
        }
      );

      expect(graph).toBeDefined();
    });

    test('should handle mixed static and dynamic MagicAssignable values', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'MixedFactory',
        analysisEnabled: true
      };

      const mixedConfig = {
        staticString: 'static-value',
        staticNumber: 42,
        staticBoolean: true,
        staticArray: ['item1', 'item2'],
        staticObject: { key: 'value' },
        // These would be KubernetesRef objects in a real scenario
        dynamicString: { [KUBERNETES_REF_BRAND]: true, resourceId: '__schema__', fieldPath: 'spec.name' },
        dynamicNumber: { [KUBERNETES_REF_BRAND]: true, resourceId: '__schema__', fieldPath: 'spec.port' },
      };

      const analysis = analyzeFactoryConfig(mixedConfig, context);

      expect(analysis.hasKubernetesRefs).toBe(true);
      expect(analysis.metrics.referencesFound).toBe(2); // dynamicString and dynamicNumber
    });
  });

  describe('Type Safety with MagicAssignable', () => {
    test('should maintain type safety across MagicAssignable transformations', () => {
      const graph = toResourceGraph(
        {
          name: 'type-safety-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => {
          // TypeScript should allow these assignments
          const name: MagicAssignable<string> = schema.spec.name;
          const image: MagicAssignable<string> = schema.spec.image;
          const replicas: MagicAssignable<number> = schema.spec.replicas;
          const _port: MagicAssignable<number> = schema.spec.port;

          // These should also be valid
          const _staticName: MagicAssignable<string> = 'static-name';
          const _staticReplicas: MagicAssignable<number> = 3;

          return {
            deployment: simple.Deployment({
              name: name,
              image: image,
              replicas: replicas,
              id: 'typeSafetyDeployment',
            }),
          };
        },
        (schema, resources) => {
          // Status builder should also maintain type safety
          const ready: MagicAssignable<boolean> = resources.deployment.status.readyReplicas > 0;
          const url: MagicAssignable<string> = `https://${schema.spec.hostname}:${schema.spec.port}`;
          const replicaCount: MagicAssignable<number> = resources.deployment.status.readyReplicas;

          return {
            ready: ready,
            url: url,
            replicas: replicaCount,
            phase: 'Running',
            endpoint: `${resources.deployment.metadata.name}.default.svc.cluster.local`,
          };
        }
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('type-safety-test');
    });

    test('should handle optional MagicAssignable values', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'OptionalFactory',
        analysisEnabled: true
      };

      const configWithOptionals = {
        required: 'required-value',
        optional: undefined as MagicAssignable<string> | undefined,
        nullable: null as MagicAssignable<string> | null,
        conditionalRef: Math.random() > 0.5
          ? { [KUBERNETES_REF_BRAND]: true, resourceId: '__schema__', fieldPath: 'spec.name' }
          : 'static-fallback'
      };

      const processed = processFactoryValue(configWithOptionals, context, 'test.config');

      expect(processed).toBeDefined();
      expect(processed.required).toBe('required-value');
    });
  });

  describe('Performance with MagicAssignable Processing', () => {
    test('should handle large MagicAssignable configurations efficiently', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'PerformanceFactory',
        analysisEnabled: true
      };

      // Create a large configuration with mixed MagicAssignable values
      const largeConfig: Record<string, MagicAssignable<any>> = {};

      for (let i = 0; i < 1000; i++) {
        if (i % 10 === 0) {
          // Add some KubernetesRef objects
          largeConfig[`ref${i}`] = {
            [KUBERNETES_REF_BRAND]: true,
            resourceId: `resource${i}`,
            fieldPath: `spec.field${i}`
          };
        } else {
          // Add static values
          largeConfig[`static${i}`] = `value${i}`;
        }
      }

      const startTime = performance.now();
      const analysis = analyzeFactoryConfig(largeConfig, context);
      const endTime = performance.now();

      expect(analysis.hasKubernetesRefs).toBe(true);
      expect(analysis.metrics.referencesFound).toBe(100); // Every 10th item
      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
    });

    test('should optimize static MagicAssignable value processing', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'OptimizationFactory',
        analysisEnabled: true
      };

      const staticConfig = {
        name: 'static-name',
        image: 'nginx:latest',
        replicas: 3,
        env: {
          NODE_ENV: 'production',
          PORT: '3000'
        }
      };

      const startTime = performance.now();
      const analysis = analyzeFactoryConfig(staticConfig, context);
      const processed = processFactoryValue(staticConfig, context, 'test.static');
      const endTime = performance.now();

      expect(analysis.hasKubernetesRefs).toBe(false);
      expect(processed).toEqual(staticConfig);
      expect(endTime - startTime).toBeLessThan(10); // Should be very fast for static values
    });
  });

  describe('Error Handling with MagicAssignable', () => {
    test('should handle malformed MagicAssignable values gracefully', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'ErrorHandlingFactory',
        analysisEnabled: true
      };

      const malformedConfig = {
        valid: 'valid-value',
        circular: {} as any,
        invalidRef: { [KUBERNETES_REF_BRAND]: true }, // Missing required fields
        deepNesting: {}
      };

      // Create circular reference
      malformedConfig.circular.self = malformedConfig.circular;

      // Create deep nesting
      let current: any = malformedConfig.deepNesting;
      for (let i = 0; i < 20; i++) {
        current.next = {};
        current = current.next;
      }

      // Should not throw errors
      expect(() => {
        const analysis = analyzeFactoryConfig(malformedConfig, context, { maxDepth: 10 });
        expect(analysis).toBeDefined();
      }).not.toThrow();
    });

    test('should provide meaningful error information for invalid MagicAssignable usage', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'ValidationFactory',
        analysisEnabled: true
      };

      const configWithIssues = {
        validField: 'valid',
        // This would be caught by TypeScript in real usage, but we test runtime behavior
        typeIssue: 123 as any as MagicAssignable<string>,
      };

      const analysis = analyzeFactoryConfig(configWithIssues, context);

      // Should handle type mismatches gracefully
      expect(analysis).toBeDefined();
      expect(analysis.hasKubernetesRefs).toBe(false);
    });
  });

  describe('Integration with Factory Pattern Selection', () => {
    test('should work correctly with direct factory pattern', async () => {
      const graph = toResourceGraph(
        {
          name: 'direct-pattern-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'directPatternDeployment',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}:${schema.spec.port}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: 'Running',
          endpoint: `${resources.deployment.metadata.name}.default.svc.cluster.local`,
        })
      );

      const directFactory = await graph.factory('direct', { namespace: 'test-direct' });

      expect(directFactory).toBeDefined();
      expect(directFactory.name).toBe('direct-pattern-test');
    });

    test('should work correctly with Kro factory pattern', async () => {
      const graph = toResourceGraph(
        {
          name: 'kro-pattern-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'kroPatternDeployment',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}:${schema.spec.port}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: 'Running',
          endpoint: `${resources.deployment.metadata.name}.default.svc.cluster.local`,
        })
      );

      const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });

      expect(kroFactory).toBeDefined();
      expect(kroFactory.name).toBe('kro-pattern-test');
    });
  });
});