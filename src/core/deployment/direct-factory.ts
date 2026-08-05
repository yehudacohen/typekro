/**
 * DirectResourceFactory implementation for direct deployment mode
 *
 * This factory handles direct deployment of Kubernetes resources using TypeKro's
 * internal dependency resolution engine, without requiring the Kro controller.
 */

import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import type { AlchemyResourceDeclaration } from '../../alchemy/types.js';
import { createAlchemyResourceId } from '../../alchemy/utilities.js';
import { toCamelCase } from '../../utils/string.js';
import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { applyAspects } from '../aspects/apply.js';
import { createCompositionContext, runWithCompositionContext } from '../composition/context.js';
import { buildNestedCompositionAliasTargets } from '../composition/nested-status-cel.js';
import {
  DEFAULT_DELETE_TIMEOUT,
  DEFAULT_FAST_POLL_INTERVAL,
  DEFAULT_MAX_RECURSION_DEPTH,
} from '../config/defaults.js';
import { KUBERNETES_REF_SCHEMA_MARKER_SOURCE } from '../constants/brands.js';
import { DependencyResolver } from '../dependencies/index.js';
import {
  ensureError,
  ResourceGraphFactoryError,
  TypeKroError,
  ValidationError,
} from '../errors.js';
import type { KubernetesClientProvider } from '../kubernetes/client-provider.js';
import { createBunCompatibleCoreV1Api } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
import {
  copyResourceMetadata,
  getIncludeWhen,
  getMetadataField,
  getReadinessEvaluator,
  getResourceId,
  setResourceId,
} from '../metadata/index.js';
import type {
  ArtifactApplyPolicy,
  DirectKubernetesArtifactPlan,
  DirectKubernetesArtifactResource,
} from '../planning/artifacts.js';
import {
  assertAdapterCapabilitiesSupported,
  collectArtifactOutputUses,
  collectPlanValueSensitiveBindings,
  compileDirectArtifactPlan,
  createDirectArtifactExecutionMaterialization,
  directArtifactPlanToResourceGraph,
  encodeDirectArtifactExecutionRecord,
  materializeDirectArtifactManifest,
  planValueContainsSensitiveValue,
  planValueSensitiveBindingNames,
  resolveStaticYamlSensitiveBindings,
  type StaticYamlMaterializationOptions,
} from '../planning/index.js';
import type { CapabilityRequirement, PlanValue } from '../planning/types.js';
import { ensureReadinessEvaluator } from '../readiness/evaluator.js';
import { resolvePortableReadinessStrategy } from '../readiness/portable-strategies.js';
import { runStandaloneOperation } from '../runtime/standalone-operation.js';
import { getSingletonResourceId, singletonInstanceTypeMeta } from '../singleton/singleton.js';
import type {
  DeployedResource,
  DeploymentClosure,
  DeploymentError,
  DeploymentResourceGraph,
  DeploymentResult,
  DirectResourceFactory,
  FactoryOptions,
  FactoryStatus,
  InternalResourceFactoryDeployOptions,
  InternalResourceFactoryReadOptions,
  ResourceDeletionResult,
  ResourceFactoryDeleteOptions,
  ResourceFactoryOperationOptions,
  RollbackResult,
  SingletonDefinitionRecord,
} from '../types/deployment.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from '../types/kubernetes.js';
import type { KroCompatibleType, SchemaDefinition, StatusBuilder } from '../types/serialization.js';
import { KubernetesClientManager } from './client-provider-manager.js';
import {
  createDeletionResultState,
  deletionTarget,
  finishDeletionResult,
} from './deletion-result.js';
import { BUILT_IN_GVKS } from './deployment-state-discovery.js';
import { DirectDeploymentEngine } from './engine.js';
import { logHandleSnapshot } from './handle-tracing.js';
import { isNotFoundError } from './k8s-helpers.js';
import { synthesizeNestedCompositionStatus } from './nested-composition-status.js';
import { ResourceReadinessChecker } from './readiness.js';

interface FactoryHealthDetails {
  health: 'healthy' | 'degraded' | 'failed';
  resourceCounts: {
    healthy: number;
    degraded: number;
    failed: number;
    total: number;
  };
  errors: DeploymentError[];
}

import {
  extractSerializableKubeConfigOptions,
  generateInstanceName,
  getSingletonInstanceName,
  validateSpec,
} from './shared-utilities.js';
import {
  assertNoDeployedSingletonSpecDrift,
  assertNoDiscoveredSingletonSpecDrift,
  singletonSpecFingerprintAnnotationValue,
} from './singleton-owner-drift.js';
import { SINGLETON_SPEC_FINGERPRINT_ANNOTATION } from './resource-tagging.js';
import { DirectDeploymentStrategy } from './strategies/index.js';

interface DirectArtifactExecution {
  readonly graph: DeploymentResourceGraph;
  readonly artifacts?: DirectKubernetesArtifactPlan;
}

function deployedResourceDeletionIdentity(
  resource: import('../types/deployment.js').DeployedResource
) {
  const clusterScoped = getMetadataField(resource.manifest, 'scope') === 'cluster';
  return deletionTarget(
    resource.manifest.apiVersion,
    resource.kind,
    resource.name,
    clusterScoped ? undefined : resource.namespace
  );
}

function directArtifactPlanValues(
  artifact: DirectKubernetesArtifactResource
): readonly PlanValue[] {
  const values: PlanValue[] = [
    ...artifact.readiness.activation,
    ...artifact.readiness.readyWhen,
    ...(artifact.iteration ?? []).map((dimension) => dimension.collection),
    ...(artifact.templateOverrides ?? []).map((override) => override.value),
  ];
  if (artifact.identity) {
    values.push(artifact.identity.name);
    if (artifact.identity.namespace) values.push(artifact.identity.namespace);
  }
  if (artifact.desired) values.push(artifact.desired);
  if (artifact.lifecycle.instancing.kind === 'per-scope') {
    values.push(artifact.lifecycle.instancing.key);
  }
  if (artifact.lifecycle.unusedEvidence) values.push(artifact.lifecycle.unusedEvidence.inputs);
  if (artifact.readiness.strategy?.kind === 'registered') {
    const configuration = artifact.readiness.strategy.configuration;
    if (configuration) values.push(configuration);
  }
  return values;
}

/**
 * DirectResourceFactory implementation
 *
 * Handles direct deployment of Kubernetes resources using TypeKro's dependency resolution.
 * Each deployment creates individual Kubernetes resources directly in the cluster.
 */
export class DirectResourceFactoryImpl<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> implements DirectResourceFactory<TSpec, TStatus>
{
  readonly mode = 'direct' as const;
  readonly name: string;
  readonly namespace: string;

  private readonly resources: Record<string, KubernetesResource>;
  private readonly closures: Record<string, DeploymentClosure>;
  private readonly schemaDefinition: SchemaDefinition<TSpec, TStatus>;
  // biome-ignore lint/suspicious/noExplicitAny: status builders accept composition-specific resource maps that cannot be expressed more tightly here.
  private readonly statusBuilder: StatusBuilder<TSpec, TStatus, any> | undefined;
  private deploymentEngine: DirectDeploymentEngine | undefined;
  private readonly factoryOptions: FactoryOptions;
  private readonly singletonDefinitions: SingletonDefinitionRecord[];
  private readonly singletonOwnerStatuses = new Map<string, Record<string, unknown>>();
  private readonly singletonOwnerReferenceSeeds = new Map<string, DeployedResource>();
  private readonly deployedInstances: Map<string, Enhanced<TSpec, TStatus>> = new Map();
  private resolvedResourceKeysForHydration: Record<string, KubernetesResource> | undefined;
  private resolvedClosuresForDeployment: Record<string, DeploymentClosure> | undefined;
  private readonly logger = getComponentLogger('direct-factory');
  private readonly clientManager: KubernetesClientManager;

  constructor(
    name: string,
    resources: Record<string, KubernetesResource>,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    // biome-ignore lint/suspicious/noExplicitAny: constructor must preserve the generic status-builder resource map contract.
    statusBuilder?: StatusBuilder<TSpec, TStatus, any>,
    options: FactoryOptions = {}
  ) {
    this.name = name;
    this.namespace = options.namespace || 'default';
    this.resources = resources;
    this.closures = options.closures || {};
    this.schemaDefinition = schemaDefinition;
    this.statusBuilder = statusBuilder;
    this.factoryOptions = options;
    this.singletonDefinitions = options.singletonDefinitions ?? [];
    this.clientManager = new KubernetesClientManager(options);
  }

  /**
   * Get or create the Kubernetes client provider (lazy initialization)
   */
  private getClientProvider(): KubernetesClientProvider {
    return this.clientManager.getClientProvider();
  }

  private getDebugState(): Record<string, unknown> {
    return {
      mode: this.mode,
      namespace: this.namespace,
      deployedInstances: this.deployedInstances.size,
      hasDeploymentEngine: !!this.deploymentEngine,
      clientManager: this.clientManager.getDebugState(),
      deploymentEngine: this.deploymentEngine?.getDebugState(),
    };
  }

  async dispose(): Promise<void> {
    logHandleSnapshot(this.logger, 'direct-factory.dispose.before', {
      factoryState: this.getDebugState(),
    });
    if (this.deploymentEngine) {
      await this.deploymentEngine.dispose();
      this.deploymentEngine = undefined;
    }
    this.clientManager.dispose();
    logHandleSnapshot(this.logger, 'direct-factory.dispose.after', {
      factoryState: this.getDebugState(),
    });
  }

  /**
   * Get or create the deployment engine using the centralized client provider
   */
  private getDeploymentEngine(): DirectDeploymentEngine {
    if (!this.deploymentEngine) {
      this.logger.debug('Creating DirectDeploymentEngine with KubernetesClientProvider');

      // Get the KubeConfig from the centralized provider (lazy initialization)
      const clientProvider = this.getClientProvider();
      const kubeConfig = clientProvider.getKubeConfig();

      // Create the deployment engine with the provider's KubeConfig
      // Pass HTTP timeout configuration if provided in factory options
      this.deploymentEngine = new DirectDeploymentEngine(
        kubeConfig,
        undefined,
        undefined,
        'direct',
        this.factoryOptions.httpTimeouts
      );

      this.logger.debug('DirectDeploymentEngine created successfully', {
        currentContext: kubeConfig.getCurrentContext(),
        server: kubeConfig.getCurrentCluster()?.server,
      });
    }
    return this.deploymentEngine;
  }

  /**
   * Deploy a new instance with the given spec
   */
  async deploy(
    spec: TSpec,
    opts?: InternalResourceFactoryDeployOptions
  ): Promise<Enhanced<TSpec, TStatus>> {
    if (opts?.operationSignal) {
      return this.deployWithinOperation(spec, opts, opts.operationSignal);
    }
    return runStandaloneOperation(
      (abortSignal) =>
        this.deployWithinOperation(spec, { ...opts, operationSignal: abortSignal }, abortSignal),
      { abortSignals: [this.factoryOptions.abortSignal, opts?.abortSignal] }
    );
  }

  private async deployWithinOperation(
    spec: TSpec,
    opts: InternalResourceFactoryDeployOptions,
    abortSignal: AbortSignal
  ): Promise<Enhanced<TSpec, TStatus>> {
    this.logger.debug('DirectResourceFactory deploy called', {
      factoryName: this.name,
      hasStatusBuilder: !!this.statusBuilder,
    });

    validateSpec(spec, this.schemaDefinition, {
      kind: this.schemaDefinition.kind,
      name: this.name,
    });

    // Use the consolidated deployment strategy
    const strategy = this.getDeploymentStrategy();

    this.logger.debug('Got deployment strategy', {
      strategyType: strategy.constructor.name,
    });

    await this.ensureSingletonOwners(spec, abortSignal);

    const instance = await strategy.deploy(spec, { ...opts, abortSignal });

    // Check if deployment failed and throw for user-facing error handling
    if (instance.metadata?.annotations?.['typekro.io/deployment-status'] === 'failed') {
      const errorMessage =
        instance.metadata?.annotations?.['typekro.io/deployment-error'] ||
        'Deployment failed - check logs for details';
      throw new ResourceGraphFactoryError(errorMessage, this.name, 'deployment');
    }

    // Track the deployed instance
    const instanceName = opts?.instanceNameOverride ?? this.generateInstanceName(spec);
    this.deployedInstances.set(instanceName, instance);

    return instance;
  }

  /**
   * Get the appropriate deployment strategy based on configuration
   */
  private getDeploymentStrategy() {
    return new DirectDeploymentStrategy(
      this.name,
      this.namespace,
      this.schemaDefinition,
      this.statusBuilder,
      this.resources,
      this.factoryOptions,
      this.getDeploymentEngine(),
      this // This factory acts as the resource resolver
    );
  }

  /**
   * Get all deployed instances
   *
   * Direct mode currently reports same-process instances only. Cross-process
   * discovery is implemented for `deleteInstance(name)`, but reconstructing
   * fully typed Enhanced instances from live tagged resources is intentionally
   * not attempted here.
   */
  async getInstances(
    opts?: InternalResourceFactoryReadOptions
  ): Promise<Enhanced<TSpec, TStatus>[]> {
    const abortSignal = opts?.operationSignal ?? opts?.abortSignal;
    abortSignal?.throwIfAborted();
    return Array.from(this.deployedInstances.values());
  }

