import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { createCompositionContext, runWithCompositionContext } from '../composition/context.js';
import { KUBERNETES_REF_SCHEMA_MARKER_SOURCE } from '../constants/brands.js';
import { TypeKroError } from '../errors.js';
import { getIncludeWhen } from '../metadata/index.js';
import type { SingletonDefinitionRecord } from '../types/deployment.js';
import type { KubernetesResource } from '../types/kubernetes.js';
import type { KroCompatibleType } from '../types/serialization.js';
import { evaluateSchemaCelExpression } from './schema-cel-evaluator.js';

type ResourceCollection = Record<string, KubernetesResource> | readonly KubernetesResource[];

export interface KroInstanceNamespaceSafetyInput<TSpec extends KroCompatibleType> {
  readonly compositionName: string;
  readonly instanceNamespace: string;
  readonly spec: TSpec;
  readonly resources?: ResourceCollection;
  readonly compositionFn?: (spec: TSpec) => unknown;
  /**
   * Namespace names the factory has HOISTED out of the RGD graph (emitted as
   * retained resources OUTSIDE the graph, created deps-first). A hoisted
   * namespace is no longer a graph-owned child, so it can never be garbage
   * collected when the instance CR is deleted — the finalizer-stranding concern
   * this guard protects against is structurally resolved. The guard therefore
   * treats an owned namespace that has been hoisted as SAFE, even though it still
   * appears in the composition's resources. Everything NOT hoisted (an owned
   * namespace whose name can't be proven, or one the caller EXPLICITLY pinned the
   * instance back into) still throws.
   */
  readonly hoistedNamespaces?: ReadonlySet<string>;
}

interface CompositionSafetyMetadata {
  readonly name?: string;
  readonly resources?: readonly KubernetesResource[];
  readonly _compositionFn?: (spec: KroCompatibleType) => unknown;
}

function resourceEntries(
  resources: ResourceCollection | undefined
): [string, KubernetesResource][] {
  if (!resources) return [];
  return Array.isArray(resources)
    ? resources.map((resource, index) => [String(index), resource])
    : Object.entries(resources);
}

