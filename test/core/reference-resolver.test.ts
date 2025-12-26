/**
 * Unit tests for reference resolution system
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import { ReferenceResolver } from '../../src/core.js';

// Mock the Kubernetes client
const mockKubeConfig = {
  makeApiClient: mock(() => mockK8sApi),
} as unknown as k8s.KubeConfig;
const mockK8sApi = {
  read: mock(() => Promise.resolve({ body: {} })),
  create: mock(() => Promise.resolve({ body: {} })),
  replace: mock(() => Promise.resolve({ body: {} })),
  delete: mock(() => Promise.resolve({ body: {} })),
};

describe('ReferenceResolver', () => {
  let resolver: ReferenceResolver;
  let context: any;

  beforeEach(() => {
    resolver = new ReferenceResolver(mockKubeConfig, 'direct', mockK8sApi as any);
    context = {
      deployedResources: [],
      kubeClient: mockKubeConfig,
      namespace: 'default',
      timeout: 5000,
      cache: new Map(),
    };

    // Clear mocks
    mockK8sApi.read.mockClear();
    resolver.clearCache();
  });

  describe('resolveReferences', () => {
    it('should resolve simple KubernetesRef objects', async () => {
      const deployedResource = {
        id: 'database',
        kind: 'Deployment',
        name: 'db',
        namespace: 'default',
        manifest: {
          status: {
            podIP: '10.0.0.1',
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];

      const resource = {
        spec: {
          containers: [
            {
              env: [
                {
                  name: 'DB_HOST',
                  value: {
                    [KUBERNETES_REF_BRAND]: true,
                    resourceId: 'database',
                    fieldPath: 'status.podIP',
                  },
                },
              ],
            },
          ],
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.containers[0].env[0].value).toBe('10.0.0.1');
    });

    it('should resolve nested field paths', async () => {
      const deployedResource = {
        id: 'service',
        kind: 'Service',
        name: 'api-service',
        namespace: 'default',
        manifest: {
          spec: {
            ports: [
              { name: 'http', port: 80 },
              { name: 'https', port: 443 },
            ],
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];

      const resource = {
        spec: {
          backend: {
            service: {
              port: {
                number: {
                  [KUBERNETES_REF_BRAND]: true,
                  resourceId: 'service',
                  fieldPath: 'spec.ports[0].port',
                },
              },
            },
          },
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.backend.service.port.number).toBe(80);
    });

    it('should resolve CEL expressions', async () => {
      const deployedResource = {
        id: 'database',
        kind: 'Deployment',
        name: 'db',
        namespace: 'default',
        manifest: {
          status: {
            endpoint: 'db.example.com',
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];

      const resource = {
        spec: {
          containers: [
            {
              env: [
                {
                  name: 'DATABASE_URL',
                  value: {
                    [CEL_EXPRESSION_BRAND]: true,
                    expression: 'concat("postgresql://", database.status.endpoint, ":5432/mydb")',
                  },
                },
              ],
            },
          ],
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.containers[0].env[0].value).toBe(
        'postgresql://db.example.com:5432/mydb'
      );
    });

    it('should handle arrays of references', async () => {
      const deployedResource = {
        id: 'config',
        kind: 'ConfigMap',
        name: 'app-config',
        namespace: 'default',
        manifest: {
          data: {
            key1: 'value1',
            key2: 'value2',
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];

      const resource = {
        spec: {
          env: [
            {
              name: 'CONFIG_KEY1',
              value: {
                [KUBERNETES_REF_BRAND]: true,
                resourceId: 'config',
                fieldPath: 'data.key1',
              },
            },
            {
              name: 'CONFIG_KEY2',
              value: {
                [KUBERNETES_REF_BRAND]: true,
                resourceId: 'config',
                fieldPath: 'data.key2',
              },
            },
          ],
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.env[0].value).toBe('value1');
      expect(resolved.spec.env[1].value).toBe('value2');
    });

    it('should preserve non-reference values', async () => {
      const resource = {
        spec: {
          containers: [
            {
              name: 'app',
              image: 'nginx:latest',
              ports: [{ containerPort: 80 }],
              env: [
                { name: 'STATIC_VAR', value: 'static-value' },
                { name: 'NUMERIC_VAR', value: 42 },
                { name: 'BOOLEAN_VAR', value: true },
              ],
            },
          ],
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.containers[0].name).toBe('app');
      expect(resolved.spec.containers[0].image).toBe('nginx:latest');
      expect(resolved.spec.containers[0].ports[0].containerPort).toBe(80);
      expect(resolved.spec.containers[0].env[0].value).toBe('static-value');
      expect(resolved.spec.containers[0].env[1].value).toBe(42);
      expect(resolved.spec.containers[0].env[2].value).toBe(true);
    });

    it('should handle undefined and null values', async () => {
      const resource = {
        spec: {
          optional: undefined,
          nullable: null,
          empty: '',
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.optional).toBeUndefined();
      expect(resolved.spec.nullable).toBeNull();
      expect(resolved.spec.empty).toBe('');
    });
  });

  describe('extractFieldValue', () => {
    it('should extract simple field values', () => {
      const obj = { name: 'test', value: 42 };

      // Access private method for testing
      const extractFieldValue = (resolver as any).extractFieldValue.bind(resolver);

      expect(extractFieldValue(obj, 'name')).toBe('test');
      expect(extractFieldValue(obj, 'value')).toBe(42);
    });

    it('should extract nested field values', () => {
      const obj = {
        spec: {
          template: {
            metadata: {
              labels: {
                app: 'my-app',
              },
            },
          },
        },
      };

      const extractFieldValue = (resolver as any).extractFieldValue.bind(resolver);

      expect(extractFieldValue(obj, 'spec.template.metadata.labels.app')).toBe('my-app');
    });

    it('should extract array values by index', () => {
      const obj = {
        spec: {
          ports: [
            { name: 'http', port: 80 },
            { name: 'https', port: 443 },
          ],
        },
      };

      const extractFieldValue = (resolver as any).extractFieldValue.bind(resolver);

      expect(extractFieldValue(obj, 'spec.ports[0].port')).toBe(80);
      expect(extractFieldValue(obj, 'spec.ports[1].name')).toBe('https');
    });

    it('should return undefined for non-existent paths', () => {
      const obj = { name: 'test' };

      const extractFieldValue = (resolver as any).extractFieldValue.bind(resolver);

      expect(extractFieldValue(obj, 'nonexistent')).toBeUndefined();
      expect(extractFieldValue(obj, 'name.nested')).toBeUndefined();
    });

    it('should handle null/undefined objects gracefully', () => {
      const extractFieldValue = (resolver as any).extractFieldValue.bind(resolver);

      expect(extractFieldValue(null, 'field')).toBeUndefined();
      expect(extractFieldValue(undefined, 'field')).toBeUndefined();
    });
  });

  describe('CEL expression integration', () => {
    it('should use the proper CEL evaluator for complex expressions', async () => {
      const deployedResource = {
        id: 'database',
        kind: 'Deployment',
        name: 'db',
        namespace: 'default',
        manifest: {
          status: {
            endpoint: 'db.example.com',
            port: 5432,
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];

      const resource = {
        spec: {
          containers: [
            {
              env: [
                {
                  name: 'DATABASE_URL',
                  value: {
                    [CEL_EXPRESSION_BRAND]: true,
                    expression:
                      'concat("postgresql://", database.status.endpoint, ":", string(database.status.port), "/mydb")',
                  },
                },
              ],
            },
          ],
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.containers[0].env[0].value).toBe(
        'postgresql://db.example.com:5432/mydb'
      );
    });

    it('should handle conditional CEL expressions', async () => {
      const deployedResource = {
        id: 'config',
        kind: 'ConfigMap',
        name: 'app-config',
        namespace: 'default',
        manifest: {
          data: {
            debug: 'true',
            logLevel: 'debug',
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];

      const resource = {
        spec: {
          env: [
            {
              name: 'LOG_LEVEL',
              value: {
                [CEL_EXPRESSION_BRAND]: true,
                expression: 'config.data.debug == "true" ? config.data.logLevel : "info"',
              },
            },
          ],
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.env[0].value).toBe('debug');
    });

    it('should handle mathematical CEL expressions', async () => {
      const deployedResource = {
        id: 'deployment',
        kind: 'Deployment',
        name: 'app',
        namespace: 'default',
        manifest: {
          spec: {
            replicas: 3,
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];

      const resource = {
        spec: {
          maxReplicas: {
            [CEL_EXPRESSION_BRAND]: true,
            expression: 'deployment.spec.replicas * 2',
          },
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.maxReplicas).toBe(6);
    });
  });

  describe('caching', () => {
    it('should cache resolved values', async () => {
      const deployedResource = {
        id: 'database',
        kind: 'Deployment',
        name: 'db',
        namespace: 'default',
        manifest: {
          status: { podIP: '10.0.0.1' },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];

      const ref = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'database',
        fieldPath: 'status.podIP',
      };

      // First resolution
      const resolveKubernetesRef = (resolver as any).resolveKubernetesRef.bind(resolver);
      const result1 = await resolveKubernetesRef(ref, context);

      // Second resolution should use cache
      const result2 = await resolveKubernetesRef(ref, context);

      expect(result1).toBe('10.0.0.1');
      expect(result2).toBe('10.0.0.1');

      const stats = resolver.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.keys).toContain('database.status.podIP');
    });

    it('should clear cache when requested', async () => {
      const deployedResource = {
        id: 'database',
        kind: 'Deployment',
        name: 'db',
        namespace: 'default',
        manifest: {
          status: { podIP: '10.0.0.1' },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];

      const ref = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'database',
        fieldPath: 'status.podIP',
      };

      const resolveKubernetesRef = (resolver as any).resolveKubernetesRef.bind(resolver);
      await resolveKubernetesRef(ref, context);

      expect(resolver.getCacheStats().size).toBe(1);

      resolver.clearCache();

      expect(resolver.getCacheStats().size).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should throw ReferenceResolutionError for invalid references', async () => {
      // Mock the k8s API to throw a 404 error for nonexistent resources
      mockK8sApi.read.mockImplementationOnce(() => {
        const error = new Error('Resource not found') as any;
        error.statusCode = 404;
        return Promise.reject(error);
      });

      const resource = {
        spec: {
          value: {
            [KUBERNETES_REF_BRAND]: true,
            resourceId: 'nonexistent',
            fieldPath: 'status.value',
          },
        },
      };

      await expect(resolver.resolveReferences(resource, context)).rejects.toThrow(
        'Failed to resolve reference nonexistent.status.value'
      );
    });

    it('should throw CelExpressionError for invalid CEL expressions', async () => {
      const resource = {
        spec: {
          value: {
            [CEL_EXPRESSION_BRAND]: true,
            expression: 'nonexistent.resource.field',
          },
        },
      };

      await expect(resolver.resolveReferences(resource, context)).rejects.toThrow(
        "Resource 'nonexistent' not found in context"
      );
    });
  });

  describe('containsCelExpressions', () => {
    it('should detect CEL expressions at root level', () => {
      const obj = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'test.expression',
      };

      const containsCelExpressions = (resolver as any).containsCelExpressions.bind(resolver);
      expect(containsCelExpressions(obj)).toBe(true);
    });

    it('should detect CEL expressions in nested objects', () => {
      const obj = {
        spec: {
          env: {
            value: {
              [CEL_EXPRESSION_BRAND]: true,
              expression: 'schema.spec.name',
            },
          },
        },
      };

      const containsCelExpressions = (resolver as any).containsCelExpressions.bind(resolver);
      expect(containsCelExpressions(obj)).toBe(true);
    });

    it('should detect CEL expressions in arrays', () => {
      const obj = {
        items: [
          { name: 'static' },
          {
            [CEL_EXPRESSION_BRAND]: true,
            expression: 'dynamic.value',
          },
        ],
      };

      const containsCelExpressions = (resolver as any).containsCelExpressions.bind(resolver);
      expect(containsCelExpressions(obj)).toBe(true);
    });

    it('should return false for objects without CEL expressions', () => {
      const obj = {
        spec: {
          name: 'test',
          replicas: 3,
          nested: {
            value: 'static',
          },
        },
      };

      const containsCelExpressions = (resolver as any).containsCelExpressions.bind(resolver);
      expect(containsCelExpressions(obj)).toBe(false);
    });

    it('should handle null and undefined', () => {
      const containsCelExpressions = (resolver as any).containsCelExpressions.bind(resolver);
      expect(containsCelExpressions(null)).toBe(false);
      expect(containsCelExpressions(undefined)).toBe(false);
    });

    it('should handle primitive values', () => {
      const containsCelExpressions = (resolver as any).containsCelExpressions.bind(resolver);
      expect(containsCelExpressions('string')).toBe(false);
      expect(containsCelExpressions(42)).toBe(false);
      expect(containsCelExpressions(true)).toBe(false);
    });

    it('should handle circular references without infinite loop', () => {
      const obj: any = { name: 'test' };
      obj.circular = obj;

      const containsCelExpressions = (resolver as any).containsCelExpressions.bind(resolver);
      expect(containsCelExpressions(obj)).toBe(false);
    });

    it('should detect CEL in deeply nested structures', () => {
      const obj = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  [CEL_EXPRESSION_BRAND]: true,
                  expression: 'deep.value',
                },
              },
            },
          },
        },
      };

      const containsCelExpressions = (resolver as any).containsCelExpressions.bind(resolver);
      expect(containsCelExpressions(obj)).toBe(true);
    });
  });

  describe('selectiveClone', () => {
    it('should clone simple objects without CEL expressions', () => {
      const obj = {
        name: 'test',
        value: 42,
        nested: {
          prop: 'value',
        },
      };

      const selectiveClone = (resolver as any).selectiveClone.bind(resolver);
      const cloned = selectiveClone(obj);

      expect(cloned).toEqual(obj);
      expect(cloned).not.toBe(obj); // Different reference
      expect(cloned.nested).not.toBe(obj.nested); // Nested object also cloned
    });

    it('should preserve CEL expressions without cloning them', () => {
      const celExpr = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'test.expression',
      };

      const obj = {
        spec: {
          value: celExpr,
        },
      };

      const selectiveClone = (resolver as any).selectiveClone.bind(resolver);
      const cloned = selectiveClone(obj);

      expect(cloned.spec.value).toBe(celExpr); // Same reference, not cloned
      expect(cloned.spec).not.toBe(obj.spec); // Parent object cloned
    });

    it('should clone arrays while preserving CEL expressions', () => {
      const celExpr = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'array.value',
      };

      const obj = {
        items: ['static', 42, celExpr, { nested: 'object' }],
      };

      const selectiveClone = (resolver as any).selectiveClone.bind(resolver);
      const cloned = selectiveClone(obj);

      expect(cloned.items).not.toBe(obj.items); // Array cloned
      expect(cloned.items[0]).toBe('static');
      expect(cloned.items[1]).toBe(42);
      expect(cloned.items[2]).toBe(celExpr); // CEL preserved
      expect(cloned.items[3]).toEqual(obj.items[3]);
      expect(cloned.items[3]).not.toBe(obj.items[3]); // Nested object cloned
    });

    it('should handle null and undefined', () => {
      const selectiveClone = (resolver as any).selectiveClone.bind(resolver);
      expect(selectiveClone(null)).toBeNull();
      expect(selectiveClone(undefined)).toBeUndefined();
    });

    it('should handle primitive values', () => {
      const selectiveClone = (resolver as any).selectiveClone.bind(resolver);
      expect(selectiveClone('string')).toBe('string');
      expect(selectiveClone(42)).toBe(42);
      expect(selectiveClone(true)).toBe(true);
    });

    it('should handle circular references without infinite loop', () => {
      const obj: any = { name: 'test', value: 123 };
      obj.circular = obj;

      const selectiveClone = (resolver as any).selectiveClone.bind(resolver);
      const cloned = selectiveClone(obj);

      expect(cloned.name).toBe('test');
      expect(cloned.value).toBe(123);
      expect(cloned.circular).toBe(obj);
      expect(cloned.circular).toBe(obj);
    });

    it('should preserve multiple CEL expressions in same object', () => {
      const celExpr1 = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'expr1',
      };
      const celExpr2 = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'expr2',
      };

      const obj = {
        field1: celExpr1,
        field2: celExpr2,
        field3: 'static',
      };

      const selectiveClone = (resolver as any).selectiveClone.bind(resolver);
      const cloned = selectiveClone(obj);

      expect(cloned.field1).toBe(celExpr1);
      expect(cloned.field2).toBe(celExpr2);
      expect(cloned.field3).toBe('static');
      expect(cloned).not.toBe(obj);
    });

    it('should handle deeply nested CEL expressions', () => {
      const celExpr = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'deep.expr',
      };

      const obj = {
        level1: {
          level2: {
            level3: {
              celField: celExpr,
              staticField: 'value',
            },
          },
        },
      };

      const selectiveClone = (resolver as any).selectiveClone.bind(resolver);
      const cloned = selectiveClone(obj);

      expect(cloned.level1.level2.level3.celField).toBe(celExpr);
      expect(cloned.level1.level2.level3.staticField).toBe('value');
      expect(cloned.level1.level2.level3).not.toBe(obj.level1.level2.level3);
    });
  });

  describe('resolveReferences with CEL expressions (integration)', () => {
    it('should use selective cloning when CEL expressions are present', async () => {
      const celExpr = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'webapp.status.readyReplicas > 0',
      };

      const deployedResource = {
        id: 'webapp',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'default',
        manifest: {
          status: {
            readyReplicas: 2,
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];
      context.resourceKeyMapping = new Map([['webapp', deployedResource.manifest]]);

      const resource = {
        spec: {
          ready: celExpr,
          name: 'test-app',
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      // CEL expression should be evaluated to boolean
      expect(resolved.spec.ready).toBe(true);
      expect(resolved.spec.name).toBe('test-app');
    });

    it('should handle mixed CEL and KubernetesRef objects', async () => {
      const celExpr = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'deployment.spec.replicas * 2',
      };

      const kubeRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
      };

      const deployedResource = {
        id: 'deployment',
        kind: 'Deployment',
        name: 'app',
        namespace: 'default',
        manifest: {
          spec: {
            replicas: 3,
          },
          status: {
            readyReplicas: 3,
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];
      context.resourceKeyMapping = new Map([['deployment', deployedResource.manifest]]);

      const resource = {
        spec: {
          maxReplicas: celExpr,
          currentReplicas: kubeRef,
        },
      };

      const resolved = await resolver.resolveReferences(resource, context);

      expect(resolved.spec.maxReplicas).toBe(6);
      expect(resolved.spec.currentReplicas).toBe(3);
    });

    it('should avoid structuredClone error with Symbol-branded objects', async () => {
      // This test verifies that we don't hit the "object cannot be cloned" error
      const statusWithCel = {
        ready: {
          [CEL_EXPRESSION_BRAND]: true,
          expression: 'resource.status.ready',
        },
        phase: 'Running',
        nested: {
          celField: {
            [CEL_EXPRESSION_BRAND]: true,
            expression: 'resource.status.phase',
          },
        },
      };

      const deployedResource = {
        id: 'resource',
        kind: 'Deployment',
        name: 'test',
        namespace: 'default',
        manifest: {
          status: {
            ready: true,
            phase: 'Active',
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];
      context.resourceKeyMapping = new Map([['resource', deployedResource.manifest]]);

      // This should not throw "The object can not be cloned" error
      const resolved = await resolver.resolveReferences(statusWithCel, context);

      expect(resolved.ready).toBe(true);
      expect(resolved.phase).toBe('Running');
      expect(resolved.nested.celField).toBe('Active');
    });

    it('should handle CEL expressions in toJSON() output from Enhanced proxies', async () => {
      // This test covers the specific bug where Enhanced proxies return CEL expressions
      // from their toJSON() method, and we were calling structuredClone on the result
      // Without the fix, this would throw "The object can not be cloned"
      const celExpr = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'resource.status.ready',
      };

      const deployedResource = {
        id: 'resource',
        kind: 'Deployment',
        name: 'test',
        namespace: 'default',
        manifest: {
          status: {
            ready: true,
          },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      context.deployedResources = [deployedResource];
      context.resourceKeyMapping = new Map([['resource', deployedResource.manifest]]);

      // Simulate an Enhanced proxy that has both:
      // 1. A toJSON() method (triggers the toJSON code path)
      // 2. CEL expressions in the toJSON result (would cause structuredClone to fail without fix)
      const resourceWithToJSON = {
        id: 'test-resource',
        kind: 'Deployment',
        spec: {
          replicas: 3,
        },
        status: {
          ready: celExpr, // This CEL expression should be detected after toJSON()
        },
        toJSON: function () {
          // toJSON returns a plain object that still contains CEL expressions
          return {
            id: this.id,
            kind: this.kind,
            spec: this.spec,
            status: this.status, // Contains CEL expression!
          };
        },
      };

      // Before fix: This would throw "The object can not be cloned" because
      // structuredClone was called on toJSON() result without checking for CEL
      // After fix: selectiveClone is used when CEL detected in toJSON() output
      const resolved = await resolver.resolveReferences(resourceWithToJSON, context);

      // CEL expression should be evaluated
      expect(resolved.status.ready).toBe(true);
      expect(resolved.spec.replicas).toBe(3);
    });
  });
});
