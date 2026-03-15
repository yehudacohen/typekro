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
import { DEFAULT_FAST_POLL_INTERVAL, DEFAULT_POLL_INTERVAL } from '../config/defaults.js';
import { CRDInstanceError, DeploymentTimeoutError, ensureError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import type { RGDManifest } from '../types/kubernetes.js';

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
}

/**
 * Wait for a Kro custom resource instance to become ready.
 *
 * Readiness is determined when:
 * 1. `state === 'ACTIVE'`
 * 2. Either `InstanceSynced` (v0.3.x) or `Ready` (v0.8.x) condition is `True`
 * 3. Either custom status fields are populated OR the RGD declares no status schema
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
  } = options;

  const logger = getComponentLogger('kro-readiness');
  const readinessLogger = logger.child({ instanceName, rgdName });
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const response = await k8sApi.read({
        apiVersion,
        kind,
        metadata: {
          name: instanceName,
          namespace,
        },
      });

      // In the new API, methods return objects directly (no .body wrapper)
      const instance = response as k8s.KubernetesObject & {
        status?: {
          state?: string;
          phase?: string;
          ready?: boolean;
          message?: string;
          conditions?: Array<{
            type: string;
            status: string;
            reason?: string;
            message?: string;
          }>;
        };
      };

      // Kro-specific readiness logic
      const status = instance.status;
      if (!status) {
        readinessLogger.debug('No status found yet, continuing to wait', { instanceName });
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL));
        continue;
      }

      const state = status.state;
      const conditions = status.conditions || [];
      // Support both Kro v0.3.x (InstanceSynced) and v0.8.x (Ready) conditions
      const syncedCondition = conditions.find((c) => c.type === 'InstanceSynced');
      const readyCondition = conditions.find((c) => c.type === 'Ready');

      // Check if status has fields beyond the basic Kro fields (conditions, state)
      const statusKeys = Object.keys(status);
      const basicKroFields = ['conditions', 'state'];
      const hasCustomStatusFields = statusKeys.some((key) => !basicKroFields.includes(key));

      const isActive = state === 'ACTIVE';
      const isSynced = syncedCondition?.status === 'True' || readyCondition?.status === 'True';

      // Check what status fields are expected by looking at the ResourceGraphDefinition
      let expectedCustomStatusFields = false;
      try {
        const rgdResponse = await customObjectsApi.getClusterCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          plural: 'resourcegraphdefinitions',
          name: rgdName,
        });
        const rgd = rgdResponse as RGDManifest;
        const rgdStatusSchema = rgd.spec?.schema?.status ?? {};
        const rgdStatusKeys = Object.keys(rgdStatusSchema);
        expectedCustomStatusFields = rgdStatusKeys.length > 0;

        readinessLogger.debug('ResourceGraphDefinition status schema check', {
          rgdName,
          rgdStatusKeys,
          expectedCustomStatusFields,
        });
      } catch (error: unknown) {
        readinessLogger.warn('Could not fetch ResourceGraphDefinition for status schema check', {
          rgdName,
          error: ensureError(error).message,
        });
        // If we can't fetch the RGD, be permissive: if instance is ACTIVE and synced, consider it ready
        expectedCustomStatusFields = false;
      }

      readinessLogger.debug('Kro instance status check', {
        instanceName,
        state,
        isActive,
        isSynced,
        hasCustomStatusFields,
        expectedCustomStatusFields,
        statusKeys,
      });

      // Resource is ready when it's active, synced, and either:
      // 1. Has the expected custom status fields populated, OR
      // 2. No custom status fields are expected (empty status schema in RGD)
      const isReady =
        isActive && isSynced && (hasCustomStatusFields || !expectedCustomStatusFields);

      if (isReady) {
        readinessLogger.info('Kro instance is ready', {
          instanceName,
          hasCustomStatusFields,
          expectedCustomStatusFields,
        });
        return;
      }

      // Check for failure states (Kro v0.8.x uses "ERROR", v0.3.x uses "FAILED")
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

      readinessLogger.debug('Kro instance not ready yet, continuing to wait', {
        instanceName,
        state,
        isSynced,
        hasCustomStatusFields,
      });
    } catch (error: unknown) {
      // Re-throw CRDInstanceError as-is
      if (error instanceof CRDInstanceError) {
        throw error;
      }
      const k8sError = error as { statusCode?: number };
      if (k8sError.statusCode !== 404) {
        throw error;
      }
      // Instance not found yet, continue waiting
      readinessLogger.debug('Instance not found yet, continuing to wait', { instanceName });
    }

    // Wait before checking again
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  const elapsed = Date.now() - startTime;
  throw new DeploymentTimeoutError(
    `Timeout waiting for Kro instance ${instanceName} to be ready after ${elapsed}ms (timeout: ${timeout}ms).${factoryContext ? ` This usually means the Kro controller is not running or the RGD deployment failed. Check Kro controller logs: kubectl logs -n kro-system deployment/kro` : ''}`,
    kind,
    instanceName,
    timeout,
    'instance-readiness'
  );
}
