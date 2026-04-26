/**
 * KroResourceFactory implementation for Kro deployment mode
 *
 * This factory handles deployment via Kro ResourceGraphDefinitions,
 * using the Kro controller for dependency resolution and resource management.
 */

import * as k8s from '@kubernetes/client-node';
import { compile as compileExpression } from 'angular-expressions';
import * as yaml from 'js-yaml';
import { preserveNonEnumerableProperties } from '../../utils/helpers.js';
import { isKubernetesRef } from '../../utils/type-guards.js';
import type { KroDeletionOptions } from '../../alchemy/kro-delete.js';
import {
  DEFAULT_DEPLOYMENT_TIMEOUT,
  DEFAULT_KRO_INSTANCE_TIMEOUT,
  DEFAULT_RGD_TIMEOUT,
} from '../config/defaults.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_SCHEMA_MARKER_SOURCE } from '../constants/brands.js';
import { CRDInstanceError, ensureError, ResourceGraphFactoryError, TypeKroError } from '../errors.js';
import type { KubernetesClientProvider } from '../kubernetes/client-provider.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
import { createSchemaProxy, DeploymentMode } from '../references/index.js';
import { createCompositionContext, runWithCompositionContext } from '../composition/context.js';
import { buildNestedCompositionAliasTargets } from '../composition/nested-status-cel.js';
import { applyAnalysisToResources } from '../expressions/composition/composition-analyzer.js';
// Dependency inversion: kroCustomResource, resourceGraphDefinition, and
// alchemy bridge are injected via FactoryOptions providers (Phase 3.5)
// instead of dynamic import() from higher layers.
import { getMetadataField } from '../metadata/index.js';
import { generateKroSchemaFromArktype } from '../serialization/schema.js';
import { applyTernaryConditionalsToResources } from '../serialization/kro-post-processing.js';
import { serializeResourceGraphToYaml } from '../serialization/yaml.js';
import { logHandleSnapshot } from './handle-tracing.js';
import type { CelExpression, KubernetesRef } from '../types/common.js';
import type {
  AlchemyBridge,
  AppliedResource,
  DeploymentClosure,
  DeploymentContext,
  FactoryOptions,
  FactoryStatus,
  KroCustomResourceProvider,
  KroResourceFactory,
  ResourceGraphDefinitionProvider,
  RGDStatus,
  SingletonDefinitionRecord,
} from '../types/deployment.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from '../types/kubernetes.js';
import type {
  KroCompatibleType,
  MagicAssignableShape,
  SchemaDefinition,
  SchemaProxy,
  Scope,
} from '../types/serialization.js';
import { KubernetesClientManager } from './client-provider-manager.js';
import { DirectDeploymentEngine } from './engine.js';
import { waitForKroInstanceReady as waitForKroInstanceReadyShared } from './kro-readiness.js';
import { getSingletonResourceId } from '../singleton/singleton.js';
import {
  convertToKubernetesName,
  generateInstanceName,
  getSingletonInstanceName,
  pluralizeKind,
  validateAlchemyScope,
  validateSpec,
} from './shared-utilities.js';
import {
  assertNoDeployedSingletonSpecDrift,
  singletonSpecFingerprintAnnotationValue,
} from './singleton-owner-drift.js';

/**
 * Decide whether the RGD/CRD should be preserved after a `deleteInstance`
 * call, i.e., whether other instances still depend on it.
 *
 * **Exported for testing.** This is the pure decision core extracted
 * from {@link KroResourceFactoryImpl.deleteInstance}:
 *
 *   - `instanceDeleted === true` — the poll loop confirmed the CR
 *     returned 404. Filter the target name out of the live instance
 *     list to handle list-cache lag (the CR is gone from GETs but may
 *     still appear in LISTs briefly). If any *other* instances remain,
 *     preserve the RGD so they keep working.
 *
 *   - `instanceDeleted === false` — the poll loop timed out while KRO
 *     was still processing `kro.run/finalizer`. Do NOT filter the
 *     target name out: the stuck instance counts as remaining so the
 *     RGD stays up for KRO to complete finalizer processing in the
 *     background. Deleting the RGD mid-finalizer orphans the finalizer
 *     and permanently blocks cleanup — a regression that surfaced
 *     during real-world KRO dogfooding.
 *
 * Returns `true` when the RGD should be preserved (i.e., remaining
 * instances exist or the target is stuck), `false` when it's safe
 * to tear the RGD/CRD down.
 */
export function shouldPreserveRgd(
  // Loose typing — the callers pass Enhanced<TSpec, TStatus>[] at runtime
  // but this decision only reads `metadata.name` and tolerates undefined.
  instances: ReadonlyArray<{ metadata?: { name?: unknown } }>,
  targetName: string,
  instanceDeleted: boolean
): boolean {
  const others = instanceDeleted
    ? instances.filter((i) => i.metadata?.name !== targetName)
    : instances;
  return others.length > 0;
}

/**
 * KroResourceFactory implementation
 *
 * Handles deployment via Kro ResourceGraphDefinitions. The RGD is deployed once,
 * and then instances are created as custom resources that the Kro controller processes.
 */
export class KroResourceFactoryImpl<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> implements KroResourceFactory<TSpec, TStatus>
{
  readonly mode = 'kro' as const;
  readonly name: string;
  readonly namespace: string;
  readonly isAlchemyManaged: boolean;
  readonly rgdName: string;
  readonly schema: SchemaProxy<TSpec, TStatus>;

  private readonly resources: Record<string, KubernetesResource>;
  private readonly closures: Record<string, DeploymentClosure>;
  private readonly schemaDefinition: SchemaDefinition<TSpec, TStatus>;
  private readonly statusMappings: Record<string, unknown>;
  private readonly alchemyScope: Scope | undefined;
  private readonly singletonDefinitions: SingletonDefinitionRecord[];
  private readonly singletonOwnerStatuses = new Map<string, Record<string, unknown>>();
  private readonly logger = getComponentLogger('kro-factory');
  private readonly factoryOptions: FactoryOptions;
  private readonly clientManager: KubernetesClientManager;
  /**
   * Tracks whether ternary-conditional post-processing has already been applied
   * to `this.resources`. The mutation is idempotent today (consumed markers are
   * replaced with CEL in the first pass), but we guard explicitly for symmetry
   * with `core.ts` and to avoid relying on that idempotency claim across future
   * refactors. Applies across both `toYaml()` and `ensureRGDDeployed()` paths.
   */
  private ternaryAndOmitApplied = false;
  private compositionAnalysisApplied = false;

  /**
   * Cached plural form of the schema kind, discovered from the actual CRD
   * created by KRO after RGD deployment. Populated by
   * {@link waitForCRDReadyWithEngine}. Used by {@link getInstances} (and
   * any other method that needs to list/read the custom resource) instead
   * of guessing the plural from client-side heuristics.
   *
   * KRO's server-side pluralization is authoritative and not always
   * derivable from client code — for example, already-plural kind
   * names don't get an extra "s" suffix.
   */
  private discoveredPlural: string | undefined;

  // Dependency-inversion providers (Phase 3.5) — injected via FactoryOptions
  // instead of dynamic import() from factories/ and alchemy/ layers.
  private readonly kroCustomResourceProvider: KroCustomResourceProvider | undefined;
  private readonly rgdProvider: ResourceGraphDefinitionProvider | undefined;
  private readonly alchemyBridge: AlchemyBridge | undefined;

  constructor(
    name: string,
    resources: Record<string, KubernetesResource>,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    statusMappings: MagicAssignableShape<TStatus>,
    options: FactoryOptions = {}
  ) {
    this.name = name;
    this.namespace = options.namespace || 'default';
    this.alchemyScope = options.alchemyScope;
    this.isAlchemyManaged = !!options.alchemyScope;
    this.rgdName = convertToKubernetesName(name); // Convert to valid Kubernetes resource name
    this.resources = resources;
    this.closures = options.closures || {};
    this.schemaDefinition = schemaDefinition;
    this.statusMappings = statusMappings as Record<string, unknown>;
    this.singletonDefinitions = options.singletonDefinitions ?? [];
    this.factoryOptions = options;
    this.clientManager = new KubernetesClientManager(options);
    // Pass the Arktype JSON so the proxy is shape-aware: spread
    // (`{ ...schema.spec.X }`) enumerates declared fields and
    // `Object.keys(schema.spec.X)` returns them. See the docstring on
    // `createSchemaProxy` for why this matters for nested compositions.
    this.schema = createSchemaProxy<TSpec, TStatus>(
      (schemaDefinition.spec as { json?: unknown } | undefined)?.json,
      (schemaDefinition.status as { json?: unknown } | undefined)?.json
    );

    // Injected providers — fall back to dynamic import() for backward compatibility
    this.kroCustomResourceProvider = options.kroCustomResourceProvider;
    this.rgdProvider = options.rgdProvider;
    this.alchemyBridge = options.alchemyBridge;

    // Validate closures for Kro mode - detect KubernetesRef inputs and raise clear errors
    this.validateClosuresForKroMode();
  }

