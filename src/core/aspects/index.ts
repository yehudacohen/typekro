/**
 * Typed resource aspects for applying validated metadata and spec overrides to
 * TypeKro resources at render/factory time.
 *
 * Target groups: `allResources` accepts `metadata(...)` for every rendered
 * resource. `resources` accepts `override(...)` for every rendered resource with
 * a structured `spec`, using resource-advertised schemas when present and a
 * conservative runtime schema derived from the resource object otherwise.
 * Concrete factory targets such as `simple.Deployment` and `simple.StatefulSet`
 * provide the strongest type narrowing.
 *
 * Selectors use AND semantics across `slot`, `id`, `name`, `namespace`, `kind`,
 * and `labels`. By default an aspect requires one-or-more matches; `.optional()`
 * allows zero matches and `.expectOne()` requires exactly one match.
 *
 * Operation legality is schema-derived: `replace(...)` is valid for advertised
 * scalar, object, and array fields; `merge(...)` is valid for advertised object
 * fields; `append(...)` is valid for advertised array fields. Kro mode rejects
 * merge/append when the current composite field is reference-backed.
 *
 * @example Apply metadata across a rendered composition.
 * ```typescript
 * app.toYaml({
 *   aspects: [
 *     aspect.on(allResources, metadata({ labels: merge({ team: 'platform' }) })),
 *   ],
 * });
 * ```
 *
 * @example Override factory-advertised workload fields for hot reload.
 * ```typescript
 * app.toYaml({
 *   aspects: [
 *     aspect
 *       .on(simple.Deployment, override({
 *         spec: {
 *           template: {
 *             spec: {
 *               containers: append([{
 *                 name: 'dev-tools',
 *                 image: 'busybox',
 *                 command: ['sh', '-c', 'sleep infinity'],
 *                 workingDir: '/workspace',
 *                 env: [{ name: 'LOG_LEVEL', value: 'debug' }],
 *                 volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
 *               }],
 *               volumes: append([{ name: 'workspace', emptyDir: {} }]),
 *             },
 *           },
 *         },
 *       }))
 *       .where({ slot: 'web', labels: { tier: 'app' } })
 *       .expectOne(),
 *   ],
 * });
 * ```
 *
 * @example Apply the same aspect through direct/Kro factories.
 * ```typescript
 * const aspects = [aspect.on(allResources, metadata({ annotations: merge({ owner: 'platform' }) }))];
 * app.factory('direct', { aspects }).toYaml(spec);
 * app.factory('kro', { aspects }).toYaml();
 * ```
 *
 * Failure recovery: `AspectDefinitionError` means the aspect definition is invalid
 * before resources are touched (for example, wrong target/surface pairing).
 * `AspectApplicationError` means the definition matched resources but could not be
 * safely applied (for example, unsupported writable field, wrong operation type,
 * selector cardinality mismatch, or Kro reference-backed merge/append). Fix the
 * target, selector, field path, or operation and render again. Error diagnostics
 * include selector and resource identity context but not operation payloads or
 * full manifests.
 */
import {
  isCelExpression,
  isKubernetesRef,
  isMixedTemplate,
  isResourceReference,
} from '../../utils/type-guards.js';
import { TypeKroError } from '../errors.js';
import { getAspectMetadata, setAspectMetadata } from './metadata.js';

import type {
  AppendOperation,
  AspectBuilder,
  AspectDefinition,
  AspectDefinitionError as AspectDefinitionErrorType,
  AspectOverridePatch,
  AspectSelector,
  AspectSurface,
  AspectSurfaceForTarget,
  AspectTarget,
  AspectTargetGroup,
  CommonAspectSurfaceForTargets,
  CompatibleAspectTargets,
  MergeOperation,
  MetadataAspectSurface,
  OverrideAspectSurface,
  ReplaceOperation,
} from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
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

function assertSelector(selector: AspectSelector): void {
  if (!isPlainObject(selector)) {
    throw createDefinitionError('aspect.on', 'where(...) selector must be an object');
  }
}

function createDefinitionError(
  functionName: AspectDefinitionErrorType['functionName'],
  reason: string
): AspectDefinitionError {
  return new AspectDefinitionError(functionName, reason);
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
    if (kind === 'replace' || kind === 'merge' || kind === 'append') {
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
      const targetId = Reflect.get(target, '__typekroAspectTargetId');
      const surfaces = Reflect.get(target, '__typekroAspectSurfaces');
      if (typeof targetId !== 'string' || targetId.length === 0 || !Array.isArray(surfaces)) {
        throw createDefinitionError(
          'aspect.on',
          'factory target must advertise TypeKro aspect metadata'
        );
      }
      if (!surfaces.includes(surface.kind)) {
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

/** Error thrown for invalid aspect definitions before resource application. */
export class AspectDefinitionError extends TypeKroError {
  constructor(
    readonly functionName: AspectDefinitionErrorType['functionName'],
    readonly reason: string
  ) {
    super(`Invalid aspect definition in ${functionName}: ${reason}`, 'ASPECT_DEFINITION_ERROR', {
      functionName,
      reason,
    });
    this.name = 'AspectDefinitionError';
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

export { AspectApplicationError, applyAspects } from './apply.js';
export type * from './types.js';
