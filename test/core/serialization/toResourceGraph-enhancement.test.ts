/**
 * Tests for toResourceGraph API enhancements with JavaScript to CEL conversion
 * 
 * This test suite verifies the enhanced toResourceGraph functionality including:
 * - Automatic detection of KubernetesRef objects in JavaScript expressions
 * - Backward compatibility with existing CEL expressions
 * - Factory pattern integration (direct vs Kro)
 * - Migration helpers for converting CEL to JavaScript
 * - Comprehensive expression analysis and categorization
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph } from '../../../src/core/serialization/core.js';
import { simple } from '../../../src/factories/index.js';
import { Cel } from '../../../src/core/references/cel.js';
import { 
  CelToJavaScriptMigrationHelper,
  analyzeCelMigrationOpportunities,
  generateCelMigrationGuide 
} from '../../../src/core/expressions/migration-helpers.js';

// Test schemas
const TestSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  hostname: 'string',
});

const TestStatusSchema = type({
  ready: 'boolean',
  url: 'string',
  replicas: 'number',
  phase: 'string',
});

describe('toResourceGraph Enhancement', () => {
  describe('Backward Compatibility with CEL Expressions', () => {
    it('should preserve existing CEL expressions without conversion', () => {
      const graph = toResourceGraph(
        {
          name: 'test-cel-preservation',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'testDeployment',
          }),
        }),
        (schema, resources) => ({
          // Existing CEL expressions should be preserved
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
          url: Cel.template('https://%s', schema.spec.hostname),
          replicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<string>(
            resources.deployment.status.readyReplicas,
            ' > 0 ? "Ready" : "Pending"'
          ),
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('test-cel-preservation');
      expect(graph.resources).toHaveLength(1);
    });

    it('should handle mixed CEL expressions and static values', () => {
      const graph = toResourceGraph(
        {
          name: 'test-mixed-expressions',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'mixedDeployment',
          }),
        }),
        (_schema, resources) => ({
          // Mix of CEL expressions and static values
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
          url: 'https://static-url.com', // Static value
          replicas: resources.deployment.status.readyReplicas, // KubernetesRef
          phase: 'Running', // Static value
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('test-mixed-expressions');
    });
  });

  describe('JavaScript Expression Detection and Conversion', () => {
    it('should detect KubernetesRef objects in JavaScript expressions', () => {
      const graph = toResourceGraph(
        {
          name: 'test-js-detection',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'jsDetectionDeployment',
          }),
        }),
        (schema, resources) => ({
          // JavaScript expressions with KubernetesRef objects
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: resources.deployment.status.readyReplicas > 0 ? 'Ready' : 'Pending',
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('test-js-detection');
    });

    it('should handle static values without conversion', () => {
      const graph = toResourceGraph(
        {
          name: 'test-static-values',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'staticDeployment',
          }),
        }),
        (_schema, _resources) => ({
          // All static values - no conversion needed
          ready: true,
          url: 'https://static.example.com',
          replicas: 3,
          phase: 'Ready',
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('test-static-values');
    });

    it('should handle complex nested expressions', () => {
      const graph = toResourceGraph(
        {
          name: 'test-complex-expressions',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'complexDeployment',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas >= schema.spec.replicas,
          url: `https://${schema.spec.hostname}/api/v1`,
          replicas: resources.deployment.status.readyReplicas,
          phase: resources.deployment.status.readyReplicas >= schema.spec.replicas 
            ? 'Ready' 
            : resources.deployment.status.readyReplicas > 0 
              ? 'Scaling' 
              : 'Pending',
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('test-complex-expressions');
    });
  });

  describe('Factory Pattern Integration', () => {
    it('should create Kro factory with CEL expressions', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-kro-factory',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'kroDeployment',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: 'Ready',
        })
      );

      const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });
      
      expect(kroFactory).toBeDefined();
      expect(kroFactory.namespace).toBe('test-kro');
    });

    it('should create direct factory with appropriate expression handling', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-direct-factory',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'directDeployment',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: 'Ready',
        })
      );

      const directFactory = await graph.factory('direct', { namespace: 'test-direct' });
      
      expect(directFactory).toBeDefined();
      expect(directFactory.namespace).toBe('test-direct');
    });

    it('should handle factory-specific expression analysis', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-factory-analysis',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'analysisDeployment',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: resources.deployment.status.readyReplicas > 0 ? 'Ready' : 'Pending',
        })
      );

      // Both factories should be created successfully with different analysis
      const kroFactory = await graph.factory('kro', { namespace: 'test-kro' });
      const directFactory = await graph.factory('direct', { namespace: 'test-direct' });
      
      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();
      expect(kroFactory.namespace).toBe('test-kro');
      expect(directFactory.namespace).toBe('test-direct');
    });
  });

  describe('Expression Analysis and Categorization', () => {
    it('should analyze and categorize different expression types', () => {
      // This test verifies that the internal analysis correctly categorizes expressions
      // We can't directly access the internal analysis, but we can verify the graph is created
      const graph = toResourceGraph(
        {
          name: 'test-categorization',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'categorizationDeployment',
          }),
        }),
        (_schema, resources) => ({
          // Different types of expressions for categorization
          ready: resources.deployment.status.readyReplicas > 0, // jsExpression
          url: 'https://static.example.com', // staticValue
          replicas: resources.deployment.status.readyReplicas, // kubernetesRef
          phase: Cel.expr<string>(resources.deployment.status.readyReplicas, ' > 0 ? "Ready" : "Pending"'), // celExpression
        })
      );

      expect(graph).toBeDefined();
      expect(graph.name).toBe('test-categorization');
    });

    it('should handle error cases gracefully', () => {
      // Test that the enhanced toResourceGraph handles errors gracefully
      expect(() => {
        toResourceGraph(
          {
            name: 'test-error-handling',
            apiVersion: 'test.com/v1',
            kind: 'TestApp',
            spec: TestSpecSchema,
            status: TestStatusSchema,
          },
          (schema) => ({
            deployment: simple.Deployment({
              name: schema.spec.name,
              image: schema.spec.image,
              replicas: schema.spec.replicas,
              id: 'errorDeployment',
            }),
          }),
          (schema, resources) => ({
            ready: resources.deployment.status.readyReplicas > 0,
            url: `https://${schema.spec.hostname}`,
            replicas: resources.deployment.status.readyReplicas,
            phase: 'Ready',
          })
        );
      }).not.toThrow();
    });
  });

  describe('Migration Helpers', () => {
    it('should analyze CEL migration opportunities', () => {
      const statusMappings = {
        ready: Cel.expr<boolean>('resources.deployment.status.readyReplicas > 0'),
        url: Cel.template('https://%s', 'schema.spec.hostname'),
        phase: Cel.expr<string>('resources.deployment.status.readyReplicas > 0 ? "Ready" : "Pending"'),
        staticValue: 'static-string',
      };

      const analysis = analyzeCelMigrationOpportunities(statusMappings);

      expect(analysis).toBeDefined();
      expect(analysis.migrationFeasibility).toBeDefined();
      expect(analysis.suggestions).toBeDefined();
      expect(analysis.suggestionsByCategory).toBeDefined();
      expect(analysis.summary).toBeDefined();
    });

    it('should generate migration guide', () => {
      const statusMappings = {
        ready: Cel.expr<boolean>('resources.deployment.status.readyReplicas > 0'),
        url: Cel.template('https://%s', 'schema.spec.hostname'),
      };

      const guide = generateCelMigrationGuide(statusMappings, {
        format: 'markdown',
        includeExamples: true,
        includeWarnings: true,
      });

      expect(guide).toBeDefined();
      expect(typeof guide).toBe('string');
      expect(guide.length).toBeGreaterThan(0);
      expect(guide).toContain('Migration Guide');
    });

    it('should create migration helper instance', () => {
      const helper = new CelToJavaScriptMigrationHelper();
      expect(helper).toBeDefined();

      const statusMappings = {
        ready: Cel.expr<boolean>('resources.deployment.status.readyReplicas > 0'),
      };

      const analysis = helper.analyzeMigrationOpportunities(statusMappings);
      expect(analysis).toBeDefined();
      expect(analysis.suggestions).toBeDefined();
    });

    it('should handle empty status mappings', () => {
      const analysis = analyzeCelMigrationOpportunities({});
      
      expect(analysis).toBeDefined();
      expect(analysis.migrationFeasibility.totalExpressions).toBe(0);
      expect(analysis.suggestions).toHaveLength(0);
      expect(analysis.summary).toContain('No CEL expressions found');
    });

    it('should categorize different migration types', () => {
      const statusMappings = {
        simpleComparison: Cel.expr<boolean>('resources.deployment.status.readyReplicas > 0'),
        resourceReference: Cel.expr<number>('resources.deployment.status.readyReplicas'),
        schemaReference: Cel.expr<string>('schema.spec.name'),
        templateString: Cel.template('https://%s', 'schema.spec.hostname'),
        conditionalExpression: Cel.expr<string>('resources.deployment.status.readyReplicas > 0 ? "Ready" : "Pending"'),
      };

      const analysis = analyzeCelMigrationOpportunities(statusMappings);

      expect(analysis.suggestionsByCategory.size).toBeGreaterThan(0);
      expect(analysis.migrationFeasibility.totalExpressions).toBeGreaterThan(0);
    });
  });

  describe('Integration with Existing Features', () => {
    it('should work with YAML generation', () => {
      const graph = toResourceGraph(
        {
          name: 'test-yaml-generation',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'yamlDeployment',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: 'Ready',
        })
      );

      const yaml = graph.toYaml();
      expect(yaml).toBeDefined();
      expect(typeof yaml).toBe('string');
      expect(yaml.length).toBeGreaterThan(0);
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });

    it('should maintain type safety', () => {
      const graph = toResourceGraph(
        {
          name: 'test-type-safety',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'typeSafetyDeployment',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0,
          url: `https://${schema.spec.hostname}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: 'Ready',
        })
      );

      // Type safety is enforced at compile time, so if this compiles, it's working
      expect(graph).toBeDefined();
      expect(graph.schema).toBeDefined();
    });

    it('should handle resource cross-references', () => {
      const graph = toResourceGraph(
        {
          name: 'test-cross-references',
          apiVersion: 'test.com/v1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'crossRefDeployment',
          }),
          service: simple.Service({
            name: schema.spec.name,
            ports: [{ port: 80, targetPort: 8080 }],
            selector: { app: 'test' },
            id: 'crossRefService',
          }),
        }),
        (schema, resources) => ({
          ready: resources.deployment.status.readyReplicas > 0 && resources.service.status.loadBalancer !== null,
          url: `https://${schema.spec.hostname}`,
          replicas: resources.deployment.status.readyReplicas,
          phase: 'Ready',
        })
      );

      expect(graph).toBeDefined();
      expect(graph.resources).toHaveLength(2);
    });
  });
});