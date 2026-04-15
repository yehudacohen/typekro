/**
 * Direct Deployment Strategy
 *
 * This module provides the direct deployment strategy that deploys
 * individual Kubernetes resources directly to the cluster.
 */

import { isCelExpression, isKubernetesRef, containsKubernetesRefs, containsCelExpressions } from '../../../utils/type-guards.js';
import { RESOURCE_ID_ANNOTATION } from '../resource-tagging.js';
import { getMetadataField, getResourceId } from '../../metadata/index.js';
import type {
  DeployedResource,
  DeploymentContext,
  DeploymentResourceGraph,
  DeploymentResult,
  FactoryOptions,
} from '../../types/deployment.js';
import type { Enhanced } from '../../types/index.js';
import type { KubernetesResource } from '../../types/kubernetes.js';
import type {
  KroCompatibleType,
  SchemaDefinition,
  StatusBuilder,
} from '../../types/serialization.js';
import type { DirectDeploymentEngine } from '../engine.js';
import { ResourceDeploymentError } from '../errors.js';
import { createDeploymentOptions, handleDeploymentError } from '../shared-utilities.js';
import { BaseDeploymentStrategy } from './base-strategy.js';

/**
 * Direct deployment strategy - deploys individual Kubernetes resources
 */
export class DirectDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> extends BaseDeploymentStrategy<TSpec, TStatus> {
  constructor(
    factoryName: string,
    namespace: string,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    statusBuilder: StatusBuilder<TSpec, TStatus, any> | undefined,
    resourceKeys: Record<string, KubernetesResource> | undefined,
    factoryOptions: FactoryOptions,
    private deploymentEngine: DirectDeploymentEngine,
    public resourceResolver: {
      createResourceGraphForInstance(spec: TSpec): DeploymentResourceGraph;
      getReExecutedStatus?(): TStatus | null;
      reExecuteWithLiveStatus?(spec: TSpec, liveStatusMap: Map<string, Record<string, unknown>>): TStatus | null;
    } // Resource resolution logic
  ) {
    super(factoryName, namespace, schemaDefinition, statusBuilder, resourceKeys, factoryOptions);
  }

  protected async executeDeployment(
    spec: TSpec,
    instanceName: string,
    opts?: import('./base-strategy.js').DeployStrategyOptions
  ): Promise<DeploymentResult> {
    try {
      // Create resource graph for this instance
      const resourceGraph = this.resourceResolver.createResourceGraphForInstance(spec);

      // Create deployment options. Tag the options with factoryName +
      // instanceName so the engine stamps every resource with ownership
      // labels — this enables cross-process cleanup via
      // `factory.deleteInstance` from a later bun process.
      const deploymentOptions = {
        ...createDeploymentOptions(this.factoryOptions, this.namespace, 'direct'),
        factoryName: this.factoryName,
        instanceName,
        ...(opts?.targetScopes !== undefined && { targetScopes: opts.targetScopes }),
      };

      // Pass closures to deployment engine for level-based execution
      const closures = this.factoryOptions.closures || {};

      // Deploy using the direct deployment engine with closures if available, otherwise use regular deploy
      let deploymentResult: DeploymentResult;
      if (Object.keys(closures).length > 0 && 'deployWithClosures' in this.deploymentEngine) {
        // Type assertion is safe here because we've checked that the method exists
        const engineWithClosures = this.deploymentEngine as DirectDeploymentEngine & {
          deployWithClosures<TSpec>(
            graph: DeploymentResourceGraph,
            closures: Record<string, unknown>,
            options: Parameters<DirectDeploymentEngine['deploy']>[1],
            spec: TSpec,
            alchemyScope?: unknown
          ): Promise<DeploymentResult>;
        };
        deploymentResult = await engineWithClosures.deployWithClosures(
          resourceGraph,
          closures,
          deploymentOptions,
          spec,
          this.factoryOptions.alchemyScope
        );
      } else {
        // Fallback to regular deployment for backward compatibility
        deploymentResult = await this.deploymentEngine.deploy(resourceGraph, deploymentOptions);
      }

      if (deploymentResult.status === 'failed') {
        const firstError = deploymentResult.errors[0]?.error;
        const deploymentError = new ResourceDeploymentError(
          'resource-graph',
          'ResourceGraph',
          firstError || new Error('Unknown deployment error')
        );
        // Add additional context from all errors
        if (deploymentResult.errors.length > 1) {
          deploymentError.message += ` (and ${deploymentResult.errors.length - 1} other errors)`;
        }
        throw deploymentError;
      }

      return deploymentResult;
    } catch (error: unknown) {
      handleDeploymentError(error, 'Direct deployment failed');
    }
  }

