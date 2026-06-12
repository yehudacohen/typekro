/**
 * Alchemy v2 KRO Resource Provider
 *
 * Exposes TypeKro KRO deploys as an alchemy **v2** custom resource. Under v2 a
 * resource is declarative: callers instantiate `KroResource` inside their alchemy
 * Stack and merge `kroProvider` (an Effect `Layer`) into their runtime's providers,
 * so the deployed RGD/instance joins the caller's unified alchemy state (reverse-topo
 * teardown + idempotent reconcile). This replaces the v1 (`alchemy@0.62`) integration,
 * which dynamically registered per-kind providers in a global `PROVIDERS` registry and
 * drove them imperatively via `scope.run(() => Provider(id, props))` — a model alchemy
 * v2 does not have.
 *
 * The Kubernetes machinery (`deployers`, `kro-delete`, client/deployer construction) is
 * alchemy-version-agnostic and reused verbatim; only the registration glue changed.
 */

import type { KubeConfig } from '@kubernetes/client-node';
import { Effect } from 'effect';
import * as Output from 'alchemy/Output';
import * as ProviderMod from 'alchemy/Provider';
import * as ResourceMod from 'alchemy/Resource';
import type { Resource as ResourceT } from 'alchemy/Resource';
import { DEFAULT_DEPLOYMENT_TIMEOUT } from '../core/config/defaults.js';
import { ensureError } from '../core/errors.js';
import { createKubernetesClientProvider } from '../core/kubernetes/client-provider.js';
import { getComponentLogger, type TypeKroLogger } from '../core/logging/index.js';
import { CEL_EXPRESSION_BRAND } from '../core/constants/brands.js';
import { createBunCompatibleKubernetesObjectApi } from '../core/kubernetes/index.js';
import { SINGLETON_SPEC_FINGERPRINT_ANNOTATION } from '../core/deployment/resource-tagging.js';
import { stableSerialize } from '../core/singleton/singleton.js';
import type { DeployedResource, DeploymentOptions } from '../core/types/deployment.js';
import type { Enhanced, KubernetesResource } from '../core/types/kubernetes.js';
import {
  DirectTypeKroDeployer,
  KroTypeKroDeployer,
  ResourceGraphDefinitionDeletionDeferredError,
} from './deployers.js';
import { deleteKroDefinition, deleteKroInstanceFinalizerSafe, hasKroInstances } from './kro-delete.js';
import type { KroDeletionOptions } from './kro-delete.js';
import type {
  AlchemyResourceDeclaration,
  SerializableKubeConfigOptions,
  TypeKroDeployer,
  TypeKroResource,
  TypeKroResourceProps,
} from './types.js';

/**
 * Serializable resource properties stored by Alchemy after deployment.
 * These are the clean, cloneable fields that represent deployed state.
 */
interface DeployedResourceProperties<T extends Enhanced<unknown, unknown>> {
  resource: T;
  resourceId?: string;
  namespace: string;
  // Persisted so `delete` can reconstruct how to reach + tear down the resource after a fresh
  // process rehydrates only the output (alchemy passes no `news` on a state-driven destroy).
  deploymentStrategy: 'direct' | 'kro';
  kubeConfigOptions?: SerializableKubeConfigOptions;
  kroDeletion?: KroDeletionOptions;
  deployedResource: T;
  ready: boolean;
  deployedAt: number;
}

/** The single alchemy v2 resource type for any TypeKro KRO resource (RGD or CR instance). */
export const KRO_RESOURCE_TYPE = 'TypeKro.KroResource' as const;

/**
 * The v2 resource shape: `TypeKroResourceProps` are the (serializable) inputs alchemy
 * persists + re-applies on reconcile; `TypeKroResource` is the deployed-state output.
 */
export type KroResourceR = ResourceT<
  typeof KRO_RESOURCE_TYPE,
  TypeKroResourceProps<Enhanced<unknown, unknown>>,
  TypeKroResource<Enhanced<unknown, unknown>>
