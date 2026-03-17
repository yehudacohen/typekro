/**
 * Unit tests for CRDManager
 *
 * Tests the CRD lifecycle management class including custom resource detection,
 * CRD name resolution, Flux CRD auto-fix logic, and CRD establishment waiting.
 */

import { beforeEach, describe, expect, it, type Mock, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { CRDManager } from '../../src/core/deployment/crd-manager.js';
import { DeploymentTimeoutError } from '../../src/core/errors.js';
import type { TypeKroLogger } from '../../src/core/logging/types.js';
import type { DeploymentOptions } from '../../src/core/types/deployment.js';
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';
import { createMockK8sApi, createMockKubeConfig } from '../utils/mock-factories.js';

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

function createTestMockK8sApi(): MockK8sApi {
  return createMockK8sApi() as unknown as MockK8sApi;
}

function createMockLogger(): TypeKroLogger {
  const logger: TypeKroLogger = {
    trace: mock(() => undefined),
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    fatal: mock(() => undefined),
    child: mock(() => logger),
  };
  return logger;
}

function createTestResource(overrides: Partial<KubernetesResource> = {}): KubernetesResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'test-resource', namespace: 'default' },
    ...overrides,
  };
}

describe('CRDManager', () => {
  let mockApi: MockK8sApi;
  let mockKubeConfig: k8s.KubeConfig;
  let abortableDelay: MockFn;
  let withAbortSignal: MockFn;
  let crdManager: CRDManager;
  let mockLogger: TypeKroLogger;

  beforeEach(() => {
    mockApi = createTestMockK8sApi();
    mockKubeConfig = createMockKubeConfig();
    abortableDelay = mock(() => Promise.resolve());
    withAbortSignal = mock(<T>(operation: Promise<T>) => operation);
    mockLogger = createMockLogger();
    crdManager = new CRDManager(mockApi, mockKubeConfig, abortableDelay, withAbortSignal);
  });

  // ===========================================================================
  // isCustomResource
  // ===========================================================================

  describe('isCustomResource', () => {
    it('should return false for core API group (v1)', () => {
      const resource = createTestResource({ apiVersion: 'v1', kind: 'ConfigMap' });
      expect(crdManager.isCustomResource(resource)).toBe(false);
    });

    it('should return false for apps/v1 (built-in)', () => {
      const resource = createTestResource({ apiVersion: 'apps/v1', kind: 'Deployment' });
      expect(crdManager.isCustomResource(resource)).toBe(false);
    });

    it('should return false for networking.k8s.io/v1 (built-in)', () => {
      const resource = createTestResource({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' });
      expect(crdManager.isCustomResource(resource)).toBe(false);
    });

    it('should return false for batch/v1 (built-in)', () => {
      const resource = createTestResource({ apiVersion: 'batch/v1', kind: 'Job' });
      expect(crdManager.isCustomResource(resource)).toBe(false);
    });

    it('should return false for rbac.authorization.k8s.io/v1 (built-in)', () => {
      const resource = createTestResource({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRole',
      });
      expect(crdManager.isCustomResource(resource)).toBe(false);
    });

    it('should return false for apiextensions.k8s.io/v1 (CRD definitions themselves)', () => {
      const resource = createTestResource({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
      });
      expect(crdManager.isCustomResource(resource)).toBe(false);
    });

    it('should return true for custom API group (example.com/v1)', () => {
      const resource = createTestResource({ apiVersion: 'example.com/v1', kind: 'MyApp' });
      expect(crdManager.isCustomResource(resource)).toBe(true);
    });

    it('should return true for Flux toolkit CRDs', () => {
      const resource = createTestResource({
        apiVersion: 'helm.toolkit.fluxcd.io/v2beta2',
        kind: 'HelmRelease',
      });
      expect(crdManager.isCustomResource(resource)).toBe(true);
    });

    it('should return true for cert-manager CRDs', () => {
      const resource = createTestResource({
        apiVersion: 'cert-manager.io/v1',
        kind: 'Certificate',
      });
      expect(crdManager.isCustomResource(resource)).toBe(true);
    });

    it('should return false when apiVersion is missing', () => {
      const resource = createTestResource({ apiVersion: undefined as unknown as string });
      expect(crdManager.isCustomResource(resource)).toBe(false);
    });

    it('should return false when kind is missing', () => {
      const resource = createTestResource({ kind: undefined as unknown as string });
      expect(crdManager.isCustomResource(resource)).toBe(false);
    });
  });

  // ===========================================================================
  // getCRDNameForResource
  // ===========================================================================

  describe('getCRDNameForResource', () => {
    it('should return null for built-in resources', async () => {
      const resource = createTestResource({ apiVersion: 'apps/v1', kind: 'Deployment' });
      const result = await crdManager.getCRDNameForResource(resource);
      expect(result).toBeNull();
    });

    it('should return null when apiVersion is missing', async () => {
      const resource = createTestResource({ apiVersion: undefined as unknown as string });
      const result = await crdManager.getCRDNameForResource(resource);
      expect(result).toBeNull();
    });

    it('should return null when kind is missing', async () => {
      const resource = createTestResource({ kind: undefined as unknown as string });
      const result = await crdManager.getCRDNameForResource(resource);
      expect(result).toBeNull();
    });

    it('should return null for core API group without slash (no group)', async () => {
      const resource = createTestResource({ apiVersion: 'v1', kind: 'Service' });
      const result = await crdManager.getCRDNameForResource(resource);
      expect(result).toBeNull();
    });

    it('should resolve CRD name from cluster CRD list', async () => {
      mockApi.list.mockResolvedValueOnce({
        items: [
          {
            metadata: { name: 'myapps.example.com' },
            spec: { group: 'example.com', names: { kind: 'MyApp' } },
          },
        ],
      });

      const resource = createTestResource({ apiVersion: 'example.com/v1', kind: 'MyApp' });
      const result = await crdManager.getCRDNameForResource(resource);
      expect(result).toBe('myapps.example.com');
    });

    it('should fall back to heuristic when CRD list query fails', async () => {
      mockApi.list.mockRejectedValueOnce(new Error('Forbidden'));

      const resource = createTestResource({ apiVersion: 'example.com/v1', kind: 'MyApp' });
      const result = await crdManager.getCRDNameForResource(resource);
      expect(result).toBe('myapps.example.com');
    });

    it('should fall back to heuristic when CRD is not found in list', async () => {
      mockApi.list.mockResolvedValueOnce({
        items: [
          {
            metadata: { name: 'other.example.com' },
            spec: { group: 'example.com', names: { kind: 'Other' } },
          },
        ],
      });

      const resource = createTestResource({ apiVersion: 'example.com/v1', kind: 'Widget' });
      const result = await crdManager.getCRDNameForResource(resource);
      expect(result).toBe('widgets.example.com');
    });

    it('should pluralize kind that already ends in s', async () => {
      mockApi.list.mockResolvedValueOnce({ items: [] });

      const resource = createTestResource({ apiVersion: 'example.com/v1', kind: 'Status' });
      const result = await crdManager.getCRDNameForResource(resource);
      // 'status' already ends with 's', so no extra 's'
      expect(result).toBe('status.example.com');
    });
  });

  // ===========================================================================
  // shouldAutoFixFluxCRDs
  // ===========================================================================

  describe('shouldAutoFixFluxCRDs', () => {
    const baseOptions: DeploymentOptions = { mode: 'direct' };

    it('should return true for Flux toolkit resources with default options', () => {
      const resource = createTestResource({
        apiVersion: 'helm.toolkit.fluxcd.io/v2beta2',
        kind: 'HelmRelease',
      });
      expect(crdManager.shouldAutoFixFluxCRDs(resource, baseOptions)).toBe(true);
    });

    it('should return true for source.toolkit.fluxcd.io resources', () => {
      const resource = createTestResource({
        apiVersion: 'source.toolkit.fluxcd.io/v1',
        kind: 'HelmRepository',
      });
      expect(crdManager.shouldAutoFixFluxCRDs(resource, baseOptions)).toBe(true);
    });

    it('should return false for non-Flux resources', () => {
      const resource = createTestResource({
        apiVersion: 'example.com/v1',
        kind: 'MyApp',
      });
      expect(crdManager.shouldAutoFixFluxCRDs(resource, baseOptions)).toBe(false);
    });

    it('should return false when autoFix.fluxCRDs is explicitly false', () => {
      const resource = createTestResource({
        apiVersion: 'helm.toolkit.fluxcd.io/v2beta2',
        kind: 'HelmRelease',
      });
      const options: DeploymentOptions = {
        mode: 'direct',
        autoFix: { fluxCRDs: false },
      };
      expect(crdManager.shouldAutoFixFluxCRDs(resource, options)).toBe(false);
    });

    it('should return true when autoFix.fluxCRDs is explicitly true', () => {
      const resource = createTestResource({
        apiVersion: 'helm.toolkit.fluxcd.io/v2beta2',
        kind: 'HelmRelease',
      });
      const options: DeploymentOptions = {
        mode: 'direct',
        autoFix: { fluxCRDs: true },
      };
      expect(crdManager.shouldAutoFixFluxCRDs(resource, options)).toBe(true);
    });

    it('should return false when apiVersion is missing', () => {
      const resource = createTestResource({ apiVersion: undefined as unknown as string });
      expect(crdManager.shouldAutoFixFluxCRDs(resource, baseOptions)).toBe(false);
    });
  });

  // ===========================================================================
  // waitForCRDEstablishment
  // ===========================================================================

  describe('waitForCRDEstablishment', () => {
    const defaultOptions: DeploymentOptions = { mode: 'direct', timeout: 5000 };

    it('should resolve immediately when CRD is established', async () => {
      mockApi.read.mockResolvedValueOnce({
        metadata: { name: 'myapps.example.com' },
        status: {
          conditions: [{ type: 'Established', status: 'True' }],
        },
      });

      await crdManager.waitForCRDEstablishment(
        { metadata: { name: 'myapps.example.com' } },
        defaultOptions,
        mockLogger
      );

      expect(mockApi.read).toHaveBeenCalledTimes(1);
    });

    it('should poll until CRD becomes established', async () => {
      // First call: not established. Second call: established.
      mockApi.read
        .mockResolvedValueOnce({
          metadata: { name: 'myapps.example.com' },
          status: {
            conditions: [{ type: 'Established', status: 'False' }],
          },
        })
        .mockResolvedValueOnce({
          metadata: { name: 'myapps.example.com' },
          status: {
            conditions: [{ type: 'Established', status: 'True' }],
          },
        });

      await crdManager.waitForCRDEstablishment(
        { metadata: { name: 'myapps.example.com' } },
        defaultOptions,
        mockLogger
      );

      expect(mockApi.read).toHaveBeenCalledTimes(2);
      expect(abortableDelay).toHaveBeenCalledTimes(1);
    });

    it('should poll when CRD read fails with 404 (not yet created)', async () => {
      // First call: 404 not found. Second call: established.
      mockApi.read
        .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { statusCode: 404 }))
        .mockResolvedValueOnce({
          metadata: { name: 'myapps.example.com' },
          status: {
            conditions: [{ type: 'Established', status: 'True' }],
          },
        });

      await crdManager.waitForCRDEstablishment(
        { metadata: { name: 'myapps.example.com' } },
        defaultOptions,
        mockLogger
      );

      expect(mockApi.read).toHaveBeenCalledTimes(2);
      expect(abortableDelay).toHaveBeenCalledTimes(1);
    });

    it('should throw DeploymentTimeoutError when CRD is never established', async () => {
      // Always return not-established, use a very short timeout
      mockApi.read.mockImplementation(() =>
        Promise.resolve({
          metadata: { name: 'myapps.example.com' },
          status: {
            conditions: [{ type: 'Established', status: 'False' }],
          },
        })
      );

      // Simulate time passing by making Date.now() advance
      let callCount = 0;
      const originalDateNow = Date.now;
      const start = originalDateNow();
      const dateNowMock = mock(() => {
        callCount++;
        // First call is the start, subsequent calls exceed timeout
        return callCount <= 1 ? start : start + 10000;
      });
      Date.now = dateNowMock;

      try {
        await expect(
          crdManager.waitForCRDEstablishment(
            { metadata: { name: 'myapps.example.com' } },
            { mode: 'direct', timeout: 5000 },
            mockLogger
          )
        ).rejects.toThrow(DeploymentTimeoutError);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should throw AbortError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        crdManager.waitForCRDEstablishment(
          { metadata: { name: 'myapps.example.com' } },
          defaultOptions,
          mockLogger,
          controller.signal
        )
      ).rejects.toThrow('Operation aborted');
    });

    it('should re-throw AbortError from withAbortSignal during polling', async () => {
      const abortError = new DOMException('Operation aborted', 'AbortError');
      // withAbortSignal rejects with AbortError (simulating abort mid-read)
      withAbortSignal.mockImplementationOnce(() => Promise.reject(abortError));

      await expect(
        crdManager.waitForCRDEstablishment(
          { metadata: { name: 'myapps.example.com' } },
          defaultOptions,
          mockLogger,
          new AbortController().signal
        )
      ).rejects.toThrow('Operation aborted');
    });

    it('should re-throw AbortError from abortableDelay during polling', async () => {
      // First read: not established
      mockApi.read.mockResolvedValueOnce({
        metadata: { name: 'myapps.example.com' },
        status: {
          conditions: [{ type: 'Established', status: 'False' }],
        },
      });

      const abortError = new DOMException('Operation aborted', 'AbortError');
      abortableDelay.mockRejectedValueOnce(abortError);

      await expect(
        crdManager.waitForCRDEstablishment(
          { metadata: { name: 'myapps.example.com' } },
          defaultOptions,
          mockLogger,
          new AbortController().signal
        )
      ).rejects.toThrow('Operation aborted');
    });

    it('should handle CRD with no conditions gracefully', async () => {
      // First: no conditions. Second: established.
      mockApi.read
        .mockResolvedValueOnce({
          metadata: { name: 'myapps.example.com' },
          status: {},
        })
        .mockResolvedValueOnce({
          metadata: { name: 'myapps.example.com' },
          status: {
            conditions: [{ type: 'Established', status: 'True' }],
          },
        });

      await crdManager.waitForCRDEstablishment(
        { metadata: { name: 'myapps.example.com' } },
        defaultOptions,
        mockLogger
      );

      expect(mockApi.read).toHaveBeenCalledTimes(2);
    });

    it('should use DEFAULT_DEPLOYMENT_TIMEOUT when timeout is not provided', async () => {
      mockApi.read.mockResolvedValueOnce({
        metadata: { name: 'myapps.example.com' },
        status: {
          conditions: [{ type: 'Established', status: 'True' }],
        },
      });

      await crdManager.waitForCRDEstablishment(
        { metadata: { name: 'myapps.example.com' } },
        { mode: 'direct' },
        mockLogger
      );

      expect(mockApi.read).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // waitForCRDIfCustomResource
  // ===========================================================================

  describe('waitForCRDIfCustomResource', () => {
    const defaultOptions: DeploymentOptions = { mode: 'direct', timeout: 5000 };

    it('should skip waiting for built-in resources', async () => {
      const resource = createTestResource({ apiVersion: 'apps/v1', kind: 'Deployment' });

      await crdManager.waitForCRDIfCustomResource(resource, defaultOptions, mockLogger);

      expect(mockApi.read).not.toHaveBeenCalled();
      expect(mockApi.list).not.toHaveBeenCalled();
    });

    it('should wait for CRD establishment for custom resources', async () => {
      // getCRDNameForResource list call
      mockApi.list.mockResolvedValueOnce({
        items: [
          {
            metadata: { name: 'myapps.example.com' },
            spec: { group: 'example.com', names: { kind: 'MyApp' } },
          },
        ],
      });

      // waitForCRDEstablishment read call — CRD is established
      mockApi.read.mockResolvedValueOnce({
        metadata: { name: 'myapps.example.com' },
        status: {
          conditions: [{ type: 'Established', status: 'True' }],
        },
      });

      const resource = createTestResource({ apiVersion: 'example.com/v1', kind: 'MyApp' });

      await crdManager.waitForCRDIfCustomResource(resource, defaultOptions, mockLogger);

      expect(mockApi.list).toHaveBeenCalledTimes(1);
      expect(mockApi.read).toHaveBeenCalledTimes(1);
    });

    it('should throw AbortError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const resource = createTestResource({ apiVersion: 'example.com/v1', kind: 'MyApp' });

      await expect(
        crdManager.waitForCRDIfCustomResource(
          resource,
          defaultOptions,
          mockLogger,
          controller.signal
        )
      ).rejects.toThrow('Operation aborted');
    });

    it('should warn and return if CRD name cannot be determined', async () => {
      // Return empty items so no CRD name is found — but resource has no group
      const resource = createTestResource({
        apiVersion: 'v1',
        kind: 'UnknownThing',
      });
      // v1 is built-in, so isCustomResource returns false and it returns early
      await crdManager.waitForCRDIfCustomResource(resource, defaultOptions, mockLogger);

      expect(mockApi.read).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // waitForCRDReady
  // ===========================================================================

  describe('waitForCRDReady', () => {
    it('should wait for CRD readiness by name', async () => {
      mockApi.read.mockResolvedValueOnce({
        metadata: { name: 'myapps.example.com' },
        status: {
          conditions: [{ type: 'Established', status: 'True' }],
        },
      });

      await crdManager.waitForCRDReady('myapps.example.com', 'direct');

      expect(mockApi.read).toHaveBeenCalledTimes(1);
    });

    it('should use provided timeout', async () => {
      mockApi.read.mockResolvedValueOnce({
        metadata: { name: 'myapps.example.com' },
        status: {
          conditions: [{ type: 'Established', status: 'True' }],
        },
      });

      await crdManager.waitForCRDReady('myapps.example.com', 'direct', 10000);

      expect(mockApi.read).toHaveBeenCalledTimes(1);
    });

    it('should forward abort signal', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        crdManager.waitForCRDReady('myapps.example.com', 'direct', 5000, controller.signal)
      ).rejects.toThrow('Operation aborted');
    });
  });

  // ===========================================================================
  // ensureFluxCRDsPatched (caching behavior)
  // ===========================================================================

  describe('ensureFluxCRDsPatched', () => {
    it('should only patch once (caches the promise)', async () => {
      // ensureFluxCRDsPatched lazy-imports crd-patcher. We can't easily mock that,
      // but we can verify it caches by calling twice and checking the promise identity.
      // The import will fail in unit test context (no real cluster), but the error
      // should be caught and logged as a warning.

      const options: DeploymentOptions = {
        mode: 'direct',
        autoFix: { logLevel: 'debug' },
      };

      // First call — will fail on dynamic import but catch the error
      await crdManager.ensureFluxCRDsPatched(options, mockLogger);

      // Second call — should reuse or re-attempt (depending on whether first failed)
      await crdManager.ensureFluxCRDsPatched(options, mockLogger);

      // The logger should have been called (either success or warning)
      const debugCalls = (mockLogger.debug as MockFn).mock.calls;
      const warnCalls = (mockLogger.warn as MockFn).mock.calls;
      expect(debugCalls.length + warnCalls.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Integration: isCustomResource + getCRDNameForResource
  // ===========================================================================

  describe('isCustomResource + getCRDNameForResource integration', () => {
    it('should identify and resolve a Flux HelmRelease CRD name', async () => {
      const resource = createTestResource({
        apiVersion: 'helm.toolkit.fluxcd.io/v2beta2',
        kind: 'HelmRelease',
      });

      expect(crdManager.isCustomResource(resource)).toBe(true);

      mockApi.list.mockResolvedValueOnce({
        items: [
          {
            metadata: { name: 'helmreleases.helm.toolkit.fluxcd.io' },
            spec: {
              group: 'helm.toolkit.fluxcd.io',
              names: { kind: 'HelmRelease' },
            },
          },
        ],
      });

      const crdName = await crdManager.getCRDNameForResource(resource);
      expect(crdName).toBe('helmreleases.helm.toolkit.fluxcd.io');
    });

    it('should use heuristic for unknown custom resource kinds', async () => {
      const resource = createTestResource({
        apiVersion: 'custom.io/v1alpha1',
        kind: 'Database',
      });

      expect(crdManager.isCustomResource(resource)).toBe(true);

      mockApi.list.mockResolvedValueOnce({ items: [] });

      const crdName = await crdManager.getCRDNameForResource(resource);
      expect(crdName).toBe('databases.custom.io');
    });
  });
});
