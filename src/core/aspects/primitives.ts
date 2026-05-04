import {
  isCelExpression,
  isKubernetesRef,
  isMixedTemplate,
  isResourceReference,
} from '../../utils/type-guards.js';
import { getAspectMetadata, setAspectMetadata } from './metadata.js';
import { resolveFactoryTargetId } from './targets.js';
import { AspectDefinitionError } from './types.js';

import type {
  AppendOperation,
  AspectBuilder,
  AspectDefinition,
  AspectDefinitionFunctionName,
  AspectOverridePatch,
  AspectSelector,
  AspectSurface,
  AspectSurfaceForTarget,
  AspectTarget,
  AspectTargetGroup,
  CommonAspectSurfaceForTargets,
  CompatibleAspectTargets,
  MergeByNameOperation,
  MergeOperation,
  MetadataAspectSurface,
  OverrideAspectSurface,
  PatchEachOperation,
  ReplaceOperation,
} from './types.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneImmutable<T>(value: T): T {
  if (
    isKubernetesRef(value) ||
    isCelExpression(value) ||
    isMixedTemplate(value) ||
    isResourceReference(value)
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  }

  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      cloned[key] = cloneImmutable(child);
    }
    return Object.freeze(cloned) as T;
  }

  return value;
}

function createDefinitionError(
  functionName: AspectDefinitionFunctionName,
  reason: string
): AspectDefinitionError {
  return new AspectDefinitionError(functionName, reason);
}

function assertSelector(selector: AspectSelector): void {
  if (!isPlainObject(selector)) {
    throw createDefinitionError('aspect.on', 'where(...) selector must be an object');
  }
  const allowedKeys = new Set(['slot', 'id', 'name', 'namespace', 'kind', 'labels']);
  for (const [key, value] of Object.entries(selector)) {
    if (!allowedKeys.has(key)) {
      throw createDefinitionError('aspect.on', `where(...) selector field ${key} is not supported`);
    }
    if (key === 'labels') {
      if (!isPlainObject(value)) {
        throw createDefinitionError('aspect.on', 'where(...) selector labels must be an object');
      }
      for (const [labelKey, labelValue] of Object.entries(value)) {
        if (typeof labelValue !== 'string') {
          throw createDefinitionError(
            'aspect.on',
            `where(...) selector label ${labelKey} must be a string`
          );
        }
      }
    } else if (typeof value !== 'string') {
      throw createDefinitionError('aspect.on', `where(...) selector ${key} must be a string`);
    }
  }
}

function operationKind(value: unknown): string | undefined {
  return isPlainObject(value) && typeof value.kind === 'string' ? value.kind : undefined;
}

function assertMetadataOperation(field: string, value: unknown): void {
  const kind = operationKind(value);
  if (kind !== 'merge' && kind !== 'replace') {
    throw createDefinitionError(
      'metadata',
      `metadata.${field} must use merge(...) or replace(...)`
    );
  }
}

function assertOverridePatch(path: string, value: unknown): void {
  const kind = operationKind(value);
  if (kind) {
    if (kind === 'merge' && !isPlainObject((value as { value?: unknown }).value)) {
      throw createDefinitionError('override', `${path} merge value must be an object`);
    }
    if (kind === 'append' && !Array.isArray((value as { value?: unknown }).value)) {
      throw createDefinitionError('override', `${path} append value must be an array`);
    }
    if (kind === 'mergeByName' && !Array.isArray((value as { value?: unknown }).value)) {
      throw createDefinitionError('override', `${path} mergeByName value must be an array`);
    }
    if (kind === 'patchEach') {
      const patch = (value as { patch?: unknown }).patch;
      if (!isPlainObject(patch)) {
        throw createDefinitionError('override', `${path} patchEach patch must be an object`);
      }
      assertOverridePatch(`${path}.patch`, patch);
      return;
    }
    if (kind === 'replace' || kind === 'merge' || kind === 'append' || kind === 'mergeByName') {
      return;
    }
    throw createDefinitionError('override', `${path} uses unsupported operation ${kind}`);
  }

  if (!isPlainObject(value)) {
    throw createDefinitionError('override', `${path} must contain aspect operations`);
  }

  for (const [key, child] of Object.entries(value)) {
    assertOverridePatch(`${path}.${key}`, child);
  }
}

