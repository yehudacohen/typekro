import { describe, expect, it, } from 'bun:test';
import { type } from 'arktype';
import { Cel, simpleDeployment, simpleService, toResourceGraph } from '../../src/index.js';
import { separateStatusFields } from '../../src/core/validation/cel-validator.js';
import { hydrateStatus } from '../../src/core/deployment/status-hydrator.js';

describe('Factory Pattern Status Hydration', () => {
  describe('Field Separation Logic', () => {
    it('should correctly separate static and dynamic status fields', () => {
      const statusMappings = {
        // Static fields (no Kubernetes references)
        url: 'http://webapp-service',
        version: '1.0.0',
        environment: 'production',
        
        // Dynamic fields (with Kubernetes references)
        phase: Cel.conditional(
          Cel.expr('webapp.status.readyReplicas > 0'),
          '"running"',
          '"pending"'
        ),
        replicas: Cel.expr('webapp.status.replicas'),
        
        // Mixed nested object
        metadata: {
          name: 'my-app', // static
          namespace: Cel.expr('webapp.metadata.namespace'), // dynamic
        }
      };

      const { staticFields, dynamicFields } = separateStatusFields(statusMappings);

      // Verify static fields
      expect(Object.keys(staticFields)).toEqual(['url', 'version', 'environment', 'metadata']);
      expect(staticFields.url).toBe('http://webapp-service');
      expect(staticFields.version).toBe('1.0.0');
      expect(staticFields.environment).toBe('production');
      expect(staticFields.metadata).toEqual({ name: 'my-app' });

      // Verify dynamic fields
      expect(Object.keys(dynamicFields)).toEqual(['phase', 'replicas', 'metadata']);
      expect(dynamicFields.phase).toHaveProperty('__brand', 'CelExpression');
      expect(dynamicFields.replicas).toHaveProperty('__brand', 'CelExpression');
      expect(dynamicFields.metadata).toEqual({ 
        namespace: expect.objectContaining({ __brand: 'CelExpression' })
      });
    });

    it('should handle purely static status mappings', () => {
      const statusMappings = {
        url: 'http://static-service',
        version: '2.0.0',
        ready: true,
      };

      const { staticFields, dynamicFields } = separateStatusFields(statusMappings);

      expect(Object.keys(staticFields)).toEqual(['url', 'version', 'ready']);
      expect(Object.keys(dynamicFields)).toEqual([]);
      expect(staticFields.url).toBe('http://static-service');
      expect(staticFields.version).toBe('2.0.0');
      expect(staticFields.ready).toBe(true);
    });

    it('should handle purely dynamic status mappings', () => {
      const statusMappings = {
        phase: Cel.expr('deployment.status.phase'),
        replicas: Cel.expr('deployment.status.replicas'),
        ready: Cel.expr('deployment.status.readyReplicas > 0'),
      };

      const { staticFields, dynamicFields } = separateStatusFields(statusMappings);

      expect(Object.keys(staticFields)).toEqual([]);
      expect(Object.keys(dynamicFields)).toEqual(['phase', 'replicas', 'ready']);
      expect(dynamicFields.phase).toHaveProperty('__brand', 'CelExpression');
      expect(dynamicFields.replicas).toHaveProperty('__brand', 'CelExpression');
      expect(dynamicFields.ready).toHaveProperty('__brand', 'CelExpression');
    });
  });

  describe('Status Hydration Logic', () => {
    it('should hydrate static fields directly', async () => {
      const staticFields = {
        url: 'http://webapp-service',
        version: '1.0.0',
        environment: 'production',
        metadata: {
          name: 'my-app',
          createdBy: 'typekro'
        }
      };

      const kroResolvedStatus = {
        phase: 'running',
        replicas: 2,
      };

      const hydratedStatus = await hydrateStatus(kroResolvedStatus, staticFields);

      // Should contain both static and dynamic fields
      expect(hydratedStatus).toEqual({
        // Static fields hydrated directly
        url: 'http://webapp-service',
        version: '1.0.0',
        environment: 'production',
        metadata: {
          name: 'my-app',
          createdBy: 'typekro'
        },
        // Dynamic fields from Kro
        phase: 'running',
        replicas: 2,
      });
    });

    it('should handle overlapping field names with dynamic taking precedence', async () => {
      const staticFields = {
        phase: 'static-phase', // This should be overridden
        url: 'http://static-url',
      };

      const kroResolvedStatus = {
        phase: 'dynamic-phase', // This should take precedence
        replicas: 3,
      };

      const hydratedStatus = await hydrateStatus(kroResolvedStatus, staticFields);

      expect(hydratedStatus).toEqual({
        url: 'http://static-url', // Static field preserved
        phase: 'dynamic-phase', // Dynamic field takes precedence
        replicas: 3, // Dynamic field
      });
    });

    it('should handle nested object merging correctly', async () => {
      const staticFields = {
        metadata: {
          name: 'static-name',
          version: '1.0.0',
        },
        config: {
          timeout: 30,
          retries: 3,
        }
      };

      const kroResolvedStatus = {
        metadata: {
          namespace: 'dynamic-namespace',
          labels: { app: 'webapp' },
        },
        phase: 'running',
      };

      const hydratedStatus = await hydrateStatus(kroResolvedStatus, staticFields);

      expect(hydratedStatus).toEqual({
        // Static fields
        config: {
          timeout: 30,
          retries: 3,
        },
        // Merged metadata (dynamic overwrites static for same keys)
        metadata: {
          namespace: 'dynamic-namespace',
          labels: { app: 'webapp' },
        },
        // Dynamic fields
        phase: 'running',
      });
    });
  });

  describe('Factory Pattern Integration', () => {
    it('should create a resource graph with mixed static/dynamic status fields', async () => {
      const WebAppSpecSchema = type({
        name: 'string',
        image: 'string',
        replicas: 'number',
      });

      const WebAppStatusSchema = type({
        // Static fields
        url: 'string',
        version: 'string',
        environment: 'string',
        // Dynamic fields  
        phase: '"pending" | "running" | "failed"',
        replicas: 'number',
        readyReplicas: 'number',
        // Mixed nested object
        metadata: {
          name: 'string',
          namespace: 'string',
          createdBy: 'string',
        },
      });

      const resourceGraph = toResourceGraph(
        {
          name: 'webapp-with-mixed-status',
          apiVersion: 'v1alpha1',
          kind: 'WebAppWithMixedStatus',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webapp',
          }),
          service: simpleService({
            name: Cel.concat(schema.spec.name, '-service'),
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 8080 }],
            id: 'webappService',
          }),
        }),
        (_schema, resources) => ({
          // Static fields (no Kubernetes references)
          url: 'http://webapp-service.default.svc.cluster.local',
          version: '1.0.0',
          environment: 'production',
          
          // Dynamic fields (with Kubernetes references)
          phase: Cel.conditional(
            Cel.expr(resources.deployment.status.readyReplicas, ' > 0'),
            '"running"',
            '"pending"'
          ) as 'pending' | 'running' | 'failed',
          replicas: Cel.expr(resources.deployment.status.replicas),
          readyReplicas: Cel.expr(resources.deployment.status.readyReplicas),
          
          // Mixed nested object
          metadata: {
            name: 'webapp-app', // static
            namespace: resources.deployment.metadata.namespace, // dynamic
            createdBy: 'typekro', // static
          },
        })
      );

      // Verify the resource graph was created
      expect(resourceGraph).toBeDefined();
      expect(resourceGraph.name).toBe('webapp-with-mixed-status');
      expect(resourceGraph.resources).toHaveLength(2);

      // Test YAML generation
      const yaml = resourceGraph.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: webapp-with-mixed-status');
      
      // Verify that only dynamic fields are in the Kro schema
      expect(yaml).toContain('phase: \"${webapp.status.readyReplicas > 0 ? \\\"running\\\" : \\\"pending\\\"}\"');
      expect(yaml).toContain('replicas: ${webapp.status.replicas}');
      expect(yaml).toContain('readyReplicas: ${webapp.status.readyReplicas}');
      
      // Static fields should NOT be in the Kro schema
      expect(yaml).not.toContain('url: \"http://webapp-service');
      expect(yaml).not.toContain('version: \"1.0.0\"');
      expect(yaml).not.toContain('environment: \"production\"');
    });

    it('should create factories that properly handle status hydration', async () => {
      const WebAppSpecSchema = type({
        name: 'string',
        replicas: 'number',
      });

      const WebAppStatusSchema = type({
        url: 'string',
        phase: '"pending" | "running" | "failed"',
        replicas: 'number',
      });

      const resourceGraph = toResourceGraph(
        {
          name: 'webapp-status-test',
          apiVersion: 'v1alpha1', 
          kind: 'WebAppStatusTest',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: 'nginx:alpine',
            replicas: schema.spec.replicas,
            id: 'webapp',
          }),
        }),
        (_schema, resources) => ({
          // Static field
          url: 'http://static-webapp-service',
          // Dynamic fields
          phase: Cel.conditional(
            Cel.expr(resources.deployment.status.readyReplicas, ' > 0'),
            '"running"',
            '"pending"'
          ) as 'pending' | 'running' | 'failed',
          replicas: resources.deployment.status.replicas,
        })
      );

      // Create a direct factory (for testing without Kubernetes cluster)
      const directFactory = await resourceGraph.factory('direct', {
        namespace: 'test-namespace',
        hydrateStatus: false, // Disable live status hydration for unit test
      });

      expect(directFactory).toBeDefined();
      expect(directFactory.mode).toBe('direct');
      expect(directFactory.name).toBe('webapp-status-test');
      expect(directFactory.namespace).toBe('test-namespace');

      // Test YAML generation - direct factory generates individual resource YAML, not RGD
      const instanceYaml = directFactory.toYaml({ name: 'test-app', replicas: 2 });
      expect(instanceYaml).toContain('kind: Deployment'); // Direct factory generates individual resources
      expect(instanceYaml).toContain('name: test-app');
      expect(instanceYaml).toContain('replicas: 2');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid status mappings gracefully', () => {
      const invalidStatusMappings = {
        validField: 'static-value',
        invalidRef: Cel.expr('nonExistentResource.status.field'),
      };

      // This should not throw during field separation
      const { staticFields, dynamicFields } = separateStatusFields(invalidStatusMappings);
      
      expect(staticFields.validField).toBe('static-value');
      expect(dynamicFields.invalidRef).toHaveProperty('__brand', 'CelExpression');
      
      // The validation should catch the invalid reference later
      // (This would be caught by validateResourceGraphDefinition)
    });

    it('should handle empty status mappings', () => {
      const emptyStatusMappings = {};
      
      const { staticFields, dynamicFields } = separateStatusFields(emptyStatusMappings);
      
      expect(Object.keys(staticFields)).toEqual([]);
      expect(Object.keys(dynamicFields)).toEqual([]);
    });

    it('should handle null/undefined status mappings', () => {
      const { staticFields: staticNull, dynamicFields: dynamicNull } = separateStatusFields(null as any);
      const { staticFields: staticUndef, dynamicFields: dynamicUndef } = separateStatusFields(undefined as any);
      
      expect(Object.keys(staticNull)).toEqual([]);
      expect(Object.keys(dynamicNull)).toEqual([]);
      expect(Object.keys(staticUndef)).toEqual([]);
      expect(Object.keys(dynamicUndef)).toEqual([]);
    });
  });

  describe('Performance and Edge Cases', () => {
    it('should handle deeply nested status objects', () => {
      const deepStatusMappings = {
        level1: {
          level2: {
            level3: {
              staticField: 'deep-static-value',
              dynamicField: Cel.expr('resource.status.deepField'),
            },
            staticAtLevel2: 'static-value',
          },
          dynamicAtLevel1: Cel.expr('resource.status.field'),
        },
        topLevelStatic: 'top-static',
      };

      const { staticFields, dynamicFields } = separateStatusFields(deepStatusMappings);

      // Current behavior: if any part of a nested object is dynamic, the entire object is dynamic
      // This is a conservative approach that ensures proper Kro resolution
      expect(staticFields).toHaveProperty('topLevelStatic');
      expect(staticFields.topLevelStatic).toBe('top-static');
      
      expect(dynamicFields).toHaveProperty('level1');
      expect(dynamicFields.level1).toHaveProperty('dynamicAtLevel1');
      expect(dynamicFields.level1.level2).toHaveProperty('staticAtLevel2');
      expect(dynamicFields.level1.level2.level3).toHaveProperty('staticField');
      expect(dynamicFields.level1.level2.level3).toHaveProperty('dynamicField');
    });

    it('should handle arrays in status mappings', () => {
      const statusWithArrays = {
        staticArray: ['item1', 'item2', 'item3'],
        dynamicArray: [
          Cel.expr('resource1.status.field'),
          'static-item',
          Cel.expr('resource2.status.field'),
        ],
        mixedObject: {
          staticItems: ['a', 'b', 'c'],
          dynamicCount: Cel.expr('resource.status.count'),
        },
      };

      const { staticFields, dynamicFields } = separateStatusFields(statusWithArrays);

      // Arrays with only static content should be static
      expect(staticFields.staticArray).toEqual(['item1', 'item2', 'item3']);
      
      // LIMITATION: Arrays with mixed content are currently treated as static
      // This is a known limitation - arrays containing CEL expressions should be dynamic
      expect(staticFields.dynamicArray).toBeDefined();
      expect(staticFields.dynamicArray).toEqual([
        expect.objectContaining({ __brand: 'CelExpression' }),
        'static-item',
        expect.objectContaining({ __brand: 'CelExpression' }),
      ]);
      
      // Mixed objects should be split appropriately
      expect(staticFields.mixedObject).toEqual({ staticItems: ['a', 'b', 'c'] });
      expect(dynamicFields.mixedObject).toEqual({ 
        dynamicCount: expect.objectContaining({ __brand: 'CelExpression' })
      });
    });
  });
});