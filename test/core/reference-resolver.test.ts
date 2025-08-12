/**
 * Unit tests for reference resolution system
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { ReferenceResolver } from '../../src/core.js';
import { KUBERNETES_REF_BRAND, CEL_EXPRESSION_BRAND } from '../../src/core/constants/brands.js';

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
});
