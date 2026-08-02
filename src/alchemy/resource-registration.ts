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
import * as Diff from 'alchemy/Diff';
import type { Input } from 'alchemy/Input';
import * as Output from 'alchemy/Output';
import * as ProviderMod from 'alchemy/Provider';
import type { Resource as ResourceT } from 'alchemy/Resource';
import * as ResourceMod from 'alchemy/Resource';
import { Effect } from 'effect';
import * as Redacted from 'effect/Redacted';
import { DEFAULT_DEPLOYMENT_TIMEOUT } from '../core/config/defaults.js';
import { CEL_EXPRESSION_BRAND } from '../core/constants/brands.js';
import { migrateLegacyKroArtifactBindingCrd } from '../core/deployment/kro-artifact-binding-migration.js';
import { isNotFoundError } from '../core/deployment/k8s-helpers.js';
import {
  decideNamespaceOwnershipCreateFirst,
  deleteNamespaceIfEmpty,
  HOISTED_NAMESPACES_ANNOTATION,
  listNamespacesOwnedByRgd,
  NAMESPACE_OWNER_ANNOTATION,
  readHoistedNamespacesRecord,
} from '../core/deployment/kro-namespace-teardown.js';
import { SINGLETON_SPEC_FINGERPRINT_ANNOTATION } from '../core/deployment/resource-tagging.js';
import { materializeSerializableKubeConfigOptions } from '../core/deployment/shared-utilities.js';
import {
  type DeployedSingletonInstance as LiveSingletonOwner,
  singletonDriftVerdict,
} from '../core/deployment/singleton-owner-drift.js';
import { ensureError } from '../core/errors.js';
import { createKubernetesClientProvider } from '../core/kubernetes/client-provider.js';
import {
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
} from '../core/kubernetes/index.js';
import { getComponentLogger, type TypeKroLogger } from '../core/logging/index.js';
import {
  copyResourceMetadata,
  getReadinessEvaluator,
  getResourceScope,
  type ResourceScope,
  setMetadataField,
  setReadinessEvaluator,
  setResourceId,
} from '../core/metadata/index.js';
import {
  collectArtifactOutputUses,
  decodeDirectArtifactExecutionRecord,
  decodeKroArtifactBundle,
  materializeDirectArtifactManifest,
  materializeKroArtifactBundleOperation,
  planValueSensitiveBindingNames,
} from '../core/planning/index.js';
import { resolvePortableReadinessStrategy } from '../core/readiness/portable-strategies.js';
import type { DeployedResource, DeploymentOptions } from '../core/types/deployment.js';
import type { Enhanced, KubernetesResource } from '../core/types/kubernetes.js';
import {
  DirectTypeKroDeployer,
  KroTypeKroDeployer,
  ResourceGraphDefinitionDeletionDeferredError,
} from './deployers.js';
import type { KroDeletionOptions } from './kro-delete.js';
import {
  deleteKroDefinition,
  deleteKroInstanceFinalizerSafe,
  hasKroInstances,
} from './kro-delete.js';
import type {
  AlchemyResourceDeclaration,
  MaterializeAlchemyResourcesOptions,
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
  artifactExecutionRecord?: string;
  kroArtifactBundle?: string;
  kroArtifactOperationId?: string;
  namespace: string;
  // Persisted so `delete` can reconstruct how to reach + tear down the resource after a fresh
  // process rehydrates only the output (alchemy passes no `news` on a state-driven destroy).
  deploymentStrategy: 'direct' | 'kro';
  kubeConfigOptions?: SerializableKubeConfigOptions;
  kroDeletion?: KroDeletionOptions;
  retain?: boolean;
  namespaceEmptyGate?: boolean;
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
  // Typed so the service literal is checked directly against `ProviderService` (methods bivariant) —
  // avoids the exactOptionalPropertyTypes friction of an inferred literal while keeping the effect-hosted
  // registration the conformance boundary requires.
  Effect.succeed<ProviderMod.ProviderService<KroResourceR>>({
    // `namespace` is identity-stable: a namespace change is a replacement, not an in-place update.
    stables: ['namespace'],
    // Account-wide enumeration (powers `alchemy nuke`). A generic KRO resource isn't discoverable
    // cluster-wide from props alone — TypeKro manages teardown through its own `delete` lifecycle —
    // so this reports nothing to nuke rather than guessing (required by alchemy beta.58's ProviderService).
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (Diff.isResolved(news) && olds.namespace !== news.namespace) {
        return { action: 'replace' as const };
      }
      return yield* Effect.tryPromise({
        try: () => detectKroResourceIdentityDrift(olds, output),
        catch: ensureError,
      });
    }),
    reconcile: Effect.fn(function* ({ news }) {
      return yield* Effect.tryPromise({
        try: (abortSignal) => deployKroResource(news, abortSignal),
        catch: ensureError,
      });
    }),
    delete: Effect.fn(function* ({ output, olds }) {
      // Prefer the live spec (`olds` — the last-applied props; alchemy beta.58 renamed the delete
      // input's spec field from `news` to `olds`); fall back to reconstructing minimal props from
      // persisted output (a delete after the spec is gone — e.g. resource removed from the stack).
      const props = olds ?? propsFromOutput(output);
      if (props) {
        yield* Effect.tryPromise({
          try: (abortSignal) => deleteKroResource(props, abortSignal),
          catch: ensureError,
        });
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
  declarations: readonly AlchemyResourceDeclaration[],
  options: MaterializeAlchemyResourcesOptions = {}
): Effect.Effect<Record<string, KroResourceR>, never, ProviderMod.Provider<KroResourceR>> {
  return Effect.gen(function* () {
    // Keyed by declaration id → the instantiated alchemy resource HANDLE (what `Output.of` consumes
    // and what carries the dependency edge); its resolved attributes are a `TypeKroResource`.
    const handles: Record<string, KroResourceR> = {};
    for (const decl of declarations) {
      if (Object.hasOwn(handles, decl.id)) {
        throw new Error(
          `materializeAlchemyResources: duplicate declaration id '${decl.id}' in one materialization call.`
        );
      }
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
      const artifactRequirements =
        decl.artifactRequirements ?? decl.props.artifactRequirements ?? [];
      const artifactOutputUses = decl.artifactOutputUses ?? decl.props.artifactOutputUses ?? [];
      const artifactOutputs =
        artifactOutputUses.length > 0
          ? alchemyArtifactOutputs(artifactRequirements, artifactOutputUses, options)
          : undefined;
      // `Output.all([...Output.of(dep)])` both (a) creates the alchemy dependency edges so these
      // deploy first and (b) resolves to the concrete dependency outputs handed to `reconcile`.
      const props = {
        ...decl.props,
        ...(deps.length > 0 ? { dependencies: Output.all(...deps.map((d) => Output.of(d))) } : {}),
        ...(artifactOutputs ? { artifactOutputs } : {}),
      };
      // Cast: `props` carries an `Output` for `dependencies` that the `KroResource` constructor
      // accepts as an `Input<…>` and alchemy resolves before reconcile — the field's static type
      // is the resolved (post-evaluation) shape.
      //
      // Target the PLAIN-props overload explicitly. `Parameters<typeof kroResource>[1]` resolves to
      // the LAST call signature — the one taking `Effect<InputProps<…>, never, PropsReq>` — so casting
      // to it selected the Effect-props overload and returned `Effect<R, never, PropsReq | Req>` with
      // `PropsReq` unresolved, leaking `unknown` into this function's public requirement channel.
      handles[decl.id] = yield* kroResource(
        decl.id,
        props as unknown as { [K in keyof KroResourceR['Props']]: Input<KroResourceR['Props'][K]> }
      );
    }
    return handles;
  });
}

function alchemyArtifactOutputs(
  requirements: readonly import('../core/planning/types.js').ArtifactRequirement[],
  uses: readonly import('../core/planning/types.js').ArtifactOutputUse[],
  options: MaterializeAlchemyResourcesOptions
) {
  const requirementsById = new Map(
    requirements.map((requirement) => [requirement.id, requirement])
  );
  const uniqueUses = new Map<string, (typeof uses)[number]>();
  for (const use of uses) {
    const key = `${use.requirementId}\u0000${use.output}`;
    const prior = uniqueUses.get(key);
    uniqueUses.set(key, { ...use, sensitive: use.sensitive || prior?.sensitive === true });
  }
  const expressions: ReturnType<typeof Output.asOutput>[] = [];
  const layout: Array<{ requirementId: string; output: string; sensitive: boolean }> = [];
  const handles = new Set<string>();

  for (const use of uniqueUses.values()) {
    const requirement = requirementsById.get(use.requirementId);
    if (!requirement || !requirement.outputs.includes(use.output)) {
      throw new Error(
        `materializeAlchemyResources: declaration uses undeclared artifact output ${use.requirementId}.${use.output}.`
      );
    }
    const binding = options.artifacts?.[use.requirementId];
    if (!binding) {
      throw new Error(
        `materializeAlchemyResources: artifact requirement '${use.requirementId}' was not supplied.`
      );
    }
    if (!Object.hasOwn(binding.outputs, use.output)) {
      throw new Error(
        `materializeAlchemyResources: artifact binding '${use.requirementId}' has no '${use.output}' output.`
      );
    }
    if (!handles.has(use.requirementId)) {
      expressions.push(Output.of(binding.resource) as ReturnType<typeof Output.asOutput>);
      layout.push({ requirementId: use.requirementId, output: '', sensitive: false });
      handles.add(use.requirementId);
    }
    expressions.push(Output.asOutput(binding.outputs[use.output]));
    layout.push(use);
  }

  return Output.map(Output.all(...expressions), (resolved) => {
    const outputs: Record<string, Record<string, unknown>> = {};
    (resolved as readonly unknown[]).forEach((value, index) => {
      const item = layout[index];
      if (!item || item.output.length === 0) return;
      const requirementOutputs = outputs[item.requirementId] ?? {};
      requirementOutputs[item.output] = item.sensitive ? Redacted.make(value) : value;
      outputs[item.requirementId] = requirementOutputs;
    });
    return outputs;
  });
}

/**
 * Reconcile: deploy a single KRO resource (RGD or CR instance) and return its persisted state.
 * Convergent — alchemy calls this for both create and update; the deployer is idempotent apply.
 */
async function deployKroResource<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  abortSignal?: AbortSignal,
  dependencies: {
    migrateLegacyArtifactBindings?: typeof migrateLegacyKroArtifactBindingCrd;
    kubeConfigForMigration?: () => KubeConfig;
  } = {}
): Promise<TypeKroResource<T>> {
  abortSignal?.throwIfAborted();
  const logger = getComponentLogger('alchemy-deployment').child({ alchemyType: KRO_RESOURCE_TYPE });
  // Fail-closed PRE-HOIST guard on the ALCHEMY path (finding #7): before applying a
  // typekro-hoisted workload Namespace, refuse to proceed if it is still a KRO ApplySet
  // member from a pre-hoist RGD — rolling the new hoisted RGD over the old one would let
  // KRO's prune delete it. Cluster-checked here since `toAlchemyResources` is cluster-free.
  await _assertNoPreHoistNamespaceConflictAlchemy(props, logger);
  abortSignal?.throwIfAborted();
  // Singleton-owner spec-drift protection (the declarative analog of `assertNoDeployedSingletonSpecDrift`
  // in the imperative deploy path): refuse to clobber a shared singleton that already exists with a
  // different spec. Cluster-checked here since `toAlchemyResources` is intentionally cluster-free.
  await _assertNoSingletonDrift(props, logger);
  abortSignal?.throwIfAborted();
  // finding #2 (adopted-namespace): the hoisted workload Namespace is stamped
  // owned-by-this-RGD at BUILD time (cluster-free). READ the live namespace here and
  // KEEP that stamp ONLY when typekro actually creates it (404) or already owns it;
  // otherwise strip it so teardown never deletes a namespace typekro merely adopted.
  const effectiveProps = await _preserveHoistedNamespaceAdoption(props, logger);
  abortSignal?.throwIfAborted();
  const { deployer, dispose } = await _resolveDeployer(effectiveProps, 'deployment');
  try {
    // Direct mode: hand the deployer the live state of this resource's dependencies so the engine
    // resolves its cross-resource references + CEL expressions against them (the deps deployed
    // first via alchemy ordering). KRO docs are self-contained, so the seed is irrelevant there.
    const seedResources = _seedFromDependencies(effectiveProps);
    // New direct declarations carry a canonical per-resource execution record. Decode that record
    // to restore structured references and runtime metadata without interpreting flattened YAML or
    // JSON strings. The scanner branch remains only for legacy Alchemy state created before these
    // records existed.
    let resourceForDeploy: T =
      _resourceFromKroArtifactBundle(effectiveProps) ??
      _resourceFromDirectArtifactRecord(effectiveProps) ??
      unwrapAlchemyRedactedResource(effectiveProps.resource);
    if (
      resourceForDeploy === effectiveProps.resource &&
      seedResources &&
      effectiveProps.deploymentStrategy === 'direct'
    ) {
      resourceForDeploy = _rehydrateCelStrings(
        effectiveProps.resource,
        new Set(seedResources.map((s) => s.id))
      ) as T;
    } else if (
      effectiveProps.deploymentStrategy === 'kro' &&
      (resourceForDeploy as { kind?: string }).kind === 'ResourceGraphDefinition' &&
      !getReadinessEvaluator(resourceForDeploy)
    ) {
      const { resourceGraphDefinition } = await import(
        '../factories/kro/resource-graph-definition.js'
      );
      const wrapped = resourceGraphDefinition(
        resourceForDeploy as unknown as Record<string, unknown>
      ) as unknown as T;
      copyResourceMetadata(resourceForDeploy, wrapped);
      resourceForDeploy = wrapped;
    } else if (
      effectiveProps.deploymentStrategy === 'kro' &&
      (resourceForDeploy as { kind?: string }).kind !== 'ResourceGraphDefinition'
    ) {
      // KRO CR instance (the custom resource an RGD defines — not the RGD itself). After alchemy
      // serializes props to state, the resource is a plain manifest with no readiness evaluator, so a
      // `waitForReady` deploy throws "No readiness evaluator found for <Kind>". Re-wrap it with
      // `kroCustomResource`, whose evaluator gates on the CR's KRO status reaching ACTIVE (Ready /
      // InstanceSynced) — the same KRO-instance readiness the imperative deploy path waits on. The RGD
      // is excluded (it carries its own evaluator via the resourceGraphDefinition factory).
      const { kroCustomResource } = await import('../factories/kro/kro-custom-resource.js');
      const r = resourceForDeploy as {
        apiVersion?: string;
        kind?: string;
        metadata?: { name: string; namespace?: string };
        spec?: unknown;
      };
      const wrapped = kroCustomResource({
        apiVersion: r.apiVersion ?? '',
        kind: r.kind ?? '',
        metadata: { ...(r.metadata ?? { name: '' }) },
        spec: (r.spec ?? {}) as Record<string, unknown>,
      }) as unknown as T;
      copyResourceMetadata(resourceForDeploy, wrapped);
      resourceForDeploy = wrapped;
    }
    if (
      effectiveProps.deploymentStrategy === 'kro' &&
      (resourceForDeploy as { kind?: string }).kind === 'ResourceGraphDefinition'
    ) {
      await (
        dependencies.migrateLegacyArtifactBindings ?? migrateLegacyKroArtifactBindingCrd
      )(
        dependencies.kubeConfigForMigration?.() ??
          _createClientProvider(effectiveProps, 'artifact-binding-migration'),
        resourceForDeploy as unknown as KubernetesResource
      );
    }
    const deployProps =
      resourceForDeploy === effectiveProps.resource
        ? effectiveProps
        : { ...effectiveProps, resource: resourceForDeploy };
    const { resourceProperties } = await _deployAndCreateResult(
      deployProps,
      deployer,
      seedResources,
      abortSignal
    );
    _logDeploymentSuccess(logger, KRO_RESOURCE_TYPE, effectiveProps, resourceProperties);
    return resourceProperties as unknown as TypeKroResource<T>;
  } catch (error: unknown) {
    logger.error('Error deploying resource through Alchemy', ensureError(error));
    throw error;
  } finally {
    await dispose();
  }
}

/**
 * Exercise the complete Alchemy reconcile path while substituting only the
 * cluster migration operation. Kept test-only so production callers continue
 * through the Effect provider above.
 */
export const deployKroResourceForTest = deployKroResource;

interface KroResourceIdentityReader {
  read(resource: KubernetesResource): Promise<KubernetesResource>;
}

/**
 * Check persisted Alchemy state against the Kubernetes API before Alchemy
 * decides that an unchanged TypeKro resource is a no-op.
 *
 * Alchemy invokes provider.read() only when state is absent. This diff check
 * closes the complementary persisted-state case: an out-of-band deletion,
 * replacement, or in-progress deletion must drive the normal convergent
 * reconcile path. Authored desired-property changes remain Alchemy's normal
 * prop-diff responsibility; controller-owned status evolution stays a no-op.
 * A non-404 read failure is never evidence of drift absence and fails closed.
 */
async function detectKroResourceIdentityDrift(
  props: TypeKroResourceProps<Enhanced<unknown, unknown>>,
  output: TypeKroResource<Enhanced<unknown, unknown>> | undefined,
  reader?: KroResourceIdentityReader
): Promise<{ readonly action: 'update' } | undefined> {
  const prior = output?.deployedResource;
  if (!prior) return { action: 'update' };
  const identity: KubernetesResource = {
    apiVersion: prior.apiVersion,
    kind: prior.kind,
    metadata: {
      name: prior.metadata?.name ?? '',
      ...(prior.metadata?.namespace
        ? { namespace: prior.metadata.namespace }
        : {}),
    },
  };
  if (!identity.metadata.name) return { action: 'update' };

  const liveReader = reader ?? (() => {
    const provider = _createClientProvider(props, 'alchemy-drift-check');
    const api = createBunCompatibleKubernetesObjectApi(provider);
    return {
      read: async (resource: KubernetesResource) =>
        (await api.read(
          resource as Parameters<typeof api.read>[0],
        )) as KubernetesResource,
    };
  })();

  let live: KubernetesResource;
  try {
    live = await liveReader.read(identity);
  } catch (error: unknown) {
    if (isNotFoundError(error)) return { action: 'update' };
    throw new Error(
      `Alchemy drift check could not read ${identity.apiVersion}/${identity.kind} `
      + `${identity.metadata.namespace ? `${identity.metadata.namespace}/` : ''}`
      + `${identity.metadata.name}: ${ensureError(error).message}`,
    );
  }

  const priorUid = prior.metadata?.uid;
  const liveUid = live.metadata?.uid;
  if (
    typeof priorUid === 'string'
    && typeof liveUid === 'string'
    && priorUid !== liveUid
  ) {
    return { action: 'update' };
  }
  if (live.metadata?.deletionTimestamp) return { action: 'update' };

  return undefined;
}

/** Test hook for persisted-state Kubernetes drift decisions. */
export const detectKroResourceIdentityDriftForTest =
  detectKroResourceIdentityDrift;

export { singletonDriftVerdict } from '../core/deployment/singleton-owner-drift.js';

/**
 * Refuse to deploy a singleton owner whose identity already exists on the cluster with a DIFFERENT
 * spec — the declarative-path equivalent of the imperative `assertNoDeployedSingletonSpecDrift`. Only
 * fires for resources carrying the singleton spec-fingerprint annotation (i.e. singleton instances);
 * a missing instance / absent CRD / unreachable cluster is treated as "nothing to drift from".
 */
/**
 * Fail-closed PRE-HOIST detection for the ALCHEMY deploy path (finding #7). Runs ONLY
 * for a typekro-hoisted workload Namespace (`namespaceEmptyGate`). If the live namespace
 * is a KRO ApplySet member (carries `applyset.kubernetes.io/part-of` or any `kro.run/*`
 * label from a pre-hoist RGD), applying the new hoisted RGD would let KRO's prune delete
 * it — so THROW. A 404 (fresh) is safe; any OTHER read error FAILS CLOSED (throws).
 */
async function _assertNoPreHoistNamespaceConflictAlchemy<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  logger: TypeKroLogger
): Promise<void> {
  if (props.namespaceEmptyGate !== true) return;
  const incoming = props.resource.metadata?.name;
  if (typeof incoming !== 'string' || incoming.length === 0) return;

  const kc = _createClientProvider(props, 'pre-hoist-check');
  const api = createBunCompatibleKubernetesObjectApi(kc);

  // The set of namespaces to check: the incoming one PLUS every EXISTING instance's
  // namespace (finding #7). An upgrade prunes the ApplySet for ALL instances of the
  // shared RGD at once, so missing one would let KRO delete it.
  const namespacesToCheck = new Set<string>([incoming]);
  for (const ns of await _existingInstanceNamespacesAlchemy(props, kc, logger)) {
    namespacesToCheck.add(ns);
  }

  for (const name of namespacesToCheck) {
    let labels: Record<string, string> = {};
    try {
      const live = (await api.read({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name },
      } as Parameters<typeof api.read>[0])) as { metadata?: { labels?: Record<string, string> } };
      labels = live.metadata?.labels ?? {};
    } catch (error: unknown) {
      const k8sErr = error as { statusCode?: number; code?: number; body?: { code?: number } };
      const code = k8sErr.statusCode ?? k8sErr.code ?? k8sErr.body?.code;
      if (code === 404) continue; // fresh namespace — nothing to migrate
      // FAIL CLOSED: a non-404 read error means we cannot prove the namespace is safe.
      throw new Error(
        `Pre-hoist safety check could not read Namespace "${name}" (${ensureError(error).message}). ` +
          `Refusing to deploy: a hoist over an unreadable namespace could let KRO's ApplySet prune delete it.`
      );
    }

    const partOfKro =
      typeof labels['applyset.kubernetes.io/part-of'] === 'string' ||
      Object.keys(labels).some((key) => key.startsWith('kro.run/'));
    if (partOfKro) {
      throw new Error(
        `Pre-hoist deployment detected: the live Namespace "${name}" is a KRO ApplySet member ` +
          `(carries applyset.kubernetes.io/part-of and/or kro.run/* labels from a pre-hoist RGD). ` +
          `typekro now HOISTS every owned Namespace out of the RGD, so applying the new RGD in place ` +
          `would drop "${name}" from KRO's ApplySet and KRO's prune would DELETE it and its workloads. ` +
          `This upgrade is not auto-migrated — see docs/advanced/migration.md.`
      );
    }
  }
  logger.debug('Pre-hoist namespace check passed (alchemy)', {
    namespaces: [...namespacesToCheck],
  });
}