function assertOverrideRoot(patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (keys.length !== 1 || keys[0] !== 'spec') {
    throw createDefinitionError('override', 'override(...) patch must be rooted at spec');
  }
  if (!isPlainObject(patch.spec)) {
    throw createDefinitionError('override', 'override(...) spec patch must be an object');
  }
}

function assertTargetSurfaceCompatibility(
  targetOrTargets: AspectTarget | readonly AspectTarget[],
  surface: AspectSurface
): void {
  const targets = Array.isArray(targetOrTargets) ? targetOrTargets : [targetOrTargets];
  for (const target of targets) {
    if (isPlainObject(target) && target.kind === 'target-group') {
      if (target.id === 'allResources' && surface.kind !== 'metadata') {
        throw createDefinitionError('aspect.on', 'allResources supports metadata(...) only');
      }
      if ((target.id === 'resources' || target.id === 'workloads') && surface.kind !== 'override') {
        throw createDefinitionError(
          'aspect.on',
          `${target.id} supports override(...) aspects only`
        );
      }
      continue;
    }

    if (typeof target === 'function') {
      const targetId = resolveFactoryTargetId(target);
      if (targetId === undefined) {
        throw createDefinitionError(
          'aspect.on',
          'factory target must be a registered TypeKro factory or advertise TypeKro aspect metadata'
        );
      }
      const surfaces = Reflect.get(target, '__typekroAspectSurfaces');
      if (Array.isArray(surfaces) && !surfaces.includes(surface.kind)) {
        throw createDefinitionError(
          'aspect.on',
          `factory target ${targetId} does not support ${surface.kind}(...) aspects`
        );
      }
      continue;
    }

    throw createDefinitionError(
      'aspect.on',
      'target must be an aspect-capable factory or target group'
    );
  }
}

class AspectDefinitionImpl<TTarget = AspectTarget, TSurface = AspectSurface> {
  readonly kind = 'aspect';

  readonly selector?: AspectSelector;

  constructor(
    readonly target: TTarget,
    readonly surface: TSurface,
    readonly cardinality: AspectDefinition<TTarget, TSurface>['cardinality'] = 'one-or-more',
    selector?: AspectSelector
  ) {
    if (selector !== undefined) {
      this.selector = cloneImmutable(selector);
    }
    Object.freeze(this);
  }

  where(selector: AspectSelector): AspectDefinition<TTarget, TSurface> {
    if (this.selector !== undefined) {
      throw createDefinitionError('aspect.on', 'where(...) cannot be called more than once');
    }
    assertSelector(selector);
    return new AspectDefinitionImpl(
      this.target,
      this.surface,
      this.cardinality,
      cloneImmutable(selector)
    );
  }

  optional(): AspectDefinition<TTarget, TSurface> {
    if (this.cardinality === 'exactly-one') {
      throw createDefinitionError('aspect.on', 'optional() cannot be called after expectOne()');
    }
    return new AspectDefinitionImpl(this.target, this.surface, 'zero-or-more', this.selector);
  }

  expectOne(): AspectDefinition<TTarget, TSurface> {
    if (this.cardinality === 'zero-or-more') {
      throw createDefinitionError('aspect.on', 'expectOne() cannot be called after optional()');
    }
    return new AspectDefinitionImpl(this.target, this.surface, 'exactly-one', this.selector);
  }
}

export const allResources: AspectTargetGroup<'allResources'> = Object.freeze({
  kind: 'target-group',
  id: 'allResources',
});

export const resources: AspectTargetGroup<'resources'> = Object.freeze({
  kind: 'target-group',
  id: 'resources',
});

export const workloads: AspectTargetGroup<'workloads'> = Object.freeze({
  kind: 'target-group',
  id: 'workloads',
});

