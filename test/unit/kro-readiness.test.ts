/**
 * Unit tests for waitForKroInstanceReady
 *
 * Tests the polling-based readiness logic for Kro-managed custom resource instances.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import type { KroReadinessOptions } from '../../src/core/deployment/kro-readiness.js';
import { waitForKroInstanceReady } from '../../src/core/deployment/kro-readiness.js';
import { PollTimeoutError, RequestTimeoutError } from '../../src/core/deployment/poll-timeout.js';
import { CRDInstanceError, DeploymentTimeoutError } from '../../src/core/errors.js';
import { PrematureCloseError } from '../../src/core/kubernetes/bun-http-library.js';
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

/**
 * Build a Kro instance response with the given status fields, and optionally a
 * `metadata.generation` — the spec revision a condition's `observedGeneration` is measured against.
 */
function kroInstance(
  status?: {
    state?: string;
    conditions?: Array<{
      type: string;
      status: string;
      reason?: string;
      message?: string;
      observedGeneration?: number;
    }>;
    [key: string]: unknown;
  },
  metadata?: { generation?: number }
): k8s.KubernetesObject {
  return {
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    metadata: { name: 'test-instance', namespace: 'default', ...metadata },
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
  abortSignal?: AbortSignal;
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
    ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {}),
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

    it('does not trust custom status.ready when Kro Ready condition is stale false', async () => {
      mockCustomObjectsApi.getClusterCustomObject.mockResolvedValue({
        spec: {
          schema: { status: { ready: { type: 'boolean' }, supervisorReady: { type: 'boolean' } } },
        },
      });

      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ACTIVE',
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              reason: 'NotReady',
              message: 'resource reconciliation failed: cluster mutated',
            },
          ],
          ready: true,
          supervisorReady: true,
        })
      );

      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 1,
            pollInterval: 0,
          })
        )
      ).rejects.toThrow(DeploymentTimeoutError);
    });

    it('waits until the Ready condition observes the updated instance generation', async () => {
      let reads = 0;
      mockK8sApi.read.mockImplementation(() => {
        reads += 1;
        return Promise.resolve({
          ...kroInstance({
            state: 'ACTIVE',
            conditions: [
              {
                type: 'Ready',
                status: 'True',
                observedGeneration: reads === 1 ? 3 : 4,
              },
            ],
            endpoint: reads === 1 ? 'http://old.example' : 'http://new.example',
          }),
          metadata: { name: 'test-instance', namespace: 'default', generation: 4 },
        });
      });

      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            pollInterval: 0,
          })
        )
      ).resolves.toBeUndefined();
      expect(mockK8sApi.read).toHaveBeenCalledTimes(2);
    });

    it('waits for a declared projected observedGeneration after the owner condition is current', async () => {
      mockCustomObjectsApi.getClusterCustomObject.mockResolvedValue({
        spec: {
          schema: {
            status: {
              ready: { type: 'boolean' },
              observedGeneration: { type: 'integer' },
            },
          },
        },
      });
      let reads = 0;
      mockK8sApi.read.mockImplementation(() => {
        reads += 1;
        return Promise.resolve({
          ...kroInstance({
            state: 'ACTIVE',
            conditions: [{ type: 'Ready', status: 'True', observedGeneration: 8 }],
            ready: true,
            observedGeneration: reads === 1 ? 7 : 8,
          }),
          metadata: { name: 'test-instance', namespace: 'default', generation: 8 },
        });
      });

      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            pollInterval: 0,
          })
        )
      ).resolves.toBeUndefined();
      expect(mockK8sApi.read).toHaveBeenCalledTimes(2);
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

    it('keeps polling until all expected custom status fields are present', async () => {
      mockCustomObjectsApi.getClusterCustomObject.mockResolvedValue({
        spec: {
          schema: {
            status: {
              ready: { type: 'boolean' },
              components: { type: 'object' },
            },
          },
        },
      });

      let callCount = 0;
      mockK8sApi.read.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve(
            kroInstance({
              state: 'ACTIVE',
              conditions: [{ type: 'Ready', status: 'True' }],
              components: { database: true },
            })
          );
        }
        return Promise.resolve(
          kroInstance({
            state: 'ACTIVE',
            conditions: [{ type: 'Ready', status: 'True' }],
            ready: true,
            components: { database: true, app: true },
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

    it('an exhausted deadline throws the overall DeploymentTimeoutError, NOT a per-call PollTimeoutError', async () => {
      // Regression: a ≤0 per-call budget means the overall deadline elapsed — it must not be reported as
      // a credential-wedge PollTimeoutError. A 1ms timeout with a normal (fast, not-ready) read must
      // surface DeploymentTimeoutError.
      mockK8sApi.read.mockResolvedValue(
        kroInstance({ state: 'PENDING', conditions: [{ type: 'Ready', status: 'False' }] })
      );

      const err = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 1,
          pollInterval: 0,
        })
      ).catch((e) => e);
      expect(err).toBeInstanceOf(DeploymentTimeoutError);
      expect((err as Error).message).not.toMatch(/exec credential/);
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

    it('reports a FAILED instance immediately even while the RGD lookup keeps resetting', async () => {
      // Ordering regression. The RGD status-schema lookup used to run BEFORE the terminal-state
      // check, and under the strict lookup policy a retryable failure abandons the iteration and
      // retries. A broken lookup therefore hid an instance that had ALREADY failed, with a
      // perfectly good message, behind retries until the deadline — a precise CRDInstanceError
      // downgraded to a generic DeploymentTimeoutError. The failure is current-generation, so the
      // terminal state is authoritative and this measures the ORDERING alone.
      mockK8sApi.read.mockResolvedValue(
        kroInstance(
          {
            state: 'FAILED',
            conditions: [
              {
                type: 'Ready',
                status: 'False',
                message: 'Deployment failed: image pull error',
                observedGeneration: 3,
              },
            ],
          },
          { generation: 3 }
        )
      );
      mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      );

      const started = Date.now();
      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 5_000,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CRDInstanceError);
      // The instance's OWN message, not the transport noise from the lookup.
      expect((failure as Error).message).toContain('image pull error');
      expect((failure as Error).message).not.toContain('ECONNRESET');
      // Immediately: not after the 5s budget.
      expect(Date.now() - started).toBeLessThan(2_000);
      // And the lookup was never even attempted — the instance read alone settled it.
      expect(mockCustomObjectsApi.getClusterCustomObject.mock.calls.length).toBe(0);
    });

    it('reports an ERROR instance immediately even while the RGD lookup 404s', async () => {
      // Same ordering guarantee for the v0.8.x spelling, with the other retryable classification: a
      // 404 for the RGD object is retried to the deadline, and must not delay a terminal instance.
      // Current-generation failure evidence again, so only the ordering is under test.
      mockK8sApi.read.mockResolvedValue(
        kroInstance(
          {
            state: 'ERROR',
            conditions: [
              {
                type: 'InstanceSynced',
                status: 'False',
                message: 'Resource reconciliation error',
                observedGeneration: 3,
              },
            ],
          },
          { generation: 3 }
        )
      );
      mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(
        createK8sError('resourcegraphdefinitions.kro.run "web-app" not found', 404)
      );

      const started = Date.now();
      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 5_000,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CRDInstanceError);
      expect((failure as Error).message).toContain('Resource reconciliation error');
      expect((failure as Error).message).not.toContain('not found');
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(mockCustomObjectsApi.getClusterCustomObject.mock.calls.length).toBe(0);
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

    // -------------------------------------------------------------------------
    // A TERMINAL STATE IS ONLY AUTHORITATIVE WHEN IT IS CURRENT.
    //
    // Kubernetes keeps the status subresource across spec updates, so the first read after an
    // update can return the PREVIOUS deployment's verdict next to the NEW generation. KRO documents
    // `observedGeneration < metadata.generation` as "not yet processed", so failure evidence that
    // has not observed this generation is history, not a verdict on the deploy now in flight.
    // -------------------------------------------------------------------------

    it('does not report a FAILED state whose failure evidence belongs to an earlier generation', async () => {
      // generation=2 is being reconciled; state and conditions still describe generation 1. Throwing
      // here would fail an update that is about to succeed — and would do it on the very first poll,
      // so no timeout could ever rescue it.
      mockK8sApi.read
        .mockResolvedValueOnce(
          kroInstance(
            {
              state: 'FAILED',
              conditions: [
                {
                  type: 'Ready',
                  status: 'False',
                  message: 'previous deployment failed: image pull error',
                  observedGeneration: 1,
                },
              ],
            },
            { generation: 2 }
          )
        )
        .mockResolvedValue(
          kroInstance(
            {
              state: 'ACTIVE',
              conditions: [{ type: 'Ready', status: 'True', observedGeneration: 2 }],
            },
            { generation: 2 }
          )
        );

      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 2_000,
            pollInterval: 10,
          })
        )
      ).resolves.toBeUndefined();

      // Proof it really polled past the stale verdict rather than resolving on some other path.
      expect(mockK8sApi.read.mock.calls.length).toBeGreaterThan(1);
    });

    it('throws immediately when the FAILED state has observed the current generation', async () => {
      // The same shape as above with ONE field changed: the failure has seen generation 2. That is
      // a verdict on the deploy in flight, and it must not be softened into polling.
      mockK8sApi.read.mockResolvedValue(
        kroInstance(
          {
            state: 'FAILED',
            conditions: [
              {
                type: 'Ready',
                status: 'False',
                message: 'Deployment failed: image pull error',
                observedGeneration: 2,
              },
            ],
          },
          { generation: 2 }
        )
      );

      const started = Date.now();
      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 5_000,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CRDInstanceError);
      expect((failure as Error).message).toContain('FAILED');
      expect((failure as Error).message).toContain('image pull error');
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('throws immediately for an older KRO whose conditions carry no observedGeneration', async () => {
      // Backward compatibility. Conditions without `observedGeneration` cannot be shown to be stale,
      // so the generation-aware rule must not turn a real failure into a silent poll-to-timeout on
      // every cluster running a KRO that does not report generations.
      mockK8sApi.read.mockResolvedValue(
        kroInstance(
          {
            state: 'FAILED',
            conditions: [
              { type: 'Ready', status: 'False', message: 'Deployment failed: image pull error' },
            ],
          },
          { generation: 2 }
        )
      );

      const started = Date.now();
      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 5_000,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CRDInstanceError);
      expect((failure as Error).message).toContain('image pull error');
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('throws immediately for a FAILED state with no conditions at all, even when generations are reported', async () => {
      // No condition means no evidence either way, and "no evidence" must not read as "stale":
      // the instance still says FAILED and nothing suggests that verdict belongs to an older spec.
      mockK8sApi.read.mockResolvedValue(
        kroInstance({ state: 'FAILED', conditions: [] }, { generation: 2 })
      );

      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 2_000,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CRDInstanceError);
      expect((failure as Error).message).toContain('Unknown error');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. RGD fetch error handling
  // ---------------------------------------------------------------------------

  describe('RGD fetch error handling', () => {
    it('no longer treats an unclassifiable RGD fetch failure as an empty status schema', async () => {
      // This used to RESOLVE: ANY lookup failure set `expectedCustomStatusFields = false`, so an
      // ACTIVE + synced instance was declared ready without its status fields ever being checked.
      // An error with no Kubernetes shape at all is `not-a-kubernetes-error` — we did not learn the
      // answer, and re-asking cannot change that — so the wait fails with the error itself rather
      // than taking the permissive path or spending the whole budget on it.
      const unclassifiable = new Error('RGD lookup blew up');
      mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(unclassifiable);

      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ACTIVE',
          conditions: [{ type: 'Ready', status: 'True' }],
        })
      );

      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 200,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).toBe(unclassifiable);
      expect(failure).not.toBeInstanceOf(DeploymentTimeoutError);
    });

    it('does NOT swallow a WEDGED RGD read as readiness — fails fast instead of returning ready late', async () => {
      // Regression: a per-call timeout on the RGD read must not fall through to the permissive path,
      // which would declare an ACTIVE/synced instance ready WITHOUT validating expected status fields
      // (and after the deadline). A wedged RGD read (never settles) must surface as a timeout error.
      mockK8sApi.read.mockResolvedValue(
        kroInstance({
          state: 'ACTIVE',
          conditions: [{ type: 'Ready', status: 'True' }],
        })
      );
      // The RGD fetch never settles — models a wedged/expired kubeconfig exec credential.
      mockCustomObjectsApi.getClusterCustomObject.mockImplementation(
        () => new Promise(() => {}) as Promise<object>
      );

      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 200,
          })
        )
      ).rejects.toThrow(/did not return|request timeout/);
    });

    // A request can time out at EITHER timing layer. The HTTP library arms its socket timer
    // synchronously while the request is issued, so with comparable budgets it fires BEFORE the
    // `callWithTimeout` wrapper and raises a bare `RequestTimeoutError`; a mid-response disconnect
    // raises `PrematureCloseError`. An `instanceof PollTimeoutError` gate recognised neither, so both
    // fell through to the permissive branch and an ACTIVE/synced instance was declared ready without
    // its expected status fields ever being confirmed. Every timeout class must instead ABANDON the
    // iteration: not permissive, and not fatal either — the poll loop rides the blip out.
    const lookupTimeouts: [string, () => Error][] = [
      [
        'a bare RequestTimeoutError from the socket timer',
        () => new RequestTimeoutError('HTTP request timeout: GET /apis/kro.run/v1alpha1', 30_000),
      ],
      [
        'a PrematureCloseError from a mid-response disconnect',
        () =>
          new PrematureCloseError(
            'GET',
            '/apis/kro.run/v1alpha1/resourcegraphdefinitions/web-app',
            12,
            'the response body was truncated'
          ),
      ],
      [
        'a PollTimeoutError from the deadline wrapper',
        () => new PollTimeoutError('read ResourceGraphDefinition/web-app', 30_000),
      ],
    ];

    for (const [label, makeError] of lookupTimeouts) {
      it(`retries past ${label} without ever taking the permissive path`, async () => {
        // The instance is ACTIVE + synced but its custom status field is NOT yet populated, so the
        // permissive path is observable: taking it would resolve on the very first iteration. The
        // wait may only succeed once the schema has actually been read AND the field has appeared.
        mockCustomObjectsApi.getClusterCustomObject
          .mockRejectedValueOnce(makeError())
          .mockResolvedValue({ spec: { schema: { status: { url: 'string' } } } });
        mockK8sApi.read
          .mockResolvedValueOnce(
            kroInstance({ state: 'ACTIVE', conditions: [{ type: 'Ready', status: 'True' }] })
          )
          .mockResolvedValueOnce(
            // Schema readable now, but the expected field is still missing — must NOT be ready.
            kroInstance({ state: 'ACTIVE', conditions: [{ type: 'Ready', status: 'True' }] })
          )
          .mockResolvedValue(
            kroInstance({
              state: 'ACTIVE',
              conditions: [{ type: 'Ready', status: 'True' }],
              url: 'http://web-app',
            })
          );

        await expect(
          waitForKroInstanceReady(
            defaultOptions({
              k8sApi: mockK8sApi,
              customObjectsApi: mockCustomObjectsApi,
              timeout: 2_000,
              pollInterval: 10,
            })
          )
        ).resolves.toBeUndefined();

        // Proof the permissive branch was never taken: it would have resolved before the schema was
        // ever read a second time, and before the expected field existed.
        expect(mockCustomObjectsApi.getClusterCustomObject.mock.calls.length).toBeGreaterThan(1);
        expect(mockK8sApi.read.mock.calls.length).toBeGreaterThan(2);
      });
    }

    it('ends at the overall deadline, reporting the lookup failure, when the lookup keeps timing out', async () => {
      // A persistently wedged lookup must not be declared ready and must not throw on the first
      // blip: the caller's own `timeout` stays the single authority, and the diagnosis survives.
      mockK8sApi.read.mockResolvedValue(
        kroInstance({ state: 'ACTIVE', conditions: [{ type: 'Ready', status: 'True' }] })
      );
      mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(
        new PrematureCloseError(
          'GET',
          '/apis/kro.run/v1alpha1/resourcegraphdefinitions/web-app',
          12,
          'the response body was truncated'
        )
      );

      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 300,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DeploymentTimeoutError);
      expect((failure as Error).message).toContain('socket hang up');
      expect((failure as Error).message).toContain('status-schema lookup could not be read');
    });

    // An UNCERTAIN read must never become an EMPTY schema. Every classification below means the
    // server did not answer the question, so none of them may take the old permissive path.
    const strictLookupFailures: [string, () => Error][] = [
      [
        'timeout (socket timer)',
        () => new RequestTimeoutError('HTTP request timeout: GET /apis', 30_000),
      ],
      [
        'unreachable (premature close)',
        () =>
          new PrematureCloseError('GET', '/apis/kro.run/v1alpha1', 12, 'the body was truncated'),
      ],
      [
        'unreachable (connection refused)',
        () =>
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6443'), { code: 'ECONNREFUSED' }),
      ],
      [
        'unreachable (connection reset)',
        () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      ],
      [
        'unreachable (DNS failure)',
        () =>
          Object.assign(new Error('getaddrinfo ENOTFOUND kubernetes.default.svc'), {
            code: 'ENOTFOUND',
          }),
      ],
      [
        'notFound (404)',
        () => createK8sError('resourcegraphdefinitions.kro.run "web-app" not found', 404),
      ],
      ['other (500)', () => createK8sError('an internal server error occurred', 500)],
    ];

    for (const [label, makeError] of strictLookupFailures) {
      it(`never treats a ${label} lookup failure as an empty status schema`, async () => {
        // ACTIVE + synced, but the expected custom status field is absent. The permissive path is
        // therefore observable: taking it resolves immediately. Strict handling must instead run
        // out the (short) deadline.
        mockK8sApi.read.mockResolvedValue(
          kroInstance({ state: 'ACTIVE', conditions: [{ type: 'Ready', status: 'True' }] })
        );
        mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(makeError());

        const failure = await waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 200,
            pollInterval: 10,
          })
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DeploymentTimeoutError);
        expect((failure as Error).message).toContain('status-schema lookup could not be read');
      });
    }

    it('fails fast on a forbidden (403) lookup — RBAC is the one cause waiting cannot fix', async () => {
      // Every other 401/403 in the codebase fails fast, including the instance read in this same
      // loop. Burning the whole readiness budget re-asking a refused question buries the cause.
      mockK8sApi.read.mockResolvedValue(
        kroInstance({ state: 'ACTIVE', conditions: [{ type: 'Ready', status: 'True' }] })
      );
      const forbidden = createK8sError('resourcegraphdefinitions.kro.run is forbidden', 403);
      mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(forbidden);

      const started = Date.now();
      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 5_000,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).not.toBeInstanceOf(DeploymentTimeoutError);
      expect((failure as Error).message).toContain('forbidden');
      // Fast, not after the 5s budget.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(mockCustomObjectsApi.getClusterCustomObject.mock.calls.length).toBe(1);
    });

    // -------------------------------------------------------------------------
    // A DETERMINISTIC LOOKUP FAILURE IS NOT WORTH RETRYING.
    //
    // "We did not learn the schema" is a reason not to take the permissive path; it is not a reason
    // to keep asking. These errors read identically on every attempt, so polling them to the
    // deadline spends the whole budget and then reports a DeploymentTimeoutError that HIDES the
    // cause. Each must surface as ITSELF, on the first attempt. (Mutation check: revert the lookup
    // to "retry everything except forbidden" and every case here fails.)
    // -------------------------------------------------------------------------

    const deterministicLookupFailures: [string, () => Error][] = [
      ['permission-denied (401)', () => createK8sError('Unauthorized', 401)],
      ['invalid-request (400)', () => createK8sError('the request body is malformed', 400)],
      [
        'invalid-request (422)',
        () =>
          createK8sError('ResourceGraphDefinition in version "v1alpha1" cannot be handled', 422),
      ],
      [
        // A 404 that means the RGD API RESOURCE is not served at all — the CRD is not installed —
        // as opposed to a 404 for the RGD object, which stays retryable. This one also proves the
        // instance read's "404 means not created yet, keep waiting" handler does not swallow it.
        'unknown-resource-type (404 with no object named)',
        () =>
          Object.assign(new Error('the server could not find the requested resource'), {
            statusCode: 404,
            body: { code: 404, message: 'the server could not find the requested resource' },
          }),
      ],
      [
        // A programming bug — a client signature mismatch, a typo — has no Kubernetes shape at all.
        // It must reach the caller as the TypeError it is, not as a deadline.
        'not-a-kubernetes-error (TypeError)',
        () => new TypeError('customObjectsApi.getClusterCustomObject is not a function'),
      ],
    ];

    for (const [label, makeError] of deterministicLookupFailures) {
      it(`fails fast on a ${label} lookup, surfacing the real error`, async () => {
        mockK8sApi.read.mockResolvedValue(
          kroInstance({ state: 'ACTIVE', conditions: [{ type: 'Ready', status: 'True' }] })
        );
        const deterministic = makeError();
        mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(deterministic);

        const started = Date.now();
        const failure = await waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: 5_000,
            pollInterval: 10,
          })
        ).catch((error: unknown) => error);

        // The original error object, not a DeploymentTimeoutError wrapping nothing useful.
        expect(failure).toBe(deterministic);
        expect(failure).not.toBeInstanceOf(DeploymentTimeoutError);
        // On the first attempt, not after the 5s budget.
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(mockCustomObjectsApi.getClusterCustomObject.mock.calls.length).toBe(1);
      });
    }

    it('surfaces a TypeError from the lookup as that TypeError, never as a deadline', async () => {
      // Spelled out separately because this is the class the old "retry everything but forbidden"
      // policy hid most completely: a programming bug became a multi-minute wait and then a
      // timeout message about the Kro controller.
      mockK8sApi.read.mockResolvedValue(
        kroInstance({ state: 'ACTIVE', conditions: [{ type: 'Ready', status: 'True' }] })
      );
      mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(
        new TypeError('customObjectsApi.getClusterCustomObject is not a function')
      );

      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 5_000,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toContain('is not a function');
    });

    it('does not blame a recovered lookup for a timeout the projected status caused', async () => {
      // The remembered lookup failure exists to rescue a diagnosis that would otherwise be lost.
      // It must not SUPPLY a wrong one: once a later lookup answers, the schema is known, and a
      // deadline reached because the instance never populated that schema has nothing to do with
      // the transport blip that happened on the first poll.
      mockK8sApi.read.mockResolvedValue(
        kroInstance({ state: 'ACTIVE', conditions: [{ type: 'Ready', status: 'True' }] })
      );

      let lookups = 0;
      mockCustomObjectsApi.getClusterCustomObject.mockImplementation(() => {
        lookups += 1;
        if (lookups === 1) {
          return Promise.reject(
            new PrematureCloseError(
              'GET',
              '/apis/kro.run/v1alpha1/resourcegraphdefinitions/web-app',
              12,
              'the response body was truncated'
            )
          );
        }
        // Every later lookup answers: the RGD declares a `url` field the instance never gets.
        return Promise.resolve({ spec: { schema: { status: { url: 'string' } } } });
      });

      const failure = await waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 300,
          pollInterval: 10,
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DeploymentTimeoutError);
      // It really did keep looking the schema up after the first failure.
      expect(lookups).toBeGreaterThan(1);
      // ...and the stale first failure is not reported as the cause.
      expect((failure as Error).message).not.toContain('status-schema lookup could not be read');
      expect((failure as Error).message).not.toContain('socket hang up');
    });
  });

  // ---------------------------------------------------------------------------
  // 6b. The declared timeout is the real upper bound on the wait
  // ---------------------------------------------------------------------------

  describe('poll sleeps stay inside the declared budget', () => {
    // Each sleep between polls used to run to completion before the loop condition was re-checked,
    // so the wait could overshoot the declared `timeout` by up to a FULL poll interval. Every case
    // below gives the sleep an interval far larger than the whole budget, which turns the overshoot
    // from a few milliseconds into something a wall-clock assertion can see without being flaky.
    const BUDGET = 150;
    // Generous enough to absorb scheduler jitter on a loaded CI box, far below the interval each
    // test would sleep for if its sleep were still uncapped.
    const EPSILON = 400;

    it('caps the sleep taken when the instance has no status yet (DEFAULT_POLL_INTERVAL, 2s)', async () => {
      // This path ignores `pollInterval` and sleeps DEFAULT_POLL_INTERVAL, so an uncapped sleep
      // overshoots a 150ms budget by well over a second.
      mockK8sApi.read.mockResolvedValue(kroInstance());

      const started = Date.now();
      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: BUDGET,
            pollInterval: 10,
          })
        )
      ).rejects.toBeInstanceOf(DeploymentTimeoutError);
      expect(Date.now() - started).toBeLessThan(BUDGET + EPSILON);
    });

    it('caps the sleep taken after a failed RGD status-schema lookup', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({ state: 'ACTIVE', conditions: [{ type: 'Ready', status: 'True' }] })
      );
      mockCustomObjectsApi.getClusterCustomObject.mockRejectedValue(
        createK8sError('an internal server error occurred', 500)
      );

      const started = Date.now();
      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: BUDGET,
            pollInterval: 3_000,
          })
        )
      ).rejects.toBeInstanceOf(DeploymentTimeoutError);
      expect(Date.now() - started).toBeLessThan(BUDGET + EPSILON);
    });

    it('caps the sleep taken at the bottom of an ordinary not-ready iteration', async () => {
      mockK8sApi.read.mockResolvedValue(
        kroInstance({ state: 'IN_PROGRESS', conditions: [{ type: 'Ready', status: 'False' }] })
      );

      const started = Date.now();
      await expect(
        waitForKroInstanceReady(
          defaultOptions({
            k8sApi: mockK8sApi,
            customObjectsApi: mockCustomObjectsApi,
            timeout: BUDGET,
            pollInterval: 3_000,
          })
        )
      ).rejects.toBeInstanceOf(DeploymentTimeoutError);
      expect(Date.now() - started).toBeLessThan(BUDGET + EPSILON);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Passes correct arguments to k8sApi.read
  // ---------------------------------------------------------------------------

  describe('API call arguments', () => {
    it('interrupts a wedged instance read with the caller abort reason', async () => {
      const controller = new AbortController();
      const reason = new DOMException('stop readiness', 'AbortError');
      mockK8sApi.read.mockImplementation(() => new Promise(() => {}));

      const result = waitForKroInstanceReady(
        defaultOptions({
          k8sApi: mockK8sApi,
          customObjectsApi: mockCustomObjectsApi,
          timeout: 10_000,
          abortSignal: controller.signal,
        })
      ).catch((error: unknown) => error);
      controller.abort(reason);

      expect(await result).toBe(reason);
    });

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