>;

/**
 * The declarative v2 resource. Instantiate inside an alchemy Stack — one per RGD and one
 * per CR instance — e.g. `yield* KroResource(rgdId, { resource, namespace, deploymentStrategy: 'kro', … })`.
 * Order instances after their RGD (pass the RGD output through) so reverse-topo teardown
 * removes instances before the shared RGD.
 */
export const KroResource = ResourceMod.Resource<KroResourceR>(KRO_RESOURCE_TYPE);

/**
 * The provider `Layer` that backs {@link KroResource}. Merge into the runtime's providers
 * (alongside the cloud providers) so reconcile/delete run. `reconcile` is the single
 * convergent create/update (apply the manifest, wait for readiness); `delete` performs the
 * finalizer-safe, shared-RGD-aware teardown.
 */
export const kroProvider = ProviderMod.effect(
  KroResource,
  Effect.succeed({
    // `namespace` is identity-stable: a namespace change is a replacement, not an in-place update.
    stables: ['namespace'] as const,
    reconcile: Effect.fn(function* ({ news }: { news: TypeKroResourceProps<Enhanced<unknown, unknown>> }) {
      return yield* Effect.promise(() => deployKroResource(news));
    }),
    delete: Effect.fn(function* ({
      output,
      news,
    }: {
      output?: TypeKroResource<Enhanced<unknown, unknown>>;
      news?: TypeKroResourceProps<Enhanced<unknown, unknown>>;
    }) {
      // Prefer the live spec; fall back to reconstructing minimal props from persisted output
      // (a delete after the spec is gone — e.g. resource removed from the stack).
      const props = news ?? propsFromOutput(output);
      if (props) {
        yield* Effect.promise(() => deleteKroResource(props));
      } else {
        // Neither a live spec nor a usable output (e.g. a create that failed before persisting a
        // complete output). Warn rather than silently no-op so a possible leaked cluster object is
        // visible — there's nothing reconstructable to tear down here.
        getComponentLogger('alchemy-deployment')
          .child({ alchemyType: KRO_RESOURCE_TYPE })
          .warn('Skipping delete: no live spec and no reconstructable output to tear down', {
            hasOutput: !!output,
          });
      }
    }),
  })
);

/**
 * Instantiate a set of {@link AlchemyResourceDeclaration}s (from a factory's `toAlchemyResources`)
 * as `KroResource`s inside an alchemy Stack, wiring each declaration's `dependsOn` into alchemy
 * `Output` dependencies. This is what gives the fan-out its **ordering** (alchemy deploys a
 * resource only after every resource it `dependsOn` is ready) and, in direct mode, feeds each
 * dependency's resolved live state into the dependent's reconcile for cross-resource reference
 * resolution. Returns the map of declaration id → deployed output.
 *
 * ```ts
 * // inside a Stack/generator:
 * const outputs = yield* materializeAlchemyResources(KroResource, await factory.toAlchemyResources(spec));
 * ```
 *
 * Declarations must be topologically ordered (as `toAlchemyResources` returns them) so each
 * dependency's output exists before its dependents reference it.
 */
