/**
 * CRD Manager - Handles Custom Resource Definition detection, waiting, and Flux CRD patching
 *
 * Extracted from engine.ts to provide focused CRD lifecycle management.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  DEFAULT_CRD_READY_TIMEOUT,
  DEFAULT_DEPLOYMENT_TIMEOUT,
  DEFAULT_POLL_INTERVAL,
} from '../config/defaults.js';
import { DeploymentTimeoutError, ensureError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import type { DeploymentOptions } from '../types/deployment.js';
import type {
  CustomResourceDefinitionItem,
  CustomResourceDefinitionList,
  KubernetesCondition,
  KubernetesResource,
} from '../types.js';

/**
 * Built-in Kubernetes API groups that are NOT custom resources
 */
const BUILT_IN_API_GROUPS = [
  'v1', // Core API group
  'apps/v1',
  'extensions/v1beta1',
  'networking.k8s.io/v1',
  'policy/v1',
  'rbac.authorization.k8s.io/v1',
  'storage.k8s.io/v1',
  'apiextensions.k8s.io/v1', // CRDs themselves
  'admissionregistration.k8s.io/v1',
  'apiregistration.k8s.io/v1',
  'authentication.k8s.io/v1',
  'authorization.k8s.io/v1',
  'autoscaling/v1',
  'autoscaling/v2',
  'batch/v1',
  'certificates.k8s.io/v1',
  'coordination.k8s.io/v1',
  'discovery.k8s.io/v1',
  'events.k8s.io/v1',
  'flowcontrol.apiserver.k8s.io/v1beta3',
  'node.k8s.io/v1',
  'scheduling.k8s.io/v1',
];

export class CRDManager {
  private fluxCRDsPatchPromise: Promise<void> | null = null;
  private logger = getComponentLogger('crd-manager');

  constructor(
    private k8sApi: k8s.KubernetesObjectApi,
    private kubeClient: k8s.KubeConfig,
    private abortableDelay: (ms: number, signal?: AbortSignal) => Promise<void>,
    private withAbortSignal: <T>(operation: Promise<T>, signal?: AbortSignal) => Promise<T>
  ) {}

  /**
   * Check if a resource is a custom resource (not a built-in Kubernetes resource)
   */
  isCustomResource(resource: KubernetesResource): boolean {
    if (!resource.apiVersion || !resource.kind) {
      return false;
    }
    return !BUILT_IN_API_GROUPS.includes(resource.apiVersion);
  }

  /**
   * Get the CRD name for a custom resource
   */
  async getCRDNameForResource(resource: KubernetesResource): Promise<string | null> {
    if (!resource.apiVersion || !resource.kind) {
      return null;
    }

    if (!this.isCustomResource(resource)) {
      return null;
    }

    // Extract group from apiVersion (e.g., "example.com/v1" -> "example.com")
    const apiVersionParts = resource.apiVersion.split('/');
    const group = apiVersionParts.length > 1 ? apiVersionParts[0] : '';

    if (!group) {
      return null; // Core API resources don't have CRDs
    }

    try {
      const crds = await this.k8sApi.list('apiextensions.k8s.io/v1', 'CustomResourceDefinition');

      const crdList = crds as unknown as CustomResourceDefinitionList;
      const matchingCrd = crdList?.items?.find((crd: CustomResourceDefinitionItem) => {
        const crdSpec = crd.spec;
        return crdSpec?.group === group && crdSpec?.names?.kind === resource.kind;
      });

      if (matchingCrd) {
        return matchingCrd.metadata?.name ?? null;
      }
    } catch (error: unknown) {
      this.logger.warn('Failed to query CRDs, using heuristic for CRD name generation', {
        error: String(error),
      });
    }

    // Fallback: Convert Kind to plural lowercase (simple heuristic)
    const kind = resource.kind.toLowerCase();
    const plural = kind.endsWith('s') ? kind : `${kind}s`;
    return `${plural}.${group}`;
  }

  /**
   * Determine if auto-fix should run for Flux CRDs
   */
  shouldAutoFixFluxCRDs(resource: KubernetesResource, options: DeploymentOptions): boolean {
    if (!resource.apiVersion?.includes('toolkit.fluxcd.io')) {
      return false;
    }
    const autoFixEnabled = options.autoFix?.fluxCRDs !== false;
    return autoFixEnabled;
  }

