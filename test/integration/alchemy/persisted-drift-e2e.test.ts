/**
 * E2E (live cluster): persisted Alchemy state must not turn an absent
 * Kubernetes object into a false no-op.
 *
 * The out-of-band ConfigMap deletion is deliberate failure injection. The
 * TypeKro provider must detect the missing live object during the next plan,
 * drive its ordinary convergent reconcile, then return to a real no-op.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import * as Test from 'alchemy/Test/Core';
import { Effect } from 'effect';
import { KroResource, kroProvider } from '../../../src/alchemy/index.js';
import { simple } from '../../../src/index.js';
import {
  createCoreV1ApiClient,
  createKubernetesObjectApiClient,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  isNotFoundError,
  waitForResourceAbsent,
} from '../shared-kubeconfig';

setDefaultTimeout(300_000);

const clusterAvailable = await isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Alchemy persisted-state live drift (e2e)', () => {
  it('recreates an externally deleted direct resource and then plans noop', async () => {
    const namespace = 'default';
    const name = `tk-alchemy-drift-${crypto.randomUUID().slice(0, 8)}`;
    const resource = simple.ConfigMap({
      name,
      namespace,
      data: {
        contract: 'persisted-state-must-match-live-state',
      },
    });
    const declaration = Effect.gen(function* () {
      return yield* KroResource('applicationContract', {
        resource,
        namespace,
        deploymentStrategy: 'direct',
        kubeConfigOptions: {
          loadFromDefault: true,
        },
      });
    });
    const options = { providers: kroProvider };
    const scratch = Test.scratchStack(options, `tk-alchemy-drift-${namespace}`);
    const run = <A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> =>
      Test.run(effect as never, options as never) as Promise<A>;
    const kubeConfig = getIntegrationTestKubeConfig();
    const coreApi = createCoreV1ApiClient(kubeConfig);

    try {
      await run(scratch.deploy(declaration));
      const first = await coreApi.readNamespacedConfigMap({ namespace, name });
      const firstUid = first.metadata?.uid;
      expect(firstUid).toBeString();
      if (!firstUid) {
        throw new Error(`ConfigMap ${namespace}/${name} did not receive a Kubernetes UID`);
      }

      // Simulate external loss while retaining Alchemy's successful state.
      await coreApi.deleteNamespacedConfigMap({ namespace, name });
      await waitForResourceAbsent(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { namespace, name },
        },
        kubeConfig
      );

      const driftPlan = await run(scratch.plan(declaration));
      expect(Object.values(driftPlan.resources)).toHaveLength(1);
      expect(Object.values(driftPlan.resources)[0]?.action).toBe('update');

      await run(scratch.deploy(declaration));
      const replacement = await coreApi.readNamespacedConfigMap({ namespace, name });
      expect(replacement.metadata?.uid).toBeString();
      expect(replacement.metadata?.uid).not.toBe(firstUid);

      const convergedPlan = await run(scratch.plan(declaration));
      expect(Object.values(convergedPlan.resources)).toHaveLength(1);
      expect(Object.values(convergedPlan.resources)[0]?.action).toBe('noop');
    } finally {
      await run(scratch.destroy());
    }

    await waitForResourceAbsent(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { namespace, name },
      },
      kubeConfig
    );
  });

  it('waits for a finalizer-held terminating identity before recreating it', async () => {
    const namespace = 'default';
    const name = `tk-alchemy-terminating-${crypto.randomUUID().slice(0, 8)}`;
    const testFinalizer = 'tests.typekro.dev/hold-termination';
    const resource = simple.ConfigMap({
      name,
      namespace,
      data: {
        contract: 'terminating-state-must-not-report-success',
      },
    });
    const declaration = Effect.gen(function* () {
      return yield* KroResource('terminatingContract', {
        resource,
        namespace,
        deploymentStrategy: 'direct',
        kubeConfigOptions: {
          loadFromDefault: true,
        },
      });
    });
    const options = { providers: kroProvider };
    const scratch = Test.scratchStack(options, `tk-alchemy-terminating-${name}`);
    const run = <A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> =>
      Test.run(effect as never, options as never) as Promise<A>;
    const kubeConfig = getIntegrationTestKubeConfig();
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const objectApi = createKubernetesObjectApiClient(kubeConfig);
    const identity = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { namespace, name },
    };
    const cleanup = async (): Promise<void> => {
      const cleanupErrors: unknown[] = [];
      try {
        const live = await objectApi.read(identity);
        if (live.metadata?.finalizers?.includes(testFinalizer)) {
          await objectApi.patch(
            {
              ...identity,
              metadata: {
                ...identity.metadata,
                finalizers: [],
              },
            },
            undefined,
            undefined,
            undefined,
            undefined,
            'application/merge-patch+json'
          );
        }
      } catch (error: unknown) {
        if (!isNotFoundError(error)) cleanupErrors.push(error);
      }
      try {
        await run(scratch.destroy());
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          `Failed to clean up finalizer-held drift test ${namespace}/${name}`
        );
      }
    };

    try {
      await run(scratch.deploy(declaration));
      const first = await coreApi.readNamespacedConfigMap({ namespace, name });
      const firstUid = first.metadata?.uid;
      expect(firstUid).toBeString();
      if (!firstUid) {
        throw new Error(`ConfigMap ${namespace}/${name} did not receive a Kubernetes UID`);
      }

      await objectApi.patch(
        {
          ...identity,
          metadata: {
            ...identity.metadata,
            finalizers: [testFinalizer],
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        'application/merge-patch+json'
      );
      await coreApi.deleteNamespacedConfigMap({ namespace, name });
      const terminating = await coreApi.readNamespacedConfigMap({ namespace, name });
      expect(terminating.metadata?.uid).toBe(firstUid);
      expect(terminating.metadata?.deletionTimestamp).toBeDefined();

      const driftPlan = await run(scratch.plan(declaration));
      expect(Object.values(driftPlan.resources)).toHaveLength(1);
      expect(Object.values(driftPlan.resources)[0]?.action).toBe('update');

      let deploymentSettled = false;
      const deployment = run(scratch.deploy(declaration)).finally(() => {
        deploymentSettled = true;
      });
      await Bun.sleep(1_000);
      expect(deploymentSettled).toBe(false);

      await objectApi.patch(
        {
          ...identity,
          metadata: {
            ...identity.metadata,
            finalizers: [],
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        'application/merge-patch+json'
      );
      await deployment;

      const replacement = await coreApi.readNamespacedConfigMap({ namespace, name });
      expect(replacement.metadata?.uid).toBeString();
      expect(replacement.metadata?.uid).not.toBe(firstUid);
      expect(replacement.metadata?.deletionTimestamp).toBeUndefined();

      const convergedPlan = await run(scratch.plan(declaration));
      expect(Object.values(convergedPlan.resources)).toHaveLength(1);
      expect(Object.values(convergedPlan.resources)[0]?.action).toBe('noop');
    } finally {
      await cleanup();
    }

    await waitForResourceAbsent(identity, kubeConfig);
  });
});