  /**
   * Delete a specific instance by name.
   *
   * Lookup order:
   *   1. In-memory `deployedInstances` Map (same-process path) — uses
   *      the deployment-id annotation on the Enhanced instance proxy.
   *   2. Cluster-side label discovery (cross-process path) — queries
   *      for all resources labeled `typekro.io/factory-name=<factory>,
   *      typekro.io/instance-name=<instance>`, reconstructs the
   *      dependency graph from per-resource `typekro.io/depends-on`
   *      annotations, and performs reverse-topological deletion.
   *
   * Both paths feed into the same graph-based reverse-topological
   * delete via `engine.rollbackRecord`.
   *
   * **Scope filtering**: By default, unscoped (instance-private)
   * resources are deleted and scoped resources are preserved. Pass
   * `opts.scopes` to include broader-scope resources additively:
   *
   * ```ts
   * await factory.deleteInstance('my-app');                                         // unscoped only (safe default)
   * await factory.deleteInstance('my-app', { scopes: ['cluster'] });               // unscoped + cluster
   * await factory.deleteInstance('my-app', { scopes: ['cluster'],
   *   includeUnscopedResources: false });                                           // cluster-only (leave app running)
   * ```
   */
  async deleteInstance(
    name: string,
    opts?: ResourceFactoryDeleteOptions
  ): Promise<ResourceDeletionResult> {
    return runStandaloneOperation(
      (abortSignal) => this.deleteInstanceWithinOperation(name, opts, abortSignal),
      { abortSignals: [this.factoryOptions.abortSignal, opts?.abortSignal] }
    );
  }

  private async deleteInstanceWithinOperation(
    name: string,
    opts: ResourceFactoryDeleteOptions | undefined,
    abortSignal: AbortSignal
  ): Promise<ResourceDeletionResult> {
    const deletion = createDeletionResultState('direct', this.name, name);
    try {
      const rollbackResult = await this.rollbackInstanceWithNamespaceCompletion(
        name,
        opts,
        abortSignal
      );

      deletion.deleted.push(
        ...(rollbackResult.deletedResources ?? []).map(deployedResourceDeletionIdentity)
      );
      for (const resource of rollbackResult.retainedResources ?? []) {
        const identity = deployedResourceDeletionIdentity(resource);
        deletion.retained.push({
          resource: identity,
          policy: 'scope-filter',
          reason:
            'The resource scope is outside the requested deletion scope and was retained intentionally.',
        });
      }

      if (rollbackResult.status !== 'success' || rollbackResult.errors.length > 0) {
        for (const error of rollbackResult.errors) {
          deletion.blockers.push({
            code: 'CLEANUP_ERROR',
            message: `${error.resourceId}: ${ensureError(error.error).message}`,
            retryable: true,
            retryGuidance:
              'Inspect the referenced resource and retry deletion after its controller or finalizers can make progress.',
          });
        }
        return finishDeletionResult(deletion, 'blocked', {
          safe: true,
          guidance: 'Retry after resolving the listed resource cleanup errors.',
        });
      }

      // Remove from tracking
      this.deployedInstances.delete(name);
      return finishDeletionResult(deletion, 'complete', {
        safe: true,
        guidance:
          deletion.retained.length > 0
            ? 'The instance-private graph is gone. Resources outside the requested scopes were retained explicitly.'
            : 'The requested direct-mode instance graph is gone.',
      });
    } catch (error: unknown) {
      if (abortSignal.aborted) {
        throw abortSignal.reason ?? error;
      }
      // Deletion is idempotent: no in-memory state and no tagged live
      // resources is positive evidence that the requested graph is gone.
      if (error instanceof TypeKroError && error.code === 'INSTANCE_NOT_FOUND') {
        return finishDeletionResult(deletion, 'complete', {
          safe: true,
          guidance:
            'No tagged or in-memory resources remain for this instance; deletion is already complete.',
        });
      }
      // Soft-swallow "Cannot rollback" errors from the engine —
      // they indicate the engine's in-memory deployment state has
      // already been cleaned up (e.g., by a previous rollback call).
      // The instance is effectively gone, so we remove from tracking.
      const errorMessage = ensureError(error).message;
      if (errorMessage.includes('Cannot rollback')) {
        this.deployedInstances.delete(name);
        return finishDeletionResult(deletion, 'complete', {
          safe: true,
          guidance: 'The deployment record was already removed; no remaining instance was found.',
        });
      }
      deletion.blockers.push({
        code: 'CLEANUP_ERROR',
        message: `Failed to delete instance ${name}: ${errorMessage}`,
        retryable: true,
        retryGuidance:
          'Inspect the reported Kubernetes error and retry. TypeKro does not report deletion complete while cleanup is unproven.',
      });
      return finishDeletionResult(deletion, 'blocked', {
        safe: true,
        guidance: 'Retry after resolving the reported cleanup error.',
      });
    }
  }

  private buildKnownGvks(): import('./deployment-state-discovery.js').GvkTarget[] {
    const crdHints = new Map<string, import('./deployment-state-discovery.js').GvkTarget>();
    for (const r of Object.values(this.resources)) {
      if (!r.apiVersion || !r.kind) continue;
      const key = `${r.apiVersion}/${r.kind}`;
      if (crdHints.has(key)) continue;
      const scope = getMetadataField(r as object, 'scope');
      crdHints.set(key, {
        apiVersion: r.apiVersion,
        kind: r.kind,
        namespaced: scope !== 'cluster',
      });
    }
    return [...BUILT_IN_GVKS, ...crdHints.values()];
  }