  /**
   * Ensure Flux CRDs are patched for Kubernetes 1.33+ compatibility
   * Uses lazy import and instance-level caching to only patch once per engine instance
   */
  async ensureFluxCRDsPatched(
    options: DeploymentOptions,
    logger: ReturnType<typeof getComponentLogger>
  ): Promise<void> {
    if (this.fluxCRDsPatchPromise) {
      return this.fluxCRDsPatchPromise;
    }

    this.fluxCRDsPatchPromise = (async () => {
      const logLevel = options.autoFix?.logLevel || 'info';
      logger[logLevel]('Checking Flux CRDs for Kubernetes 1.33+ compatibility...');

      try {
        const { patchFluxCRDSchemas } = await import('../runtime-patches/crd-patcher.js');
        await patchFluxCRDSchemas(this.kubeClient);
        logger[logLevel]('Flux CRDs patched successfully');
      } catch (error: unknown) {
        this.fluxCRDsPatchPromise = null;
        logger.warn(
          'Failed to auto-patch Flux CRDs - deployment may fail if CRDs lack proper schema',
          {
            error: ensureError(error).message,
            suggestion: 'Ensure RBAC permissions to patch CRDs, or set autoFix.fluxCRDs: false',
          }
        );
      }
    })();

    return this.fluxCRDsPatchPromise;
  }

  /**
   * Wait for CRD establishment if the resource is a custom resource
   */
  async waitForCRDIfCustomResource(
    resource: KubernetesResource,
    options: DeploymentOptions,
    logger: ReturnType<typeof getComponentLogger>,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new DOMException('Operation aborted', 'AbortError');
    }

    if (!this.isCustomResource(resource)) {
      return;
    }

    const crdName = await this.getCRDNameForResource(resource);
    if (!crdName) {
      logger.warn('Could not determine CRD name for custom resource', {
        kind: resource.kind,
        apiVersion: resource.apiVersion,
      });
      return;
    }

    if (this.shouldAutoFixFluxCRDs(resource, options)) {
      await this.ensureFluxCRDsPatched(options, logger);
    }

    logger.debug('Custom resource detected, waiting for CRD establishment', {
      resourceKind: resource.kind,
      crdName,
    });

    await this.waitForCRDEstablishment(
      { metadata: { name: crdName } },
      options,
      logger,
      abortSignal
    );