export function materializeAlchemyResources(
  kroResource: typeof KroResource,
  declarations: readonly AlchemyResourceDeclaration[]
) {
  return Effect.gen(function* () {
    // Keyed by declaration id → the instantiated alchemy resource HANDLE (what `Output.of` consumes
    // and what carries the dependency edge); its resolved attributes are a `TypeKroResource`.
    const handles: Record<string, KroResourceR> = {};
    for (const decl of declarations) {
      const deps = decl.dependsOn.map((id) => {
        const handle = handles[id];
        if (!handle) {
          // Declarations must be topologically ordered so every dependency is instantiated first.
          // A missing handle means an out-of-order/unknown id — fail loudly rather than silently
          // dropping the edge (which would cause a deploy-order race or unresolved reference).
          throw new Error(
            `materializeAlchemyResources: '${decl.id}' dependsOn '${id}', which is not (yet) instantiated. ` +
              `Declarations must be topologically ordered.`
          );
        }
        return handle;
      });
      // `Output.all([...Output.of(dep)])` both (a) creates the alchemy dependency edges so these
      // deploy first and (b) resolves to the concrete dependency outputs handed to `reconcile`.
      const props =
        deps.length > 0
          ? { ...decl.props, dependencies: Output.all(...deps.map((d) => Output.of(d))) }
          : decl.props;
      // Cast: `props` carries an `Output` for `dependencies` that the `KroResource` constructor
      // accepts as an `Input<…>` and alchemy resolves before reconcile — the field's static type
      // is the resolved (post-evaluation) shape.
      handles[decl.id] = yield* kroResource(
        decl.id,
        props as unknown as Parameters<typeof kroResource>[1]
      );
    }
    return handles;
  });
}

/**
 * Reconcile: deploy a single KRO resource (RGD or CR instance) and return its persisted state.
 * Convergent — alchemy calls this for both create and update; the deployer is idempotent apply.
 */
async function deployKroResource<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>
): Promise<TypeKroResource<T>> {
  const logger = getComponentLogger('alchemy-deployment').child({ alchemyType: KRO_RESOURCE_TYPE });
  // Singleton-owner spec-drift protection (the declarative analog of `assertNoDeployedSingletonSpecDrift`
  // in the imperative deploy path): refuse to clobber a shared singleton that already exists with a
  // different spec. Cluster-checked here since `toAlchemyResources` is intentionally cluster-free.
  await _assertNoSingletonDrift(props, logger);
  const { deployer, dispose } = await _resolveDeployer(props, 'deployment');
  try {
    // Direct mode: hand the deployer the live state of this resource's dependencies so the engine
    // resolves its cross-resource references + CEL expressions against them (the deps deployed
    // first via alchemy ordering). KRO docs are self-contained, so the seed is irrelevant there.
    const seedResources = _seedFromDependencies(props);
    // alchemy serializes props to state, flattening this resource's CEL refs to `${…}` STRINGS.
    // The engine resolver only evaluates CEL OBJECTS, so (direct mode, with dependency state to
    // resolve against) re-hydrate those strings into template CEL objects before deploying — but
    // ONLY strings that reference a known dependency id, so genuine `${…}` literals (e.g. a shell
    // `${HOME}` in an env var) are left untouched.
    const deployProps =
      seedResources && props.deploymentStrategy === 'direct'
        ? {
            ...props,
            resource: _rehydrateCelStrings(
              props.resource,
              new Set(seedResources.map((s) => s.id))
            ) as T,
          }
        : props;
    const { resourceProperties } = await _deployAndCreateResult(deployProps, deployer, seedResources);
    _logDeploymentSuccess(logger, KRO_RESOURCE_TYPE, props, resourceProperties);
    return resourceProperties as unknown as TypeKroResource<T>;
  } catch (error: unknown) {
    logger.error('Error deploying resource through Alchemy', ensureError(error));
    throw error;
  } finally {
    await dispose();
  }
}

/** The live singleton owner as seen for a drift check. */
interface LiveSingletonOwner {
  metadata?: { annotations?: Record<string, string> };
  spec?: unknown;
}

/**
 * Pure drift verdict (no I/O) for a singleton instance being deployed, given:
 *  - `expectedFingerprint`: the spec-fingerprint annotation on the resource being deployed,
 *  - `deployingSpec`: that resource's spec,
 *  - `live`: the existing same-named owner on the cluster (or undefined if none).
 *
 * Mirrors the imperative `assertNoDeployedSingletonSpecDrift`, INCLUDING its fallback: an existing
 * owner with NO fingerprint annotation (a legacy/unfingerprinted owner) is still verified by
 * comparing serialized specs — so a different-spec legacy owner is NOT silently accepted.
 */