  /**
   * Override Enhanced proxy creation to use re-executed status when available
   */
  protected async createEnhancedProxy(
    spec: TSpec,
    instanceName: string,
    deploymentResult: DeploymentResult
  ): Promise<Enhanced<TSpec, TStatus>> {
    // Get the base proxy first
    const baseProxy = await super.createEnhancedProxy(spec, instanceName, deploymentResult);

    // Try live status re-execution: re-run the composition function with real
    // status data from the cluster injected into the proxy system. This makes
    // status comparisons like `database.status.readyInstances >= 1` evaluate
    // correctly instead of returning proxy artifacts.
    if (
      deploymentResult.status === 'success' &&
      this.resourceResolver.reExecuteWithLiveStatus
    ) {
      const liveStatusMap = await this.buildLiveStatusMap(deploymentResult);

      if (liveStatusMap.size > 0) {
        const liveStatus = this.resourceResolver.reExecuteWithLiveStatus(spec, liveStatusMap);

        if (liveStatus) {
          this.logger.debug('Using live-status re-execution for status hydration', {
            instanceName,
            liveResourceCount: liveStatusMap.size,
            statusFields: Object.keys(liveStatus),
          });

          // Deep merge: recursively walk the status tree, replacing proxy artifacts
          // (KubernetesRef, CelExpression) with base values while keeping resolved values.
          const mergedStatus = normalizeReadyFromComponents(
            deepMergeLiveStatus(liveStatus, baseProxy.status ?? {})
          );

          return {
            ...baseProxy,
            status: mergedStatus as TStatus,
          } as Enhanced<TSpec, TStatus>;
        }
      }
    }

    // Fallback: use pre-deployment re-executed status.
    // This works correctly for spec-derived values (e.g., `spec.replicas > 0`)
    // but may have proxy artifacts for status-derived fields.
    const reExecutedStatus = this.resourceResolver.getReExecutedStatus?.();
    if (reExecutedStatus) {
      this.logger.debug('Falling back to pre-deployment re-executed status', { instanceName });

      if (baseProxy.status == null) {
        return {
          ...baseProxy,
          status: reExecutedStatus as TStatus,
        } as Enhanced<TSpec, TStatus>;
      }

      // Merge: use re-executed values unless they're CEL expressions or proxy artifacts
      const hybridStatus: Record<string, unknown> = { ...baseProxy.status };
      for (const [key, value] of Object.entries(reExecutedStatus)) {
        if (isCelExpression(value)) {
          hybridStatus[key] = (baseProxy.status as Record<string, unknown>)[key];
        } else if (isKubernetesRef(value) || containsKubernetesRefs(value)) {
          hybridStatus[key] = (baseProxy.status as Record<string, unknown>)[key];
        } else {
          hybridStatus[key] = value;
        }
      }
      return {
        ...baseProxy,
        status: hybridStatus as TStatus,
      } as Enhanced<TSpec, TStatus>;
    }

    return baseProxy;
  }

