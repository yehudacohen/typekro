import {
  containsCelExpressions,
  containsKubernetesRefs,
  isCelExpression,
  isKubernetesRef,
  isMixedTemplate,
  isResourceReference,
} from '../../utils/type-guards.js';
import { TypeKroError } from '../errors.js';
import { copyResourceMetadata } from '../metadata/resource-metadata.js';
import type { KubernetesResource } from '../types/kubernetes.js';

import type { AspectOverrideSchemaNode } from './metadata.js';
import { getAspectMetadata, setAspectMetadata } from './metadata.js';
import { resolveFactoryTargetId } from './targets.js';
import { AspectDefinitionError } from './types.js';
import type {
  AppendOperation,
  ApplyAspectsOptions,
  AspectDefinition,
  AspectOperationKind,
  AspectSelector,
  AspectTarget,
  MergeOperation,
  MetadataAspectSurface,
  ReplaceOperation,
} from './types.js';

type MutableResource = KubernetesResource & Record<string, unknown>;
type RuntimeAspectDefinition = AspectDefinition<AspectTarget | readonly AspectTarget[]>;
type RuntimeOverrideAspectSurface = {
  readonly kind: 'override';
  readonly patch: unknown;
};

export class AspectApplicationError extends TypeKroError {
  readonly name = 'AspectApplicationError';

  readonly selector?: AspectSelector;

  readonly matchCount?: number;

  readonly resourceId?: string;

  readonly resourceKind?: string;

  readonly resourceName?: string;

  readonly surface?: 'metadata' | 'override';

  readonly operation?: AspectOperationKind;

  readonly fieldPath?: string;

  constructor(
    message: string,
    readonly aspectIndex: number,
    readonly target: string,
    readonly mode: 'direct' | 'kro',
    readonly reason: string,
    options: {
      selector?: AspectSelector;
      matchCount?: number;
      resourceId?: string;
      resourceKind?: string;
      resourceName?: string;
      surface?: 'metadata' | 'override';
      operation?: AspectOperationKind;
      fieldPath?: string;
    } = {}
  ) {
    super(message, 'ASPECT_APPLICATION_ERROR', {
      aspectIndex,
      target,
      mode,
      reason,
      ...options,
    });
    Object.assign(this, options);
  }
}

function cloneValue<T>(value: T): T {
  if (
    isKubernetesRef(value) ||
    isCelExpression(value) ||
    isMixedTemplate(value) ||
    isResourceReference(value)
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value && typeof value === 'object') {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      clone[key] = cloneValue(child);
    }
    return clone as T;
  }
  return value;
}

function cloneResources<TResources extends Record<string, KubernetesResource>>(
  resources: TResources
): TResources {
  const cloned: Record<string, KubernetesResource> = {};
  for (const [key, resource] of Object.entries(resources)) {
    const clone = cloneValue(resource);
    copyResourceMetadata(resource, clone);
    cloned[key] = clone;
  }
  return cloned as TResources;
}

function isTargetGroup(target: unknown): target is { kind: 'target-group'; id: string } {
  return (
    !!target && typeof target === 'object' && 'kind' in target && target.kind === 'target-group'
  );
}

function targetLabel(target: unknown): string {
  if (Array.isArray(target)) {
    return (target as readonly AspectTarget[]).map((child) => targetLabel(child)).join(',');
  }
  if (typeof target === 'function') {
    return String(Reflect.get(target, '__typekroAspectTargetId') ?? target.name);
  }
  if (isTargetGroup(target)) return target.id;
  return 'unknown';
}

function normalizedTargetId(value: unknown): string {
  return String(value).toLowerCase();
}

function hasStructuredSpec(resource: KubernetesResource): boolean {
  return !!resource.spec && typeof resource.spec === 'object' && !Array.isArray(resource.spec);
}