/**
 * The namespaces of EVERY existing instance of the shared RGD (finding #7, alchemy).
 * Discovers the generated CRD from {@link TypeKroResourceProps.namespacePreHoistQuery},
 * lists instances cluster-wide, and returns each instance's namespace.
 *
 * FAIL CLOSED: a CRD-discovery or instance-list FAILURE (RBAC/connectivity) is NOT proof
 * of absence — it THROWS. Only a successful CRD list with no matching CRD (fresh cluster),
 * or a definitive 404 listing instances, yields an empty set.
 *
 * NAMESPACE RESOLUTION (finding #1, v7 — per-instance exact or fail closed): each existing
 * instance's namespaces are resolved EXACTLY and PER INSTANCE from that instance's OWN CR
 * `typekro.io/hoisted-namespaces` record — the only per-instance proof. An instance that
 * lacks its own record (a genuinely-legacy deployment) FAILS CLOSED (throws): the RGD-wide
 * set of Namespaces carrying `typekro.io/created-by-rgd == props.namespaceOwnerRgd` is NOT
 * per-instance proof — a DIFFERENT (modern) instance could have stamped it, so a non-empty
 * RGD-wide set would MASK a legacy instance whose own — possibly different — namespace is
 * then invisible and pruned. We never approximate from `metadata.namespace` / `spec.namespace`.
 * The RGD-wide set IS unioned into the returned protected set (a superset catching leaked
 * namespaces) — it just never SATISFIES the per-instance check. The incoming namespace is
 * always checked directly by the caller regardless.
 */