  /**
   * Build a map of resource ID → live status by querying the cluster.
   */
  private async buildLiveStatusMap(
    deploymentResult: DeploymentResult
  ): Promise<Map<string, Record<string, unknown>>> {
    const liveStatusMap = new Map<string, Record<string, unknown>>();
    const k8sApi = this.deploymentEngine.getKubernetesApi();

    const readyResources = deploymentResult.resources.filter(
      r => r.status === 'ready' || r.status === 'deployed'
    );

    const results = await Promise.allSettled(
      readyResources.map(async (resource) => {
        const isClusterScoped = getMetadataField(resource.manifest, 'scope') === 'cluster';
        const liveResource = await k8sApi.read({
          apiVersion: resource.manifest.apiVersion || '',
          kind: resource.kind,
          metadata: {
            name: resource.name,
            ...(isClusterScoped ? {} : { namespace: resource.namespace }),
          },
        });

        const status = (liveResource as Record<string, unknown>).status;
        if (status && typeof status === 'object') {
          const annotationId =
            (resource.manifest.metadata as { annotations?: Record<string, string> } | undefined)
              ?.annotations?.[RESOURCE_ID_ANNOTATION];
          const originalId = annotationId || getResourceId(resource.manifest) || resource.id;
          return { originalId, deployedId: resource.id, kind: resource.kind, status: status as Record<string, unknown> };
        }
        return null;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const { originalId, deployedId, kind, status } = result.value;
        liveStatusMap.set(originalId, status);
        this.logger.debug('Captured live status for resource', {
          originalId, deployedId, kind, statusKeys: Object.keys(status),
        });
      }
    }

    // Nested composition status synthesis is handled by reExecuteWithLiveStatus —
    // during re-execution, synthesizeNestedCompositionStatus creates entries
    // for virtual parent IDs (e.g., "inngestBootstrap1") from child readiness.

    return liveStatusMap;
  }

  /**
   * Create deployment context for closure execution
   */
  public createDeploymentContext(
    deployedResources: Map<string, DeployedResource>,
    _spec: TSpec
  ): DeploymentContext {
    // Get Kubernetes API from deployment engine
    const kubernetesApi = this.deploymentEngine.getKubernetesApi();

    // Create reference resolver function
    const resolveReference = async (ref: unknown): Promise<unknown> => {
      // This would integrate with the existing reference resolution system
      // For now, return a placeholder - this will be enhanced in future tasks
      return ref;
    };

    return {
      kubernetesApi,
      ...(this.factoryOptions.alchemyScope && { alchemyScope: this.factoryOptions.alchemyScope }),
      ...(this.namespace && { namespace: this.namespace }),
      deployedResources,
      resolveReference,
    };
  }

  protected getStrategyMode(): 'direct' | 'kro' {
    return 'direct';
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────

/**
 * Recursively merge live-status re-execution output with base values.
 *
 * Walks the value tree and for each leaf:
 * - KubernetesRef / CelExpression → proxy artifact, use base value
 * - Plain object containing refs → recurse into each key
 * - Array containing refs → recurse into each element
 * - Primitive / clean object → correctly resolved, use live value
 *
 * Internal fields (keys starting with `__`) are always taken from live.
 */
function deepMergeLiveStatus(
  liveValue: unknown,
  baseValue: unknown
): unknown {
  // Internal metadata fields — always from live
  // (handled by callers for top-level, but included for safety)

  // Proxy artifacts — use base
  if (isKubernetesRef(liveValue)) return baseValue;
  if (isCelExpression(liveValue)) return baseValue;

  // Plain objects — may contain a mix of resolved values and artifacts
  if (liveValue !== null && typeof liveValue === 'object' && !Array.isArray(liveValue)) {
    if (!containsKubernetesRefs(liveValue) && !containsCelExpressions(liveValue)) {
      // Entire object is clean — use it directly
      return liveValue;
    }
    // Mixed object — recurse into each key
    const liveObj = liveValue as Record<string, unknown>;
    const baseObj =
      baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue)
        ? (baseValue as Record<string, unknown>)
        : {};
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(liveObj), ...Object.keys(baseObj)])) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (key.startsWith('__')) {
        merged[key] = liveObj[key] ?? baseObj[key];
      } else {
        merged[key] = deepMergeLiveStatus(liveObj[key], baseObj[key]);
      }
    }
    return merged;
  }

  // Arrays — may contain mixed elements
  if (Array.isArray(liveValue)) {
    if (!containsKubernetesRefs(liveValue) && !containsCelExpressions(liveValue)) return liveValue;
    const baseArr = Array.isArray(baseValue) ? baseValue : [];
    return liveValue.map((item, i) => deepMergeLiveStatus(item, baseArr[i]));
  }

  // Primitives (string, number, boolean, null, undefined) — correctly resolved
  return liveValue;
}

function normalizeReadyFromComponents<T>(status: T): T {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return status;
  }

  const statusRecord = status as Record<string, unknown>;
  if (typeof statusRecord.ready !== 'boolean') {
    return status;
  }

  const components = statusRecord.components;
  if (!components || typeof components !== 'object' || Array.isArray(components)) {
    return status;
  }

  const componentValues = Object.values(components as Record<string, unknown>);
  if (componentValues.length === 0 || componentValues.some((value) => typeof value !== 'boolean')) {
    return status;
  }

  const normalizedReady = componentValues.every((value) => value === true);
  if (normalizedReady === statusRecord.ready) {
    return status;
  }

  return {
    ...statusRecord,
    ready: normalizedReady,
  } as T;
}