function matchesTarget(
  resource: KubernetesResource,
  aspectDefinition: RuntimeAspectDefinition
): boolean {
  const metadata = getAspectMetadata(resource);
  const targets = Array.isArray(aspectDefinition.target)
    ? aspectDefinition.target
    : [aspectDefinition.target];

  return targets.some((target) => {
    if (typeof target === 'function') {
      const targetId = resolveFactoryTargetId(target);
      if (targetId === undefined) return false;
      // Factory targets are kind-level identities, so custom factories that
      // produce the same Kubernetes kind intentionally share the same target.
      return (
        normalizedTargetId(metadata?.factoryTarget) === normalizedTargetId(targetId) ||
        normalizedTargetId(resource.kind) === normalizedTargetId(targetId)
      );
    }
    if (isTargetGroup(target)) {
      if (target.id === 'allResources') return true;
      if (target.id === 'resources') {
        return metadata?.overrideSchema !== undefined || hasStructuredSpec(resource);
      }
      return metadata?.targetGroups?.includes(target.id) ?? false;
    }
    return false;
  });
}

function matchesSelector(resource: KubernetesResource, selector?: AspectSelector): boolean {
  if (!selector) return true;
  const metadata = getAspectMetadata(resource);
  if (selector.slot !== undefined && metadata?.slot !== selector.slot) return false;
  if (selector.id !== undefined && metadata?.id !== selector.id) return false;
  if (
    selector.name !== undefined &&
    (metadata?.name ?? resource.metadata?.name) !== selector.name
  ) {
    return false;
  }
  if (
    selector.namespace !== undefined &&
    (metadata?.namespace ?? resource.metadata?.namespace) !== selector.namespace
  ) {
    return false;
  }
  if (selector.kind !== undefined && (metadata?.kind ?? resource.kind) !== selector.kind)
    return false;
  if (selector.labels) {
    const labels = resource.metadata?.labels ?? metadata?.labels ?? {};
    for (const [key, value] of Object.entries(selector.labels)) {
      if (labels[key] !== value) return false;
    }
  }
  return true;
}

function setLabelsFromResource(resource: KubernetesResource): void {
  const metadata = getAspectMetadata(resource);
  if (!metadata) return;
  const labels = resource.metadata?.labels ?? metadata.labels;
  if (labels !== undefined) {
    setAspectMetadata(resource, { labels });
  }
}

function applyMetadataSurface(resource: MutableResource, surface: MetadataAspectSurface): void {
  resource.metadata ??= {};
  if (surface.labels) {
    resource.metadata.labels = applyMapOperation(resource.metadata.labels ?? {}, surface.labels);
  }
  if (surface.annotations) {
    resource.metadata.annotations = applyMapOperation(
      resource.metadata.annotations ?? {},
      surface.annotations
    );
  }
  setLabelsFromResource(resource);
}

function applyMapOperation(
  current: Record<string, string>,
  operation: ReplaceOperation<Record<string, string>> | MergeOperation<Record<string, string>>
): Record<string, string> {
  return operation.kind === 'replace'
    ? Object.fromEntries(
        Object.entries(operation.value).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
    : Object.fromEntries(
        Object.entries({ ...current, ...operation.value }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      );
}

function isOperation(
  value: unknown
): value is ReplaceOperation<unknown> | MergeOperation<object> | AppendOperation<unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    'kind' in value &&
    (value.kind === 'replace' || value.kind === 'merge' || value.kind === 'append')
  );
}

function applyOverrideSurface(
  resource: MutableResource,
  surface: RuntimeOverrideAspectSurface,
  context: ApplyOperationContext
): void {
  validateOverridePatch(resource, surface.patch, context);
  applyPatch(resource, surface.patch, [], context);
}

interface ApplyOperationContext {
  mode: 'direct' | 'kro';
  aspectIndex: number;
  target: string;
  selector?: AspectSelector;
  matchCount: number;
  resourceId?: string;
  resourceKind?: string;
  resourceName?: string;
  surface: 'override';
}