/**
 * Injectable API surface for {@link _existingInstanceNamespacesAlchemy} — lets the
 * deterministic unit test supply mocks instead of a live cluster. Production passes
 * nothing and the Bun-compatible clients are constructed from the KubeConfig.
 */
interface AlchemyPreHoistDeps {
  objectApi?: {
    list(apiVersion: string, kind: string): Promise<unknown>;
  };
  customApi?: {
    listClusterCustomObject(request: { group: string; version: string; plural: string }): Promise<{
      items?: Array<{
        metadata?: { namespace?: unknown; annotations?: Record<string, string> };
        spec?: unknown;
      }>;
    }>;
  };
  /** The NamespaceListApi passed to {@link listNamespacesOwnedByRgd}. */
  ownedNamespaceListApi?: Parameters<typeof listNamespacesOwnedByRgd>[2] extends infer O
    ? O extends { k8sApi?: infer A }
      ? A
      : never
    : never;
}

async function _existingInstanceNamespacesAlchemy<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  kc: KubeConfig,
  logger: TypeKroLogger,
  deps: AlchemyPreHoistDeps = {}
): Promise<Set<string>> {
  const result = new Set<string>();
  const query = props.namespacePreHoistQuery;
  if (!query) return result;

  // STRICT CRD discovery — a list failure FAILS CLOSED (throws).
  const objectApi = deps.objectApi ?? createBunCompatibleKubernetesObjectApi(kc);
  const crds = (await objectApi.list(
    'apiextensions.k8s.io/v1',
    'CustomResourceDefinition'
  )) as unknown as {
    items?: Array<{ spec?: { group?: string; names?: { kind?: string; plural?: string } } }>;
  };
  const match = crds?.items?.find(
    (crd) => crd.spec?.group === query.group && crd.spec?.names?.kind === query.kind
  );
  const plural = match?.spec?.names?.plural;
  if (!plural) return result; // definitively fresh — no CRD, so no existing instances

  let items: Array<{
    metadata?: { namespace?: unknown; annotations?: Record<string, string> };
    spec?: unknown;
  }>;
  try {
    const customApi =
      deps.customApi ??
      (createBunCompatibleCustomObjectsApi(kc) as unknown as {
        listClusterCustomObject(request: {
          group: string;
          version: string;
          plural: string;
        }): Promise<{
          items?: Array<{
            metadata?: { namespace?: unknown; annotations?: Record<string, string> };
            spec?: unknown;
          }>;
        }>;
      });
    const listResponse = await customApi.listClusterCustomObject({
      group: query.group,
      version: query.version,
      plural,
    });
    items = listResponse.items ?? [];
  } catch (error: unknown) {
    const k8sErr = error as { statusCode?: number; code?: number; body?: { code?: number } };
    const status = k8sErr.statusCode ?? k8sErr.code ?? k8sErr.body?.code;
    if (status === 404) return result; // CRD/instances vanished — fresh
    throw new Error(
      `Pre-hoist safety check could not list existing instances of the RGD's CRD ` +
        `(${ensureError(error).message}). Refusing to deploy: another instance's namespace could ` +
        `be pruned by the hoist without being checked.`
    );
  }

  if (items.length === 0) return result;

  // The RGD-wide record of every namespace this RGD created: namespaces carrying
  // `typekro.io/created-by-rgd == props.namespaceOwnerRgd`. We union it into the PROTECTED set
  // as a superset (it catches namespaces leaked by an interrupted teardown), but it is NOT
  // used to satisfy the per-instance check below (finding #1, v7) — being RGD-wide it cannot
  // prove a SPECIFIC instance's namespaces. A list error FAILS CLOSED.
  const ownerRgd = props.namespaceOwnerRgd;
  const ownedNamespaces = new Set<string>();
  if (typeof ownerRgd === 'string' && ownerRgd.length > 0) {
    let owned: string[];
    try {
      owned = await listNamespacesOwnedByRgd(kc, ownerRgd, {
        logger,
        ...(deps.ownedNamespaceListApi ? { k8sApi: deps.ownedNamespaceListApi } : {}),
      });
    } catch (error: unknown) {
      throw new Error(
        `Pre-hoist safety check could not list namespaces owned by RGD "${ownerRgd}" ` +
          `(${ensureError(error).message}). Refusing to deploy: without the durable ownership ` +
          `record we cannot prove the hoist won't prune an existing instance's namespace.`
      );
    }
    for (const ns of owned) ownedNamespaces.add(ns);
    for (const ns of ownedNamespaces) result.add(ns);
  }

  for (const item of items) {
    // Resolve THIS instance's namespaces from its OWN exact PER-INSTANCE record — the CR
    // `typekro.io/hoisted-namespaces` annotation (finding #1, v7). It carries the instance's
    // EXACT hoisted names (a name derived from an arbitrary spec field round-trips) and is the
    // ONLY per-instance proof.
    const record = readHoistedNamespacesRecord(
      item.metadata?.annotations?.[HOISTED_NAMESPACES_ANNOTATION]
    );
    if (record.status === 'present') {
      // A VALID record — including an explicit empty `[]` — is per-instance proof: this instance
      // hoists exactly these namespaces (possibly none). Resolved; do NOT fail closed.
      for (const ns of record.names) result.add(ns);
      continue;
    }
    // MISSING or MALFORMED record → NO per-instance exact record. FAIL CLOSED (finding #1, v7). We do NOT
    // fall back to the RGD-wide `created-by-rgd` set: being RGD-wide it is not per-instance
    // proof — a DIFFERENT (modern) instance could have stamped it, so a non-empty set would
    // MASK this legacy instance whose own — possibly different — owned namespace is then
    // invisible and pruned. Nor do we approximate from metadata.namespace / spec.namespace.
    throw new Error(
      `Pre-hoist safety check found an existing instance with no per-instance namespace record — ` +
        `its CR carries no "${HOISTED_NAMESPACES_ANNOTATION}" annotation. The RGD-wide ` +
        `"${NAMESPACE_OWNER_ANNOTATION}${ownerRgd ? `=${ownerRgd}` : ''}" set is NOT per-instance ` +
        `proof (another instance could have stamped it), so this instance's own owned namespace ` +
        `could be pruned by the hoist unseen. Refusing to deploy: migrate it (redeploy with a ` +
        `current TypeKro so its namespaces are recorded) and retry.`
    );
  }
  logger.debug('Enumerated existing-instance namespaces for the alchemy pre-hoist check', {
    count: result.size,
  });
  return result;
}