export function singletonDriftVerdict(
  expectedFingerprint: string,
  deployingSpec: unknown,
  live: LiveSingletonOwner | undefined
): { drift: false } | { drift: true; reason: string } {
  if (!live) return { drift: false };
  const actual = live.metadata?.annotations?.[SINGLETON_SPEC_FINGERPRINT_ANNOTATION];
  if (actual === expectedFingerprint) return { drift: false };
  if (actual) {
    return { drift: true, reason: `existing fingerprint ${actual} does not match ${expectedFingerprint}` };
  }
  // Unfingerprinted (legacy) owner — fall back to comparing serialized specs.
  if (stableSerialize(live.spec) !== stableSerialize(deployingSpec)) {
    return { drift: true, reason: 'an existing unfingerprinted singleton owner has a different spec' };
  }
  return { drift: false };
}

/**
 * Refuse to deploy a singleton owner whose identity already exists on the cluster with a DIFFERENT
 * spec — the declarative-path equivalent of the imperative `assertNoDeployedSingletonSpecDrift`. Only
 * fires for resources carrying the singleton spec-fingerprint annotation (i.e. singleton instances);
 * a missing instance / absent CRD / unreachable cluster is treated as "nothing to drift from".
 */
async function _assertNoSingletonDrift<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  logger: TypeKroLogger
): Promise<void> {
  const resource = props.resource as {
    metadata?: { name?: string; annotations?: Record<string, string> };
    spec?: unknown;
  };
  const expected = resource.metadata?.annotations?.[SINGLETON_SPEC_FINGERPRINT_ANNOTATION];
  if (!expected) return; // not a fingerprinted singleton instance

  let live: LiveSingletonOwner | undefined;
  try {
    const kc = _createClientProvider(props, 'singleton-drift-check');
    const api = createBunCompatibleKubernetesObjectApi(kc);
    live = (await api.read(props.resource as Parameters<typeof api.read>[0])) as LiveSingletonOwner;
  } catch {
    return; // not found / CRD not yet created / cluster unreachable → no existing spec to clash with
  }

  const verdict = singletonDriftVerdict(expected, resource.spec, live);
  if (verdict.drift) {
    throw new Error(
      `Singleton config drift detected for ${resource.metadata?.name ?? '<unknown>'}: ${verdict.reason}. ` +
        'A singleton identity must not be deployed with multiple specs.'
    );
  }
  logger.debug('Singleton spec verified (no drift)', {
    name: resource.metadata?.name,
    fingerprint: expected,
  });
}

/**
 * Build the engine resolution seed (direct mode) from `props.dependencies`: each dependency output
 * carries its live `deployedResource` (apiVersion/kind + status) and its logical `resourceId` — the
 * id this resource's `KubernetesRef`s / CEL expressions (`${resourceId.field}`) point at. The engine
 * resolves against these without redeploying them.
 */
function _seedFromDependencies<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>
): DeployedResource[] | undefined {
  const deps = props.dependencies;
  if (props.deploymentStrategy !== 'direct' || !deps || deps.length === 0) return undefined;

  const seed = deps
    .filter((d): d is TypeKroResource<Enhanced<unknown, unknown>> => !!d?.deployedResource && !!d.resourceId)
    .map((d) => {
      const manifest = d.deployedResource as unknown as KubernetesResource;
      return {
        id: d.resourceId as string,
        kind: manifest.kind ?? 'Unknown',
        name: manifest.metadata?.name ?? 'unknown',
        namespace: manifest.metadata?.namespace ?? props.namespace,
        manifest,
        status: 'deployed',
        applied: true,
        deployedAt: new Date(0),
      } satisfies DeployedResource;
    });
  return seed.length > 0 ? seed : undefined;
}