  private async rollbackInstanceResources(
    name: string,
    opts?: ResourceFactoryDeleteOptions,
    abortSignal?: AbortSignal
  ): Promise<RollbackResult> {
    const engine = this.getDeploymentEngine();
    const instance = this.deployedInstances.get(name);

    if (instance) {
      const deploymentId = instance.metadata?.annotations?.['typekro.io/deployment-id'];
      if (deploymentId) {
        try {
          return await engine.rollback(deploymentId, {
            ...(opts?.scopes && { scopes: opts.scopes }),
            ...(opts?.includeUnscopedResources === false && { includeUnscopedResources: false }),
            ...(opts?.timeout !== undefined || this.factoryOptions.timeout !== undefined
              ? {
                  timeout: opts?.timeout ?? this.factoryOptions.timeout,
                }
              : {}),
            ...(abortSignal ? { abortSignal } : {}),
          });
        } catch (error: unknown) {
          const isNotFound =
            error instanceof ResourceGraphFactoryError && error.operation === 'cleanup';
          if (!isNotFound) {
            throw error;
          }
        }
      }
    }

    const record = await engine.loadDeploymentByInstance({
      factoryName: this.name,
      instanceName: name,
      factoryNamespace: this.namespace,
      knownGvks: this.buildKnownGvks(),
    });
    if (!record) {
      throw new TypeKroError(
        `Instance not found: ${name} (no in-memory state and no tagged resources on the cluster). The instance may have been cleaned up already, or was deployed with a typekro version that did not tag resources.`,
        'INSTANCE_NOT_FOUND',
        { instanceName: name, factoryName: this.name }
      );
    }
    this.logger.info('Cross-process cleanup: discovered deployment from cluster labels', {
      instanceName: name,
      factoryName: this.name,
      deploymentId: record.deploymentId,
      resourceCount: record.resources.length,
    });
    return engine.rollbackRecord(record, {
      ...(opts?.scopes && { scopes: opts.scopes }),
      ...(opts?.includeUnscopedResources === false && { includeUnscopedResources: false }),
      ...(opts?.timeout !== undefined || this.factoryOptions.timeout !== undefined
        ? { timeout: opts?.timeout ?? this.factoryOptions.timeout }
        : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  /**
   * Use the same complete teardown contract for deleteInstance() and rollback().
   * A successful rollback is not complete while an owned Namespace remains
   * terminating, because an immediate redeploy can otherwise race that deletion.
   */
  private async rollbackInstanceWithNamespaceCompletion(
    name: string,
    opts?: ResourceFactoryDeleteOptions,
    abortSignal?: AbortSignal
  ): Promise<RollbackResult> {
    const rollbackResult = await this.rollbackInstanceResources(name, opts, abortSignal);
    if (rollbackResult.status === 'success' && rollbackResult.errors.length === 0) {
      await this.completeNamespaceDeletion(rollbackResult, opts?.timeout, abortSignal);
    }
    return rollbackResult;
  }

  private async completeNamespaceDeletion(
    rollbackResult: RollbackResult,
    timeout?: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const namespaceLeases = new Map<string, string>();
    for (const resource of rollbackResult.deletedResources ?? []) {
      if (resource.kind !== 'Namespace') continue;
      const uid = resource.liveManifest?.metadata?.uid ?? resource.manifest.metadata?.uid;
      if (!uid) {
        throw new TypeKroError(
          `Refusing post-delete cleanup for Namespace ${resource.name} without its Kubernetes UID lease`,
          'NAMESPACE_UID_UNAVAILABLE',
          { namespace: resource.name }
        );
      }
      namespaceLeases.set(resource.name, uid);
    }

    if (namespaceLeases.size === 0) return;

    // Delete PVCs in the exact Namespace identities targeted by rollback before
    // waiting. A Namespace name can be reused after deletion, so every follow-up
    // read and delete remains bound to the captured UID lease.
    const kubeConfig = this.getClientProvider().getKubeConfig();
    const coreApi = createBunCompatibleCoreV1Api(kubeConfig, this.factoryOptions.httpTimeouts);
    const objectApi = this.getDeploymentEngine().getKubernetesApi();
    const leaseStillCurrent = async (namespace: string, uid: string): Promise<boolean> => {
      try {
        const live = (await objectApi.read({
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: { name: namespace },
        })) as KubernetesResource;
        return live.metadata?.uid === uid;
      } catch (error: unknown) {
        if (isNotFoundError(error)) return false;
        throw error;
      }
    };

    for (const [namespace, namespaceUid] of namespaceLeases) {
      abortSignal?.throwIfAborted();
      if (!(await leaseStillCurrent(namespace, namespaceUid))) continue;
      let pvcs: Awaited<ReturnType<typeof coreApi.listNamespacedPersistentVolumeClaim>>;
      try {
        pvcs = await coreApi.listNamespacedPersistentVolumeClaim({ namespace });
      } catch (error: unknown) {
        if (isNotFoundError(error)) continue;
        throw error;
      }
      if (pvcs.items.length > 0) {
        this.logger.info('Deleting PVCs to unblock namespace termination', {
          namespace,
          count: pvcs.items.length,
        });
      }
      for (const pvc of pvcs.items) {
        abortSignal?.throwIfAborted();
        const pvcName = pvc.metadata?.name;
        const pvcUid = pvc.metadata?.uid;
        if (!pvcName || !pvcUid) {
          throw new TypeKroError(
            `Refusing to delete a PersistentVolumeClaim in Namespace ${namespace} without a complete UID lease`,
            'PVC_UID_UNAVAILABLE',
            { namespace, pvcName }
          );
        }
        if (!(await leaseStillCurrent(namespace, namespaceUid))) break;
        try {
          await coreApi.deleteNamespacedPersistentVolumeClaim({
            name: pvcName,
            namespace,
            body: { preconditions: { uid: pvcUid } },
          });
        } catch (error: unknown) {
          if (!isNotFoundError(error)) throw error;
        }
      }
    }

    const deleteTimeout = timeout ?? this.factoryOptions.timeout ?? DEFAULT_DELETE_TIMEOUT;
    await this.waitForNamespaceDeletion(
      objectApi,
      [...namespaceLeases].map(([name, uid]) => ({ name, uid })),
      deleteTimeout,
      abortSignal
    );
  }

  /**
   * Poll until the given namespaces no longer exist (HTTP 404).
   * Namespaces enter a "Terminating" phase on deletion and may take time
   * to fully disappear, especially when finalizers or remaining resources
   * are involved.
   */
  private async waitForNamespaceDeletion(
    k8sApi: import('@kubernetes/client-node').KubernetesObjectApi,
    namespaces: Array<{ name: string; uid: string }>,
    timeout: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const pollInterval = DEFAULT_FAST_POLL_INTERVAL;

    for (const { name: ns, uid } of namespaces) {
      // Each namespace gets its own timeout budget
      const nsStartTime = Date.now();
      let deleted = false;
      while (Date.now() - nsStartTime < timeout) {
        abortSignal?.throwIfAborted();
        try {
          const live = (await k8sApi.read({
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: { name: ns },
          })) as KubernetesResource;
          // The leased Namespace is gone. A replacement with the same name is
          // outside this teardown and must neither be waited on nor mutated.
          if (live.metadata?.uid !== uid) {
            deleted = true;
            break;
          }
          // Namespace still exists (likely "Terminating"), keep polling
          await new Promise<void>((resolve, reject) => {
            if (!abortSignal) {
              setTimeout(resolve, pollInterval);
              return;
            }
            const onAbort = () => {
              clearTimeout(delay);
              reject(
                abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError')
              );
            };
            const delay = setTimeout(() => {
              abortSignal.removeEventListener('abort', onAbort);
              resolve();
            }, pollInterval);
            if (abortSignal.aborted) {
              onAbort();
              return;
            }
            abortSignal.addEventListener('abort', onAbort, { once: true });
          });
        } catch (error: unknown) {
          // 404 means the namespace is fully gone
          const k8sErr = error as { statusCode?: number; body?: { code?: number } };
          if (k8sErr.statusCode === 404 || k8sErr.body?.code === 404) {
            this.logger.debug('Namespace fully deleted', { namespace: ns });
            deleted = true;
            break;
          }
          // Unexpected error — fail loudly so callers do not assume cleanup completed.
          this.logger.warn('Error polling namespace deletion', {
            namespace: ns,
            error: ensureError(error).message,
          });
          throw error;
        }
      }
      if (!deleted) {
        throw new ResourceGraphFactoryError(
          `Timed out waiting for namespace ${ns} to be deleted after ${timeout}ms`,
          this.name,
          'cleanup'
        );
      }
    }
  }

  /**
   * Get factory status with real health checking using readiness evaluators
   *
   * Direct mode status is based on same-process instances returned by
   * `getInstances()`. Use `deleteInstance(name)` for cross-process cleanup;
   * status reconstruction from tagged live resources is not currently exposed.
   */
  async getStatus(opts?: InternalResourceFactoryReadOptions): Promise<FactoryStatus> {
    if (opts?.operationSignal) {
      return this.getStatusWithinOperation(opts.operationSignal);
    }
    return runStandaloneOperation((abortSignal) => this.getStatusWithinOperation(abortSignal), {
      abortSignals: [this.factoryOptions.abortSignal, opts?.abortSignal],
    });
  }

  private async getStatusWithinOperation(abortSignal: AbortSignal): Promise<FactoryStatus> {
    const instances = await this.getInstances({ operationSignal: abortSignal });

    // If no instances, we're healthy by definition
    let health: 'healthy' | 'degraded' | 'failed' = 'healthy';

    if (instances.length > 0) {
      // Only perform cluster health checking if we have deployed instances
      health = await this.checkFactoryHealth(abortSignal);
    }

    return {
      name: this.name,
      mode: this.mode,
      namespace: this.namespace,
      instanceCount: instances.length,
      health,
    };
  }

  /**
   * Check the overall health of the factory by leveraging existing ResourceReadinessChecker
   */
  private async checkFactoryHealth(
    abortSignal: AbortSignal
  ): Promise<'healthy' | 'degraded' | 'failed'> {
    const healthLogger = this.logger.child({ method: 'checkFactoryHealth' });

    try {
      abortSignal.throwIfAborted();
      const engine = this.getDeploymentEngine();

      // Get all deployment states from the engine
      const deploymentStates = engine.getAllDeploymentStates();

      if (deploymentStates.length === 0) {
        healthLogger.debug('No deployments found, factory is healthy');
        return 'healthy';
      }

      let healthyCount = 0;
      let degradedCount = 0;
      let failedCount = 0;
      let totalResources = 0;
      const healthErrors: DeploymentError[] = [];

      // Check health of all resources across all deployments
      for (const deploymentState of deploymentStates) {
        for (const deployedResource of deploymentState.resources) {
          totalResources++;

          try {
            abortSignal.throwIfAborted();
            // Use the deployment engine's readiness logic (includes custom evaluators + fallback)
            const engine = this.getDeploymentEngine();
            const isReady = await engine.isDeployedResourceReady(deployedResource);
            abortSignal.throwIfAborted();

            if (isReady) {
              healthyCount++;
            } else {
              // Resource exists but not ready - consider degraded
              degradedCount++;
              healthLogger.info('Resource not ready', {
                resourceId: deployedResource.id,
                kind: deployedResource.kind,
                name: deployedResource.name,
                namespace: deployedResource.namespace,
              });
            }
          } catch (error: unknown) {
            abortSignal.throwIfAborted();
            // Resource not found or API error - consider it failed
            failedCount++;
            const healthError: DeploymentError = {
              resourceId: deployedResource.id,
              phase: 'readiness',
              error: ensureError(error),
              timestamp: new Date(),
            };
            healthErrors.push(healthError);

            healthLogger.error('Failed to check resource health', ensureError(error), {
              resourceId: deployedResource.id,
            });
          }
        }
      }

      // Log health errors for debugging
      if (healthErrors.length > 0) {
        healthLogger.debug('Health check errors encountered', {
          errorCount: healthErrors.length,
          errors: healthErrors.map((e) => ({
            resourceId: e.resourceId,
            phase: e.phase,
            message: e.error.message,
          })),
        });
      }

      // Determine overall health based on resource status distribution
      if (failedCount > 0) {
        healthLogger.info('Factory health: failed', {
          healthy: healthyCount,
          degraded: degradedCount,
          failed: failedCount,
          total: totalResources,
          errorCount: healthErrors.length,
        });
        return 'failed';
      } else if (degradedCount > 0) {
        healthLogger.info('Factory health: degraded', {
          healthy: healthyCount,
          degraded: degradedCount,
          failed: failedCount,
          total: totalResources,
        });
        return 'degraded';
      } else {
        healthLogger.info('Factory health: healthy', {
          healthy: healthyCount,
          degraded: degradedCount,
          failed: failedCount,
          total: totalResources,
        });
        return 'healthy';
      }
    } catch (error: unknown) {
      abortSignal.throwIfAborted();
      healthLogger.error('Error checking factory health', ensureError(error));
      return 'failed';
    }
  }

  /**
   * Get detailed health information including any errors encountered
   * Useful for debugging and monitoring
   */
  async getHealthDetails(opts?: InternalResourceFactoryReadOptions): Promise<FactoryHealthDetails> {
    if (opts?.operationSignal) {
      return this.getHealthDetailsWithinOperation(opts.operationSignal);
    }
    return runStandaloneOperation(
      (abortSignal) => this.getHealthDetailsWithinOperation(abortSignal),
      { abortSignals: [this.factoryOptions.abortSignal, opts?.abortSignal] }
    );
  }

  private async getHealthDetailsWithinOperation(
    abortSignal: AbortSignal
  ): Promise<FactoryHealthDetails> {
    const healthLogger = this.logger.child({ method: 'getHealthDetails' });

    // Check if we have any instances first to avoid initializing engine unnecessarily
    const instances = await this.getInstances({ operationSignal: abortSignal });
    if (instances.length === 0) {
      return {
        health: 'healthy',
        resourceCounts: { healthy: 0, degraded: 0, failed: 0, total: 0 },
        errors: [],
      };
    }

    try {
      const engine = this.getDeploymentEngine();
      const deploymentStates = engine.getAllDeploymentStates();

      if (deploymentStates.length === 0) {
        return {
          health: 'healthy',
          resourceCounts: { healthy: 0, degraded: 0, failed: 0, total: 0 },
          errors: [],
        };
      }

      const k8sApi = engine.getKubernetesApi();
      const readinessChecker = new ResourceReadinessChecker(k8sApi);

      let healthyCount = 0;
      let degradedCount = 0;
      let failedCount = 0;
      let totalResources = 0;
      const healthErrors: DeploymentError[] = [];

      // Check health of all resources across all deployments
      for (const deploymentState of deploymentStates) {
        for (const deployedResource of deploymentState.resources) {
          totalResources++;

          try {
            abortSignal.throwIfAborted();
            const resourceRef = {
              apiVersion: deployedResource.manifest.apiVersion || '',
              kind: deployedResource.kind,
              metadata: {
                name: deployedResource.name,
                namespace: deployedResource.namespace,
              },
            };
            // In the new API, methods return objects directly (no .body wrapper)
            const liveResource = await k8sApi.read(resourceRef);
            abortSignal.throwIfAborted();

            const isReady = readinessChecker.isResourceReady(liveResource);

            if (isReady) {
              healthyCount++;
            } else {
              degradedCount++;
            }
          } catch (error: unknown) {
            abortSignal.throwIfAborted();
            failedCount++;
            const healthError: DeploymentError = {
              resourceId: deployedResource.id,
              phase: 'readiness',
              error: ensureError(error),
              timestamp: new Date(),
            };
            healthErrors.push(healthError);
          }
        }
      }

      const health = failedCount > 0 ? 'failed' : degradedCount > 0 ? 'degraded' : 'healthy';

      return {
        health,
        resourceCounts: {
          healthy: healthyCount,
          degraded: degradedCount,
          failed: failedCount,
          total: totalResources,
        },
        errors: healthErrors,
      };
    } catch (error: unknown) {
      abortSignal.throwIfAborted();
      healthLogger.error('Error getting health details', ensureError(error));
      return {
        health: 'failed',
        resourceCounts: { healthy: 0, degraded: 0, failed: 0, total: 0 },
        errors: [
          {
            resourceId: 'factory',
            phase: 'readiness',
            error: ensureError(error),
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Rollback all deployments made by this factory
   *
   * This rolls back same-process deployments tracked by this factory instance.
   * For cross-process cleanup, call `deleteInstance(name)` with the known
   * instance name so TypeKro can discover tagged resources from the cluster.
   */
  async rollback(opts?: ResourceFactoryOperationOptions): Promise<RollbackResult> {
    return runStandaloneOperation((abortSignal) => this.rollbackWithinOperation(abortSignal), {
      abortSignals: [this.factoryOptions.abortSignal, opts?.abortSignal],
    });
  }

  private async rollbackWithinOperation(abortSignal: AbortSignal): Promise<RollbackResult> {
    abortSignal.throwIfAborted();
    this.logger.debug('Starting rollback for all deployed instances');

    const startedAt = Date.now();
    const instanceNames = Array.from(this.deployedInstances.keys());

    this.logger.debug('Rolling back resources', {
      instanceCount: instanceNames.length,
      instanceNames,
    });

    const rolledBackResources: string[] = [];
    const errors: DeploymentError[] = [];
    let status: RollbackResult['status'] = 'success';

    for (const instanceName of instanceNames) {
      try {
        abortSignal.throwIfAborted();
        const result = await this.rollbackInstanceWithNamespaceCompletion(
          instanceName,
          undefined,
          abortSignal
        );
        rolledBackResources.push(...result.rolledBackResources);
        errors.push(...result.errors);
        if (result.status === 'failed') {
          status = 'failed';
        } else if (result.status === 'partial' && status === 'success') {
          status = 'partial';
        }
        if (result.status === 'success' && result.errors.length === 0) {
          this.deployedInstances.delete(instanceName);
        }
      } catch (error: unknown) {
        abortSignal.throwIfAborted();
        status = 'failed';
        errors.push({
          resourceId: instanceName,
          phase: 'rollback',
          error: ensureError(error),
          timestamp: new Date(),
        });
      }
    }

    if (errors.length > 0 && status === 'success') {
      status = rolledBackResources.length > 0 ? 'partial' : 'failed';
    }

    const result: RollbackResult = {
      deploymentId: `factory-rollback-${Date.now()}`,
      rolledBackResources,
      duration: Date.now() - startedAt,
      status,
      errors,
    };

    if (result.status === 'success') {
      this.deployedInstances.clear();
    }

    this.logger.info('Rollback completed', {
      status: result.status,
      resourceCount: result.rolledBackResources.length,
    });

    return result;
  }

  /**
   * Perform a dry run deployment
   */
  async toDryRun(spec: TSpec, opts?: ResourceFactoryOperationOptions): Promise<DeploymentResult> {
    return runStandaloneOperation(
      (abortSignal) => this.toDryRunWithinOperation(spec, abortSignal),
      { abortSignals: [this.factoryOptions.abortSignal, opts?.abortSignal] }
    );
  }

  private async toDryRunWithinOperation(
    spec: TSpec,
    abortSignal: AbortSignal
  ): Promise<DeploymentResult> {
    abortSignal.throwIfAborted();
    const resourceGraph = this.createResourceGraphForInstance(spec);

    const deploymentOptions = {
      mode: 'direct' as const,
      namespace: this.namespace,
      ...(this.factoryOptions.timeout && { timeout: this.factoryOptions.timeout }),
      waitForReady: false, // Don't wait for readiness in dry run
      dryRun: true,
      abortSignal,
      ...(this.factoryOptions.retryPolicy && { retryPolicy: this.factoryOptions.retryPolicy }),
      ...(this.factoryOptions.progressCallback && {
        progressCallback: this.factoryOptions.progressCallback,
      }),
    };

    return this.getDeploymentEngine().deploy(resourceGraph, deploymentOptions);
  }

  /**
   * Generate YAML for instance deployment.
   *
   * In direct mode this produces plain Kubernetes manifests with all schema
   * references resolved from the provided spec.  If any KubernetesRef or
   * CelExpression objects remain after resolution (cross-resource references,
   * explicit Cel.expr/Cel.template calls, $-prefixed optional access) a
   * ValidationError is thrown — those constructs require the Kro controller
   * or runtime deployment via deploy().
   */
  toYaml(spec: TSpec, options?: StaticYamlMaterializationOptions): string {
    // Serialize the same artifact-derived graph used by deploy/dry-run/Alchemy.
    // The compatibility facade still rejects runtime-only references below.
    const execution = this.createArtifactExecutionForInstance(spec, undefined, {
      staticYamlOptions: options ?? {},
    });
    this.assertExecutionCapabilities(execution, { host: null, output: 'static' });
    const resolvedResources = Object.fromEntries(
      execution.graph.resources.map(({ id, manifest }) => [id, manifest])
    );
    const orderedResources = execution.graph.dependencyGraph.getTopologicalOrder().flatMap((id) => {
      const resource = resolvedResources[id];
      return resource ? [resource] : [];
    });

    // Validate that all values are fully resolved — no KubernetesRef or
    // CelExpression objects should remain in direct-mode YAML output.
    const unresolvedRefs = findUnresolvedReferences(resolvedResources);
    if (unresolvedRefs.length > 0) {
      const details = unresolvedRefs.map((r) => `  - ${r.path}: ${r.description}`).join('\n');
      throw new ValidationError(
        `Cannot generate direct-mode YAML: ${unresolvedRefs.length} unresolved reference(s) found.\n` +
          `Direct mode toYaml() produces plain Kubernetes manifests where all values must be resolved.\n\n` +
          `Unresolved references:\n${details}\n\n` +
          `To fix this, either:\n` +
          `  1. Use factory('kro') to generate Kro-managed YAML with CEL expressions\n` +
          `  2. Use deploy() which resolves all references at runtime against the live cluster\n` +
          `  3. Remove Cel.expr() / Cel.template() / cross-resource references from your resource builder`,
        'DirectResourceFactory',
        this.name,
        undefined,
        [
          'Use factory("kro") for resource graphs with CEL expressions or cross-resource references',
          'Use deploy() for runtime resolution against the live cluster',
          'Remove explicit Cel.expr() / Cel.template() calls if direct-mode YAML is needed',
        ]
      );
    }

    // Generate individual Kubernetes resource YAML manifests (not RGD).
    // Uses js-yaml for safe serialization — avoids YAML injection via string interpolation.
    const yamlParts = orderedResources.map((resource) => {
      // Remove TypeKro-specific fields and generate clean Kubernetes YAML
      const cleanResource = { ...resource } as KubernetesResource & { id?: string };
      delete cleanResource.id; // Remove TypeKro id field

      // Build a clean manifest object for yaml.dump
      const manifest: Record<string, unknown> = {
        apiVersion: cleanResource.apiVersion,
        kind: cleanResource.kind,
        metadata: {
          name: cleanResource.metadata?.name,
          ...(getMetadataField(resource as object, 'scope') === 'cluster'
            ? {}
            : { namespace: cleanResource.metadata?.namespace ?? this.namespace }),
          ...(cleanResource.metadata?.labels
            ? { labels: cleanResource.metadata.labels }
            : undefined),
          ...(cleanResource.metadata?.annotations
            ? { annotations: cleanResource.metadata.annotations }
            : undefined),
        },
      };

      // Preserve every ordinary top-level Kubernetes field. Many resources do
      // not place their desired state under `spec`: StorageClass uses
      // provisioner/parameters/reclaimPolicy, RBAC uses rules/roleRef/subjects,
      // and Secret uses stringData/type. A spec/data allowlist silently emitted
      // syntactically valid but behaviorally empty manifests for those kinds.
      for (const [key, value] of Object.entries(cleanResource)) {
        if (
          key === 'apiVersion' ||
          key === 'kind' ||
          key === 'metadata' ||
          key === 'id' ||
          key === 'status'
        ) {
          continue;
        }
        if (value !== undefined) manifest[key] = value;
      }

      // JSON round-trip strips non-serializable values (functions, symbols, proxies)
      // that may remain in resolved resources before safe YAML serialization.
      const safeManifest = JSON.parse(JSON.stringify(manifest));
      return yaml.dump(safeManifest, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd();
    });

    return yamlParts.join('\n---\n');
  }

  /**
   * Create a resource graph for a specific instance
   */
  public createResourceGraphForInstance(
    spec: TSpec,
    instanceNameOverride?: string
  ): DeploymentResourceGraph {
    const execution = this.createArtifactExecutionForInstance(spec, instanceNameOverride);
    this.assertExecutionCapabilities(execution, { host: 'standalone', output: 'live' });
    return execution.graph;
  }

  private assertExecutionCapabilities(
    execution: DirectArtifactExecution,
    context: { readonly host: 'standalone' | 'alchemy' | null; readonly output: 'live' | 'static' }
  ): void {
    const compatibilityRequirements: readonly CapabilityRequirement[] =
      execution.artifacts?.requiredCapabilities ??
      (Object.keys(this.closures).length > 0
        ? [
            {
              id: 'typekro.runtime-closure',
              version: 1,
              host: 'standalone',
              output: 'live',
            },
          ]
        : []);
    assertAdapterCapabilitiesSupported(compatibilityRequirements, {
      target: 'direct',
      ...context,
    });
  }

  private createArtifactExecutionForInstance(
    spec: TSpec,
    instanceNameOverride?: string,
    options: {
      readonly sensitiveBindings?: Readonly<Record<string, unknown>>;
      readonly staticYamlOptions?: StaticYamlMaterializationOptions;
      readonly preserveArtifactOutputs?: boolean;
      /**
       * Singleton ownership is part of the desired Kubernetes object, not
       * provider-only decoration. Include it before semantic compilation so
       * the canonical execution record and every rehydrated apply preserve
       * the same drift identity.
       */
      readonly singletonSpecFingerprint?: string;
    } = {}
  ): DirectArtifactExecution {
    const capturedGraph = this.createLegacyResourceGraphForInstance(spec, instanceNameOverride);
    const legacyGraph = options.singletonSpecFingerprint
      ? {
          ...capturedGraph,
          resources: capturedGraph.resources.map(({ id, manifest }) => {
            const decorated = {
              ...manifest,
              metadata: {
                ...manifest.metadata,
                annotations: {
                  ...manifest.metadata.annotations,
                  [SINGLETON_SPEC_FINGERPRINT_ANNOTATION]:
                    options.singletonSpecFingerprint as string,
                },
              },
            } as typeof manifest;
            copyResourceMetadata(manifest, decorated);
            return { id, manifest: decorated };
          }),
        }
      : capturedGraph;
    const capture = this.factoryOptions.semanticCapture;
    if (!capture) return { graph: legacyGraph };

    const configuredPlan = this.factoryOptions.plan ?? {};
    const planOptions = {
      ...configuredPlan,
      aspects: configuredPlan.aspects ?? this.factoryOptions.aspects ?? [],
    };
    const materializedSourceIds = legacyGraph.resources
      .map(({ manifest }) => getResourceId(manifest))
      .filter((id): id is string => !!id);
    const containsExpandedIteration =
      new Set(materializedSourceIds).size !== materializedSourceIds.length;
    // Re-execution expands collection bodies into concrete resources that
    // intentionally share one authoring id. A materialized node map cannot
    // represent those repetitions without losing their iteration identity, so
    // retain the analyzer-proven PlanIterationDimension and let the direct
    // runtime adapter expand it. Non-collection graphs keep their concrete
    // materialized desired state, including nested composition resolution.
    const plan = containsExpandedIteration
      ? capture.plan(spec, planOptions)
      : capture.planMaterialized(spec, legacyGraph, planOptions);
    const artifacts = compileDirectArtifactPlan(plan, {
      strict: true,
      applyPolicy: this.getArtifactApplyPolicy(),
    });
    const placeholderArtifactOutputs = options.preserveArtifactOutputs
      ? Object.fromEntries(
          artifacts.artifactRequirements.map((requirement) => [
            requirement.id,
            Object.fromEntries(
              requirement.outputs.map((output) => [
                output,
                `__typekro_artifact_${encodeURIComponent(requirement.id)}_${encodeURIComponent(output)}__`,
              ])
            ),
          ])
        )
      : undefined;
    const runtimeResources = Object.fromEntries(
      legacyGraph.resources.flatMap((resource) => {
        const logicalId = getResourceId(resource.manifest);
        return logicalId ? [[logicalId, resource.manifest] as const] : [];
      })
    );
    const capturedSensitiveBindings: Record<string, unknown> = {};
    const mergeSensitiveBindings = (
      incoming: Readonly<Record<string, unknown>>,
      context: string
    ): void => {
      for (const [binding, bindingValue] of Object.entries(incoming)) {
        if (
          Object.hasOwn(capturedSensitiveBindings, binding) &&
          !Object.is(capturedSensitiveBindings[binding], bindingValue)
        ) {
          throw new TypeKroError(
            `Sensitive binding ${binding} resolved to conflicting values while ${context}.`,
            'DIRECT_SENSITIVE_BINDING_CONFLICT',
            { binding }
          );
        }
        capturedSensitiveBindings[binding] = bindingValue;
      }
    };
    for (const artifact of artifacts.resources) {
      if (!artifact.desired) continue;
      const sourceNodeId = artifact.sourceNodeId ?? artifact.id;
      const concrete = runtimeResources[sourceNodeId];
      if (!concrete) continue;
      mergeSensitiveBindings(
        collectPlanValueSensitiveBindings(
          artifact.desired,
          concrete,
          `$.resources.${artifact.id}.desired`
        ),
        `capturing direct artifact ${artifact.id}`
      );
    }
    let effectiveSensitiveBindings: Readonly<Record<string, unknown>> = {
      ...capturedSensitiveBindings,
    };
    if (options.sensitiveBindings) {
      mergeSensitiveBindings(options.sensitiveBindings, 'applying direct materialization inputs');
      effectiveSensitiveBindings = { ...capturedSensitiveBindings };
    }
    if (options.staticYamlOptions) {
      const requiredBindings = new Set<string>();
      let containsSensitiveValue = false;
      for (const artifact of artifacts.resources) {
        for (const value of directArtifactPlanValues(artifact)) {
          planValueSensitiveBindingNames(value).forEach((binding) => requiredBindings.add(binding));
          containsSensitiveValue ||= planValueContainsSensitiveValue(value);
        }
      }
      effectiveSensitiveBindings = resolveStaticYamlSensitiveBindings(
        [...requiredBindings],
        capturedSensitiveBindings,
        options.staticYamlOptions,
        `Direct factory ${this.name} YAML`,
        containsSensitiveValue
      );
    }
    const legacyGraphIdBySourceNodeId = new Map(
      legacyGraph.resources.flatMap(({ id, manifest }) => {
        const sourceNodeId = getResourceId(manifest);
        return sourceNodeId ? ([[sourceNodeId, id]] as const) : [];
      })
    );
    const graphIdsByArtifactId = Object.fromEntries(
      artifacts.resources.flatMap((artifact) => {
        const graphId = legacyGraphIdBySourceNodeId.get(artifact.sourceNodeId ?? artifact.id);
        return graphId ? ([[artifact.id, graphId]] as const) : [];
      })
    );
    const readinessEvaluators = Object.fromEntries([
      ...legacyGraph.resources.flatMap(({ id, manifest }) => {
        const evaluator = getReadinessEvaluator(manifest);
        const resourceId = getResourceId(manifest);
        if (!evaluator) return [];
        return [...new Set([id, resourceId].filter((value): value is string => !!value))].map(
          (value) => [`readiness:${value}`, evaluator] as const
        );
      }),
      ...Object.entries(capture.ir.resources).flatMap(([logicalId, manifest]) => {
        const evaluator = getReadinessEvaluator(manifest);
        const resourceId = getResourceId(manifest);
        if (!evaluator) return [];
        return [
          ...new Set([logicalId, resourceId].filter((value): value is string => !!value)),
        ].map((value) => [`readiness:${value}`, evaluator] as const);
      }),
    ]);
    return {
      artifacts,
      graph: directArtifactPlanToResourceGraph(artifacts, {
        instanceName: instanceNameOverride ?? this.generateInstanceName(spec),
        graphName: legacyGraph.name,
        graphIdsByArtifactId,
        spec,
        ...(Object.keys(effectiveSensitiveBindings).length > 0
          ? { sensitive: effectiveSensitiveBindings }
          : {}),
        ...(placeholderArtifactOutputs ? { artifactOutputs: placeholderArtifactOutputs } : {}),
        runtimeResources,
        readinessEvaluators,
        resolveReadinessStrategy: resolvePortableReadinessStrategy,
        // Existing singleton ownership is already reconciled before this graph
        // executes. Keep compiler-generated owner operations out of the app graph.
        includeSupportingArtifacts: false,
      }),
    };
  }

  private getArtifactApplyPolicy(): ArtifactApplyPolicy {
    if (this.factoryOptions.applyPolicy) return this.factoryOptions.applyPolicy;
    return {
      strategy: 'create-or-patch',
      existingResource: 'patch',
      immutableFieldPolicy: 'fail',
    };
  }

  /**
   * Legacy composition materializer retained as the capture frontend while the
   * semantic planner is built from current authoring machinery. Executors must
   * call createResourceGraphForInstance(), not this method.
   *
   * @internal
   */
  public createLegacyResourceGraphForInstance(
    spec: TSpec,
    instanceNameOverride?: string
  ): DeploymentResourceGraph {
    const dependencyResolver = new DependencyResolver();
    const resolvedResources = applyAspects(this.resolveResourcesForSpec(spec), {
      mode: 'direct',
      aspects: this.factoryOptions.aspects ?? [],
    });

    const instanceName = instanceNameOverride ?? this.generateInstanceName(spec);
    const resourceArray = Object.values(resolvedResources).map((resource, index) => {
      this.logger.debug('Processing resource for ID generation', {
        index,
        resourceId: resource.id,
        resourceKind: resource.kind,
        hasId: !!resource.id,
        resourceKeys: Object.keys(resource),
      });
      const baseId = `${instanceName}-resource-${index}-${resource.id || resource.kind?.toLowerCase() || 'unknown'}`;
      const finalId = toCamelCase(baseId);
      this.logger.debug('Generated resource ID', {
        index,
        originalId: resource.id,
        resourceKind: resource.kind,
        baseId,
        finalId,
      });
      const resourceWithId = {
        ...resource,
        id: finalId,
      };

      // Preserve resource metadata from the original resource to the spread copy
      // The WeakMap-based copyResourceMetadata replaces manual Object.defineProperty calls
      copyResourceMetadata(resource, resourceWithId);

      // Also check proxy 'id' as fallback for the original resource key
      const originalResourceId = getResourceId(resource);
      const resourceIdFromProxy = resource.id;
      const effectiveOriginalId = originalResourceId || resourceIdFromProxy;

      this.logger.debug('Checking resourceId preservation', {
        originalResourceId,
        resourceIdFromProxy,
        effectiveOriginalId,
        hasOriginalResourceId: !!originalResourceId,
        hasResourceIdFromProxy: !!resourceIdFromProxy,
      });

      if (effectiveOriginalId) {
        setResourceId(resourceWithId, effectiveOriginalId);
        this.logger.debug('Preserved resourceId on resource', {
          originalResourceId: effectiveOriginalId,
          newId: finalId,
        });
      }

      return resourceWithId;
    });

    // Convert to DeployableK8sResource format expected by dependency resolver
    const deployableResources = resourceArray as DeployableK8sResource<
      Enhanced<unknown, unknown>
    >[];
    const knownExternalResourceIds = new Set(
      Object.entries(this.resolvedResourceKeysForHydration ?? {}).flatMap(
        ([captureId, resource]) =>
          Reflect.get(resource, '__externalRef') === true
            ? [captureId, getResourceId(resource)].filter((id): id is string => !!id)
            : []
      )
    );
    const dependencyGraph = dependencyResolver.buildDependencyGraph(deployableResources, {
      knownExternalResourceIds,
    });

    // Create resources in the format expected by DirectDeploymentEngine
    const formattedResources = deployableResources.map((resource) => ({
      id: resource.id, // Already prefixed with instance name above
      manifest: resource,
    }));

    return {
      name: `${this.name}-instance`,
      resources: formattedResources,
      dependencyGraph,
    };
  }

  /**
   * Emit this composition's resolved resources as declarative alchemy **v2** resources — one
   * {@link AlchemyResourceDeclaration} per Kubernetes resource (matching the v1 integration's
   * per-resource state granularity), topologically ordered with `dependsOn` wired from the
   * composition's dependency graph. The v2 analog of the removed imperative direct-mode alchemy
   * deploy. Instantiate them with `materializeAlchemyResources(KroResource, …)`, which turns
   * `dependsOn` into alchemy `Output` edges so (a) each resource deploys only after the resources
   * it references and (b) each reconcile resolves its cross-resource `KubernetesRef`s against those
   * dependencies' live state before applying.
   */
  async toAlchemyResources(
    spec: TSpec,
    opts?: { instanceNameOverride?: string; singletonSpecFingerprint?: string }
  ): Promise<AlchemyResourceDeclaration[]> {
    const singletonDeclarations = await this.singletonAlchemyDeclarations(spec);
    const execution = this.createArtifactExecutionForInstance(spec, opts?.instanceNameOverride, {
      preserveArtifactOutputs: true,
      ...(opts?.singletonSpecFingerprint
        ? { singletonSpecFingerprint: opts.singletonSpecFingerprint }
        : {}),
    });
    this.assertExecutionCapabilities(execution, { host: 'alchemy', output: 'live' });
    const graph = execution.graph;
    const persistence =
      this.factoryOptions.alchemyKubeConfig ??
      (this.factoryOptions.kubeConfig === undefined
        ? { source: { kind: 'default' as const } }
        : undefined);
    const kubeConfig =
      this.factoryOptions.kubeConfig ??
      (persistence?.source ? undefined : this.getClientProvider().getKubeConfig());
    const kubeConfigOptions = extractSerializableKubeConfigOptions(kubeConfig, {
      ...(this.factoryOptions.skipTLSVerify === true ? { skipTLSVerifyOverride: true } : {}),
      ...(persistence ? { persistence } : {}),
    });

    // Per graph node: its alchemy resource id (for `dependsOn` / `KroResource` id) and logical id
    // (what sibling `KubernetesRef`s + the resolver match on — the original composition id).
    interface Node {
      resource: Enhanced<unknown, unknown>;
      alchemyId: string;
      logicalId: string;
    }
    const byGraphId = new Map<string, Node>();
    const artifactByLogicalId = new Map(
      execution.artifacts?.resources.map((artifact) => [
        artifact.sourceNodeId ?? artifact.id,
        artifact,
      ]) ?? []
    );
    const executionArtifacts = execution.artifacts;
    const materializationByArtifactId = new Map(
      executionArtifacts?.resources.map((artifact) => [
        artifact.id,
        createDirectArtifactExecutionMaterialization(executionArtifacts, artifact.id, { spec }),
      ]) ?? []
    );
    const hasSensitiveBindings = [...materializationByArtifactId.values()].some(
      (materialization) => Object.keys(materialization.sensitiveBindings).length > 0
    );
    const hasSecretPayload = graph.resources.some(
      ({ manifest }) =>
        manifest.kind === 'Secret' &&
        (Reflect.has(manifest, 'data') || Reflect.has(manifest, 'stringData'))
    );
    const Redacted =
      hasSensitiveBindings || hasSecretPayload ? await import('effect/Redacted') : undefined;
    const nodeCandidates = graph.resources.map(({ id: graphId, manifest }) => {
      const resource = ensureReadinessEvaluator(manifest as Enhanced<unknown, unknown>);
      const identity = directAlchemyKubernetesIdentity(resource, this.namespace);
      return {
        graphId,
        resource,
        identity,
        legacyAlchemyId: createAlchemyResourceId(resource, this.namespace),
        logicalId: getResourceId(manifest as Enhanced<unknown, unknown>) ?? graphId,
      };
    });
    const candidateByKubernetesIdentity = new Map<
      string,
      (typeof nodeCandidates)[number]
    >();
    for (const candidate of nodeCandidates) {
      const existing = candidateByKubernetesIdentity.get(candidate.identity.key);
      if (existing) {
        throw new ValidationError(
          `Direct Alchemy materialization cannot assign two graph nodes to the same Kubernetes ` +
            `object ${candidate.identity.display}: ${existing.logicalId} and ${candidate.logicalId}. ` +
            `Each live Kubernetes identity must have exactly one Alchemy owner.`,
          candidate.resource.kind,
          candidate.logicalId,
          'metadata'
        );
      }
      candidateByKubernetesIdentity.set(candidate.identity.key, candidate);
    }
    const legacyAlchemyIdCounts = new Map<string, number>();
    for (const candidate of nodeCandidates) {
      legacyAlchemyIdCounts.set(
        candidate.legacyAlchemyId,
        (legacyAlchemyIdCounts.get(candidate.legacyAlchemyId) ?? 0) + 1
      );
    }
    const assignedAlchemyIds = new Set<string>();
    for (const candidate of nodeCandidates) {
      const alchemyId =
        legacyAlchemyIdCounts.get(candidate.legacyAlchemyId) === 1
          ? candidate.legacyAlchemyId
          : disambiguatedAlchemyResourceId(
              candidate.legacyAlchemyId,
              candidate.identity.key
            );
      if (assignedAlchemyIds.has(alchemyId)) {
        throw new ValidationError(
          `Direct Alchemy materialization could not derive a unique declaration ID for ` +
            `${candidate.resource.apiVersion}/${candidate.resource.kind} ` +
            `${candidate.resource.metadata?.namespace ? `${candidate.resource.metadata.namespace}/` : ''}` +
            `${candidate.resource.metadata?.name ?? '<unnamed>'}. Give each graph resource a distinct explicit id.`,
          candidate.resource.kind,
          candidate.logicalId,
          'id'
        );
      }
      assignedAlchemyIds.add(alchemyId);
      byGraphId.set(candidate.graphId, {
        resource: candidate.resource,
        alchemyId,
        logicalId: candidate.logicalId,
      });
    }

    const waitForReady = this.factoryOptions.waitForReady ?? false;
    const timeout = this.factoryOptions.timeout;

    // The semantic planner records typed output/existence/readiness/ownership edges, and the
    // direct artifact adapter lowers those edges into this graph. Alchemy must consume that
    // authoritative ordering rather than reinterpreting serialized manifest strings.
    const ordered = graph.dependencyGraph.getTopologicalOrder();

    const applicationDeclarations = ordered.flatMap((graphId) => {
      const node = byGraphId.get(graphId);
      if (!node) return [];
      const artifact = artifactByLogicalId.get(node.logicalId);
      const materialization = artifact ? materializationByArtifactId.get(artifact.id) : undefined;
      const artifactOutputUses = materialization
        ? collectArtifactOutputUses(materialization.record.artifact)
        : [];
      const artifactRequirementIds = new Set(artifactOutputUses.map((use) => use.requirementId));
      const artifactRequirements =
        executionArtifacts?.artifactRequirements.filter((requirement) =>
          artifactRequirementIds.has(requirement.id)
        ) ?? [];
      const declarationArtifactOutputs = Object.fromEntries(
        artifactRequirements.map((requirement) => [
          requirement.id,
          Object.fromEntries(
            requirement.outputs.map((output) => [
              output,
              `__typekro_artifact_${encodeURIComponent(requirement.id)}_${encodeURIComponent(output)}__`,
            ])
          ),
        ])
      );
      const sensitiveBindings =
        materialization && Redacted
          ? Object.fromEntries(
              Object.entries(materialization.sensitiveBindings).map(([binding, value]) => [
                binding,
                Redacted.make(value),
              ])
            )
          : undefined;
      const strategy = materialization?.record.artifact.readiness.strategy;
      const evaluator = getReadinessEvaluator(node.resource);
      const readinessEvaluators =
        strategy?.kind === 'runtime-binding' && evaluator
          ? { [strategy.binding]: evaluator }
          : undefined;
      const declarationResource =
        materialization &&
        ((sensitiveBindings && Object.keys(sensitiveBindings).length > 0) ||
          artifactOutputUses.length > 0)
          ? (materializeDirectArtifactManifest(
              materialization.record.artifact,
              {
                instanceName: opts?.instanceNameOverride ?? this.generateInstanceName(spec),
                ...(sensitiveBindings ? { sensitive: sensitiveBindings } : {}),
                ...(artifactOutputUses.length > 0
                  ? { artifactOutputs: declarationArtifactOutputs }
                  : {}),
                runtimeResources: { [node.logicalId]: node.resource },
                ...(readinessEvaluators ? { readinessEvaluators } : {}),
                resolveReadinessStrategy: resolvePortableReadinessStrategy,
              },
              getResourceId(node.resource) ?? node.logicalId,
              node.logicalId
            ) as Enhanced<unknown, unknown>)
          : Redacted && node.resource.kind === 'Secret'
            ? ({
                ...node.resource,
                ...(Reflect.has(node.resource, 'data')
                  ? {
                      data: Object.fromEntries(
                        Object.entries(
                          (Reflect.get(node.resource, 'data') as Record<string, unknown>) ?? {}
                        ).map(([key, value]) => [key, Redacted.make(value)])
                      ),
                    }
                  : {}),
                ...(Reflect.has(node.resource, 'stringData')
                  ? {
                      stringData: Object.fromEntries(
                        Object.entries(
                          (Reflect.get(node.resource, 'stringData') as Record<string, unknown>) ??
                            {}
                        ).map(([key, value]) => [key, Redacted.make(value)])
                      ),
                    }
                  : {}),
              } as Enhanced<unknown, unknown>)
            : node.resource;
      if (declarationResource !== node.resource) {
        copyResourceMetadata(node.resource, declarationResource);
      }
      const dependsOn = graph.dependencyGraph
        .getDependencies(graphId)
        .map((dependencyGraphId) => byGraphId.get(dependencyGraphId)?.alchemyId)
        .filter((id): id is string => id !== undefined);
      return {
        id: node.alchemyId,
        dependsOn,
        ...(artifactRequirements.length > 0 ? { artifactRequirements } : {}),
        ...(artifactOutputUses.length > 0 ? { artifactOutputUses } : {}),
        props: {
          resource: declarationResource,
          resourceId: node.logicalId,
          ...(materialization
            ? {
                artifactExecutionRecord: encodeDirectArtifactExecutionRecord(
                  materialization.record
                ),
                ...(sensitiveBindings && Object.keys(sensitiveBindings).length > 0
                  ? { sensitiveBindings }
                  : {}),
                ...(artifactRequirements.length > 0 ? { artifactRequirements } : {}),
                ...(artifactOutputUses.length > 0 ? { artifactOutputUses } : {}),
              }
            : {}),
          // Alchemy persists this field as the deployed Kubernetes identity
          // namespace. A direct composition may author resources outside the
          // factory's default namespace, so carrying only `this.namespace`
          // makes drift reconciliation compare against the wrong identity.
          // Match the KRO artifact emitter: prefer the concrete manifest
          // namespace and use the factory namespace only as its default.
          namespace: declarationResource.metadata.namespace ?? this.namespace,
          deploymentStrategy: 'direct' as const,
          kubeConfigOptions,
          options: { waitForReady, ...(timeout !== undefined && { timeout }) },
        },
      };
    });
    if (singletonDeclarations.length === 0) return applicationDeclarations;

    const singletonIds = singletonDeclarations.map((declaration) => declaration.id);
    const applicationIds = new Set(applicationDeclarations.map((declaration) => declaration.id));
    const collision = singletonDeclarations.find((declaration) =>
      applicationIds.has(declaration.id)
    );
    if (collision) {
      throw new ValidationError(
        `Direct Alchemy singleton declaration ${collision.id} collides with an application resource. ` +
          `Singleton owners and consumers must have distinct declaration identities.`,
        this.schemaDefinition.kind,
        this.name,
        'alchemy'
      );
    }
    return [
      ...singletonDeclarations,
      ...applicationDeclarations.map((declaration) => ({
        ...declaration,
        // Singleton owners gate Alchemy scheduling, but are not canonical dependencies of every
        // consumer Kubernetes operation. Keeping this edge separate preserves the compiled direct
        // execution record while still waiting for singleton readiness before reconciliation.
        schedulingDependsOn: singletonIds,
      })),
    ];
  }

  private async singletonAlchemyDeclarations(
    spec: TSpec
  ): Promise<AlchemyResourceDeclaration[]> {
    const definitions = this.discoverSingletonDefinitions(spec);
    if (definitions.length === 0) return [];

    const declarations = new Map<string, AlchemyResourceDeclaration>();
    for (const definition of definitions) {
      const ownerFactory = definition.composition.factory('direct', {
        namespace: definition.registryNamespace,
        waitForReady: true,
        ...(this.factoryOptions.timeout !== undefined
          ? { timeout: this.factoryOptions.timeout }
          : {}),
        ...(this.factoryOptions.kubeConfig !== undefined
          ? { kubeConfig: this.factoryOptions.kubeConfig }
          : {}),
        ...(this.factoryOptions.alchemyKubeConfig !== undefined
          ? { alchemyKubeConfig: this.factoryOptions.alchemyKubeConfig }
          : {}),
        ...(this.factoryOptions.skipTLSVerify !== undefined
          ? { skipTLSVerify: this.factoryOptions.skipTLSVerify }
          : {}),
        ...(this.factoryOptions.applyPolicy !== undefined
          ? { applyPolicy: this.factoryOptions.applyPolicy }
          : {}),
      }) as DirectResourceFactory<KroCompatibleType, KroCompatibleType>;
      const ownerDeclarations = await ownerFactory.toAlchemyResources(definition.spec, {
        instanceNameOverride: getSingletonInstanceName(definition.id),
        singletonSpecFingerprint: singletonSpecFingerprintAnnotationValue(
          definition.specFingerprint
        ),
      });
      for (const declaration of ownerDeclarations) {
        const retained = {
          ...declaration,
          props: { ...declaration.props, retain: true },
        };
        const existing = declarations.get(retained.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(retained)) {
          throw new ValidationError(
            `Direct Alchemy singleton declarations disagree on ${retained.id}. ` +
              `A shared singleton identity must resolve to one canonical resource graph.`,
            this.schemaDefinition.kind,
            definition.id,
            'alchemy'
          );
        }
        declarations.set(retained.id, retained);
      }
    }
    return [...declarations.values()];
  }

  /**
   * Resolve resources for a specific spec
   * This uses composition re-execution when available, or falls back to reference resolution
   */
  private reExecutedStatus: TStatus | null = null; // Store the re-executed status

  private resolveResourcesForSpec(spec: TSpec): Record<string, KubernetesResource> {
    // Reset the re-executed status
    this.reExecutedStatus = null;
    this.resolvedResourceKeysForHydration = undefined;
    this.resolvedClosuresForDeployment = undefined;

    // Check if we have composition re-execution parameters
    if (this.factoryOptions.compositionFn && this.factoryOptions.compositionDefinition) {
      this.logger.debug('Re-executing composition with actual spec values', {
        hasCompositionFn: !!this.factoryOptions.compositionFn,
        hasCompositionDefinition: !!this.factoryOptions.compositionDefinition,
      });

      try {
        // Re-execute the composition with actual spec values
        const reExecutionResult = this.reExecuteCompositionWithActualValues(spec);
        if (reExecutionResult) {
          this.logger.debug('Successfully re-executed composition with actual values', {
            resourceCount: Object.keys(reExecutionResult.resources).length,
            statusFields: reExecutionResult.status ? Object.keys(reExecutionResult.status) : [],
          });

          // Store the re-executed status for later use
          this.reExecutedStatus = reExecutionResult.status;
          this.resolvedResourceKeysForHydration = reExecutionResult.resourceKeysForHydration;
          this.resolvedClosuresForDeployment = reExecutionResult.closures;

          return reExecutionResult.resources;
        }
      } catch (error: unknown) {
        this.logger.error(
          'Failed to re-execute composition with actual spec values',
          ensureError(error)
        );
        throw error;
      }
    }

    // Fall back to the original reference resolution approach
    this.logger.debug(
      'Using reference resolution approach (no composition re-execution available)'
    );
    const resolvedResources: Record<string, KubernetesResource> = {};
    for (const [key, resource] of Object.entries(this.resources)) {
      try {
        // CORRECTED: Go directly from the resource template (with proxy objects)
        // to resolving the values from the provided spec.
        const resolvedResource = this.resolveSchemaReferencesToValues(resource, spec);
        resolvedResources[key] = resolvedResource as KubernetesResource;
      } catch (error: unknown) {
        // If resolution fails, use the original resource
        this.logger.error('Failed to resolve references for resource', ensureError(error));
        resolvedResources[key] = resource;
      }
    }

    this.resolvedResourceKeysForHydration = resolvedResources;
    this.resolvedClosuresForDeployment = this.closures;

    return resolvedResources;
  }

  /**
   * Re-execute the composition function with actual spec values
   * This provides actual values instead of proxy functions to the composition
   */
  private reExecuteCompositionWithActualValues(spec: TSpec): {
    resources: Record<string, KubernetesResource>;
    closures: Record<string, DeploymentClosure>;
    resourceKeysForHydration: Record<string, KubernetesResource>;
    status: TStatus;
  } | null {
    if (!this.factoryOptions.compositionFn || !this.factoryOptions.compositionDefinition) {
      return null;
    }

    try {
      this.logger.debug('Re-executing composition with actual spec values');

      // Composition context utilities are now statically imported from core

      // Create a new composition context for re-execution.
      // Enable ID deduplication so forEach loops that create multiple resources
      // with the same id (e.g., 'regionDep') get unique keys ('regionDep', 'regionDep-1', etc.)
      const reExecutionContext = createCompositionContext('re-execution', {
        deduplicateIds: true,
        isReExecution: true,
      });

      // Execute the composition function within the new context and capture both resources and status
      const { resources, status } = runWithCompositionContext(reExecutionContext, () => {
        // Execute the composition function with actual spec values
        const computedStatus = this.factoryOptions.compositionFn?.(spec);
        return {
          resources: reExecutionContext.resources,
          status: computedStatus,
        };
      });

      this.logger.debug('Composition re-execution completed', {
        capturedResourceCount: Object.keys(resources).length,
        resourceIds: Object.keys(resources),
        statusFields: status ? Object.keys(status) : [],
      });

      // Convert Enhanced resources back to KubernetesResource format.
      // Filter out externalRef resources — they already exist in the cluster
      // and should NOT be deployed in direct mode.
      const kubernetesResources: Record<string, KubernetesResource> = {};
      const resourceKeysForHydration: Record<string, KubernetesResource> = {};
      for (const [id, enhanced] of Object.entries(resources)) {
        const includeWhen = getIncludeWhen(enhanced as object);
        if (includeWhen?.some((condition) => condition === false)) {
          this.logger.debug('Skipping resource disabled by a concrete includeWhen condition', {
            id,
          });
          continue;
        }
        const kubernetesResource = this.extractKubernetesResourceFromEnhanced(
          enhanced as Enhanced<unknown, unknown>
        );

        // Skip external references — they're not managed by us
        if (Reflect.get(enhanced, '__externalRef') === true) {
          this.logger.debug('Skipping externalRef resource in direct mode', { id });
          Reflect.set(kubernetesResource, '__externalRef', true);
          resourceKeysForHydration[id] = kubernetesResource;
          continue;
        }

        kubernetesResources[id] = kubernetesResource;
        resourceKeysForHydration[id] = kubernetesResource;
      }

      // The status returned from re-execution should preserve CEL expressions
      // Only spec-based values should be resolved, resource-based CEL expressions should remain
      return {
        resources: kubernetesResources,
        closures: reExecutionContext.closures,
        resourceKeysForHydration,
        status: status as TStatus,
      };
    } catch (error: unknown) {
      this.logger.error('Failed to re-execute composition', ensureError(error));
      throw error;
    }
  }

  /**
   * Get the re-executed status if available
   * This is used by the deployment strategy to use computed status instead of calling status builder with proxy functions
   */
  public getReExecutedStatus(): TStatus | null {
    return this.reExecutedStatus;
  }

  public getResourceKeysForHydration(): Record<string, KubernetesResource> | undefined {
    return this.resolvedResourceKeysForHydration ?? this.resources;
  }

  public getClosuresForDeployment(): Record<string, DeploymentClosure> {
    return this.resolvedClosuresForDeployment ?? this.closures;
  }

  private reExecuteSingletonStatus(
    singletonDefinition: SingletonDefinitionRecord,
    liveStatusMap: Map<string, Record<string, unknown>>
  ): Record<string, unknown> | undefined {
    const compositionFn = (
      singletonDefinition.composition as unknown as {
        _compositionFn?: (spec: unknown) => unknown;
      }
    )._compositionFn;

    if (!compositionFn) {
      return undefined;
    }

    const singletonContext = createCompositionContext('singleton-re-execution', {
      deduplicateIds: true,
      isReExecution: true,
    });
    singletonContext.liveStatusMap = liveStatusMap;

    const status = runWithCompositionContext(singletonContext, () =>
      compositionFn(singletonDefinition.spec)
    );

    if (status && typeof status === 'object' && !Array.isArray(status)) {
      return status as Record<string, unknown>;
    }

    return undefined;
  }

  /**
   * Re-execute the composition with live status data from deployed resources.
   *
   * After deployment completes, we have live status for each resource.
   * This method re-runs the composition function with that live data injected
   * into the proxy system, so status comparisons like
   * `database.status.readyInstances >= 1` evaluate correctly.
   *
   * @param spec - The original spec
   * @param liveStatusMap - Map of resource ID to live status object
   * @returns Re-executed status with live data, or null on failure
   */
  public reExecuteWithLiveStatus(
    spec: TSpec,
    liveStatusMap: Map<string, Record<string, unknown>>
  ): TStatus | null {
    if (!this.factoryOptions.compositionFn) return null;

    try {
      this.logger.debug('Re-executing composition with live status data', {
        liveResourceCount: liveStatusMap.size,
        resourceIds: [...liveStatusMap.keys()],
      });

      // Phase 1: Probe execution to discover nested composition IDs.
      // Nested compositions generate IDs like "inngest-bootstrap1" via the
      // composition instance counter. We need to discover these IDs so we can
      // synthesize status entries from child resources' live data.
      const probeContext = createCompositionContext('re-execution-probe', {
        deduplicateIds: true,
        isReExecution: true,
      });
      probeContext.liveStatusMap = liveStatusMap;

      runWithCompositionContext(probeContext, () => {
        this.factoryOptions.compositionFn?.(spec);
      });

      // Synthesize status for nested compositions from deployment readiness.
      //
      // Every deployed resource has a readiness status from its factory-provided
      // evaluator (the deployment engine confirmed each one via waitForReady).
      // Nested compositions are "ready" when ALL their children are ready.
      //
      // This uses synthesizeNestedCompositionStatus which is shared between
      // direct and KRO deployment strategies — it only depends on the probe
      // context's resource keys and the liveStatusMap's deployed resource keys.
      const enrichedMap = synthesizeNestedCompositionStatus(
        probeContext.resources,
        liveStatusMap,
        this.logger,
        probeContext.nestedCompositionIds,
        probeContext.nestedStatusSnapshots
      );

      // Framework invariant: direct-mode re-execution must preserve the same
      // cross-composition semantics as KRO-mode serialization. If a user writes
      // `const stack = nestedComp(...); return { ready: stack.status.ready && ... }`,
      // TypeKro must resolve that alias in the framework rather than pushing
      // CEL-specific workarounds into composition code.
      const aliasTargets = buildNestedCompositionAliasTargets(
        this.factoryOptions.compositionFn.toString(),
        probeContext.nestedCompositionIds
      );
      for (const [aliasName, baseId] of Object.entries(aliasTargets)) {
        const synthesizedStatus = enrichedMap.get(baseId);
        if (synthesizedStatus && !enrichedMap.has(aliasName)) {
          enrichedMap.set(aliasName, synthesizedStatus);
        }
      }

      const singletonDefinitions = new Map<string, SingletonDefinitionRecord>();
      for (const definition of this.singletonDefinitions) {
        singletonDefinitions.set(definition.key, definition);
      }
      for (const definition of probeContext.singletonDefinitions?.values() ?? []) {
        singletonDefinitions.set(definition.key, definition);
      }

      for (const definition of singletonDefinitions.values()) {
        const singletonResourceId = getSingletonResourceId(definition.key);
        if (enrichedMap.has(singletonResourceId)) {
          continue;
        }

        const singletonStatus =
          this.singletonOwnerStatuses.get(singletonResourceId) ??
          this.reExecuteSingletonStatus(definition, liveStatusMap);
        if (singletonStatus) {
          enrichedMap.set(singletonResourceId, singletonStatus);
        }
      }

      // Phase 2: Real execution with enriched live status map
      const reExecutionContext = createCompositionContext('re-execution', {
        deduplicateIds: true,
        isReExecution: true,
      });
      reExecutionContext.liveStatusMap = enrichedMap;

      const { status } = runWithCompositionContext(reExecutionContext, () => {
        const computedStatus = this.factoryOptions.compositionFn?.(spec);
        return { status: computedStatus };
      });

      this.logger.debug('Live status re-execution completed', {
        statusFields: status ? Object.keys(status) : [],
      });

      return status as TStatus;
    } catch (error: unknown) {
      this.logger.warn('Failed to re-execute composition with live status', {
        error: ensureError(error).message,
      });
      return null;
    }
  }

  /**
   * Deep resolve any KubernetesRef objects in a value to their string representation
   * This is needed because when composition functions build objects with schema proxy values,
   * those values are KubernetesRef objects that need to be converted to actual values or
   * placeholder strings for serialization.
   *
   * For schema references (resourceId === '__schema__'), we return a placeholder that will
   * be resolved later when actual spec values are available.
   *
   * For resource references, we return a CEL expression placeholder.
   */
  private deepResolveKubernetesRefs(value: unknown, path = 'root'): unknown {
    // Handle KubernetesRef objects
    if (isKubernetesRef(value)) {
      this.logger.trace('Found KubernetesRef in value', {
        path,
        resourceId: value.resourceId,
        fieldPath: value.fieldPath,
      });

      // For schema references, return a marker that can be resolved later
      if (value.resourceId === '__schema__') {
        return `__KUBERNETES_REF___schema___${value.fieldPath}__`;
      }

      // For resource references, return a CEL expression placeholder
      return `__KUBERNETES_REF_${value.resourceId}_${value.fieldPath}__`;
    }

    // Handle CelExpression objects
    if (isCelExpression(value)) {
      this.logger.trace('Found CelExpression in value', {
        path,
        expression: value.expression,
      });
      return value.expression;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((item, index) => this.deepResolveKubernetesRefs(item, `${path}[${index}]`));
    }

    // Handle objects
    if (value !== null && typeof value === 'object') {
      const resolved: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        resolved[key] = this.deepResolveKubernetesRefs(val, `${path}.${key}`);
      }
      return resolved;
    }

    // Return primitives as-is
    return value;
  }

  /**
   * Extract the underlying Kubernetes resource from an Enhanced proxy
   *
   * IMPORTANT: This method preserves ALL enumerable properties from the Enhanced resource,
   * not just standard Kubernetes fields. This is critical for resources like Secret (data),
   * ConfigMap (data, binaryData), RBAC resources (rules, roleRef, subjects), etc.
   *
   * It also resolves any KubernetesRef objects in the resource properties to their
   * string representations, which is critical for HelmRelease values that may contain
   * schema proxy references.
   */
  private extractKubernetesResourceFromEnhanced(
    enhanced: Enhanced<unknown, unknown>
  ): KubernetesResource {
    // Start with required Kubernetes resource structure
    const resource: KubernetesResource = {
      apiVersion: enhanced.apiVersion,
      kind: enhanced.kind,
      metadata: this.deepResolveKubernetesRefs(enhanced.metadata) as KubernetesResource['metadata'],
    };

    // Preserve ALL other enumerable properties from the Enhanced resource
    // This ensures resource-specific fields (data, rules, roleRef, etc.) are not lost
    for (const [key, value] of Object.entries(enhanced)) {
      // Skip the core fields we've already set
      if (key === 'apiVersion' || key === 'kind' || key === 'metadata') {
        continue;
      }

      // Include all other properties (spec, status, data, rules, etc.)
      // Deep resolve any KubernetesRef objects in the value
      if (value !== undefined && value !== null) {
        Reflect.set(resource, key, this.deepResolveKubernetesRefs(value));
      }
    }

    // Preserve the non-enumerable id field if it exists (needed for resource mapping in CEL resolution)
    if (enhanced.id) {
      resource.id = enhanced.id;
    }

    // Preserve the non-enumerable readinessEvaluator if it exists.
    // Preserve resource metadata (resourceId, readinessEvaluator, etc.) from Enhanced proxy
    copyResourceMetadata(enhanced, resource);

    return resource;
  }

  /**
   * Traverse a spec object using dot-separated path parts, returning the resolved value.
   * Shared by both KubernetesRef resolution (Case 1) and template marker resolution (Case 4).
   */
  private traverseSpec(
    spec: TSpec,
    pathParts: string[],
    logPath: string
  ): { found: true; value: unknown } | { found: false } {
    let currentValue: unknown = spec;
    this.logger.trace('Traversing spec with path parts', { pathParts });
    for (const part of pathParts) {
      if (currentValue && typeof currentValue === 'object' && part in currentValue) {
        currentValue = (currentValue as Record<string, unknown>)[part];
      } else {
        this.logger.warn('Path part not found in spec', {
          path: logPath,
          part,
          availableKeys:
            currentValue && typeof currentValue === 'object' ? Object.keys(currentValue) : [],
        });
        return { found: false };
      }
    }
    return { found: true, value: currentValue };
  }

  private resolveSpecPathValue(
    spec: TSpec,
    specPath: string,
    logPath: string
  ): { found: true; value: unknown } | { found: false } {
    const pathParts = specPath.split('.').filter(Boolean);
    return this.traverseSpec(spec, pathParts, logPath);
  }

  private stringifyCelFallbackValue(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  }

  /**
   * Resolve schema references and CEL expressions to actual values for direct deployment.
   * This is the final, corrected version that handles both direct proxies and Cel.expr wrappers.
   */
  private resolveSchemaReferencesToValues(resource: unknown, spec: TSpec, path = 'root'): unknown {
    this.logger.trace('Resolving schema references', {
      path,
      type: typeof resource,
      isObject: resource !== null && typeof resource === 'object',
    });

    // Case 1: Handle direct schema proxy objects (e.g., schema.spec.replicas)
    if (isKubernetesRef(resource) && resource.resourceId === '__schema__') {
      this.logger.trace('Found schema KubernetesRef', { path, fieldPath: resource.fieldPath });
      const pathParts = resource.fieldPath.split('.');
      const resolved = this.traverseSpec(spec, pathParts.slice(1), path);
      if (resolved.found) {
        this.logger.trace('Resolved schema KubernetesRef to value', {
          path,
          resolvedValue: resolved.value,
        });
        return resolved.value;
      }
      return resource;
    }

    // Case 2: Handle CelExpression objects (e.g., Cel.expr(schema.spec.name, '-db'))
    if (isCelExpression(resource)) {
      this.logger.trace('Found CEL Expression', { path, expression: resource.expression });
      // The .expression property holds a string like "schema.spec.name-db-config"
      let expressionString = resource.expression;
      const exactSchemaRef = expressionString.match(
        /^schema\.spec\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/
      );
      const exactSpecPath = exactSchemaRef?.[1];
      if (exactSpecPath !== undefined) {
        const resolved = this.resolveSpecPathValue(spec, exactSpecPath, path);
        if (resolved.found) {
          return resolved.value;
        }
      }
      // Use regex to find all `schema.spec.fieldName` placeholders in the string
      // and replace them with the corresponding values from the spec object.
      // The 'g' flag ensures all occurrences are replaced.
      expressionString = expressionString.replace(
        /schema\.spec\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g,
        (_match, specPath) => {
          const resolved = this.resolveSpecPathValue(spec, specPath, path);
          const value = resolved.found ? resolved.value : undefined;
          this.logger.trace('Replacing CEL placeholder', { specPath, value });
          // If the value exists in the spec, convert it to a string for concatenation.
          // Otherwise, keep the original placeholder (though this shouldn't happen in valid cases).

          return value !== undefined ? this.stringifyCelFallbackValue(value) : _match;
        }
      );
      this.logger.trace('Resolved CEL expression to value', {
        path,
        resolvedValue: expressionString,
      });
      // The result is the final, resolved string.
      return expressionString;
    }

    // Case 3: Recursively traverse arrays and plain objects (no changes here)
    if (Array.isArray(resource)) {
      this.logger.trace('Traversing array', { path });
      return resource.map((item, index) =>
        this.resolveSchemaReferencesToValues(item, spec, `${path}[${index}]`)
      );
    }

    if (resource && typeof resource === 'object') {
      this.logger.trace('Traversing object', { path, keys: Object.keys(resource) });
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(resource)) {
        resolved[key] = this.resolveSchemaReferencesToValues(value, spec, `${path}.${key}`);
      }

      // Debug: Check if id field is being preserved
      const resourceRecord = resource as Record<string, unknown>;
      if (path === 'root' && resourceRecord.id) {
        this.logger.debug('Resource ID preservation check', {
          path,
          originalId: resourceRecord.id,
          resolvedId: resolved.id,
          originalKeys: Object.keys(resource),
          resolvedKeys: Object.keys(resolved),
        });
      }

      // Preserve resource metadata (resourceId, readinessEvaluator, etc.) via WeakMap
      if (typeof resource === 'object' && resource !== null) {
        copyResourceMetadata(resource, resolved);
      }

      // FIX: Preserve the id field if it exists (needed for resource mapping in CEL resolution)
      if (resourceRecord.id) {
        this.logger.trace('Preserving resource id field', { path, id: resourceRecord.id });
        resolved.id = resourceRecord.id;
      }

      return resolved;
    }

    // Case 4: Handle strings that contain __KUBERNETES_REF_ markers from template literals
    // These are generated when schema references are used in template literals like `${schema.spec.name}-suffix`
    if (typeof resource === 'string' && resource.includes('__KUBERNETES_REF_')) {
      this.logger.trace('Found string with KubernetesRef markers', { path, value: resource });

      // Replace all __KUBERNETES_REF_ markers with actual values from spec
      // Pattern: __KUBERNETES_REF_{resourceId}_{fieldPath}__
      // For schema: __KUBERNETES_REF___schema___{fieldPath}__
      // The fieldPath for schema refs is like "spec.baseName" or "spec.nested.field"
      const resolvedString = resource.replace(
        new RegExp(KUBERNETES_REF_SCHEMA_MARKER_SOURCE, 'g'),
        (_match, fieldPath) => {
          // fieldPath is like "spec.baseName" - we need to traverse starting from the schema root
          const pathParts = fieldPath.split('.');

          // The first part should be 'spec' or 'status'
          if (pathParts[0] === 'spec') {
            const resolved = this.traverseSpec(spec, pathParts.slice(1), path);
            if (resolved.found) {
              this.logger.trace('Resolved schema marker to value', {
                fieldPath,
                resolvedValue: resolved.value,
              });
              return String(resolved.value);
            }
            return _match; // Keep original marker if path not found
          } else {
            // Status references or other paths - keep as-is for now
            this.logger.trace('Keeping non-spec schema reference marker', {
              fieldPath,
            });
            return _match;
          }
        }
      );

      // Also handle non-schema resource references (keep them as-is for now)
      // Pattern: __KUBERNETES_REF_{resourceId}_{fieldPath}__ where resourceId is not __schema__

      this.logger.trace('Resolved string with markers', {
        path,
        original: resource,
        resolved: resolvedString,
      });
      return resolvedString;
    }

    this.logger.trace('Returning primitive value as-is', { path, value: resource });
    // Return primitives and other types as-is.
    return resource;
  }

  /**
   * Generate instance name from spec
   */
  private generateInstanceName(spec: TSpec): string {
    // Use the imported shared utility
    return generateInstanceName(spec);
  }

  private async ensureTargetNamespace(
    namespace = this.namespace,
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      abortSignal?.throwIfAborted();
      const { createBunCompatibleKubernetesObjectApi } = await import(
        '../kubernetes/bun-api-client.js'
      );
      const k8sApi = createBunCompatibleKubernetesObjectApi(
        this.getClientProvider().getKubeConfig()
      );
      const waitForNamespaceDeletion = async (): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < 120000) {
          abortSignal?.throwIfAborted();
          try {
            const existing = (await k8sApi.read({
              apiVersion: 'v1',
              kind: 'Namespace',
              metadata: { name: namespace },
            })) as { metadata?: { deletionTimestamp?: string | Date } };
            if (!existing.metadata?.deletionTimestamp) {
              return;
            }
          } catch (pollError: unknown) {
            const err = pollError as { statusCode?: number; body?: { code?: number } };
            const code = err.statusCode ?? err.body?.code;
            if (code === 404) {
              return;
            }
            throw pollError;
          }
          await new Promise<void>((resolve, reject) => {
            if (!abortSignal) {
              setTimeout(resolve, 1000);
              return;
            }
            const onAbort = () => {
              clearTimeout(delay);
              reject(
                abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError')
              );
            };
            const delay = setTimeout(() => {
              abortSignal.removeEventListener('abort', onAbort);
              resolve();
            }, 1000);
            if (abortSignal.aborted) {
              onAbort();
              return;
            }
            abortSignal.addEventListener('abort', onAbort, { once: true });
          });
        }
        throw new Error(`Namespace ${namespace} is still terminating after 120000ms`);
      };
      try {
        const existing = (await k8sApi.read({
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: { name: namespace },
        })) as { metadata?: { deletionTimestamp?: string | Date } };
        if (existing.metadata?.deletionTimestamp) {
          await waitForNamespaceDeletion();
        } else {
          return;
        }
      } catch (readError: unknown) {
        const k8sErr = readError as { statusCode?: number; body?: { code?: number } };
        const code = k8sErr.statusCode ?? k8sErr.body?.code;
        if (code !== 404) {
          throw readError;
        }
      }

      try {
        await k8sApi.create({
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: namespace,
            labels: {
              'app.kubernetes.io/managed-by': 'typekro',
            },
          },
        });
      } catch (createError: unknown) {
        const k8sErr = createError as {
          statusCode?: number;
          body?: { code?: number; reason?: string };
          message?: string;
        };
        const code = k8sErr.statusCode ?? k8sErr.body?.code;
        const isNamespaceTerminating =
          k8sErr.body?.reason === 'Forbidden' &&
          k8sErr.message?.includes('NamespaceTerminating') === true;
        if (isNamespaceTerminating) {
          await waitForNamespaceDeletion();
          await k8sApi.create({
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
              name: namespace,
              labels: {
                'app.kubernetes.io/managed-by': 'typekro',
              },
            },
          });
        } else if (code !== 409) {
          throw createError;
        }
      }
    } catch (error: unknown) {
      throw new ResourceGraphFactoryError(
        `Failed to ensure target namespace "${namespace}" exists: ${ensureError(error).message}`,
        this.name,
        'deployment',
        ensureError(error)
      );
    }
  }

  private discoverSingletonDefinitions(spec: TSpec): SingletonDefinitionRecord[] {
    const discoveredSingletons = new Map<string, SingletonDefinitionRecord>();

    if (this.factoryOptions.compositionFn) {
      const singletonContext = createCompositionContext('singleton-owner-discovery');
      runWithCompositionContext(singletonContext, () => {
        this.factoryOptions.compositionFn?.(spec);
      });

      for (const [key, definition] of singletonContext.singletonDefinitions ?? []) {
        discoveredSingletons.set(key, definition);
      }
    }

    for (const definition of this.singletonDefinitions) {
      if (!discoveredSingletons.has(definition.key)) {
        discoveredSingletons.set(definition.key, definition);
      }
    }

    return [...discoveredSingletons.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    );
  }

  private async ensureSingletonOwners(spec: TSpec, operationSignal?: AbortSignal): Promise<void> {
    const discoveredSingletons = this.discoverSingletonDefinitions(spec);
    if (discoveredSingletons.length === 0) return;

    for (const definition of discoveredSingletons) {
      await this.ensureTargetNamespace(definition.registryNamespace, operationSignal);

      const singletonInstanceName = getSingletonInstanceName(definition.id);
      const singletonFactory = definition.composition.factory('direct', {
        namespace: definition.registryNamespace,
        waitForReady: true,
        ...(this.factoryOptions.timeout !== undefined
          ? { timeout: this.factoryOptions.timeout }
          : {}),
        ...(this.factoryOptions.kubeConfig !== undefined
          ? { kubeConfig: this.factoryOptions.kubeConfig }
          : {}),
        ...(this.factoryOptions.skipTLSVerify !== undefined
          ? { skipTLSVerify: this.factoryOptions.skipTLSVerify }
          : {}),
      }) as DirectResourceFactory<KroCompatibleType, KroCompatibleType>;

      try {
        const existingInstances = await singletonFactory.getInstances();
        assertNoDeployedSingletonSpecDrift(definition, singletonInstanceName, existingInstances);
        if (
          'createResourceGraphForInstance' in singletonFactory &&
          existingInstances.length === 0
        ) {
          const discovered = await this.getDeploymentEngine().loadDeploymentByInstance({
            factoryName: singletonFactory.name,
            instanceName: singletonInstanceName,
          });
          const discoveredResources = discovered?.resources ?? [];
          const driftCheck = assertNoDiscoveredSingletonSpecDrift(
            definition,
            singletonInstanceName,
            discoveredResources
          );
          if (driftCheck.hasLegacyUnfingerprintedResources) {
            const expectedGraph = singletonFactory.createResourceGraphForInstance(
              definition.spec,
              singletonInstanceName
            );
            const discoveredIds = new Set(discoveredResources.map((resource) => resource.id));
            const hasAllExpectedResources = expectedGraph.resources.every((resource) =>
              discoveredIds.has(resource.id)
            );
            const hasHelmReleaseResources = expectedGraph.resources.some(
              (resource) => resource.manifest.kind === 'HelmRelease'
            );

            const legacyStatus = this.reExecuteSingletonStatusFromDiscoveredResources(
              definition,
              discoveredResources
            );
            if (legacyStatus) {
              this.rememberSingletonOwnerStatus(definition, legacyStatus);
            }
            if (hasAllExpectedResources && !hasHelmReleaseResources) {
              this.logger.warn(
                'Skipping direct singleton owner reconciliation for legacy resources without a spec fingerprint',
                {
                  singletonId: definition.id,
                  singletonKey: definition.key,
                  singletonInstanceName,
                  registryNamespace: definition.registryNamespace,
                }
              );
              continue;
            }

            this.logger.warn(
              'Reconciling direct singleton owner because legacy resources may need repair',
              {
                singletonId: definition.id,
                singletonKey: definition.key,
                singletonInstanceName,
                registryNamespace: definition.registryNamespace,
                discoveredResourceCount: discoveredResources.length,
                expectedResourceCount: expectedGraph.resources.length,
                hasAllExpectedResources,
                hasHelmReleaseResources,
              }
            );
          }
        }

        const singletonDeployOptions: InternalResourceFactoryDeployOptions = {
          instanceNameOverride: singletonInstanceName,
          singletonSpecFingerprint: singletonSpecFingerprintAnnotationValue(
            definition.specFingerprint
          ),
          ...(operationSignal ? { operationSignal } : {}),
        };
        const deployedSingleton = await singletonFactory.deploy(
          definition.spec,
          singletonDeployOptions
        );
        const singletonStatus = (deployedSingleton as { status?: unknown }).status;
        if (
          singletonStatus &&
          typeof singletonStatus === 'object' &&
          !Array.isArray(singletonStatus)
        ) {
          this.rememberSingletonOwnerStatus(definition, singletonStatus as Record<string, unknown>);
        }
      } finally {
        await singletonFactory.dispose?.();
      }
    }
  }

  /**
   * Expose already-reconciled singleton owners as reference seeds for the consumer graph.
   * Direct mode owns the physical singleton resources directly; the logical KRO owner CR exists
   * only as a composition boundary and must not be read from the Kubernetes API.
   */
  getExternalReferenceSeeds(): DeployedResource[] {
    return [...this.singletonOwnerReferenceSeeds.values()];
  }

  private rememberSingletonOwnerStatus(
    definition: SingletonDefinitionRecord,
    status: Record<string, unknown>
  ): void {
    const id = getSingletonResourceId(definition.key);
    const { apiVersion, kind } = singletonInstanceTypeMeta(definition.composition);
    const name = getSingletonInstanceName(definition.id);
    const manifest: KubernetesResource = {
      apiVersion,
      kind,
      metadata: {
        name,
        namespace: definition.registryNamespace,
      },
      status,
    };

    this.singletonOwnerStatuses.set(id, status);
    this.singletonOwnerReferenceSeeds.set(id, {
      id,
      kind,
      name,
      namespace: definition.registryNamespace,
      manifest,
      liveManifest: manifest,
      status: 'ready',
      applied: false,
      deployedAt: new Date(),
    });
  }

  private reExecuteSingletonStatusFromDiscoveredResources(
    definition: SingletonDefinitionRecord,
    resources: Array<{ id: string; manifest?: unknown }>
  ): Record<string, unknown> | null {
    if (resources.length === 0) return null;

    const liveStatusMap = new Map<string, Record<string, unknown>>();
    const localIdsByLiveIdentity = this.getSingletonLocalIdsByLiveIdentity(definition);
    const singletonInstanceName = getSingletonInstanceName(definition.id);
    for (const resource of resources) {
      const manifest = resource.manifest;
      const status =
        manifest && typeof manifest === 'object' && 'status' in manifest
          ? (manifest as { status?: unknown }).status
          : undefined;
      const statusRecord =
        status && typeof status === 'object' && !Array.isArray(status)
          ? (status as Record<string, unknown>)
          : {};

      for (const id of this.getSingletonStatusAliases(
        resource.id,
        manifest,
        singletonInstanceName,
        localIdsByLiveIdentity
      )) {
        liveStatusMap.set(id, statusRecord);
      }
    }

    return this.reExecuteSingletonStatus(definition, liveStatusMap) ?? null;
  }

  private getSingletonLocalIdsByLiveIdentity(
    definition: SingletonDefinitionRecord
  ): Map<string, string> {
    const compositionFn = (
      definition.composition as unknown as {
        _compositionFn?: (spec: unknown) => unknown;
      }
    )._compositionFn;
    const idsByIdentity = new Map<string, string>();
    if (!compositionFn) return idsByIdentity;

    const probeContext = createCompositionContext('singleton-status-discovery-probe', {
      deduplicateIds: true,
      isReExecution: true,
    });
    runWithCompositionContext(probeContext, () => compositionFn(definition.spec));

    for (const [id, resource] of Object.entries(probeContext.resources)) {
      const identity = this.getLiveIdentityKey(
        resource.kind,
        resource.metadata?.name,
        resource.metadata?.namespace
      );
      if (identity) idsByIdentity.set(identity, id);
      const namespaceAgnosticIdentity = this.getLiveIdentityKey(
        resource.kind,
        resource.metadata?.name
      );
      if (namespaceAgnosticIdentity) idsByIdentity.set(namespaceAgnosticIdentity, id);
    }

    return idsByIdentity;
  }

  private getSingletonStatusAliases(
    discoveredId: string,
    manifest: unknown,
    singletonInstanceName: string,
    localIdsByLiveIdentity: Map<string, string>
  ): string[] {
    const aliases = new Set<string>([discoveredId]);
    const annotationId =
      manifest && typeof manifest === 'object'
        ? (manifest as { metadata?: { annotations?: Record<string, string> } }).metadata
            ?.annotations?.['typekro.io/resource-id']
        : undefined;
    if (annotationId) aliases.add(annotationId);

    const derivedId = this.deriveLocalIdFromDirectGraphId(
      discoveredId,
      singletonInstanceName,
      localIdsByLiveIdentity.values()
    );
    if (derivedId) aliases.add(derivedId);

    if (manifest && typeof manifest === 'object') {
      const resource = manifest as {
        kind?: string;
        metadata?: { name?: string; namespace?: string };
      };
      const identity = this.getLiveIdentityKey(
        resource.kind,
        resource.metadata?.name,
        resource.metadata?.namespace
      );
      const namespaceAgnosticIdentity = this.getLiveIdentityKey(
        resource.kind,
        resource.metadata?.name
      );
      const localId =
        (identity ? localIdsByLiveIdentity.get(identity) : undefined) ??
        (namespaceAgnosticIdentity
          ? localIdsByLiveIdentity.get(namespaceAgnosticIdentity)
          : undefined);
      if (localId) aliases.add(localId);
    }

    return [...aliases];
  }

  private deriveLocalIdFromDirectGraphId(
    id: string,
    singletonInstanceName: string,
    candidateLocalIds: Iterable<string> = []
  ): string | undefined {
    const prefix = `${toCamelCase(singletonInstanceName)}Resource`;
    const match = id.match(new RegExp(`^${prefix}\\d+(.+)$`));
    if (!match?.[1]) return undefined;
    const suffix = match[1].charAt(0).toLowerCase() + match[1].slice(1);
    const normalizedSuffix = suffix.toLowerCase();
    for (const candidate of candidateLocalIds) {
      if (
        candidate === suffix ||
        candidate.toLowerCase() === normalizedSuffix ||
        toCamelCase(candidate).toLowerCase() === normalizedSuffix
      ) {
        return candidate;
      }
    }
    return suffix;
  }

  private getLiveIdentityKey(kind?: string, name?: string, namespace?: string): string | undefined {
    if (!kind || !name) return undefined;
    return `${kind}/${namespace ?? ''}/${name}`;
  }
}

/** Describes an unresolved reference found during direct-mode toYaml() validation. */
interface UnresolvedReference {
  /** Dot-separated path to the value, e.g. "spec.containers[0].env.DATABASE_HOST" */
  path: string;
  /** Human-readable description of the reference type */
  description: string;
}

/**
 * Recursively walk a resolved resource tree and collect any remaining
 * KubernetesRef or CelExpression objects.  These cannot be serialized
 * in direct-mode YAML and indicate the user should use Kro mode or deploy().
 */
function findUnresolvedReferences(
  resources: Record<string, KubernetesResource>
): UnresolvedReference[] {
  const refs: UnresolvedReference[] = [];
  const visited = new WeakSet<object>();

  function walk(value: unknown, path: string, depth: number): void {
    if (value == null || typeof value !== 'object') {
      // Check for __KUBERNETES_REF_ marker strings left in resolved primitives
      if (typeof value === 'string' && value.includes('__KUBERNETES_REF_')) {
        refs.push({ path, description: `Unresolved reference marker: ${value}` });
      }
      return;
    }

    if (depth >= DEFAULT_MAX_RECURSION_DEPTH) return;
    if (visited.has(value)) return;
    visited.add(value);

    if (isKubernetesRef(value)) {
      const ref = value as { resourceId?: string; fieldPath?: string };
      refs.push({
        path,
        description: `KubernetesRef(${ref.resourceId ?? '?'}.${ref.fieldPath ?? '?'})`,
      });
      return;
    }

    if (isCelExpression(value)) {
      const expr = value as { expression?: string };
      refs.push({
        path,
        description: `CelExpression(${expr.expression ?? '?'})`,
      });
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  }

  for (const [resourceKey, resource] of Object.entries(resources)) {
    const label = `${resource.kind ?? 'Resource'}/${resource.metadata?.name ?? resourceKey}`;
    walk(resource, label, 0);
  }

  return refs;
}

/**
 * Preserve the historical declaration ID for every non-colliding resource.
 * A collision means no prior Alchemy stack could have materialized the set, so
 * it is safe to add an identity suffix only at that boundary.
 */
function disambiguatedAlchemyResourceId(
  legacyId: string,
  canonicalKubernetesIdentity: string
): string {
  const suffix = createHash('sha256')
    .update(canonicalKubernetesIdentity, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `${legacyId}Identity${suffix}`;
}

function directAlchemyKubernetesIdentity(
  resource: Enhanced<unknown, unknown>,
  factoryNamespace: string
): {
  readonly key: string;
  readonly display: string;
} {
  const namespace =
    getMetadataField(resource, 'scope') === 'cluster'
      ? undefined
      : resource.metadata?.namespace ?? factoryNamespace;
  const identity = {
    group: kubernetesApiGroup(resource.apiVersion),
    kind: resource.kind,
    name: resource.metadata?.name,
    namespace,
  };
  return {
    key: JSON.stringify(identity),
    display:
      `${resource.apiVersion}/${identity.kind} ` +
      `${namespace ? `${namespace}/` : ''}${identity.name ?? '<unnamed>'}`,
  };
}

function kubernetesApiGroup(apiVersion: string): string {
  const separator = apiVersion.indexOf('/');
  return separator === -1 ? '' : apiVersion.slice(0, separator);
}

/**
 * Create a DirectResourceFactory instance
 */
export function createDirectResourceFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  name: string,
  resources: Record<string, KubernetesResource>,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  // biome-ignore lint/suspicious/noExplicitAny: factory creation must accept status builders with composition-specific resource maps.
  statusBuilder?: StatusBuilder<TSpec, TStatus, any>,
  options: FactoryOptions = {}
): DirectResourceFactory<TSpec, TStatus> {
  return new DirectResourceFactoryImpl<TSpec, TStatus>(
    name,
    resources,
    schemaDefinition,
    statusBuilder,
    options
  );
}