  /** Extract nested composition status CEL mappings from the raw status object. */
  private getNestedStatusCel(): Record<string, string> | undefined {
    return (this.statusMappings as Record<string, unknown>)?.__nestedStatusCel as
      | Record<string, string>
      | undefined;
  }

  private getSchemaVersion(): string {
    return this.schemaDefinition.apiVersion.includes('/')
      ? this.schemaDefinition.apiVersion.split('/')[1] || this.schemaDefinition.apiVersion
      : this.schemaDefinition.apiVersion;
  }

  private getSchemaGroup(): string {
    if (this.schemaDefinition.group) return this.schemaDefinition.group;
    return this.schemaDefinition.apiVersion.includes('/')
      ? this.schemaDefinition.apiVersion.split('/')[0] || 'kro.run'
      : 'kro.run';
  }

  private getInstanceApiVersion(): string {
    return `${this.getSchemaGroup()}/${this.getSchemaVersion()}`;
  }

  /**
   * Idempotently create the factory's target namespace if it doesn't
   * exist. KRO does not auto-create the CR's containing namespace, and
   * users specify `{ namespace }` in factory options expecting it to
   * "just work" without having to `kubectl create ns` first.
   *
   * Uses the Kubernetes Object API's create path with a 409-conflict
   * tolerance — ignored if the namespace already exists so concurrent
   * callers don't collide.
   */
  private async ensureTargetNamespace(namespace = this.namespace): Promise<void> {
    try {
      const { createBunCompatibleKubernetesObjectApi } = await import(
        '../kubernetes/bun-api-client.js'
      );
      const k8sApi = createBunCompatibleKubernetesObjectApi(this.getKubeConfig());
      const waitForNamespaceDeletion = async (): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < 120000) {
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
          await new Promise((resolve) => setTimeout(resolve, 1000));
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
          // Already exists — nothing to do.
          return;
        }
      } catch (readError: unknown) {
        const k8sErr = readError as { statusCode?: number; body?: { code?: number } };
        const code = k8sErr.statusCode ?? k8sErr.body?.code;
        if (code !== 404) {
          // Non-404 read failure — propagate with context.
          throw readError;
        }
      }
      // Namespace is missing — create it.
      this.logger.info('Creating target namespace for Kro deployment', {
        namespace,
      });
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
        } as k8s.KubernetesObject);
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
          } as k8s.KubernetesObject);
          return;
        }
        // 409 = race with another caller — namespace now exists, treat as success.
        if (code !== 409) throw createError;
      }
    } catch (error: unknown) {
      throw new ResourceGraphFactoryError(
        `Failed to ensure target namespace "${this.namespace}" exists: ${ensureError(error).message}`,
        this.name,
        'deployment',
        ensureError(error)
      );
    }
  }

  /**
   * One-shot lookup of the CRD plural from the live cluster for this
   * factory's (kind, group). Does NOT wait for establishment — expects
   * the CRD to already exist. Returns `undefined` if the CRD is missing
   * or the lookup fails, so callers can fall back to a heuristic.
   *
   * Used by paths like `getInstances` when invoked on a fresh factory
   * instance (e.g., `--delete` from the CLI) where the wait-for-CRD
   * step hasn't populated {@link discoveredPlural}.
   */
  private async lookupCRDPlural(): Promise<string | undefined> {
    try {
      const k8sApi = this.createKubernetesObjectApi();
      const crds = (await k8sApi.list(
        'apiextensions.k8s.io/v1',
        'CustomResourceDefinition'
      )) as unknown as {
        items?: Array<{
          metadata?: { name?: string };
          spec?: { group?: string; names?: { kind?: string; plural?: string } };
        }>;
      };
      const match = crds?.items?.find(
        (crd) =>
          crd.spec?.group === this.getSchemaGroup() &&
          crd.spec?.names?.kind === this.schemaDefinition.kind
      );
      return match?.spec?.names?.plural;
    } catch (error: unknown) {
      this.logger.debug('CRD plural lookup failed — falling back to heuristic', {
        kind: this.schemaDefinition.kind,
        error: ensureError(error).message,
      });
      return undefined;
    }
  }

  private createKubernetesObjectApi(): k8s.KubernetesObjectApi {
    return createBunCompatibleKubernetesObjectApi(this.getKubeConfig());
  }

  /**
   * Validate closures for Kro mode compatibility
   * Kro mode only supports static values - no dynamic references (KubernetesRef)
   */
  private validateClosuresForKroMode(): void {
    if (Object.keys(this.closures).length === 0) {
      return; // No closures to validate
    }

    // For Kro mode, we need to validate that closures don't contain dynamic references
    // This is a static analysis - we can't execute the closures to check their arguments
    // Instead, we'll validate when closures are executed during deployment
    this.logger.debug('Kro factory initialized with closures', {
      closureCount: Object.keys(this.closures).length,
      closureNames: Object.keys(this.closures),
    });
  }

  /**
   * Get or create the Kubernetes client provider (lazy initialization)
   */
  private getClientProvider(): KubernetesClientProvider {
    return this.clientManager.getClientProvider();
  }

  /**
   * Get the Kubernetes config from the centralized provider
   */
  private getKubeConfig(): k8s.KubeConfig {
    return this.clientManager.getKubeConfig();
  }

  /**
   * Get CustomObjectsApi client
   */
  private getCustomObjectsApi(): k8s.CustomObjectsApi {
    return this.clientManager.getCustomObjectsApi();
  }

  private getDebugState(): Record<string, unknown> {
    return {
      mode: this.mode,
      rgdName: this.rgdName,
      namespace: this.namespace,
      discoveredPlural: this.discoveredPlural,
      clientManager: this.clientManager.getDebugState(),
    };
  }

  async dispose(): Promise<void> {
    logHandleSnapshot(this.logger, 'kro-factory.dispose.before', {
      factoryState: this.getDebugState(),
    });
    this.clientManager.dispose();
    logHandleSnapshot(this.logger, 'kro-factory.dispose.after', {
      factoryState: this.getDebugState(),
    });
  }

  /**
   * Deploy a new instance by creating a custom resource
   */
  async deploy(
    spec: TSpec,
    opts?: { targetScopes?: string[]; instanceNameOverride?: string; singletonSpecFingerprint?: string }
  ): Promise<Enhanced<TSpec, TStatus>> {
    if (opts?.targetScopes !== undefined) {
      throw new TypeKroError(
        'Scope-targeted deployment is not supported in KRO mode. KRO manages resource lifecycle via its own controller. Use direct mode for scope-targeted deploys.',
        'UNSUPPORTED_OPTION',
        { targetScopes: opts.targetScopes, mode: 'kro' }
      );
    }
    // Validate spec against ArkType schema
    validateSpec(spec, this.schemaDefinition, {
      kind: this.schemaDefinition.kind,
      name: this.name,
    });

    // Execute closures before RGD creation (Kro mode requirement)
    await this.executeClosuresBeforeRGD(spec);
    await this.ensureSingletonOwners(spec);

    if (this.isAlchemyManaged) {
      return this.deployWithAlchemy(
        spec,
        opts?.instanceNameOverride,
        opts?.singletonSpecFingerprint,
      );
    } else {
      return this.deployDirect(
        spec,
        opts?.instanceNameOverride,
        opts?.singletonSpecFingerprint,
      );
    }
  }

  private async ensureSingletonOwners(spec: TSpec): Promise<void> {
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

    if (discoveredSingletons.size === 0) return;

    const singletonRecords = new Map<string, SingletonDefinitionRecord>();
    for (const definition of discoveredSingletons.values()) {
      if (!singletonRecords.has(definition.key)) {
        singletonRecords.set(definition.key, definition);
      }
    }

    for (const definition of singletonRecords.values()) {
      await this.ensureTargetNamespace(definition.registryNamespace);

      const singletonInstanceName = getSingletonInstanceName(definition.id);
      const singletonFactory = definition.composition.factory('kro', {
        namespace: definition.registryNamespace,
        waitForReady: true,
        ...(this.factoryOptions.timeout !== undefined ? { timeout: this.factoryOptions.timeout } : {}),
        ...(this.factoryOptions.kubeConfig !== undefined ? { kubeConfig: this.factoryOptions.kubeConfig } : {}),
        ...(this.factoryOptions.skipTLSVerify !== undefined ? { skipTLSVerify: this.factoryOptions.skipTLSVerify } : {}),
      }) as KroResourceFactory<KroCompatibleType, KroCompatibleType>;

      try {
        this.logger.info('Ensuring singleton owner boundary', {
          singletonId: definition.id,
          singletonKey: definition.key,
          registryNamespace: definition.registryNamespace,
        });

        const existingInstances = await this.getSingletonOwnerInstancesForDriftCheck(
          singletonFactory,
          definition
        );
        assertNoDeployedSingletonSpecDrift(
          definition,
          singletonInstanceName,
          existingInstances
        );

        const deployedSingleton = await singletonFactory.deploy(definition.spec as TSpec, {
          instanceNameOverride: singletonInstanceName,
          singletonSpecFingerprint: singletonSpecFingerprintAnnotationValue(definition.specFingerprint),
        });
        const singletonStatus = (deployedSingleton as { status?: unknown }).status;
        if (singletonStatus && typeof singletonStatus === 'object' && !Array.isArray(singletonStatus)) {
          this.singletonOwnerStatuses.set(
            getSingletonResourceId(definition.key),
            singletonStatus as Record<string, unknown>
          );
        }
      } finally {
        await singletonFactory.dispose?.();
      }
    }
  }

  private async getSingletonOwnerInstancesForDriftCheck(
    singletonFactory: KroResourceFactory<KroCompatibleType, KroCompatibleType>,
    definition: SingletonDefinitionRecord
  ): Promise<Enhanced<KroCompatibleType, KroCompatibleType>[]> {
    try {
      return await singletonFactory.getInstances();
    } catch (error: unknown) {
      if (this.isMissingSingletonOwnerCrdError(error)) {
        this.logger.debug('Singleton owner CRD is not installed yet; continuing with first deploy', {
          singletonId: definition.id,
          singletonKey: definition.key,
          registryNamespace: definition.registryNamespace,
          error: ensureError(error).message,
        });
        return [];
      }
      throw error;
    }
  }

  private isMissingSingletonOwnerCrdError(error: unknown): boolean {
    const err = error as { message?: string; body?: unknown; statusCode?: number; code?: number };
    const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? '');
    const text = `${err.message ?? ''} ${body} ${String(error)}`.toLowerCase();
    return (
      err.statusCode === 404 ||
      err.code === 404 ||
      text.includes('404') ||
      text.includes('not found') ||
      text.includes('no matches for kind') ||
      text.includes('the server could not find the requested resource')
    );
  }

  /**
   * Execute closures before RGD creation (Kro mode requirement)
   * Closures must execute before ResourceGraphDefinition is created
   */
  private async executeClosuresBeforeRGD(_spec: TSpec): Promise<AppliedResource[]> {
    if (Object.keys(this.closures).length === 0) {
      return []; // No closures to execute
    }

    this.logger.info('Executing closures before RGD creation', {
      closureCount: Object.keys(this.closures).length,
    });

    // First, validate all closures before creating any API clients
    // The closures returned by the resource builder are deployment closures that expect a DeploymentContext
    // We need to execute them with a mock context to trigger validation
    const mockDeploymentContext: DeploymentContext = {
      // kubernetesApi intentionally omitted - not needed for validation
      namespace: this.namespace,
      deployedResources: new Map(),
      resolveReference: async (ref: KubernetesRef) => {
        throw new ResourceGraphFactoryError(
          `Kro mode does not support dynamic reference resolution. Found reference: ${ref.resourceId}.${ref.fieldPath}`,
          this.name,
          'deployment'
        );
      },
    };

    for (const [closureName, closure] of Object.entries(this.closures)) {
      try {
        // Execute the deployment closure with mock context to trigger validation
        await closure(mockDeploymentContext);
      } catch (error: unknown) {
        // If validation fails, throw the validation error immediately
        if (
          error instanceof Error &&
          error.message.includes('Kro mode does not support dynamic reference resolution')
        ) {
          throw error;
        }
        // For other errors, wrap them with context
        throw new ResourceGraphFactoryError(
          `Failed to validate closure '${closureName}': ${ensureError(error).message}`,
          this.name,
          'deployment'
        );
      }
    }

    const allResults: AppliedResource[] = [];

    // Only create deployment context after validation passes
    // Use createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
    const kubeConfig = this.getKubeConfig();
    const deploymentContext: DeploymentContext = {
      kubernetesApi: createBunCompatibleKubernetesObjectApi(kubeConfig),
      kubeConfig: kubeConfig,
      ...(this.alchemyScope && { alchemyScope: this.alchemyScope }),
      namespace: this.namespace,
      deployedResources: new Map(), // Empty for pre-RGD execution
      resolveReference: async (ref: KubernetesRef) => {
        throw new ResourceGraphFactoryError(
          `Kro mode does not support dynamic reference resolution. Found reference: ${ref.resourceId}.${ref.fieldPath}`,
          this.name,
          'deployment'
        );
      },
    };

    // Execute closures sequentially to maintain order
    for (const [closureName, closure] of Object.entries(this.closures)) {
      try {
        this.logger.debug('Executing closure', { name: closureName });

        // Note: We can't validate closure arguments here because we don't have access to them
        // The validation happens inside the closure when it processes its config
        // This is a limitation of the closure pattern, but the error messages will be clear

        const results = await closure(deploymentContext);
        allResults.push(...results);

        this.logger.info('Closure executed successfully', {
          name: closureName,
          resourceCount: results.length,
        });
      } catch (error: unknown) {
        // Check if this is a KubernetesRef validation error and enhance it
        if (error instanceof Error && error.message.includes('KubernetesRef')) {
          this.logger.error(
            'Closure validation failed - dynamic references not supported in Kro mode',
            {
              name: closureName,
              message: error.message,
            }
          );
          throw error; // Re-throw with original detailed message
        }

        this.logger.error('Closure execution failed', {
          name: closureName,
          message: ensureError(error).message,
        });
        throw new ResourceGraphFactoryError(
          `Failed to execute closure '${closureName}': ${ensureError(error).message}`,
          this.name,
          'deployment',
          ensureError(error)
        );
      }
    }

    this.logger.info('All closures executed successfully', {
      totalResources: allResults.length,
    });

    return allResults;
  }

  /**
   * Deploy directly to Kubernetes using DirectDeploymentEngine
   */
  private async deployDirect(
    spec: TSpec,
    instanceNameOverride?: string,
    singletonSpecFingerprint?: string,
  ): Promise<Enhanced<TSpec, TStatus>> {
    // Ensure RGD is deployed first
    await this.ensureRGDDeployed();

    // Ensure the target namespace exists before posting the CR. KRO
    // reconciles resources from the RGD into their own namespaces, but
    // the CR instance itself must live in a namespace the user can
    // write to. Without this, the first deploy after `kubectl delete ns`
    // fails with a 404 on the CR POST.
    await this.ensureTargetNamespace();

    // Create DirectDeploymentEngine with KRO mode for CEL string conversion
    const deploymentEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );

    // Create custom resource instance
    const instanceName = instanceNameOverride ?? generateInstanceName(spec, this.name);
    const customResourceData = this.createCustomResourceInstance(
      instanceName,
      spec,
      singletonSpecFingerprint,
    );

    // Wrap with kroCustomResource factory to get Enhanced object with readiness evaluation
    const kroCustomResource =
      this.kroCustomResourceProvider ??
      (await import('../../factories/kro/kro-custom-resource.js')).kroCustomResource;
    const enhancedCustomResource = kroCustomResource({
      apiVersion: customResourceData.apiVersion,
      kind: customResourceData.kind,
      metadata: {
        ...customResourceData.metadata,
      },
      spec: customResourceData.spec,
    });

    // Deploy using DirectDeploymentEngine with built-in waitForReady logic
    const deployableResource: DeployableK8sResource<typeof enhancedCustomResource> = {
      ...enhancedCustomResource,
      id: instanceName,
      metadata: {
        ...enhancedCustomResource.metadata,
        name: instanceName,
        namespace: this.namespace,
      },
      spec: customResourceData.spec, // Use spec directly from customResourceData to ensure it's preserved
    } as DeployableK8sResource<typeof enhancedCustomResource>;

    // Preserve non-enumerable properties (readinessEvaluator, __resourceId) lost during spread
    preserveNonEnumerableProperties(enhancedCustomResource, deployableResource);

    // Deploy without waiting for readiness - we'll handle that ourselves
    this.logger.info('Deploying Kro instance', { instanceName, rgdName: this.rgdName });
    try {
      await deploymentEngine.deployResource(deployableResource, {
        mode: 'kro',
        namespace: this.namespace,
        waitForReady: false, // We'll handle Kro-specific readiness ourselves
        timeout: this.factoryOptions.timeout || DEFAULT_DEPLOYMENT_TIMEOUT,
      });
      this.logger.info('Instance deployed, checking readiness', {
        instanceName,
        rgdName: this.rgdName,
      });

      // Handle Kro-specific readiness checking if requested
      if (this.factoryOptions.waitForReady ?? true) {
        await this.waitForKroInstanceReady(
          instanceName,
          this.factoryOptions.timeout || DEFAULT_KRO_INSTANCE_TIMEOUT
        ); // 10 minutes
      }
      this.logger.info('Instance ready, creating enhanced proxy', {
        instanceName,
        rgdName: this.rgdName,
      });

      // Create Enhanced proxy for the deployed instance
      return await this.createEnhancedProxy(spec, instanceName);
    } finally {
      await deploymentEngine.dispose();
    }
  }

  /**
   * Deploy using type-safe alchemy resource wrapping
   *
   * In alchemy mode, the RGD gets one typed alchemy Resource and each instance gets another
   */
  private async deployWithAlchemy(
    spec: TSpec,
    instanceNameOverride?: string,
    singletonSpecFingerprint?: string,
  ): Promise<Enhanced<TSpec, TStatus>> {
    validateAlchemyScope(this.alchemyScope, 'KRO Alchemy deployment');
    const alchemyScope = this.alchemyScope as Scope & {
      run<T>(fn: () => Promise<T>): Promise<T>;
    };

    // Use static registration functions

    // Create deployer instance using DirectDeploymentEngine with KRO mode
    const kroEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );
    const kubeConfigOptions = this.extractKubeConfigOptionsForAlchemy();
    const kroDeletion = this.createAlchemyKroDeletionOptions();

    try {
      // 1. Ensure RGD is deployed via alchemy (once per factory). Reuse the
      // normal serializer so externalRef/forEach/includeWhen/readyWhen and
      // singleton owner boundaries match non-Alchemy KRO deploys.
      const rgdManifest = yaml.load(this.buildRgdYaml()) as Record<string, unknown>;

      // Register RGD type dynamically
      const rgdFactory =
        this.rgdProvider ??
        (await import('../../factories/kro/resource-graph-definition.js')).resourceGraphDefinition;
      const rgdEnhanced = rgdFactory(rgdManifest);
      const bridge = this.alchemyBridge ?? (await import('../../alchemy/deployment.js'));
      const RGDProvider = bridge.ensureResourceTypeRegistered(rgdEnhanced);
      const rgdId = bridge.createAlchemyResourceId(rgdEnhanced, this.namespace);

      await alchemyScope.run(async () => {
        await RGDProvider(rgdId, {
          resource: rgdEnhanced,
          namespace: this.namespace,
          deploymentStrategy: 'kro' as const,
          kubeConfigOptions,
          kroDeletion,
          options: {
            waitForReady: true,
            timeout: DEFAULT_RGD_TIMEOUT, // RGD should be ready quickly
          },
        });
      });
      await this.waitForCRDReadyWithEngine(kroEngine);

      // 2. Create instance via alchemy (once per deploy call)
      await this.ensureTargetNamespace();
      const instanceName = instanceNameOverride ?? generateInstanceName(spec, this.name);
      const crdInstanceManifest = this.createCustomResourceInstance(
        instanceName,
        spec,
        singletonSpecFingerprint,
      );

      // Register CRD instance type dynamically
      // Cast required: crdInstanceManifest is a plain KubernetesResource, but alchemy functions
      // expect Enhanced<unknown, unknown>. They only access kind/metadata.name for type inference.
      const crdAsEnhanced = crdInstanceManifest as unknown as Enhanced<unknown, unknown>;
      const CRDInstanceProvider = bridge.ensureResourceTypeRegistered(crdAsEnhanced);
      const instanceId = bridge.createAlchemyResourceId(crdAsEnhanced, this.namespace);

      await alchemyScope.run(async () => {
        await CRDInstanceProvider(instanceId, {
          resource: crdAsEnhanced,
          namespace: this.namespace,
          deploymentStrategy: 'kro' as const,
          kubeConfigOptions,
          kroDeletion,
          options: {
            waitForReady: false,
            timeout: this.factoryOptions.timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
          },
        });
      });

      if (this.factoryOptions.waitForReady ?? true) {
        await this.waitForKroInstanceReady(
          instanceName,
          this.factoryOptions.timeout || DEFAULT_KRO_INSTANCE_TIMEOUT
        );
      }

      // Create Enhanced proxy for the deployed instance
      return await this.createEnhancedProxy(spec, instanceName);
    } finally {
      await kroEngine.dispose();
    }
  }

  /**
   * Get all deployed instances
   */
  async getInstances(): Promise<Enhanced<TSpec, TStatus>[]> {
    const customApi = await this.createCustomObjectsApi();

    try {
      const version = this.getSchemaVersion();

      // Prefer the server-discovered plural (populated after the CRD is
      // created by KRO) over any client-side heuristic. For first-call
      // paths like delete-on-fresh-factory, discover the plural lazily
      // from the live CRD so already-plural kinds work correctly. Fall
      // back to `pluralizeKind` only if the CRD list query failed (e.g.,
      // missing RBAC) — in which case the list call below may also fail
      // and surface a clearer error.
      if (!this.discoveredPlural) {
        this.discoveredPlural = await this.lookupCRDPlural();
      }
      const plural =
        this.discoveredPlural ?? pluralizeKind(this.schemaDefinition.kind);

      // In the new API, methods take request objects and return objects directly
      const listResponse = await customApi.listNamespacedCustomObject({
        group: this.getSchemaGroup(),
        version,
        namespace: this.namespace,
        plural,
      });

      // Custom object list response structure
      interface CustomObjectListResponse {
        items?: Array<{
          spec?: TSpec;
          metadata?: { name?: string; annotations?: Record<string, string> };
        }>;
      }
      const listResult = listResponse as CustomObjectListResponse;
      const instances = listResult.items || [];

      return await Promise.all(
        instances.map(async (instance) => {
          const enhanced = await this.createEnhancedProxy(
            instance.spec as TSpec,
            instance.metadata?.name || 'unknown'
          );
          if (instance.metadata?.annotations) {
            const mutableEnhanced = enhanced as unknown as { metadata?: Record<string, unknown> };
            const existingMetadata = mutableEnhanced.metadata ?? {};
            const existingAnnotations = existingMetadata.annotations && typeof existingMetadata.annotations === 'object'
              ? existingMetadata.annotations as Record<string, string>
              : {};
            mutableEnhanced.metadata = {
              ...existingMetadata,
              annotations: {
                ...existingAnnotations,
                ...instance.metadata.annotations,
              },
            };
          }
          return enhanced;
        })
      );
    } catch (error: unknown) {
      const k8sError = error as { message?: string; body?: string | object; statusCode?: number };
      // If the CRD doesn't exist yet or there are no instances, return empty array
      const bodyString =
        typeof k8sError.body === 'string' ? k8sError.body : JSON.stringify(k8sError.body || '');

      if (
        k8sError.message?.includes('not found') ||
        k8sError.message?.includes('404') ||
        bodyString.includes('not found') ||
        bodyString.includes('404') ||
        k8sError.statusCode === 404 ||
        String(error).includes('404') ||
        String(error).includes('not found')
      ) {
        return [];
      }
      throw new CRDInstanceError(
        `Failed to list instances: ${k8sError.message || String(error)}`,
        this.schemaDefinition.apiVersion,
        this.schemaDefinition.kind,
        '*',
        'statusResolution',
        ensureError(error)
      );
    }
  }

  private async createCustomObjectsApi(): Promise<k8s.CustomObjectsApi> {
    const kubeConfig = this.getKubeConfig();
    // Use Bun-compatible API client to ensure proper TLS handling
    const { createBunCompatibleCustomObjectsApi } = await import('../kubernetes/bun-api-client.js');
    return createBunCompatibleCustomObjectsApi(kubeConfig);
  }

  /**
   * Delete a specific instance by name
   */
  async deleteInstance(name: string, opts?: { scopes?: string[]; includeUnscopedResources?: boolean }): Promise<void> {
    if (opts?.scopes?.length) {
      throw new TypeKroError(
        'Scope-filtered deletion is not supported in KRO mode. KRO manages resource lifecycle via its own controller. Use direct mode for scope-filtered deletes.',
        'UNSUPPORTED_OPTION',
        { scopes: opts.scopes, instanceName: name, mode: 'kro' }
      );
    }
    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    const apiVersion = this.getInstanceApiVersion();

    // Tracks whether the CR was confirmed 404 by the poll loop. Used
    // later to decide whether to tear down the RGD/CRD or preserve
    // them for KRO to continue finalizer processing in the background.
    let instanceDeleted = false;
    let deletionTimedOut = false;

    try {
      // Delete the instance. KRO's controller processes kro.run/finalizer,
      // which does graph-based deletion of all child resources.
      await k8sApi.delete({
        apiVersion,
        kind: this.schemaDefinition.kind,
        metadata: {
          name,
          namespace: this.namespace,
        },
      } as k8s.KubernetesObject);

      // Wait for KRO to finish cleanup (finalizer processing).
      // KRO needs the RGD to exist during this phase — the caller must
      // not delete the RGD until deleteInstance completes.
      const timeout = this.factoryOptions.timeout ?? 300000;
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        try {
          await k8sApi.read({
            apiVersion,
            kind: this.schemaDefinition.kind,
            metadata: { name, namespace: this.namespace },
          });
          // Still exists — KRO is processing finalizer
          await new Promise(r => setTimeout(r, 2000));
        } catch (pollError: unknown) {
          const pollK8sError = pollError as { statusCode?: number; code?: number; body?: { code?: number } };
          const errorCode = pollK8sError.statusCode ?? pollK8sError.code ?? pollK8sError.body?.code;
          if (errorCode === 404) {
            instanceDeleted = true;
            break;
          }
          // Non-404 error (permissions, server error) — log and retry
          this.logger.debug('Deletion poll error (retrying)', {
            name,
            errorCode,
          });
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!instanceDeleted) {
        // KRO is still processing the finalizer. Treat the stuck instance as
        // remaining so the RGD is preserved, then surface failure to callers.
        // Deleting the RGD while KRO is mid-finalizer would orphan cleanup.
        deletionTimedOut = true;
        this.logger.warn('Instance deletion still in progress after timeout', {
          name,
          timeout,
          elapsed: Date.now() - startTime,
          hint: 'KRO finalizer processing continues in the background. The RGD will be preserved.',
        });
      }
    } catch (error: unknown) {
      const k8sError = error as { statusCode?: number; code?: number; body?: { code?: number }; message?: string };
      const errorCode = k8sError.statusCode ?? k8sError.code ?? k8sError.body?.code;
      if (errorCode === 404) {
        instanceDeleted = true;
      } else {
        throw new CRDInstanceError(
          `Failed to delete instance ${name}: ${k8sError.message || String(error)}`,
          this.schemaDefinition.apiVersion,
          this.schemaDefinition.kind,
          name,
          'deletion',
          ensureError(error)
        );
      }
    }

    // Only delete the RGD and CRD if no other instances remain. Multiple
    // instances can share one RGD — deleting it would break the others.
    // The decision is a pure function of (listed instances, target name,
    // instanceDeleted flag) — see {@link shouldPreserveRgd} for the rules.
    let hasRemainingInstances = false;
    try {
      const instances = await this.getInstances();
      hasRemainingInstances = shouldPreserveRgd(instances, name, instanceDeleted);
    } catch (listError: unknown) {
      // Can't list instances — could be CRD gone (safe) or transient error
      // (unsafe to delete RGD). Default to preserving the RGD to avoid
      // breaking other instances that might still be using it.
      this.logger.warn('Cannot list instances to check for shared RGD — preserving RGD', {
        rgdName: this.rgdName,
        error: ensureError(listError).message,
      });
      hasRemainingInstances = true;
    }

    if (!hasRemainingInstances) {
      // Delete the RGD after the instance is gone.
      try {
        await k8sApi.delete({
          apiVersion: 'kro.run/v1alpha1',
          kind: 'ResourceGraphDefinition',
          metadata: { name: this.rgdName },
        } as k8s.KubernetesObject);
        this.logger.debug('RGD deleted', { rgdName: this.rgdName });
      } catch (error: unknown) {
        const k8sErr = error as { statusCode?: number; code?: number; body?: { code?: number } };
        const errorCode = k8sErr.statusCode ?? k8sErr.code ?? k8sErr.body?.code;
        if (errorCode !== 404) {
          this.logger.warn('RGD cleanup failed', { rgdName: this.rgdName, error: ensureError(error).message });
          throw error;
        }
      }

      // Delete the CRD that KRO created from the RGD. KRO's default config
      // has allowCRDDeletion=false, so it won't clean up the CRD when the
      // RGD is deleted. Prefer the server-discovered plural over the
      // heuristic fallback so already-plural kinds clean up correctly.
      const crdPlural =
        this.discoveredPlural ?? pluralizeKind(this.schemaDefinition.kind);
      const crdName = `${crdPlural}.${this.getSchemaGroup()}`;
      try {
        await k8sApi.delete({
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: { name: crdName },
        } as k8s.KubernetesObject);
        this.logger.debug('CRD deleted', { crdName });
      } catch (error: unknown) {
        const k8sErr = error as { statusCode?: number; code?: number; body?: { code?: number } };
        const errorCode = k8sErr.statusCode ?? k8sErr.code ?? k8sErr.body?.code;
        if (errorCode !== 404) {
          this.logger.warn('CRD cleanup failed', { crdName, error: ensureError(error).message });
          throw error;
        }
      }
    } else {
      this.logger.debug('Skipping RGD/CRD deletion — other instances still exist', {
        rgdName: this.rgdName,
      });
    }

    if (deletionTimedOut) {
      throw new CRDInstanceError(
        `KRO instance ${name} deletion did not complete within ${this.factoryOptions.timeout ?? 300000}ms`,
        this.schemaDefinition.apiVersion,
        this.schemaDefinition.kind,
        name,
        'deletion'
      );
    }

    // Namespaces are resources in the composition's dependency graph.
    // KRO's finalizer processing handles deleting all child resources
    // (including Namespaces) via its applyset — no manual cleanup needed.
  }

  private extractKubeConfigOptionsForAlchemy(): Record<string, unknown> {
    const kc = this.getKubeConfig();
    const cluster = kc.getCurrentCluster();
    const user = typeof kc.getCurrentUser === 'function' ? kc.getCurrentUser() : undefined;
    const context = typeof kc.getCurrentContext === 'function' ? kc.getCurrentContext() : undefined;
    const finalSkipTLS = this.factoryOptions.skipTLSVerify === true
      ? true
      : (cluster?.skipTLSVerify ?? false);

    return {
      skipTLSVerify: finalSkipTLS,
      ...(cluster?.server && { server: cluster.server }),
      ...(context && { context }),
      ...(cluster && {
        cluster: {
          name: cluster.name,
          server: cluster.server,
          skipTLSVerify: finalSkipTLS,
          ...(cluster.caData && { caData: cluster.caData }),
          ...(cluster.caFile && { caFile: cluster.caFile }),
        },
      }),
      ...(user && {
        user: {
          name: user.name,
          ...(user.token && { token: user.token }),
          ...(user.certData && { certData: user.certData }),
          ...(user.certFile && { certFile: user.certFile }),
          ...(user.keyData && { keyData: user.keyData }),
          ...(user.keyFile && { keyFile: user.keyFile }),
          ...((user as { exec?: object }).exec ? { exec: (user as { exec?: object }).exec } : {}),
          ...((user as { authProvider?: object }).authProvider ? { authProvider: (user as { authProvider?: object }).authProvider } : {}),
        },
      }),
    };
  }

  private createAlchemyKroDeletionOptions(): KroDeletionOptions {
    return {
      apiVersion: this.schemaDefinition.apiVersion,
      kind: this.schemaDefinition.kind,
      ...(this.schemaDefinition.group && { group: this.schemaDefinition.group }),
      namespace: this.namespace,
      rgdName: this.rgdName,
      ...(this.discoveredPlural && { plural: this.discoveredPlural }),
      timeout: this.factoryOptions.timeout ?? 300000,
    };
  }

  /**
   * Get factory status
   */
  async getStatus(): Promise<FactoryStatus> {
    const instances = await this.getInstances();
    const rgdStatus = await this.getRGDStatus();

    return {
      name: this.name,
      mode: this.mode,
      isAlchemyManaged: this.isAlchemyManaged,
      namespace: this.namespace,
      instanceCount: instances.length,
      health: rgdStatus.phase === 'ready' ? 'healthy' : 'degraded',
    };
  }

  /**
   * Get ResourceGraphDefinition status
   */
  async getRGDStatus(): Promise<RGDStatus> {
    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    try {
      // In the new API, methods return objects directly (no .body wrapper)
      const response = await k8sApi.read({
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: {
          name: this.rgdName,
          namespace: this.namespace,
        },
      });

      const rgd = response as k8s.KubernetesObject & {
        status?: {
          state?: string;
          conditions?: Array<{
            type: string;
            status: string;
            reason?: string;
            message?: string;
          }>;
          observedGeneration?: number;
        };
      };

      // Map Kro's state to our phase enum
      let phase: 'pending' | 'ready' | 'failed' = 'pending';
      if (rgd.status?.state === 'Active') {
        phase = 'ready';
      } else if (rgd.status?.state === 'Inactive') {
        // Check if it's failed or just pending
        const hasFailedCondition = rgd.status?.conditions?.some((c) => c.status === 'False');
        phase = hasFailedCondition ? 'failed' : 'pending';
      }

      return {
        name: this.rgdName,
        phase,
        conditions: rgd.status?.conditions || [],
        observedGeneration: rgd.status?.observedGeneration || 0,
      };
    } catch (error: unknown) {
      const k8sError = error as { statusCode?: number; message?: string; body?: string | object };
      // Check for 404 in multiple ways since different API clients report it differently
      const bodyString =
        typeof k8sError.body === 'string' ? k8sError.body : JSON.stringify(k8sError.body || '');
      const is404 =
        k8sError.statusCode === 404 ||
        k8sError.message?.includes('404') ||
        k8sError.message?.includes('not found') ||
        k8sError.message?.includes('NotFound') ||
        bodyString.includes('"code":404') ||
        bodyString.includes('"reason":"NotFound"') ||
        String(error).includes('404') ||
        String(error).includes('not found');

      if (is404) {
        return {
          name: this.rgdName,
          phase: 'pending',
          conditions: [],
        };
      }
      throw new ResourceGraphFactoryError(
        `Failed to get RGD status: ${k8sError.message || String(error)}`,
        this.name,
        'getInstance',
        ensureError(error)
      );
    }
  }

  /**
   * Generate RGD YAML (no arguments)
   */
  toYaml(): string;
  /**
   * Generate CRD instance YAML (with spec)
   */
  toYaml(spec: TSpec): string;
  /**
   * Implementation of overloaded toYaml method
   */
  toYaml(spec?: TSpec): string {
    if (spec) {
      // Generate CRD instance YAML
      const instanceName = generateInstanceName(spec, this.name);
      const customResource = this.createCustomResourceInstance(instanceName, spec);

      return yaml.dump(customResource, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd();
    }

    return this.buildRgdYaml();
  }

  /**
   * Build the RGD YAML string shared by `toYaml()` and `ensureRGDDeployed()`.
   *
   * Both call sites must apply ternary-conditional post-processing;
   * extracting the logic ensures the two paths stay in sync and share the
   * single-apply guard on `this.ternaryAndOmitApplied`.
   *
   * Note: omit() wrapping for optional fields is no longer a post-processing
   * step — it's applied inline during ref-to-CEL conversion via
   * `SerializationContext.omitFields`, which `serializeResourceGraphToYaml`
   * populates from `kroSchema.__omitFields` automatically.
   */
  private buildRgdYaml(): string {
    if (this.factoryOptions.compositionAnalysis && !this.compositionAnalysisApplied) {
      this.compositionAnalysisApplied = true;
      applyAnalysisToResources(this.resources as Record<string, unknown>, this.factoryOptions.compositionAnalysis);
    }

    const kroSchema = generateKroSchemaFromArktype(
      this.name,
      this.schemaDefinition,
      this.resources,
      this.statusMappings,
      this.getNestedStatusCel()
    );

    // Attach nested status CEL mappings as non-enumerable property so
    // serializeResourceGraphToYaml can inline virtual composition IDs.
    const nestedCel = this.getNestedStatusCel();
    if (nestedCel && Object.keys(nestedCel).length > 0) {
      Object.defineProperty(kroSchema, '__nestedStatusCel', {
        value: nestedCel,
        enumerable: false,
      });
    }

    // Apply ternary conditionals to this.resources BEFORE serialization.
    // Mutates in place (JSON.clone is NOT safe here because it strips
    // proxy-valued fields like `metadata.namespace` that are KubernetesRef
    // proxies with typeof function). The single-apply guard mirrors
    // core.ts — the underlying operation is idempotent today, but we
    // explicitly skip re-runs to keep both paths structurally identical
    // and avoid depending on that idempotency across future refactors.
    if (!this.ternaryAndOmitApplied) {
      this.ternaryAndOmitApplied = true;
      if (kroSchema.__ternaryConditionals?.length) {
        applyTernaryConditionalsToResources(
          this.resources as Record<string, unknown>,
          kroSchema.__ternaryConditionals
        );
      }
    }

    return serializeResourceGraphToYaml(
      this.rgdName,
      this.resources,
      { namespace: this.namespace },
      kroSchema
    );
  }

  /**
   * Ensure the ResourceGraphDefinition is deployed using DirectDeploymentEngine
   */
  private async ensureRGDDeployed(): Promise<void> {
    // Create DirectDeploymentEngine instance with KRO mode for CEL string generation
    const deploymentEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );

    // Build the RGD YAML — shared with toYaml() so both call sites emit
    // identical post-processed output and share the single-apply guard.
    const rgdYaml = this.buildRgdYaml();

    // Parse the YAML to get the RGD object
    const rgdManifests = k8s.loadAllYaml(rgdYaml);
    const rgdManifest = rgdManifests[0] as k8s.KubernetesObject;

    // Ensure the RGD has the required properties for deployment
    const rgdWithMetadata = {
      ...rgdManifest,
      metadata: {
        ...rgdManifest.metadata,
        name: this.rgdName,
        namespace: this.namespace,
      },
    };

    // Create Enhanced RGD with readiness evaluator
    const rgdFactory =
      this.rgdProvider ??
      (await import('../../factories/kro/resource-graph-definition.js')).resourceGraphDefinition;
    const enhancedRGD = rgdFactory(rgdWithMetadata);

    // Create a deployable resource with the required 'id' field
    const deployableRGD = {
      ...enhancedRGD,
      id: this.rgdName,
    } as DeployableK8sResource<Enhanced<Record<string, unknown>, Record<string, unknown>>>;

    // Preserve non-enumerable properties (readinessEvaluator, __resourceId) lost during spread
    preserveNonEnumerableProperties(enhancedRGD, deployableRGD);

    // Debug: Log the RGD being deployed
    this.logger.debug('Deploying RGD', {
      rgdName: this.rgdName,
      rgdManifest: JSON.stringify(rgdWithMetadata, null, 2),
    });

    try {
      // Deploy RGD using DirectDeploymentEngine with readiness checking
      this.logger.info('Deploying RGD via engine', { rgdName: this.rgdName });
      await deploymentEngine.deployResource(deployableRGD, {
        mode: 'direct',
        namespace: this.namespace,
        waitForReady: true,
        timeout: this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT,
      });
      this.logger.info('RGD deployed, waiting for CRD', { rgdName: this.rgdName });

      // Wait for the CRD to be created by Kro using DirectDeploymentEngine
      await this.waitForCRDReadyWithEngine(deploymentEngine);
      this.logger.info('CRD ready', { rgdName: this.rgdName });
    } catch (error: unknown) {
      // Debug: Check the actual RGD status when it fails
      try {
        const kubeConfig = this.getKubeConfig();
        const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
        // In the new API, methods return objects directly (no .body wrapper)
        const rgdStatus = await k8sApi.read({
          apiVersion: 'kro.run/v1alpha1',
          kind: 'ResourceGraphDefinition',
          metadata: { name: this.rgdName, namespace: this.namespace },
        });
        // RGD status structure
        interface RGDStatusResponse {
          status?: {
            conditions?: Array<{ type?: string; status?: string; message?: string }>;
            [key: string]: unknown;
          };
        }
        const rgdResult = rgdStatus as RGDStatusResponse;
        this.logger.error('RGD deployment failed, current status:', undefined, {
          rgdName: this.rgdName,
          status: rgdResult.status,
          conditions: rgdResult.status?.conditions,
        });
      } catch (statusError: unknown) {
        this.logger.error('Could not fetch RGD status for debugging', ensureError(statusError));
      }

      throw new ResourceGraphFactoryError(
        `Failed to deploy RGD using DirectDeploymentEngine: ${ensureError(error).message}`,
        this.name,
        'deployment',
        ensureError(error)
      );
    } finally {
      await deploymentEngine.dispose();
    }
  }

  /**
   * Wait for the CRD to be created by Kro using DirectDeploymentEngine.
   *
   * Discovers the CRD by (kind, group=kro.run) via the CRD list API
   * rather than pre-computing a plural form. KRO's server-side pluralization
   * is authoritative, and client-side heuristics cannot handle all cases
   * (e.g., already-plural kind names that shouldn't get an extra "s").
   */
  private async waitForCRDReadyWithEngine(deploymentEngine: DirectDeploymentEngine): Promise<void> {
    if (typeof deploymentEngine.waitForCRDByKindAndGroup !== 'function') {
      throw new ResourceGraphFactoryError(
        `deploymentEngine.waitForCRDByKindAndGroup is not a function. Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(deploymentEngine)).join(', ')}`,
        this.name,
        'deployment'
      );
    }

    const { plural } = await deploymentEngine.waitForCRDByKindAndGroup(
      this.schemaDefinition.kind,
      this.getSchemaGroup(),
      this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT
    );
    this.discoveredPlural = plural;
  }

  /**
   * Separate static and dynamic status fields
   */
  private async separateStatusFields(): Promise<{
    staticFields: Record<string, unknown>;
    dynamicFields: Record<string, unknown>;
  }> {
    if (!this.statusMappings) {
      return { staticFields: {}, dynamicFields: {} };
    }

    // Use dynamic import to avoid circular dependencies
    const { separateStatusFields } = await import('../validation/cel-validator.js');
    return separateStatusFields(this.statusMappings);
  }

  /**
   * Evaluate static CEL expressions with actual spec values
   */
  private async evaluateStaticFields(
    staticFields: Record<string, unknown>,
    spec: TSpec
  ): Promise<Record<string, unknown>> {
    const evaluatedFields: Record<string, unknown> = {};

    for (const [fieldName, fieldValue] of Object.entries(staticFields)) {
      if (this.isCelExpression(fieldValue)) {
        try {
          // Evaluate CEL expressions that contain only schema references
          const evaluatedValue = this.evaluateStaticCelExpression(fieldValue, spec);
          evaluatedFields[fieldName] = evaluatedValue;
        } catch (error: unknown) {
          this.logger.warn('Failed to evaluate static CEL expression', {
            field: fieldName,
            expression: fieldValue.expression,
            error: ensureError(error).message,
          });
          // Fallback to the original value
          evaluatedFields[fieldName] = fieldValue;
        }
      } else if (
        typeof fieldValue === 'string' &&
        fieldValue.includes('__KUBERNETES_REF___schema___')
      ) {
        // Resolve __KUBERNETES_REF_ marker strings from template literal coercion.
        // When the composition function uses template literals like `${spec.name}-suffix`,
        // the proxy's Symbol.toPrimitive produces marker strings at runtime. These need
        // to be resolved to actual spec values at deploy time.
        evaluatedFields[fieldName] = this.resolveSchemaRefMarkers(fieldValue, spec);
      } else if (
        typeof fieldValue === 'string' &&
        fieldValue.startsWith('${') &&
        fieldValue.endsWith('}')
      ) {
        // Evaluate inline CEL expression strings produced by the composition AST analyzer.
        // statusOverrides from analyzeCompositionBody write ternary/conditional expressions
        // as plain strings like "${schema.spec.enabled ? 2 : 1}" into statusMappings.
        // These must be evaluated with actual spec values at deploy time.
        try {
          evaluatedFields[fieldName] = this.evaluateInlineCelString(fieldValue, spec);
        } catch (error: unknown) {
          this.logger.warn('Failed to evaluate inline CEL expression string', {
            field: fieldName,
            expression: fieldValue,
            error: ensureError(error).message,
          });
          evaluatedFields[fieldName] = fieldValue;
        }
      } else if (
        typeof fieldValue === 'object' &&
        fieldValue !== null &&
        !Array.isArray(fieldValue)
      ) {
        // Recursively evaluate nested objects
        evaluatedFields[fieldName] = await this.evaluateStaticFields(
          fieldValue as Record<string, unknown>,
          spec
        );
      } else {
        // Keep non-CEL values as-is
        evaluatedFields[fieldName] = fieldValue;
      }
    }

    return evaluatedFields;
  }

  /**
   * Evaluate a static CEL expression that contains only schema references or literal values.
   *
   * Uses `angular-expressions` for safe AST-based evaluation instead of `new Function()` / `eval()`.
   * Spec field references (e.g., `schema.spec.name`, `spec.replicas`) are resolved by passing the
   * spec values as a scope object, eliminating string interpolation injection risks entirely.
   */
  private evaluateStaticCelExpression(celExpression: CelExpression, spec: TSpec): unknown {
    const expression = celExpression.expression;
    // Use null-prototype object to prevent prototype chain access (defense-in-depth).
    // angular-expressions has hasOwnProperty guards, but a null-prototype scope
    // eliminates any residual risk from constructor/toString/__proto__ leaking.
    // Object.freeze prevents expression-based mutation of the original spec data.
    const specRecord = Object.freeze(
      Object.assign(Object.create(null) as Record<string, unknown>, spec)
    );

    // Build a scope expression by stripping schema.spec. or spec. prefixes so that
    // angular-expressions can resolve field references directly from the spec scope.
    let scopeExpression = expression;

    if (expression.includes('schema.spec.')) {
      // Replace schema.spec.fieldName → fieldName (resolved from scope)
      scopeExpression = scopeExpression.replace(/schema\.spec\.(\w+)/g, '$1');
    }

    if (scopeExpression.includes('spec.')) {
      // Replace spec.fieldName → fieldName (resolved from scope)
      scopeExpression = scopeExpression.replace(/\bspec\.(\w+)/g, '$1');
    }

    try {
      const evaluator = compileExpression(scopeExpression);
      const result = evaluator(specRecord) as unknown;
      return result;
    } catch (error: unknown) {
      // If evaluation fails, the expression might be an unquoted string like: http://kro-webapp-service
      // In this case, return it as-is (it's already a string value)
      if (!expression.includes('schema.spec.') && !expression.includes('spec.')) {
        this.logger.debug('Static expression evaluation failed, returning as string literal', {
          expression,
          error: ensureError(error).message,
        });
        return expression;
      }
      this.logger.warn('Failed to evaluate expression safely', {
        expression: scopeExpression,
        originalExpression: expression,
        error: ensureError(error).message,
      });
      throw error;
    }
  }

  /**
   * Resolve `__KUBERNETES_REF___schema___<fieldPath>__` markers in a string.
   *
   * When a composition function uses template literals like `` `${spec.name}-suffix` ``,
   * the magic proxy's Symbol.toPrimitive returns a marker string at composition time.
   * At deploy time we replace each marker with the actual spec value.
   */
  private resolveSchemaRefMarkers(value: string, spec: TSpec): unknown {
    const resolved = value.replace(
      new RegExp(KUBERNETES_REF_SCHEMA_MARKER_SOURCE, 'g'),
      (_match, fieldPath: string) => {
        // fieldPath is e.g. "spec.name" or "spec.nested.field"
        const parts = fieldPath.replace(/^spec\./, '').split('.');
        let current: unknown = spec;
        for (const part of parts) {
          if (current != null && typeof current === 'object') {
            current = (current as Record<string, unknown>)[part];
          } else {
            this.logger.warn('Could not resolve schema ref marker', {
              marker: _match,
              fieldPath,
              failedAt: part,
            });
            return _match; // Keep marker if unresolvable
          }
        }
        return String(current ?? '');
      }
    );
    return resolved;
  }

  /**
   * Evaluate an inline CEL expression string like `"${schema.spec.enabled ? 2 : 1}"`.
   *
   * The composition body AST analyzer produces these for ternary expressions in
   * status return values (statusOverrides). They are plain strings wrapping a CEL
   * expression that must be evaluated with the real spec values.
   */
  private evaluateInlineCelString(celString: string, spec: TSpec): unknown {
    // Strip the wrapping ${ ... }
    const innerExpression = celString.slice(2, -1);

    // Build scope expression: strip schema.spec. / spec. prefixes
    let scopeExpression = innerExpression;
    if (scopeExpression.includes('schema.spec.')) {
      scopeExpression = scopeExpression.replace(/schema\.spec\.(\w+)/g, '$1');
    }
    if (scopeExpression.includes('spec.')) {
      scopeExpression = scopeExpression.replace(/\bspec\.(\w+)/g, '$1');
    }

    // Resolve any __KUBERNETES_REF_ markers that may be embedded in the expression
    // (e.g. from template literals inside ternary branches)
    if (scopeExpression.includes('__KUBERNETES_REF___schema___')) {
      scopeExpression = scopeExpression.replace(
        new RegExp(KUBERNETES_REF_SCHEMA_MARKER_SOURCE, 'g'),
        (_match, fieldPath: string) => {
          const parts = fieldPath.replace(/^spec\./, '').split('.');
          return parts.join('.');
        }
      );
    }

    // Convert CEL single-quoted string literals to double-quoted for angular-expressions
    // Match single-quoted strings that are NOT inside backticks
    scopeExpression = scopeExpression.replace(/'([^'\\]*)'/g, '"$1"');

    const specRecord = Object.freeze(
      Object.assign(Object.create(null) as Record<string, unknown>, spec)
    );
    const evaluator = compileExpression(scopeExpression);
    return evaluator(specRecord) as unknown;
  }

  /**
   * Check if a value is a CEL expression (using canonical brand symbol)
   */
  private isCelExpression(value: unknown): value is CelExpression {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    return (
      CEL_EXPRESSION_BRAND in value &&
      (value as Record<symbol, unknown>)[CEL_EXPRESSION_BRAND] === true &&
      'expression' in value &&
      typeof (value as Record<string, unknown>).expression === 'string'
    );
  }

  /**
   * Create custom resource instance
   */
  private createCustomResourceInstance(
    instanceName: string,
    spec: TSpec,
    singletonSpecFingerprint?: string,
  ) {
    const apiVersion = this.getInstanceApiVersion();

    return {
      apiVersion,
      kind: this.schemaDefinition.kind,
      metadata: {
        name: instanceName,
        namespace: this.namespace,
        ...(singletonSpecFingerprint ? {
          annotations: {
            'typekro.io/singleton-spec-fingerprint': singletonSpecFingerprint,
          },
        } : {}),
      },
      spec,
    };
  }

  /**
   * Create an Enhanced proxy for the instance with mixed static/dynamic hydration
   */
  private async createEnhancedProxyWithMixedHydration(
    spec: TSpec,
    instanceName: string
  ): Promise<Enhanced<TSpec, TStatus>> {
    const hydrationLogger = this.logger.child({ instanceName });

    // Separate static and dynamic status fields
    const { staticFields, dynamicFields } = await this.separateStatusFields();

    // Evaluate static CEL expressions with actual spec values
    const evaluatedStaticFields = await this.evaluateStaticFields(staticFields, spec);

    // Start with evaluated static fields as the base status
    const status: TStatus = { ...evaluatedStaticFields } as TStatus;

    // Create the initial Enhanced proxy
    // The Enhanced proxy should represent the actual instance, which uses the full API version
    const instanceApiVersion = this.getInstanceApiVersion();

    const enhancedProxy = {
      apiVersion: instanceApiVersion,
      kind: this.schemaDefinition.kind,
      spec,
      status,
      metadata: {
        name: instanceName,
        namespace: this.namespace,
        labels: {
          'typekro.io/factory': this.name,
          'typekro.io/mode': this.mode,
          'typekro.io/rgd': this.rgdName,
        },
        annotations: {
          'typekro.io/deployed-at': new Date().toISOString(),
          'typekro.io/api-version': instanceApiVersion,
          'typekro.io/kind': this.schemaDefinition.kind,
        },
      },
      // Type cast: constructing a partial Enhanced proxy — only metadata.name and spec
      // are accessed by callers at this call site. TypeScript cannot verify structural
      // completeness; callers are responsible for only accessing these fields.
    } as unknown as Enhanced<TSpec, TStatus>;

    // Hydrate dynamic status fields if enabled and there are dynamic fields
    if (this.factoryOptions.hydrateStatus !== false && Object.keys(dynamicFields).length > 0) {
      try {
        const hydratedDynamicFields = await this.hydrateDynamicStatusFields(
          instanceName,
          dynamicFields
        );

        // Merge evaluated static fields with dynamic fields from KRO.
        // Use evaluatedStaticFields (resolved markers) not raw staticFields.
        const mergedStatus = {
          ...evaluatedStaticFields,
          ...hydratedDynamicFields, // Dynamic fields from Kro override
        };

        // Update the status using object assignment to avoid type issues
        Object.assign(enhancedProxy.status, mergedStatus);
      } catch (error: unknown) {
        hydrationLogger.error('Dynamic status hydration failed', ensureError(error));
        // Continue with static fields only if dynamic hydration fails
      }
    }

    // Post-process: re-execute the composition with live cluster data to fill
    // in status fields that neither static evaluation nor KRO could provide.
    if (this.factoryOptions.hydrateStatus !== false && this.factoryOptions.compositionFn) {
      try {
        const liveStatus = await this.reExecuteWithLiveStatus(spec);
        if (liveStatus) {
          for (const [key, value] of Object.entries(liveStatus)) {
            if (key.startsWith('__')) continue;
            // Live re-execution uses the actual deploy spec plus cluster state, so it is the
            // most accurate source for non-dynamic fields. Dynamic fields remain owned by the
            // live Kro instance status and should not be replaced here.
            if (!(key in dynamicFields)) {
              (enhancedProxy.status as Record<string, unknown>)[key] = value;
              continue;
            }

            const current = (enhancedProxy.status as Record<string, unknown>)[key];
            if (current === undefined || current === null || current === '') {
              (enhancedProxy.status as Record<string, unknown>)[key] = value;
            }
          }
        }
      } catch (error: unknown) {
        hydrationLogger.warn('Live status re-execution failed (non-fatal)', {
          error: ensureError(error).message,
        });
      }
    }

    return enhancedProxy;
  }

  /**
   * Re-execute the composition function with live cluster data to hydrate
   * status fields that KRO couldn't compute.
   */
  private async reExecuteWithLiveStatus(spec: TSpec): Promise<TStatus | null> {
    const compositionFn = this.factoryOptions.compositionFn;
    if (!compositionFn) return null;

    const { createCompositionContext, runWithCompositionContext } = await import(
      '../composition/context.js'
    );
    const { synthesizeNestedCompositionStatus } = await import(
      './nested-composition-status.js'
    );

    // Build a live status map from deployed resources
    const liveStatusMap = new Map<string, Record<string, unknown>>();
    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    const resourceEntries = Object.entries(this.resources);
    const results = await Promise.allSettled(
      resourceEntries.map(async ([resourceId, resource]) => {
        const name = this.resolveLiveResourceIdentityValue(resource.metadata?.name, spec, resourceId);
        const ns = this.resolveLiveResourceIdentityValue(resource.metadata?.namespace, spec, this.namespace);

        const isClusterScoped = getMetadataField(resource, 'scope') === 'cluster';
        const live = await k8sApi.read({
          apiVersion: resource.apiVersion || '',
          kind: resource.kind || '',
          metadata: { name, ...(isClusterScoped ? {} : { namespace: ns }) },
        });

        if (live && typeof live === 'object' && 'status' in live) {
          return { resourceId, status: (live as Record<string, unknown>).status as Record<string, unknown> };
        }

        // Statusless resources (Service, ConfigMap, Secret, etc.) should still
        // count as visible children for nested-composition recovery.
        return { resourceId, status: {} };
      })
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        liveStatusMap.set(result.value.resourceId, result.value.status);
      }
    }

    // Probe to discover nested composition IDs
    const probeContext = createCompositionContext('kro-re-execution-probe', {
      deduplicateIds: true,
      isReExecution: true,
    });
    probeContext.liveStatusMap = liveStatusMap;
    runWithCompositionContext(probeContext, () => compositionFn(spec));

    // Synthesize nested composition status
    const enrichedMap = synthesizeNestedCompositionStatus(
      probeContext.resources,
      liveStatusMap,
      this.logger,
      probeContext.nestedCompositionIds,
      probeContext.nestedStatusSnapshots
    );

    const aliasTargets = buildNestedCompositionAliasTargets(
      compositionFn.toString(),
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
      const singletonStatus = this.singletonOwnerStatuses.get(singletonResourceId);
      if (singletonStatus && !enrichedMap.has(singletonResourceId)) {
        enrichedMap.set(singletonResourceId, singletonStatus);
      }
    }

    // Real execution with live status
    const reExecutionContext = createCompositionContext('kro-re-execution', {
      deduplicateIds: true,
      isReExecution: true,
    });
    reExecutionContext.liveStatusMap = enrichedMap;

    const result = runWithCompositionContext(reExecutionContext, () =>
      compositionFn(spec)
    );
    return result as TStatus;
  }

  private resolveLiveResourceIdentityValue(value: unknown, spec: TSpec, fallback: string): string {
    if (isKubernetesRef(value)) {
      if (value.resourceId !== '__schema__') return fallback;

      const parts = value.fieldPath.replace(/^spec\./, '').split('.');
      let current: unknown = spec;
      for (const part of parts) {
        if (current == null || typeof current !== 'object') return fallback;
        current = (current as Record<string, unknown>)[part];
      }
      return current == null ? fallback : String(current);
    }

    if (typeof value !== 'string') return fallback;

    let resolved = value;
    if (resolved.includes('__KUBERNETES_REF___schema___')) {
      resolved = String(this.resolveSchemaRefMarkers(resolved, spec));
    }

    resolved = resolved.replace(
      /\$\{(?:string\()?schema\.spec\.([a-zA-Z0-9_.$]+)\)?\}/g,
      (_match, fieldPath: string) => {
        const parts = fieldPath.split('.');
        let current: unknown = spec;
        for (const part of parts) {
          if (current == null || typeof current !== 'object') {
            return _match;
          }
          current = (current as Record<string, unknown>)[part];
        }
        return String(current ?? '');
      }
    );

    return resolved === '' || resolved.includes('__KUBERNETES_REF_') || resolved.includes('${') ? fallback : resolved;
  }

  /**
   * Create an Enhanced proxy for the instance (backward compatibility method)
   */
  private async createEnhancedProxy(
    spec: TSpec,
    instanceName: string
  ): Promise<Enhanced<TSpec, TStatus>> {
    return this.createEnhancedProxyWithMixedHydration(spec, instanceName);
  }

  /**
   * Wait for Kro instance to be ready with Kro-specific logic.
   * Delegates to the shared `waitForKroInstanceReady` in `kro-readiness.ts`.
   */
  private async waitForKroInstanceReady(instanceName: string, timeout: number): Promise<void> {
    const apiVersion = this.getInstanceApiVersion();

    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    return waitForKroInstanceReadyShared({
      instanceName,
      timeout,
      k8sApi,
      customObjectsApi: this.getCustomObjectsApi(),
      namespace: this.namespace,
      apiVersion,
      kind: this.schemaDefinition.kind,
      rgdName: this.rgdName,
      factoryContext: this.name,
    });
  }

  /**
   * Hydrate dynamic status fields by evaluating CEL expressions against live Kro resource data
   */
  private async hydrateDynamicStatusFields(
    instanceName: string,
    dynamicFields: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const dynamicLogger = this.logger.child({ instanceName });

    // Get the live custom resource to extract dynamic status fields
    const apiVersion = this.getInstanceApiVersion();

    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
    const response = await k8sApi.read({
      apiVersion,
      kind: this.schemaDefinition.kind,
      metadata: {
        name: instanceName,
        namespace: this.namespace,
      },
    });

    // In the new API, methods return objects directly (no .body wrapper)
    const liveInstance = response as { status?: Record<string, unknown> };

    if (!liveInstance.status) {
      dynamicLogger.warn('No status found in live instance, returning empty dynamic fields');
      return {};
    }

    // For now, return the live instance status directly
    // In a full implementation, this would evaluate CEL expressions in dynamicFields
    // against the live Kro resource data and return the evaluated results

    // Extract only the fields that were marked as dynamic
    const hydratedFields: Record<string, unknown> = {};

    for (const [fieldName, _fieldValue] of Object.entries(dynamicFields)) {
      if (liveInstance.status[fieldName] !== undefined) {
        hydratedFields[fieldName] = liveInstance.status[fieldName];
      }
    }
    return hydratedFields;
  }
}

/**
 * Create a KroResourceFactory instance
 */
export function createKroResourceFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  name: string,
  resources: Record<string, KubernetesResource>,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  statusMappings: Record<string, unknown>,
  options: FactoryOptions = {}
): KroResourceFactory<TSpec, TStatus> {
  return new KroResourceFactoryImpl<TSpec, TStatus>(
    name,
    resources,
    schemaDefinition,
    statusMappings as MagicAssignableShape<TStatus>,
    options
  );
}
