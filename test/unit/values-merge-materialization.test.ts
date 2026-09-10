import { describe, expect, it } from 'bun:test';
import {
  isValuesMergeExpression,
  materializeValuesMergeExpressions,
  mergeValuesExpression,
  type ValuesMergeExpression,
  withChartValueDefaults,
} from '../../src/core/aspects/values-merge.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';

describe('direct values merge materialization', () => {
  it('deep-merges objects, replaces arrays and scalars, and preserves its inputs', () => {
    const base = {
      nested: { retained: true, replaced: 'base' },
      list: ['base'],
      scalar: 'base',
    };
    const overlay = {
      nested: { replaced: 'overlay', added: true },
      list: ['overlay'],
      scalar: false,
    };

    expect(materializeValuesMergeExpressions(mergeValuesExpression(base, overlay))).toEqual({
      nested: { retained: true, replaced: 'overlay', added: true },
      list: ['overlay'],
      scalar: false,
    });
    expect(base).toEqual({
      nested: { retained: true, replaced: 'base' },
      list: ['base'],
      scalar: 'base',
    });
    expect(overlay).toEqual({
      nested: { replaced: 'overlay', added: true },
      list: ['overlay'],
      scalar: false,
    });
  });

  it('resolves nested and chained merge expressions anywhere in a value tree', () => {
    const value = {
      spec: {
        values: mergeValuesExpression(
          mergeValuesExpression({ first: 1, nested: { first: 1 } }, { second: 2 }),
          {
            nested: mergeValuesExpression({ second: 2 }, { third: 3 }),
          }
        ),
      },
    };

    expect(materializeValuesMergeExpressions(value)).toEqual({
      spec: {
        values: {
          first: 1,
          second: 2,
          nested: { first: 1, second: 2, third: 3 },
        },
      },
    });
    expect((value.spec.values as { __typekroValuesMerge?: boolean }).__typekroValuesMerge).toBe(
      true
    );
  });
});

/**
 * `withChartValueDefaults` layers a factory's static chart defaults UNDER
 * whatever the caller passed. A default may never be dropped for being
 * unmergeable at build time: when the merge base is opaque the defaults become
 * the base of a runtime merge node, which KRO evaluates per instance.
 */
describe('withChartValueDefaults', () => {
  const defaults = { crds: { create: true, keep: false }, replicaCount: 1 };
  const ref = { [KUBERNETES_REF_BRAND]: true, resourceId: '__schema__', fieldPath: 'spec.values' };
  const cel = { [CEL_EXPRESSION_BRAND]: true, expression: 'schema.spec.values' };

  it('merges statically when the values are a plain object', () => {
    expect(withChartValueDefaults(defaults, { replicaCount: 3 })).toEqual({
      crds: { create: true, keep: false },
      replicaCount: 3,
    });
    expect(isValuesMergeExpression(withChartValueDefaults(defaults, { replicaCount: 3 }))).toBe(
      false
    );
  });

  it('keeps the defaults as a plain object when there are no values at all', () => {
    expect(withChartValueDefaults(defaults, undefined)).toEqual(defaults);
    expect(isValuesMergeExpression(withChartValueDefaults(defaults, undefined))).toBe(false);
  });

  it('defers to a runtime merge when the values are a whole-object reference', () => {
    const merged = withChartValueDefaults(defaults, ref);
    expect(isValuesMergeExpression(merged)).toBe(true);
    expect((merged as ValuesMergeExpression).base).toEqual(defaults);
    expect((merged as ValuesMergeExpression).overlays).toEqual([ref]);
  });

  it('keeps the defaults when an existing merge node has a reference base', () => {
    // The regression: the base was carried through untouched, so the defaults
    // were silently dropped instead of being deferred to the runtime merge.
    const merged = withChartValueDefaults(defaults, mergeValuesExpression(ref, { extra: true }));
    expect(isValuesMergeExpression(merged)).toBe(true);
    expect((merged as ValuesMergeExpression).base).toEqual(defaults);
    expect((merged as ValuesMergeExpression).overlays).toEqual([ref, { extra: true }]);
  });

  it('keeps the defaults when an existing merge node has a CEL base', () => {
    const merged = withChartValueDefaults(defaults, mergeValuesExpression(cel, { extra: true }));
    expect(isValuesMergeExpression(merged)).toBe(true);
    expect((merged as ValuesMergeExpression).base).toEqual(defaults);
    expect((merged as ValuesMergeExpression).overlays).toEqual([cel, { extra: true }]);
  });

  it('still merges statically when an existing merge node has a plain base', () => {
    const merged = withChartValueDefaults(
      defaults,
      mergeValuesExpression({ replicaCount: 2 }, ref)
    );
    expect((merged as ValuesMergeExpression).base).toEqual({
      crds: { create: true, keep: false },
      replicaCount: 2,
    });
    expect((merged as ValuesMergeExpression).overlays).toEqual([ref]);
  });

  it('preserves nested defaults under a partial override in the deferred merge', () => {
    const merged = withChartValueDefaults(
      defaults,
      mergeValuesExpression(ref, { crds: { keep: true } })
    );
    // The reference is opaque until runtime, so materializing it here shows
    // only the halves that ARE known: the defaults, deep-merged under the
    // partial override rather than replaced by it.
    expect(
      materializeValuesMergeExpressions({
        ...(merged as ValuesMergeExpression),
        overlays: (merged as ValuesMergeExpression).overlays.slice(1),
      })
    ).toEqual({ crds: { create: true, keep: true }, replicaCount: 1 });
  });
});