    logger.debug('CRD established, proceeding with custom resource deployment', {
      resourceKind: resource.kind,
      crdName,
    });
  }

  /**
   * Public method to wait for CRD readiness by name
   */
  async waitForCRDReady(
    crdName: string,
    deploymentMode: string,
    timeout: number = DEFAULT_CRD_READY_TIMEOUT,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const logger = this.logger.child({ crdName, timeout });
    const options: DeploymentOptions = {
      mode: deploymentMode as 'direct' | 'kro' | 'alchemy' | 'auto',
      timeout,
    };

    await this.waitForCRDEstablishment(
      { metadata: { name: crdName } },
      options,
      logger,
      abortSignal
    );
  }

  /**
   * Wait for a CRD to be established in the cluster
   */
  async waitForCRDEstablishment(
    crd: { metadata?: { name?: string } },
    options: DeploymentOptions,
    logger: ReturnType<typeof getComponentLogger>,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const crdName = crd.metadata?.name;
    const timeout = options.timeout || DEFAULT_DEPLOYMENT_TIMEOUT;
    const startTime = Date.now();
    const pollInterval = DEFAULT_POLL_INTERVAL;

    logger.debug('Waiting for CRD to exist and be established', { crdName, timeout });

    while (Date.now() - startTime < timeout) {
      if (abortSignal?.aborted) {
        throw new DOMException('Operation aborted', 'AbortError');
      }

      try {
        const crdStatus = await this.withAbortSignal(
          this.k8sApi.read({
            apiVersion: 'apiextensions.k8s.io/v1',
            kind: 'CustomResourceDefinition',
            metadata: { name: crdName },
          } as { metadata: { name: string } }),
          abortSignal
        );

        const crdItem = crdStatus as unknown as CustomResourceDefinitionItem;
        const conditions = crdItem?.status?.conditions || [];
        const establishedCondition = conditions.find(
          (c: KubernetesCondition) => c.type === 'Established'
        );

        if (establishedCondition?.status === 'True') {
          logger.debug('CRD exists and is established', { crdName });
          return;
        }

        logger.debug('CRD exists but not yet established, waiting...', {
          crdName,
          establishedStatus: establishedCondition?.status || 'unknown',
        });
      } catch (error: unknown) {
        if (
          error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
          throw error;
        }

        logger.debug('CRD not found yet, waiting for it to be created...', {
          crdName,
          error: ensureError(error).message,
        });
      }

      try {
        await this.abortableDelay(pollInterval, abortSignal);
      } catch (error: unknown) {
        if (
          error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
          throw error;
        }
      }
    }

    throw new DeploymentTimeoutError(
      `Timeout waiting for CRD ${crdName} to be established after ${timeout}ms`,
      'CustomResourceDefinition',
      crdName || 'unknown',
      timeout,
      'crd-establishment'
    );
  }

  /**
   * Wait for a CRD to be created and established, discovered by (group, kind)
   * rather than a pre-computed name.
   *
   * This is the correct path for KRO RGDs because KRO's server-side
   * pluralization may not match any client-side heuristic. For example,
   * already-plural kind names don't get an extra "s" suffix — only
   * the CRD's `spec.names.plural` is authoritative.
   *
   * The method polls the full CRD list looking for one whose
   * `spec.group` and `spec.names.kind` match, then delegates to
   * {@link waitForCRDEstablishment} with the discovered name.
   *
   * @param kind - The resource kind (e.g., "WebAppWithProcessing")
   * @param group - The CRD group (e.g., "kro.run")
   * @param deploymentMode - The deployment mode for logging
   * @param timeout - Max milliseconds to wait for the CRD to exist AND be established
   * @param abortSignal - Optional abort signal for cancellation
   * @throws {DeploymentTimeoutError} if the CRD is never discovered or never becomes Established within the timeout
   */
  async waitForCRDByKindAndGroup(
    kind: string,
    group: string,
    deploymentMode: string,
    timeout: number = DEFAULT_CRD_READY_TIMEOUT,
    abortSignal?: AbortSignal
  ): Promise<{ crdName: string; plural: string }> {
    const logger = this.logger.child({ kind, group, timeout });
    const startTime = Date.now();
    const pollInterval = DEFAULT_POLL_INTERVAL;

    logger.debug('Discovering CRD by kind and group');

    // Phase 1: discover the CRD's actual name by listing CRDs and matching
    // on (group, kind). KRO creates the CRD asynchronously after the RGD
    // is accepted, so we poll.
    let crdName: string | undefined;
    let plural: string | undefined;
    while (Date.now() - startTime < timeout) {
      if (abortSignal?.aborted) {
        throw new DOMException('Operation aborted', 'AbortError');
      }

      try {
        const crds = await this.withAbortSignal(
          this.k8sApi.list('apiextensions.k8s.io/v1', 'CustomResourceDefinition'),
          abortSignal
        );
        const crdList = crds as unknown as CustomResourceDefinitionList;
        const match = crdList?.items?.find((crd: CustomResourceDefinitionItem) => {
          const spec = crd.spec;
          return spec?.group === group && spec?.names?.kind === kind;
        });
        if (match?.metadata?.name && match.spec?.names?.plural) {
          crdName = match.metadata.name;
          plural = match.spec.names.plural;
          logger.debug('CRD discovered', { crdName, plural });
          break;
        }
      } catch (error: unknown) {
        if (
          error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
          throw error;
        }
        logger.debug('CRD list failed, retrying...', {
          error: ensureError(error).message,
        });
      }

      try {
        await this.abortableDelay(pollInterval, abortSignal);
      } catch (error: unknown) {
        if (
          error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
          throw error;
        }
      }
    }

    if (!crdName || !plural) {
      throw new DeploymentTimeoutError(
        `Timeout discovering CRD for kind "${kind}" in group "${group}" after ${timeout}ms`,
        'CustomResourceDefinition',
        `${kind}.${group}`,
        timeout,
        'crd-discovery'
      );
    }

    // Phase 2: wait for the discovered CRD to become Established. Pass
    // along the remaining timeout budget so total wait is bounded.
    const remaining = Math.max(timeout - (Date.now() - startTime), pollInterval);
    await this.waitForCRDReady(crdName, deploymentMode, remaining, abortSignal);

    return { crdName, plural };
  }
}