/**
 * Deep-clone `value`, converting strings that contain a `${dependencyId.…}` placeholder into a
 * template {@link CelExpression} object so the engine resolver evaluates them (alchemy's state
 * serialization had flattened the original CEL objects to these strings). Only strings whose
 * placeholder references one of `seedIds` (this resource's dependencies) are converted — genuine
 * `${…}` literals that don't reference a dependency (e.g. a shell `${HOME}`) are left untouched.
 *
 * Template form means placeholders are resolved and string-concatenated; this is correct for the
 * string-valued fields (env/data/annotations) where cross-resource refs survive serialization. A
 * cross-resource ref in a NON-string field would be coerced to a string — an accepted limitation
 * of round-tripping CEL through serialized state.
 */
function _rehydrateCelStrings(value: unknown, seedIds: Set<string>): unknown {
  if (typeof value === 'string') {
    return _referencesSeed(value, seedIds)
      ? { [CEL_EXPRESSION_BRAND]: true, expression: value, __isTemplate: true }
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => _rehydrateCelStrings(v, seedIds));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = _rehydrateCelStrings(v, seedIds);
    }
    return out;
  }
  return value;
}

/** True if `s` contains a `${<id>.…}` placeholder whose leading identifier is a known dependency. */
function _referencesSeed(s: string, seedIds: Set<string>): boolean {
  if (!s.includes('${')) return false;
  const re = /\$\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let m: RegExpExecArray | null = re.exec(s);
  while (m !== null) {
    if (m[1] && seedIds.has(m[1])) return true;
    m = re.exec(s);
  }
  return false;
}

/**
 * Rebuild the minimal delete-time props from persisted output. The output carries the deployed
 * resource (with `metadata.labels['typekro.io/rgd']` for instances / `spec.schema` for RGDs),
 * which is all {@link inferKroDeletionOptions} + the deployer need to tear down finalizer-safe.
 */
function propsFromOutput<T extends Enhanced<unknown, unknown>>(
  output?: TypeKroResource<T>
): TypeKroResourceProps<T> | undefined {
  if (!output?.resource) return undefined;
  return {
    resource: output.resource,
    ...(output.resourceId !== undefined && { resourceId: output.resourceId }),
    namespace: output.namespace,
    deploymentStrategy: output.deploymentStrategy ?? 'kro',
    ...(output.kubeConfigOptions !== undefined && { kubeConfigOptions: output.kubeConfigOptions }),
    ...(output.kroDeletion !== undefined && { kroDeletion: output.kroDeletion }),
  };
}

/**
 * Create KubernetesClientProvider using centralized configuration management
 * Eliminates complex multi-stage fallback logic and consolidates TLS handling
 */
function _createClientProvider<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  phase: string
): KubeConfig {
  const alchemyLogger = getComponentLogger('alchemy-deployment');

  alchemyLogger.debug(`Creating KubernetesClientProvider for alchemy handler (${phase} phase)`, {
    hasKubeConfigOptions: !!props.kubeConfigOptions,
    skipTLSVerify: props.kubeConfigOptions?.skipTLSVerify,
    hasCluster: !!props.kubeConfigOptions?.cluster,
    hasUser: !!props.kubeConfigOptions?.user,
  });

  // Use the centralized KubernetesClientProvider with the provided configuration
  const clientProvider = createKubernetesClientProvider(props.kubeConfigOptions);

  // Get the configured KubeConfig from the provider
  const kubeConfig = clientProvider.getKubeConfig();

  alchemyLogger.debug(`KubernetesClientProvider created successfully (${phase} phase)`, {
    currentContext: kubeConfig.getCurrentContext(),
    server: kubeConfig.getCurrentCluster()?.server,
    skipTLSVerify: kubeConfig.getCurrentCluster()?.skipTLSVerify,
  });

  return kubeConfig;
}

/**
 * Create the appropriate deployer based on the deployment strategy
 */
