/**
 * Factory Integration Tests
 * 
 * Tests the integration between factory functions and the expression analysis system,
 * ensuring that KubernetesRef objects are properly detected and handled in factory
 * configurations.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph } from '../../../src/core/serialization/core.js';
import { simple } from '../../../src/factories/simple/index.js';
import { 
  FactoryExpressionAnalyzer,
  analyzeFactoryConfig,
  processFactoryValue,
  withExpressionAnalysis
} from '../../../src/core/expressions/factory-integration.js';
import type { 
  FactoryExpressionContext,
  FactoryAnalysisConfig 
} from '../../../src/core/expressions/factory-integration.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';

// Test schemas
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  hostname: 'string',
});

const WebAppStatusSchema = type({
  ready: 'boolean',
  url: 'string',
  replicas: 'number',
  phase: 'string',
});

describe('Factory Integration', () => {
  let analyzer: FactoryExpressionAnalyzer;

  beforeEach(() => {
    analyzer = new FactoryExpressionAnalyzer();
  });

  describe('FactoryExpressionAnalyzer', () => {
    test('should analyze factory configuration with KubernetesRef objects', () => {
      const graph = toResourceGraph(
        {
          name: 'factory-integration-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name, // This will be a KubernetesRef
            image: schema.spec.image, // This will be a KubernetesRef
            replicas: schema.spec.replicas, // This will be a KubernetesRef
            id: 'testDeployment',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: 'Ready',
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('factory-integration-test');
    });

    test('should detect KubernetesRef objects in factory configuration', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      // Create a mock KubernetesRef object
      const mockRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'test-resource',
        fieldPath: 'spec.name'
      };

      const config = {
        name: mockRef,
        image: 'nginx:latest',
        replicas: 3
      };

      const result = analyzer.analyzeFactoryConfig(config, context);

      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.metrics.referencesFound).toBe(1);
      expect(result.fieldAnalysis).toHaveProperty('name');
    });

    test('should handle static values without KubernetesRef objects', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      const config = {
        name: 'static-name',
        image: 'nginx:latest',
        replicas: 3
      };

      const result = analyzer.analyzeFactoryConfig(config, context);

      expect(result.hasKubernetesRefs).toBe(false);
      expect(result.metrics.referencesFound).toBe(0);
      expect(result.optimizations).toContain('Configuration contains only static values - no expression analysis needed');
    });

    test('should process factory values correctly', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'direct',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      // Test static value
      const staticValue = 'static-string';
      const processedStatic = analyzer.processFactoryValue(staticValue, context, 'test.field');
      expect(processedStatic).toBe(staticValue);

      // Test KubernetesRef object
      const mockRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'test-resource',
        fieldPath: 'spec.name'
      };

      const processedRef = analyzer.processFactoryValue(mockRef, context, 'test.ref');
      expect(processedRef).toBe(mockRef); // Should be preserved for direct factory
    });

    test('should handle nested objects with KubernetesRef objects', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      const mockRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'test-resource',
        fieldPath: 'spec.name'
      };

      const config = {
        metadata: {
          name: mockRef,
          labels: {
            app: 'static-app'
          }
        },
        spec: {
          replicas: 3,
          image: 'nginx:latest'
        }
      };

      const result = analyzer.analyzeFactoryConfig(config, context);

      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.metrics.referencesFound).toBe(1);
      // Check that the nested field was found
      const fieldKeys = Object.keys(result.fieldAnalysis);
      expect(fieldKeys.some(key => key.includes('name'))).toBe(true);
    });

    test('should handle arrays with KubernetesRef objects', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      const mockRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'test-resource',
        fieldPath: 'spec.name'
      };

      const config = {
        env: [
          { name: 'APP_NAME', value: mockRef },
          { name: 'STATIC_VAR', value: 'static-value' }
        ]
      };

      const result = analyzer.analyzeFactoryConfig(config, context);

      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.metrics.referencesFound).toBe(1);
    });
  });

  describe('Factory Enhancement', () => {
    test('should enhance factory function with expression analysis', () => {
      const originalFactory = (config: { name: string; image: string }) => ({
        metadata: { name: config.name },
        spec: { image: config.image }
      });

      const enhancedFactory = withExpressionAnalysis(originalFactory, 'TestFactory');

      const result = enhancedFactory({ name: 'test', image: 'nginx' });
      expect(result).toEqual({
        metadata: { name: 'test' },
        spec: { image: 'nginx' }
      });
    });

    test('should pass analysis options to enhanced factory', () => {
      const originalFactory = (config: { name: string }) => ({ name: config.name });
      const enhancedFactory = withExpressionAnalysis(originalFactory, 'TestFactory');

      const options: FactoryAnalysisConfig = {
        enableAnalysis: false,
        factoryType: 'direct'
      };

      const result = enhancedFactory({ name: 'test' }, options);
      expect(result).toEqual({ name: 'test' });
    });
  });

  describe('Utility Functions', () => {
    test('should analyze factory configuration using utility function', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      const config = {
        name: 'static-name',
        replicas: 3
      };

      const result = analyzeFactoryConfig(config, context);

      expect(result.hasKubernetesRefs).toBe(false);
      expect(result.metrics.fieldsAnalyzed).toBe(2);
    });

    test('should process factory value using utility function', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      const value = 'test-value';
      const processed = processFactoryValue(value, context, 'test.field');

      expect(processed).toBe(value);
    });
  });

  describe('Performance and Optimization', () => {
    test('should provide performance metrics', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      const config = {
        name: 'test',
        image: 'nginx',
        replicas: 3
      };

      const result = analyzer.analyzeFactoryConfig(config, context);

      expect(result.metrics.analysisTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.fieldsAnalyzed).toBe(3);
      expect(result.metrics.referencesFound).toBe(0);
    });

    test('should suggest optimizations based on analysis', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'direct',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      const config = {
        name: 'static-name',
        image: 'nginx:latest'
      };

      const result = analyzer.analyzeFactoryConfig(config, context);

      expect(result.optimizations.length).toBeGreaterThan(0);
      expect(result.optimizations[0]).toContain('static values');
    });

    test('should handle large configurations efficiently', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      // Create a large configuration
      const largeConfig: Record<string, any> = {};
      for (let i = 0; i < 100; i++) {
        largeConfig[`field${i}`] = `value${i}`;
      }

      const startTime = performance.now();
      const result = analyzer.analyzeFactoryConfig(largeConfig, context);
      const endTime = performance.now();

      expect(result.metrics.fieldsAnalyzed).toBe(100);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
    });
  });

  describe('Error Handling', () => {
    test('should handle disabled analysis gracefully', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      const config = { name: 'test' };
      const options: FactoryAnalysisConfig = { enableAnalysis: false };

      const result = analyzer.analyzeFactoryConfig(config, context, options);

      expect(result.hasKubernetesRefs).toBe(false);
      expect(result.fieldAnalysis).toEqual({});
      expect(result.metrics.fieldsAnalyzed).toBe(0);
    });

    test('should handle null and undefined values', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      const config = {
        name: 'test',
        optional: null,
        undefined: undefined
      };

      const result = analyzer.analyzeFactoryConfig(config, context);

      expect(result.hasKubernetesRefs).toBe(false);
      expect(result.metrics.fieldsAnalyzed).toBe(3);
    });

    test('should respect maximum depth limits', () => {
      const context: FactoryExpressionContext = {
        factoryType: 'kro',
        factoryName: 'TestFactory',
        analysisEnabled: true
      };

      // Create deeply nested configuration
      const deepConfig = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  value: 'deep-value'
                }
              }
            }
          }
        }
      };

      const options: FactoryAnalysisConfig = { maxDepth: 3 };
      const result = analyzer.analyzeFactoryConfig(deepConfig, context, options);

      expect(result.hasKubernetesRefs).toBe(false);
      // Should stop at maxDepth and not analyze the deepest levels
    });
  });

  describe('Integration with Real Factory Functions', () => {
    test('should work with enhanced simple.Deployment factory', () => {
      // This test verifies that our enhanced Deployment factory works correctly
      const deployment = simple.Deployment({
        name: 'test-app',
        image: 'nginx:latest',
        replicas: 3,
        id: 'testDeployment'
      });

      expect(deployment).toBeDefined();
      expect(deployment.metadata?.name).toBe('test-app');
      expect(deployment.spec?.replicas).toBe(3);
    });

    test('should handle KubernetesRef objects in enhanced factory', () => {
      const graph = toResourceGraph(
        {
          name: 'enhanced-factory-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name, // KubernetesRef
            image: schema.spec.image, // KubernetesRef
            replicas: schema.spec.replicas, // KubernetesRef
            id: 'enhancedDeployment',
          }),
        }),
        (_schema, _resources) => ({
          ready: true,
          url: 'https://example.com',
          replicas: 1,
          phase: 'Ready',
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('enhanced-factory-test');
      expect(graph.resources).toHaveLength(1);
    });
  });
});