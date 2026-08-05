import {
  isCelExpression,
  isKubernetesRef,
  isMixedTemplate,
  isResourceReference,
} from '../../utils/type-guards.js';

export interface ValuesMergeExpression {
  readonly __typekroValuesMerge: true;
  readonly base: unknown;
  readonly overlays: readonly unknown[];
}

export function isValuesMergeExpression(value: unknown): value is ValuesMergeExpression {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __typekroValuesMerge?: unknown }).__typekroValuesMerge === true
  );
}

export function mergeValuesExpression(base: unknown, overlay: unknown): ValuesMergeExpression {
  if (isValuesMergeExpression(base)) {
    const overlays = Array.isArray(base.overlays)
      ? base.overlays
      : 'overlay' in base
        ? [(base as { overlay?: unknown }).overlay]
        : [];
    return {
      __typekroValuesMerge: true,
      base: base.base,
      overlays: [...overlays, overlay],
    };
  }

  return { __typekroValuesMerge: true, base, overlays: [overlay] };
}

function isPlainMergeObject(value: unknown): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    isValuesMergeExpression(value) ||
    isKubernetesRef(value) ||
    isResourceReference(value) ||
    isCelExpression(value) ||
    isMixedTemplate(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeMaterializedValues(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return base;
  if (!isPlainMergeObject(base) || !isPlainMergeObject(overlay)) return overlay;

  return Object.fromEntries(
    Array.from(new Set([...Object.keys(base), ...Object.keys(overlay)])).flatMap((key) => {
      const merged = Object.hasOwn(overlay, key)
        ? mergeMaterializedValues(base[key], overlay[key])
        : base[key];
      return merged === undefined ? [] : [[key, merged]];
    })
  );
}

/**
 * Resolve TypeKro's internal Helm-values merge nodes for concrete/direct execution.
 *
 * KRO serialization preserves these nodes long enough to compile graph-aware map
 * merges. Direct execution already has concrete values, so the operation must be
 * evaluated before the manifest enters the canonical artifact record. The walk is
 * immutable and treats references/CEL/templates as atomic leaves.
 */
export function materializeValuesMergeExpressions(value: unknown): unknown {
  const visiting = new WeakSet<object>();

  const materialize = (current: unknown): unknown => {
    if (isValuesMergeExpression(current)) {
      if (visiting.has(current)) {
        throw new TypeError('Circular TypeKro values merge expression.');
      }
      visiting.add(current);
      let merged = materialize(current.base);
      const overlays = Array.isArray(current.overlays) ? current.overlays : [current.overlays];
      for (const overlay of overlays) {
        merged = mergeMaterializedValues(merged, materialize(overlay));
      }
      visiting.delete(current);
      return merged;
    }

    if (
      isKubernetesRef(current) ||
      isResourceReference(current) ||
      isCelExpression(current) ||
      isMixedTemplate(current)
    ) {
      return current;
    }

    if (Array.isArray(current)) {
      let changed = false;
      const materialized = current.map((entry, index) => {
        const next = materialize(entry);
        if (next !== current[index]) changed = true;
        return next;
      });
      return changed ? materialized : current;
    }

    if (!isPlainMergeObject(current)) return current;
    if (visiting.has(current)) {
      throw new TypeError('Circular value tree containing a TypeKro values merge expression.');
    }
    visiting.add(current);
    let changed = false;
    const entries = Object.entries(current).map(([key, entry]) => {
      const next = materialize(entry);
      if (next !== entry) changed = true;
      return [key, next] as const;
    });
    visiting.delete(current);
    return changed ? Object.fromEntries(entries) : current;
  };

  return materialize(value);
}