/**
 * Test-only export of the alchemy pre-hoist namespace resolver (finding #1, v7) so the
 * deterministic unit test can prove the per-instance-exact-or-fail-closed behavior with
 * injected API mocks (no cluster).
 */
export const existingInstanceNamespacesAlchemyForTest = _existingInstanceNamespacesAlchemy;

/**
 * finding #2 (alchemy adopted-namespace, mirrors the imperative `applyRetainedHoistedNamespace`
 * create-vs-adopt logic): the hoisted workload Namespace carries a build-time
 * `typekro.io/created-by-rgd` ownership stamp (added cluster-free in
 * `buildHoistedNamespaceResource`). Applying it unconditionally would let the empty-gated
 * teardown DELETE a namespace typekro merely ADOPTED. So READ the live namespace and keep
 * the stamp ONLY when typekro truly creates it (404) or already owns it (stamp already ==
 * this RGD); otherwise STRIP the stamp from the resource before apply so the live namespace
 * never carries our ownership record and teardown retains it. `namespaceOwnerRgd` is KEPT on
 * props either way — at delete time the empty-gate compares the LIVE annotation to it, and a
 * stripped/adopted namespace (no matching annotation) is retained.
 *
 * Returns props unchanged for non-hoisted-namespace resources or when the stamp should
 * stay; otherwise a shallow copy whose resource has the ownership annotation removed.
 */
