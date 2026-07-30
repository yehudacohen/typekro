/**
 * KroResourceFactory implementation for Kro deployment mode
 *
 * This factory handles deployment via Kro ResourceGraphDefinitions,
 * using the Kro controller for dependency resolution and resource management.
 */

import type * as k8s from '@kubernetes/client-node';
import { compile as compileExpression } from 'angular-expressions';
import * as yaml from 'js-yaml';
// Alchemy v2 (declarative): `toAlchemyResources(spec)` emits these as the RGD + instance
// declarations the caller feeds to `KroResource`. Imported from focused modules (NOT the
// alchemy barrel) so the factory never statically pulls the `alchemy/Provider` runtime.
import type { KroDeletionOptions } from '../../alchemy/kro-delete.js';
import type {
  AlchemyResourceDeclaration,
  SerializableKubeConfigOptions,
} from '../../alchemy/types.js';
import { createAlchemyResourceId } from '../../alchemy/utilities.js';
import { preserveNonEnumerableProperties } from '../../utils/helpers.js';
import { shortStableHash, toCamelCase } from '../../utils/string.js';
import { isKubernetesRef } from '../../utils/type-guards.js';
import { applyAspects } from '../aspects/apply.js';
import { copyCompositionAnalysisMetadata } from '../composition/analysis-metadata.js';
import { createCompositionContext, runWithCompositionContext } from '../composition/context.js';
import { buildNestedCompositionAliasTargets } from '../composition/nested-status-cel.js';
import {
  DEFAULT_DEPLOYMENT_TIMEOUT,
  DEFAULT_KRO_INSTANCE_TIMEOUT,
  DEFAULT_RGD_TIMEOUT,
} from '../config/defaults.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_SCHEMA_MARKER_SOURCE } from '../constants/brands.js';
import {
  ConversionError,
  CRDInstanceError,
  DeploymentTimeoutError,
  ensureError,
  ResourceGraphFactoryError,
  TypeKroError,
  ValidationError,
} from '../errors.js';
import { isStrictCelDiagnosticsEnabled } from '../expressions/analysis/strict-cel.js';
import { applyAnalysisToResources } from '../expressions/composition/composition-analyzer.js';
import type { KubernetesClientProvider } from '../kubernetes/client-provider.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
// Dependency inversion: kroCustomResource, resourceGraphDefinition, and
// alchemy bridge are injected via FactoryOptions providers (Phase 3.5)
// instead of dynamic import() from higher layers.
import {
  copyResourceMetadata,
  getMetadataField,
  getReadinessEvaluator,
  getResourceScope,
  setMetadataField,
  setReadinessEvaluator,
  setResourceId,
} from '../metadata/index.js';
import {
  type ArtifactOutputUse,
  type ArtifactRequirement,
  assertAdapterCapabilitiesSupported,
  type CapabilityRequirement,
  canonicalStringify,
  collectArtifactOutputUses,
  collectPlanValueSensitiveBindings,
  compileKroArtifactPlan,
  createKroArtifactBundle,
  decodeKroArtifactBundle,
  encodeKroArtifactBundle,
  KRO_ARTIFACT_BINDINGS_SPEC_FIELD,
  type KroArtifactBundle,
  type KroArtifactBundleOperation,
  type KroArtifactPlan,
  type KroSupportingArtifact,
  type KroSupportingArtifactCompilerInput,
  kroArtifactPlanToGraphResources,
  kroArtifactPlanToInstanceResource,
  kroArtifactPlanToSupportingResources,
  lowerPlanValue,
  mapPlanValueSensitiveBindings,
  materializeKroArtifactBundleOperation,
  materializePlanValue,
  mergeKroArtifactBundleOperations,
  orderKroArtifactBundleOperations,
  type PlanEdge,
  planValueSensitiveBindingNames,
  resolveStaticYamlSensitiveBindings,
  type StaticYamlMaterializationOptions,
  schemaToIR,
} from '../planning/index.js';
import {
  createAlwaysReadyEvaluator,
  createCustomResourceDefinitionReadinessEvaluator,
  ensureReadinessEvaluator,
  getPortableReadinessStrategy,
  resolvePortableReadinessStrategy,
} from '../readiness/index.js';
import { createSchemaProxy, DeploymentMode } from '../references/index.js';
import { runStandaloneOperation } from '../runtime/standalone-operation.js';
import { isStaticExpression } from '../serialization/cel-references.js';
import { applyTernaryConditionalsToResources } from '../serialization/kro-post-processing.js';
import { generateKroSchemaFromArktype } from '../serialization/schema.js';
import {
  serializeResourceGraphDefinitionToYaml,
  serializeResourceGraphToManifest,
} from '../serialization/yaml.js';
import { getSingletonResourceId } from '../singleton/singleton.js';
import type { CelExpression, KubernetesRef } from '../types/common.js';
import type {
  AppliedResource,
  DeployedResource,
  DeploymentClosure,
  DeploymentContext,
  FactoryOptions,
  FactoryStatus,
  InternalResourceFactoryDeployOptions,
  InternalResourceFactoryReadOptions,
  KroCustomResourceProvider,
  KroPrerequisiteContext,
  KroResourceFactory,
  PrerequisiteResource,
  ResourceDeletionResult,
  ResourceFactoryDeleteOptions,
  ResourceGraphDefinitionProvider,
  RGDStatus,
  SingletonDefinitionRecord,
} from '../types/deployment.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from '../types/kubernetes.js';
import type {
  KroCompatibleType,
  KroResourceGraphDefinition,
  MagicAssignableShape,
  SchemaDefinition,
  SchemaProxy,
  SerializationOptions,
} from '../types/serialization.js';
import {
  createStatusResourceIdentityContext,
  validateStatusCelExpressions,
} from '../validation/cel-validator.js';
import { KubernetesClientManager } from './client-provider-manager.js';
import {
  blockerForRemainingResource,
  createDeletionResultState,
  type DeletionResultState,
  deletionTarget,
  finishDeletionResult,
  readDeletionResourceIdentity,
} from './deletion-result.js';
import { DirectDeploymentEngine } from './engine.js';
import { logHandleSnapshot } from './handle-tracing.js';
import { isNotFoundError } from './k8s-helpers.js';
import { assertKroInstanceSpecPreserved } from './kro-instance-admission.js';
import {
  assertKroInstanceNamespaceOwnershipSafe,
  assertNoHoistWeakenedStatusFields,
  concreteActiveOwnedResources,
  concreteOwnedNamespaceResources,
  findDanglingHoistedReference,
  resolveConcreteMetadataValue,
  resolveNamespaceName,
  rewriteHoistedNamespaceReferences,
  rewriteHoistedNamespaceRefsInValue,
  selectHoistedNamespaces,
} from './kro-instance-safety.js';
import {
  decideNamespaceOwnershipCreateFirst,
  deleteNamespaceIfEmpty,
  HOISTED_NAMESPACES_ANNOTATION,
  listNamespacesOwnedByRgd,
  NAMESPACE_OWNER_ANNOTATION,
  type NamespaceDeletionOutcome,
  type NamespaceOwnershipDecision,
  parseHoistedNamespacesAnnotation,
  readHoistedNamespacesRecord,
} from './kro-namespace-teardown.js';
import { waitForKroInstanceReady as waitForKroInstanceReadyShared } from './kro-readiness.js';
import { createRollbackManager } from './rollback-manager.js';
import { evaluateSchemaCelExpression } from './schema-cel-evaluator.js';
import {
  convertToKubernetesName,
  extractSerializableKubeConfigOptions,
  generateInstanceName,
  getSingletonInstanceName,
  pluralizeKind,
  validateSpec,
} from './shared-utilities.js';
import {
  joinYamlDocuments,
  singletonOwnerInstanceManifests,
  singletonRgdYamls,
} from './singleton-gitops.js';
import {
  assertNoDeployedSingletonSpecDrift,
  singletonSpecFingerprintAnnotationValue,
} from './singleton-owner-drift.js';

/**
 * Label stamped on every KRO instance CR this factory creates, keyed to the
 * factory's RGD name. Used by the cluster-wide cleanup list in `deleteInstance`
 * to decide whether other instances still share the RGD.
 */
const INSTANCE_RGD_LABEL = 'typekro.io/rgd';

interface MaterializedHoistedNamespace {
  readonly resource: KubernetesResource;
  readonly artifact?: KroSupportingArtifact;
}

interface KroBundleAssembly {
  readonly operations: readonly KroArtifactBundleOperation[];
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  readonly artifactRequirements: readonly ArtifactRequirement[];
  readonly rgdOperationId: string;
  readonly instanceOperationId?: string;
  readonly sensitiveBindings: Readonly<Record<string, unknown>>;
}

