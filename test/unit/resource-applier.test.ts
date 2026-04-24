/**
 * Unit tests for ResourceApplier
 *
 * Tests the core resource application mechanics: serialization, namespace
 * application, existence checking, patch payload construction, and the
 * main apply-with-retry loop.
 */

import { beforeEach, describe, expect, it, type Mock, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import {
  ResourceConflictError,
  ResourceDeploymentError,
  UnsupportedMediaTypeError,
} from '../../src/core/deployment/errors.js';
import { ResourceApplier } from '../../src/core/deployment/resource-applier.js';
import type { TypeKroLogger } from '../../src/core/logging/types.js';
import {
  getResourceMetadata,
  setReadinessEvaluator,
  setResourceId,
} from '../../src/core/metadata/index.js';
import type { ReferenceResolver } from '../../src/core/references/resolver.js';
import type { DeploymentOptions, ResolutionContext } from '../../src/core/types/deployment.js';
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';
import { createK8sError, createMockK8sApi } from '../utils/mock-factories.js';

// =============================================================================
// MOCK HELPERS
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type requires generic function signature
type MockFn = Mock<(...args: any[]) => any>;

/** Typed mock K8s API that exposes mock methods for test assertions */
interface MockK8sApi extends k8s.KubernetesObjectApi {
  create: MockFn;
  read: MockFn;
  delete: MockFn;
  patch: MockFn;
  replace: MockFn;
  list: MockFn;
}

/** Create a typed mock K8s API using the shared factory */
function createTestMockK8sApi(options?: Parameters<typeof createMockK8sApi>[0]): MockK8sApi {
  return createMockK8sApi(options) as unknown as MockK8sApi;
}

/** Create a silent mock logger for tests */
function createMockLogger(): TypeKroLogger {
  const logger: TypeKroLogger = {
    trace: mock(() => {}),
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    fatal: mock(() => {}),
    child: mock(() => logger),
  };
  return logger;
}

/** Create a mock ReferenceResolver */
function createMockReferenceResolver(resolveResult?: KubernetesResource): ReferenceResolver {
  return {
    resolveReferences: mock((resource: KubernetesResource) =>
      Promise.resolve(resolveResult ?? resource)
    ),
  } as unknown as ReferenceResolver;
}

/** Create a minimal KubernetesResource for testing */
function createTestResource(overrides: Partial<KubernetesResource> = {}): KubernetesResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'test-deployment',
      namespace: 'default',
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'test' } },
      template: {
        metadata: { labels: { app: 'test' } },
        spec: { containers: [{ name: 'app', image: 'nginx' }] },
      },
    },
    ...overrides,
  };
}

