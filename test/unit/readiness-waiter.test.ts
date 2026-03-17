/**
 * Unit tests for the ReadinessWaiter class
 *
 * Tests readiness checking and polling behavior for deployed Kubernetes resources,
 * including factory-provided readiness evaluators, fallback to generic checker,
 * timeout handling, and abort signal support.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { DebugLogger } from '../../src/core/deployment/debug-logger.js';
import { ResourceReadinessChecker } from '../../src/core/deployment/readiness.js';
import type { ReadinessWaiterDeps } from '../../src/core/deployment/readiness-waiter.js';
import { ReadinessWaiter } from '../../src/core/deployment/readiness-waiter.js';
import { DeploymentTimeoutError, ResourceGraphFactoryError } from '../../src/core/errors.js';
import type { TypeKroLogger } from '../../src/core/logging/types.js';
import {
  clearResourceMetadata,
  setReadinessEvaluator,
} from '../../src/core/metadata/resource-metadata.js';
import type { DeployedResource } from '../../src/core/types/deployment.js';
import type { KubernetesResource, ResourceStatus } from '../../src/core/types/kubernetes.js';
import { createMockK8sApi } from '../utils/mock-factories.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a mock TypeKroLogger with all methods stubbed.
 */
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

/**
 * Create a properly-typed DeployedResource for testing ReadinessWaiter.
 *
 * Unlike createMockDeployedResource (which returns Record<string, unknown> for manifest),
 * this returns a manifest typed as KubernetesResource so it can be used as a WeakMap key
 * for setReadinessEvaluator and satisfies the DeployedResource interface.
 */
function makeDeployedResource(overrides: {
  id?: string;
  kind?: string;
  name?: string;
  namespace?: string;
  status?: 'deployed' | 'ready' | 'failed';
}): DeployedResource {
  const kind = overrides.kind ?? 'Deployment';
  const name = overrides.name ?? 'test-resource';
  const namespace = overrides.namespace ?? 'default';
  const manifest: KubernetesResource = {
    apiVersion: kind === 'Deployment' || kind === 'StatefulSet' ? 'apps/v1' : 'v1',
    kind,
    metadata: { name, namespace },
  };
  return {
    id: overrides.id ?? `${name}-id`,
    kind,
    name,
    namespace,
    manifest,
    status: overrides.status ?? 'deployed',
    deployedAt: new Date(),
  };
}

/**
 * Create ReadinessWaiterDeps with controllable delays for testing.
 */
