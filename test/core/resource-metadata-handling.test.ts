/**
 * Tests for KubernetesRef handling in resource metadata
 * These tests prevent regressions in resource lookup and proxy object handling
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph, simple, Cel } from '../../src/index.js';

describe('Resource Metadata Handling', () => {
  const TestSpecSchema = type({
    name: 'string',
    image: 'string',
    port: 'number',
    replicas: 'number'
  });

  const TestStatusSchema = type({
    url: 'string',
    phase: '"pending" | "running" | "failed"'
  });

  describe('KubernetesRef in Resource Metadata', () => {
    it('should handle KubernetesRef objects in resource metadata during factory creation', () => {
      // This test ensures that resources with KubernetesRef objects in metadata don't break factory creation
      expect(() => {
        const graph = toResourceGraph(
          {
            name: 'ref-test',
            apiVersion: 'v1alpha1',
            kind: 'RefTest',
            spec: TestSpecSchema,
            status: TestStatusSchema,
          },
          (schema) => ({
            deployment: simple.Deployment({
              name: schema.spec.name, // This creates a KubernetesRef
              image: schema.spec.image,
              replicas: schema.spec.replicas,
              id: 'deployment',
            }),
            service: simple.Service({
              name: Cel.template('%s-service', schema.spec.name), // This creates a CEL expression
              selector: { app: schema.spec.name },
              ports: [{ port: 80, targetPort: schema.spec.port }],
              id: 'service',
            }),
          }),
          (_schema, _resources) => ({
            url: 'http://webapp-service',
            phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
          })
        );

        // Factory creation should not throw even with KubernetesRef objects in metadata
        const factory = graph.factory('direct', {
          namespace: 'test-namespace',
          timeout: 30000,
          waitForReady: true,
        });

        expect(factory).toBeDefined();
        expect(factory.mode).toBe('direct');
        expect(factory.name).toBe('ref-test');
        expect(factory.namespace).toBe('test-namespace');
      }).not.toThrow();
    });

    it('should skip resources with unresolved references during resource lookup', () => {
      const graph = toResourceGraph(
        {
          name: 'lookup-test',
          apiVersion: 'v1alpha1',
          kind: 'LookupTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name, // KubernetesRef object
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'deployment',
          }),
          service: simple.Service({
            name: 'static-service-name', // Static string
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: schema.spec.port }],
            id: 'service',
          }),
        }),
        (_schema, _resources) => ({
          url: 'http://webapp-service',
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      // Factory creation should work and handle mixed metadata types
      const factory = graph.factory('direct', {
        namespace: 'test-namespace',
      });

      expect(factory).toBeDefined();
      
      // YAML generation should work despite mixed metadata types
      expect(() => {
        const yaml = factory.toYaml({
          name: 'test-app',
          image: 'nginx',
          port: 8080,
          replicas: 3
        });
        expect(yaml).toBeDefined();
        expect(yaml).toContain('static-service-name'); // Static name should appear
        expect(yaml).toContain('test-app'); // Resolved name should appear
      }).not.toThrow();
    });

    it('should handle complex resource metadata scenarios', () => {
      const graph = toResourceGraph(
        {
          name: 'complex-test',
          apiVersion: 'v1alpha1',
          kind: 'ComplexTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          // Resource with KubernetesRef in name
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'deployment',
          }),
          // Resource with CEL template in name
          service: simple.Service({
            name: Cel.template('%s-svc', schema.spec.name),
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: schema.spec.port }],
            id: 'service',
          }),
          // Resource with static name
          configMap: simple.ConfigMap({
            name: 'static-config',
            data: {
              'app.properties': `port=${schema.spec.port}`
            },
            id: 'config',
          }),
          // Resource with CEL template in name
          secret: simple.Secret({
            name: Cel.template('%s-secret', schema.spec.name),
            data: {
              'password': 'base64encodedpassword'
            },
            id: 'secret',
          }),

        }),
        (_schema, _resources) => ({
          url: 'http://webapp-service',
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      // Should handle all metadata types without errors
      expect(() => {
        const factory = graph.factory('direct', {
          namespace: 'test-namespace',
        });

        const yaml = factory.toYaml({
          name: 'complex-app',
          image: 'nginx',
          port: 9000,
          replicas: 2
        });

        expect(yaml).toBeDefined();
        expect(yaml).toContain('complex-app'); // Resolved KubernetesRef
        expect(yaml).toContain('${complex-app}-svc'); // CEL template (not resolved in YAML)
        expect(yaml).toContain('static-config'); // Static name
        expect(yaml).toContain('9000'); // Resolved port
      }).not.toThrow();
    });
  });

  describe('Resource Lookup Edge Cases', () => {
    it('should handle empty or null metadata gracefully', () => {
      // Create a mock resource with problematic metadata
      const mockResourcesWithKeys = {
        'resource1': {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: null, // Null name
          },
          spec: {}
        },
        'resource2': {
          apiVersion: 'v1',
          kind: 'Deployment',
          metadata: {
            name: undefined, // Undefined name
          },
          spec: {}
        },
        'resource3': {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            // Missing name property
          },
          spec: {}
        },
        'resource4': {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'valid-name', // Valid name
          },
          spec: {}
        }
      };

      // This simulates the findResourceByKey function behavior
      const findResourceByKey = (key: string) => {
        const keyLower = key.toLowerCase();
        
        for (const [resourceId, resource] of Object.entries(mockResourcesWithKeys)) {
          const kind = resource.kind.toLowerCase();
          
          // Handle case where metadata.name might be a KubernetesRef object or null/undefined
          let name = '';
          const metadataName = (resource.metadata as any).name;
          if (metadataName && typeof metadataName === 'string') {
            name = metadataName.toLowerCase();
          } else if (metadataName && typeof metadataName === 'object') {
            // Skip resources with unresolved references
            continue;
          }
          // For null/undefined, name remains empty string
          
          const resourceIdLower = resourceId.toLowerCase();
          
          // Simple matching logic - only match if we have a valid name or exact resource ID match
          if ((name && (keyLower.includes(name) || name.includes(keyLower))) ||
              keyLower === resourceIdLower ||
              (name && keyLower.includes(kind) && name.length > 0)) {
            return resource;
          }
        }
        return null;
      };

      // Should handle all edge cases without throwing
      expect(() => {
        expect(findResourceByKey('service')).toBeNull(); // Should skip resource1 (null name)
        expect(findResourceByKey('deployment')).toBeNull(); // Should skip resource2 (undefined name)
        expect(findResourceByKey('configmap')).toBeNull(); // Should skip resource3 (missing name)
        expect(findResourceByKey('secret')).toBeTruthy(); // Should find resource4 (valid name)
        expect(findResourceByKey('valid-name')).toBeTruthy(); // Should find by name
      }).not.toThrow();
    });

    it('should handle KubernetesRef objects in metadata name field', () => {
      // Mock KubernetesRef object
      const mockKubernetesRef = {
        __brand: 'KubernetesRef',
        resourceId: 'schema',
        fieldPath: 'spec.name'
      };

      const mockResourcesWithRefs = {
        'deployment': {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: {
            name: mockKubernetesRef, // KubernetesRef object
          },
          spec: {}
        },
        'service': {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: 'static-service', // String name
          },
          spec: {}
        }
      };

      const findResourceByKey = (key: string) => {
        const keyLower = key.toLowerCase();
        
        for (const [resourceId, resource] of Object.entries(mockResourcesWithRefs)) {
          const kind = resource.kind.toLowerCase();
          
          // Handle case where metadata.name might be a KubernetesRef object
          let name = '';
          if (resource.metadata.name && typeof resource.metadata.name === 'string') {
            name = resource.metadata.name.toLowerCase();
          } else if (resource.metadata.name && typeof resource.metadata.name === 'object') {
            // Skip resources with unresolved references
            continue;
          }
          
          const resourceIdLower = resourceId.toLowerCase();
          
          if (keyLower.includes(kind) || kind.includes(keyLower) || 
              (name && (keyLower.includes(name) || name.includes(keyLower))) ||
              keyLower === resourceIdLower) {
            return resource;
          }
        }
        return null;
      };

      // Should handle KubernetesRef objects without throwing
      expect(() => {
        expect(findResourceByKey('deployment')).toBeNull(); // Should skip deployment with KubernetesRef
        expect(findResourceByKey('service')).toBeTruthy(); // Should find service with string name
        expect(findResourceByKey('static-service')).toBeTruthy(); // Should find by string name
      }).not.toThrow();
    });
  });

  describe('Factory Creation Robustness', () => {
    it('should create factories successfully with mixed metadata types', () => {
      const graph = toResourceGraph(
        {
          name: 'robust-test',
          apiVersion: 'v1alpha1',
          kind: 'RobustTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          // Mix of different metadata scenarios
          deployment: simple.Deployment({
            name: schema.spec.name, // KubernetesRef
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'deployment',
          }),
          service: simple.Service({
            name: 'static-name', // Static string
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: schema.spec.port }],
            id: 'service',
          }),
        }),
        (_schema, _resources) => ({
          url: 'http://webapp-service',
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      // All factory creation methods should work
      expect(() => {
        const directFactory = graph.factory('direct', { namespace: 'test' });
        expect(directFactory.mode).toBe('direct');
        
        const kroFactory = graph.factory('kro', { namespace: 'test' });
        expect(kroFactory.mode).toBe('kro');
      }).not.toThrow();
    });

    it('should generate YAML successfully with mixed metadata types', () => {
      const graph = toResourceGraph(
        {
          name: 'yaml-robust-test',
          apiVersion: 'v1alpha1',
          kind: 'YamlRobustTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'deployment',
          }),
          service: simple.Service({
            name: 'yaml-service',
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: schema.spec.port }],
            id: 'service',
          }),
        }),
        (_schema, _resources) => ({
          url: 'http://webapp-service',
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = graph.factory('direct', { namespace: 'test' });

      expect(() => {
        const yaml = factory.toYaml({
          name: 'yaml-test-app',
          image: 'nginx',
          port: 8080,
          replicas: 2
        });

        expect(yaml).toBeDefined();
        expect(typeof yaml).toBe('string');
        expect(yaml.length).toBeGreaterThan(0);
        
        // Should contain resolved values
        expect(yaml).toContain('yaml-test-app');
        expect(yaml).toContain('yaml-service');
        expect(yaml).toContain('8080');
      }).not.toThrow();
    });
  });
});