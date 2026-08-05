import { describe, expect, it } from 'bun:test';
import {
  materializeValuesMergeExpressions,
  mergeValuesExpression,
} from '../../src/core/aspects/values-merge.js';

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