function createMockDeps(overrides: Partial<ReadinessWaiterDeps> = {}): ReadinessWaiterDeps {
  return {
    abortableDelay: overrides.abortableDelay ?? mock(() => Promise.resolve()),
    withAbortSignal:
      overrides.withAbortSignal ??
      ((<T>(op: Promise<T>, _signal?: AbortSignal) =>
        op) as ReadinessWaiterDeps['withAbortSignal']),
    emitEvent: overrides.emitEvent ?? mock(() => {}),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('ReadinessWaiter', () => {
  let mockK8sApi: k8s.KubernetesObjectApi;
  let readyResources: Set<string>;
  let readinessChecker: ResourceReadinessChecker;
  let logger: TypeKroLogger;

  beforeEach(() => {
    mockK8sApi = createMockK8sApi();
    readyResources = new Set<string>();
    readinessChecker = new ResourceReadinessChecker(mockK8sApi);
    logger = createMockLogger();
  });

  // ===========================================================================
  // isDeployedResourceReady
  // ===========================================================================

  describe('isDeployedResourceReady', () => {
    it('returns true when readiness evaluator returns { ready: true }', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'my-deploy' });
      setReadinessEvaluator(deployed.manifest, () => ({ ready: true }));

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'my-deploy', namespace: 'default' },
        status: { readyReplicas: 1 },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const waiter = new ReadinessWaiter(mockK8sApi, readyResources, readinessChecker, logger);
      const result = await waiter.isDeployedResourceReady(deployed);
      expect(result).toBe(true);
    });

    it('returns false when readiness evaluator returns { ready: false }', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'not-ready' });
      setReadinessEvaluator(deployed.manifest, () => ({
        ready: false,
        reason: 'NotEnoughReplicas',
      }));

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'not-ready', namespace: 'default' },
        status: { readyReplicas: 0 },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const waiter = new ReadinessWaiter(mockK8sApi, readyResources, readinessChecker, logger);
      const result = await waiter.isDeployedResourceReady(deployed);
      expect(result).toBe(false);
    });

    it('handles evaluator returning boolean true at runtime', async () => {
      const deployed = makeDeployedResource({ kind: 'Service', name: 'my-svc' });
      // At runtime, evaluators may return a plain boolean even though the type says ResourceStatus.
      // The ReadinessWaiter handles this case explicitly with `typeof result === 'boolean'`.
      const booleanEvaluator = (() => true) as unknown as (resource: unknown) => ResourceStatus;
      setReadinessEvaluator(deployed.manifest, booleanEvaluator);

      const liveResource = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'my-svc', namespace: 'default' },
        spec: { type: 'ClusterIP' },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const waiter = new ReadinessWaiter(mockK8sApi, readyResources, readinessChecker, logger);
      const result = await waiter.isDeployedResourceReady(deployed);
      expect(result).toBe(true);
    });

    it('falls back to generic readiness checker when no evaluator is found', async () => {
      const deployed = makeDeployedResource({ kind: 'ConfigMap', name: 'my-cm' });
      clearResourceMetadata(deployed.manifest);

      const liveResource = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'my-cm', namespace: 'default' },
        data: { key: 'value' },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const waiter = new ReadinessWaiter(mockK8sApi, readyResources, readinessChecker, logger);
      const result = await waiter.isDeployedResourceReady(deployed);
      // Should be a boolean regardless (generic checker returns true/false)
      expect(typeof result).toBe('boolean');
    });

    it('returns false when API read throws an error', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'error-deploy' });
      setReadinessEvaluator(deployed.manifest, () => ({ ready: true }));

      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.reject(new Error('Connection refused'))
      );

      const waiter = new ReadinessWaiter(mockK8sApi, readyResources, readinessChecker, logger);
      const result = await waiter.isDeployedResourceReady(deployed);
      expect(result).toBe(false);
    });

    it('handles evaluator returning unexpected result by treating as not ready', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'weird-result' });
      // Return something that is neither boolean nor { ready: boolean }
      const badEvaluator = (() => 'unexpected-string') as unknown as (
        resource: unknown
      ) => ResourceStatus;
      setReadinessEvaluator(deployed.manifest, badEvaluator);

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'weird-result', namespace: 'default' },
        status: {},
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const waiter = new ReadinessWaiter(mockK8sApi, readyResources, readinessChecker, logger);
      const result = await waiter.isDeployedResourceReady(deployed);
      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // waitForResourceReady
  // ===========================================================================

  describe('waitForResourceReady', () => {
    const defaultOptions = { mode: 'direct' as const, timeout: 500 };

    it('resolves immediately when resource status is already "ready"', async () => {
      const deployed = makeDeployedResource({
        kind: 'Deployment',
        name: 'already-ready',
        status: 'ready',
      });

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      await waiter.waitForResourceReady(deployed, defaultOptions);
      expect(mockK8sApi.read).not.toHaveBeenCalled();
    });

    it('resolves immediately when resource is in readyResources set', async () => {
      const deployed = makeDeployedResource({ kind: 'Service', name: 'known-ready' });
      readyResources.add('Service/known-ready/default');

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      await waiter.waitForResourceReady(deployed, defaultOptions);
      expect(mockK8sApi.read).not.toHaveBeenCalled();
    });

    it('throws ResourceGraphFactoryError when no readiness evaluator is found', async () => {
      const deployed = makeDeployedResource({ kind: 'ConfigMap', name: 'no-eval' });
      clearResourceMetadata(deployed.manifest);

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      await expect(waiter.waitForResourceReady(deployed, defaultOptions)).rejects.toBeInstanceOf(
        ResourceGraphFactoryError
      );
    });

    it('polls and resolves when evaluator returns boolean true at runtime', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'poll-deploy' });

      let callCount = 0;
      const pollingEvaluator = (() => {
        callCount++;
        // Ready on the 3rd evaluation
        return callCount >= 3;
      }) as unknown as (resource: unknown) => ResourceStatus;
      setReadinessEvaluator(deployed.manifest, pollingEvaluator);

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'poll-deploy', namespace: 'default' },
        status: { readyReplicas: 1 },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      await waiter.waitForResourceReady(deployed, { ...defaultOptions, timeout: 10_000 });
      expect(callCount).toBeGreaterThanOrEqual(3);
      expect(readyResources.has('Deployment/poll-deploy/default')).toBe(true);
    });

    it('polls and resolves when evaluator returns object with ready: true', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'obj-ready' });

      let callCount = 0;
      setReadinessEvaluator(deployed.manifest, () => {
        callCount++;
        if (callCount >= 2) {
          return { ready: true, message: 'All replicas available' };
        }
        return { ready: false, message: 'Waiting for replicas' };
      });

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'obj-ready', namespace: 'default' },
        status: {},
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      await waiter.waitForResourceReady(deployed, { ...defaultOptions, timeout: 10_000 });
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(readyResources.has('Deployment/obj-ready/default')).toBe(true);
    });

    it('throws DeploymentTimeoutError when timeout expires', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'timeout-deploy' });
      setReadinessEvaluator(deployed.manifest, () => ({ ready: false, reason: 'NotReady' }));

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'timeout-deploy', namespace: 'default' },
        status: { readyReplicas: 0 },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      // Use a 1ms timeout so the while loop exits on the very first Date.now() check
      await expect(
        waiter.waitForResourceReady(deployed, { mode: 'direct', timeout: 1 })
      ).rejects.toBeInstanceOf(DeploymentTimeoutError);
    });

    it('emits resource-ready event when resource becomes ready', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'event-deploy' });
      setReadinessEvaluator(deployed.manifest, () => ({ ready: true }));

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'event-deploy', namespace: 'default' },
        status: { readyReplicas: 1 },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const emitEvent = mock(() => {});
      const deps = createMockDeps({ emitEvent });
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      await waiter.waitForResourceReady(deployed, { ...defaultOptions, timeout: 5000 });

      // Check that at least one resource-ready event was emitted
      const calls = emitEvent.mock.calls;
      const readyEvents = calls.filter(
        (c: unknown[]) =>
          c[1] &&
          typeof c[1] === 'object' &&
          (c[1] as Record<string, unknown>).type === 'resource-ready'
      );
      expect(readyEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('throws AbortError when signal is already aborted', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'abort-pre' });
      setReadinessEvaluator(deployed.manifest, () => ({ ready: true }));

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      const abortController = new AbortController();
      abortController.abort();

      await expect(
        waiter.waitForResourceReady(deployed, defaultOptions, abortController.signal)
      ).rejects.toThrow('aborted');
    });

    it('continues polling when API read fails during wait loop', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'api-fail-deploy' });

      let callCount = 0;
      const pollingEvaluator = (() => {
        callCount++;
        return callCount >= 3;
      }) as unknown as (resource: unknown) => ResourceStatus;
      setReadinessEvaluator(deployed.manifest, pollingEvaluator);

      let readCount = 0;
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() => {
        readCount++;
        if (readCount === 1) {
          return Promise.reject(new Error('Transient network error'));
        }
        return Promise.resolve({
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'api-fail-deploy', namespace: 'default' },
          status: { readyReplicas: 1 },
        });
      });

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      await waiter.waitForResourceReady(deployed, { ...defaultOptions, timeout: 10_000 });
      expect(readCount).toBeGreaterThan(1);
      expect(readyResources.has('Deployment/api-fail-deploy/default')).toBe(true);
    });

    it('includes resource name in timeout error', async () => {
      const deployed = makeDeployedResource({ kind: 'StatefulSet', name: 'status-msg' });
      setReadinessEvaluator(deployed.manifest, () => ({
        ready: false,
        message: 'Waiting for 2/3 replicas',
      }));

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata: { name: 'status-msg', namespace: 'default' },
        status: { readyReplicas: 1 },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      try {
        await waiter.waitForResourceReady(deployed, { mode: 'direct', timeout: 1 });
        // Should not reach here
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeploymentTimeoutError);
        const timeoutErr = err as DeploymentTimeoutError;
        expect(timeoutErr.message).toContain('status-msg');
        expect(timeoutErr.resourceKind).toBe('StatefulSet');
        expect(timeoutErr.resourceName).toBe('status-msg');
      }
    });

    it('adds resource key to readyResources set on success', async () => {
      const deployed = makeDeployedResource({
        kind: 'Deployment',
        name: 'track-ready',
        namespace: 'prod',
      });
      setReadinessEvaluator(deployed.manifest, () => ({
        ready: true,
        message: 'All pods available',
      }));

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'track-ready', namespace: 'prod' },
        status: { readyReplicas: 3 },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const deps = createMockDeps();
      const waiter = new ReadinessWaiter(
        mockK8sApi,
        readyResources,
        readinessChecker,
        logger,
        undefined,
        deps
      );

      await waiter.waitForResourceReady(deployed, { ...defaultOptions, timeout: 5000 });
      expect(readyResources.has('Deployment/track-ready/prod')).toBe(true);
    });

    it('uses DEFAULT_DEPLOYMENT_TIMEOUT when options.timeout is not specified', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'default-timeout' });
      setReadinessEvaluator(deployed.manifest, () => ({ ready: false }));

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'default-timeout', namespace: 'default' },
        status: {},
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      // Override Date.now to simulate immediate timeout after the first iteration
      const realDateNow = Date.now;
      let callIndex = 0;
      const startTime = realDateNow();
      Date.now = () => {
        callIndex++;
        // First call: return start time; subsequent calls: jump past DEFAULT_DEPLOYMENT_TIMEOUT
        if (callIndex <= 1) return startTime;
        return startTime + 300_001; // DEFAULT_DEPLOYMENT_TIMEOUT is 300_000
      };

      try {
        const deps = createMockDeps();
        const waiter = new ReadinessWaiter(
          mockK8sApi,
          readyResources,
          readinessChecker,
          logger,
          undefined,
          deps
        );

        await expect(
          waiter.waitForResourceReady(deployed, { mode: 'direct' })
        ).rejects.toBeInstanceOf(DeploymentTimeoutError);
      } finally {
        Date.now = realDateNow;
      }
    });
  });

  // ===========================================================================
  // setDebugLogger
  // ===========================================================================

  describe('setDebugLogger', () => {
    it('sets debug logger and uses it during readiness evaluation', async () => {
      const deployed = makeDeployedResource({ kind: 'Deployment', name: 'debug-deploy' });
      setReadinessEvaluator(deployed.manifest, () => ({ ready: true }));

      const liveResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'debug-deploy', namespace: 'default' },
        status: { readyReplicas: 1 },
      };
      (mockK8sApi.read as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(liveResource)
      );

      const debugLogger = new DebugLogger({ enabled: true, readinessEvaluation: true });
      // Spy on the logReadinessEvaluation method
      const logSpy = mock(() => {});
      debugLogger.logReadinessEvaluation = logSpy;

      const waiter = new ReadinessWaiter(mockK8sApi, readyResources, readinessChecker, logger);
      waiter.setDebugLogger(debugLogger);

      await waiter.isDeployedResourceReady(deployed);
      expect(logSpy).toHaveBeenCalled();
    });
  });
});
