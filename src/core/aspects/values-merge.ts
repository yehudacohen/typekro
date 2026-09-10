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

/**
 * The overlay list of a merge node, normalized. Nodes built before the list
 * form carry a single `overlay` instead, and a hand-written one may carry
 * neither.
 */
function overlaysOf(node: ValuesMergeExpression): readonly unknown[] {
  if (Array.isArray(node.overlays)) return node.overlays;
  return 'overlay' in node ? [(node as { overlay?: unknown }).overlay] : [];
}

export function mergeValuesExpression(base: unknown, overlay: unknown): ValuesMergeExpression {
  if (isValuesMergeExpression(base)) {
    return {
      __typekroValuesMerge: true,
      base: base.base,
      overlays: [...overlaysOf(base), overlay],
    };
  }

  return { __typekroValuesMerge: true, base, overlays: [overlay] };
}

/**
 * True when a chart-values argument cannot be enumerated at build time: a
 * whole-object schema/resource reference, a CEL expression, a mixed template,
 * or an existing runtime merge node.
 */
function isOpaqueChartValues(value: unknown): boolean {
  return (
    isValuesMergeExpression(value) ||
    isKubernetesRef(value) ||
    isResourceReference(value) ||
    isCelExpression(value) ||
    isMixedTemplate(value)
  );
}

/**
 * Layer a factory's static chart defaults UNDER caller-supplied values.
 *
 * Replaces the `{ ...defaults, ...values }` spread that silently mangles an
 * opaque values argument: spreading a schema reference asks the proxy for keys
 * that only exist per instance, so the reference is lost and the emitted chart
 * values carry a placeholder key instead (issue #190). Plain objects keep the
 * exact build-time shallow-merge semantics the spread had.
 *
 * A default is never dropped for being unmergeable at build time. When the
 * merge base is opaque — a `KubernetesRef`, a CEL expression, or any other
 * value whose keys are not enumerable now — the defaults become the base of a
 * {@link ValuesMergeExpression} with the runtime values layered over them, the
 * same shape the chart values mappers emit, and KRO does the merge per
 * instance.
 */
export function withChartValueDefaults(
  defaults: Record<string, unknown>,
  values: unknown
): unknown {
  if (isValuesMergeExpression(values)) {
    // A plain base still merges statically. An opaque one is pushed down into
    // the overlay chain so the defaults sit underneath it rather than being
    // replaced by it — dropping `base` here is what lost the defaults before.
    const overlays = overlaysOf(values);
    return isPlainMergeObject(values.base)
      ? ({
          __typekroValuesMerge: true,
          base: { ...defaults, ...values.base },
          overlays,
        } satisfies ValuesMergeExpression)
      : ({
          __typekroValuesMerge: true,
          base: defaults,
          overlays: [values.base, ...overlays],
        } satisfies ValuesMergeExpression);
  }
  if (isOpaqueChartValues(values)) return mergeValuesExpression(defaults, values);
  if (isPlainMergeObject(values)) return { ...defaults, ...values };
  // Nothing to layer the defaults under: `undefined`, or an argument that is
  // not a values object at all. The defaults stand alone rather than being
  // dropped.
  return { ...defaults };
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
      for (const overlay of overlaysOf(current)) {
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