async function _preserveHoistedNamespaceAdoption<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  logger: TypeKroLogger
): Promise<TypeKroResourceProps<T>> {
  if (props.namespaceEmptyGate !== true || props.namespaceOwnerRgd === undefined) return props;
  const name = props.resource.metadata?.name;
  if (typeof name !== 'string' || name.length === 0) return props;

  const kc = _createClientProvider(props, 'ownership-check');
  const api = createBunCompatibleKubernetesObjectApi(kc);

  // CREATE-FIRST ownership (finding #3), matching the imperative path: attempt to CREATE
  // the namespace WITH the build-time stamp. A 201 is atomic proof typekro created it
  // (owned). A 409 means it already exists — owned ONLY if a prior create by this RGD
  // stamped it; otherwise adopted. This replaces the raceable read→(404)→own decision:
  // there is no window in which another actor creates the namespace between our read and
  // our claim. The generic deployer still SSA-applies the full config afterwards
  // (idempotent), so a 201 here is not the final apply — it is the ownership PROBE.
  let ownsNamespace: boolean;
  try {
    const decision = await decideNamespaceOwnershipCreateFirst(
      api,
      props.resource as unknown as import('@kubernetes/client-node').KubernetesObject,
      props.namespaceOwnerRgd
    );
    ownsNamespace = decision.owned;
  } catch (error: unknown) {
    // A non-conflict CREATE failure (or a failed conflict-read) — do NOT claim ownership
    // (conservative: a namespace we cannot provably create/own must not be stampable, or
    // teardown might delete an adopted one). The deployer's SSA apply below surfaces the
    // real error if the cluster is genuinely broken.
    logger.debug('Create-first ownership probe failed; treating as adopted (alchemy)', {
      namespace: name,
      rgd: props.namespaceOwnerRgd,
      error: ensureError(error).message,
    });
    ownsNamespace = false;
  }

  if (ownsNamespace) return props; // keep the build-time ownership stamp

  logger.debug('Preserving namespace adoption — stripping build-time ownership stamp (alchemy)', {
    namespace: name,
    rgd: props.namespaceOwnerRgd,
  });
  return { ...props, resource: _stripNamespaceOwnerAnnotation(props.resource) };
}

/**
 * Return a shallow copy of a Namespace resource with the `typekro.io/created-by-rgd`
 * ownership annotation removed. Used by {@link _preserveHoistedNamespaceAdoption} to avoid
 * stamping ownership onto an adopted namespace. By reconcile time alchemy has JSON-round-
 * tripped props to state (no symbols/brands), so a shallow object copy is safe here.
 */