function operationPlacementIsAllowed(
  fieldKind: AspectOverrideSchemaNode['kind'],
  operation: ReplaceOperation<unknown> | MergeOperation<object> | AppendOperation<unknown>
): boolean {
  if (operation.kind === 'replace') return true;
  if (operation.kind === 'merge') return fieldKind === 'object';
  return fieldKind === 'array';
}

function validateOverridePatchNode(
  node: AspectOverrideSchemaNode,
  patch: unknown,
  path: string[],
  context: ApplyOperationContext
): void {
  if (!patch || typeof patch !== 'object') return;

  if (isOperation(patch)) {
    if (!operationPlacementIsAllowed(node.kind, patch)) {
      const fieldPath = path.join('.');
      throw new AspectApplicationError(
        `Aspect ${patch.kind} operation is not valid for ${node.kind} field ${fieldPath}`,
        context.aspectIndex,
        context.target,
        context.mode,
        'operation is not allowed for the advertised writable aspect field type',
        { ...context, operation: patch.kind, fieldPath }
      );
    }
    return;
  }

  if (node.kind !== 'object' || !node.children) {
    const fieldPath = path.join('.');
    throw new AspectApplicationError(
      `Aspect override field ${fieldPath} must use replace(...)`,
      context.aspectIndex,
      context.target,
      context.mode,
      'nested patch is not valid for this advertised writable aspect field',
      { ...context, fieldPath }
    );
  }

  for (const [key, childPatch] of Object.entries(patch)) {
    const childNode = node.children[key];
    const childPath = [...path, key];
    if (!childNode) {
      const fieldPath = childPath.join('.');
      throw new AspectApplicationError(
        `Aspect override field ${fieldPath} is not advertised for this resource`,
        context.aspectIndex,
        context.target,
        context.mode,
        'field is not in the advertised writable aspect schema',
        { ...context, fieldPath }
      );
    }
    validateOverridePatchNode(childNode, childPatch, childPath, context);
  }
}

function validateOverridePatch(
  resource: MutableResource,
  patch: unknown,
  context: ApplyOperationContext
): void {
  const schema = getAspectMetadata(resource)?.overrideSchema;
  // Generic factory targets derive their deep writable shape from TypeScript.
  // At runtime we still enforce root/spec boundaries and concrete operation
  // compatibility against existing fields during applyPatch/applyOperation, but
  // TypeScript remains authoritative for optional Kubernetes fields that are not
  // present in the initial manifest.
  if (!schema) return;
  validateOverridePatchNode(schema, patch, [], context);
}

function applyPatch(
  target: Record<string, unknown>,
  patch: unknown,
  path: string[],
  context: ApplyOperationContext
): void {
  if (!patch || typeof patch !== 'object') return;
  for (const [key, value] of Object.entries(patch)) {
    const nextPath = [...path, key];
    if (isOperation(value)) {
      applyOperation(target, key, value, nextPath, context);
    } else {
      const child = target[key];
      if (child !== undefined && (typeof child !== 'object' || Array.isArray(child))) {
        const fieldPath = nextPath.join('.');
        throw new AspectApplicationError(
          `Aspect nested patch requires an object field at ${fieldPath}`,
          context.aspectIndex,
          context.target,
          context.mode,
          'nested patch target is not an object',
          { ...context, fieldPath }
        );
      }
      if (!child) target[key] = {};
      applyPatch(target[key] as Record<string, unknown>, value, nextPath, context);
    }
  }
}