function resolveSpecPath(spec: KroCompatibleType, fieldPath: string): unknown {
  const parts = fieldPath.replace(/^spec\./, '').split('.');
  let current: unknown = spec;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveNamespaceName(value: unknown, spec: KroCompatibleType): string | undefined {
  if (isKubernetesRef(value)) {
    if (value.resourceId !== '__schema__') return undefined;
    const resolved = resolveSpecPath(spec, value.fieldPath);
    return resolved === undefined || resolved === null ? undefined : String(resolved);
  }

  if (isCelExpression(value)) {
    const expression = value.expression.trim().replace(/^\$\{\s*|\s*\}$/g, '');
    // A concrete re-execution turns Cel.expr(spec.namespace) into a bare
    // DNS-label expression body. It is already the resolved namespace.
    if (/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(expression)) {
      return expression;
    }

    try {
      const resolved = evaluateSchemaCelExpression(value, spec);
      return typeof resolved === 'string' ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  if (typeof value !== 'string') return undefined;
  const marker = new RegExp(KUBERNETES_REF_SCHEMA_MARKER_SOURCE, 'g');
  let unresolved = false;
  const resolved = value.replace(marker, (_match, fieldPath: string) => {
    const fieldValue = resolveSpecPath(spec, fieldPath);
    if (fieldValue === undefined || fieldValue === null) {
      unresolved = true;
      return _match;
    }
    return String(fieldValue);
  });
  return unresolved ? undefined : resolved;
}

function concreteResources<TSpec extends KroCompatibleType>(
  input: Omit<KroInstanceNamespaceSafetyInput<TSpec>, 'instanceNamespace'>
): [string, KubernetesResource][] {
  if (!input.compositionFn) return resourceEntries(input.resources);

  const context = createCompositionContext(`kro-instance-safety-${input.compositionName}`, {
    deduplicateIds: true,
    isReExecution: true,
  });
  runWithCompositionContext(context, () => input.compositionFn?.(input.spec));
  const executed = Object.entries(context.resources) as [string, KubernetesResource][];
  return executed;
}

function concreteBoolean(value: unknown, spec: KroCompatibleType): boolean | undefined {
  if (typeof value === 'boolean') return value;

  if (isKubernetesRef(value)) {
    if (value.resourceId !== '__schema__') return undefined;
    const resolved = resolveSpecPath(spec, value.fieldPath);
    return typeof resolved === 'boolean' ? resolved : undefined;
  }

  if (isCelExpression(value)) {
    try {
      const resolved = evaluateSchemaCelExpression(value, spec);
      return typeof resolved === 'boolean' ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^\$\{\s*|\s*\}$/g, '');
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  const schemaPath = /^(?:schema\.)?(spec\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(
    normalized
  )?.[1];
  if (!schemaPath) return undefined;
  const resolved = resolveSpecPath(spec, schemaPath);
  return typeof resolved === 'boolean' ? resolved : undefined;
}

export function isActiveOwnedResource(
  resource: KubernetesResource,
  spec: KroCompatibleType
): boolean {
  if (Reflect.get(resource, '__externalRef') === true) return false;

  const metadataConditions = getIncludeWhen(resource);
  const legacyConditions = Reflect.get(resource, 'includeWhen');
  const conditions =
    metadataConditions ?? (Array.isArray(legacyConditions) ? legacyConditions : undefined);
  return !conditions?.some((condition) => concreteBoolean(condition, spec) === false);
}

/**
 * The concrete Namespaces a composition actively creates and OWNS as graph
 * children, resolved against the concrete instance spec.
 *
 * `owned` holds the resolved names; `unresolved` holds the resource ids of owned
 * Namespaces whose name cannot be evaluated from the spec (so their safety
 * cannot be proven). This is the single detection primitive shared by the
 * ownership GUARD ({@link assertKroInstanceNamespaceOwnershipSafe}) and the
 * workload-namespace HOISTING logic in the KRO factory: a composition owns its
 * instance namespace exactly when the resolved instance namespace is in `owned`.
 */
export interface OwnedNamespaceDetection {
  readonly owned: ReadonlySet<string>;
  readonly unresolved: readonly string[];
}

/**
 * Per-resource detection: for each actively-owned Namespace, its resource id
 * mapped to its resolved concrete name. `unresolved` holds the ids of owned
 * Namespaces whose name cannot be evaluated from the spec.
 *
 * The resource ids are stable across the re-execution used here (dedup + explicit
 * `id`s), so a factory can match them back to its own `resources` to HOIST the
 * owned namespace out of the RGD graph. Re-execution is also what resolves the
 * schema-driven names to concrete values (the built `resources` carry `${...}`
 * KRO templates that can't be evaluated directly).
 */
export function detectOwnedNamespaceResources<TSpec extends KroCompatibleType>(
  input: Omit<KroInstanceNamespaceSafetyInput<TSpec>, 'instanceNamespace'>
): { ownedById: Map<string, string>; unresolved: string[] } {
  const ownedById = new Map<string, string>();
  const unresolved: string[] = [];
  for (const [resourceId, resource] of concreteResources(input)) {
    if (resource.kind !== 'Namespace') continue;
    if (!isActiveOwnedResource(resource, input.spec)) continue;

    const ownedNamespace = resolveNamespaceName(resource.metadata?.name, input.spec);
    if (ownedNamespace === undefined) {
      unresolved.push(resourceId);
    } else {
      ownedById.set(resourceId, ownedNamespace);
    }
  }
  return { ownedById, unresolved };
}

export function detectOwnedNamespaces<TSpec extends KroCompatibleType>(
  input: Omit<KroInstanceNamespaceSafetyInput<TSpec>, 'instanceNamespace'>
): OwnedNamespaceDetection {
  const { ownedById, unresolved } = detectOwnedNamespaceResources(input);
  return { owned: new Set(ownedById.values()), unresolved };
}

/**
 * Whether a Namespace resource's name STRUCTURALLY tracks the schema field the
 * instance namespace is derived from (`spec.namespace`). Used on the spec-less RGD
 * path where a schema-driven name can't be resolved to a concrete value, but a
 * Namespace whose name follows `spec.namespace` always coincides, per instance,
 * with the namespace that instance lands in — so it must be hoisted out of the
 * shared RGD.
 */
export function namespaceNameTracksSchemaNamespace(name: unknown): boolean {
  if (isKubernetesRef(name)) {
    return name.resourceId === '__schema__' && name.fieldPath === 'namespace';
  }
  if (isCelExpression(name)) {
    return /(?:^|[^.\w])(?:schema\.)?spec\.namespace(?:\W|$)/.test(name.expression);
  }
  if (typeof name === 'string') {
    return (
      /(?:schema\.)?spec\.namespace(?:\W|$)/.test(name) || name.includes('__schema___spec.namespace')
    );
  }
  return false;
}

/**
 * Spec-less structural detection: the ids of actively-owned Namespaces whose name
 * tracks `spec.namespace`. These are the owned workload namespaces to HOIST out of
 * the shared RGD graph even without a concrete spec (e.g. `toYaml()` for the RGD).
 */
export function detectStructurallyOwnedNamespaceIds(resources: ResourceCollection): Set<string> {
  const ids = new Set<string>();
  for (const [resourceId, resource] of resourceEntries(resources)) {
    if (resource.kind !== 'Namespace') continue;
    if (!isActiveOwnedResource(resource, {} as KroCompatibleType)) continue;
    if (namespaceNameTracksSchemaNamespace(resource.metadata?.name)) ids.add(resourceId);
  }
  return ids;
}

/**
 * Reject a KRO instance that would own the Namespace containing its own CR.
 *
 * KRO deletes graph children before clearing the owner CR's finalizer. If a
 * child Namespace contains that CR, namespace termination can strand the
 * finalizer permanently. Re-executing with the concrete instance spec makes
 * this check survive nested compositions and schema-driven namespace names.
 *
 * The KRO factory HOISTS a self-owned workload Namespace OUT of the RGD graph
 * (emitting it as a retained resource created deps-first, outside the graph)
 * before calling this guard and passes its name in `hoistedNamespaces`. Because a
 * hoisted namespace is no longer a graph child, deleting the instance can't GC it,
 * so the common create-namespace-and-put-the-instance-in-it pattern is safe with
 * the instance left in its natural namespace — this guard skips it. The guard
 * remains the real protection for the cases hoisting cannot cover: an owned
 * Namespace whose name can't be proven safe (fails closed), and a caller who
 * EXPLICITLY pins `instanceNamespace` back onto a namespace the composition owns
 * (opts into the unsafe pattern, so it is never hoisted).
 */
export function assertKroInstanceNamespaceOwnershipSafe<TSpec extends KroCompatibleType>(
  input: KroInstanceNamespaceSafetyInput<TSpec>
): void {
  const { owned, unresolved } = detectOwnedNamespaces(input);

  const unresolvedId = unresolved[0];
  if (unresolvedId !== undefined) {
    throw new TypeKroError(
      `Cannot prove KRO instance namespace '${input.instanceNamespace}' is safe because active owned Namespace '${unresolvedId}' in composition '${input.compositionName}' has a name that cannot be evaluated from the concrete spec. ` +
        'Use a concrete or schema-only CEL Namespace name, or move the KRO instance to a control-plane namespace whose safety can be established.',
      'UNRESOLVED_KRO_NAMESPACE_OWNERSHIP',
      {
        composition: input.compositionName,
        instanceNamespace: input.instanceNamespace,
        resourceId: unresolvedId,
        mode: 'kro',
      }
    );
  }

  // An owned namespace the factory has HOISTED out of the graph is safe: it is no
  // longer a graph child, so deleting the instance can never garbage-collect it.
  if (owned.has(input.instanceNamespace) && input.hoistedNamespaces?.has(input.instanceNamespace)) {
    return;
  }

  if (owned.has(input.instanceNamespace)) {
    throw new TypeKroError(
      `KRO instance namespace '${input.instanceNamespace}' cannot also be an owned Namespace in composition '${input.compositionName}'. ` +
        'Place the KRO instance in a separate control-plane namespace so deleting it cannot terminate the namespace containing its own finalizer.',
      'UNSAFE_KRO_NAMESPACE_OWNERSHIP',
      {
        composition: input.compositionName,
        instanceNamespace: input.instanceNamespace,
        ownedNamespace: input.instanceNamespace,
        mode: 'kro',
      }
    );
  }
}

/** Validate the fixed registry namespace used by a shared singleton owner. */
export function assertSingletonOwnerNamespaceOwnershipSafe(
  definition: SingletonDefinitionRecord
): void {
  const composition = definition.composition as unknown as CompositionSafetyMetadata;
  assertKroInstanceNamespaceOwnershipSafe({
    compositionName: composition.name ?? 'singleton-owner',
    instanceNamespace: definition.registryNamespace,
    spec: definition.spec,
    ...(composition.resources ? { resources: composition.resources } : {}),
    ...(composition._compositionFn ? { compositionFn: composition._compositionFn } : {}),
  });
}
