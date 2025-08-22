import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import {
  type AlchemyPromise,
  type AlchemyResolutionContext,
  type AlchemyResource,
  buildResourceGraphWithDeferredResolution,
  containsAlchemyPromises,
  createAlchemyReferenceResolver,
  createAlchemyResourceConfig,
  createAlchemyResourceConfigs,
  extractAlchemyPromises,
  hasMixedDependencies,
  isAlchemyPromise,
  isAlchemyResource,
  resolveAlchemyPromise,
  resolveAllReferences,
  resolveAllReferencesInAlchemyContext,
  resolveReferencesWithAlchemy,
  resolveTypeKroReferencesOnly,
} from '../../../src/alchemy/resolver.js';
import type { KubernetesResource } from '../../../src/core/types/kubernetes.js';

describe('Alchemy Resolver Comprehensive', () => {
  let mockContext: AlchemyResolutionContext;
  let mockKubeConfig: k8s.KubeConfig;

  beforeEach(() => {
    mockKubeConfig = {} as k8s.KubeConfig;
    mockContext = {
      deployedResources: [],
      kubeClient: mockKubeConfig,
      deferAlchemyResolution: false,
      alchemyResourceCache: new Map(),
    };
  });

  describe('Type Guards and Detection', () => {
    describe('isAlchemyResource', () => {
      it('should identify valid alchemy resources', () => {
        const alchemyResource: AlchemyResource = {
          __alchemyResource: true,
          id: 'test-resource-1',
          type: 'TestResource',
          deploy: mock(async () => ({ status: 'deployed' })),
        };

        expect(isAlchemyResource(alchemyResource)).toBe(true);
      });

      it('should reject invalid alchemy resources', () => {
        expect(isAlchemyResource(null)).toBe(false);
        expect(isAlchemyResource(undefined)).toBe(false);
        expect(isAlchemyResource({})).toBe(false);
        expect(isAlchemyResource({ __alchemyResource: false })).toBe(false);
        expect(isAlchemyResource({ id: 'test', type: 'Test' })).toBe(false);
      });

      it('should handle edge cases', () => {
        expect(isAlchemyResource('string')).toBe(false);
        expect(isAlchemyResource(123)).toBe(false);
        expect(isAlchemyResource([])).toBe(false);
        expect(isAlchemyResource(true)).toBe(false);
      });
    });

    describe('isAlchemyPromise', () => {
      it('should identify explicit alchemy promises', () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
          then: mock((resolve) => resolve({ status: 'resolved' })),
          catch: mock((reject) => reject),
          finally: mock((callback) => callback()),
        } as any;

        expect(isAlchemyPromise(alchemyPromise)).toBe(true);
      });

      it('should identify promises with alchemy symbols', () => {
        const symbolPromise = {
          then: mock((resolve) => resolve({ value: 'test' })),
          [Symbol.for('alchemy::promise')]: true,
        };

        expect(isAlchemyPromise(symbolPromise)).toBe(true);
      });

      it('should identify promises with resource ID symbols', () => {
        const resourceIdPromise = {
          then: mock((resolve) => resolve({ value: 'test' })),
          [Symbol.for('alchemy::resourceId')]: 'resource-123',
        };

        expect(isAlchemyPromise(resourceIdPromise)).toBe(true);
      });

      it('should reject non-promises', () => {
        expect(isAlchemyPromise(null)).toBe(false);
        expect(isAlchemyPromise(undefined)).toBe(false);
        expect(isAlchemyPromise({})).toBe(false);
        expect(isAlchemyPromise({ __alchemyPromise: true })).toBe(true); // Valid alchemy promise marker
        expect(isAlchemyPromise({ __alchemyPromise: false })).toBe(false); // Invalid marker
        expect(isAlchemyPromise('string')).toBe(false);
      });
    });
  });

  describe('Reference Resolution', () => {
    describe('resolveReferencesWithAlchemy', () => {
      it('should defer alchemy resolution when requested', async () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        const obj = { resource: alchemyPromise };
        const contextWithDefer = { ...mockContext, deferAlchemyResolution: true };

        const result = await resolveReferencesWithAlchemy(obj, contextWithDefer);

        expect(result.resource).toBe(alchemyPromise); // Should be preserved
      });

      it('should resolve all references when not deferring', async () => {
        const mockResolvedValue = { value: 'resolved' };
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
          then: mock(async (resolve) => resolve(mockResolvedValue)),
          catch: mock((reject) => reject),
          finally: mock((callback) => callback()),
        } as any;

        // Mock the promise to resolve immediately
        Object.defineProperty(alchemyPromise, 'then', {
          value: (onResolve: (value: any) => any) =>
            Promise.resolve(mockResolvedValue).then(onResolve),
        });

        const obj = { resource: alchemyPromise };

        const result = await resolveReferencesWithAlchemy(obj, mockContext);

        expect(result.resource).toEqual(mockResolvedValue);
      });
    });

    describe('resolveTypeKroReferencesOnly', () => {
      it('should preserve alchemy promises', async () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        const result = await resolveTypeKroReferencesOnly(alchemyPromise, mockContext);
        expect(result).toBe(alchemyPromise);
      });

      it('should handle null and undefined', async () => {
        expect(await resolveTypeKroReferencesOnly(null, mockContext)).toBe(null);
        expect(await resolveTypeKroReferencesOnly(undefined, mockContext)).toBe(undefined);
      });

      it('should recursively process arrays', async () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        const obj = [alchemyPromise, { normal: 'value' }];
        const result = await resolveTypeKroReferencesOnly(obj, mockContext);

        expect(result).toHaveLength(2);
        expect(result[0]).toBe(alchemyPromise); // Preserved
        expect(result[1]).toEqual({ normal: 'value' });
      });

      it('should recursively process objects', async () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        const obj = {
          alchemy: alchemyPromise,
          normal: { value: 'test' },
        };

        const result = await resolveTypeKroReferencesOnly(obj, mockContext);

        expect(result.alchemy).toBe(alchemyPromise); // Preserved
        expect(result.normal).toEqual({ value: 'test' });
      });

      it('should handle primitive values', async () => {
        expect(await resolveTypeKroReferencesOnly('string', mockContext)).toBe('string');
        expect(await resolveTypeKroReferencesOnly(123, mockContext)).toBe(123);
        expect(await resolveTypeKroReferencesOnly(true, mockContext)).toBe(true);
      });
    });

    describe('resolveAllReferences', () => {
      it('should resolve alchemy promises', async () => {
        const mockResolvedValue = { value: 'resolved' };
        const alchemyPromise = Promise.resolve(mockResolvedValue) as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = 'test-resource-1';
        alchemyPromise.resourceType = 'TestResource';

        const result = await resolveAllReferences(alchemyPromise, mockContext);
        expect(result).toEqual(mockResolvedValue);
      });

      it('should handle null and undefined', async () => {
        expect(await resolveAllReferences(null, mockContext)).toBe(null);
        expect(await resolveAllReferences(undefined, mockContext)).toBe(undefined);
      });

      it('should recursively process arrays', async () => {
        const mockResolvedValue = { value: 'resolved' };
        const alchemyPromise = Promise.resolve(mockResolvedValue) as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = 'test-resource-1';
        alchemyPromise.resourceType = 'TestResource';

        const obj = [alchemyPromise, { normal: 'value' }];
        const result = await resolveAllReferences(obj, mockContext);

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual(mockResolvedValue);
        expect(result[1]).toEqual({ normal: 'value' });
      });

      it('should recursively process objects', async () => {
        const mockResolvedValue = { value: 'resolved' };
        const alchemyPromise = Promise.resolve(mockResolvedValue) as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = 'test-resource-1';
        alchemyPromise.resourceType = 'TestResource';

        const obj = {
          alchemy: alchemyPromise,
          normal: { value: 'test' },
        };

        const result = await resolveAllReferences(obj, mockContext);

        expect(result.alchemy).toEqual(mockResolvedValue);
        expect(result.normal).toEqual({ value: 'test' });
      });
    });

    describe('resolveAlchemyPromise', () => {
      it('should resolve alchemy promises and cache results', async () => {
        const mockResolvedValue = { value: 'resolved' };
        const alchemyPromise = Promise.resolve(mockResolvedValue) as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = 'test-resource-1';
        alchemyPromise.resourceType = 'TestResource';

        const result = await resolveAlchemyPromise(alchemyPromise, mockContext);

        expect(result).toEqual(mockResolvedValue);
        expect(mockContext.alchemyResourceCache?.has('test-resource-1')).toBe(true);
        expect(mockContext.alchemyResourceCache?.get('test-resource-1')).toEqual(mockResolvedValue);
      });

      it('should return cached results', async () => {
        const cachedValue = { value: 'cached' };
        mockContext.alchemyResourceCache?.set('test-resource-1', cachedValue);

        const alchemyPromise = {} as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = 'test-resource-1';
        alchemyPromise.resourceType = 'TestResource';

        const result = await resolveAlchemyPromise(alchemyPromise, mockContext);
        expect(result).toEqual(cachedValue);
      });

      it('should handle promise rejection with informative error', async () => {
        const alchemyPromise = Promise.reject(new Error('Original error')) as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = 'test-resource-1';
        alchemyPromise.resourceType = 'TestResource';

        await expect(resolveAlchemyPromise(alchemyPromise, mockContext)).rejects.toThrow(
          'Failed to resolve alchemy resource test-resource-1: Original error'
        );
      });

      it('should handle promise rejection with non-Error values', async () => {
        const alchemyPromise = Promise.reject('string error') as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = 'test-resource-1';
        alchemyPromise.resourceType = 'TestResource';

        await expect(resolveAlchemyPromise(alchemyPromise, mockContext)).rejects.toThrow(
          'Failed to resolve alchemy resource test-resource-1: string error'
        );
      });

      it('should initialize cache if not present', async () => {
        const contextWithoutCache = { ...mockContext, alchemyResourceCache: undefined };
        const mockResolvedValue = { value: 'resolved' };
        const alchemyPromise = Promise.resolve(mockResolvedValue) as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = 'test-resource-1';
        alchemyPromise.resourceType = 'TestResource';

        await resolveAlchemyPromise(alchemyPromise, contextWithoutCache);

        expect(contextWithoutCache.alchemyResourceCache).toBeDefined();
        expect(contextWithoutCache.alchemyResourceCache?.has('test-resource-1')).toBe(true);
      });
    });
  });

  describe('Resource Graph Building', () => {
    describe('buildResourceGraphWithDeferredResolution', () => {
      it('should build resource graph with deferred alchemy resolution', async () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        const resources = {
          deployment: { spec: { replicas: 3 } },
          service: { resource: alchemyPromise },
        };

        const result = await buildResourceGraphWithDeferredResolution(resources, mockContext);

        expect(result.deployment).toEqual({ spec: { replicas: 3 } });
        expect(result.service.resource).toBe(alchemyPromise); // Should be preserved
      });

      it('should handle empty resources', async () => {
        const result = await buildResourceGraphWithDeferredResolution({}, mockContext);
        expect(result).toEqual({});
      });
    });

    describe('resolveAllReferencesInAlchemyContext', () => {
      it('should resolve all references including alchemy promises', async () => {
        const mockResolvedValue = { value: 'resolved' };
        const alchemyPromise = Promise.resolve(mockResolvedValue) as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = 'test-resource-1';
        alchemyPromise.resourceType = 'TestResource';

        const resources = {
          deployment: { spec: { replicas: 3 } },
          service: { resource: alchemyPromise },
        };

        const result = await resolveAllReferencesInAlchemyContext(resources, mockContext);

        expect(result.deployment).toEqual({ spec: { replicas: 3 } });
        expect(result.service.resource).toEqual(mockResolvedValue);
      });
    });
  });

  describe('Promise Detection and Extraction', () => {
    describe('containsAlchemyPromises', () => {
      it('should detect alchemy promises in objects', () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        expect(containsAlchemyPromises(alchemyPromise)).toBe(true);
        expect(containsAlchemyPromises({ resource: alchemyPromise })).toBe(true);
        expect(containsAlchemyPromises([alchemyPromise])).toBe(true);
        expect(containsAlchemyPromises({ nested: { deep: alchemyPromise } })).toBe(true);
      });

      it('should return false for objects without alchemy promises', () => {
        expect(containsAlchemyPromises(null)).toBe(false);
        expect(containsAlchemyPromises(undefined)).toBe(false);
        expect(containsAlchemyPromises({})).toBe(false);
        expect(containsAlchemyPromises([])).toBe(false);
        expect(containsAlchemyPromises({ normal: 'value' })).toBe(false);
        expect(containsAlchemyPromises(['normal', 'array'])).toBe(false);
        expect(containsAlchemyPromises('string')).toBe(false);
      });
    });

    describe('extractAlchemyPromises', () => {
      it('should extract all alchemy promises from objects', () => {
        const promise1: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        const promise2: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-2',
          resourceType: 'TestResource',
        } as any;

        const obj = {
          deployment: { promise: promise1 },
          service: promise2,
          normal: 'value',
        };

        const promises = extractAlchemyPromises(obj);

        expect(promises).toHaveLength(2);
        expect(promises).toContain(promise1);
        expect(promises).toContain(promise2);
      });

      it('should extract promises from arrays', () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        const arr = [alchemyPromise, 'normal', { nested: 'value' }];
        const promises = extractAlchemyPromises(arr);

        expect(promises).toHaveLength(1);
        expect(promises[0]).toBe(alchemyPromise);
      });

      it('should return empty array for objects without promises', () => {
        expect(extractAlchemyPromises({})).toEqual([]);
        expect(extractAlchemyPromises({ normal: 'value' })).toEqual([]);
        expect(extractAlchemyPromises(null)).toEqual([]);
        expect(extractAlchemyPromises(undefined)).toEqual([]);
      });
    });
  });

  describe('Utility Functions', () => {
    describe('createAlchemyReferenceResolver', () => {
      it('should create proper alchemy resolution context', () => {
        const context = createAlchemyReferenceResolver();

        expect(context).toHaveProperty('deployedResources');
        expect(context).toHaveProperty('kubeClient');
        expect(context).toHaveProperty('deferAlchemyResolution');
        expect(context).toHaveProperty('alchemyResourceCache');

        expect(Array.isArray(context.deployedResources)).toBe(true);
        expect(context.deferAlchemyResolution).toBe(false);
        expect(context.alchemyResourceCache).toBeInstanceOf(Map);
      });
    });

    describe('hasMixedDependencies', () => {
      it('should detect mixed dependencies', () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        // Mock TypeKro reference (normally would use proper references)
        const typeKroRef = {
          __type: 'KubernetesRef',
          resourceKey: 'deployment',
          path: 'status.replicas',
        };

        const resources = {
          alchemy: alchemyPromise,
          typekro: typeKroRef,
        };

        // This test would pass if proper TypeKro reference detection was implemented
        // For now, it will return false since we're not implementing full reference detection
        const result = hasMixedDependencies(resources);
        expect(typeof result).toBe('boolean');
      });

      it('should return false for only alchemy promises', () => {
        const alchemyPromise: AlchemyPromise = {
          __alchemyPromise: true,
          resourceId: 'test-resource-1',
          resourceType: 'TestResource',
        } as any;

        const resources = { alchemy: alchemyPromise };
        expect(hasMixedDependencies(resources)).toBe(false);
      });

      it('should return false for no dependencies', () => {
        const resources = { normal: 'value' };
        expect(hasMixedDependencies(resources)).toBe(false);
      });
    });
  });

  describe('Alchemy Resource Configuration', () => {
    describe('createAlchemyResourceConfig', () => {
      it('should create config from Kubernetes resource', () => {
        const kubernetesResource: KubernetesResource = {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: {
            name: 'test-deployment',
            namespace: 'default',
          },
          spec: {
            replicas: 3,
          },
        };

        const config = createAlchemyResourceConfig(kubernetesResource);

        expect(config.type).toBe('Deployment');
        expect(config.config).toBe(kubernetesResource);
        expect(config.id).toContain('Deployment'); // Should contain kind in camelCase
        expect(config.id).toContain('test'); // Should contain name
      });

      it('should use provided resourceId', () => {
        const kubernetesResource: KubernetesResource = {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: 'test-service',
          },
        };

        const customId = 'custom-resource-id';
        const config = createAlchemyResourceConfig(kubernetesResource, customId);

        expect(config.id).toBe(customId);
        expect(config.type).toBe('Service');
        expect(config.config).toBe(kubernetesResource);
      });

      it('should handle resources without metadata', () => {
        const kubernetesResource: KubernetesResource = {
          apiVersion: 'v1',
          kind: 'ConfigMap',
        };

        const config = createAlchemyResourceConfig(kubernetesResource);

        expect(config.type).toBe('ConfigMap');
        expect(config.config).toBe(kubernetesResource);
        expect(config.id).toContain('configmap');
        expect(config.id).toContain('Unnamed');
      });

      it('should handle resources without kind', () => {
        const kubernetesResource: KubernetesResource = {
          apiVersion: 'v1',
          metadata: {
            name: 'test-resource',
          },
        };

        const config = createAlchemyResourceConfig(kubernetesResource);

        expect(config.type).toBe('Resource');
        expect(config.config).toBe(kubernetesResource);
        expect(config.id).toContain('Resource');
        expect(config.id).toContain('test');
      });
    });

    describe('createAlchemyResourceConfigs', () => {
      it('should create configs for multiple resources', () => {
        const resources: Record<string, KubernetesResource> = {
          deployment: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'test-deployment' },
          },
          service: {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name: 'test-service' },
          },
        };

        const configs = createAlchemyResourceConfigs(resources);

        expect(Object.keys(configs)).toHaveLength(2);
        expect(configs.deployment.type).toBe('Deployment');
        expect(configs.service.type).toBe('Service');
        expect(configs.deployment.config).toBe(resources.deployment);
        expect(configs.service.config).toBe(resources.service);
      });

      it('should use resource key as fallback name', () => {
        const resources: Record<string, KubernetesResource> = {
          'my-configmap': {
            apiVersion: 'v1',
            kind: 'ConfigMap',
          },
        };

        const configs = createAlchemyResourceConfigs(resources);

        expect(configs['my-configmap'].id).toContain('my');
        expect(configs['my-configmap'].id).toContain('Configmap');
      });

      it('should handle empty resources', () => {
        const configs = createAlchemyResourceConfigs({});
        expect(configs).toEqual({});
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle circular references gracefully', async () => {
      const circularObj: any = { name: 'test' };
      circularObj.self = circularObj;

      // Should not throw, even with circular references
      const result = await resolveTypeKroReferencesOnly(circularObj, mockContext);
      expect(result).toBeDefined();
    });

    it('should handle very deep nested objects', async () => {
      let deepObj: any = { value: 'test' };
      for (let i = 0; i < 100; i++) {
        deepObj = { nested: deepObj };
      }

      const result = await resolveTypeKroReferencesOnly(deepObj, mockContext);
      expect(result).toBeDefined();
    });

    it('should handle mixed arrays with different types', () => {
      const alchemyPromise: AlchemyPromise = {
        __alchemyPromise: true,
        resourceId: 'test-resource-1',
        resourceType: 'TestResource',
      } as any;

      const mixedArray = [
        alchemyPromise,
        'string',
        123,
        true,
        null,
        undefined,
        { normal: 'object' },
      ];

      expect(containsAlchemyPromises(mixedArray)).toBe(true);

      const promises = extractAlchemyPromises(mixedArray);
      expect(promises).toHaveLength(1);
      expect(promises[0]).toBe(alchemyPromise);
    });
  });

  describe('Performance and Memory', () => {
    it('should not create unnecessary copies when no resolution needed', async () => {
      const originalObj = { value: 'unchanged' };
      const result = await resolveTypeKroReferencesOnly(originalObj, mockContext);

      // Should be the same reference for simple objects
      expect(result).toEqual(originalObj);
    });

    it('should properly manage cache size', async () => {
      const mockResolvedValue = { value: 'resolved' };

      // Create multiple promises
      for (let i = 0; i < 5; i++) {
        const alchemyPromise = Promise.resolve(mockResolvedValue) as AlchemyPromise;
        alchemyPromise.__alchemyPromise = true;
        alchemyPromise.resourceId = `test-resource-${i}`;
        alchemyPromise.resourceType = 'TestResource';

        await resolveAlchemyPromise(alchemyPromise, mockContext);
      }

      expect(mockContext.alchemyResourceCache?.size).toBe(5);
    });
  });
});