function _stripNamespaceOwnerAnnotation<T extends Enhanced<unknown, unknown>>(resource: T): T {
  const src = resource as unknown as { metadata?: { annotations?: Record<string, string> } };
  const annotations = { ...(src.metadata?.annotations ?? {}) };
  delete annotations[NAMESPACE_OWNER_ANNOTATION];
  return {
    ...(resource as unknown as Record<string, unknown>),
    metadata: { ...(src.metadata ?? {}), annotations },
  } as unknown as T;
}

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
    .filter(
      (d): d is TypeKroResource<Enhanced<unknown, unknown>> =>
        !!d?.deployedResource && !!d.resourceId
    )
    .map((d) => {
      const manifest = unwrapAlchemyRedactedResource(
        d.deployedResource
      ) as unknown as KubernetesResource;
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

function unwrapAlchemyRedactedValue(
  value: unknown,
  seen = new WeakMap<object, unknown>()
): unknown {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (!value || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    value.forEach((entry) => clone.push(unwrapAlchemyRedactedValue(entry, seen)));
    return clone;
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = unwrapAlchemyRedactedValue(entry, seen);
  }
  return clone;
}

function unwrapAlchemyRedactedResource<T extends Enhanced<unknown, unknown>>(resource: T): T {
  const unwrapped = unwrapAlchemyRedactedValue(resource) as T;
  if (unwrapped !== resource) copyResourceMetadata(resource, unwrapped);
  return unwrapped;
}

function artifactOutputsForOperation<T extends Enhanced<unknown, unknown>>(
  source: unknown,
  props: TypeKroResourceProps<T>,
  preserveSensitiveInputs: boolean,
  operationLabel: string
): Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined {
  const expectedUses = collectArtifactOutputUses(source);
  if (expectedUses.length === 0) return undefined;
  const declaredUses = props.artifactOutputUses ?? [];
  if (
    canonicalStringArray(expectedUses.map((use) => JSON.stringify(use))) !==
    canonicalStringArray(declaredUses.map((use) => JSON.stringify(use)))
  ) {
    throw new Error(
      `${operationLabel} artifact-output use metadata does not match its canonical artifact.`
    );
  }
  const requirements = new Map(
    (props.artifactRequirements ?? []).map((requirement) => [requirement.id, requirement])
  );
  const supplied = props.artifactOutputs ?? {};
  const resolved: Record<string, Record<string, unknown>> = {};
  for (const use of expectedUses) {
    const requirement = requirements.get(use.requirementId);
    if (!requirement || !requirement.outputs.includes(use.output)) {
      throw new Error(
        `${operationLabel} is missing declaration metadata for artifact output ${use.requirementId}.${use.output}.`
      );
    }
    const outputs = supplied[use.requirementId];
    if (!outputs || !Object.hasOwn(outputs, use.output)) {
      throw new Error(
        `${operationLabel} is missing resolved artifact output ${use.requirementId}.${use.output}.`
      );
    }
    const value = outputs[use.output];
    if (use.sensitive && !Redacted.isRedacted(value)) {
      throw new Error(
        `${operationLabel} sensitive artifact output ${use.requirementId}.${use.output} must be supplied as an Alchemy Redacted input.`
      );
    }
    const concreteValue = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    if (props.deploymentStrategy === 'kro' && typeof concreteValue !== 'string') {
      throw new Error(
        `${operationLabel} artifact output ${use.requirementId}.${use.output} must be a string in KRO mode.`
      );
    }
    const requirementOutputs = resolved[use.requirementId] ?? {};
    requirementOutputs[use.output] =
      Redacted.isRedacted(value) && !preserveSensitiveInputs ? Redacted.value(value) : value;
    resolved[use.requirementId] = requirementOutputs;
  }
  return resolved;
}

/**
 * Decode one operation from the canonical KRO outer bundle persisted by
 * Alchemy. The operation record, rather than the JSON-flattened resource, is
 * authoritative for desired state and runtime metadata in new declarations.
 */
function _resourceFromKroArtifactBundle<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  preserveSensitiveInputs = false
): T | undefined {
  const encodedBundle = props.kroArtifactBundle;
  const operationId = props.kroArtifactOperationId;
  if (encodedBundle === undefined && operationId === undefined) return undefined;
  if (encodedBundle === undefined || operationId === undefined) {
    throw new Error(
      'KRO artifact state is incomplete: both kroArtifactBundle and kroArtifactOperationId are required.'
    );
  }

  const bundle = decodeKroArtifactBundle(encodedBundle);
  const operation = bundle.operations.find((candidate) => candidate.id === operationId);
  if (!operation) {
    throw new Error(`KRO artifact bundle ${bundle.bundleDigest} has no operation ${operationId}.`);
  }
  if (props.resourceId !== undefined && props.resourceId !== operation.artifact.id) {
    throw new Error(
      `KRO artifact operation ${operationId} belongs to ${operation.artifact.id}, not ${props.resourceId}.`
    );
  }

  const dependencyOutputs = props.dependencies ?? [];
  const missingOperationIds = dependencyOutputs.filter(
    (dependency) => typeof dependency.kroArtifactOperationId !== 'string'
  );
  if (missingOperationIds.length > 0) {
    throw new Error(
      `KRO artifact dependency mismatch for ${operationId}: ${missingOperationIds.length} dependency output(s) have no operation identity.`
    );
  }
  const suppliedDependencies = dependencyOutputs.map(
    (dependency) => dependency.kroArtifactOperationId as string
  );
  if (canonicalStringArray(suppliedDependencies) !== canonicalStringArray(operation.dependencies)) {
    throw new Error(
      `KRO artifact dependency mismatch for ${operationId}: expected [${operation.dependencies.join(
        ', '
      )}], received [${suppliedDependencies.join(', ')}].`
    );
  }

  const requiredBindings = planValueSensitiveBindingNames(operation.manifest);
  const suppliedBindings = props.sensitiveBindings ?? {};
  const missingBindings = requiredBindings.filter(
    (binding) => !Object.hasOwn(suppliedBindings, binding)
  );
  if (missingBindings.length > 0) {
    throw new Error(
      `KRO artifact operation ${operationId} is missing sensitive binding(s): ${missingBindings.join(', ')}.`
    );
  }
  const sensitive = Object.fromEntries(
    requiredBindings.map((binding) => {
      const value = suppliedBindings[binding];
      if (!Redacted.isRedacted(value)) {
        throw new Error(
          `KRO artifact sensitive binding ${binding} must be supplied as an Alchemy Redacted input.`
        );
      }
      return [binding, preserveSensitiveInputs ? value : Redacted.value(value)];
    })
  );
  const artifactOutputs = artifactOutputsForOperation(
    operation.manifest,
    props,
    preserveSensitiveInputs,
    `KRO artifact operation ${operationId}`
  );
  const resource = materializeKroArtifactBundleOperation(operation, {
    ...(Object.keys(sensitive).length > 0 ? { sensitive } : {}),
    ...(artifactOutputs ? { artifactOutputs } : {}),
  }) as T;
  Object.defineProperty(resource, 'id', {
    value: operation.artifact.id,
    configurable: true,
    enumerable: false,
  });
  setResourceId(resource, operation.artifact.id);
  if (operation.artifact.identity?.scope) {
    setMetadataField(resource, 'scope', operation.artifact.identity.scope);
  }
  setMetadataField(resource, 'applyPolicy', operation.artifact.apply);

  const strategy = operation.artifact.readiness.strategy;
  if (strategy?.kind === 'runtime-binding') {
    const evaluator = getReadinessEvaluator(props.resource);
    if (!evaluator) {
      throw new Error(
        `KRO readiness binding ${strategy.binding} is unavailable for operation ${operationId}.`
      );
    }
    setReadinessEvaluator(resource, evaluator);
  } else if (strategy?.kind === 'registered') {
    const evaluator = resolvePortableReadinessStrategy(strategy);
    if (!evaluator) {
      throw new Error(
        `Registered readiness strategy ${strategy.id}@${strategy.revision} is unavailable for KRO operation ${operationId}.`
      );
    }
    setReadinessEvaluator(resource, evaluator);
  }
  return resource;
}

/** Internal test hook for canonical KRO-bundle state rehydration. */
export const resourceFromKroArtifactBundleForTest = _resourceFromKroArtifactBundle;

/**
 * Decode the canonical direct execution record and reconstruct the exact
 * runtime manifest contract. This is the authoritative Alchemy path for new
 * declarations; the string rehydration below remains legacy-state support.
 */
function _resourceFromDirectArtifactRecord<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  preserveSensitiveInputs = false
): T | undefined {
  if (props.deploymentStrategy !== 'direct' || !props.artifactExecutionRecord) return undefined;

  const record = decodeDirectArtifactExecutionRecord(props.artifactExecutionRecord);
  const logicalId = record.artifact.sourceNodeId ?? record.artifact.id;
  if (props.resourceId !== undefined && props.resourceId !== logicalId) {
    throw new Error(
      `Direct artifact record ${record.artifact.id} belongs to ${logicalId}, not ${props.resourceId}.`
    );
  }

  const suppliedDependencies = (props.dependencies ?? [])
    .map((dependency) => dependency.resourceId)
    .filter((resourceId): resourceId is string => typeof resourceId === 'string')
    .sort();
  if (canonicalStringArray(suppliedDependencies) !== canonicalStringArray(record.dependencies)) {
    throw new Error(
      `Direct artifact dependency mismatch for ${logicalId}: expected [${record.dependencies.join(
        ', '
      )}], received [${suppliedDependencies.join(', ')}].`
    );
  }

  const evaluator = getReadinessEvaluator(props.resource);
  const strategy = record.artifact.readiness.strategy;
  const readinessEvaluators =
    strategy?.kind === 'runtime-binding' && evaluator
      ? { [strategy.binding]: evaluator }
      : undefined;
  const sensitive = Object.fromEntries(
    Object.entries(props.sensitiveBindings ?? {}).map(([binding, value]) => {
      if (!Redacted.isRedacted(value)) {
        throw new Error(
          `Direct artifact sensitive binding ${binding} must be supplied as an Alchemy Redacted input.`
        );
      }
      return [binding, preserveSensitiveInputs ? value : Redacted.value(value)];
    })
  );
  const artifactOutputs = artifactOutputsForOperation(
    record.artifact,
    props,
    preserveSensitiveInputs,
    `Direct artifact ${logicalId}`
  );
  return materializeDirectArtifactManifest(
    record.artifact,
    {
      instanceName: props.resourceId ?? logicalId,
      runtimeResources: { [logicalId]: props.resource },
      ...(Object.keys(sensitive).length > 0 ? { sensitive } : {}),
      ...(artifactOutputs ? { artifactOutputs } : {}),
      ...(readinessEvaluators ? { readinessEvaluators } : {}),
      resolveReadinessStrategy: resolvePortableReadinessStrategy,
    },
    props.resourceId ?? logicalId
  ) as T;
}

