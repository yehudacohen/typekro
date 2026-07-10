import { isKubernetesRef } from '../../utils/type-guards.js';
import { createCompositionContext, runWithCompositionContext } from '../composition/context.js';
import { KUBERNETES_REF_SCHEMA_MARKER_SOURCE } from '../constants/brands.js';
import { TypeKroError } from '../errors.js';
import type { SingletonDefinitionRecord } from '../types/deployment.js';
import type { KubernetesResource } from '../types/kubernetes.js';
import type { KroCompatibleType } from '../types/serialization.js';

type ResourceCollection = Record<string, KubernetesResource> | readonly KubernetesResource[];

export interface KroInstanceNamespaceSafetyInput<TSpec extends KroCompatibleType> {
  readonly compositionName: string;
  readonly instanceNamespace: string;
  readonly spec: TSpec;
  readonly resources?: ResourceCollection;
  readonly compositionFn?: (spec: TSpec) => unknown;
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

function resolveNamespaceName(value: unknown, spec: KroCompatibleType): string | undefined {
  if (isKubernetesRef(value)) {
    if (value.resourceId !== '__schema__') return undefined;
    const resolved = resolveSpecPath(spec, value.fieldPath);
    return resolved === undefined || resolved === null ? undefined : String(resolved);
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
  input: KroInstanceNamespaceSafetyInput<TSpec>
): [string, KubernetesResource][] {
  if (!input.compositionFn) return resourceEntries(input.resources);

  const context = createCompositionContext(`kro-instance-safety-${input.compositionName}`, {
    deduplicateIds: true,
    isReExecution: true,
  });
  runWithCompositionContext(context, () => input.compositionFn?.(input.spec));
  const executed = Object.entries(context.resources) as [string, KubernetesResource][];
  return executed.length > 0 ? executed : resourceEntries(input.resources);
}

/**
 * Reject a KRO instance that would own the Namespace containing its own CR.
 *
 * KRO deletes graph children before clearing the owner CR's finalizer. If a
 * child Namespace contains that CR, namespace termination can strand the
 * finalizer permanently. Re-executing with the concrete instance spec makes
 * this check survive nested compositions and schema-driven namespace names.
 */
export function assertKroInstanceNamespaceOwnershipSafe<TSpec extends KroCompatibleType>(
  input: KroInstanceNamespaceSafetyInput<TSpec>
): void {
  for (const [resourceId, resource] of concreteResources(input)) {
    if (resource.kind !== 'Namespace') continue;

    const ownedNamespace = resolveNamespaceName(resource.metadata?.name, input.spec);
    if (ownedNamespace === input.instanceNamespace) {
      throw new TypeKroError(
        `KRO instance namespace '${input.instanceNamespace}' cannot also be an owned Namespace in composition '${input.compositionName}'. ` +
          'Place the KRO instance in a separate control-plane namespace so deleting it cannot terminate the namespace containing its own finalizer.',
        'UNSAFE_KRO_NAMESPACE_OWNERSHIP',
        {
          composition: input.compositionName,
          instanceNamespace: input.instanceNamespace,
          ownedNamespace,
          resourceId,
          mode: 'kro',
        }
      );
    }
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
