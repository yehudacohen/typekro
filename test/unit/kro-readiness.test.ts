/**
 * Unit tests for waitForKroInstanceReady
 *
 * Tests the polling-based readiness logic for Kro-managed custom resource instances.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import type { KroReadinessOptions } from '../../src/core/deployment/kro-readiness.js';
import { waitForKroInstanceReady } from '../../src/core/deployment/kro-readiness.js';
import { CRDInstanceError, DeploymentTimeoutError } from '../../src/core/errors.js';
import { createK8sError } from '../utils/mock-factories.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Create a mock KubernetesObjectApi with a controllable read() mock. */
function createMockK8sObjectApi() {
  return {
    read: mock(() => Promise.resolve({})),
    create: mock(() => Promise.resolve({})),
    patch: mock(() => Promise.resolve({})),
    delete: mock(() => Promise.resolve({})),
    list: mock(() => Promise.resolve({ items: [] })),
    replace: mock(() => Promise.resolve({})),
  } as unknown as k8s.KubernetesObjectApi & {
    read: ReturnType<typeof mock>;
  };
}

/** Create a mock CustomObjectsApi with a controllable getClusterCustomObject() mock. */
function createMockCustomObjectsApi() {
  return {
    getClusterCustomObject: mock(() =>
      Promise.resolve({
        spec: { schema: { status: {} } },
      })
    ),
    listClusterCustomObject: mock(() => Promise.resolve({ items: [] })),
    listNamespacedCustomObject: mock(() => Promise.resolve({ items: [] })),
  } as unknown as k8s.CustomObjectsApi & {
    getClusterCustomObject: ReturnType<typeof mock>;
  };
}

/** Build a Kro instance response with the given status fields. */
function kroInstance(status?: {
  state?: string;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  [key: string]: unknown;
}): k8s.KubernetesObject {
  return {
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    metadata: { name: 'test-instance', namespace: 'default' },
    ...(status !== undefined ? { status } : {}),
  };
}

/** Default options for creating a KroReadinessOptions. */
function defaultOptions(overrides: {
  k8sApi: k8s.KubernetesObjectApi;
  customObjectsApi: k8s.CustomObjectsApi;
  timeout?: number;
  pollInterval?: number;
  factoryContext?: string;
}): KroReadinessOptions {
  const opts: KroReadinessOptions = {
    instanceName: 'test-instance',
    timeout: overrides.timeout ?? 2000,
    k8sApi: overrides.k8sApi,
    customObjectsApi: overrides.customObjectsApi,
    namespace: 'default',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    rgdName: 'web-app',
    pollInterval: overrides.pollInterval ?? 100,
  };
  if (overrides.factoryContext !== undefined) {
    opts.factoryContext = overrides.factoryContext;
  }
  return opts;
}

// =============================================================================
// TESTS
// =============================================================================