/** Internal test hook for canonical direct-artifact state rehydration. */
export const resourceFromDirectArtifactRecordForTest = _resourceFromDirectArtifactRecord;

function canonicalStringArray(values: readonly string[]): string {
  return JSON.stringify([...new Set(values)].sort());
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
    ...(output.artifactExecutionRecord !== undefined && {
      artifactExecutionRecord: output.artifactExecutionRecord,
    }),
    ...(output.kroArtifactBundle !== undefined && {
      kroArtifactBundle: output.kroArtifactBundle,
    }),
    ...(output.kroArtifactOperationId !== undefined && {
      kroArtifactOperationId: output.kroArtifactOperationId,
    }),
    namespace: output.namespace,
    deploymentStrategy: output.deploymentStrategy ?? 'kro',
    ...(output.kubeConfigOptions !== undefined && { kubeConfigOptions: output.kubeConfigOptions }),
    ...(output.kroDeletion !== undefined && { kroDeletion: output.kroDeletion }),
    ...(output.retain === true && { retain: true }),
    ...(output.namespaceEmptyGate === true && { namespaceEmptyGate: true }),
    ...(output.namespaceOwnerRgd !== undefined && { namespaceOwnerRgd: output.namespaceOwnerRgd }),
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

  // Resolve named host bindings only inside the provider operation. Durable state contains
  // binding identities, never the credential bytes they produce.
  const kubeConfigOptions = props.kubeConfigOptions
    ? materializeSerializableKubeConfigOptions(props.kubeConfigOptions)
    : undefined;
  const clientProvider = createKubernetesClientProvider(kubeConfigOptions);

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
  const validateInstanceSpec = shouldValidateKroInstanceAdmission(props);
  return new KroTypeKroDeployer(engine, {
    ...(validateInstanceSpec ? { validateInstanceSpec: true } : {}),
    ...(kroDeletion
      ? {
          deleteInstance: (name: string, abortSignal?: AbortSignal) =>
            deleteKroInstanceFinalizerSafe(kc, name, kroDeletion, abortSignal),
          shouldSkipRgdDelete: (_rgdName: string, abortSignal?: AbortSignal) =>
            hasKroInstances(kc, kroDeletion, abortSignal),
          deleteResourceGraphDefinition: (_rgdName: string, abortSignal?: AbortSignal) =>
            deleteKroDefinition(kc, kroDeletion, undefined, abortSignal),
        }
      : {}),
  });
}