async function _createDeployer<T extends Enhanced<unknown, unknown>>(
  kc: import('@kubernetes/client-node').KubeConfig,
  props: TypeKroResourceProps<T>
): Promise<TypeKroDeployer> {
  // Use dynamic import to avoid circular dependencies
  const { DirectDeploymentEngine } = await import('../core/deployment/engine.js');
  const engine = new DirectDeploymentEngine(kc);

  if (props.deploymentStrategy === 'direct') {
    return new DirectTypeKroDeployer(engine);
  }

  const kroDeletion = props.kroDeletion ?? inferKroDeletionOptions(props);
  return new KroTypeKroDeployer(engine, kroDeletion ? {
    deleteInstance: (name: string) => deleteKroInstanceFinalizerSafe(kc, name, kroDeletion),
    shouldSkipRgdDelete: () => hasKroInstances(kc, kroDeletion),
    deleteResourceGraphDefinition: () => deleteKroDefinition(kc, kroDeletion),
  } : {});
}

function fullApiVersion(apiVersion: unknown, group: unknown): string | undefined {
  if (typeof apiVersion !== 'string' || apiVersion.length === 0) return undefined;
  if (apiVersion.includes('/')) return apiVersion;
  return typeof group === 'string' && group.length > 0 ? `${group}/${apiVersion}` : apiVersion;
}

function apiGroup(apiVersion: unknown): string | undefined {
  return typeof apiVersion === 'string' && apiVersion.includes('/')
    ? apiVersion.split('/')[0]
    : undefined;
}

function inferKroDeletionOptions<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>
): KroDeletionOptions | undefined {
  if (props.deploymentStrategy !== 'kro') return undefined;

  const resource = props.resource as {
    apiVersion?: unknown;
    kind?: unknown;
    metadata?: {
      name?: unknown;
      namespace?: unknown;
      labels?: Record<string, unknown>;
    };
    spec?: { schema?: { apiVersion?: unknown; group?: unknown; kind?: unknown } };
  };

  if (resource.kind === 'ResourceGraphDefinition') {
    const schema = resource.spec?.schema;
    const apiVersion = fullApiVersion(schema?.apiVersion, schema?.group);
    if (
      typeof resource.metadata?.name !== 'string' ||
      typeof schema?.kind !== 'string' ||
      !apiVersion
    ) {
      return undefined;
    }

    return {
      apiVersion,
      kind: schema.kind,
      ...(typeof schema.group === 'string' && { group: schema.group }),
      namespace: typeof resource.metadata.namespace === 'string' ? resource.metadata.namespace : props.namespace,
      rgdName: resource.metadata.name,
      timeout: props.options?.timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
    };
  }

  const rgdName = resource.metadata?.labels?.['typekro.io/rgd'];
  if (
    typeof rgdName !== 'string' ||
    typeof resource.apiVersion !== 'string' ||
    typeof resource.kind !== 'string'
  ) {
    return undefined;
  }

  const group = apiGroup(resource.apiVersion);
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    ...(group && { group }),
    namespace: typeof resource.metadata?.namespace === 'string' ? resource.metadata.namespace : props.namespace,
    rgdName,
    timeout: props.options?.timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
  };
}

/** Internal test hook for legacy Alchemy KRO state rehydration. */
export const inferKroDeletionOptionsForTest = inferKroDeletionOptions;

async function _resolveDeployer<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  phase: string
): Promise<{ deployer: TypeKroDeployer; dispose: () => Promise<void> }> {
  if (props.deployer) {
    return { deployer: props.deployer, dispose: async () => {} };
  }

  const kc = _createClientProvider(props, phase);
  const deployer = await _createDeployer(kc, props);
  return {
    deployer,
    dispose: async () => {
      await deployer.dispose?.();
    },
  };
}

/**
 * Delete: tear down a single KRO resource finalizer-safe. Under v2 reverse-topo teardown,
 * CR instances are deleted before their RGD, so by the time an RGD's delete runs its
 * instances are gone. If the deployer still defers an RGD delete (a shared RGD that other
 * stacks' instances reference), we log and let alchemy drop the state entry — the orphaned
 * RGD is cluster-scoped and dies with the cluster; it must not wedge the destroy.
 */