function uniqueArtifactRequirements(
  requirements: readonly ArtifactRequirement[]
): readonly ArtifactRequirement[] {
  const byId = new Map<string, ArtifactRequirement>();
  for (const requirement of requirements) {
    const prior = byId.get(requirement.id);
    if (prior && canonicalStringify(prior) !== canonicalStringify(requirement)) {
      throw new TypeKroError(
        `Artifact requirement ${requirement.id} has conflicting definitions across KRO bundle members.`,
        'KRO_ARTIFACT_REQUIREMENT_CONFLICT',
        { requirementId: requirement.id }
      );
    }
    byId.set(requirement.id, requirement);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function uniqueCapabilityRequirements(
  requirements: readonly CapabilityRequirement[]
): readonly CapabilityRequirement[] {
  return [
    ...new Map(
      requirements.map((requirement) => [canonicalStringify(requirement), requirement] as const)
    ).values(),
  ].sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
}

interface KroArtifactPlanMaterialization {
  readonly artifacts: KroArtifactPlan;
  readonly sensitiveBindings: Readonly<Record<string, unknown>>;
}

interface KroArtifactBundleMaterialization {
  readonly bundle: KroArtifactBundle;
  readonly sensitiveBindings: Readonly<Record<string, unknown>>;
}

interface KroBundleRuntimeConsumer {
  readonly factory: KroResourceFactoryImpl<KroCompatibleType, KroCompatibleType>;
  readonly definition: SingletonDefinitionRecord;
}

interface KroBundleRuntimeMember {
  readonly memberId: string;
  readonly factory: KroResourceFactoryImpl<KroCompatibleType, KroCompatibleType>;
  readonly spec: KroCompatibleType;
  readonly definition?: SingletonDefinitionRecord;
  readonly consumers: KroBundleRuntimeConsumer[];
  readonly dispose: boolean;
}

function kroBundleOperationId(resource: KubernetesResource): string {
  const name = resource.metadata?.name;
  if (typeof resource.apiVersion !== 'string' || typeof resource.kind !== 'string' || !name) {
    throw new TypeKroError(
      'Cannot identify KRO bundle operation without a complete Kubernetes identity.',
      'KRO_ARTIFACT_BUNDLE_IDENTITY_MISSING',
      { apiVersion: resource.apiVersion, kind: resource.kind, name }
    );
  }
  return [
    'k8s',
    resource.apiVersion,
    resource.kind,
    resource.metadata?.namespace ?? '_cluster',
    name,
  ]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

function kroMemberSensitiveBinding(memberId: string, binding: string): string {
  return binding.startsWith('spec/') ? `kro/${encodeURIComponent(memberId)}/${binding}` : binding;
}

function mergeSensitiveBindingEnvelopes(
  target: Record<string, unknown>,
  incoming: Readonly<Record<string, unknown>>
): void {
  for (const [binding, value] of Object.entries(incoming)) {
    if (Object.hasOwn(target, binding) && !Object.is(target[binding], value)) {
      throw new TypeKroError(
        `Sensitive binding ${binding} resolved to conflicting values across KRO bundle members.`,
        'KRO_SENSITIVE_BINDING_CONFLICT',
        { binding }
      );
    }
    target[binding] = value;
  }
}

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
  // but this decision only reads `metadata.name` / `metadata.namespace`
  // and tolerates undefined.
  instances: ReadonlyArray<{ metadata?: { name?: unknown; namespace?: unknown } }>,
  targetName: string,
  instanceDeleted: boolean,
  targetNamespace?: string
): boolean {
  const others = instanceDeleted
    ? instances.filter((i) => {
        if (i.metadata?.name !== targetName) return true;
        if (!targetNamespace) return false;
        return i.metadata?.namespace !== targetNamespace;
      })
    : instances;
  return others.length > 0;
}

function recordNamespaceDeletionOutcome(
  state: DeletionResultState,
  namespace: string,
  outcome: NamespaceDeletionOutcome
): void {
  const resource = deletionTarget('v1', 'Namespace', namespace);
  if (outcome.status === 'deleted' || outcome.status === 'absent') {
    // A bounded descendant-drain retry may first observe the Namespace as occupied and then
    // confirm it gone. Keep the final DTO truthful by removing interim retention/blocker evidence.
    const replaceWithFilteredEntries = <T>(entries: T[], keep: (entry: T) => boolean): void => {
      entries.splice(0, entries.length, ...entries.filter(keep));
    };
    replaceWithFilteredEntries(
      state.retained,
      (entry) => !(entry.resource.kind === 'Namespace' && entry.resource.name === namespace)
    );
    replaceWithFilteredEntries(
      state.remaining,
      (entry) => !(entry.kind === 'Namespace' && entry.name === namespace)
    );
    replaceWithFilteredEntries(
      state.blockers,
      (entry) => !(entry.resource?.kind === 'Namespace' && entry.resource.name === namespace)
    );
    state.deleted.push(resource);
    return;
  }

  if (outcome.cause === 'not-owned') {
    state.retained.push({ resource, policy: 'adopted-resource', reason: outcome.reason });
    return;
  }
  if (outcome.cause === 'occupied') {
    state.retained.push({ resource, policy: 'occupied-namespace', reason: outcome.reason });
    return;
  }

  state.retained.push({
    resource,
    policy: 'safety-proof-unavailable',
    reason: outcome.reason,
  });
  state.remaining.push(resource);
  state.blockers.push({
    code: outcome.cause === 'read-failed' ? 'OWNERSHIP_UNPROVEN' : 'DISCOVERY_FAILED',
    message: outcome.reason,
    resource,
    retryable: true,
    retryGuidance:
      'Retry after Kubernetes discovery and namespace reads are available; TypeKro retained the namespace to avoid destructive cleanup.',
  });
}

const DESCENDANT_PRODUCING_KINDS = new Set([
  'CronJob',
  'DaemonSet',
  'Deployment',
  'HelmRelease',
  'Job',
  'Kustomization',
  'ReplicaSet',
  'ReplicationController',
  'StatefulSet',
]);

interface ConcreteOwnedChildTarget {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

interface CapturedOwnedDescendant {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  owner: ConcreteOwnedChildTarget & { uid: string };
}

/**
 * Capture dependents that Kubernetes may orphan when KRO removes their direct
 * controller before garbage collection completes. The UID match is the
 * ownership proof: a same-named Pod from a replacement Job is never adopted.
 */
async function captureKnownControllerDescendants(
  k8sApi: k8s.KubernetesObjectApi,
  childTargets: readonly ConcreteOwnedChildTarget[],
  defaultNamespace: string
): Promise<CapturedOwnedDescendant[]> {
  const descendants: CapturedOwnedDescendant[] = [];
  for (const target of childTargets) {
    if (target.kind !== 'Job') continue;
    const namespace = target.namespace ?? defaultNamespace;
    let live: k8s.KubernetesObject;
    try {
      live = await k8sApi.read({
        apiVersion: target.apiVersion,
        kind: target.kind,
        metadata: { name: target.name, namespace },
      });
    } catch (error: unknown) {
      const statusCode =
        (error as { statusCode?: number; body?: { code?: number } }).statusCode ??
        (error as { body?: { code?: number } }).body?.code;
      if (statusCode === 404) continue;
      throw error;
    }
    const uid = live.metadata?.uid;
    if (!uid) {
      throw new Error(`Cannot prove descendant ownership for Job/${target.name}: UID is missing`);
    }
    const pods = await k8sApi.list<k8s.KubernetesObject>(
      'v1',
      'Pod',
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `batch.kubernetes.io/controller-uid=${uid}`
    );
    for (const pod of pods.items) {
      const podName = pod.metadata?.name;
      const controlledByJob = pod.metadata?.ownerReferences?.some(
        (owner) => owner.uid === uid && owner.kind === 'Job' && owner.controller !== false
      );
      if (!podName || !controlledByJob) continue;
      descendants.push({
        apiVersion: 'v1',
        kind: 'Pod',
        name: podName,
        namespace,
        owner: { ...target, namespace, uid },
      });
    }
  }
  return descendants;
}

function deepMergeStatusPlaceholders(
  staticFields: Record<string, unknown>,
  dynamicFields: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...staticFields };

  for (const [key, dynamicValue] of Object.entries(dynamicFields)) {
    const staticValue = merged[key];
    if (
      staticValue &&
      typeof staticValue === 'object' &&
      !Array.isArray(staticValue) &&
      dynamicValue &&
      typeof dynamicValue === 'object' &&
      !Array.isArray(dynamicValue)
    ) {
      merged[key] = deepMergeStatusPlaceholders(
        staticValue as Record<string, unknown>,
        dynamicValue as Record<string, unknown>
      );
    } else if (!(key in merged)) {
      merged[key] = dynamicValue;
    }
  }

  return merged;
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
  readonly rgdName: string;
  readonly schema: SchemaProxy<TSpec, TStatus>;

  private readonly resources: Record<string, KubernetesResource>;
  private readonly closures: Record<string, DeploymentClosure>;
  private readonly schemaDefinition: SchemaDefinition<TSpec, TStatus>;
  private readonly statusMappings: Record<string, unknown>;
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

  constructor(
    name: string,
    resources: Record<string, KubernetesResource>,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    statusMappings: MagicAssignableShape<TStatus>,
    options: FactoryOptions = {}
  ) {
    this.name = name;
    this.namespace = options.namespace || 'default';
    this.rgdName = convertToKubernetesName(name); // Convert to valid Kubernetes resource name
    this.resources = resources;
    this.closures = options.closures || {};
    this.schemaDefinition = schemaDefinition;
    this.statusMappings = statusMappings as Record<string, unknown>;
    this.singletonDefinitions = options.singletonDefinitions ?? [];
    this.factoryOptions = options;
    this.clientManager = new KubernetesClientManager(options);
    const specSchema = schemaToIR(schemaDefinition.spec);
    if (
      specSchema.root.kind === 'object' &&
      specSchema.root.properties.some(
        (property) => property.name === KRO_ARTIFACT_BINDINGS_SPEC_FIELD
      )
    ) {
      throw new TypeKroError(
        `Spec field ${KRO_ARTIFACT_BINDINGS_SPEC_FIELD} is reserved for TypeKro KRO provider bindings.`,
        'KRO_RESERVED_SPEC_FIELD',
        {
          field: KRO_ARTIFACT_BINDINGS_SPEC_FIELD,
          surface: 'schema',
          factory: name,
          policyVersion: 1,
        }
      );
    }
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

    // Validate closures for Kro mode - detect KubernetesRef inputs and raise clear errors
    this.validateClosuresForKroMode();
  }

  /** Extract nested composition status CEL mappings from the raw status object. */
  private getNestedStatusCel(): Record<string, string> | undefined {
    if (!this.statusMappings) return undefined;
    return Object.getOwnPropertyDescriptor(this.statusMappings, '__nestedStatusCel')?.value as
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

  private assertNoReservedKroSpecField(spec: unknown): void {
    if (
      !spec ||
      typeof spec !== 'object' ||
      !Object.hasOwn(spec, KRO_ARTIFACT_BINDINGS_SPEC_FIELD)
    ) {
      return;
    }
    throw new TypeKroError(
      `Spec field ${KRO_ARTIFACT_BINDINGS_SPEC_FIELD} is reserved for TypeKro KRO provider bindings.`,
      'KRO_RESERVED_SPEC_FIELD',
      {
        field: KRO_ARTIFACT_BINDINGS_SPEC_FIELD,
        surface: 'instance-spec',
        factory: this.name,
        policyVersion: 1,
      }
    );
  }

  /**
   * Resolve the namespace the KRO instance CR lives in for this call.
   *
   * The default CR placement is the FACTORY namespace (`this.namespace`), exactly
   * as v0.26.0 always did — the maintainer's explicit decision (finding #2). This
   * fixes the silent-relocation regression: an upgrade never moves an existing CR
   * versus the released v0.26.0, and NO per-call `spec.namespace` is consulted for
   * CR placement. An explicit `instanceNamespace` factory option still wins as an
   * override (the only way to place the CR elsewhere).
   *
   * Identity distinctness within a single alchemy stack comes from the instance
   * NAME: the top-level alchemy id is the legacy namespace-agnostic kind+name (see
   * {@link instanceAlchemyId}, finding #1). NOTE: a different k8s factory namespace
   * does NOT by itself create a different alchemy scope — two factories with the same
   * instance name but different namespaces expose the SAME alchemy id and, if
   * materialized in the SAME alchemy stack, collide (last write wins). Isolating
   * same-named instances (e.g. `analytics` in dev vs prod) is the CALLER's
   * responsibility: put them in SEPARATE alchemy stacks/scopes. `spec.namespace` is
   * never consulted for CR placement or identity.
   *
   * The `spec` parameter is accepted only for call-site symmetry with the other
   * resolvers and is deliberately unused (CR placement must not vary per spec, or
   * `getInstances`/`deleteInstance` — which have no spec — could target a different
   * namespace than `deploy` and orphan the CR, finding #3).
   *
   * Finalizer-stranding safety comes from HOISTING the composition's own workload
   * Namespace OUT of the RGD graph (see {@link hoistedNamespaceNames}), not from
   * where the instance CR lives.
   */
  private resolveInstanceNamespace(_spec?: TSpec): string {
    const explicit = this.factoryOptions.instanceNamespace;
    if (explicit !== undefined) return explicit;
    return this.namespace;
  }

  /**
   * Every Namespace HOISTED out of the RGD graph, mapped to its RAW `metadata.name`
   * value — the UNCONDITIONAL model (typekro NEVER emits a Namespace into RGD YAML).
   * Selection is trivially `kind === 'Namespace'` (excluding `__externalRef`
   * observed namespaces); see {@link selectHoistedNamespaces}.
   *
   * This is a STABLE STRUCTURAL property of the RGD, computed WITHOUT any concrete
   * spec: the set of hoisted ids is IDENTICAL for every instance of this factory, so
   * the shared RGD never changes shape per-instance (deploying instance 2 can't
   * mutate the graph instance 1 depends on). The name VALUES feed the reference
   * rewriter so a reference to a hoisted Namespace's `metadata.name` becomes that
   * Namespace's own concrete name expression.
   */
  private hoistedNamespaceRefs(
    resources: Record<string, KubernetesResource> = this.resources
  ): Map<string, unknown> {
    return selectHoistedNamespaces(resources);
  }

  /**
   * The CONCRETE Namespace resources to emit as SIBLINGS (deps-first, outside the
   * graph) for this spec, keyed by namespace NAME.
   *
   * The set of hoisted IDS is STRUCTURAL (spec-independent); resolving those ids to
   * concrete resources needs the spec. Re-executing the composition against the
   * concrete spec yields the FULL concrete Namespace metadata (name + all labels,
   * incl. Pod Security, + all annotations), which the emission paths PRESERVE and
   * merge retention onto (finding #5) — never a bare synthesized Namespace. A hoisted
   * id that is inactive under THIS spec (e.g. `includeWhen: false`) or whose name
   * can't be resolved is skipped, so emission stays per-spec and order-independent.
   * The map value is the ORIGINAL concrete Namespace resource (keyed by resolved
   * name).
   */
  private concreteHoistedNamespaces(spec?: TSpec): Map<string, KubernetesResource> {
    const result = new Map<string, KubernetesResource>();
    const hoistIds = this.hoistedNamespaceRefs();
    if (hoistIds.size === 0 || spec === undefined) return result;

    const compositionFn = this.factoryOptions.compositionFn as ((s: TSpec) => unknown) | undefined;
    const concreteById = concreteOwnedNamespaceResources<TSpec>({
      compositionName: this.name,
      spec,
      resources: this.resources,
      ...(compositionFn ? { compositionFn } : {}),
    });

    for (const id of hoistIds.keys()) {
      const concrete = concreteById.get(id);
      // Inactive under this spec (conditionally-excluded) → nothing to emit.
      if (!concrete) continue;
      const name =
        resolveNamespaceName(concrete.metadata?.name, spec as KroCompatibleType) ??
        (typeof concrete.metadata?.name === 'string' ? concrete.metadata.name : undefined);
      if (name === undefined) continue;
      result.set(name, concrete);
    }
    return result;
  }

  /**
   * The concrete NAMES of the namespaces hoisted out of the graph for this spec —
   * used to tell the ownership guard which owned namespace is now safe (no longer a
   * graph child), and as the singleton keys for sibling emission.
   */
  private hoistedNamespaceNames(spec?: TSpec): Set<string> {
    return new Set(this.concreteHoistedNamespaces(spec).keys());
  }

  /**
   * The resource map serialized into the RGD: `resources` minus EVERY hoisted
   * Namespace, with every remaining reference to a hoisted Namespace's
   * `metadata.name` rewritten to that Namespace's own concrete name expression
   * (finding #3) so the emitted RGD carries no dangling reference to a removed
   * resource. The hoist decision is STRUCTURAL (spec-independent), so the RGD shape
   * is stable across every instance of this factory (finding #4).
   */
  private resourcesForRgd(
    resources: Record<string, KubernetesResource>
  ): Record<string, KubernetesResource> {
    const hoistIds = this.hoistedNamespaceRefs(resources);
    if (hoistIds.size === 0) return resources;
    const remaining = Object.fromEntries(
      Object.entries(resources).filter(([id]) => !hoistIds.has(id))
    ) as Record<string, KubernetesResource>;
    return rewriteHoistedNamespaceReferences(remaining, hoistIds);
  }

  /**
   * Compile captured symbolic intent back into the established serializer input.
   * Legacy resources remain a fallback for factories created outside the
   * composition capture frontend.
   */
  private plannedResources(): Record<string, KubernetesResource> {
    const capture = this.factoryOptions.semanticCapture;
    if (!capture) {
      return this.resources;
    }
    const configuredPlan = this.factoryOptions.plan ?? {};
    const plan = capture.planTemplate({
      ...configuredPlan,
      aspects: configuredPlan.aspects ?? this.factoryOptions.aspects ?? [],
    });
    const outerInputs = this.outerArtifactCompilationInputs();
    const artifacts = compileKroArtifactPlan(plan, {
      strict: true,
      rgdName: this.rgdName,
      ...outerInputs,
      ...(this.factoryOptions.applyPolicy
        ? { outerApplyPolicy: this.factoryOptions.applyPolicy }
        : {}),
    });
    return kroArtifactPlanToGraphResources(artifacts);
  }

  /** Compile this factory's local graph and directly managed outer artifacts once. */
  private compiledKroArtifactPlan(
    spec?: TSpec,
    options: {
      memberId?: string;
      instanceNameOverride?: string;
      singletonSpecFingerprint?: string;
    } = {}
  ): KroArtifactPlanMaterialization | undefined {
    const capture = this.factoryOptions.semanticCapture;
    if (!capture) return undefined;
    const configuredPlan = this.factoryOptions.plan ?? {};
    const planOptions = {
      ...configuredPlan,
      aspects: configuredPlan.aspects ?? this.factoryOptions.aspects ?? [],
    };
    const plan = capture.planTemplate(planOptions);
    const concretePlan = spec === undefined ? undefined : capture.planSymbolic(spec, planOptions);
    const memberId = options.memberId ?? 'root';
    const instanceSpec = concretePlan
      ? mapPlanValueSensitiveBindings(concretePlan.spec, (binding) =>
          kroMemberSensitiveBinding(memberId, binding)
        )
      : undefined;
    const sensitiveBindings =
      spec !== undefined && instanceSpec
        ? collectPlanValueSensitiveBindings(
            instanceSpec,
            spec,
            `$.members.${memberId}.instance.spec`
          )
        : {};
    const instanceName =
      spec === undefined
        ? undefined
        : (options.instanceNameOverride ?? generateInstanceName(spec, this.name));
    const metadata =
      spec === undefined
        ? undefined
        : this.instanceManifestMetadata(spec, options.singletonSpecFingerprint);
    const artifacts = compileKroArtifactPlan(plan, {
      strict: true,
      rgdName: this.rgdName,
      ...this.outerArtifactCompilationInputs(spec),
      ...(this.factoryOptions.applyPolicy
        ? { outerApplyPolicy: this.factoryOptions.applyPolicy }
        : {}),
      ...(spec !== undefined && instanceName && metadata && instanceSpec
        ? {
            instance: {
              name: lowerPlanValue(instanceName).value,
              namespace: lowerPlanValue(this.resolveInstanceNamespace(spec)).value,
              apiVersion: this.getInstanceApiVersion(),
              kind: this.schemaDefinition.kind,
              spec: instanceSpec,
              labels: lowerPlanValue(metadata.labels).value,
              annotations: lowerPlanValue(metadata.annotations).value,
            },
          }
        : {}),
    });
    return { artifacts, sensitiveBindings };
  }

  /**
   * Recursively compile local plans into physical outer operations. Cross-member
   * singleton edges resolve to the owner's concrete instance operation.
   */
  private compileKroBundleAssembly(
    spec: TSpec | undefined,
    options: {
      memberId: string;
      root: boolean;
      instanceNameOverride?: string;
      singletonSpecFingerprint?: string;
      singletonStack: readonly string[];
    }
  ): KroBundleAssembly | undefined {
    const compilation = this.compiledKroArtifactPlan(spec, options);
    if (!compilation) return undefined;
    const { artifacts } = compilation;
    const sensitiveBindings: Record<string, unknown> = {
      ...compilation.sensitiveBindings,
    };

    const childOperations: KroArtifactBundleOperation[] = [];
    const requiredCapabilities: CapabilityRequirement[] = [...artifacts.requiredCapabilities];
    const artifactRequirements: ArtifactRequirement[] = [...artifacts.artifactRequirements];
    const singletonOperationByPhysicalId = new Map<string, string>();
    const definitions =
      spec === undefined ? this.singletonDefinitions : this.discoverSingletonDefinitions(spec);
    for (const definition of definitions) {
      if (options.singletonStack.includes(definition.key)) {
        throw new TypeKroError(
          `Singleton dependency cycle detected: ${[...options.singletonStack, definition.key].join(' -> ')}`,
          'KRO_SINGLETON_DEPENDENCY_CYCLE',
          { singletonKey: definition.key }
        );
      }
      const singletonFactory = this.singletonFactoryFor(definition) as KroResourceFactoryImpl<
        KroCompatibleType,
        KroCompatibleType
      >;
      const child = singletonFactory.compileKroBundleAssembly(
        definition.spec as KroCompatibleType,
        {
          memberId: `singleton:${definition.key}`,
          root: false,
          instanceNameOverride: getSingletonInstanceName(definition.id),
          singletonSpecFingerprint: singletonSpecFingerprintAnnotationValue(
            definition.specFingerprint
          ),
          singletonStack: [...options.singletonStack, definition.key],
        }
      );
      if (!child?.instanceOperationId) {
        throw new TypeKroError(
          `Singleton owner ${definition.key} did not compile a concrete instance operation.`,
          'KRO_SINGLETON_OWNER_ARTIFACT_MISSING',
          { singletonKey: definition.key }
        );
      }
      mergeSensitiveBindingEnvelopes(sensitiveBindings, child.sensitiveBindings);
      childOperations.push(...child.operations);
      requiredCapabilities.push(...child.requiredCapabilities);
      artifactRequirements.push(...child.artifactRequirements);
      const ownerOperation = child.operations.find(
        (operation) => operation.id === child.instanceOperationId
      );
      if (!ownerOperation) {
        throw new TypeKroError(
          `Singleton owner ${definition.key} instance operation is absent from its bundle.`,
          'KRO_SINGLETON_OWNER_ARTIFACT_MISSING',
          { singletonKey: definition.key, operationId: child.instanceOperationId }
        );
      }
      singletonOperationByPhysicalId.set(ownerOperation.id, ownerOperation.id);
    }

    const source = {
      memberId: options.memberId,
      planIdentityDigest: artifacts.planIdentityDigest,
      compiledArtifactDigest: artifacts.compiledArtifactDigest,
    };
    const operations: KroArtifactBundleOperation[] = [...childOperations];
    const operationIdByArtifactId = new Map<string, string>();

    for (const artifact of artifacts.resources.filter(
      (candidate): candidate is KroSupportingArtifact => candidate.role === 'singleton-owner'
    )) {
      if (!artifact.identity) {
        throw new TypeKroError(
          `Singleton artifact ${artifact.id} has no physical identity.`,
          'KRO_ARTIFACT_BUNDLE_IDENTITY_MISSING',
          { artifactId: artifact.id }
        );
      }
      const name = materializePlanValue(artifact.identity.name, {
        sensitive: sensitiveBindings,
      });
      const namespace = artifact.identity.namespace
        ? materializePlanValue(artifact.identity.namespace, {
            sensitive: sensitiveBindings,
          })
        : undefined;
      if (typeof name !== 'string' || (namespace !== undefined && typeof namespace !== 'string')) {
        throw new TypeKroError(
          `Singleton artifact ${artifact.id} has a non-concrete physical identity.`,
          'KRO_ARTIFACT_BUNDLE_IDENTITY_MISSING',
          { artifactId: artifact.id, name, namespace }
        );
      }
      const physicalId = kroBundleOperationId({
        apiVersion: artifact.identity.apiVersion,
        kind: artifact.identity.kind,
        metadata: { name, ...(namespace ? { namespace } : {}) },
      });
      const ownerOperationId = singletonOperationByPhysicalId.get(physicalId);
      if (!ownerOperationId) {
        throw new TypeKroError(
          `Singleton artifact ${artifact.id} has no compiled owner member.`,
          'KRO_SINGLETON_OWNER_ARTIFACT_MISSING',
          { artifactId: artifact.id, physicalId }
        );
      }
      operationIdByArtifactId.set(artifact.id, ownerOperationId);
    }

    const nonSingletonArtifacts: KroArtifactPlan = {
      ...artifacts,
      resources: artifacts.resources.filter((artifact) => artifact.role !== 'singleton-owner'),
    };
    for (const { artifact, resource } of kroArtifactPlanToSupportingResources(
      nonSingletonArtifacts,
      {
        readinessEvaluators: this.prerequisiteRuntimeReadinessEvaluators(),
        resolveReadinessStrategy: resolvePortableReadinessStrategy,
      }
    )) {
      if (artifact.role === 'singleton-owner') {
        throw new TypeKroError(
          `Singleton artifact ${artifact.id} bypassed identity-only bundle lowering.`,
          'KRO_SINGLETON_OWNER_ARTIFACT_INVALID',
          { artifactId: artifact.id }
        );
      }
      const physicalId = kroBundleOperationId(resource);
      operationIdByArtifactId.set(artifact.id, physicalId);
      operations.push({
        id: physicalId,
        role: artifact.role,
        sources: [source],
        artifact,
        manifest: lowerPlanValue(resource).value,
        dependencies: [],
      });
    }

    const rgdArtifact = artifacts.resources.find(
      (artifact) => artifact.role === 'resource-graph-definition'
    );
    if (!rgdArtifact || rgdArtifact.role !== 'resource-graph-definition') {
      throw new TypeKroError(
        `KRO plan ${artifacts.compiledArtifactDigest} has no RGD artifact.`,
        'KRO_RGD_ARTIFACT_MISSING'
      );
    }
    const rgdManifest = this.buildRgdManifest();
    const rgdOperationId = kroBundleOperationId(rgdManifest as KubernetesResource);
    operationIdByArtifactId.set(rgdArtifact.id, rgdOperationId);
    operations.push({
      id: rgdOperationId,
      role: options.root ? 'resource-graph-definition' : 'singleton-owner-rgd',
      sources: [source],
      artifact: rgdArtifact,
      manifest: lowerPlanValue(rgdManifest).value,
      dependencies: [],
    });

    let instanceOperationId: string | undefined;
    if (spec !== undefined) {
      const instanceArtifact = artifacts.resources.find((artifact) => artifact.role === 'instance');
      if (!instanceArtifact || instanceArtifact.role !== 'instance') {
        throw new TypeKroError(
          `KRO plan ${artifacts.compiledArtifactDigest} has no instance artifact.`,
          'KRO_INSTANCE_ARTIFACT_MISSING'
        );
      }
      if (!instanceArtifact.identity) {
        throw new TypeKroError(
          `KRO instance artifact ${instanceArtifact.id} has no physical identity.`,
          'KRO_ARTIFACT_BUNDLE_IDENTITY_MISSING',
          { artifactId: instanceArtifact.id }
        );
      }
      const instanceName = materializePlanValue(instanceArtifact.identity.name, {
        sensitive: sensitiveBindings,
      });
      const instanceNamespace = instanceArtifact.identity.namespace
        ? materializePlanValue(instanceArtifact.identity.namespace, {
            sensitive: sensitiveBindings,
          })
        : undefined;
      if (
        typeof instanceName !== 'string' ||
        (instanceNamespace !== undefined && typeof instanceNamespace !== 'string')
      ) {
        throw new TypeKroError(
          `KRO instance artifact ${instanceArtifact.id} has a non-concrete physical identity.`,
          'KRO_ARTIFACT_BUNDLE_IDENTITY_MISSING',
          { artifactId: instanceArtifact.id, instanceName, instanceNamespace }
        );
      }
      instanceOperationId = kroBundleOperationId({
        apiVersion: instanceArtifact.identity.apiVersion,
        kind: instanceArtifact.identity.kind,
        metadata: {
          name: instanceName,
          ...(instanceNamespace ? { namespace: instanceNamespace } : {}),
        },
      });
      operationIdByArtifactId.set(instanceArtifact.id, instanceOperationId);
      operations.push({
        id: instanceOperationId,
        role: options.root ? 'instance' : 'singleton-owner-instance',
        sources: [source],
        artifact: instanceArtifact,
        manifest: instanceArtifact.desired,
        dependencies: [],
      });
    }

    const dependencies = new Map<string, Set<string>>();
    for (const edge of artifacts.edges) {
      let prerequisite: string | undefined;
      let dependent: string | undefined;
      switch (edge.kind) {
        case 'output':
          prerequisite = operationIdByArtifactId.get(edge.producer);
          dependent = operationIdByArtifactId.get(edge.consumer);
          break;
        case 'existence':
        case 'ready':
          prerequisite = operationIdByArtifactId.get(edge.prerequisite);
          dependent = operationIdByArtifactId.get(edge.dependent);
          break;
        case 'ownership':
          prerequisite = operationIdByArtifactId.get(edge.owner);
          dependent = operationIdByArtifactId.get(edge.child);
          break;
        case 'delete-after':
          break;
      }
      if (!prerequisite || !dependent || prerequisite === dependent) continue;
      const incoming = dependencies.get(dependent) ?? new Set<string>();
      incoming.add(prerequisite);
      dependencies.set(dependent, incoming);
    }

    return {
      operations: mergeKroArtifactBundleOperations(
        operations.map((operation) => ({
          ...operation,
          dependencies: [
            ...new Set([
              ...operation.dependencies,
              ...(dependencies.get(operation.id) ?? new Set<string>()),
            ]),
          ],
        }))
      ),
      requiredCapabilities: uniqueCapabilityRequirements(requiredCapabilities),
      artifactRequirements: uniqueArtifactRequirements(artifactRequirements),
      rgdOperationId,
      ...(instanceOperationId ? { instanceOperationId } : {}),
      sensitiveBindings,
    };
  }

  /** Compile, canonicalize, and decode the complete KRO outer bundle. */
  private compiledKroArtifactBundle(
    spec?: TSpec,
    options: {
      instanceNameOverride?: string;
      singletonSpecFingerprint?: string;
    } = {}
  ): KroArtifactBundleMaterialization | undefined {
    const assembly = this.compileKroBundleAssembly(spec, {
      memberId: 'root',
      root: true,
      ...options,
      singletonStack: [],
    });
    if (!assembly) return undefined;
    const bundle = createKroArtifactBundle({
      root: {
        memberId: 'root',
        rgdOperationId: assembly.rgdOperationId,
        ...(assembly.instanceOperationId
          ? { instanceOperationId: assembly.instanceOperationId }
          : {}),
      },
      operations: assembly.operations,
      requiredCapabilities: assembly.requiredCapabilities,
      artifactRequirements: assembly.artifactRequirements,
    });
    return {
      bundle: decodeKroArtifactBundle(encodeKroArtifactBundle(bundle)),
      sensitiveBindings: assembly.sensitiveBindings,
    };
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
  private async ensureTargetNamespace(
    namespace = this.namespace,
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      abortSignal?.throwIfAborted();
      const { createBunCompatibleKubernetesObjectApi } = await import(
        '../kubernetes/bun-api-client.js'
      );
      const k8sApi = createBunCompatibleKubernetesObjectApi(this.getKubeConfig());
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
              clearTimeout(timeout);
              reject(
                abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError')
              );
            };
            const timeout = setTimeout(() => {
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

  /**
   * STRICT plural discovery (finding #3, fail-closed). Distinguishes a definitive
   * "CRD absent" (a successful CRD list with no matching definition → fresh cluster)
   * from a discovery FAILURE (RBAC/connectivity/list error) — the latter is NOT proof
   * of absence, so it THROWS rather than being swallowed into `undefined` the way
   * {@link lookupCRDPlural} does. Callers that must fail closed (the pre-hoist safety
   * guard) use this; callers that may fall back to a heuristic keep using
   * {@link lookupCRDPlural}.
   */
  private async discoverGeneratedCrdPlural(): Promise<
    { present: true; plural: string } | { present: false }
  > {
    const k8sApi = this.createKubernetesObjectApi();
    // A LIST failure propagates (NOT caught) so callers FAIL CLOSED.
    const crds = (await k8sApi.list(
      'apiextensions.k8s.io/v1',
      'CustomResourceDefinition'
    )) as unknown as {
      items?: Array<{ spec?: { group?: string; names?: { kind?: string; plural?: string } } }>;
    };
    const match = crds?.items?.find(
      (crd) =>
        crd.spec?.group === this.getSchemaGroup() &&
        crd.spec?.names?.kind === this.schemaDefinition.kind
    );
    const plural = match?.spec?.names?.plural;
    return plural ? { present: true, plural } : { present: false };
  }

  private async requireCRDPluralForCleanup(): Promise<string> {
    if (!this.discoveredPlural) {
      this.discoveredPlural = await this.lookupCRDPlural();
    }
    if (!this.discoveredPlural) {
      // Teardown-only guard: without the plural we cannot list instances to decide
      // whether the RGD is shared, so the caller preserves the RGD (conservative). The
      // generated CRD is intentionally RETAINED regardless (v4), so this no longer
      // guards against orphaning it.
      throw new CRDInstanceError(
        `Cannot determine CRD plural for ${this.schemaDefinition.kind}; preserving RGD to avoid deleting shared KRO state`,
        this.schemaDefinition.apiVersion,
        this.schemaDefinition.kind,
        '*',
        'deletion'
      );
    }
    return this.discoveredPlural;
  }

  /**
   * Definitive retry state: both the generated CRD and its RGD are absent, so
   * no instance can still exist. This lets a later deleteInstance() invocation
   * finish durable owned-namespace cleanup after an earlier teardown removed
   * the definitions. Any read/list uncertainty returns false (fail closed).
   */
  private async kroDefinitionsAreAbsent(): Promise<boolean> {
    try {
      const crd = await this.discoverGeneratedCrdPlural();
      if (crd.present) return false;
      const k8sApi = this.createKubernetesObjectApi();
      try {
        await k8sApi.read({
          apiVersion: 'kro.run/v1alpha1',
          kind: 'ResourceGraphDefinition',
          metadata: { name: this.rgdName },
        });
        return false;
      } catch (error: unknown) {
        return isNotFoundError(error);
      }
    } catch {
      return false;
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
    if (opts?.targetScopes !== undefined) {
      throw new TypeKroError(
        'Scope-targeted deployment is not supported in KRO mode. KRO manages resource lifecycle via its own controller. Use direct mode for scope-targeted deploys.',
        'UNSUPPORTED_OPTION',
        { targetScopes: opts.targetScopes, mode: 'kro' }
      );
    }
    this.assertNoReservedKroSpecField(spec);
    // Validate spec against ArkType schema
    validateSpec(spec, this.schemaDefinition, {
      kind: this.schemaDefinition.kind,
      name: this.name,
    });
    this.assertInstanceNamespaceOwnershipSafe(spec);

    const compiledBundle = this.compiledKroArtifactBundle(spec, {
      ...(opts?.instanceNameOverride ? { instanceNameOverride: opts.instanceNameOverride } : {}),
      ...(opts?.singletonSpecFingerprint
        ? { singletonSpecFingerprint: opts.singletonSpecFingerprint }
        : {}),
    });
    this.assertBundleCapabilities(compiledBundle?.bundle, {
      host: 'standalone',
      output: 'live',
    });

    // Execute compatibility closures only after the complete semantic bundle
    // has passed host/output capability negotiation, but before RGD creation.
    await this.executeClosuresBeforeRGD(spec, abortSignal);

    if (compiledBundle) {
      return this.deployKroArtifactBundle(
        compiledBundle.bundle,
        spec,
        compiledBundle.sensitiveBindings,
        abortSignal
      );
    }

    await this.ensureSingletonOwners(spec, abortSignal);
    return this.deployDirect(
      spec,
      opts?.instanceNameOverride,
      opts?.singletonSpecFingerprint,
      abortSignal
    );
  }

  /**
   * Discover the singleton-owner definitions this composition depends on (deduped by key): from
   * re-executing the composition fn under a discovery context, plus any injected definitions.
   * Shared by {@link ensureSingletonOwners} (imperative deploy) and {@link toAlchemyResources}.
   */
  private discoverSingletonDefinitions(spec: TSpec): SingletonDefinitionRecord[] {
    const discovered = new Map<string, SingletonDefinitionRecord>();
    if (this.factoryOptions.compositionFn) {
      const ctx = createCompositionContext('singleton-owner-discovery');
      runWithCompositionContext(ctx, () => {
        this.factoryOptions.compositionFn?.(spec);
      });
      for (const [key, definition] of ctx.singletonDefinitions ?? []) {
        discovered.set(key, definition);
      }
    }
    for (const definition of this.singletonDefinitions) {
      if (!discovered.has(definition.key)) discovered.set(definition.key, definition);
    }
    return Array.from(discovered.values());
  }

  /**
   * Recreate only the runtime member contexts needed to execute a decoded KRO
   * bundle. Desired state and ordering remain authoritative in the bundle;
   * these contexts provide existing operational hooks, clients, and status
   * hydration for each compiled member.
   */
  private collectKroBundleRuntimeMembers(spec: TSpec): Map<string, KroBundleRuntimeMember> {
    const rootFactory = this as unknown as KroResourceFactoryImpl<
      KroCompatibleType,
      KroCompatibleType
    >;
    const members = new Map<string, KroBundleRuntimeMember>([
      [
        'root',
        {
          memberId: 'root',
          factory: rootFactory,
          spec,
          consumers: [],
          dispose: false,
        },
      ],
    ]);

    const visit = (member: KroBundleRuntimeMember, stack: readonly string[]): void => {
      for (const definition of member.factory.discoverSingletonDefinitions(member.spec)) {
        if (stack.includes(definition.key)) {
          throw new TypeKroError(
            `Singleton dependency cycle detected: ${[...stack, definition.key].join(' -> ')}`,
            'KRO_SINGLETON_DEPENDENCY_CYCLE',
            { singletonKey: definition.key }
          );
        }
        const memberId = `singleton:${definition.key}`;
        const consumer = { factory: member.factory, definition };
        const existing = members.get(memberId);
        if (existing) {
          existing.consumers.push(consumer);
          continue;
        }
        const childFactory = member.factory.singletonFactoryFor(
          definition
        ) as KroResourceFactoryImpl<KroCompatibleType, KroCompatibleType>;
        const child: KroBundleRuntimeMember = {
          memberId,
          factory: childFactory,
          spec: definition.spec as KroCompatibleType,
          definition,
          consumers: [consumer],
          dispose: true,
        };
        members.set(memberId, child);
        visit(child, [...stack, definition.key]);
      }
    };

    const root = members.get('root');
    if (!root) {
      throw new TypeKroError(
        'KRO bundle runtime member collection lost the root member.',
        'KRO_ARTIFACT_BUNDLE_MEMBER_MISSING'
      );
    }
    visit(root, []);
    return members;
  }

  /** Build the KRO factory that owns a singleton's RGD + instance (its registry namespace). */
  private singletonFactoryFor(
    definition: SingletonDefinitionRecord
  ): KroResourceFactoryImpl<KroCompatibleType, KroCompatibleType> {
    return definition.composition.factory('kro', {
      namespace: definition.registryNamespace,
      // Pin the singleton owner CR to its registry namespace (its externalRef
      // consumers resolve against that namespace). This equals the workload
      // namespace, so it is NOT decoupled — a singleton composition that owns
      // the registry namespace is still rejected by the ownership guard.
      instanceNamespace: definition.registryNamespace,
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
    }) as KroResourceFactoryImpl<KroCompatibleType, KroCompatibleType>;
  }

  private async ensureSingletonOwners(spec: TSpec, operationSignal?: AbortSignal): Promise<void> {
    for (const definition of this.discoverSingletonDefinitions(spec)) {
      await this.ensureTargetNamespace(definition.registryNamespace, operationSignal);

      const singletonInstanceName = getSingletonInstanceName(definition.id);
      const singletonFactory = this.singletonFactoryFor(definition);

      try {
        this.logger.info('Ensuring singleton owner boundary', {
          singletonId: definition.id,
          singletonKey: definition.key,
          registryNamespace: definition.registryNamespace,
        });

        const existingInstances = await this.getSingletonOwnerInstancesForDriftCheck(
          singletonFactory,
          definition,
          operationSignal
        );
        assertNoDeployedSingletonSpecDrift(definition, singletonInstanceName, existingInstances);

        const singletonDeployOptions: InternalResourceFactoryDeployOptions = {
          instanceNameOverride: singletonInstanceName,
          singletonSpecFingerprint: singletonSpecFingerprintAnnotationValue(
            definition.specFingerprint
          ),
          ...(operationSignal ? { operationSignal } : {}),
        };
        const deployedSingleton = await singletonFactory.deploy(
          definition.spec as TSpec,
          singletonDeployOptions
        );
        const singletonStatus = (deployedSingleton as { status?: unknown }).status;
        if (
          singletonStatus &&
          typeof singletonStatus === 'object' &&
          !Array.isArray(singletonStatus)
        ) {
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
    singletonFactory: KroResourceFactoryImpl<KroCompatibleType, KroCompatibleType>,
    definition: SingletonDefinitionRecord,
    operationSignal?: AbortSignal
  ): Promise<Enhanced<KroCompatibleType, KroCompatibleType>[]> {
    try {
      return await singletonFactory.getInstances(operationSignal ? { operationSignal } : undefined);
    } catch (error: unknown) {
      if (this.isMissingSingletonOwnerCrdError(error)) {
        this.logger.debug(
          'Singleton owner CRD is not installed yet; continuing with first deploy',
          {
            singletonId: definition.id,
            singletonKey: definition.key,
            registryNamespace: definition.registryNamespace,
            error: ensureError(error).message,
          }
        );
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
  private async executeClosuresBeforeRGD(
    _spec: TSpec,
    abortSignal?: AbortSignal
  ): Promise<AppliedResource[]> {
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
      validationOnly: true,
      ...(abortSignal ? { abortSignal } : {}),
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
        abortSignal?.throwIfAborted();
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
      ...(abortSignal ? { abortSignal } : {}),
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
        abortSignal?.throwIfAborted();
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

  private assertBundleCapabilities(
    bundle: KroArtifactBundle | undefined,
    context: { readonly host: 'standalone' | 'alchemy' | null; readonly output: 'live' | 'static' }
  ): void {
    const compatibilityRequirements: readonly CapabilityRequirement[] =
      bundle?.requiredCapabilities ??
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
      target: 'kro',
      ...context,
    });
  }

  private materializeKroBundleRuntimeResource(
    operation: KroArtifactBundleOperation,
    member: KroBundleRuntimeMember,
    sensitiveBindings: Readonly<Record<string, unknown>>
  ): KubernetesResource {
    const resource = materializeKroArtifactBundleOperation(operation, {
      sensitive: sensitiveBindings,
    });
    Object.defineProperty(resource, 'id', {
      value: operation.id,
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
      const evaluator = member.factory.prerequisiteRuntimeReadinessEvaluators()[strategy.binding];
      if (!evaluator) {
        throw new TypeKroError(
          `KRO readiness binding ${strategy.binding} is unavailable for operation ${operation.id}.`,
          'KRO_ARTIFACT_READINESS_UNAVAILABLE',
          { operationId: operation.id, binding: strategy.binding }
        );
      }
      setReadinessEvaluator(resource, evaluator);
    } else if (strategy?.kind === 'registered') {
      const evaluator = resolvePortableReadinessStrategy(strategy);
      if (!evaluator) {
        throw new TypeKroError(
          `Registered readiness strategy ${strategy.id}@${strategy.revision} is unavailable.`,
          'KRO_ARTIFACT_READINESS_UNAVAILABLE',
          { operationId: operation.id, strategy: strategy.id }
        );
      }
      setReadinessEvaluator(resource, evaluator);
    }
    return resource;
  }

  /** Execute every directly managed KRO operation from one decoded artifact bundle. */
  private async deployKroArtifactBundle(
    bundle: KroArtifactBundle,
    spec: TSpec,
    sensitiveBindings: Readonly<Record<string, unknown>>,
    abortSignal?: AbortSignal
  ): Promise<Enhanced<TSpec, TStatus>> {
    const members = this.collectKroBundleRuntimeMembers(spec);
    const childMembers = [...members.values()].filter((member) => member.dispose);
    const deploymentEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );
    let rootResult: Enhanced<TSpec, TStatus> | undefined;

    const memberFor = (operation: KroArtifactBundleOperation): KroBundleRuntimeMember => {
      for (const source of operation.sources) {
        const member = members.get(source.memberId);
        if (member) return member;
      }
      throw new TypeKroError(
        `KRO bundle operation ${operation.id} has no runtime member context.`,
        'KRO_ARTIFACT_BUNDLE_MEMBER_MISSING',
        { operationId: operation.id }
      );
    };

    try {
      abortSignal?.throwIfAborted();
      // Preserve singleton operational checks and compatibility closures while
      // taking desired state and ordering exclusively from the decoded bundle.
      for (const member of childMembers) {
        const definition = member.definition;
        if (!definition) {
          throw new TypeKroError(
            `KRO bundle member ${member.memberId} has no singleton definition.`,
            'KRO_ARTIFACT_BUNDLE_MEMBER_MISSING',
            { memberId: member.memberId }
          );
        }
        await member.factory.ensureTargetNamespace(definition.registryNamespace, abortSignal);
        const existing = await member.factory.getSingletonOwnerInstancesForDriftCheck(
          member.factory,
          definition,
          abortSignal
        );
        assertNoDeployedSingletonSpecDrift(
          definition,
          getSingletonInstanceName(definition.id),
          existing
        );
        await member.factory.executeClosuresBeforeRGD(member.spec, abortSignal);
      }

      // Fail closed on pre-hoist upgrades before mutating any RGD, then ensure
      // every CR placement namespace not represented by a hoisted artifact.
      for (const member of members.values()) {
        abortSignal?.throwIfAborted();
        const hoistedNames = bundle.operations
          .filter(
            (operation) =>
              operation.role === 'hoisted-namespace' &&
              operation.sources.some((source) => source.memberId === member.memberId)
          )
          .map(
            (operation) =>
              materializeKroArtifactBundleOperation(operation, {
                sensitive: sensitiveBindings,
              }).metadata.name
          )
          .filter((name): name is string => typeof name === 'string');
        await member.factory.assertNoPreHoistNamespaceConflict(hoistedNames);

        const instanceOperation = bundle.operations.find(
          (operation) =>
            (operation.role === 'instance' || operation.role === 'singleton-owner-instance') &&
            operation.sources.some((source) => source.memberId === member.memberId)
        );
        if (instanceOperation) {
          const instance = materializeKroArtifactBundleOperation(instanceOperation, {
            sensitive: sensitiveBindings,
          });
          const namespace = instance.metadata.namespace ?? member.factory.namespace;
          if (!hoistedNames.includes(namespace)) {
            await member.factory.ensureTargetNamespace(namespace, abortSignal);
          }
        }
      }

      for (const operation of orderKroArtifactBundleOperations(bundle)) {
        abortSignal?.throwIfAborted();
        const member = memberFor(operation);
        const resource = this.materializeKroBundleRuntimeResource(
          operation,
          member,
          sensitiveBindings
        );
        const namespace = resource.metadata.namespace ?? member.factory.namespace;

        if (operation.role === 'kro-prerequisite') {
          const waitForReady = getReadinessEvaluator(resource) !== undefined;
          const deployable = waitForReady
            ? ensureReadinessEvaluator(resource as Enhanced<unknown, unknown>)
            : resource;
          await deploymentEngine.deployResource(
            deployable as DeployableK8sResource<Enhanced<unknown, unknown>>,
            {
              mode: 'direct',
              namespace,
              waitForReady,
              timeout: member.factory.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT,
              ...(abortSignal ? { abortSignal } : {}),
            }
          );
          const crdName = member.factory.prerequisiteCRDName(resource);
          if (crdName) {
            await deploymentEngine.waitForCRDReady(
              crdName,
              member.factory.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT,
              abortSignal
            );
          }
          continue;
        }

        if (operation.role === 'hoisted-namespace') {
          await member.factory.applyRetainedHoistedNamespace(
            resource,
            operation.artifact as KroSupportingArtifact,
            abortSignal
          );
          continue;
        }

        if (
          operation.role === 'resource-graph-definition' ||
          operation.role === 'singleton-owner-rgd'
        ) {
          await member.factory.runKroPrerequisiteHook(deploymentEngine, undefined, abortSignal);
          await member.factory.addRgdSchemaStatusPruneMarkers(resource);
          const rgdFactory =
            member.factory.rgdProvider ??
            (await import('../../factories/kro/resource-graph-definition.js'))
              .resourceGraphDefinition;
          const enhanced = rgdFactory(resource as unknown as Record<string, unknown>);
          copyResourceMetadata(resource, enhanced);
          const deployable = {
            ...enhanced,
            id: operation.id,
          } as DeployableK8sResource<Enhanced<Record<string, unknown>, Record<string, unknown>>>;
          copyResourceMetadata(enhanced, deployable);
          await deploymentEngine.deployResource(deployable, {
            mode: 'direct',
            namespace: member.factory.namespace,
            waitForReady: true,
            timeout: member.factory.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT,
            ...(abortSignal ? { abortSignal } : {}),
          });
          await member.factory.waitForCRDReadyWithEngine(deploymentEngine, abortSignal);
          continue;
        }

        const kroCustomResource =
          member.factory.kroCustomResourceProvider ??
          (await import('../../factories/kro/kro-custom-resource.js')).kroCustomResource;
        const resourceName = resource.metadata.name;
        if (typeof resourceName !== 'string' || resourceName.length === 0) {
          throw new TypeKroError(
            `KRO instance operation ${operation.id} has no concrete metadata.name.`,
            'KRO_ARTIFACT_BUNDLE_IDENTITY_MISSING',
            { operationId: operation.id }
          );
        }
        const enhanced = kroCustomResource({
          apiVersion: resource.apiVersion,
          kind: resource.kind,
          metadata: { ...resource.metadata, name: resourceName },
          spec: resource.spec as KroCompatibleType,
        });
        copyResourceMetadata(resource, enhanced);
        const deployable = {
          ...enhanced,
          id: operation.id,
          metadata: { ...enhanced.metadata, name: resourceName, namespace },
          spec: resource.spec,
        } as DeployableK8sResource<typeof enhanced>;
        copyResourceMetadata(enhanced, deployable);
        const deployed = await deploymentEngine.deployResource(deployable, {
          mode: 'kro',
          namespace,
          waitForReady: false,
          timeout: member.factory.factoryOptions.timeout || DEFAULT_DEPLOYMENT_TIMEOUT,
          ...(abortSignal ? { abortSignal } : {}),
        });
        assertKroInstanceSpecPreserved(deployable, deployed.liveManifest ?? deployed.manifest);

        const shouldWait =
          operation.role === 'singleton-owner-instance' ||
          (member.factory.factoryOptions.waitForReady ?? true);
        if (shouldWait) {
          await member.factory.waitForKroInstanceReady(
            resourceName,
            member.factory.factoryOptions.timeout || DEFAULT_KRO_INSTANCE_TIMEOUT,
            namespace,
            abortSignal
          );
        }
        const result = await member.factory.createEnhancedProxy(member.spec, resourceName);
        if (operation.role === 'instance') {
          rootResult = result as unknown as Enhanced<TSpec, TStatus>;
        } else {
          const status = (result as { status?: unknown }).status;
          if (status && typeof status === 'object' && !Array.isArray(status)) {
            for (const consumer of member.consumers) {
              consumer.factory.singletonOwnerStatuses.set(
                getSingletonResourceId(consumer.definition.key),
                status as Record<string, unknown>
              );
            }
          }
        }
      }

      if (!rootResult) {
        throw new TypeKroError(
          'KRO artifact bundle completed without producing the root instance.',
          'KRO_ARTIFACT_BUNDLE_ROOT_RESULT_MISSING',
          { bundleDigest: bundle.bundleDigest }
        );
      }
      return rootResult;
    } finally {
      await deploymentEngine.dispose();
      for (const member of childMembers.reverse()) {
        await member.factory.dispose();
      }
    }
  }

  /**
   * Deploy directly to Kubernetes using DirectDeploymentEngine
   */
  private async deployDirect(
    spec: TSpec,
    instanceNameOverride?: string,
    singletonSpecFingerprint?: string,
    abortSignal?: AbortSignal
  ): Promise<Enhanced<TSpec, TStatus>> {
    const instanceNamespace = this.resolveInstanceNamespace(spec);
    const instanceName = instanceNameOverride ?? generateInstanceName(spec, this.name);
    const hoistedNamespaces = this.materializedHoistedNamespaces(spec);

    // FINDING #2: fail closed on a PRE-HOIST upgrade BEFORE touching the RGD. If a
    // namespace this factory now hoists is currently a KRO ApplySet member (a namespace
    // a pre-hoist RGD owned as a graph child), rolling the new hoisted RGD over the old
    // one drops the namespace from the ApplySet — and KRO's prune then deletes the live
    // namespace out from under the workload. Detect it and THROW (detection only — no
    // automatic migration). See the migration doc for the one-time manual step.
    await this.assertNoPreHoistNamespaceConflict(hoistedNamespaces.keys());

    // Ensure RGD is deployed. Every owned Namespace is hoisted OUT of the RGD graph
    // and applied as a SIBLING below (deps-first), never a graph child — so KRO never
    // owns a namespace and deleting the instance can never garbage-collect the
    // namespace holding its own finalizer. The hoist is STRUCTURAL, so the shared RGD
    // shape is the same for every instance (finding #4).
    await this.ensureRGDDeployed(spec, abortSignal);

    // Ensure the namespace that will hold the CR exists before posting it. KRO
    // reconciles resources from the RGD into their own namespaces, but the CR
    // instance itself must live in a namespace the user can write to. If the
    // composition owns that namespace it was hoisted out of the graph above, so
    // creating it here (as a sibling) means KRO never garbage-collects it. Without
    // this, the first deploy after `kubectl delete ns` fails with a 404 on the CR
    // POST.
    //
    // A hoisted Namespace is applied with its COMPLETE preserved configuration
    // (all labels incl. Pod Security + spec) plus retention markers; a non-hoisted
    // instance namespace just needs to exist.
    if (!hoistedNamespaces.has(instanceNamespace)) {
      await this.ensureTargetNamespace(instanceNamespace, abortSignal);
    }
    for (const { artifact, resource } of hoistedNamespaces.values()) {
      await this.applyRetainedHoistedNamespace(resource, artifact, abortSignal);
    }

    // Create DirectDeploymentEngine with KRO mode for CEL string conversion
    const deploymentEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );

    // Create custom resource instance
    const customResourceData = this.createCustomResourceInstance(
      instanceName,
      spec,
      singletonSpecFingerprint
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
        namespace: instanceNamespace,
      },
      spec: customResourceData.spec, // Use spec directly from customResourceData to ensure it's preserved
    } as DeployableK8sResource<typeof enhancedCustomResource>;

    // Preserve non-enumerable properties (readinessEvaluator, __resourceId) lost during spread
    preserveNonEnumerableProperties(enhancedCustomResource, deployableResource);

    // Deploy without waiting for readiness - we'll handle that ourselves
    this.logger.info('Deploying Kro instance', { instanceName, rgdName: this.rgdName });
    try {
      const deployed = await deploymentEngine.deployResource(deployableResource, {
        mode: 'kro',
        namespace: instanceNamespace,
        waitForReady: false, // We'll handle Kro-specific readiness ourselves
        timeout: this.factoryOptions.timeout || DEFAULT_DEPLOYMENT_TIMEOUT,
        ...(abortSignal ? { abortSignal } : {}),
      });
      assertKroInstanceSpecPreserved(
        deployableResource,
        deployed.liveManifest ?? deployed.manifest
      );
      this.logger.info('Instance deployed, checking readiness', {
        instanceName,
        rgdName: this.rgdName,
      });

      // Handle Kro-specific readiness checking if requested
      if (this.factoryOptions.waitForReady ?? true) {
        await this.waitForKroInstanceReady(
          instanceName,
          this.factoryOptions.timeout || DEFAULT_KRO_INSTANCE_TIMEOUT,
          instanceNamespace,
          abortSignal
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
   * Apply a hoisted workload Namespace as a RETAINED resource OUTSIDE the KRO
   * graph, with its COMPLETE preserved configuration — all labels (incl. Pod
   * Security + schema-derived), all annotations, AND spec — plus retention markers
   * (finding #8), using typekro's own field manager (not KRO's). Server-side apply
   * is idempotent and does not conflict with KRO because KRO no longer considers
   * the Namespace desired.
   *
   * If the full Namespace cannot be applied, this FAILS (finding #8) rather than
   * silently degrading to a bare `ensureTargetNamespace` that would drop Pod
   * Security + other declared configuration.
   */
  private async applyRetainedHoistedNamespace(
    resource: KubernetesResource,
    artifact?: KroSupportingArtifact,
    abortSignal?: AbortSignal
  ): Promise<void> {
    abortSignal?.throwIfAborted();
    const name = String(resource.metadata.name);
    const annotations = Object.fromEntries(
      Object.entries(resource.metadata.annotations ?? {}).map(([key, value]) => [
        key,
        String(value),
      ])
    );

    const applyPolicy = artifact?.apply ?? {
      strategy: 'server-side-apply' as const,
      fieldManager: 'typekro',
      fieldConflictPolicy: 'force-owned-fields' as const,
      immutableFieldPolicy: 'fail' as const,
    };
    if (applyPolicy.strategy !== 'server-side-apply') {
      throw new TypeKroError(
        `Hoisted Namespace artifact ${artifact?.id ?? name} requires server-side apply.`,
        'INVALID_ARTIFACT_APPLY_POLICY',
        { artifactId: artifact?.id ?? name, strategy: applyPolicy.strategy }
      );
    }
    const k8sApi = createBunCompatibleKubernetesObjectApi(this.getKubeConfig());

    const baseMetadata = {
      name,
      ...(resource.metadata.labels !== undefined ? { labels: resource.metadata.labels } : {}),
      ...(resource.metadata.finalizers !== undefined
        ? { finalizers: resource.metadata.finalizers }
        : {}),
      ...(resource.metadata.ownerReferences !== undefined
        ? { ownerReferences: resource.metadata.ownerReferences }
        : {}),
    };
    const buildManifest = (manifestAnnotations: Record<string, string>): k8s.KubernetesObject =>
      ({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { ...baseMetadata, annotations: manifestAnnotations },
        ...(resource.spec !== undefined ? { spec: resource.spec } : {}),
      }) as unknown as k8s.KubernetesObject;

    const annotationsWithStamp = {
      ...annotations,
      [NAMESPACE_OWNER_ANNOTATION]: this.rgdName,
    };

    // CREATE-FIRST ownership (finding #3): attempt to CREATE the namespace WITH the
    // ownership stamp and complete declared config. A 201 is atomic proof WE created it
    // (owned). A 409 means it already exists — owned ONLY if a prior create by this RGD
    // stamped it; otherwise adopted (never stamped, so teardown never deletes it). This
    // replaces the raceable GET→(404)→patch-with-stamp: no window in which another actor
    // creates the namespace between our read and our stamping patch.
    let decision: NamespaceOwnershipDecision;
    try {
      decision = await decideNamespaceOwnershipCreateFirst(
        k8sApi,
        buildManifest(annotationsWithStamp),
        this.rgdName
      );
      abortSignal?.throwIfAborted();
    } catch (error: unknown) {
      // A non-conflict CREATE failure (or a failed conflict-read) — do NOT fall back to a
      // bare namespace (finding #8). Fail loudly so the operator sees the real problem.
      throw new ResourceGraphFactoryError(
        `Failed to create the retained workload Namespace "${name}" with its complete declared ` +
          `configuration (Pod Security labels, annotations, spec): ${ensureError(error).message}`,
        this.name,
        'deployment',
        ensureError(error)
      );
    }

    // 201 CREATE landed the full config + stamp atomically — nothing more to apply.
    if (decision.created) return;

    // 409: the namespace already existed. Apply the retained config via SSA, keeping the
    // ownership stamp ONLY if we already own it (adoption must NOT be stamped).
    const appliedAnnotations = decision.owned ? annotationsWithStamp : annotations;
    try {
      await k8sApi.patch(
        buildManifest(appliedAnnotations),
        undefined,
        undefined,
        applyPolicy.fieldManager,
        applyPolicy.fieldConflictPolicy === 'force-owned-fields',
        'application/apply-patch+yaml' // server-side apply
      );
    } catch (error: unknown) {
      // Do NOT fall back to a bare namespace (finding #8): that would drop the
      // declared Pod Security labels + other config. Fail loudly so the operator
      // sees the real problem instead of a silently-degraded workload namespace.
      throw new ResourceGraphFactoryError(
        `Failed to apply the retained workload Namespace "${name}" with its complete declared ` +
          `configuration (Pod Security labels, annotations, spec): ${ensureError(error).message}`,
        this.name,
        'deployment',
        ensureError(error)
      );
    }
  }

  /**
   * FINDING #2 — fail-closed PRE-HOIST detection (detection only; no migration).
   *
   * On deploy, BEFORE the RGD is (re)applied, check every namespace this factory would
   * hoist. If a live namespace is currently a KRO ApplySet member — it carries
   * `applyset.kubernetes.io/part-of` and/or any `kro.run/*` ownership label from a
   * PRE-HOIST RGD (which owned the namespace as a graph child) — then rolling the new,
   * hoisted RGD (which no longer lists the namespace) over the old one makes KRO's
   * ApplySet prune enumerate and DELETE the live namespace, taking the workload with
   * it. We THROW a clear, actionable error instead. This does NOT re-introduce the
   * removed automatic migration/drain/strip machinery — it only refuses to proceed.
   *
   * typekro's own v2 sibling namespaces carry `typekro.io/kro-instance-namespace=true`
   * but NEITHER an ApplySet `part-of` NOR any `kro.run/*` label (KRO never owns them),
   * so steady-state re-deploys never trip this. A 404 (fresh) is not a pre-hoist signal.
   *
   * FINDING #7 (hardened): the check covers not only the namespaces resolved from the
   * INCOMING spec but EVERY existing instance of this shared RGD (their hoisted
   * namespaces too) — an upgrade prunes the ApplySet for ALL of them at once, so
   * missing another instance's namespace would let KRO delete it. And reads FAIL
   * CLOSED: a non-404 read error is NOT proof of safety, so it ABORTS the deploy
   * rather than being skipped.
   */
  private async assertNoPreHoistNamespaceConflict(
    hoistedNamespaceNames: Iterable<string>
  ): Promise<void> {
    const names = new Set<string>(hoistedNamespaceNames);
    // Union in every EXISTING instance's hoisted namespaces (finding #7): they are all
    // dropped from the ApplySet by the same RGD roll. Fails closed on a non-absent list
    // error.
    for (const extra of await this.existingInstancesHoistedNamespaceNames()) {
      names.add(extra);
    }
    if (names.size === 0) return;

    const k8sApi = this.createKubernetesObjectApi();
    for (const name of names) {
      let labels: Record<string, string> = {};
      try {
        const live = (await k8sApi.read({
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: { name },
        })) as { metadata?: { labels?: Record<string, string> } };
        labels = live.metadata?.labels ?? {};
      } catch (error: unknown) {
        const k8sErr = error as { statusCode?: number; code?: number; body?: { code?: number } };
        const code = k8sErr.statusCode ?? k8sErr.code ?? k8sErr.body?.code;
        if (code === 404) continue; // fresh namespace — nothing to migrate
        // FAIL CLOSED (finding #7): a non-404 read error means we cannot prove the
        // namespace is safe to hoist over. Abort rather than risk KRO's prune deleting
        // a namespace whose pre-hoist ownership we could not read.
        throw new TypeKroError(
          `Pre-hoist safety check could not read Namespace "${name}" for composition ` +
            `"${this.name}" (${ensureError(error).message}). Refusing to deploy: a hoist over an ` +
            `unreadable namespace could let KRO's ApplySet prune delete it. Resolve the read ` +
            `error (RBAC/connectivity) and retry.`,
          'PRE_HOIST_NAMESPACE_CHECK_FAILED',
          { composition: this.name, namespace: name, mode: 'kro' }
        );
      }
      const partOfKro =
        typeof labels['applyset.kubernetes.io/part-of'] === 'string' ||
        Object.keys(labels).some((key) => key.startsWith('kro.run/'));
      if (partOfKro) {
        throw new TypeKroError(
          `Pre-hoist deployment detected for composition "${this.name}": the live Namespace ` +
            `"${name}" is a KRO ApplySet member (carries applyset.kubernetes.io/part-of and/or ` +
            `kro.run/* ownership labels from a pre-hoist RGD). typekro now HOISTS every owned ` +
            `Namespace out of the RGD, so applying the new RGD in place would drop "${name}" from ` +
            `KRO's ApplySet and KRO's prune would DELETE the live namespace and its workloads. ` +
            `This upgrade is not auto-migrated. Either recreate (delete the instance, then ` +
            `redeploy — the namespace is recreated as a sibling) or perform the one-time manual ` +
            `label-strip while the controller is quiesced. See docs/advanced/migration.md ` +
            `("Upgrading from a pre-hoist TypeKro release").`,
          'PRE_HOIST_NAMESPACE_CONFLICT',
          { composition: this.name, namespace: name, labels: Object.keys(labels), mode: 'kro' }
        );
      }
    }
  }

  /**
   * The hoisted-namespace names of EVERY existing instance of this shared RGD (finding
   * #7), resolved EXACTLY and PER INSTANCE from that instance's OWN durable record
   * (finding #1, v7) — never approximated, and never from an RGD-wide aggregate.
   *
   * Each instance's namespaces come from its OWN CR `typekro.io/hoisted-namespaces`
   * annotation — the only PER-INSTANCE proof. An instance that lacks its own record (a
   * genuinely-legacy deployment) FAILS CLOSED (throws): the RGD-wide set of Namespaces
   * carrying `typekro.io/created-by-rgd == this.rgdName` is NOT per-instance proof — a
   * DIFFERENT (modern) instance could have stamped it, so a non-empty RGD-wide set would
   * otherwise MASK a legacy instance whose own — possibly different — namespace is invisible
   * and would be pruned. We also never approximate from metadata.namespace / spec.namespace.
   *
   * The RGD-wide `created-by-rgd` set IS still unioned into the returned protected set (it
   * is a superset that catches namespaces leaked by an interrupted teardown) — it just never
   * SATISFIES the per-instance check. FRESH clusters (no CRD / no instances yet) yield an
   * empty set; any list error FAILS CLOSED so the guard is never silently bypassed.
   */
  private async existingInstancesHoistedNamespaceNames(): Promise<Set<string>> {
    const result = new Set<string>();

    // Short-circuit: if this RGD structurally hoists NO namespace, the hoist can prune nothing —
    // there is nothing to protect and no per-instance record to require. An ordinary composition
    // with no Namespace resources must never trip the pre-hoist legacy guard.
    if (this.hoistedNamespaceRefs().size === 0) return result;

    // Discover the generated CRD via a STRICT lookup that THROWS on a real list error
    // (finding #3, fail-closed): a discovery/RBAC failure is NOT proof the CRD is
    // absent. Only a successful list with no matching CRD is a definitive "fresh
    // cluster" (no prior instances to protect).
    let discovery: { present: true; plural: string } | { present: false };
    try {
      discovery = await this.discoverGeneratedCrdPlural();
    } catch (error: unknown) {
      throw new TypeKroError(
        `Pre-hoist safety check could not discover the generated CRD for RGD "${this.rgdName}" ` +
          `(${ensureError(error).message}). Refusing to deploy: a discovery/RBAC error is not ` +
          `proof the CRD is absent, and proceeding could let the hoist prune an existing ` +
          `instance's namespace unchecked.`,
        'PRE_HOIST_CRD_DISCOVERY_FAILED',
        { composition: this.name, rgdName: this.rgdName, mode: 'kro' }
      );
    }
    if (!discovery.present) return result; // definitively fresh — no prior instances

    let items: Array<{ spec?: unknown; metadata?: { annotations?: Record<string, string> } }>;
    try {
      const customApi = await this.createCustomObjectsApi();
      const listResponse = await customApi.listClusterCustomObject({
        group: this.getSchemaGroup(),
        version: this.getSchemaVersion(),
        plural: discovery.plural,
      });
      items =
        (
          listResponse as {
            items?: Array<{ spec?: unknown; metadata?: { annotations?: Record<string, string> } }>;
          }
        ).items ?? [];
    } catch (error: unknown) {
      // Only a DEFINITIVE 404 (the CRD/instances vanished between discovery and list)
      // is treated as fresh; ANY other error FAILS CLOSED (finding #3) — a message
      // that merely mentions "CRD"/"not found" no longer counts (that was the swallow
      // bug), only a real NotFound status.
      const k8sErr = error as { statusCode?: number; code?: number; body?: { code?: number } };
      const status = k8sErr.statusCode ?? k8sErr.code ?? k8sErr.body?.code;
      if (status === 404) return result;
      throw new TypeKroError(
        `Pre-hoist safety check could not list existing instances of RGD "${this.rgdName}" ` +
          `(${ensureError(error).message}). Refusing to deploy: another instance's namespace could ` +
          `be pruned by the hoist without being checked.`,
        'PRE_HOIST_INSTANCE_LIST_FAILED',
        { composition: this.name, rgdName: this.rgdName, mode: 'kro' }
      );
    }

    if (items.length === 0) return result;

    // The RGD-wide record of every namespace this RGD created: namespaces carrying
    // `typekro.io/created-by-rgd == this.rgdName`. We union it into the PROTECTED set as a
    // superset — it catches namespaces leaked by an interrupted teardown that no live CR
    // records. It is NOT used to satisfy the per-instance check below (finding #1, v7): being
    // RGD-wide, it cannot prove a SPECIFIC instance's namespaces. A list error FAILS CLOSED —
    // an unreadable list is not proof no owned namespace exists.
    let ownedNamespaces: Set<string>;
    try {
      ownedNamespaces = new Set(
        await listNamespacesOwnedByRgd(this.getKubeConfig(), this.rgdName, {
          k8sApi: this.createKubernetesObjectApi(),
          logger: this.logger,
        })
      );
    } catch (error: unknown) {
      throw new TypeKroError(
        `Pre-hoist safety check could not list namespaces owned by RGD "${this.rgdName}" ` +
          `(${ensureError(error).message}). Refusing to deploy: without the durable ownership ` +
          `record we cannot prove the hoist won't prune an existing instance's namespace.`,
        'PRE_HOIST_OWNED_NAMESPACE_LIST_FAILED',
        { composition: this.name, rgdName: this.rgdName, mode: 'kro' }
      );
    }
    // Every owned namespace is at risk of the ApplySet prune — protect them all.
    for (const ns of ownedNamespaces) result.add(ns);

    for (const item of items) {
      // Resolve THIS instance's namespaces from its OWN exact PER-INSTANCE record — the CR
      // `typekro.io/hoisted-namespaces` annotation (finding #1, v7). It carries the instance's
      // EXACT hoisted names (round-tripping a name derived from an arbitrary spec field) and is
      // the ONLY per-instance proof.
      const record = readHoistedNamespacesRecord(
        item.metadata?.annotations?.[HOISTED_NAMESPACES_ANNOTATION]
      );
      if (record.status === 'present') {
        // A VALID record — including an explicit empty `[]` — is per-instance proof: this
        // instance hoists exactly these namespaces (possibly none). Resolved; do NOT fail closed.
        for (const ns of record.names) result.add(ns);
        continue;
      }
      // MISSING or MALFORMED record → NO per-instance exact record. FAIL CLOSED (finding #1, v7). We do
      // NOT fall back to the RGD-wide `created-by-rgd` set: it is not per-instance proof — a
      // DIFFERENT (modern) instance could have stamped it, so a non-empty set would MASK this
      // legacy instance whose own — possibly different — owned namespace is then invisible and
      // pruned by the hoist. Nor do we approximate from metadata.namespace / spec.namespace.
      // Refusing the upgrade until the legacy instance is migrated/annotated is the intended,
      // safe transition cost — refusing beats silently pruning an unseen namespace.
      throw new TypeKroError(
        `Pre-hoist safety check found an existing instance of RGD "${this.rgdName}" with no ` +
          `per-instance namespace record — its CR carries no "${HOISTED_NAMESPACES_ANNOTATION}" ` +
          `annotation. The RGD-wide "${NAMESPACE_OWNER_ANNOTATION}=${this.rgdName}" set is NOT ` +
          `per-instance proof (another instance could have stamped it), so this instance's own ` +
          `owned namespace could be pruned by the hoist unseen. Refusing to deploy: migrate it ` +
          `(redeploy the instance with a current TypeKro so its namespaces are recorded) and retry.`,
        'PRE_HOIST_LEGACY_INSTANCE_UNRESOLVABLE',
        { composition: this.name, rgdName: this.rgdName, mode: 'kro' }
      );
    }
    return result;
  }

  /**
   * Get all deployed instances
   */
  async getInstances(
    opts?: InternalResourceFactoryReadOptions
  ): Promise<Enhanced<TSpec, TStatus>[]> {
    if (opts?.operationSignal) {
      return this.getInstancesWithinOperation(opts.operationSignal);
    }
    return runStandaloneOperation((abortSignal) => this.getInstancesWithinOperation(abortSignal), {
      abortSignals: [this.factoryOptions.abortSignal, opts?.abortSignal],
    });
  }

  private async getInstancesWithinOperation(
    abortSignal: AbortSignal
  ): Promise<Enhanced<TSpec, TStatus>[]> {
    abortSignal.throwIfAborted();
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
      abortSignal.throwIfAborted();
      const plural = this.discoveredPlural ?? pluralizeKind(this.schemaDefinition.kind);

      // The instance CR lives in the namespace {@link resolveInstanceNamespace}
      // resolves to — the SAME shared resolver `deploy()`/`toYaml()` use, so a
      // create in namespace X is always listed in namespace X (finding #2). No
      // per-call spec is available here, so it resolves the factory default
      // (`instanceNamespace` override ?? factory namespace).
      const listResponse = await customApi.listNamespacedCustomObject({
        group: this.getSchemaGroup(),
        version,
        namespace: this.resolveInstanceNamespace(),
        plural,
      });
      abortSignal.throwIfAborted();

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
          abortSignal.throwIfAborted();
          const enhanced = await this.createEnhancedProxy(
            instance.spec as TSpec,
            instance.metadata?.name || 'unknown'
          );
          if (instance.metadata?.annotations) {
            const mutableEnhanced = enhanced as unknown as { metadata?: Record<string, unknown> };
            const existingMetadata = mutableEnhanced.metadata ?? {};
            const existingAnnotations =
              existingMetadata.annotations && typeof existingMetadata.annotations === 'object'
                ? (existingMetadata.annotations as Record<string, string>)
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
      abortSignal.throwIfAborted();
      const k8sError = error as { message?: string; body?: string | object; statusCode?: number };
      // If the CRD doesn't exist yet or there are no instances, return empty array
      const bodyString =
        typeof k8sError.body === 'string' ? k8sError.body : JSON.stringify(k8sError.body || '');

      const canTreatNotFoundAsEmpty = !this.discoveredPlural;
      if (
        canTreatNotFoundAsEmpty &&
        (k8sError.message?.includes('not found') ||
          k8sError.message?.includes('404') ||
          bodyString.includes('not found') ||
          bodyString.includes('404') ||
          k8sError.statusCode === 404 ||
          String(error).includes('404') ||
          String(error).includes('not found'))
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

  private async listInstancesForCleanup(): Promise<
    Array<{
      metadata?: { name?: unknown; namespace?: unknown; annotations?: Record<string, string> };
    }>
  > {
    const customApi = await this.createCustomObjectsApi();
    const version = this.getSchemaVersion();
    const plural = await this.requireCRDPluralForCleanup();

    try {
      const listResponse = await customApi.listClusterCustomObject({
        group: this.getSchemaGroup(),
        version,
        plural,
      });
      const listResult = listResponse as {
        items?: Array<{
          metadata?: { name?: unknown; namespace?: unknown; annotations?: Record<string, string> };
        }>;
      };
      return listResult.items ?? [];
    } catch (error: unknown) {
      throw new CRDInstanceError(
        `Failed to list instances cluster-wide: ${ensureError(error).message}`,
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
    const deletion = createDeletionResultState('kro', this.name, name);
    abortSignal.throwIfAborted();
    if (opts?.scopes?.length) {
      throw new TypeKroError(
        'Scope-filtered deletion is not supported in KRO mode. KRO manages resource lifecycle via its own controller. Use direct mode for scope-filtered deletes.',
        'UNSUPPORTED_OPTION',
        { scopes: opts.scopes, instanceName: name, mode: 'kro' }
      );
    }
    const k8sApi = this.createKubernetesObjectApi();
    // ONE gating deletion mechanism for the whole teardown (finding #1): the engine's
    // rollback manager, whose `deleteResourceAndWait` deletes then polls to a REAL 404
    // and THROWS DeploymentTimeoutError on timeout — never a silent return that lets a
    // later step run behind a still-Terminating resource.
    const rollback = createRollbackManager(k8sApi);
    const timeout = opts?.timeout ?? this.factoryOptions.timeout ?? 300000;

    const apiVersion = this.getInstanceApiVersion();
    let definitionsAlreadyAbsent = false;
    try {
      await this.requireCRDPluralForCleanup();
    } catch (error: unknown) {
      if (!(await this.kroDefinitionsAreAbsent())) throw error;
      definitionsAlreadyAbsent = true;
      this.logger.info(
        'KRO definitions already absent; continuing durable namespace cleanup retry',
        { rgdName: this.rgdName, instance: name }
      );
    }
    // The CR lives in the namespace {@link resolveInstanceNamespace} resolves to — the
    // SAME shared resolver `deploy()` created it with (finding #2), so we never look in
    // the wrong namespace and mistake a 404 there for "already gone".
    const instanceNamespace = this.resolveInstanceNamespace();
    const instanceTarget = deletionTarget(
      apiVersion,
      this.schemaDefinition.kind,
      name,
      instanceNamespace
    );

    // Capture the CR's durable RECORD of which namespaces THIS instance hoisted BEFORE
    // deleting it (finding #4). deleteInstance has no caller spec, so the live CR is the
    // only source of the declared set. PREFER the recorded `typekro.io/hoisted-namespaces`
    // annotation (stamped at deploy time) — it round-trips a name derived from an
    // arbitrary spec field (e.g. spec.targetNamespace) EXACTLY. Fall back to re-deriving
    // from the CR's spec for instances deployed before the annotation existed (the
    // imperative path CAN re-execute the composition). If the CR is already gone (404) or
    // unreadable, we cannot reconstruct it, so NO namespace becomes a delete candidate
    // (fail-safe: an owned-but-unprovable namespace is kept).
    let crSpec: TSpec | undefined;
    let recordedHoistedNames: string[] = [];
    if (!definitionsAlreadyAbsent) {
      try {
        const live = (await k8sApi.read({
          apiVersion,
          kind: this.schemaDefinition.kind,
          metadata: { name, namespace: instanceNamespace },
        })) as { spec?: TSpec; metadata?: { annotations?: Record<string, string> } };
        crSpec = live.spec;
        recordedHoistedNames = parseHoistedNamespacesAnnotation(
          live.metadata?.annotations?.[HOISTED_NAMESPACES_ANNOTATION]
        );
      } catch (readError: unknown) {
        const k8sErr = readError as {
          statusCode?: number;
          code?: number;
          body?: { code?: number };
        };
        const code = k8sErr.statusCode ?? k8sErr.code ?? k8sErr.body?.code;
        if (code !== 404) {
          this.logger.debug(
            'Could not read instance CR before delete (declared-namespace record unavailable)',
            { name, error: ensureError(readError).message }
          );
        }
      }
    }
    const declaredHoistedNamespaceNames =
      recordedHoistedNames.length > 0
        ? recordedHoistedNames
        : crSpec
          ? [...this.concreteHoistedNamespaces(crSpec).keys()]
          : [];
    const permanentlyRetainedOwnedNamespaces = new Set<string>();
    let graphMayHaveDrainingDescendants = false;
    const deleteOwnedNamespace = async (
      namespace: string
    ): Promise<ResourceDeletionResult | undefined> => {
      const target = deletionTarget('v1', 'Namespace', namespace);
      try {
        const outcome = await deleteNamespaceIfEmpty(this.getKubeConfig(), namespace, {
          logger: this.logger,
          k8sApi,
          ownedByRgd: this.rgdName,
          timeoutMs: timeout,
          abortSignal,
          context: { rgdName: this.rgdName },
        });
        recordNamespaceDeletionOutcome(deletion, namespace, outcome);
        if (
          outcome.status === 'retained' &&
          outcome.cause === 'occupied' &&
          !graphMayHaveDrainingDescendants
        ) {
          permanentlyRetainedOwnedNamespaces.add(namespace);
        }
        return undefined;
      } catch (error: unknown) {
        if (abortSignal.aborted) throw abortSignal.reason ?? error;
        let live = target;
        try {
          live = (await readDeletionResourceIdentity(k8sApi, target)) ?? target;
        } catch (readError: unknown) {
          deletion.blockers.push({
            code: 'CLEANUP_ERROR',
            message: `Namespace cleanup failed and blocker inspection also failed: ${ensureError(readError).message}`,
            resource: target,
            retryable: true,
            retryGuidance: 'Restore Kubernetes API access, then retry the deletion operation.',
          });
        }
        deletion.remaining.push(live);
        deletion.blockers.push(
          blockerForRemainingResource(
            live,
            `Namespace ${namespace} did not complete deletion: ${ensureError(error).message}`
          )
        );
        return finishDeletionResult(deletion, live.deletionTimestamp ? 'progressing' : 'blocked', {
          safe: true,
          afterMs: 2_000,
          guidance:
            'Retry after the listed namespace finalizers or occupants have drained; the RGD and generated CRD were retained.',
        });
      }
    };

    const childTargets: ConcreteOwnedChildTarget[] = [];
    if (crSpec) {
      const compositionFn = this.factoryOptions.compositionFn as
        | ((spec: TSpec) => unknown)
        | undefined;
      const ownedChildren = concreteActiveOwnedResources<TSpec>({
        compositionName: this.name,
        spec: crSpec,
        resources: this.resources,
        ...(compositionFn ? { compositionFn } : {}),
      });
      for (const [resourceId, resource] of ownedChildren) {
        if (resource.kind === 'Namespace') continue;
        const childName = resolveNamespaceName(resource.metadata?.name, crSpec);
        const childNamespace = resolveNamespaceName(resource.metadata?.namespace, crSpec);
        if (!childName) {
          deletion.blockers.push({
            code: 'OWNERSHIP_UNPROVEN',
            message: `Cannot prove KRO child cleanup: resource ${resourceId} (${resource.kind}) has an unresolved concrete name.`,
            retryable: false,
            retryGuidance:
              'Give every KRO-owned child a concretely resolvable metadata.name so TypeKro can prove teardown completion.',
          });
          return finishDeletionResult(deletion, 'blocked', {
            safe: false,
            guidance:
              'Correct the unresolved child identity before retrying; the instance was retained.',
          });
        }
        childTargets.push({
          apiVersion: resource.apiVersion,
          kind: resource.kind,
          name: childName,
          ...(childNamespace ? { namespace: childNamespace } : {}),
        });
      }
      graphMayHaveDrainingDescendants = childTargets.some((target) =>
        DESCENDANT_PRODUCING_KINDS.has(target.kind)
      );
    }

    let capturedDescendants: CapturedOwnedDescendant[] = [];
    try {
      capturedDescendants = await captureKnownControllerDescendants(
        k8sApi,
        childTargets,
        instanceNamespace
      );
    } catch (error: unknown) {
      deletion.blockers.push({
        code: 'DISCOVERY_FAILED',
        message: `Cannot capture KRO-owned controller descendants before deletion: ${ensureError(error).message}`,
        retryable: true,
        retryGuidance:
          'Restore read/list access to KRO-owned children and their dependents, then retry deletion.',
      });
      return finishDeletionResult(deletion, 'blocked', {
        safe: true,
        guidance:
          'TypeKro retained the instance because descendant ownership could not be proven safely.',
      });
    }

    // 1. Delete the CR and GATE on its 404 — KRO cleared `kro.run/finalizer` after
    // graph-deleting every child (findings #1 + #2). On timeout the gate THROWS, so we
    // NEVER proceed to delete the RGD while KRO is mid-finalizer (which would orphan
    // cleanup). A pre-existing 404 on delete is treated as already-deleted.
    let instanceDeleted = false;
    try {
      if (!definitionsAlreadyAbsent) {
        await rollback.deleteResourceAndWait(
          { apiVersion, kind: this.schemaDefinition.kind, name, namespace: instanceNamespace },
          { timeout, abortSignal }
        );
      }
      instanceDeleted = true;
      deletion.deleted.push(instanceTarget);
    } catch (error: unknown) {
      if (abortSignal.aborted) throw abortSignal.reason ?? error;
      if (error instanceof DeploymentTimeoutError) {
        // KRO is still processing the finalizer. The RGD/CRD/namespace are LEFT ALONE
        // so KRO can finish cleanup in the background, and the caller receives the exact
        // live finalizer/owner state instead of a success-shaped void return.
        let live = instanceTarget;
        try {
          live = (await readDeletionResourceIdentity(k8sApi, instanceTarget)) ?? instanceTarget;
        } catch (readError: unknown) {
          deletion.blockers.push({
            code: 'CLEANUP_ERROR',
            message: `KRO instance deletion timed out and its live blocker state could not be read: ${ensureError(readError).message}`,
            resource: instanceTarget,
            retryable: true,
            retryGuidance:
              'Retry when the Kubernetes API is readable; keep the RGD installed so KRO can continue finalizer processing.',
          });
        }
        deletion.remaining.push(live);
        deletion.blockers.push(
          blockerForRemainingResource(
            live,
            `KRO instance ${name} deletion did not complete within ${timeout}ms.`
          )
        );
        return finishDeletionResult(deletion, live.deletionTimestamp ? 'progressing' : 'blocked', {
          safe: true,
          afterMs: 2_000,
          guidance:
            'Retry deletion after KRO and the listed owners have had time to clear the remaining finalizers.',
        });
      }
      deletion.remaining.push(instanceTarget);
      deletion.blockers.push({
        code: 'CLEANUP_ERROR',
        message: `Failed to delete instance ${name}: ${ensureError(error).message}`,
        resource: instanceTarget,
        retryable: true,
        retryGuidance:
          'Resolve the reported Kubernetes API error, then retry. TypeKro has preserved the RGD and generated CRD.',
      });
      return finishDeletionResult(deletion, 'blocked', {
        safe: true,
        guidance: 'Retry after resolving the reported Kubernetes API error.',
      });
    }

    // KRO's owner CR reaching 404 proves that its finalizer issued child
    // deletions; it does not prove that controller-owned child finalizers have
    // completed. Gate on every concrete owned child before touching the RGD or
    // reporting successful cleanup. External refs and hoisted Namespaces are
    // deliberately excluded: this instance never owns the former and TypeKro
    // tears down the latter in the namespace phase below.
    if (childTargets.length > 0) {
      try {
        await Promise.all(
          childTargets.map((target) =>
            rollback.waitForResourceGone(target, { timeout, abortSignal })
          )
        );
        deletion.deleted.push(
          ...childTargets.map((target) =>
            deletionTarget(target.apiVersion, target.kind, target.name, target.namespace)
          )
        );
      } catch (error: unknown) {
        if (abortSignal.aborted) throw abortSignal.reason ?? error;
        for (const target of childTargets) {
          const identity = deletionTarget(
            target.apiVersion,
            target.kind,
            target.name,
            target.namespace
          );
          try {
            const live = await readDeletionResourceIdentity(k8sApi, identity);
            if (!live) {
              deletion.deleted.push(identity);
              continue;
            }
            deletion.remaining.push(live);
            deletion.blockers.push(blockerForRemainingResource(live));
          } catch (readError: unknown) {
            deletion.remaining.push(identity);
            deletion.blockers.push({
              code: 'CLEANUP_ERROR',
              message: `Could not inspect remaining child ${target.kind}/${target.name}: ${ensureError(readError).message}`,
              resource: identity,
              retryable: true,
              retryGuidance:
                'Retry after the Kubernetes API is readable; TypeKro retained the RGD and generated CRD.',
            });
          }
        }
        const progressing =
          deletion.remaining.length > 0 &&
          deletion.remaining.every((resource) => resource.deletionTimestamp !== undefined);
        return finishDeletionResult(deletion, progressing ? 'progressing' : 'blocked', {
          safe: true,
          afterMs: 2_000,
          guidance:
            'Retry after the listed child resources and finalizers have drained; TypeKro retained the RGD and generated CRD.',
        });
      }
    }

    // KRO 0.9 can remove a completed Job before Kubernetes garbage collection
    // removes its Pod. Delete only the dependents captured before instance
    // deletion whose controller UID matched the KRO-owned Job exactly.
    for (const descendant of capturedDescendants) {
      const identity = deletionTarget(
        descendant.apiVersion,
        descendant.kind,
        descendant.name,
        descendant.namespace
      );
      try {
        await rollback.deleteResourceAndWait(identity, { timeout, abortSignal });
        deletion.deleted.push(identity);
      } catch (error: unknown) {
        if (abortSignal.aborted) throw abortSignal.reason ?? error;
        let live = identity;
        try {
          live = (await readDeletionResourceIdentity(k8sApi, identity)) ?? identity;
        } catch (readError: unknown) {
          deletion.blockers.push({
            code: 'CLEANUP_ERROR',
            message: `Could not inspect captured descendant ${descendant.kind}/${descendant.name}: ${ensureError(readError).message}`,
            resource: identity,
            retryable: true,
            retryGuidance: 'Restore Kubernetes API access, then retry deletion.',
          });
        }
        deletion.remaining.push(live);
        deletion.blockers.push(
          blockerForRemainingResource(
            live,
            `${descendant.kind}/${descendant.name}, owned by ${descendant.owner.kind}/${descendant.owner.name} (${descendant.owner.uid}), did not complete deletion: ${ensureError(error).message}`
          )
        );
        return finishDeletionResult(deletion, live.deletionTimestamp ? 'progressing' : 'blocked', {
          safe: true,
          afterMs: 2_000,
          guidance:
            'Retry after the listed controller-owned descendants and finalizers have drained.',
        });
      }
    }

    // 2. LIST REMAINING INSTANCES FIRST — BEFORE deleting any namespace (finding #2, v7).
    // This instance's per-instance namespace cleanup below must EXCLUDE any namespace a
    // REMAINING instance still records: because ownership is RGD-wide, deleting this instance
    // could otherwise remove an empty/default-only namespace that another remaining instance
    // shares (its workloads may momentarily leave it empty), and the later RGD-preserve check
    // cannot RESTORE a deleted namespace. So we list once, up front, and use the result for
    // BOTH the shared-namespace exclusion AND the RGD-share decision. A list FAILURE is
    // fail-closed on BOTH: we can compute NEITHER the exclusion nor the share decision, so we
    // delete NO namespace and preserve the RGD/CRD (a retry completes teardown once the list
    // is readable).
    let remainingItems: Array<{
      metadata?: { name?: unknown; namespace?: unknown; annotations?: Record<string, string> };
    }>;
    try {
      remainingItems = definitionsAlreadyAbsent ? [] : await this.listInstancesForCleanup();
      abortSignal.throwIfAborted();
    } catch (listError: unknown) {
      const reason = `Cannot list KRO instances to prove shared ownership: ${ensureError(listError).message}`;
      this.logger.warn(
        'Cannot list instances — preserving ALL namespaces + the RGD/CRD (fail closed; retry to complete)',
        { rgdName: this.rgdName, error: ensureError(listError).message }
      );
      const rgd = deletionTarget('kro.run/v1alpha1', 'ResourceGraphDefinition', this.rgdName);
      deletion.retained.push({
        resource: rgd,
        policy: 'safety-proof-unavailable',
        reason,
      });
      for (const namespace of declaredHoistedNamespaceNames) {
        const resource = deletionTarget('v1', 'Namespace', namespace);
        deletion.retained.push({
          resource,
          policy: 'safety-proof-unavailable',
          reason,
        });
        deletion.remaining.push(resource);
      }
      deletion.blockers.push({
        code: 'DISCOVERY_FAILED',
        message: reason,
        resource: rgd,
        retryable: true,
        retryGuidance:
          'Restore cluster-wide list access for the generated custom resource, then retry deletion.',
      });
      return finishDeletionResult(deletion, 'blocked', {
        safe: true,
        guidance:
          'Retry after cluster-wide instance discovery is available; TypeKro retained shared resources fail-closed.',
      });
    }
    // The decision to keep the RGD is a pure function of (listed instances, target name,
    // instanceDeleted flag) — see {@link shouldPreserveRgd} for the rules.
    const hasRemainingInstances = shouldPreserveRgd(
      remainingItems,
      name,
      instanceDeleted,
      instanceNamespace
    );
    // The remaining instances (this one filtered out) — the SAME filter shouldPreserveRgd
    // applies — whose recorded namespaces this instance's cleanup must PRESERVE.
    const remainingInstances = instanceDeleted
      ? remainingItems.filter((i) => {
          if (i.metadata?.name !== name) return true;
          if (!instanceNamespace) return false;
          return i.metadata?.namespace !== instanceNamespace;
        })
      : remainingItems;

    // 3. Delete THIS instance's OWN hoisted namespace(s) — EXCLUDING any a remaining instance
    // still records (finding #2, v7). Deletable = this instance's declared namespaces MINUS the
    // UNION of every remaining instance's recorded namespaces. This preserves v5's "each
    // instance cleans its own namespace even when non-last" (a NON-last instance's exclusive
    // namespace is still cleaned here, never leaked) while it also EXCLUDES a namespace a
    // remaining instance shares. Cleanup stays ownership-PRIMARY (`ownedByRgd`: a namespace only
    // this RGD's create stamped) + emptiness-secondary (a namespace another stack still occupies
    // is RETAINED) via deleteNamespaceIfEmpty. The names come from the CR's recorded
    // `typekro.io/hoisted-namespaces` annotation (finding #4), so an arbitrary-field name
    // round-trips cross-process. Namespace-before-RGD/CRD is safe: the RGD + generated CRD stay
    // HEALTHY/Active during ns termination, so the namespace controller confirms emptiness
    // INSTANTLY (never terminating against a *Terminating* CRD, upstream kro #1171). typekro
    // never puts a Namespace in the RGD, so KRO's finalizer never touched these — we own their
    // teardown; the delete is gated on a real 404 via the SAME primitive (throws on timeout).
    //
    // FAIL CLOSED: if ANY remaining instance's record cannot be resolved exactly (no
    // `hoisted-namespaces` annotation on an RGD that DOES hoist), the exclusion is uncomputable
    // → preserve ALL of this instance's namespaces (delete NONE), since any of them could be one
    // the unresolved instance still needs.
    if (declaredHoistedNamespaceNames.length > 0) {
      const preserved = new Set<string>();
      let allRemainingResolvable = true;
      for (const item of remainingInstances) {
        const record = readHoistedNamespacesRecord(
          item.metadata?.annotations?.[HOISTED_NAMESPACES_ANNOTATION]
        );
        if (record.status !== 'present') {
          // MISSING or MALFORMED — this remaining instance's namespaces are uncomputable.
          allRemainingResolvable = false;
          continue;
        }
        // PRESENT (including a valid empty []) is RESOLVED: contribute its namespaces (possibly
        // none). A valid [] no longer forces the fail-closed preserve-everything path (P2).
        for (const ns of record.names) preserved.add(ns);
      }
      if (!allRemainingResolvable) {
        const reason =
          'A remaining KRO instance has no valid hoisted-namespace ownership record, so shared namespace safety cannot be proven.';
        this.logger.warn(
          "A remaining instance has no resolvable namespace record — preserving ALL of this instance's " +
            'namespaces (fail closed) to avoid deleting one a remaining instance shares',
          { rgdName: this.rgdName, instance: name }
        );
        for (const ns of declaredHoistedNamespaceNames) {
          const resource = deletionTarget('v1', 'Namespace', ns);
          deletion.retained.push({
            resource,
            policy: 'safety-proof-unavailable',
            reason,
          });
          deletion.remaining.push(resource);
        }
        deletion.blockers.push({
          code: 'OWNERSHIP_UNPROVEN',
          message: reason,
          retryable: true,
          retryGuidance:
            'Repair or migrate the remaining instance hoisted-namespace annotation, then retry deletion.',
        });
      } else {
        for (const ns of declaredHoistedNamespaceNames) {
          abortSignal.throwIfAborted();
          if (preserved.has(ns)) {
            this.logger.debug('Namespace recorded by a remaining instance — preserving', {
              namespace: ns,
              rgdName: this.rgdName,
            });
            deletion.retained.push({
              resource: deletionTarget('v1', 'Namespace', ns),
              policy: 'shared-instance',
              reason: 'A remaining KRO instance records this namespace as shared state.',
            });
            continue;
          }
          const incomplete = await deleteOwnedNamespace(ns);
          if (incomplete) return incomplete;
        }
      }
    }

    // Only delete the RGD and CRD if no other instances remain. Multiple instances can share
    // one RGD — deleting it would break the others.
    if (hasRemainingInstances) {
      const rgd = deletionTarget('kro.run/v1alpha1', 'ResourceGraphDefinition', this.rgdName);
      deletion.retained.push({
        resource: rgd,
        policy: 'shared-instance',
        reason: 'Other KRO instances still depend on this ResourceGraphDefinition.',
      });
      if (this.discoveredPlural) {
        deletion.retained.push({
          resource: deletionTarget(
            'apiextensions.k8s.io/v1',
            'CustomResourceDefinition',
            `${this.discoveredPlural}.${this.getSchemaGroup()}`
          ),
          policy: 'generated-crd',
          reason: 'The generated CRD is retained while shared instances exist.',
        });
      }
      this.logger.debug('Skipping RGD/CRD deletion — other instances still exist', {
        rgdName: this.rgdName,
      });
      const blocked = deletion.blockers.length > 0;
      return finishDeletionResult(deletion, blocked ? 'blocked' : 'complete', {
        safe: true,
        guidance: blocked
          ? 'Retry after repairing the missing namespace ownership evidence.'
          : 'The requested instance is gone. Shared definitions and namespaces were retained intentionally.',
      });
    }

    // 2b. RETRY-SAFE owned-namespace sweep (finding #2). The per-instance cleanup above
    // reads the names off the CR's `typekro.io/hoisted-namespaces` annotation — but that
    // record dies WITH the CR, so a retry AFTER an earlier attempt already deleted the CR
    // (crash / partial teardown) would find the CR 404, read NO names, and skip cleanup.
    // Since this is the LAST instance, find EVERY namespace this RGD created via the
    // DURABLE `typekro.io/created-by-rgd` namespace annotation (survives the CR) and clean
    // each — catching any namespace leaked by an interrupted teardown. The names above may
    // overlap; `deleteNamespaceIfEmpty` is idempotent (a 404 is a no-op). A LIST failure
    // means we cannot confirm cleanup, so PRESERVE the RGD/CRD and return (a later retry
    // completes it) — deleting the definitions now could orphan a leaked namespace.
    let ownedNamespaces: string[];
    try {
      ownedNamespaces = await listNamespacesOwnedByRgd(this.getKubeConfig(), this.rgdName, {
        k8sApi,
        logger: this.logger,
        abortSignal,
      });
    } catch (listError: unknown) {
      const reason = `Cannot list namespaces owned by RGD ${this.rgdName}: ${ensureError(listError).message}`;
      this.logger.warn(
        'Cannot list owned namespaces to confirm cleanup — preserving RGD/CRD (retry to complete)',
        { rgdName: this.rgdName, error: ensureError(listError).message }
      );
      const rgd = deletionTarget('kro.run/v1alpha1', 'ResourceGraphDefinition', this.rgdName);
      deletion.retained.push({
        resource: rgd,
        policy: 'safety-proof-unavailable',
        reason,
      });
      deletion.blockers.push({
        code: 'DISCOVERY_FAILED',
        message: reason,
        resource: rgd,
        retryable: true,
        retryGuidance:
          'Restore Namespace list access and retry; TypeKro retained the RGD and generated CRD.',
      });
      return finishDeletionResult(deletion, 'blocked', {
        safe: true,
        guidance: 'Retry after Namespace ownership discovery is available.',
      });
    }
    for (const ns of ownedNamespaces) {
      abortSignal.throwIfAborted();
      const incomplete = await deleteOwnedNamespace(ns);
      if (incomplete) return incomplete;
    }

    // 2c. CONFIRM owned-namespace cleanup BEFORE removing the definitions (finding #2): do
    // NOT delete the RGD/CRD while any owned namespace still exists or cannot be confirmed
    // gone. `deleteNamespaceIfEmpty` above RETAINS (does not delete) a namespace another
    // stack still occupies or one it could not read — those legitimately remain here, so we
    // keep the RGD/CRD rather than orphan a still-owned namespace from its definition. Only
    // once NO created-by-rgd namespace remains do we proceed to tear the definitions down.
    let remainingOwned: string[];
    try {
      remainingOwned = await listNamespacesOwnedByRgd(this.getKubeConfig(), this.rgdName, {
        k8sApi,
        logger: this.logger,
        abortSignal,
      });
    } catch (listError: unknown) {
      const reason = `Cannot confirm cleanup of namespaces owned by RGD ${this.rgdName}: ${ensureError(listError).message}`;
      this.logger.warn(
        'Cannot confirm owned-namespace cleanup — preserving RGD/CRD (retry to complete)',
        { rgdName: this.rgdName, error: ensureError(listError).message }
      );
      const rgd = deletionTarget('kro.run/v1alpha1', 'ResourceGraphDefinition', this.rgdName);
      deletion.retained.push({
        resource: rgd,
        policy: 'safety-proof-unavailable',
        reason,
      });
      deletion.blockers.push({
        code: 'DISCOVERY_FAILED',
        message: reason,
        resource: rgd,
        retryable: true,
        retryGuidance:
          'Restore Namespace list access and retry; TypeKro retained the RGD and generated CRD.',
      });
      return finishDeletionResult(deletion, 'blocked', {
        safe: true,
        guidance: 'Retry after Namespace cleanup can be confirmed.',
      });
    }
    // A graph child reaching 404 only proves its controller accepted deletion;
    // grandchildren such as Helm-managed Pods or Rook RGW Deployments may need
    // another reconciliation cycle to disappear. For a normal (non-retry)
    // deletion, keep retrying the ownership+emptiness gate for a bounded period
    // before returning the durable "preserved for retry" state. This prevents a
    // successful deleteInstance() from racing immediately into teardown of a
    // storage prerequisite while owned descendants are still draining.
    const namespacesStillDraining = (): string[] =>
      remainingOwned.filter((namespace) => !permanentlyRetainedOwnedNamespaces.has(namespace));
    if (crSpec && namespacesStillDraining().length > 0) {
      const drainDeadline = Date.now() + Math.min(timeout, 60_000);
      while (namespacesStillDraining().length > 0 && Date.now() < drainDeadline) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(delay);
            reject(
              abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError')
            );
          };
          const delay = setTimeout(() => {
            abortSignal.removeEventListener('abort', onAbort);
            resolve();
          }, 2_000);
          if (abortSignal.aborted) {
            onAbort();
            return;
          }
          abortSignal.addEventListener('abort', onAbort, { once: true });
        });
        for (const ns of namespacesStillDraining()) {
          abortSignal.throwIfAborted();
          const incomplete = await deleteOwnedNamespace(ns);
          if (incomplete) return incomplete;
        }
        try {
          remainingOwned = await listNamespacesOwnedByRgd(this.getKubeConfig(), this.rgdName, {
            k8sApi,
            logger: this.logger,
            abortSignal,
          });
        } catch (listError: unknown) {
          const reason = `Cannot confirm descendant drain for namespaces owned by RGD ${this.rgdName}: ${ensureError(listError).message}`;
          this.logger.warn(
            'Cannot confirm owned-namespace descendant drain — preserving RGD/CRD for retry',
            { rgdName: this.rgdName, error: ensureError(listError).message }
          );
          const rgd = deletionTarget('kro.run/v1alpha1', 'ResourceGraphDefinition', this.rgdName);
          deletion.retained.push({
            resource: rgd,
            policy: 'safety-proof-unavailable',
            reason,
          });
          deletion.blockers.push({
            code: 'DISCOVERY_FAILED',
            message: reason,
            resource: rgd,
            retryable: true,
            retryGuidance: 'Restore Namespace list access, then retry deletion.',
          });
          return finishDeletionResult(deletion, 'blocked', {
            safe: true,
            guidance: 'Retry after Namespace descendant cleanup can be confirmed.',
          });
        }
      }
    }
    if (remainingOwned.length > 0) {
      this.logger.info(
        'Owned namespace(s) still present after cleanup — preserving RGD/CRD until they are gone',
        { rgdName: this.rgdName, remaining: remainingOwned }
      );
      for (const namespace of remainingOwned) {
        const resource = deletionTarget('v1', 'Namespace', namespace);
        if (
          !deletion.retained.some(
            (entry) => entry.resource.kind === 'Namespace' && entry.resource.name === namespace
          )
        ) {
          deletion.retained.push({
            resource,
            policy: 'occupied-namespace',
            reason:
              'The namespace remains owned by this RGD but contains resources that TypeKro will not delete implicitly.',
          });
        }
      }
      const rgd = deletionTarget('kro.run/v1alpha1', 'ResourceGraphDefinition', this.rgdName);
      deletion.retained.push({
        resource: rgd,
        policy: deletion.blockers.length > 0 ? 'safety-proof-unavailable' : 'occupied-namespace',
        reason:
          'The RGD is retained while an owned namespace remains, preventing orphaned lifecycle state.',
      });
      if (this.discoveredPlural) {
        deletion.retained.push({
          resource: deletionTarget(
            'apiextensions.k8s.io/v1',
            'CustomResourceDefinition',
            `${this.discoveredPlural}.${this.getSchemaGroup()}`
          ),
          policy: 'generated-crd',
          reason: 'The generated CRD is retained Active while owned namespaces remain.',
        });
      }
      return finishDeletionResult(deletion, deletion.blockers.length > 0 ? 'blocked' : 'complete', {
        safe: true,
        guidance:
          deletion.blockers.length > 0
            ? 'Resolve the listed discovery or ownership blockers, then retry.'
            : 'The instance graph is gone. Occupied or adopted namespaces and their definitions were retained explicitly.',
      });
    }

    // 3. Delete the RGD and GATE on its 404 (findings #1 + #2). The RGD carries a KRO
    // finalizer; while KRO processes it, KRO's per-RGD dynamic controller is still
    // WATCHING the generated CRD's resources. Waiting for the RGD 404 first lets KRO
    // tear its controller down cleanly. The gate THROWS on timeout (no silent proceed).
    const rgdTarget = deletionTarget('kro.run/v1alpha1', 'ResourceGraphDefinition', this.rgdName);
    try {
      await rollback.deleteResourceAndWait(rgdTarget, { timeout, abortSignal });
      deletion.deleted.push(rgdTarget);
    } catch (error: unknown) {
      if (abortSignal.aborted) throw abortSignal.reason ?? error;
      let live = rgdTarget;
      try {
        live = (await readDeletionResourceIdentity(k8sApi, rgdTarget)) ?? rgdTarget;
      } catch (readError: unknown) {
        deletion.blockers.push({
          code: 'CLEANUP_ERROR',
          message: `RGD deletion failed and blocker inspection also failed: ${ensureError(readError).message}`,
          resource: rgdTarget,
          retryable: true,
          retryGuidance: 'Restore Kubernetes API access, then retry deletion.',
        });
      }
      deletion.remaining.push(live);
      deletion.blockers.push(
        blockerForRemainingResource(
          live,
          `ResourceGraphDefinition ${this.rgdName} did not complete deletion: ${ensureError(error).message}`
        )
      );
      return finishDeletionResult(deletion, live.deletionTimestamp ? 'progressing' : 'blocked', {
        safe: true,
        afterMs: 2_000,
        guidance: 'Retry after KRO clears the listed RGD finalizers.',
      });
    }
    this.logger.debug('RGD deleted and fully gone', { rgdName: this.rgdName });

    // 4. RETAIN the generated CRD. This matches the Alchemy path and KRO's own
    // `allowCRDDeletion=false` default. Initiating a best-effort delete is not harmless:
    // apiextensions can leave the definition Terminating behind its
    // `customresourcecleanup` finalizer, and a Terminating definition prevents a later
    // deployment of the same RGD/kind from reusing it. At this point it has zero
    // instances, so keeping it Active is the safe, reusable state. Administrators may
    // garbage-collect retired definitions explicitly after proving no RGD or instances
    // need them. See docs/advanced/migration.md.
    this.logger.debug('Generated CRD retained for safe reuse and out-of-band GC', {
      rgdName: this.rgdName,
      ...(this.discoveredPlural
        ? { crdName: `${this.discoveredPlural}.${this.getSchemaGroup()}` }
        : {}),
    });
    if (this.discoveredPlural) {
      deletion.retained.push({
        resource: deletionTarget(
          'apiextensions.k8s.io/v1',
          'CustomResourceDefinition',
          `${this.discoveredPlural}.${this.getSchemaGroup()}`
        ),
        policy: 'generated-crd',
        reason:
          'Generated CRDs are retained Active by policy after the final instance is removed; administrative GC may delete them after proving they are unused.',
      });
    }
    return finishDeletionResult(deletion, 'complete', {
      safe: true,
      guidance:
        'The instance graph and RGD are gone. The generated CRD was retained Active under the documented zero-instance policy.',
    });
  }

  /**
   * Emit this factory's KRO deployment as declarative alchemy **v2** resources — the v2
   * analog of the removed imperative `deployWithAlchemy(scope)`. Returns, in dependency order, a
   * declaration for each discovered **singleton owner** (its own RGD + instance — mirroring
   * `ensureSingletonOwners` in the imperative `deploy()` path), then the **RGD** (shared, deployed
   * once), then the **CR instance** (one per `spec`, which `dependsOn` the RGD + the singletons),
   * matching the old integration's per-resource state granularity. The caller instantiates
   * each with `KroResource` inside their Stack (RGD first so reverse-topo removes the
   * instance before the shared RGD):
   *
   * ```ts
   * for (const { id, props } of await factory.toAlchemyResources(spec)) {
   *   yield* KroResource(id, props);
   * }
   * ```
   *
   * Each declaration carries serialized `kubeConfigOptions` (so reconcile can reconnect to the
   * cluster after state rehydration) and `kroDeletion` (so delete is finalizer-safe / shared-RGD
   * aware). The actual deploy/teardown runs in `kroProvider`'s reconcile/delete.
   */
  async toAlchemyResources(
    spec: TSpec,
    opts?: { instanceNameOverride?: string; singletonSpecFingerprint?: string }
  ): Promise<AlchemyResourceDeclaration[]> {
    this.assertNoKroPrerequisiteHookForDeclarative('toAlchemyResources()');
    this.assertNoReservedKroSpecField(spec);
    validateSpec(spec, this.schemaDefinition, {
      kind: this.schemaDefinition.kind,
      name: this.name,
    });
    this.assertInstanceNamespaceOwnershipSafe(spec);

    const instanceNamespace = this.resolveInstanceNamespace(spec);
    const kubeConfigOptions = this.extractKubeConfigOptionsForAlchemy();
    const compiledBundle = this.compiledKroArtifactBundle(spec, opts);
    if (compiledBundle) {
      this.assertBundleCapabilities(compiledBundle.bundle, {
        host: 'alchemy',
        output: 'live',
      });
      const runtimeBindings = compiledBundle.bundle.operations.flatMap((operation) => {
        const strategy = operation.artifact.readiness.strategy;
        return strategy?.kind === 'runtime-binding'
          ? [
              {
                operationId: operation.id,
                binding: strategy.binding,
                classification: strategy.classification ?? {
                  reason: 'unclassified-evaluator' as const,
                },
              },
            ]
          : [];
      });
      if (runtimeBindings.length > 0) {
        throw new TypeKroError(
          'KRO Alchemy declarations cannot persist runtime-only readiness functions. Register a portable readiness strategy or use standalone deployment.',
          'KRO_ALCHEMY_RUNTIME_BINDING_UNSUPPORTED',
          { runtimeBindings }
        );
      }
      return this.alchemyDeclarationsFromKroArtifactBundle(
        compiledBundle.bundle,
        kubeConfigOptions,
        compiledBundle.sensitiveBindings
      );
    }
    this.assertBundleCapabilities(undefined, { host: 'alchemy', output: 'live' });
    const kroDeletion = this.createAlchemyKroDeletionOptions(instanceNamespace);
    const prerequisiteDeclarations = this.prerequisiteAlchemyDeclarations(kubeConfigOptions);
    const prerequisiteIds = prerequisiteDeclarations.map((decl) => decl.id);

    // Every Namespace the composition owns is HOISTED out of the RGD graph and
    // emitted here instead — before the RGD + instance and OUTSIDE the graph, so the
    // CR always has a namespace to land in and KRO never garbage-collects it (which
    // would strand the instance's finalizer). Teardown is EMPTY-GATED (findings #3 +
    // #4): alchemy's reverse-topo teardown runs the namespace's delete AFTER the RGD +
    // instance (both `dependsOn` it), and the instance's delete waits for its
    // `kro.run/finalizer` to clear (KRO graph-deletes all children) — so by then
    // everything THIS instance owned has drained (finding #1's ordering, via the
    // dependency graph + instance-drain wait). The namespace is then deleted ONLY if
    // empty and RETAINED if another stack/user still has resources there. This is the
    // same for the instance's OWN namespace and a SHARED one — deduped by name, so
    // multiple stacks share ONE declaration and none deletes it while another still
    // occupies it (no cross-stack refcount needed).
    const instanceNamespaceDeclarations: AlchemyResourceDeclaration[] = [];
    const instanceNamespaceIds: string[] = [];
    for (const [hoistedNs, { artifact, resource }] of this.materializedHoistedNamespaces(spec)) {
      resource.metadata.annotations = {
        ...resource.metadata.annotations,
        [NAMESPACE_OWNER_ANNOTATION]: this.rgdName,
      };
      const decl = this.hoistedNamespaceAlchemyDeclaration(
        hoistedNs,
        resource,
        artifact,
        kubeConfigOptions,
        prerequisiteIds
      );
      instanceNamespaceDeclarations.push(decl);
      instanceNamespaceIds.push(decl.id);
    }
    const leadingIds = [...prerequisiteIds, ...instanceNamespaceIds];

    // 0. Singleton owners. The imperative `deploy()` ensures shared singleton owners (each its own
    // RGD + instance, in its registry namespace) via `ensureSingletonOwners` BEFORE the main
    // instance; emit them as declarations too so the declarative path has the same boundaries.
    // Their deterministic ids/names mean alchemy dedupes a singleton shared across compositions.
    // (The runtime spec-drift check from `ensureSingletonOwners` is omitted here — `toAlchemyResources`
    // stays cluster-free — but the spec-fingerprint annotation it relied on is still emitted.)
    const singletonDeclarations: AlchemyResourceDeclaration[] = [];
    const singletonInstanceIds: string[] = [];
    for (const definition of this.discoverSingletonDefinitions(spec)) {
      const singletonFactory = this.singletonFactoryFor(definition);
      try {
        const decls = await singletonFactory.toAlchemyResources(
          definition.spec as KroCompatibleType,
          {
            instanceNameOverride: getSingletonInstanceName(definition.id),
            singletonSpecFingerprint: singletonSpecFingerprintAnnotationValue(
              definition.specFingerprint
            ),
          }
        );
        singletonDeclarations.push(...decls);
        // `toAlchemyResources` returns the owner's OWN CR instance LAST (after any of ITS nested
        // singletons + its RGD), so the consumer must wait on `decls[last]` — using "first decl
        // with a dependency" would wrongly point at a nested singleton's instance.
        const ownerInstance = decls[decls.length - 1];
        if (ownerInstance) singletonInstanceIds.push(ownerInstance.id);
      } finally {
        await singletonFactory.dispose?.();
      }
    }

    // 1. RGD declaration (deployed once per factory; shared by all instances). The serializer
    // exposes the manifest directly, so Alchemy consumes the same representation without a
    // YAML dump/load round trip or timestamp-like scalar coercion.
    const rgdManifest = this.buildRgdManifest(spec);
    const rgdFactory =
      this.rgdProvider ??
      (await import('../../factories/kro/resource-graph-definition.js')).resourceGraphDefinition;
    const rgdEnhanced = rgdFactory(rgdManifest as unknown as Record<string, unknown>);
    const rgdId = createAlchemyResourceId(rgdEnhanced, this.namespace);
    const rgdDeclaration: AlchemyResourceDeclaration = {
      id: rgdId,
      dependsOn: leadingIds,
      props: {
        resource: rgdEnhanced as Enhanced<unknown, unknown>,
        namespace: this.namespace,
        deploymentStrategy: 'kro',
        kubeConfigOptions,
        kroDeletion,
        // Honor the factory's configured timeout (matches the non-alchemy paths, e.g. line ~1700);
        // hardcoding DEFAULT_RGD_TIMEOUT (60s) ignored a caller's longer timeout and false-failed a
        // converge whose RGD legitimately takes >60s to reach ready (e.g. a Helm workload rollout).
        options: {
          waitForReady: true,
          timeout: this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT,
        },
      },
    };

    // 2. CR instance declaration (one per deploy call). Depends on the RGD so alchemy applies the
    // instance only after the RGD's CRD is established (else the CR apply races a missing kind).
    const instanceName = opts?.instanceNameOverride ?? generateInstanceName(spec, this.name);
    const crdInstanceManifest = this.createCustomResourceInstance(
      instanceName,
      spec,
      opts?.singletonSpecFingerprint
    );
    // Cast: a plain KubernetesResource is fine — the alchemy path only reads kind/metadata.
    const crdAsEnhanced = crdInstanceManifest as unknown as Enhanced<unknown, unknown>;
    const instanceDeclaration: AlchemyResourceDeclaration = {
      id: this.instanceAlchemyId(crdAsEnhanced),
      // Wait for the RGD's CRD AND for any singleton owners (mirrors `ensureSingletonOwners` running
      // before the main deploy), so the instance applies only once its dependencies exist.
      dependsOn: [rgdId, ...singletonInstanceIds, ...instanceNamespaceIds],
      props: {
        resource: crdAsEnhanced,
        namespace: instanceNamespace,
        deploymentStrategy: 'kro',
        kubeConfigOptions,
        kroDeletion,
        options: {
          // Honor the factory's `waitForReady` (default true, matching the imperative deploy path at
          // `deploy()`), so a declarative converge blocks until the CR instance's KRO-managed resources
          // (e.g. a HelmRelease + its pods) are actually ready — end-to-end readiness, not merely
          // "CR applied". A consumer that wants fire-and-forget passes `waitForReady: false` to the factory.
          waitForReady: this.factoryOptions.waitForReady ?? true,
          timeout: this.factoryOptions.timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
        },
      },
    };

    return [
      ...prerequisiteDeclarations,
      ...instanceNamespaceDeclarations,
      ...singletonDeclarations,
      rgdDeclaration,
      instanceDeclaration,
    ];
  }

  /**
   * The alchemy resource id for a KRO instance CR — the LEGACY, namespace-agnostic
   * kind+name id (finding #1).
   *
   * This deliberately does NOT fold the namespace into the id. An earlier revision
   * appended a namespace hash to distinguish same-named instances placed in
   * different namespaces, but that changed every existing instance's id versus the
   * released v0.26.0, so alchemy would see remove+replace and could tear down
   * (delete) the live CR on upgrade. Reverting to the legacy id keeps existing
   * alchemy state identity stable.
   *
   * Consequence to be honest about: within ONE alchemy stack, two instances collide
   * iff they share this kind+name id — regardless of their k8s namespace. A
   * different factory namespace does NOT automatically yield a different alchemy
   * scope. To keep same-named instances (e.g. `analytics` in dev vs prod) separate,
   * the CALLER must materialize them in SEPARATE alchemy stacks/scopes.
   */
  private instanceAlchemyId(resource: Enhanced<unknown, unknown>): string {
    return createAlchemyResourceId(resource);
  }

  /** Serialize the factory's cluster connection so an alchemy resource can reconnect after rehydration. */
  private extractKubeConfigOptionsForAlchemy(): SerializableKubeConfigOptions {
    const persistence =
      this.factoryOptions.alchemyKubeConfig ??
      (this.factoryOptions.kubeConfig === undefined
        ? { source: { kind: 'default' as const } }
        : undefined);
    const kubeConfig =
      this.factoryOptions.kubeConfig ?? (persistence?.source ? undefined : this.getKubeConfig());
    return extractSerializableKubeConfigOptions(kubeConfig, {
      ...(this.factoryOptions.skipTLSVerify === true ? { skipTLSVerifyOverride: true } : {}),
      ...(persistence ? { persistence } : {}),
    });
  }

  /** Build the finalizer-safe, shared-RGD-aware deletion metadata for this factory's instances. */
  private createAlchemyKroDeletionOptions(instanceNamespace = this.namespace): KroDeletionOptions {
    return {
      apiVersion: this.schemaDefinition.apiVersion,
      kind: this.schemaDefinition.kind,
      ...(this.schemaDefinition.group && { group: this.schemaDefinition.group }),
      namespace: instanceNamespace,
      rgdName: this.rgdName,
      ...(this.discoveredPlural && { plural: this.discoveredPlural }),
      timeout: this.factoryOptions.timeout ?? 300000,
    };
  }

  private kroDeletionForBundleOperation(
    bundle: KroArtifactBundle,
    operation: KroArtifactBundleOperation
  ): KroDeletionOptions | undefined {
    if (
      operation.role !== 'resource-graph-definition' &&
      operation.role !== 'singleton-owner-rgd' &&
      operation.role !== 'instance' &&
      operation.role !== 'singleton-owner-instance'
    ) {
      return undefined;
    }
    const memberId = operation.sources[0]?.memberId;
    if (!memberId) return undefined;
    const rgdOperation = bundle.operations.find(
      (candidate) =>
        (candidate.role === 'resource-graph-definition' ||
          candidate.role === 'singleton-owner-rgd') &&
        candidate.sources.some((source) => source.memberId === memberId)
    );
    const instanceOperation = bundle.operations.find(
      (candidate) =>
        (candidate.role === 'instance' || candidate.role === 'singleton-owner-instance') &&
        candidate.sources.some((source) => source.memberId === memberId)
    );
    if (!rgdOperation || !instanceOperation) return undefined;
    const rgdIdentity = rgdOperation.artifact.identity;
    const instanceIdentity = instanceOperation.artifact.identity;
    if (!rgdIdentity || !instanceIdentity) return undefined;
    const apiVersion = instanceIdentity.apiVersion;
    const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : undefined;
    return {
      apiVersion,
      kind: instanceIdentity.kind,
      namespace: instanceIdentity.namespace
        ? String(materializePlanValue(instanceIdentity.namespace))
        : this.namespace,
      rgdName: String(materializePlanValue(rgdIdentity.name)),
      ...(group ? { group } : {}),
      timeout: this.factoryOptions.timeout ?? 300000,
    };
  }

  private async alchemyDeclarationsFromKroArtifactBundle(
    bundle: KroArtifactBundle,
    kubeConfigOptions: SerializableKubeConfigOptions,
    sensitiveBindings: Readonly<Record<string, unknown>>
  ): Promise<AlchemyResourceDeclaration[]> {
    const encodedBundle = encodeKroArtifactBundle(bundle);
    const ordered = orderKroArtifactBundleOperations(bundle);
    const Redacted =
      Object.keys(sensitiveBindings).length > 0 ? await import('effect/Redacted') : undefined;
    const rgdFactory =
      this.rgdProvider ??
      (await import('../../factories/kro/resource-graph-definition.js')).resourceGraphDefinition;
    const resources = new Map<string, Enhanced<unknown, unknown>>();
    const operationSensitiveBindings = new Map<string, Readonly<Record<string, unknown>>>();
    const operationArtifactUses = new Map<string, readonly ArtifactOutputUse[]>();
    const declarationIds = new Map<string, string>();

    for (const operation of ordered) {
      const bindingNames = planValueSensitiveBindingNames(operation.manifest);
      const missingBindings = bindingNames.filter(
        (binding) => !Object.hasOwn(sensitiveBindings, binding)
      );
      if (missingBindings.length > 0) {
        throw new TypeKroError(
          `KRO operation ${operation.id} has unresolved sensitive bindings: ${missingBindings.join(', ')}.`,
          'KRO_SENSITIVE_BINDING_UNRESOLVED',
          { operationId: operation.id, bindings: missingBindings }
        );
      }
      const redactedBindings =
        Redacted && bindingNames.length > 0
          ? Object.fromEntries(
              bindingNames.map((binding) => [binding, Redacted.make(sensitiveBindings[binding])])
            )
          : {};
      operationSensitiveBindings.set(operation.id, redactedBindings);
      const artifactOutputUses = collectArtifactOutputUses(operation.manifest);
      operationArtifactUses.set(operation.id, artifactOutputUses);
      const declarationArtifactOutputs = Object.fromEntries(
        bundle.artifactRequirements.map((requirement) => [
          requirement.id,
          Object.fromEntries(
            requirement.outputs.map((output) => [
              output,
              `__typekro_artifact_${encodeURIComponent(requirement.id)}_${encodeURIComponent(output)}__`,
            ])
          ),
        ])
      );
      const manifest = materializeKroArtifactBundleOperation(operation, {
        sensitive: redactedBindings,
        ...(artifactOutputUses.length > 0 ? { artifactOutputs: declarationArtifactOutputs } : {}),
      });
      const artifact = operation.artifact;
      if (artifact.identity?.scope) setMetadataField(manifest, 'scope', artifact.identity.scope);
      setMetadataField(manifest, 'applyPolicy', artifact.apply);
      setResourceId(manifest, artifact.id);
      const strategy = artifact.readiness.strategy;
      if (strategy?.kind === 'registered') {
        const evaluator = resolvePortableReadinessStrategy(strategy);
        if (!evaluator) {
          throw new TypeKroError(
            `Registered readiness strategy ${strategy.id}@${strategy.revision} is unavailable.`,
            'KRO_ARTIFACT_READINESS_UNAVAILABLE',
            { operationId: operation.id, artifactId: artifact.id }
          );
        }
        setReadinessEvaluator(manifest, evaluator);
      }

      if (operation.role === 'hoisted-namespace') {
        const evidence = artifact.lifecycle.unusedEvidence;
        const evidenceInputs = evidence
          ? (materializePlanValue(evidence.inputs) as Record<string, unknown>)
          : undefined;
        manifest.metadata.annotations = {
          ...manifest.metadata.annotations,
          [NAMESPACE_OWNER_ANNOTATION]: String(evidenceInputs?.rgdName ?? this.rgdName),
        };
      }

      const enhanced =
        operation.role === 'resource-graph-definition' || operation.role === 'singleton-owner-rgd'
          ? (rgdFactory(manifest as unknown as Record<string, unknown>) as Enhanced<
              unknown,
              unknown
            >)
          : (manifest as Enhanced<unknown, unknown>);
      setMetadataField(enhanced, 'applyPolicy', artifact.apply);
      resources.set(operation.id, enhanced);

      const declarationId =
        operation.role === 'hoisted-namespace'
          ? KroResourceFactoryImpl.hoistedNamespaceId(String(manifest.metadata.name))
          : operation.role === 'instance' || operation.role === 'singleton-owner-instance'
            ? this.instanceAlchemyId(enhanced)
            : createAlchemyResourceId(
                enhanced,
                artifact.identity?.scope === 'cluster'
                  ? undefined
                  : (manifest.metadata.namespace ?? this.namespace)
              );
      if ([...declarationIds.values()].includes(declarationId)) {
        throw new TypeKroError(
          `KRO bundle operations collapse to duplicate Alchemy id ${declarationId}.`,
          'KRO_ALCHEMY_DECLARATION_ID_COLLISION',
          { operationId: operation.id, declarationId }
        );
      }
      declarationIds.set(operation.id, declarationId);
    }

    return ordered.map((operation) => {
      const resource = resources.get(operation.id);
      const declarationId = declarationIds.get(operation.id);
      if (!resource || !declarationId) {
        throw new TypeKroError(
          `KRO operation ${operation.id} was not prepared for Alchemy declaration emission.`,
          'KRO_ALCHEMY_DECLARATION_MISSING',
          { operationId: operation.id }
        );
      }
      const artifact = operation.artifact;
      const operationBindings = operationSensitiveBindings.get(operation.id);
      const artifactOutputUses = operationArtifactUses.get(operation.id) ?? [];
      const artifactRequirementIds = new Set(artifactOutputUses.map((use) => use.requirementId));
      const artifactRequirements = bundle.artifactRequirements.filter((requirement) =>
        artifactRequirementIds.has(requirement.id)
      );
      const manifest = resource as KubernetesResource;
      const direct =
        operation.role === 'kro-prerequisite' || operation.role === 'hoisted-namespace';
      const kroDeletion = this.kroDeletionForBundleOperation(bundle, operation);
      const evidence = artifact.lifecycle.unusedEvidence;
      const evidenceInputs = evidence
        ? (materializePlanValue(evidence.inputs) as Record<string, unknown>)
        : undefined;
      const namespace =
        operation.role === 'hoisted-namespace'
          ? String(manifest.metadata.name)
          : (manifest.metadata.namespace ?? this.namespace);
      return {
        id: declarationId,
        dependsOn: operation.dependencies.map((dependency) => {
          const declarationId = declarationIds.get(dependency);
          if (!declarationId) {
            throw new TypeKroError(
              `KRO operation ${operation.id} references an unemitted dependency ${dependency}.`,
              'KRO_ALCHEMY_DEPENDENCY_MISSING',
              { operationId: operation.id, dependency }
            );
          }
          return declarationId;
        }),
        ...(artifactRequirements.length > 0 ? { artifactRequirements } : {}),
        ...(artifactOutputUses.length > 0 ? { artifactOutputUses } : {}),
        props: {
          resource,
          resourceId: artifact.id,
          namespace,
          deploymentStrategy: direct ? ('direct' as const) : ('kro' as const),
          kubeConfigOptions,
          kroArtifactBundle: encodedBundle,
          kroArtifactOperationId: operation.id,
          ...(artifactRequirements.length > 0 ? { artifactRequirements } : {}),
          ...(artifactOutputUses.length > 0 ? { artifactOutputUses } : {}),
          ...(operationBindings && Object.keys(operationBindings).length > 0
            ? { sensitiveBindings: operationBindings }
            : {}),
          ...(kroDeletion ? { kroDeletion } : {}),
          ...(operation.role === 'hoisted-namespace'
            ? {
                namespaceEmptyGate: true,
                namespaceOwnerRgd: String(evidenceInputs?.rgdName ?? this.rgdName),
                namespacePreHoistQuery: {
                  group: String(evidenceInputs?.group ?? this.getSchemaGroup()),
                  version: String(evidenceInputs?.version ?? this.getSchemaVersion()),
                  kind: String(evidenceInputs?.kind ?? this.schemaDefinition.kind),
                },
              }
            : {}),
          options: {
            waitForReady:
              operation.role === 'resource-graph-definition' ||
              operation.role === 'singleton-owner-rgd' ||
              operation.role === 'singleton-owner-instance' ||
              (operation.role === 'instance'
                ? (this.factoryOptions.waitForReady ?? true)
                : artifact.readiness.strategy !== undefined),
            timeout:
              this.factoryOptions.timeout ??
              (operation.role === 'resource-graph-definition' ||
              operation.role === 'singleton-owner-rgd'
                ? DEFAULT_RGD_TIMEOUT
                : DEFAULT_DEPLOYMENT_TIMEOUT),
          },
        },
      };
    });
  }

  /**
   * Get factory status
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
    const instances = await this.getInstancesWithinOperation(abortSignal);
    const rgdStatus = await this.getRGDStatusWithinOperation(abortSignal);

    return {
      name: this.name,
      mode: this.mode,
      namespace: this.namespace,
      instanceCount: instances.length,
      health: rgdStatus.phase === 'ready' ? 'healthy' : 'degraded',
    };
  }

  /**
   * Get ResourceGraphDefinition status
   */
  async getRGDStatus(opts?: InternalResourceFactoryReadOptions): Promise<RGDStatus> {
    if (opts?.operationSignal) {
      return this.getRGDStatusWithinOperation(opts.operationSignal);
    }
    return runStandaloneOperation((abortSignal) => this.getRGDStatusWithinOperation(abortSignal), {
      abortSignals: [this.factoryOptions.abortSignal, opts?.abortSignal],
    });
  }

  private async getRGDStatusWithinOperation(abortSignal: AbortSignal): Promise<RGDStatus> {
    abortSignal.throwIfAborted();
    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    try {
      // In the new API, methods return objects directly (no .body wrapper)
      const response = await k8sApi.read({
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: {
          name: this.rgdName,
        },
      });
      abortSignal.throwIfAborted();

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
      abortSignal.throwIfAborted();
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
  toYaml(spec: TSpec, options?: StaticYamlMaterializationOptions): string;
  /**
   * Implementation of overloaded toYaml method
   */
  toYaml(spec?: TSpec, options?: StaticYamlMaterializationOptions): string {
    this.assertNoKroPrerequisiteHookForDeclarative('toYaml()');

    if (spec) {
      this.assertNoReservedKroSpecField(spec);
      validateSpec(spec, this.schemaDefinition, {
        kind: this.schemaDefinition.kind,
        name: this.name,
      });
      this.assertInstanceNamespaceOwnershipSafe(spec);

      const compiledBundle = this.compiledKroArtifactBundle(spec);
      if (compiledBundle) {
        this.assertBundleCapabilities(compiledBundle.bundle, { host: null, output: 'static' });
        const operations = orderKroArtifactBundleOperations(compiledBundle.bundle).filter(
          (operation) =>
            operation.role === 'hoisted-namespace' ||
            operation.role === 'singleton-owner-instance' ||
            operation.role === 'instance'
        );
        const requiredBindings = operations.flatMap((operation) =>
          planValueSensitiveBindingNames(operation.manifest)
        );
        const sensitiveBindings = resolveStaticYamlSensitiveBindings(
          requiredBindings,
          compiledBundle.sensitiveBindings,
          options,
          `KRO factory ${this.name} YAML`
        );
        const documents = operations.map((operation) =>
          yaml
            .dump(
              materializeKroArtifactBundleOperation(operation, {
                sensitive: sensitiveBindings,
              }),
              {
                lineWidth: -1,
                noRefs: true,
                sortKeys: false,
              }
            )
            .trimEnd()
        );
        return joinYamlDocuments(documents.slice(0, -1), documents.at(-1) ?? '');
      }

      this.assertBundleCapabilities(undefined, { host: null, output: 'static' });

      // Generate CRD instance YAML
      const instanceName = generateInstanceName(spec, this.name);
      const customResource = this.createCustomResourceInstance(instanceName, spec);
      const instanceYaml = yaml
        .dump(customResource, { lineWidth: -1, noRefs: true, sortKeys: false })
        .trimEnd();

      // Shared singleton owner instances are created by `deploy()`; for the
      // GitOps path we emit them alongside the consuming instance, deps-first,
      // so the consuming RGD's externalRef resolves. No-op without singletons.
      // Any owned workload Namespace hoisted out of the RGD graph leads, so the CR
      // always has a namespace to apply into and KRO never garbage-collects it.
      const ownerYamls = this.materializedSingletonOwnerInstances(spec).map((resource) =>
        yaml
          .dump(JSON.parse(JSON.stringify(resource)), {
            lineWidth: -1,
            noRefs: true,
            sortKeys: false,
          })
          .trimEnd()
      );
      const leadingInstanceYamls = [
        ...[...this.materializedHoistedNamespaces(spec).values()].map(({ resource }) =>
          yaml
            .dump(JSON.parse(JSON.stringify(resource)), {
              lineWidth: -1,
              noRefs: true,
              sortKeys: false,
            })
            .trimEnd()
        ),
        ...ownerYamls,
      ];
      return leadingInstanceYamls.length === 0
        ? instanceYaml
        : joinYamlDocuments(leadingInstanceYamls, instanceYaml);
    }

    const compiledBundle = this.compiledKroArtifactBundle();
    if (compiledBundle) {
      this.assertBundleCapabilities(compiledBundle.bundle, { host: null, output: 'static' });
      const documents = orderKroArtifactBundleOperations(compiledBundle.bundle)
        .filter(
          (operation) =>
            operation.role === 'kro-prerequisite' ||
            operation.role === 'singleton-owner-rgd' ||
            operation.role === 'resource-graph-definition'
        )
        .map((operation) =>
          yaml
            .dump(
              materializeKroArtifactBundleOperation(operation, {
                sensitive: compiledBundle.sensitiveBindings,
              }),
              {
                lineWidth: -1,
                noRefs: true,
                sortKeys: false,
              }
            )
            .trimEnd()
        );
      return joinYamlDocuments(documents.slice(0, -1), documents.at(-1) ?? '');
    }

    this.assertBundleCapabilities(undefined, { host: null, output: 'static' });

    const rgdYaml = this.buildRgdYaml();
    const prerequisiteYamls = this.prerequisiteResourceYamls();
    const leadingYamls = [...prerequisiteYamls, ...singletonRgdYamls(this.singletonDefinitions)];
    return leadingYamls.length === 0 ? rgdYaml : joinYamlDocuments(leadingYamls, rgdYaml);
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
   *
   * The hoist decision is SPEC-INDEPENDENT (finding #4): the RGD is shared by every
   * instance of this factory, so its shape must be a stable structural property and
   * must NOT vary with a per-call spec. `spec` is accepted only for signature
   * symmetry with the callers and is deliberately NOT used to decide hoisting — see
   * {@link hoistedNamespaceRefs} / {@link resourcesForRgd}.
   */
  private buildRgdManifest(_spec?: TSpec): KroResourceGraphDefinition {
    if (this.factoryOptions.compositionAnalysis && !this.compositionAnalysisApplied) {
      this.compositionAnalysisApplied = true;
      applyAnalysisToResources(
        this.resources as Record<string, unknown>,
        this.factoryOptions.compositionAnalysis
      );
    }

    // Hoist EVERY owned Namespace OUT of the RGD graph (STRUCTURALLY, so the shared
    // RGD shape is identical for every instance) and rewrite any dangling reference
    // to it. typekro NEVER emits a Namespace into RGD YAML; each is applied as a
    // sibling (toYaml/toAlchemyResources/imperative deploy), so deleting the instance
    // can never garbage-collect the namespace holding its own finalizer.
    const plannedResources = this.plannedResources();
    const hoistIds = this.hoistedNamespaceRefs(plannedResources);
    const graphResources = this.resourcesForRgd(plannedResources);

    // Rewrite references to a hoisted Namespace in the STATUS mappings too
    // (finding #6): a status CEL like `ns-${string(ownedNamespace.metadata.name)}`
    // would otherwise reference a resource removed from the graph and KRO would
    // reject the RGD. Each becomes the referenced Namespace's own name expression.
    const statusMappings = rewriteHoistedNamespaceRefsInValue(this.statusMappings, hoistIds);
    copyCompositionAnalysisMetadata(this.statusMappings, statusMappings);
    const nestedCel = rewriteHoistedNamespaceRefsInValue(this.getNestedStatusCel(), hoistIds);

    // #6 — REJECT (throw) HONESTLY, never silently drop: a status field whose only
    // reference was a hoisted Namespace becomes a schema-only expression
    // (`schema.spec.namespace`), which KRO status CEL cannot evaluate, so it cannot be
    // represented in the KRO status schema. Rather than ship a status API weaker than
    // the declared one (the old warn-and-drop), fail loudly naming the field(s).
    // Resource-derived sibling fields are unaffected.
    assertNoHoistWeakenedStatusFields(
      this.statusMappings as Record<string, unknown>,
      hoistIds,
      this.name
    );

    const aspectResources = this.factoryOptions.semanticCapture
      ? graphResources
      : applyAspects(graphResources, {
          mode: 'kro',
          aspects: this.factoryOptions.aspects ?? [],
        });

    // Semantic artifact adaptation canonicalizes graph-child keys. Preserve the
    // authoring aliases on those reconstructed resources so status classification
    // and emission resolve callback keys and derived nested aliases identically.
    const authoredIdentities = createStatusResourceIdentityContext(this.resources);
    const emittedIdentities = createStatusResourceIdentityContext(aspectResources);
    for (const [resourceKey, resource] of Object.entries(aspectResources)) {
      const emittedId = emittedIdentities.resourceAliases.get(resourceKey) ?? resourceKey;
      const aliases = [...authoredIdentities.resourceAliases.entries()].flatMap(
        ([alias, canonicalId]) => (canonicalId === emittedId && alias !== emittedId ? [alias] : [])
      );
      if (aliases.length > 0) {
        setMetadataField(resource, 'resourceAliases', [
          ...new Set([...(getMetadataField(resource, 'resourceAliases') ?? []), ...aliases]),
        ]);
      }
    }

    // Strict CEL diagnostics gate: fail fast if the status CEL that is about
    // to be emitted references resources that are not part of this graph,
    // instead of shipping an RGD that KRO will mark Inactive on the cluster.
    if (isStrictCelDiagnosticsEnabled(this.factoryOptions)) {
      this.assertStatusCelReferencesKnownResources(aspectResources);
    }

    const kroSchema = generateKroSchemaFromArktype(
      this.name,
      this.schemaDefinition,
      aspectResources,
      statusMappings,
      nestedCel,
      (this.factoryOptions.compositionOptions as SerializationOptions | undefined)
        ?.schemaFieldValidations
    );
    kroSchema.spec[KRO_ARTIFACT_BINDINGS_SPEC_FIELD] = 'map[string]map[string]string';

    // Attach nested status CEL mappings as non-enumerable property so
    // serializeResourceGraphToYaml can inline virtual composition IDs.
    if (nestedCel && Object.keys(nestedCel).length > 0) {
      Object.defineProperty(kroSchema, '__nestedStatusCel', {
        value: nestedCel,
        enumerable: false,
      });
    }

    const statusOverrides = this.factoryOptions.compositionAnalysis?.statusOverrides ?? [];
    if (statusOverrides.length > 0) {
      // Only resource-referencing (dynamic) overrides belong in the KRO schema;
      // schema-only ones (e.g. `spec.x ? a : b`) are rejected by KRO ("unknown
      // identifiers: [schema]") and are hydrated client-side instead, like any
      // other static status field.
      const resourceIdList = Object.keys(aspectResources);
      const nestedCelForClassification =
        nestedCel && Object.keys(nestedCel).length > 0 ? nestedCel : undefined;
      for (const override of statusOverrides) {
        // Rewrite any reference to a hoisted Namespace in the override expression
        // too (finding #6), so a status override never dangles at the removed id.
        const celExpression = rewriteHoistedNamespaceRefsInValue(override.celExpression, hoistIds);
        if (isStaticExpression(celExpression, nestedCelForClassification, resourceIdList)) continue;
        kroSchema.status ??= {};
        const yamlSafe = celExpression.replace(/"([^"\\]*)"/g, "'$1'");
        kroSchema.status[override.propertyPath] = yamlSafe;
      }
    }

    // Apply ternary conditionals to the exact resource set being serialized.
    // Aspect application clones resources, so each aspect render needs ternary
    // post-processing even when the base factory already ran it once.
    const hasAspects = (this.factoryOptions.aspects?.length ?? 0) > 0;
    if (hasAspects || !this.ternaryAndOmitApplied) {
      if (!hasAspects) this.ternaryAndOmitApplied = true;
      if (kroSchema.__ternaryConditionals?.length) {
        applyTernaryConditionalsToResources(
          aspectResources as Record<string, unknown>,
          kroSchema.__ternaryConditionals,
          kroSchema.__nestedStatusCel
        );
      }
    }

    const rgdManifest = serializeResourceGraphToManifest(
      this.rgdName,
      aspectResources,
      {
        ...(this.factoryOptions.compositionOptions as SerializationOptions | undefined),
        namespace: this.namespace,
        // Factory-level override. The composition option of the same name is unreachable for a consumer of a
        // SHIPPED composition (its definition lives in TypeKro), so without this there is no way to authorize
        // the one-off CRD schema migration KRO would otherwise silently refuse.
        ...(this.factoryOptions.allowBreakingChanges === undefined
          ? {}
          : { allowBreakingChanges: this.factoryOptions.allowBreakingChanges }),
      },
      kroSchema
    );

    // VALIDATE (finding #6): after hoisting, NO reference to any removed resource id
    // may remain anywhere in the emitted RGD. If one slipped through (a form the
    // rewrite didn't structurally cover), fail LOUDLY here rather than shipping an
    // RGD KRO will reject at runtime with a dangling `${...}` reference.
    this.assertNoDanglingHoistedReferences(JSON.stringify(rgdManifest), new Set(hoistIds.keys()));

    return rgdManifest;
  }

  private buildRgdYaml(spec?: TSpec): string {
    return serializeResourceGraphDefinitionToYaml(this.buildRgdManifest(spec), {
      ...(this.factoryOptions.compositionOptions as SerializationOptions | undefined),
      ...(this.factoryOptions.allowBreakingChanges === undefined
        ? {}
        : { allowBreakingChanges: this.factoryOptions.allowBreakingChanges }),
    });
  }

  /**
   * Assert the emitted RGD carries NO leftover reference to a hoisted (removed)
   * resource id — neither a CEL interpolation `${<id>.…}` nor a raw
   * `__KUBERNETES_REF_<id>_…` marker (finding #6). A negative lookbehind avoids
   * matching an id that is only a suffix of a longer identifier.
   */
  private assertNoDanglingHoistedReferences(rgdYaml: string, hoistIds: ReadonlySet<string>): void {
    const dangling = findDanglingHoistedReference(rgdYaml, hoistIds);
    if (dangling !== undefined) {
      throw new ResourceGraphFactoryError(
        `Hoisting the owned Namespace left a dangling reference to removed resource "${dangling}" in the ` +
          'emitted RGD. This would make KRO reject the graph. Report this as a typekro bug (the ' +
          'reference form was not structurally rewritten).',
        this.name,
        'deployment'
      );
    }
  }

  /**
   * Strict CEL diagnostics: verify that every dynamic status CEL expression
   * references only resources that exist in this graph.
   *
   * The lenient default demotes unknown `<id>.status.*` references to
   * cross-composition warnings at graph creation time, so an unresolvable
   * expression survives all the way into the emitted RGD and only fails on
   * the cluster. In strict mode (`strictCelDiagnostics` factory option or
   * `TYPEKRO_STRICT_CEL=1`), those findings abort serialization here with
   * the offending expressions.
   */
  private assertStatusCelReferencesKnownResources(
    resources: Record<string, KubernetesResource>
  ): void {
    if (!this.statusMappings) return;

    const validation = validateStatusCelExpressions(this.statusMappings, resources);
    const unknownResourceFindings = [...validation.errors, ...validation.warnings].filter(
      (finding) => finding.code === 'unknown-resource'
    );
    if (unknownResourceFindings.length === 0) return;

    const details = unknownResourceFindings
      .map(
        (finding) =>
          `  status.${finding.field}: resource '${finding.referencedResource}' is not part of the resource graph\n    expression: ${finding.expression}`
      )
      .join('\n');
    const known = Object.keys(resources);
    const first = unknownResourceFindings[0];

    throw new ConversionError(
      `Strict CEL diagnostics: status CEL in ResourceGraphDefinition '${this.name}' references unknown resources.\n${details}\n  Known resources: ${known.length > 0 ? known.join(', ') : '(none)'}`,
      first?.expression ?? '',
      'member-access',
      undefined,
      { analysisContext: 'status', availableReferences: known },
      [
        'Check that the referenced resources are created in this composition (resource ids are set via the "id" field on factory configs)',
        'If these are intentional cross-composition references, disable strict CEL diagnostics for this factory (strictCelDiagnostics: false)',
      ]
    );
  }

  private static asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private static getRgdSchemaStatusMap(
    rgd: k8s.KubernetesObject
  ): Record<string, unknown> | undefined {
    const resource = KroResourceFactoryImpl.asRecord(rgd);
    const spec = KroResourceFactoryImpl.asRecord(resource?.spec);
    const schema = KroResourceFactoryImpl.asRecord(spec?.schema);
    return KroResourceFactoryImpl.asRecord(schema?.status);
  }

  /**
   * Kubernetes merge-patch preserves omitted map keys. RGD status schema fields
   * that are removed from a composition must be sent as `null` so stale CEL does
   * not survive on an existing cluster-scoped RGD.
   */
  private async addRgdSchemaStatusPruneMarkers(rgdManifest: k8s.KubernetesObject): Promise<void> {
    const k8sApi = createBunCompatibleKubernetesObjectApi(this.getKubeConfig());

    let existing: k8s.KubernetesObject;
    try {
      existing = await k8sApi.read({
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: this.rgdName },
      });
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return;
      }
      this.logger.debug(
        'Skipping RGD status schema prune markers; existing RGD could not be read',
        {
          rgdName: this.rgdName,
          error: ensureError(error).message,
        }
      );
      return;
    }

    const existingStatus = KroResourceFactoryImpl.getRgdSchemaStatusMap(existing);
    const desiredStatus = KroResourceFactoryImpl.getRgdSchemaStatusMap(rgdManifest);
    if (!existingStatus || !desiredStatus) {
      return;
    }

    const removedFields: string[] = [];
    for (const fieldName of Object.keys(existingStatus)) {
      if (!(fieldName in desiredStatus)) {
        desiredStatus[fieldName] = null;
        removedFields.push(fieldName);
      }
    }

    if (removedFields.length > 0) {
      this.logger.debug('Adding RGD status schema prune markers', {
        rgdName: this.rgdName,
        removedFields,
      });
    }
  }

  /**
   * Ensure the ResourceGraphDefinition is deployed using DirectDeploymentEngine.
   *
   * The `spec` (when the caller has one) lets the RGD hoist the composition's own
   * workload Namespace out of the graph with its schema-driven name resolved.
   */
  private async ensureRGDDeployed(spec?: TSpec, abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted();
    // Create DirectDeploymentEngine instance with KRO mode for CEL string generation
    const deploymentEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );

    // Build the RGD YAML — shared with toYaml() so both call sites emit
    // identical post-processed output and share the single-apply guard.
    const rgdYaml = this.buildRgdYaml(spec);

    // Parse the YAML to get the RGD object. Use js-yaml with JSON_SCHEMA to MATCH the dump schema in
    // `serializeResourceGraphToYaml` (same fix as the alchemy path above — this is the imperative/direct
    // KRO deploy path). `k8s.loadAllYaml` uses js-yaml's DEFAULT (timestamp-aware) schema, which coerces an
    // unquoted date-shaped scalar — e.g. an env value `"2026-06-01"` — to a `Date` OBJECT, so the applied
    // RGD would carry an object where KRO requires a string and rejects the graph (`GraphAccepted=False`).
    const rgdManifests = yaml.loadAll(rgdYaml, undefined, {
      schema: yaml.JSON_SCHEMA,
    }) as k8s.KubernetesObject[];
    const rgdManifest = rgdManifests[0] as k8s.KubernetesObject;

    // Ensure the RGD has the required properties for deployment
    const rgdWithMetadata = {
      ...rgdManifest,
      metadata: {
        ...rgdManifest.metadata,
        name: this.rgdName,
      },
    };

    await this.addRgdSchemaStatusPruneMarkers(rgdWithMetadata);

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
    setMetadataField(deployableRGD, 'scope', 'cluster');

    // Debug: Log the RGD being deployed
    this.logger.debug('Deploying RGD', {
      rgdName: this.rgdName,
      rgdManifest: JSON.stringify(rgdWithMetadata, null, 2),
    });

    try {
      await this.applyKroPrerequisites(deploymentEngine, abortSignal);

      // Deploy RGD using DirectDeploymentEngine with readiness checking
      this.logger.info('Deploying RGD via engine', { rgdName: this.rgdName });
      await deploymentEngine.deployResource(deployableRGD, {
        mode: 'direct',
        namespace: this.namespace,
        waitForReady: true,
        timeout: this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT,
        ...(abortSignal ? { abortSignal } : {}),
      });
      this.logger.info('RGD accepted, waiting for CRD', { rgdName: this.rgdName });

      // Wait for the CRD to be created by Kro using DirectDeploymentEngine
      await this.waitForCRDReadyWithEngine(deploymentEngine, abortSignal);
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
          metadata: { name: this.rgdName },
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

  private async applyKroPrerequisites(
    deploymentEngine: DirectDeploymentEngine,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const prerequisites = this.factoryOptions.kroPrerequisites;
    if (!prerequisites?.resources?.length && !prerequisites?.beforeResourceGraphDefinition) {
      return;
    }

    const deployResource = this.kroPrerequisiteDeployResource(deploymentEngine, abortSignal);
    for (const resource of prerequisites.resources ?? []) {
      abortSignal?.throwIfAborted();
      await deployResource(resource);
    }
    await this.runKroPrerequisiteHook(deploymentEngine, deployResource, abortSignal);
  }

  private kroPrerequisiteDeployResource(
    deploymentEngine: DirectDeploymentEngine,
    abortSignal?: AbortSignal
  ): (
    resource: PrerequisiteResource,
    options?: { waitForReady?: boolean }
  ) => Promise<DeployedResource> {
    const timeout = this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT;
    return async (
      resource: PrerequisiteResource,
      options: { waitForReady?: boolean } = {}
    ): Promise<DeployedResource> => {
      abortSignal?.throwIfAborted();
      const deployable = this.normalizePrerequisiteResource(resource, {
        ensureReadiness: options.waitForReady ?? false,
      });
      const resourceToDeploy = options.waitForReady
        ? ensureReadinessEvaluator(deployable)
        : deployable;
      const deployed = await deploymentEngine.deployResource(resourceToDeploy, {
        mode: 'direct',
        namespace: this.namespace,
        waitForReady: options.waitForReady ?? false,
        timeout,
        ...(abortSignal ? { abortSignal } : {}),
      });

      const crdName = this.prerequisiteCRDName(resource);
      if (crdName) {
        await deploymentEngine.waitForCRDReady(crdName, timeout, abortSignal);
      }

      return deployed;
    };
  }

  private async runKroPrerequisiteHook(
    deploymentEngine: DirectDeploymentEngine,
    deployResource?: ReturnType<
      KroResourceFactoryImpl<TSpec, TStatus>['kroPrerequisiteDeployResource']
    >,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const hook = this.factoryOptions.kroPrerequisites?.beforeResourceGraphDefinition;
    if (!hook) return;
    abortSignal?.throwIfAborted();
    const timeout = this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT;
    const deploy =
      deployResource ?? this.kroPrerequisiteDeployResource(deploymentEngine, abortSignal);
    const context: KroPrerequisiteContext = {
      kubernetesApi: deploymentEngine.getKubernetesApi(),
      kubeConfig: this.getKubeConfig(),
      namespace: this.namespace,
      timeout,
      ...(abortSignal ? { abortSignal } : {}),
      deployResource: deploy,
      waitForCRDReady: (crdName, waitTimeout = timeout) =>
        deploymentEngine.waitForCRDReady(crdName, waitTimeout, abortSignal),
    };
    await hook(context);
  }

  private normalizePrerequisiteResource(
    resource: PrerequisiteResource,
    options: { ensureReadiness?: boolean; attachFallbackReadiness?: boolean } = {}
  ): DeployableK8sResource<Enhanced<unknown, unknown>> {
    const name = resource.metadata?.name ?? 'unnamed';
    const deployable = {
      ...resource,
      id: resource.id ?? `${resource.kind}-${name}`,
      metadata: {
        ...resource.metadata,
      },
    } as DeployableK8sResource<Enhanced<unknown, unknown>>;

    copyResourceMetadata(resource as object, deployable);
    delete (deployable as unknown as Record<string, unknown>).scope;

    const scope = this.prerequisiteScope(resource);
    if (scope === 'cluster') {
      setMetadataField(deployable, 'scope', 'cluster');
      delete (deployable.metadata as Record<string, unknown>).namespace;
    } else if (!deployable.metadata.namespace) {
      if (!this.canDefaultPrerequisiteNamespace(resource)) {
        throw new ValidationError(
          `KRO prerequisite ${resource.kind}/${name} must declare its scope or namespace. ` +
            "Set scope: 'cluster' for cluster-scoped prerequisites, " +
            "or set metadata.namespace / scope: 'namespaced' for namespaced raw prerequisites.",
          resource.kind,
          name,
          'metadata.namespace',
          [
            'Use a TypeKro factory resource that carries scope metadata.',
            "Set scope: 'cluster' on raw cluster-scoped prerequisites.",
            "Set metadata.namespace or scope: 'namespaced' on raw namespaced prerequisites.",
          ]
        );
      }
      deployable.metadata.namespace = this.namespace;
    }

    if (this.prerequisiteCRDName(resource) && !getReadinessEvaluator(deployable)) {
      setReadinessEvaluator(deployable, createCustomResourceDefinitionReadinessEvaluator());
    } else if (options.attachFallbackReadiness && !getReadinessEvaluator(deployable)) {
      setReadinessEvaluator(deployable, createAlwaysReadyEvaluator(resource.kind));
    }

    if (options.ensureReadiness) {
      return ensureReadinessEvaluator(deployable);
    }

    return deployable;
  }

  private prerequisiteResourceYamls(): string[] {
    const capture = this.factoryOptions.semanticCapture;
    if (capture) {
      const configuredPlan = this.factoryOptions.plan ?? {};
      const plan = capture.planTemplate({
        ...configuredPlan,
        aspects: configuredPlan.aspects ?? this.factoryOptions.aspects ?? [],
      });
      const artifacts = compileKroArtifactPlan(plan, {
        strict: true,
        rgdName: this.rgdName,
        ...this.prerequisiteArtifactCompilationInputs(),
        ...(this.factoryOptions.applyPolicy
          ? { outerApplyPolicy: this.factoryOptions.applyPolicy }
          : {}),
      });
      return kroArtifactPlanToSupportingResources(artifacts, {
        readinessEvaluators: this.prerequisiteRuntimeReadinessEvaluators(),
        resolveReadinessStrategy: resolvePortableReadinessStrategy,
      })
        .filter(({ artifact }) => artifact.role === 'kro-prerequisite')
        .map(({ resource }) =>
          yaml
            .dump(JSON.parse(JSON.stringify(resource)), {
              lineWidth: -1,
              noRefs: true,
              sortKeys: false,
            })
            .trimEnd()
        );
    }
    return (this.factoryOptions.kroPrerequisites?.resources ?? []).map((resource) =>
      yaml
        .dump(this.toSerializablePrerequisiteResource(resource), {
          lineWidth: -1,
          noRefs: true,
          sortKeys: false,
        })
        .trimEnd()
    );
  }

  private prerequisiteArtifactCompilationInputs(): {
    supportingArtifacts: KroSupportingArtifactCompilerInput[];
    outerEdges: PlanEdge[];
  } {
    const supportingArtifacts: KroSupportingArtifactCompilerInput[] = [];
    const outerEdges: PlanEdge[] = [];
    let previousId: string | undefined;
    for (const prerequisite of this.factoryOptions.kroPrerequisites?.resources ?? []) {
      const normalized = this.normalizePrerequisiteResource(prerequisite, {
        attachFallbackReadiness: true,
      });
      const id = normalized.id;
      const serialized = this.toSerializablePrerequisiteResource(prerequisite);
      const scope = getMetadataField(normalized, 'scope') === 'cluster' ? 'cluster' : 'namespaced';
      const namespace =
        scope === 'namespaced' && typeof normalized.metadata.namespace === 'string'
          ? lowerPlanValue(normalized.metadata.namespace).value
          : undefined;
      const evaluator = getReadinessEvaluator(normalized);
      const portableStrategy = evaluator ? getPortableReadinessStrategy(evaluator) : undefined;
      const runtimeBinding = `readiness:kro-prerequisite:${id}`;
      supportingArtifacts.push({
        id,
        role: 'kro-prerequisite',
        desired: lowerPlanValue(serialized).value,
        identity: {
          apiVersion: normalized.apiVersion,
          kind: normalized.kind,
          name: lowerPlanValue(normalized.metadata.name).value,
          ...(namespace ? { namespace } : {}),
          scope,
        },
        lifecycle: {
          creation: 'adopt',
          management: 'authoritative',
          deletion: 'delete',
          instancing: { kind: 'per-cluster' },
          sharing: 'exclusive',
        },
        readiness: {
          activation: [],
          readyWhen: [],
          ...(portableStrategy
            ? { strategy: portableStrategy }
            : evaluator
              ? {
                  strategy: {
                    kind: 'runtime-binding' as const,
                    binding: runtimeBinding,
                    version: 1 as const,
                  },
                }
              : {}),
        },
      });
      if (previousId) {
        outerEdges.push({ kind: 'existence', prerequisite: previousId, dependent: id });
      }
      previousId = id;
    }
    if (previousId) {
      outerEdges.push({
        kind: 'existence',
        prerequisite: previousId,
        dependent: '__typekro_rgd__',
      });
    }
    return { supportingArtifacts, outerEdges };
  }

  private outerArtifactCompilationInputs(spec?: TSpec): {
    supportingArtifacts: KroSupportingArtifactCompilerInput[];
    outerEdges: PlanEdge[];
  } {
    const prerequisiteInputs = this.prerequisiteArtifactCompilationInputs();
    if (spec === undefined) return prerequisiteInputs;

    const supportingArtifacts = [...prerequisiteInputs.supportingArtifacts];
    const outerEdges = [...prerequisiteInputs.outerEdges];
    const lastPrerequisite = prerequisiteInputs.supportingArtifacts.at(-1)?.id;
    for (const [name, original] of this.concreteHoistedNamespaces(spec)) {
      const id = KroResourceFactoryImpl.hoistedNamespaceId(name);
      const manifest = this.hoistedNamespaceManifest(name, original, spec);
      supportingArtifacts.push({
        id,
        role: 'hoisted-namespace',
        desired: lowerPlanValue(manifest).value,
        identity: {
          apiVersion: 'v1',
          kind: 'Namespace',
          name: lowerPlanValue(name).value,
          scope: 'cluster',
        },
        lifecycle: {
          creation: 'adopt',
          management: 'authoritative',
          deletion: 'delete-when-unused',
          instancing: { kind: 'per-scope', key: lowerPlanValue(name).value },
          sharing: 'shareable',
          unusedEvidence: {
            provider: 'typekro.hoisted-namespace-empty-owned',
            version: 1,
            inputs: lowerPlanValue({
              rgdName: this.rgdName,
              group: this.getSchemaGroup(),
              version: this.getSchemaVersion(),
              kind: this.schemaDefinition.kind,
            }).value,
          },
        },
        apply: {
          strategy: 'server-side-apply',
          fieldManager: 'typekro',
          fieldConflictPolicy: 'force-owned-fields',
          immutableFieldPolicy: 'fail',
        },
      });
      if (lastPrerequisite) {
        outerEdges.push({
          kind: 'existence',
          prerequisite: lastPrerequisite,
          dependent: id,
        });
      }
      outerEdges.push({
        kind: 'existence',
        prerequisite: id,
        dependent: '__typekro_rgd__',
      });
    }
    return { supportingArtifacts, outerEdges };
  }

  private materializedHoistedNamespaces(spec: TSpec): Map<string, MaterializedHoistedNamespace> {
    const capture = this.factoryOptions.semanticCapture;
    if (!capture) {
      return new Map(
        [...this.concreteHoistedNamespaces(spec)].map(([name, original]) => [
          name,
          { resource: this.hoistedNamespaceManifest(name, original, spec) },
        ])
      );
    }
    const configuredPlan = this.factoryOptions.plan ?? {};
    const plan = capture.planTemplate({
      ...configuredPlan,
      aspects: configuredPlan.aspects ?? this.factoryOptions.aspects ?? [],
    });
    const artifacts = compileKroArtifactPlan(plan, {
      strict: true,
      rgdName: this.rgdName,
      ...this.outerArtifactCompilationInputs(spec),
      ...(this.factoryOptions.applyPolicy
        ? { outerApplyPolicy: this.factoryOptions.applyPolicy }
        : {}),
    });
    return new Map(
      kroArtifactPlanToSupportingResources(artifacts, {
        readinessEvaluators: this.prerequisiteRuntimeReadinessEvaluators(),
        resolveReadinessStrategy: resolvePortableReadinessStrategy,
      })
        .filter(({ artifact }) => artifact.role === 'hoisted-namespace')
        .map(
          ({ artifact, resource }) =>
            [String(resource.metadata.name), { artifact, resource }] as const
        )
    );
  }

  private materializedSingletonOwnerInstances(spec: TSpec): KubernetesResource[] {
    const capture = this.factoryOptions.semanticCapture;
    if (!capture) {
      return singletonOwnerInstanceManifests(
        this.discoverSingletonDefinitions(spec)
      ) as KubernetesResource[];
    }
    const configuredPlan = this.factoryOptions.plan ?? {};
    const plan = capture.planTemplate({
      ...configuredPlan,
      aspects: configuredPlan.aspects ?? this.factoryOptions.aspects ?? [],
    });
    const artifacts = compileKroArtifactPlan(plan, {
      strict: true,
      rgdName: this.rgdName,
      ...this.outerArtifactCompilationInputs(spec),
      ...(this.factoryOptions.applyPolicy
        ? { outerApplyPolicy: this.factoryOptions.applyPolicy }
        : {}),
    });
    return kroArtifactPlanToSupportingResources(artifacts, {
      readinessEvaluators: this.prerequisiteRuntimeReadinessEvaluators(),
      resolveReadinessStrategy: resolvePortableReadinessStrategy,
    })
      .filter(({ artifact }) => artifact.role === 'singleton-owner')
      .map(({ resource }) => resource);
  }

  private prerequisiteRuntimeReadinessEvaluators(): Readonly<
    Record<string, NonNullable<ReturnType<typeof getReadinessEvaluator>>>
  > {
    const bindings: Record<string, NonNullable<ReturnType<typeof getReadinessEvaluator>>> = {};
    for (const prerequisite of this.factoryOptions.kroPrerequisites?.resources ?? []) {
      const normalized = this.normalizePrerequisiteResource(prerequisite, {
        attachFallbackReadiness: true,
      });
      const evaluator = getReadinessEvaluator(normalized);
      if (evaluator && !getPortableReadinessStrategy(evaluator)) {
        bindings[`readiness:kro-prerequisite:${normalized.id}`] = evaluator;
      }
    }
    return bindings;
  }

  private toSerializablePrerequisiteResource(
    resource: PrerequisiteResource
  ): Record<string, unknown> {
    const normalized = this.normalizePrerequisiteResource(resource);
    const toJSON = normalized.toJSON;
    const jsonResource = typeof toJSON === 'function' ? toJSON.call(normalized) : normalized;
    const serialized = JSON.parse(JSON.stringify(jsonResource)) as Record<string, unknown>;
    delete serialized.id;
    delete serialized.scope;
    return serialized;
  }

  private prerequisiteAlchemyDeclarations(
    kubeConfigOptions: SerializableKubeConfigOptions
  ): AlchemyResourceDeclaration[] {
    const timeout = this.factoryOptions.timeout;
    const capture = this.factoryOptions.semanticCapture;
    if (capture) {
      const configuredPlan = this.factoryOptions.plan ?? {};
      const plan = capture.planTemplate({
        ...configuredPlan,
        aspects: configuredPlan.aspects ?? this.factoryOptions.aspects ?? [],
      });
      const artifacts = compileKroArtifactPlan(plan, {
        strict: true,
        rgdName: this.rgdName,
        ...this.prerequisiteArtifactCompilationInputs(),
        ...(this.factoryOptions.applyPolicy
          ? { outerApplyPolicy: this.factoryOptions.applyPolicy }
          : {}),
      });
      const materialized = kroArtifactPlanToSupportingResources(artifacts, {
        readinessEvaluators: this.prerequisiteRuntimeReadinessEvaluators(),
        resolveReadinessStrategy: resolvePortableReadinessStrategy,
      }).filter(({ artifact }) => artifact.role === 'kro-prerequisite');
      const declarationIdByArtifactId = new Map(
        materialized.map(({ artifact, resource }) => {
          const namespaceForId =
            artifact.identity?.scope === 'cluster' ? undefined : this.namespace;
          return [artifact.id, createAlchemyResourceId(resource, namespaceForId)] as const;
        })
      );
      return materialized.map(({ artifact, resource }) => {
        const declarationId = declarationIdByArtifactId.get(artifact.id);
        if (!declarationId) {
          throw new TypeKroError(
            `KRO prerequisite ${artifact.id} has no Alchemy declaration identity.`,
            'KRO_ALCHEMY_DECLARATION_MISSING',
            { artifactId: artifact.id }
          );
        }
        const dependsOn = artifacts.edges.flatMap((edge) => {
          if (
            (edge.kind !== 'existence' && edge.kind !== 'ready') ||
            edge.dependent !== artifact.id
          ) {
            return [];
          }
          const dependencyId = declarationIdByArtifactId.get(edge.prerequisite);
          return dependencyId ? [dependencyId] : [];
        });
        return {
          id: declarationId,
          dependsOn,
          props: {
            resource: resource as Enhanced<unknown, unknown>,
            resourceId: artifact.id,
            namespace: this.namespace,
            deploymentStrategy: 'direct' as const,
            kubeConfigOptions,
            options: {
              waitForReady:
                resource.apiVersion === 'apiextensions.k8s.io/v1' &&
                resource.kind === 'CustomResourceDefinition',
              ...(timeout !== undefined && { timeout }),
            },
          },
        };
      });
    }
    const declarations: AlchemyResourceDeclaration[] = [];
    for (const resource of this.factoryOptions.kroPrerequisites?.resources ?? []) {
      const normalized = this.normalizePrerequisiteResource(resource, {
        attachFallbackReadiness: true,
      });
      const namespaceForId =
        getMetadataField(normalized, 'scope') === 'cluster' ? undefined : this.namespace;
      const previousDeclaration = declarations.at(-1);
      declarations.push({
        id: createAlchemyResourceId(normalized, namespaceForId),
        dependsOn: previousDeclaration ? [previousDeclaration.id] : [],
        props: {
          resource: normalized,
          resourceId: normalized.id,
          namespace: this.namespace,
          deploymentStrategy: 'direct' as const,
          kubeConfigOptions,
          options: {
            waitForReady: this.prerequisiteCRDName(resource) !== undefined,
            ...(timeout !== undefined && { timeout }),
          },
        },
      });
    }
    return declarations;
  }

  private assertNoKroPrerequisiteHookForDeclarative(apiName: string): void {
    const prerequisites = this.factoryOptions.kroPrerequisites;
    if (!prerequisites?.beforeResourceGraphDefinition) {
      return;
    }

    throw new TypeKroError(
      `${apiName} does not support kroPrerequisites.beforeResourceGraphDefinition. ` +
        'Prerequisite hooks are deploy-only because they require a live cluster; use kroPrerequisites.resources for declarative prerequisite resources.',
      'KRO_PREREQUISITES_DEPLOY_ONLY',
      { factoryName: this.name, apiName }
    );
  }

  private prerequisiteCRDName(resource: KubernetesResource): string | undefined {
    if (
      resource.apiVersion !== 'apiextensions.k8s.io/v1' ||
      resource.kind !== 'CustomResourceDefinition'
    ) {
      return undefined;
    }
    return resource.metadata?.name;
  }

  private prerequisiteScope(resource: PrerequisiteResource): 'cluster' | 'namespaced' | undefined {
    return getResourceScope(resource as object & PrerequisiteResource);
  }

  private canDefaultPrerequisiteNamespace(resource: PrerequisiteResource): boolean {
    if (Reflect.get(resource as object, 'scope') === 'namespaced') return true;
    return (
      this.prerequisiteScope(resource) === 'namespaced' &&
      getMetadataField(resource as object, 'scopeProvenance') === 'explicit'
    );
  }

  /**
   * Wait for the CRD to be created by Kro using DirectDeploymentEngine.
   *
   * Discovers the CRD by (kind, group=kro.run) via the CRD list API
   * rather than pre-computing a plural form. KRO's server-side pluralization
   * is authoritative, and client-side heuristics cannot handle all cases
   * (e.g., already-plural kind names that shouldn't get an extra "s").
   */
  private async waitForCRDReadyWithEngine(
    deploymentEngine: DirectDeploymentEngine,
    abortSignal?: AbortSignal
  ): Promise<void> {
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
      this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT,
      abortSignal
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
    const { resourceIds } = createStatusResourceIdentityContext(this.resources);
    return separateStatusFields(this.statusMappings, this.getNestedStatusCel(), resourceIds);
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
      evaluatedFields[fieldName] = await this.evaluateStaticFieldValue(fieldValue, spec, fieldName);
    }

    return evaluatedFields;
  }

  private async evaluateStaticFieldValue(
    fieldValue: unknown,
    spec: TSpec,
    fieldName: string
  ): Promise<unknown> {
    if (this.isCelExpression(fieldValue)) {
      try {
        // Evaluate CEL expressions that contain only schema references
        return this.evaluateStaticCelExpression(fieldValue, spec);
      } catch (error: unknown) {
        this.logger.warn('Failed to evaluate static CEL expression', {
          field: fieldName,
          expression: fieldValue.expression,
          error: ensureError(error).message,
        });
        // Fallback to the original value
        return fieldValue;
      }
    }

    if (isKubernetesRef(fieldValue)) {
      if (fieldValue.resourceId === '__schema__') {
        return this.resolveSchemaRefValue(fieldValue.fieldPath, spec);
      }
      return fieldValue;
    }

    if (typeof fieldValue === 'string' && fieldValue.includes('__KUBERNETES_REF___schema___')) {
      // Resolve __KUBERNETES_REF_ marker strings from template literal coercion.
      // When the composition function uses template literals like `${spec.name}-suffix`,
      // the proxy's Symbol.toPrimitive produces marker strings at runtime. These need
      // to be resolved to actual spec values at deploy time.
      return this.resolveSchemaRefMarkers(fieldValue, spec);
    }

    if (typeof fieldValue === 'string' && fieldValue.startsWith('${') && fieldValue.endsWith('}')) {
      // Evaluate inline CEL expression strings produced by the composition AST analyzer.
      // statusOverrides from analyzeCompositionBody write ternary/conditional expressions
      // as plain strings like "${schema.spec.enabled ? 2 : 1}" into statusMappings.
      // These must be evaluated with actual spec values at deploy time.
      try {
        return this.evaluateInlineCelString(fieldValue, spec);
      } catch (error: unknown) {
        this.logger.warn('Failed to evaluate inline CEL expression string', {
          field: fieldName,
          expression: fieldValue,
          error: ensureError(error).message,
        });
        return fieldValue;
      }
    }

    if (Array.isArray(fieldValue)) {
      return Promise.all(
        fieldValue.map((item, index) =>
          this.evaluateStaticFieldValue(item, spec, `${fieldName}[${index}]`)
        )
      );
    }

    if (typeof fieldValue === 'object' && fieldValue !== null) {
      // Recursively evaluate nested objects
      return this.evaluateStaticFields(fieldValue as Record<string, unknown>, spec);
    }

    // Keep non-CEL values as-is
    return fieldValue;
  }

  private resolveSchemaRefValue(fieldPath: string, spec: TSpec): unknown {
    const parts = fieldPath.replace(/^spec\./, '').split('.');
    let current: unknown = spec;

    for (const part of parts) {
      if (current != null && typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
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

    try {
      return evaluateSchemaCelExpression(celExpression, spec);
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
        expression: this.prepareStaticExpressionForEvaluation(expression),
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

    // Build scope expression: translate KRO helpers and strip schema.spec. / spec. prefixes
    let scopeExpression = this.prepareStaticExpressionForEvaluation(innerExpression);

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

    const specRecord = this.createStaticEvaluationScope(spec);
    const evaluator = compileExpression(scopeExpression);
    return evaluator(specRecord) as unknown;
  }

  /**
   * Translate the small KRO/CEL helper subset that can appear in static schema-only
   * expressions into functions that angular-expressions can safely evaluate.
   */
  private prepareStaticExpressionForEvaluation(expression: string): string {
    let scopeExpression = expression;
    const schemaPath = '[a-zA-Z_$][\\w$]*(?:\\.[a-zA-Z_$][\\w$]*)*';

    scopeExpression = scopeExpression.replace(
      new RegExp(`\\bhas\\((?:schema\\.)?spec\\.(${schemaPath})\\)`, 'g'),
      '__has("$1")'
    );

    scopeExpression = scopeExpression.replace(
      new RegExp(`\\b(?:schema\\.)?spec\\.(${schemaPath})\\.orValue\\(([^()]*)\\)`, 'g'),
      '__orValue($1, $2)'
    );

    scopeExpression = scopeExpression.replace(/\bstring\(/g, '__string(');

    // Replace schema.spec.fieldName → fieldName (resolved from scope)
    scopeExpression = scopeExpression.replace(/schema\.spec\.(\w+)/g, '$1');

    // Replace spec.fieldName → fieldName (resolved from scope)
    scopeExpression = scopeExpression.replace(/\bspec\.(\w+)/g, '$1');

    return scopeExpression;
  }

  private createStaticEvaluationScope(spec: TSpec): Record<string, unknown> {
    // Use null-prototype object to prevent prototype chain access (defense-in-depth).
    // angular-expressions has hasOwnProperty guards, but a null-prototype scope
    // eliminates any residual risk from constructor/toString/__proto__ leaking.
    // Object.freeze prevents expression-based mutation of the original spec data.
    return Object.freeze(
      Object.assign(Object.create(null) as Record<string, unknown>, spec, {
        __has: (path: string) => this.hasSchemaValue(path, spec),
        __orValue: (value: unknown, defaultValue: unknown) => value ?? defaultValue,
        __string: (value: unknown) => String(value ?? ''),
        omit: () => undefined,
      })
    );
  }

  private hasSchemaValue(fieldPath: string, spec: TSpec): boolean {
    const parts = fieldPath.replace(/^spec\./, '').split('.');
    let current: unknown = spec;

    for (const part of parts) {
      if (current == null || typeof current !== 'object') {
        return false;
      }
      if (!Object.hasOwn(current, part)) {
        return false;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current !== undefined;
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
  private instanceManifestMetadata(
    spec: TSpec,
    singletonSpecFingerprint?: string
  ): {
    labels: Record<string, string>;
    annotations: Record<string, string>;
  } {
    const hoistedNamespaceNames = [...this.concreteHoistedNamespaces(spec).keys()];
    return {
      labels: {
        'typekro.io/factory': this.name,
        'typekro.io/mode': this.mode,
        [INSTANCE_RGD_LABEL]: this.rgdName,
      },
      annotations: {
        ...(singletonSpecFingerprint
          ? { 'typekro.io/singleton-spec-fingerprint': singletonSpecFingerprint }
          : {}),
        [HOISTED_NAMESPACES_ANNOTATION]: JSON.stringify(hoistedNamespaceNames),
      },
    };
  }

  private createCustomResourceInstance(
    instanceName: string,
    spec: TSpec,
    singletonSpecFingerprint?: string
  ): {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace: string;
      labels: Record<string, string>;
      annotations?: Record<string, string>;
    };
    spec: TSpec;
  } {
    const apiVersion = this.getInstanceApiVersion();

    // DURABLE RECORD (finding #4): stamp the CONCRETE hoisted-namespace names on the CR so
    // teardown + the pre-hoist guard read them back EXACTLY, without re-deriving from
    // metadata.namespace/spec.namespace. This is what lets a name derived from an ARBITRARY
    // spec field (e.g. spec.targetNamespace) round-trip. ALWAYS record the array — INCLUDING an
    // empty [] — so the pre-hoist guard can distinguish "this instance hoists zero namespaces"
    // (a valid, safe record) from a genuinely-legacy CR that predates the annotation (missing →
    // fail closed). Omitting [] made an ordinary namespace-less composition's 2nd deploy throw.
    const { labels, annotations } = this.instanceManifestMetadata(spec, singletonSpecFingerprint);
    const legacyManifest = {
      apiVersion,
      kind: this.schemaDefinition.kind,
      metadata: {
        name: instanceName,
        namespace: this.resolveInstanceNamespace(spec),
        labels,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      },
      spec,
    };

    const compilation = this.compiledKroArtifactPlan(spec, {
      instanceNameOverride: instanceName,
      ...(singletonSpecFingerprint ? { singletonSpecFingerprint } : {}),
    });
    if (!compilation) {
      return {
        ...legacyManifest,
        spec: {
          ...(spec as Record<string, unknown>),
          [KRO_ARTIFACT_BINDINGS_SPEC_FIELD]: {},
        } as TSpec,
      };
    }
    return kroArtifactPlanToInstanceResource(compilation.artifacts, {
      sensitive: compilation.sensitiveBindings,
    }) as {
      apiVersion: string;
      kind: string;
      metadata: {
        name: string;
        namespace: string;
        labels: Record<string, string>;
        annotations?: Record<string, string>;
      };
      spec: TSpec;
    };
  }

  /**
   * Labels/annotations marking a hoisted workload Namespace as SHARED, RETAINED
   * infrastructure that must survive any single consumer's teardown/prune.
   *
   * Retention is declared for BOTH major GitOps reconcilers, not just Flux, so a
   * prune (or an Application deletion) by whichever tool manages a consuming app
   * can never delete this shared namespace (and with it every OTHER stack's
   * resources living inside it):
   *   - `kustomize.toolkit.fluxcd.io/prune: disabled` — Flux Kustomize.
   *   - `argocd.argoproj.io/sync-options: Prune=false,Delete=false` — Argo CD.
   *     `Delete=false` is what survives an Argo Application DELETION, not merely a
   *     sync-prune (`Prune=false` alone does NOT).
   * The alchemy path pairs these with a `retain` prop (see
   * {@link hoistedNamespaceAlchemyDeclaration}) that skips delete. For any other
   * GitOps tool, pre-create the workload namespace out-of-band.
   */
  private static readonly INSTANCE_NAMESPACE_METADATA = {
    labels: {
      'app.kubernetes.io/managed-by': 'typekro',
      'typekro.io/kro-instance-namespace': 'true',
    },
    annotations: {
      'kustomize.toolkit.fluxcd.io/prune': 'disabled',
      'argocd.argoproj.io/sync-options': 'Prune=false,Delete=false',
    },
  } as const;

  /**
   * The collision-free singleton id for a hoisted workload Namespace, deduped by
   * the namespace NAME (finding #7). {@link toCamelCase} alone destroys separators
   * (`foo-bar` and `foo--bar` both camel-case to `fooBar`), so two DISTINCT
   * namespaces would collapse to one id — silently deduping unrelated namespaces
   * into a single retained resource. Appending a stable hash of the RAW name keeps
   * distinct names distinct while staying deterministic (same name → same id, so
   * the intended cross-factory dedup still holds).
   */
  private static hoistedNamespaceId(workloadNamespace: string): string {
    return `${toCamelCase(`kro-instance-namespace-${workloadNamespace}`)}${shortStableHash(workloadNamespace)}`;
  }

  /**
   * Resolve a single Namespace metadata VALUE (a label/annotation value) against
   * the concrete spec to its final string form (finding #8). Handles:
   *   - plain strings (kept verbatim),
   *   - numbers / booleans (stringified — a "non-string" declared value),
   *   - schema-derived CEL expressions / KubernetesRefs (resolved to the concrete
   *     value; re-execution already collapsed the schema ref, but this evaluates
   *     it against the spec for robustness).
   * Returns `undefined` for a value that cannot be resolved to a string, so the
   * caller drops only genuinely-unresolvable entries rather than the whole class of
   * non-string / schema-derived metadata (the old string-only filter dropped them).
   */
  private static resolveMetadataStringValue(
    value: unknown,
    spec: KroCompatibleType
  ): string | undefined {
    // Metadata VALUES are unrestricted strings (finding #5): `Team_A`, free text with
    // spaces, etc. — resolve any CONCRETE value, without the DNS-label shape
    // restriction that `resolveNamespaceName` correctly applies to namespace NAMES.
    return resolveConcreteMetadataValue(value, spec);
  }

  /**
   * Merge the SHARED/RETAINED marker labels + annotations onto an ORIGINAL,
   * fully-concrete Namespace resource, PRESERVING the COMPLETE declared config
   * (findings #6 + #8): ALL labels — including Pod Security (`pod-security.kubernetes.io/*`)
   * AND non-string / schema-derived labels resolved against the spec — ALL
   * annotations, the remaining declarative ObjectMeta (`finalizers`,
   * `ownerReferences`), AND the Namespace `spec` (e.g. `spec.finalizers`). The
   * retention markers are added on top.
   */
  private static mergedHoistedNamespaceMetadata(
    workloadNamespace: string,
    original: KubernetesResource,
    spec: KroCompatibleType
  ): {
    name: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    finalizers?: string[];
    ownerReferences?: unknown[];
    spec?: unknown;
  } {
    const originalMeta = (original.metadata ?? {}) as {
      labels?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
      finalizers?: unknown;
      ownerReferences?: unknown;
    };
    const resolveMap = (value: Record<string, unknown> | undefined): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [key, val] of Object.entries(value ?? {})) {
        const resolved = KroResourceFactoryImpl.resolveMetadataStringValue(val, spec);
        if (resolved !== undefined) out[key] = resolved;
      }
      return out;
    };
    // `original` is an Enhanced PROXY: reading an UNDECLARED field returns a
    // KubernetesRef marker (a truthy function-like proxy), NOT undefined. Passing
    // such a proxy through to the k8s client serializer makes it try to iterate a
    // `{}`-looking value for an array-typed attribute (e.g. `spec.finalizers`) and
    // throw "{} is not iterable". So extract only the CONCRETE, own-enumerable
    // declared values via a JSON round-trip (drops proxies, ref-markers, symbols,
    // functions) and omit anything empty.
    const concretize = <T>(value: unknown): T | undefined => {
      if (value === undefined || value === null) return undefined;
      try {
        const cloned = JSON.parse(JSON.stringify(value)) as T;
        return cloned;
      } catch {
        return undefined;
      }
    };
    const concreteSpecRaw = concretize<Record<string, unknown>>(
      (original as { spec?: unknown }).spec
    );
    // Only keep a spec that actually declares something (an empty proxy spec must
    // NOT be emitted — that is the "{} is not iterable" trap).
    const originalSpec =
      concreteSpecRaw !== undefined && Object.keys(concreteSpecRaw).length > 0
        ? concreteSpecRaw
        : undefined;
    // Preserve the remaining declarative ObjectMeta the user may have set on the
    // owned Namespace (finding #6): metadata.finalizers + metadata.ownerReferences.
    // Server-set fields (uid/resourceVersion/managedFields/…) are intentionally not
    // carried — only declared configuration is retained. Array.isArray guards against
    // the proxy's ref-markers for undeclared fields (which are functions, not arrays).
    const finalizers = Array.isArray(originalMeta.finalizers)
      ? (concretize<string[]>(originalMeta.finalizers) ?? []).map((f) => String(f))
      : undefined;
    const ownerReferences = Array.isArray(originalMeta.ownerReferences)
      ? concretize<unknown[]>(originalMeta.ownerReferences)
      : undefined;
    return {
      name: workloadNamespace,
      labels: {
        ...resolveMap(originalMeta.labels),
        ...KroResourceFactoryImpl.INSTANCE_NAMESPACE_METADATA.labels,
      },
      annotations: {
        ...resolveMap(originalMeta.annotations),
        ...KroResourceFactoryImpl.INSTANCE_NAMESPACE_METADATA.annotations,
      },
      ...(finalizers !== undefined && finalizers.length > 0 ? { finalizers } : {}),
      ...(ownerReferences !== undefined && ownerReferences.length > 0 ? { ownerReferences } : {}),
      ...(originalSpec !== undefined && originalSpec !== null ? { spec: originalSpec } : {}),
    };
  }

  /** Host-neutral desired state for one hoisted Namespace. */
  private hoistedNamespaceManifest(
    workloadNamespace: string,
    original: KubernetesResource,
    spec: TSpec
  ): KubernetesResource {
    const merged = KroResourceFactoryImpl.mergedHoistedNamespaceMetadata(
      workloadNamespace,
      original,
      spec as KroCompatibleType
    );
    return {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: merged.name,
        labels: merged.labels,
        annotations: merged.annotations,
        ...(merged.finalizers !== undefined ? { finalizers: merged.finalizers } : {}),
        ...(merged.ownerReferences !== undefined
          ? {
              ownerReferences:
                merged.ownerReferences as import('@kubernetes/client-node').V1OwnerReference[],
            }
          : {}),
      },
      ...(merged.spec !== undefined ? { spec: merged.spec } : {}),
    };
  }

  private hoistedNamespaceAlchemyDeclaration(
    workloadNamespace: string,
    nsResource: KubernetesResource,
    artifact: KroSupportingArtifact | undefined,
    kubeConfigOptions: SerializableKubeConfigOptions,
    dependsOn: readonly string[]
  ): AlchemyResourceDeclaration {
    const timeout = this.factoryOptions.timeout;
    const resourceId = artifact?.id ?? (nsResource as { id?: string }).id;
    const evidence = artifact?.lifecycle.unusedEvidence;
    if (
      artifact &&
      (artifact.lifecycle.creation !== 'adopt' ||
        artifact.lifecycle.deletion !== 'delete-when-unused' ||
        evidence?.provider !== 'typekro.hoisted-namespace-empty-owned')
    ) {
      throw new TypeKroError(
        `Hoisted Namespace artifact ${artifact.id} has an unsupported lifecycle contract.`,
        'INVALID_ARTIFACT_LIFECYCLE',
        { artifactId: artifact.id }
      );
    }
    const evidenceInputs = evidence
      ? (materializePlanValue(evidence.inputs) as Record<string, unknown>)
      : undefined;
    return {
      // Collision-free (finding #7) and cluster-scoped (no namespace segment):
      // distinct workload namespaces → distinct ids; same name → same id (dedup).
      id: KroResourceFactoryImpl.hoistedNamespaceId(workloadNamespace),
      dependsOn,
      props: {
        resource: nsResource as Enhanced<unknown, unknown>,
        ...(resourceId !== undefined ? { resourceId } : {}),
        namespace: workloadNamespace,
        deploymentStrategy: 'direct' as const,
        // EMPTY-GATED teardown (findings #3 + #4), replacing the old retain-by-name
        // distinction: on delete, the namespace is removed ONLY if empty and RETAINED
        // if another stack/user still has resources inside it. Alchemy's reverse-topo
        // teardown runs this AFTER the RGD + instance (both `dependsOn` this
        // declaration) are gone — the load-bearing delete-after-RGD ordering (a
        // namespace deleted while the CR is still inside it re-creates the finalizer
        // deadlock).
        namespaceEmptyGate:
          artifact?.lifecycle.deletion === 'delete-when-unused' || artifact === undefined,
        // Ownership record for the empty-gated delete (finding #4): only a namespace
        // carrying this RGD's `created-by-rgd` annotation is a candidate.
        namespaceOwnerRgd: String(evidenceInputs?.rgdName ?? this.rgdName),
        // CRD coordinates so the alchemy pre-hoist check enumerates EVERY existing
        // instance of this shared RGD (finding #7), not just the incoming namespace.
        namespacePreHoistQuery: {
          group: String(evidenceInputs?.group ?? this.getSchemaGroup()),
          version: String(evidenceInputs?.version ?? this.getSchemaVersion()),
          kind: String(evidenceInputs?.kind ?? this.schemaDefinition.kind),
        },
        kubeConfigOptions,
        options: {
          waitForReady: false,
          ...(timeout !== undefined && { timeout }),
        },
      },
    };
  }

  private assertInstanceNamespaceOwnershipSafe(spec: TSpec): void {
    const compositionFn = this.factoryOptions.compositionFn as
      | ((spec: TSpec) => unknown)
      | undefined;
    assertKroInstanceNamespaceOwnershipSafe({
      compositionName: this.name,
      instanceNamespace: this.resolveInstanceNamespace(spec),
      spec,
      resources: this.resources,
      // The owned workload namespace is hoisted out of the graph (created retained,
      // deps-first), so the guard treats it as safe. Everything not hoisted — an
      // unprovable owned name, or an EXPLICIT `instanceNamespace` pin back onto an
      // owned namespace — still throws.
      hoistedNamespaces: this.hoistedNamespaceNames(spec),
      ...(compositionFn ? { compositionFn } : {}),
    });
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

    // Start with evaluated static fields plus dynamic placeholders so local
    // direct-mode access preserves nested status object shape before Kro hydrates it.
    const status: TStatus = deepMergeStatusPlaceholders(
      evaluatedStaticFields,
      dynamicFields
    ) as TStatus;

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
        namespace: this.resolveInstanceNamespace(spec),
        labels: {
          'typekro.io/factory': this.name,
          'typekro.io/mode': this.mode,
          [INSTANCE_RGD_LABEL]: this.rgdName,
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
          dynamicFields,
          this.resolveInstanceNamespace(spec)
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
            // A key ENTIRELY absent from dynamicFields never touched KRO at
            // all — live re-execution (the actual deployed spec plus real
            // cluster reads) is strictly more authoritative than the
            // pre-deploy static evaluation, so it unconditionally overrides,
            // even when the live value is falsy/empty.
            if (!(key in dynamicFields)) {
              (enhancedProxy.status as Record<string, unknown>)[key] = value;
              continue;
            }

            // `dynamicFields`/`evaluatedStaticFields` are classified per LEAF
            // (see `separateNestedObject`), so a key CAN be in dynamicFields
            // while still holding a MIXED object — e.g.
            // `app: { host: <CEL>, appPort: 3000 }` has one dynamic leaf
            // (`host`, KRO-owned) and one static leaf (`appPort`, never sent
            // to KRO). Only checking the top-level key here treated the
            // whole object as "belongs to KRO, don't touch" and discarded
            // the static leaves the live re-execution correctly computed.
            // Recurse so each leaf is filled from the most accurate source:
            // the already-merged current value if present (dynamic leaves
            // must never be overwritten by a client-side re-execution),
            // live re-execution only to fill a genuine gap.
            const current = (enhancedProxy.status as Record<string, unknown>)[key];
            (enhancedProxy.status as Record<string, unknown>)[key] =
              fillStatusGapsFromLiveReExecution(current, value);
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
    const { synthesizeNestedCompositionStatus } = await import('./nested-composition-status.js');

    // Build a live status map from deployed resources
    const liveStatusMap = new Map<string, Record<string, unknown>>();
    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    const resourceEntries = Object.entries(this.resources);
    const results = await Promise.allSettled(
      resourceEntries.map(async ([resourceId, resource]) => {
        const name = this.resolveLiveResourceIdentityValue(
          resource.metadata?.name,
          spec,
          resourceId
        );
        const ns = this.resolveLiveResourceIdentityValue(
          resource.metadata?.namespace,
          spec,
          this.namespace
        );

        const isClusterScoped = getMetadataField(resource, 'scope') === 'cluster';
        const live = await k8sApi.read({
          apiVersion: resource.apiVersion || '',
          kind: resource.kind || '',
          metadata: { name, ...(isClusterScoped ? {} : { namespace: ns }) },
        });

        if (live && typeof live === 'object' && 'status' in live) {
          return {
            resourceId,
            status: (live as Record<string, unknown>).status as Record<string, unknown>,
          };
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

    const result = runWithCompositionContext(reExecutionContext, () => compositionFn(spec));
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

    return resolved === '' || resolved.includes('__KUBERNETES_REF_') || resolved.includes('${')
      ? fallback
      : resolved;
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
  private async waitForKroInstanceReady(
    instanceName: string,
    timeout: number,
    instanceNamespace = this.resolveInstanceNamespace(),
    abortSignal?: AbortSignal
  ): Promise<void> {
    const apiVersion = this.getInstanceApiVersion();

    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    return waitForKroInstanceReadyShared({
      instanceName,
      timeout,
      k8sApi,
      customObjectsApi: this.getCustomObjectsApi(),
      namespace: instanceNamespace,
      apiVersion,
      kind: this.schemaDefinition.kind,
      rgdName: this.rgdName,
      factoryContext: this.name,
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  /**
   * Hydrate dynamic status fields by evaluating CEL expressions against live Kro resource data
   */
  private async hydrateDynamicStatusFields(
    instanceName: string,
    dynamicFields: Record<string, unknown>,
    instanceNamespace = this.resolveInstanceNamespace()
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
        namespace: instanceNamespace,
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

// ── Module-level helpers ─────────────────────────────────────────────────

/**
 * Recursively fill gaps in the already-merged (static + KRO-hydrated)
 * status with values from re-executing the composition against live
 * cluster data.
 *
 * `current` (the already-merged static/dynamic status) wins for any leaf
 * that already has a value — dynamic leaves are owned by the live KRO
 * instance and must not be overwritten by a client-side re-execution.
 * `live` only fills a leaf that is genuinely empty (undefined/null/''),
 * which happens for static leaves that live inside an otherwise-dynamic
 * object (KRO never sees them, so nothing upstream ever populated them).
 *
 * Recursing into plain objects — instead of only checking the top-level
 * status key — matters because a single top-level key can be a MIXED
 * object with both dynamic and static leaves (e.g.
 * `app: { host: <CEL, KRO-owned>, appPort: 3000 }`); treating the whole
 * key as "belongs to KRO" would discard the static leaves entirely.
 */
export function fillStatusGapsFromLiveReExecution(current: unknown, live: unknown): unknown {
  if (current === undefined || current === null || current === '') {
    return live;
  }
  if (
    current !== null &&
    live !== null &&
    typeof current === 'object' &&
    typeof live === 'object' &&
    !Array.isArray(current) &&
    !Array.isArray(live)
  ) {
    const currentObj = current as Record<string, unknown>;
    const liveObj = live as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...currentObj };
    for (const key of Object.keys(liveObj)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      merged[key] = fillStatusGapsFromLiveReExecution(currentObj[key], liveObj[key]);
    }
    return merged;
  }
  return current;
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