function applyOperation(
  target: Record<string, unknown>,
  key: string,
  operation: ReplaceOperation<unknown> | MergeOperation<object> | AppendOperation<unknown>,
  path: string[],
  context: ApplyOperationContext
): void {
  const current = target[key];
  const fieldPath = path.join('.');
  if (
    context.mode === 'kro' &&
    (operation.kind === 'merge' || operation.kind === 'append') &&
    (operation.kind === 'merge'
      ? containsKubernetesRefs(current) || containsCelExpressions(current)
      : operation.value.length > 0 &&
        (containsKubernetesRefs(current) || containsCelExpressions(current)))
  ) {
    throw new AspectApplicationError(
      `Aspect ${operation.kind} is not safe for reference-backed Kro field ${fieldPath}`,
      context.aspectIndex,
      context.target,
      context.mode,
      'reference-backed composite cannot be merged or appended in Kro mode',
      { ...context, operation: operation.kind, fieldPath }
    );
  }
  if (operation.kind === 'replace') {
    target[key] = cloneValue(operation.value);
  } else if (operation.kind === 'merge') {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new AspectApplicationError(
        `Aspect merge operation requires an object field at ${fieldPath}`,
        context.aspectIndex,
        context.target,
        context.mode,
        'merge operation target is not an object',
        { ...context, operation: operation.kind, fieldPath }
      );
    }
    target[key] = { ...(current as Record<string, unknown>), ...operation.value };
  } else {
    if (current === undefined) {
      target[key] = cloneValue(operation.value);
      return;
    }
    if (!Array.isArray(current)) {
      throw new AspectApplicationError(
        `Aspect append operation requires an array field at ${fieldPath}`,
        context.aspectIndex,
        context.target,
        context.mode,
        'append operation target is not an array',
        { ...context, operation: operation.kind, fieldPath }
      );
    }
    target[key] = [...current, ...operation.value];
  }
}

export function applyAspects<TResources extends Record<string, KubernetesResource>>(
  resources: TResources,
  options: ApplyAspectsOptions
): TResources {
  if (options.aspects.length === 0) return resources;
  const cloned = cloneResources(resources);
  const resourceList = Object.values(cloned);

  options.aspects.forEach((definition, index) => {
    const typedDefinition = definition as RuntimeAspectDefinition;
    const target = targetLabel(typedDefinition.target);
    const matches = resourceList.filter(
      (resource) =>
        matchesTarget(resource, typedDefinition) &&
        matchesSelector(resource, typedDefinition.selector)
    );
    if (typedDefinition.cardinality === 'exactly-one' && matches.length !== 1) {
      throw new AspectApplicationError(
        `Aspect expected one ${target} match but found ${matches.length}`,
        index,
        target,
        options.mode,
        'selector cardinality mismatch',
        {
          ...(typedDefinition.selector !== undefined ? { selector: typedDefinition.selector } : {}),
          matchCount: matches.length,
        }
      );
    }
    if (typedDefinition.cardinality === 'one-or-more' && matches.length === 0) {
      throw new AspectApplicationError(
        `Aspect selector matched no resources for ${target}`,
        index,
        target,
        options.mode,
        'no resources matched selector',
        {
          ...(typedDefinition.selector !== undefined ? { selector: typedDefinition.selector } : {}),
          matchCount: 0,
        }
      );
    }

    for (const resource of matches) {
      const metadata = getAspectMetadata(resource);
      if (typedDefinition.surface.kind === 'metadata') {
        applyMetadataSurface(resource as MutableResource, typedDefinition.surface);
      } else if (typedDefinition.surface.kind === 'override') {
        try {
          applyOverrideSurface(resource as MutableResource, typedDefinition.surface, {
            mode: options.mode,
            aspectIndex: index,
            target,
            ...(typedDefinition.selector !== undefined
              ? { selector: typedDefinition.selector }
              : {}),
            matchCount: matches.length,
            ...(metadata?.id !== undefined ? { resourceId: metadata.id } : {}),
            resourceKind: resource.kind,
            ...(resource.metadata?.name !== undefined
              ? { resourceName: String(resource.metadata.name) }
              : {}),
            surface: 'override',
          });
        } catch (error) {
          if (error instanceof AspectApplicationError) throw error;
          throw new AspectDefinitionError('override', String(error));
        }
      }
    }
  });

  return cloned;
}