function aspectOn<TTarget extends AspectTarget>(
  target: TTarget,
  surface: AspectSurfaceForTarget<TTarget>
): AspectDefinition<TTarget, AspectSurfaceForTarget<TTarget>>;
function aspectOn<const TTargets extends readonly AspectTarget[]>(
  targets: CompatibleAspectTargets<TTargets>,
  surface: CommonAspectSurfaceForTargets<TTargets>
): AspectDefinition<TTargets, CommonAspectSurfaceForTargets<TTargets>>;
function aspectOn(
  targetOrTargets: AspectTarget | readonly AspectTarget[],
  surface: AspectSurface
): AspectDefinition {
  assertTargetSurfaceCompatibility(targetOrTargets, surface);
  return new AspectDefinitionImpl(targetOrTargets, surface) as unknown as AspectDefinition;
}

export const aspect: AspectBuilder = Object.freeze({
  on: aspectOn,
});

/** Creates a replace operation descriptor. */
export function replace<T>(value: T): ReplaceOperation<T> {
  return Object.freeze({ kind: 'replace', value: cloneImmutable(value) });
}

/** Creates an object merge operation descriptor. */
export function merge<T extends object>(value: Partial<T>): MergeOperation<T> {
  if (!isPlainObject(value)) {
    throw createDefinitionError('merge', 'merge(...) value must be a concrete object');
  }
  return Object.freeze({ kind: 'merge', value: cloneImmutable(value) });
}

/** Creates an array append operation descriptor. */
export function append<TElement>(value: readonly TElement[]): AppendOperation<TElement> {
  if (!Array.isArray(value)) {
    throw createDefinitionError('append', 'append(...) value must be an array');
  }
  return Object.freeze({ kind: 'append', value: cloneImmutable(value) });
}

export function patchEach<TElement extends object>(
  patch: AspectOverridePatch<TElement>
): PatchEachOperation<TElement> {
  if (!isPlainObject(patch)) {
    throw createDefinitionError('override', 'patchEach patch must be an object');
  }
  return Object.freeze({ kind: 'patchEach', patch: cloneImmutable(patch) });
}

export function mergeByName<TElement extends { name: string }>(
  value: readonly TElement[]
): MergeByNameOperation<TElement> {
  if (!Array.isArray(value)) {
    throw createDefinitionError('override', 'mergeByName value must be an array');
  }
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || entry.name.length === 0) {
      throw createDefinitionError('override', 'mergeByName entries must have a non-empty name');
    }
  }
  return Object.freeze({ kind: 'mergeByName', value: cloneImmutable(value) });
}

/** Creates a metadata aspect surface descriptor. */
export function metadata(surface: Omit<MetadataAspectSurface, 'kind'>): MetadataAspectSurface {
  if (!isPlainObject(surface)) {
    throw createDefinitionError('metadata', 'metadata(...) value must be an object');
  }
  for (const key of Object.keys(surface)) {
    if (key !== 'labels' && key !== 'annotations') {
      throw createDefinitionError('metadata', `metadata.${key} is not supported`);
    }
  }
  if (surface.labels !== undefined) assertMetadataOperation('labels', surface.labels);
  if (surface.annotations !== undefined)
    assertMetadataOperation('annotations', surface.annotations);
  return Object.freeze({ kind: 'metadata', ...cloneImmutable(surface) });
}

/** Creates a resource override aspect surface descriptor. */
export function override<TSchema extends object>(
  patch: AspectOverridePatch<TSchema>
): OverrideAspectSurface<TSchema>;
export function override(patch: unknown) {
  if (!isPlainObject(patch)) {
    throw createDefinitionError('override', 'override(...) patch must be an object');
  }
  assertOverrideRoot(patch);
  assertOverridePatch('patch', patch);
  return Object.freeze({
    kind: 'override',
    patch: cloneImmutable(patch) as AspectOverridePatch<object>,
  });
}

/** Attaches semantic slot metadata to a resource for aspect selector matching. */
export function slot<TResource extends object>(name: string, resource: TResource): TResource {
  if (name.length === 0) {
    throw createDefinitionError('slot', 'slot name must not be empty');
  }
  const existingSlot = getAspectMetadata(resource)?.slot;
  if (existingSlot !== undefined && existingSlot !== name) {
    throw createDefinitionError('slot', 'resource already has a different slot assigned');
  }
  setAspectMetadata(resource, { slot: name });
  return resource;
}