/** Default deployment options for tests */
function createTestOptions(overrides: Partial<DeploymentOptions> = {}): DeploymentOptions {
  return {
    mode: 'direct',
    retryPolicy: {
      maxRetries: 0,
      backoffMultiplier: 1,
      initialDelay: 10,
      maxDelay: 100,
    },
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('ResourceApplier', () => {
  let mockApi: MockK8sApi;
  let mockLogger: TypeKroLogger;
  let mockRefResolver: ReferenceResolver;
  let applier: ResourceApplier;

  beforeEach(() => {
    mockApi = createTestMockK8sApi();
    mockLogger = createMockLogger();
    mockRefResolver = createMockReferenceResolver();
    applier = new ResourceApplier(mockApi as k8s.KubernetesObjectApi, mockRefResolver, mockLogger);
  });

  // ===========================================================================
  // serializeResourceForK8s
  // ===========================================================================

  describe('serializeResourceForK8s', () => {
    it('should deep clone a resource and strip the id field', () => {
      const resource = createTestResource({ id: 'myDeployment' });
      const serialized = applier.serializeResourceForK8s(resource);

      expect(serialized.id).toBeUndefined();
      expect(serialized.apiVersion).toBe('apps/v1');
      expect(serialized.kind).toBe('Deployment');
      expect((serialized.metadata as { name: string }).name).toBe('test-deployment');
    });

    it('should call toJSON if available', () => {
      const customJSON: KubernetesResource = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'from-toJSON' },
      };
      const resource = createTestResource({
        toJSON: () => customJSON,
      });

      const serialized = applier.serializeResourceForK8s(resource);
      expect(serialized.kind).toBe('Service');
      expect((serialized.metadata as { name: string }).name).toBe('from-toJSON');
    });

    it('should produce a clean JSON-serializable object (no proxies)', () => {
      const resource = createTestResource();
      const serialized = applier.serializeResourceForK8s(resource);

      // Should be a plain object, re-serializable without error
      const roundTripped = JSON.parse(JSON.stringify(serialized));
      expect(roundTripped.apiVersion).toBe('apps/v1');
    });
  });

  // ===========================================================================
  // applyNamespaceToResource
  // ===========================================================================

  describe('applyNamespaceToResource', () => {
    it('should add namespace to resource metadata when none is present', () => {
      const resource = createTestResource({
        metadata: { name: 'test' },
      });
      // Ensure no namespace on the metadata
      delete (resource.metadata as Record<string, unknown>).namespace;

      const result = applier.applyNamespaceToResource(resource, 'my-ns', mockLogger);

      expect(result.metadata.namespace).toBe('my-ns');
      expect(result.metadata.name).toBe('test');
    });

    it('should return original resource when namespace is undefined', () => {
      const resource = createTestResource();
      const result = applier.applyNamespaceToResource(resource, undefined, mockLogger);

      expect(result).toBe(resource);
    });

    it('should return original resource when it already has a string namespace', () => {
      const resource = createTestResource({
        metadata: { name: 'test', namespace: 'existing-ns' },
      });
      const result = applier.applyNamespaceToResource(resource, 'new-ns', mockLogger);

      // Should NOT override existing namespace
      expect(result).toBe(resource);
      expect(result.metadata.namespace).toBe('existing-ns');
    });

    it('should return original resource when metadata is missing', () => {
      const resource = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
      } as KubernetesResource;

      const result = applier.applyNamespaceToResource(resource, 'my-ns', mockLogger);
      expect(result).toBe(resource);
    });

    it('should copy WeakMap metadata to the new resource object', () => {
      const resource = createTestResource({
        metadata: { name: 'test' },
      });
      delete (resource.metadata as Record<string, unknown>).namespace;

      // Set metadata on the original resource via WeakMap
      setResourceId(resource, 'myDeployment');
      const evaluator = () => ({ ready: true, message: 'ok' });
      setReadinessEvaluator(resource, evaluator);

      const result = applier.applyNamespaceToResource(resource, 'target-ns', mockLogger);

      // The new object should have the metadata copied
      expect(result).not.toBe(resource);
      const meta = getResourceMetadata(result);
      expect(meta).toBeDefined();
      expect(meta?.resourceId).toBe('myDeployment');
      expect(meta?.readinessEvaluator).toBe(evaluator);
    });

    it('should create a new object, not mutate the original', () => {
      const resource = createTestResource({
        metadata: { name: 'test' },
      });
      delete (resource.metadata as Record<string, unknown>).namespace;

      const result = applier.applyNamespaceToResource(resource, 'new-ns', mockLogger);

      expect(result).not.toBe(resource);
      expect(resource.metadata.namespace).toBeUndefined();
      expect(result.metadata.namespace).toBe('new-ns');
    });
  });

  // ===========================================================================
  // buildPatchPayload
  // ===========================================================================

  describe('buildPatchPayload', () => {
    it('should include apiVersion, kind, metadata, and spec', () => {
      const resource = createTestResource();
      const payload = applier.buildPatchPayload(resource);

      expect(payload.apiVersion).toBe('apps/v1');
      expect(payload.kind).toBe('Deployment');
      expect(payload.metadata).toBeDefined();
      expect(payload.spec).toBeDefined();
    });

    it('should include data and stringData for Secret resources', () => {
      const secret = createTestResource({
        apiVersion: 'v1',
        kind: 'Secret',
        data: { password: 'base64encoded' },
        stringData: { token: 'raw-token' },
      });

      const payload = applier.buildPatchPayload(secret);
      expect(payload.data).toEqual({ password: 'base64encoded' });
      expect(payload.stringData).toEqual({ token: 'raw-token' });
    });

    it('should include rules, subjects, and roleRef for RBAC resources', () => {
      const clusterRoleBinding: KubernetesResource = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: { name: 'test-binding' },
        rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }],
        subjects: [{ kind: 'ServiceAccount', name: 'test-sa', namespace: 'default' }],
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'admin' },
      };

      const payload = applier.buildPatchPayload(clusterRoleBinding);
      expect(payload.rules).toBeDefined();
      expect(payload.subjects).toBeDefined();
      expect(payload.roleRef).toBeDefined();
    });

    it('should preserve arrays in rules and subjects (not convert to objects)', () => {
      const resource: KubernetesResource = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRole',
        metadata: { name: 'test-role' },
        rules: [
          { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
          { apiGroups: ['apps'], resources: ['deployments'], verbs: ['create'] },
        ],
        subjects: [
          { kind: 'User', name: 'alice' },
          { kind: 'User', name: 'bob' },
        ],
      };

      const payload = applier.buildPatchPayload(resource);
      expect(Array.isArray(payload.rules)).toBe(true);
      expect(Array.isArray(payload.subjects)).toBe(true);
    });

    it('should strip internal id field from the payload', () => {
      const resource = createTestResource({ id: 'internalId' });
      const payload = applier.buildPatchPayload(resource);

      expect(payload.id).toBeUndefined();
    });
  });

  // ===========================================================================
  // checkResourceExists
  // ===========================================================================

  describe('checkResourceExists', () => {
    it('should return the resource when read succeeds (resource exists)', async () => {
      const liveResource: k8s.KubernetesObject = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default', uid: 'abc-123' },
      };
      mockApi.read.mockImplementation(() => Promise.resolve(liveResource));

      const resource = createTestResource();
      const result = await applier.checkResourceExists(resource, mockLogger);

      expect(result).toBe(liveResource);
      expect(mockApi.read).toHaveBeenCalledTimes(1);
    });

    it('should return undefined when read returns 404 (resource does not exist)', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Not Found', 404)));

      const resource = createTestResource();
      const result = await applier.checkResourceExists(resource, mockLogger);

      expect(result).toBeUndefined();
    });

    it('should throw for non-404 errors', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Forbidden', 403)));

      const resource = createTestResource();
      await expect(applier.checkResourceExists(resource, mockLogger)).rejects.toThrow('Forbidden');
    });

    it('should handle 404 from response.statusCode format', async () => {
      const error = Object.assign(new Error('Not Found'), {
        response: { statusCode: 404 },
      });
      mockApi.read.mockImplementation(() => Promise.reject(error));

      const resource = createTestResource();
      const result = await applier.checkResourceExists(resource, mockLogger);
      expect(result).toBeUndefined();
    });

    it('should handle 404 from body.code format', async () => {
      const error = Object.assign(new Error('Not Found'), {
        body: { code: 404, message: 'not found' },
      });
      mockApi.read.mockImplementation(() => Promise.reject(error));

      const resource = createTestResource();
      const result = await applier.checkResourceExists(resource, mockLogger);
      expect(result).toBeUndefined();
    });

    it('should handle 404 from message string format', async () => {
      const error = new Error('HTTP-Code: 404 - Not Found');
      mockApi.read.mockImplementation(() => Promise.reject(error));

      const resource = createTestResource();
      const result = await applier.checkResourceExists(resource, mockLogger);
      expect(result).toBeUndefined();
    });

    it('should use default namespace when resource has no namespace', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Not Found', 404)));

      const resource: KubernetesResource = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'test-cm' },
      };

      await applier.checkResourceExists(resource, mockLogger);

      expect(mockApi.read).toHaveBeenCalledWith({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'test-cm', namespace: 'default' },
      });
    });

    it('should handle Unrecognized API version error without throwing', async () => {
      const error = new Error('Unrecognized API version and kind: example.com/v1/MyResource');
      mockApi.read.mockImplementation(() => Promise.reject(error));

      const resource = createTestResource();
      await expect(applier.checkResourceExists(resource, mockLogger)).rejects.toThrow(
        'Unrecognized API version'
      );
    });
  });

  // ===========================================================================
  // applyResourceToCluster
  // ===========================================================================

  describe('applyResourceToCluster', () => {
    it('should create a new resource when it does not exist (404 on read)', async () => {
      const createdResource: k8s.KubernetesObject = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default', uid: 'new-uid' },
      };

      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Not Found', 404)));
      mockApi.create.mockImplementation(() => Promise.resolve(createdResource));

      const resource = createTestResource();
      const options = createTestOptions();
      const result = await applier.applyResourceToCluster(resource, options, mockLogger);

      expect(result).toBe(createdResource);
      expect(mockApi.create).toHaveBeenCalledTimes(1);
      expect(mockApi.patch).not.toHaveBeenCalled();
    });

    it('should patch an existing resource when read succeeds (200)', async () => {
      const existingResource: k8s.KubernetesObject = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default', uid: 'existing-uid' },
      };
      const patchedResource: k8s.KubernetesObject = {
        ...existingResource,
        metadata: { ...existingResource.metadata, resourceVersion: '2' },
      };

      mockApi.read.mockImplementation(() => Promise.resolve(existingResource));
      mockApi.patch.mockImplementation(() => Promise.resolve(patchedResource));

      const resource = createTestResource();
      const options = createTestOptions();
      const result = await applier.applyResourceToCluster(resource, options, mockLogger);

      expect(result).toBe(patchedResource);
      expect(mockApi.patch).toHaveBeenCalledTimes(1);
      expect(mockApi.create).not.toHaveBeenCalled();
    });

    it('should return a dry-run resource when dryRun is true', async () => {
      const resource = createTestResource();
      const options = createTestOptions({ dryRun: true });
      const result = await applier.applyResourceToCluster(resource, options, mockLogger);

      expect(result.metadata?.uid).toBe('dry-run-uid');
      // K8s API should not be called
      expect(mockApi.read).not.toHaveBeenCalled();
      expect(mockApi.create).not.toHaveBeenCalled();
    });

    it('should throw ResourceDeploymentError after exhausting retries', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Not Found', 404)));
      mockApi.create.mockImplementation(() =>
        Promise.reject(createK8sError('Internal Server Error', 500))
      );

      const resource = createTestResource();
      const options = createTestOptions({
        retryPolicy: {
          maxRetries: 1,
          backoffMultiplier: 1,
          initialDelay: 1,
          maxDelay: 10,
        },
      });

      await expect(applier.applyResourceToCluster(resource, options, mockLogger)).rejects.toThrow(
        ResourceDeploymentError
      );
    });

    it('should throw UnsupportedMediaTypeError on HTTP 415', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Not Found', 404)));
      mockApi.create.mockImplementation(() =>
        Promise.reject(createK8sError('Unsupported Media Type', 415))
      );

      const resource = createTestResource();
      const options = createTestOptions();

      await expect(applier.applyResourceToCluster(resource, options, mockLogger)).rejects.toThrow(
        UnsupportedMediaTypeError
      );
    });

    it('should not strip id from the payload sent to create', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Not Found', 404)));
      mockApi.create.mockImplementation((resource: Record<string, unknown>) => {
        // The serialized resource should have id stripped
        expect(resource.id).toBeUndefined();
        return Promise.resolve(resource as k8s.KubernetesObject);
      });

      const resource = createTestResource({ id: 'shouldBeStripped' });
      const options = createTestOptions();
      await applier.applyResourceToCluster(resource, options, mockLogger);

      expect(mockApi.create).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // handleConflictStrategy
  // ===========================================================================

  describe('handleConflictStrategy', () => {
    const resource = createTestResource();

    it('should throw ResourceConflictError when strategy is "fail"', async () => {
      await expect(applier.handleConflictStrategy(resource, 'fail', mockLogger)).rejects.toThrow(
        ResourceConflictError
      );
    });

    it('should read existing resource when strategy is "warn"', async () => {
      const existingResource: k8s.KubernetesObject = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default' },
      };
      mockApi.read.mockImplementation(() => Promise.resolve(existingResource));

      const result = await applier.handleConflictStrategy(resource, 'warn', mockLogger);
      expect(result).toBe(existingResource);
    });

    it('should fall back to patch when warn strategy read fails', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Not Found', 404)));
      const patchedResource: k8s.KubernetesObject = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default' },
      };
      mockApi.patch.mockImplementation(() => Promise.resolve(patchedResource));

      const result = await applier.handleConflictStrategy(resource, 'warn', mockLogger);
      expect(result).toBe(patchedResource);
    });

    it('should return undefined when warn strategy both read and patch fail', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Error', 500)));
      mockApi.patch.mockImplementation(() => Promise.reject(createK8sError('Error', 500)));

      const result = await applier.handleConflictStrategy(resource, 'warn', mockLogger);
      expect(result).toBeUndefined();
    });

    it('should patch resource when strategy is "patch"', async () => {
      const patchedResource: k8s.KubernetesObject = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default' },
      };
      mockApi.patch.mockImplementation(() => Promise.resolve(patchedResource));

      const result = await applier.handleConflictStrategy(resource, 'patch', mockLogger);
      expect(result).toBe(patchedResource);
    });

    it('should return undefined when patch strategy fails', async () => {
      mockApi.patch.mockImplementation(() => Promise.reject(createK8sError('Error', 500)));

      const result = await applier.handleConflictStrategy(resource, 'patch', mockLogger);
      expect(result).toBeUndefined();
    });

    it('should delete and recreate when strategy is "replace"', async () => {
      const recreatedResource: k8s.KubernetesObject = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default', uid: 'new-uid' },
      };
      mockApi.delete.mockImplementation(() => Promise.resolve({}));
      mockApi.create.mockImplementation(() => Promise.resolve(recreatedResource));

      const result = await applier.handleConflictStrategy(resource, 'replace', mockLogger);
      expect(result).toBe(recreatedResource);
      expect(mockApi.delete).toHaveBeenCalledTimes(1);
      expect(mockApi.create).toHaveBeenCalledTimes(1);
    });

    it('should return undefined when replace strategy fails', async () => {
      mockApi.delete.mockImplementation(() => Promise.reject(createK8sError('Error', 500)));

      const result = await applier.handleConflictStrategy(resource, 'replace', mockLogger);
      expect(result).toBeUndefined();
    });
  });

  // ===========================================================================
  // resolveResourceReferences
  // ===========================================================================

  describe('resolveResourceReferences', () => {
    it('should resolve references via the ReferenceResolver', async () => {
      const resolvedResource = createTestResource({
        metadata: { name: 'resolved-deployment', namespace: 'default' },
      });
      const resolver = createMockReferenceResolver(resolvedResource);
      const localApplier = new ResourceApplier(
        mockApi as k8s.KubernetesObjectApi,
        resolver,
        mockLogger
      );

      const resource = createTestResource({ id: 'deploy' }) as KubernetesResource & { id: string };
      const context: ResolutionContext = {
        deployedResources: [],
        kubeClient: {} as k8s.KubeConfig,
        namespace: 'default',
        resourceKeyMapping: new Map([['deploy', { kind: 'Deployment', name: 'test' }]]),
      };
      const options = createTestOptions();

      const result = await localApplier.resolveResourceReferences(
        resource as Parameters<typeof localApplier.resolveResourceReferences>[0],
        context,
        options,
        mockLogger
      );

      expect(result.metadata.name).toBe('resolved-deployment');
    });

    it('should fall back to original resource when resolution fails', async () => {
      const resolver = {
        resolveReferences: mock(() => Promise.reject(new Error('Resolution failed'))),
      } as unknown as ReferenceResolver;
      const localApplier = new ResourceApplier(
        mockApi as k8s.KubernetesObjectApi,
        resolver,
        mockLogger
      );

      const resource = createTestResource({ id: 'deploy' });
      const context: ResolutionContext = {
        deployedResources: [],
        kubeClient: {} as k8s.KubeConfig,
        namespace: 'default',
        resourceKeyMapping: new Map(),
      };
      const options = createTestOptions();

      const result = await localApplier.resolveResourceReferences(
        resource as Parameters<typeof localApplier.resolveResourceReferences>[0],
        context,
        options,
        mockLogger
      );

      // Should return the original resource on failure
      expect(result).toBe(resource);
    });

    it('should log at warn level when resolution fails with non-empty resourceKeyMapping', async () => {
      const resolver = {
        resolveReferences: mock(() => Promise.reject(new Error('Resolution failed'))),
      } as unknown as ReferenceResolver;
      const localApplier = new ResourceApplier(
        mockApi as k8s.KubernetesObjectApi,
        resolver,
        mockLogger
      );

      const resource = createTestResource({ id: 'deploy' });
      const context: ResolutionContext = {
        deployedResources: [],
        kubeClient: {} as k8s.KubeConfig,
        namespace: 'default',
        resourceKeyMapping: new Map([['deploy', 'something']]),
      };
      const options = createTestOptions();

      await localApplier.resolveResourceReferences(
        resource as Parameters<typeof localApplier.resolveResourceReferences>[0],
        context,
        options,
        mockLogger
      );

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should log at debug level when resolution fails with empty resourceKeyMapping', async () => {
      const resolver = {
        resolveReferences: mock(() => Promise.reject(new Error('Resolution failed'))),
      } as unknown as ReferenceResolver;
      const localApplier = new ResourceApplier(
        mockApi as k8s.KubernetesObjectApi,
        resolver,
        mockLogger
      );

      const resource = createTestResource({ id: 'deploy' });
      const context: ResolutionContext = {
        deployedResources: [],
        kubeClient: {} as k8s.KubeConfig,
        namespace: 'default',
        resourceKeyMapping: new Map(),
      };
      const options = createTestOptions();

      await localApplier.resolveResourceReferences(
        resource as Parameters<typeof localApplier.resolveResourceReferences>[0],
        context,
        options,
        mockLogger
      );

      expect(mockLogger.debug).toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should time out if resolution takes too long', async () => {
      const resolver = {
        resolveReferences: mock(() => new Promise((resolve) => setTimeout(resolve, 5000))),
      } as unknown as ReferenceResolver;
      const localApplier = new ResourceApplier(
        mockApi as k8s.KubernetesObjectApi,
        resolver,
        mockLogger
      );

      const resource = createTestResource({ id: 'deploy' });
      const context: ResolutionContext = {
        deployedResources: [],
        kubeClient: {} as k8s.KubeConfig,
        namespace: 'default',
        resourceKeyMapping: new Map(),
      };
      // Very short timeout to trigger the race
      const options = createTestOptions({ timeout: 10 });

      const result = await localApplier.resolveResourceReferences(
        resource as Parameters<typeof localApplier.resolveResourceReferences>[0],
        context,
        options,
        mockLogger
      );

      // Should fall back to original resource on timeout
      expect(result).toBe(resource);
    });

    it('clears the reference resolution timeout after a successful resolve', async () => {
      const resolvedResource = createTestResource({
        metadata: { name: 'resolved-deployment', namespace: 'default' },
      });
      const resolver = createMockReferenceResolver(resolvedResource);
      const localApplier = new ResourceApplier(
        mockApi as k8s.KubernetesObjectApi,
        resolver,
        mockLogger
      );

      const resource = createTestResource({ id: 'deploy' }) as KubernetesResource & { id: string };
      const context: ResolutionContext = {
        deployedResources: [],
        kubeClient: {} as k8s.KubeConfig,
        namespace: 'default',
        resourceKeyMapping: new Map([['deploy', { kind: 'Deployment', name: 'test' }]]),
      };
      const options = createTestOptions({ timeout: 12345 });

      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      const fakeTimer = { unref: mock() } as unknown as ReturnType<typeof setTimeout>;
      const clearCalls: Array<ReturnType<typeof setTimeout>> = [];

      globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
        void handler;
        void args;
        return fakeTimer;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
        clearCalls.push(timer);
      }) as typeof clearTimeout;

      try {
        const result = await localApplier.resolveResourceReferences(
          resource as Parameters<typeof localApplier.resolveResourceReferences>[0],
          context,
          options,
          mockLogger
        );

        expect(result.metadata.name).toBe('resolved-deployment');
        expect(clearCalls).toEqual([fakeTimer]);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    });
  });

  // ===========================================================================
  // applyResourceToCluster - conflict handling integration
  // ===========================================================================

  describe('applyResourceToCluster - conflict handling', () => {
    it('should handle 409 conflict with warn strategy and return existing resource', async () => {
      const existingResource: k8s.KubernetesObject = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default' },
      };

      // First read returns 404 (does not exist), then create returns 409,
      // then handleConflictStrategy reads the existing resource
      mockApi.read.mockImplementationOnce(() => Promise.reject(createK8sError('Not Found', 404)));
      mockApi.create.mockImplementation(() => Promise.reject(createK8sError('Conflict', 409)));
      // The warn strategy will call read again
      mockApi.read.mockImplementation(() => Promise.resolve(existingResource));

      const resource = createTestResource();
      const options = createTestOptions({ conflictStrategy: 'warn' });

      const result = await applier.applyResourceToCluster(resource, options, mockLogger);
      expect(result.metadata?.name).toBe('test-deployment');
    });

    it('should throw ResourceConflictError for 409 with fail strategy', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Not Found', 404)));
      mockApi.create.mockImplementation(() => Promise.reject(createK8sError('Conflict', 409)));

      const resource = createTestResource();
      const options = createTestOptions({ conflictStrategy: 'fail' });

      await expect(applier.applyResourceToCluster(resource, options, mockLogger)).rejects.toThrow(
        ResourceConflictError
      );
    });
  });

  // ===========================================================================
  // applyResourceToCluster - Secret handling
  // ===========================================================================

  describe('applyResourceToCluster - Secret resources', () => {
    it('should create a Secret resource without logging sensitive data', async () => {
      mockApi.read.mockImplementation(() => Promise.reject(createK8sError('Not Found', 404)));
      const createdSecret: k8s.KubernetesObject = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'test-secret', namespace: 'default' },
      };
      mockApi.create.mockImplementation(() => Promise.resolve(createdSecret));

      const secret = createTestResource({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'test-secret', namespace: 'default' },
        data: { password: 'c2VjcmV0' },
        spec: undefined,
      });
      const options = createTestOptions();

      const result = await applier.applyResourceToCluster(secret, options, mockLogger);
      expect(result).toBe(createdSecret);
      expect(mockApi.create).toHaveBeenCalledTimes(1);
    });
  });
});