function shouldValidateKroInstanceAdmission<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>
): boolean {
  if (props.deploymentStrategy !== 'kro') return false;

  if (props.kroArtifactBundle !== undefined || props.kroArtifactOperationId !== undefined) {
    if (props.kroArtifactBundle === undefined || props.kroArtifactOperationId === undefined) {
      return false;
    }
    const bundle = decodeKroArtifactBundle(props.kroArtifactBundle);
    const operation = bundle.operations.find(
      (candidate) => candidate.id === props.kroArtifactOperationId
    );
    return operation?.role === 'instance' || operation?.role === 'singleton-owner-instance';
  }

  // Legacy Alchemy declarations predate operation roles. Their KRO resources are
  // either the RGD itself or its root custom resource instance.
  return props.resource.kind !== 'ResourceGraphDefinition';
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
      namespace:
        typeof resource.metadata.namespace === 'string'
          ? resource.metadata.namespace
          : props.namespace,
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
    namespace:
      typeof resource.metadata?.namespace === 'string'
        ? resource.metadata.namespace
        : props.namespace,
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
  props: TypeKroResourceProps<T>,
  abortSignal?: AbortSignal
): Promise<void> {
  abortSignal?.throwIfAborted();
  const logger = getComponentLogger('alchemy-deployment').child({ alchemyType: KRO_RESOURCE_TYPE });
  // Retained (shared) resources — e.g. the KRO instance control-plane Namespace —
  // must survive a single stack's teardown/prune: another stack targeting the same
  // workload namespace may still have KRO instances inside it. Drop only the state
  // entry (like the deferred shared-RGD delete below), leaving the object on-cluster.
  if (props.retain === true) {
    logger.debug('Skipping delete: resource is retained (shared); dropping state entry only', {
      resourceName: props.resource.metadata?.name,
      namespace: props.namespace,
    });
    return;
  }
  // Empty-gated Namespace teardown (findings #3 + #4): a typekro-hoisted workload
  // Namespace is deleted ONLY if empty and RETAINED if another stack/user still has
  // resources inside it. Alchemy's reverse-topo teardown runs this AFTER the RGD +
  // instance that `dependsOn` it are gone; the instance is deleted FIRST and its delete
  // waits for the CR's `kro.run/finalizer` to clear (KRO graph-deletes all children),
  // so by the time this runs everything THIS instance owned has already drained from
  // the namespace (finding #1's ordering, provided here by the dependency graph + the
  // instance-drain wait rather than an in-line CRD-404 wait; the gate is fail-safe
  // regardless). Replaces the old retain-by-name-equality distinction — runtime
  // emptiness is the truth for both the instance's own namespace and a shared one.
  if (props.namespaceEmptyGate === true) {
    const namespaceName = props.resource.metadata?.name;
    if (typeof namespaceName !== 'string' || namespaceName.length === 0) {
      logger.warn('Empty-gated namespace teardown skipped: resource has no metadata.name', {
        namespace: props.namespace,
      });
      return;
    }
    const kubeConfig = _createClientProvider(props, 'delete');
    abortSignal?.throwIfAborted();
    await deleteNamespaceIfEmpty(kubeConfig, namespaceName, {
      logger,
      // Ownership record (finding #4) + gated delete (finding #1): only delete a
      // namespace this composition's RGD created, and gate it to a real 404.
      ...(props.namespaceOwnerRgd !== undefined && { ownedByRgd: props.namespaceOwnerRgd }),
      ...(props.options?.timeout !== undefined && { timeoutMs: props.options.timeout }),
      context: { alchemyType: KRO_RESOURCE_TYPE },
    });
    abortSignal?.throwIfAborted();
    return;
  }
  const { deployer, dispose } = await _resolveDeployer(props, 'delete');
  try {
    await deployer.delete(props.resource, {
      mode: props.deploymentStrategy,
      namespace: props.namespace,
      ...props.options,
      ...(abortSignal ? { abortSignal } : {}),
    });
  } catch (error: unknown) {
    if (error instanceof ResourceGraphDefinitionDeletionDeferredError) {
      logger.debug(
        'Deferring ResourceGraphDefinition delete (still referenced); dropping state entry',
        {
          resourceName: props.resource.metadata?.name,
          reason: error.message,
        }
      );
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
  seedResources?: DeployedResource[],
  abortSignal?: AbortSignal
): Promise<{ resourceProperties: DeployedResourceProperties<T> }> {
  const deploymentOptions = buildAlchemyDeploymentOptions(props, abortSignal);

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
  const stateResource =
    _resourceFromKroArtifactBundle(props, true) ??
    _resourceFromDirectArtifactRecord(props, true) ??
    redactSecretResourceForAlchemyState(props.resource);
  const stateDeployedResource = mergeLiveResourceState(stateResource, deployedResource as T);
  const cleanResource = cloneResourceForAlchemyState(stateResource);
  const cleanDeployedResource = cloneResourceForAlchemyState(
    stateDeployedResource,
    getResourceScope(cleanResource)
  );

  // Create the resource properties for Alchemy
  const resourceProperties: DeployedResourceProperties<T> = {
    resource: cleanResource,
    ...(props.resourceId !== undefined && { resourceId: props.resourceId }),
    ...(props.artifactExecutionRecord !== undefined && {
      artifactExecutionRecord: props.artifactExecutionRecord,
    }),
    ...(props.kroArtifactBundle !== undefined && {
      kroArtifactBundle: props.kroArtifactBundle,
    }),
    ...(props.kroArtifactOperationId !== undefined && {
      kroArtifactOperationId: props.kroArtifactOperationId,
    }),
    namespace: props.namespace,
    deploymentStrategy: props.deploymentStrategy,
    ...(props.kubeConfigOptions !== undefined && { kubeConfigOptions: props.kubeConfigOptions }),
    ...(props.kroDeletion !== undefined && { kroDeletion: props.kroDeletion }),
    ...(props.retain === true && { retain: true }),
    ...(props.namespaceEmptyGate === true && { namespaceEmptyGate: true }),
    ...(props.namespaceOwnerRgd !== undefined && { namespaceOwnerRgd: props.namespaceOwnerRgd }),
    deployedResource: cleanDeployedResource,
    ready: true,
    deployedAt: Date.now(),
  };

  return { resourceProperties };
}

function cloneResourceForAlchemyState<T extends Enhanced<unknown, unknown>>(
  resource: T,
  fallbackScope?: ResourceScope
): T {
  const cleanResource = cloneAlchemyStateValue(resource) as T & { scope?: ResourceScope };
  const scope =
    getResourceScope(resource as T & { scope?: ResourceScope }) ??
    fallbackScope ??
    cleanResource.scope;
  if (scope) {
    cleanResource.scope = scope;
    if (scope === 'cluster') {
      delete (cleanResource.metadata as Record<string, unknown> | undefined)?.namespace;
    }
  }
  return cleanResource as T;
}

function cloneAlchemyStateValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (Redacted.isRedacted(value)) return value;
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' || value === undefined
      ? undefined
      : value;
  }
  if (value instanceof Date) return value.toJSON();
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    value.forEach((entry) => clone.push(cloneAlchemyStateValue(entry, seen)));
    return clone;
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, entry] of Object.entries(value)) {
    const cloned = cloneAlchemyStateValue(entry, seen);
    if (cloned !== undefined) clone[key] = cloned;
  }
  return clone;
}

function redactSecretResourceForAlchemyState<T extends Enhanced<unknown, unknown>>(resource: T): T {
  if (resource.kind !== 'Secret') return resource;
  const redactMap = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        Redacted.isRedacted(entry) ? entry : Redacted.make(entry),
      ])
    );
  };
  return {
    ...resource,
    ...(Reflect.has(resource, 'data') ? { data: redactMap(Reflect.get(resource, 'data')) } : {}),
    ...(Reflect.has(resource, 'stringData')
      ? { stringData: redactMap(Reflect.get(resource, 'stringData')) }
      : {}),
  } as T;
}

function mergeLiveResourceState<T extends Enhanced<unknown, unknown>>(desired: T, live: T): T {
  const liveMetadata = live.metadata as Record<string, unknown> | undefined;
  const runtimeMetadata = Object.fromEntries(
    ['uid', 'resourceVersion', 'generation', 'creationTimestamp'].flatMap((key) =>
      liveMetadata?.[key] === undefined ? [] : [[key, liveMetadata[key]]]
    )
  );
  return {
    ...desired,
    metadata: { ...(desired.metadata ?? { name: '' }), ...runtimeMetadata },
    ...(Reflect.has(live, 'status') ? { status: Reflect.get(live, 'status') } : {}),
  } as T;
}

/** Internal test hook for Alchemy state serialization semantics. */
export const cloneResourceForAlchemyStateForTest = cloneResourceForAlchemyState;

export function buildAlchemyDeploymentOptions<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  abortSignal?: AbortSignal
): DeploymentOptions {
  const { waitForReady, timeout, ...deploymentMetadataOptions } = props.options ?? {};

  return {
    mode: props.deploymentStrategy,
    namespace: props.namespace,
    ...deploymentMetadataOptions,
    waitForReady: waitForReady ?? true,
    timeout: timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
    ...(abortSignal ? { abortSignal } : {}),
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