describe('waitForKroInstanceReady', () => {
  let mockK8sApi: ReturnType<typeof createMockK8sObjectApi>;
  let mockCustomObjectsApi: ReturnType<typeof createMockCustomObjectsApi>;

  beforeEach(() => {
    mockK8sApi = createMockK8sObjectApi();
    mockCustomObjectsApi = createMockCustomObjectsApi();
  });

  // ---------------------------------------------------------------------------
  // 1. Resolves immediately when instance is already ready
  // ---------------------------------------------------------------------------

  describe('immediate readiness', () => {
    it('resolves when instance has ACTIVE state + Ready=True condition (v0.8.x)', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ACTIVE',
          conditions: [{ type: 'Ready', status: 'True' }],
        })
      );

      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).resolves.toBeUndefined();

      expect(mockK8sApi.read).toHaveBeenCalledTimes(1);
    });

    it('resolves when instance has ACTIVE state + InstanceSynced=True condition (v0.3.x)', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ACTIVE',
          conditions: [{ type: 'InstanceSynced', status: 'True' }],
        })
      );

      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).resolves.toBeUndefined();

      expect(mockK8sApi.read).toHaveBeenCalledTimes(1);
    });

    it('resolves when instance has custom status fields and RGD expects them', async () => {
      mockCustomObjectsApi.getClusterCustomObject.mockResolvedValue({
        spec: { schema: { status: { url: { type: 'string' } } } },
      });

      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ACTIVE',
          conditions: [{ type: 'Ready', status: 'True' }],
          url: 'http://example.com',
        })
      );

      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Polls repeatedly then resolves when ready
  // ---------------------------------------------------------------------------

  describe('polling until ready', () => {
    it('polls multiple times then resolves when status becomes ACTIVE + Ready=True', async () => {
      let callCount = 0;

      mockK8sApi.read.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          // Not ready yet — state is still PENDING
          return Promise.resolve(
            kroInstance({
              state: 'PENDING',
              conditions: [{ type: 'Ready', status: 'False' }],
            })
          );
        }
        // Third call: ready
        return Promise.resolve(
          kroInstance({
            state: 'ACTIVE',
            conditions: [{ type: 'Ready', status: 'True' }],
          })
        );
      });

      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).resolves.toBeUndefined();

      expect(mockK8sApi.read).toHaveBeenCalledTimes(3);
    });

    it('keeps polling when status exists but has no conditions yet', async () => {
      let callCount = 0;

      mockK8sApi.read.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          // Status exists but no synced/ready condition
          return Promise.resolve(kroInstance({ state: 'PENDING' }));
        }
        // Ready on third call
        return Promise.resolve(
          kroInstance({
            state: 'ACTIVE',
            conditions: [{ type: 'Ready', status: 'True' }],
          })
        );
      });

      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).resolves.toBeUndefined();

      expect(mockK8sApi.read).toHaveBeenCalledTimes(3);
    });

    it('keeps polling when status is absent (uses DEFAULT_POLL_INTERVAL)', async () => {
      let callCount = 0;

      mockK8sApi.read.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // No status at all — triggers DEFAULT_POLL_INTERVAL (2000ms) wait
          return Promise.resolve(kroInstance());
        }
        // Ready on second call
        return Promise.resolve(
          kroInstance({
            state: 'ACTIVE',
            conditions: [{ type: 'Ready', status: 'True' }],
          })
        );
      });

      // Timeout must exceed DEFAULT_POLL_INTERVAL (2000ms) + pollInterval
      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 5000,
          })
        )
      ).resolves.toBeUndefined();

      expect(mockK8sApi.read).toHaveBeenCalledTimes(2);
    });

    it('waits for custom status fields when RGD expects them', async () => {
      mockCustomObjectsApi.getClusterCustomObject.mockResolvedValue({
        spec: { schema: { status: { ready: { type: 'boolean' } } } },
      });

      let callCount = 0;
      mockK8sApi.read.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          // ACTIVE + synced but no custom status fields yet
          return Promise.resolve(
            kroInstance({
              state: 'ACTIVE',
              conditions: [{ type: 'Ready', status: 'True' }],
            })
          );
        }
        // Now has the custom status field
        return Promise.resolve(
          kroInstance({
            state: 'ACTIVE',
            conditions: [{ type: 'Ready', status: 'True' }],
            ready: true,
          })
        );
      });

      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).resolves.toBeUndefined();

      expect(mockK8sApi.read).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Timeout error when instance never becomes ready
  // ---------------------------------------------------------------------------

  describe('timeout', () => {
    it('throws DeploymentTimeoutError when instance never becomes ready', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'PENDING',
          conditions: [{ type: 'Ready', status: 'False' }],
        })
      );

      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 500,
            pollInterval: 100,
          })
        )
      ).rejects.toThrow(DeploymentTimeoutError);
    });

    it('timeout error includes instance name and timeout info', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'PENDING',
          conditions: [{ type: 'Ready', status: 'False' }],
        })
      );

      try {
        await waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 500,
            pollInterval: 100,
          })
        );
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DeploymentTimeoutError);
        const timeoutError = error as DeploymentTimeoutError;
        expect(timeoutError.resourceName).toBe('test-instance');
        expect(timeoutError.resourceKind).toBe('WebApp');
        expect(timeoutError.timeoutMs).toBe(500);
        expect(timeoutError.operation).toBe('instance-readiness');
      }
    });

    it('timeout error includes factoryContext hint when provided', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'PENDING',
          conditions: [],
        })
      );

      try {
        await waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 300,
            pollInterval: 100,
            factoryContext: 'web-app-factory',
          })
        );
        expect(true).toBe(false);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DeploymentTimeoutError);
        expect((error as DeploymentTimeoutError).message).toContain('kubectl logs');
      }
    });

    it('timeout error does not include hint when factoryContext is not provided', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'PENDING',
          conditions: [],
        })
      );

      try {
        await waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 300,
            pollInterval: 100,
          })
        );
        expect(true).toBe(false);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DeploymentTimeoutError);
        expect((error as DeploymentTimeoutError).message).not.toContain('kubectl logs');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Handles 404 (instance not found) — keeps polling
  // ---------------------------------------------------------------------------

  describe('404 handling', () => {
    it('keeps polling when instance returns 404 then eventually resolves', async () => {
      let callCount = 0;

      mockK8sApi.read.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.reject(createK8sError('Not Found', 404));
        }
        return Promise.resolve(
          kroInstance({
            state: 'ACTIVE',
            conditions: [{ type: 'Ready', status: 'True' }],
          })
        );
      });

      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).resolves.toBeUndefined();

      expect(mockK8sApi.read).toHaveBeenCalledTimes(3);
    });

    it('times out if instance is never found (always 404)', async () => {
      mockK8sApi.read.mockRejectedValue(createK8sError('Not Found', 404));

      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 500,
            pollInterval: 100,
          })
        )
      ).rejects.toThrow(DeploymentTimeoutError);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Handles API errors gracefully
  // ---------------------------------------------------------------------------

  describe('API error handling', () => {
    it('throws non-404 API errors immediately', async () => {
      mockK8sApi.read.mockRejectedValue(createK8sError('Forbidden', 403));

      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).rejects.toThrow('Forbidden');
    });

    it('throws 500 server errors immediately', async () => {
      mockK8sApi.read.mockRejectedValue(createK8sError('Internal Server Error', 500));

      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).rejects.toThrow('Internal Server Error');
    });

    it('throws CRDInstanceError for FAILED state', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'FAILED',
          conditions: [
            { type: 'Ready', status: 'False', message: 'Deployment failed: image pull error' },
          ],
        })
      );

      try {
        await waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        );
        expect(true).toBe(false);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CRDInstanceError);
        const crdError = error as CRDInstanceError;
        expect(crdError.message).toContain('FAILED');
        expect(crdError.message).toContain('image pull error');
        expect(crdError.instanceName).toBe('test-instance');
        expect(crdError.operation).toBe('creation');
      }
    });

    it('throws CRDInstanceError for ERROR state (v0.8.x)', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ERROR',
          conditions: [
            { type: 'InstanceSynced', status: 'False', message: 'Resource reconciliation error' },
          ],
        })
      );

      try {
        await waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        );
        expect(true).toBe(false);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CRDInstanceError);
        const crdError = error as CRDInstanceError;
        expect(crdError.message).toContain('ERROR');
        expect(crdError.message).toContain('Resource reconciliation error');
      }
    });

    it('uses "Unknown error" when FAILED state has no condition message', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'FAILED',
          conditions: [],
        })
      );

      try {
        await waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        );
        expect(true).toBe(false);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CRDInstanceError);
        expect((error as CRDInstanceError).message).toContain('Unknown error');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. RGD fetch error handling
  // ---------------------------------------------------------------------------

  describe('RGD fetch error handling', () => {
    it('treats instance as ready (permissive) when RGD fetch fails and instance is ACTIVE + synced', async () => {
      mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(new Error('RGD not found'));

      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ACTIVE',
          conditions: [{ type: 'Ready', status: 'True' }],
        })
      );

      // Should resolve because when RGD can't be fetched, expectedCustomStatusFields = false,
      // so isReady = ACTIVE && synced && (hasCustom || !false) = ACTIVE && synced && true
      await expect(
        waitForKroInstanceReady(
          defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
        )
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Passes correct arguments to k8sApi.read
  // ---------------------------------------------------------------------------

  describe('API call arguments', () => {
    it('passes correct apiVersion, kind, name, and namespace to k8sApi.read', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ACTIVE',
          conditions: [{ type: 'Ready', status: 'True' }],
        })
      );

      await waitForKroInstanceReady(
        defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
      );

      expect(mockK8sApi.read).toHaveBeenCalledWith({
        apiVersion: 'example.com/v1alpha1',
        kind: 'WebApp',
        metadata: {
          name: 'test-instance',
          namespace: 'default',
        },
      });
    });

    it('passes correct parameters to customObjectsApi.getClusterCustomObject', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ACTIVE',
          conditions: [{ type: 'Ready', status: 'True' }],
        })
      );

      await waitForKroInstanceReady(
        defaultOptions({ k8sApi: mockK8sApi, customObjectsApi: mockCustomObjectsApi })
      );

      expect(mockCustomObjectsApi.getClusterCustomObject).toHaveBeenCalledWith({
        group: 'kro.run',
        version: 'v1alpha1',
        plural: 'resourcegraphdefinitions',
        name: 'web-app',
      });
    });
  });
});