async function deleteKroResource<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>
): Promise<void> {
  const logger = getComponentLogger('alchemy-deployment').child({ alchemyType: KRO_RESOURCE_TYPE });
  const { deployer, dispose } = await _resolveDeployer(props, 'delete');
  try {
    await deployer.delete(props.resource, {
      mode: 'alchemy' as const,
      namespace: props.namespace,
      ...props.options,
    });
  } catch (error: unknown) {
    if (error instanceof ResourceGraphDefinitionDeletionDeferredError) {
      logger.debug('Deferring ResourceGraphDefinition delete (still referenced); dropping state entry', {
        resourceName: props.resource.metadata?.name,
        reason: error.message,
      });
      return;
    }
    logger.error('Error deleting resource', ensureError(error));
    throw error;
  } finally {
    await dispose();
  }
}

/** Internal test hook for deletion semantics. */
export const deleteKroResourceForTest = deleteKroResource;

/**
 * Deploy resource and create deployment result
 */
async function _deployAndCreateResult<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  deployer: TypeKroDeployer,
  seedResources?: DeployedResource[]
): Promise<{ resourceProperties: DeployedResourceProperties<T> }> {
  const deploymentOptions = buildAlchemyDeploymentOptions(props);

  // Deploy using the created deployer. The deployer/engine resolves references + CEL expressions,
  // seeded (direct mode) with dependencies' live state so cross-resource refs resolve.
  const deployedResource = await deployer.deploy(props.resource, deploymentOptions, seedResources);

  // Create clean, serializable versions for Alchemy storage.
  // We use JSON.parse(JSON.stringify()) deliberately instead of structuredClone because:
  // 1. Enhanced<> resources contain non-cloneable values (Symbols like pino.chindings,
  //    KUBERNETES_REF_BRAND, plus functions like readinessEvaluator) that cause
  //    structuredClone to throw "Cannot serialize unique symbol" errors.
  // 2. JSON round-trip strips symbols, functions, and undefined values — which is
  //    exactly the behavior we want for creating clean Alchemy state entries.
  const cleanResource = JSON.parse(JSON.stringify(props.resource)) as T;
  const cleanDeployedResource = JSON.parse(JSON.stringify(deployedResource)) as T;

  // Create the resource properties for Alchemy
  const resourceProperties: DeployedResourceProperties<T> = {
    resource: cleanResource,
    ...(props.resourceId !== undefined && { resourceId: props.resourceId }),
    namespace: props.namespace,
    deploymentStrategy: props.deploymentStrategy,
    ...(props.kubeConfigOptions !== undefined && { kubeConfigOptions: props.kubeConfigOptions }),
    ...(props.kroDeletion !== undefined && { kroDeletion: props.kroDeletion }),
    deployedResource: cleanDeployedResource,
    ready: true,
    deployedAt: Date.now(),
  };

  return { resourceProperties };
}

export function buildAlchemyDeploymentOptions<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>
): DeploymentOptions {
  const {
    waitForReady,
    timeout,
    ...deploymentMetadataOptions
  } = props.options ?? {};

  return {
    mode: 'alchemy' as const,
    namespace: props.namespace,
    ...deploymentMetadataOptions,
    waitForReady: waitForReady ?? true,
    timeout: timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
  };
}

/**
 * Log deployment success.
 */
function _logDeploymentSuccess<T extends Enhanced<unknown, unknown>>(
  logger: TypeKroLogger,
  alchemyType: string,
  props: TypeKroResourceProps<T>,
  resourceProperties: DeployedResourceProperties<T>
): void {
  logger.debug('Successfully deployed resource through Alchemy', {
    alchemyType,
    resourceKind: props.resource.kind,
    resourceName: props.resource.metadata?.name,
    namespace: props.namespace,
    resourceProperties: {
      hasResource: !!resourceProperties.resource,
      hasNamespace: !!resourceProperties.namespace,
      hasDeployedResource: !!resourceProperties.deployedResource,
      ready: resourceProperties.ready,
      deployedAt: resourceProperties.deployedAt,
    },
  });
}
