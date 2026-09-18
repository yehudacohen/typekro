/**
 * Kro Readiness Polling
 *
 * Shared readiness polling logic for Kro-managed custom resource instances.
 * Used by both KroResourceFactoryImpl and KroDeploymentStrategy.
 *
 * The polling checks:
 * - Kro state field (ACTIVE, FAILED, ERROR)
 * - Kro conditions (InstanceSynced for v0.3.x, Ready for v0.8.x)
 * - Custom status fields populated from the RGD status schema
 */

import type * as k8s from '@kubernetes/client-node';
import {
  DEFAULT_FAST_POLL_INTERVAL,
  DEFAULT_HTTP_READ_TIMEOUT,
  DEFAULT_POLL_INTERVAL,
} from '../config/defaults.js';
import { CRDInstanceError, DeploymentTimeoutError, ensureError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import type { RGDManifest } from '../types/kubernetes.js';
import { classifyApiReadError, describeApiReadFailure } from './k8s-helpers.js';
import { callWithTimeout, perCallTimeout } from './poll-timeout.js';

/** Options for Kro instance readiness polling. */
export interface KroReadinessOptions {
  /** The Kro custom resource instance name. */
  instanceName: string;

  /** Timeout in milliseconds. */
  timeout: number;

  /** A `KubernetesObjectApi` that can `.read()` namespaced resources. */
  k8sApi: k8s.KubernetesObjectApi;

  /** A `CustomObjectsApi` for fetching the RGD status schema. */
  customObjectsApi: k8s.CustomObjectsApi;

  /** The Kubernetes namespace where the instance lives. */
  namespace: string;

  /** The apiVersion of the custom resource (e.g. `'kro.run/v1alpha1'`). */
  apiVersion: string;

  /** The kind of the custom resource (e.g. `'WebApp'`). */
  kind: string;

  /**
   * The RGD name used to fetch the ResourceGraphDefinition for status schema
   * checking. Typically the kebab-case factory name.
   */
  rgdName: string;

  /**
   * Polling interval between readiness checks in milliseconds.
   * Defaults to {@link DEFAULT_FAST_POLL_INTERVAL}.
   */
  pollInterval?: number;

  /** Optional context for error messages (e.g. factory name). */
  factoryContext?: string;

  /** Signal for cancelling the readiness operation. */
  abortSignal?: AbortSignal;
}

function abortableDelay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  abortSignal?.throwIfAborted();
  if (!abortSignal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Sleep between polls WITHOUT overshooting the caller's deadline.
 *
 * A bare `abortableDelay(pollInterval)` can carry the wait up to a full poll interval PAST the
 * declared `timeout` — a 5s budget polled every 2s could return at 7s — because the `while`
 * condition is only re-checked after the sleep has already run to completion. Capping the sleep to
 * whatever is left of the budget keeps the declared timeout the real upper bound, so a caller that
 * sizes a deploy against it is not silently given more time than it asked for.
 *
 * @returns `false` when the budget is already spent, meaning the caller should stop polling.
 */
async function delayWithinBudget(
  ms: number,
  remaining: number,
  abortSignal?: AbortSignal
): Promise<boolean> {
  if (remaining <= 0) return false;
  await abortableDelay(Math.min(ms, remaining), abortSignal);
  return true;
}

/**
 * Wait for a Kro custom resource instance to become ready.
 *
 * Readiness is determined when:
 * 1. `state === 'ACTIVE'`
 * 2. Either `InstanceSynced` (v0.3.x) or `Ready` (v0.8.x) condition is `True`
 *    and has observed the current instance generation when KRO reports generations
 * 3. Either custom status fields are populated OR the RGD declares no status schema
 *
 * A TERMINAL instance state (`FAILED`/`ERROR`) is checked first, on the instance read alone, before
 * the RGD lookup below. Under the strict lookup policy a broken lookup retries to the deadline, and
 * an instance that has already failed carries the most actionable message this function can return —
 * it must not be buried behind retries and downgraded to a generic timeout.
 *
 * RGD STATUS-SCHEMA LOOKUP POLICY. Step 3 needs the ResourceGraphDefinition's declared status schema.
 * An UNCERTAIN read of that schema is never converted into an EMPTY schema: "we did not learn what
 * this instance's status should contain" must not become "this instance has no custom status", which
 * is what declares an ACTIVE/synced instance ready without validating any of its expected fields.
 * Failures are classified with the repo's shared {@link classifyApiReadError}:
 *
 * - `forbidden` (401/403) FAILS FAST. RBAC is the one cause waiting cannot fix, and every other
 *   401/403 in this codebase — including the instance read in this same loop — already fails fast.
 * - EVERY other classification — `timeout` (a wedged/expired exec credential, a half-open socket),
 *   `unreachable` (a premature close, a refused connection, DNS, TLS), `notFound`, and the
 *   deliberately conservative `other` bucket that catches 5xx and anything unrecognised — ABANDONS
 *   the iteration: neither ready nor permissive. The loop polls again, so the caller's overall
 *   `timeout` stays the single authority on how long to keep trying, and one transient blip is
 *   ridden out rather than failing the deploy. A lookup that never succeeds simply never satisfies
 *   step 3, and the wait ends in the overall {@link DeploymentTimeoutError}, whose message carries
 *   the last lookup failure so the diagnosis is not lost.
 *
 * `notFound` is strict for the same reason: the RGD name this poll looks up is the name the compiler
 * emitted (`convertToKubernetesName(composition.name)`, threaded through the deployment plan), so a
 * 404 means the RGD is missing or not yet created, not that the instance has no status schema.
 *
 * @throws {CRDInstanceError} if the instance enters a FAILED or ERROR state
 * @throws {DeploymentTimeoutError} if the timeout is exceeded
 */
export async function waitForKroInstanceReady(options: KroReadinessOptions): Promise<void> {
  const {
    instanceName,
    timeout,
    k8sApi,
    customObjectsApi,
    namespace,
    apiVersion,
    kind,
    rgdName,
    pollInterval = DEFAULT_FAST_POLL_INTERVAL,
    factoryContext,
    abortSignal,
  } = options;

  const logger = getComponentLogger('kro-readiness');
  const readinessLogger = logger.child({ instanceName, rgdName });
  const startTime = Date.now();
  /**
   * The last RGD status-schema lookup that timed out and was retried. Folded into the overall
   * timeout message: without it a persistently wedged lookup reports only "not ready in time" and
   * the actionable diagnosis (a wedged request / a premature close, and its cause) is lost.
   */
  let lastLookupError: Error | undefined;
  /** Lookup failure messages already logged, so a retry loop warns once per distinct message. */
  const warnedLookupFailures = new Set<string>();

  while (Date.now() - startTime < timeout) {
    abortSignal?.throwIfAborted();
    try {
      // Bound the read so a wedged/expired kubeconfig exec credential rejects (and is re-thrown below)
      // instead of hanging the poll forever — see poll-timeout.ts. A ≤0 budget means the deadline is
      // spent: break to the overall DeploymentTimeoutError below (NOT a per-call PollTimeoutError).
      const readTimeout = perCallTimeout(
        timeout - (Date.now() - startTime),
        DEFAULT_HTTP_READ_TIMEOUT
      );
      if (readTimeout <= 0) break;
      const response = await callWithTimeout(
        () =>
          k8sApi.read({
            apiVersion,
            kind,
            metadata: {
              name: instanceName,
              namespace,
            },
          }),
        readTimeout,
        `read ${kind}/${instanceName}`,
        abortSignal
      );

      // In the new API, methods return objects directly (no .body wrapper)
      const instance = response as k8s.KubernetesObject & {
        status?: {
          state?: string;
          phase?: string;
          ready?: boolean;
          message?: string;
          observedGeneration?: number;
          conditions?: Array<{
            type: string;
            status: string;
            reason?: string;
            message?: string;
            observedGeneration?: number;
          }>;
        };
      };

      // Kro-specific readiness logic
      const status = instance.status;
      if (!status) {
        readinessLogger.debug('No status found yet, continuing to wait', { instanceName });
        if (
          !(await delayWithinBudget(
            DEFAULT_POLL_INTERVAL,
            timeout - (Date.now() - startTime),
            abortSignal
          ))
        ) {
          break;
        }
        continue;
      }

      const state = status.state;
      const conditions = status.conditions || [];

      // TERMINAL STATE IS CHECKED FIRST, BEFORE ANY RGD LOOKUP.
      //
      // Kro v0.8.x uses "ERROR", v0.3.x uses "FAILED". Either way the instance is done: no amount of
      // further polling changes it, and the condition message is the single most actionable thing
      // this function can hand the caller. The check therefore runs on the instance read alone —
      // the RGD status-schema lookup below cannot make a failed instance succeed, and under the
      // strict lookup policy (every non-forbidden failure abandons the iteration and retries) a
      // lookup that is itself broken would otherwise bury this message behind retries until the
      // deadline, turning a precise CRDInstanceError into a generic DeploymentTimeoutError.
      if (state === 'FAILED' || state === 'ERROR') {
        const failedCondition = conditions.find((c) => c.status === 'False');
        const errorMessage = failedCondition?.message || 'Unknown error';
        throw new CRDInstanceError(
          `Kro instance deployment failed (state=${state}): ${errorMessage}`,
          apiVersion,
          kind,
          instanceName,
          'creation'
        );
      }

      // Support both Kro v0.3.x (InstanceSynced) and v0.8.x (Ready) conditions
      const syncedCondition = conditions.find((c) => c.type === 'InstanceSynced');
      const readyCondition = conditions.find((c) => c.type === 'Ready');
      const generation = instance.metadata?.generation;
      const conditionIsCurrent = (condition: (typeof conditions)[number] | undefined) =>
        condition?.status === 'True' &&
        (generation === undefined ||
          condition.observedGeneration === undefined ||
          condition.observedGeneration >= generation);

      // Check if status has fields beyond the basic Kro fields (conditions, state)
      const statusKeys = Object.keys(status);
      const basicKroFields = ['conditions', 'state'];
      const hasCustomStatusFields = statusKeys.some((key) => !basicKroFields.includes(key));

      const isActive = state === 'ACTIVE';
      const isSynced = conditionIsCurrent(syncedCondition) || conditionIsCurrent(readyCondition);

      // Check what status fields are expected by looking at the ResourceGraphDefinition
      let expectedCustomStatusFields = false;
      let expectedStatusKeys: string[] = [];
      try {
        const rgdReadTimeout = perCallTimeout(
          timeout - (Date.now() - startTime),
          DEFAULT_HTTP_READ_TIMEOUT
        );
        // Deadline spent mid-iteration: break to the overall DeploymentTimeoutError rather than starting
        // a doomed read (which would surface a misleading per-call PollTimeoutError).
        if (rgdReadTimeout <= 0) break;
        const rgdResponse = await callWithTimeout(
          () =>
            customObjectsApi.getClusterCustomObject({
              group: 'kro.run',
              version: 'v1alpha1',
              plural: 'resourcegraphdefinitions',
              name: rgdName,
            }),
          rgdReadTimeout,
          `read ResourceGraphDefinition/${rgdName}`,
          abortSignal
        );
        const rgd = rgdResponse as RGDManifest;
        const rgdStatusSchema = rgd.spec?.schema?.status ?? {};
        expectedStatusKeys = Object.keys(rgdStatusSchema).filter(
          (key) => !basicKroFields.includes(key)
        );
        expectedCustomStatusFields = expectedStatusKeys.length > 0;
        // The schema HAS now been read, so any earlier failure is spent history. Leaving it set
        // would misattribute a later timeout — one caused by the projected status never becoming
        // ready — to a lookup that has since been answered.
        lastLookupError = undefined;

        readinessLogger.debug('ResourceGraphDefinition status schema check', {
          rgdName,
          rgdStatusKeys: expectedStatusKeys,
          expectedCustomStatusFields,
        });
      } catch (error: unknown) {
        // An UNCERTAIN read must never be converted into an empty schema. The old code fell through
        // to `expectedCustomStatusFields = false` — "the RGD declares no custom status" — for every
        // failure alike, so any request that did not produce an answer let an ACTIVE/synced instance
        // be declared ready WITHOUT validating the status fields it was supposed to have. The
        // question is not which error class this is, it is whether the server actually ANSWERED.
        // `classifyApiReadError` is the repo's shared answer to that, and it already folds in the
        // socket-level cases this gate previously missed: `PrematureCloseError` carries `ECONNRESET`
        // → `unreachable`, and both `RequestTimeoutError` and `PollTimeoutError` → `timeout`.
        const failure = classifyApiReadError(error);

        // RBAC is the one failure that waiting cannot fix, and the repo fails fast on 401/403
        // everywhere else (including the instance read in this very loop). Spending the whole
        // readiness budget re-asking a question that will keep being refused only buries the cause.
        if (failure === 'forbidden') {
          throw error;
        }

        // Everything else — `timeout`, `unreachable`, `notFound`, and the deliberately conservative
        // `other` bucket that catches 5xx and anything unrecognised — means we did not learn the
        // schema. Abandon this iteration (neither ready nor permissive) and poll again, so the
        // caller's overall `timeout` stays the single authority on how long to keep trying. One
        // transient blip is what a poll loop exists to ride out; a persistent failure ends in the
        // overall DeploymentTimeoutError, carrying this message.
        lastLookupError = ensureError(error);
        if (!warnedLookupFailures.has(lastLookupError.message)) {
          warnedLookupFailures.add(lastLookupError.message);
          readinessLogger.warn(
            'ResourceGraphDefinition status-schema lookup did not produce an answer — retrying until the readiness deadline',
            {
              rgdName,
              failure,
              reason: describeApiReadFailure(failure),
              error: lastLookupError.message,
            }
          );
        }
        // Honour the poll interval before retrying: a premature close can reject in milliseconds,
        // so continuing straight to the top of the loop would spin.
        if (
          !(await delayWithinBudget(pollInterval, timeout - (Date.now() - startTime), abortSignal))
        ) {
          break;
        }
        continue;
      }

      readinessLogger.debug('Kro instance status check', {
        instanceName,
        state,
        isActive,
        isSynced,
        hasCustomStatusFields,
        expectedCustomStatusFields,
        expectedStatusKeys,
        statusKeys,
        generation,
        syncedObservedGeneration: syncedCondition?.observedGeneration,
        readyObservedGeneration: readyCondition?.observedGeneration,
      });

      // Resource is ready only after KRO reports the current instance as synced.
      // A user-defined `status.ready === true` can be stale across updates, so it
      // must not bypass Kro's InstanceSynced/Ready condition.
      const statusReadyField = status.ready;
      const hasReadyField = typeof statusReadyField === 'boolean';
      const hasExpectedCustomStatus =
        expectedStatusKeys.length === 0 ||
        expectedStatusKeys.every((key) => Object.hasOwn(status, key));
      // `observedGeneration` is the conventional contract for a projected
      // status snapshot. KRO can mark its owner condition current one reconcile
      // before all custom status expressions have been copied. When a graph
      // deliberately exposes this field, require it to catch up as well so
      // deploy() cannot return a mixed-generation status object.
      const projectedObservedGeneration = status.observedGeneration;
      const projectedStatusIsCurrent =
        projectedObservedGeneration === undefined ||
        generation === undefined ||
        projectedObservedGeneration >= generation;
      const isReady =
        isActive &&
        isSynced &&
        hasExpectedCustomStatus &&
        projectedStatusIsCurrent &&
        (!hasReadyField || statusReadyField === true);

      if (isReady) {
        // Re-check the deadline: an API call earlier in THIS iteration may have consumed the remaining
        // budget (e.g. a slow/bounded read), so an "isReady" reached past the deadline must still time
        // out rather than silently succeed late.
        if (Date.now() - startTime >= timeout) {
          break;
        }
        readinessLogger.info('Kro instance is ready', {
          instanceName,
          hasCustomStatusFields,
          expectedCustomStatusFields,
          expectedStatusKeys,
        });
        return;
      }

      readinessLogger.debug('Kro instance not ready yet, continuing to wait', {
        instanceName,
        state,
        isSynced,
        hasCustomStatusFields,
        expectedStatusKeys,
        projectedObservedGeneration,
        projectedStatusIsCurrent,
      });
    } catch (error: unknown) {
      // Re-throw CRDInstanceError as-is
      if (error instanceof CRDInstanceError) {
        throw error;
      }
      const k8sError = error as {
        statusCode?: number;
        code?: number | string;
        body?: { code?: number; reason?: string };
        message?: string;
      };
      const errorCode =
        k8sError.statusCode ??
        k8sError.body?.code ??
        (typeof k8sError.code === 'number' ? k8sError.code : undefined);
      const isNotFound =
        errorCode === 404 ||
        k8sError.body?.reason === 'NotFound' ||
        k8sError.message?.includes(' not found') === true ||
        k8sError.message?.includes('NotFound') === true;
      if (!isNotFound) {
        throw error;
      }
      // Instance not found yet, continue waiting
      readinessLogger.debug('Instance not found yet, continuing to wait', { instanceName });
    }

    // Wait before checking again
    if (!(await delayWithinBudget(pollInterval, timeout - (Date.now() - startTime), abortSignal))) {
      break;
    }
  }

  const elapsed = Date.now() - startTime;
  // A lookup that never succeeded is the most actionable thing known about this timeout — without it
  // the message reports only "not ready in time" and the wedged-request diagnosis is lost. It is
  // cleared as soon as a later lookup succeeds, so this only ever describes a lookup that was still
  // failing when the budget ran out.
  const lookupDiagnosis = lastLookupError
    ? ` The ResourceGraphDefinition status-schema lookup could not be read, so readiness could not be confirmed; its last failure was: ${lastLookupError.message}`
    : '';
  throw new DeploymentTimeoutError(
    `Timeout waiting for Kro instance ${instanceName} to be ready after ${elapsed}ms (timeout: ${timeout}ms).${factoryContext ? ` This usually means the Kro controller is not running or the RGD deployment failed. Check Kro controller logs: kubectl logs -n kro-system deployment/kro` : ''}${lookupDiagnosis}`,
    kind,
    instanceName,
    timeout,
    'instance-readiness'
  );
}
