/**
 * Characterization tests for src/utils/helpers.ts
 *
 * These tests capture the CURRENT behavior of utility functions that manage
 * non-enumerable properties, serving as a safety net for the WeakMap migration
 * (Phase 2.6).
 *
 * Focus areas:
 *   1. removeUndefinedValues — recursive undefined stripping
 *   2. preserveNonEnumerableProperties — non-enumerable property transfer
 *   3. escapeRegExp — regex special character escaping
 *
 * @see src/utils/helpers.ts
 */

import { describe, expect, it } from 'bun:test';
import { getReadinessEvaluator, getResourceId } from '../../src/core/metadata/index.js';
import {
  escapeRegExp,
  preserveNonEnumerableProperties,
  removeUndefinedValues,
} from '../../src/utils/helpers.js';

// ===========================================================================
// 1. removeUndefinedValues
// ===========================================================================

describe('removeUndefinedValues', () => {
  it('returns null as-is', () => {
    expect(removeUndefinedValues(null)).toBeNull();
  });

  it('returns undefined as-is', () => {
    expect(removeUndefinedValues(undefined)).toBeUndefined();
  });

  it('returns primitives unchanged', () => {
    expect(removeUndefinedValues(42)).toBe(42);
    expect(removeUndefinedValues('hello')).toBe('hello');
    expect(removeUndefinedValues(true)).toBe(true);
    expect(removeUndefinedValues(0)).toBe(0);
    expect(removeUndefinedValues('')).toBe('');
    expect(removeUndefinedValues(false)).toBe(false);
  });

  it('removes undefined values from a flat object', () => {
    const input = { a: 1, b: undefined, c: 'hello' };
    const result = removeUndefinedValues(input);
    expect(result as unknown).toEqual({ a: 1, c: 'hello' });
    expect('b' in (result as Record<string, unknown>)).toBe(false);
  });

  it('preserves null values in objects', () => {
    const input = { a: null, b: 1 };
    expect(removeUndefinedValues(input)).toEqual({ a: null, b: 1 });
  });

  it('recursively removes undefined from nested objects', () => {
    const input = {
      a: 1,
      nested: {
        b: undefined,
        c: 3,
        deeper: {
          d: undefined,
          e: 5,
        },
      },
    };
    const result = removeUndefinedValues(input);
    expect(result as unknown).toEqual({
      a: 1,
      nested: {
        c: 3,
        deeper: { e: 5 },
      },
    });
  });

  it('filters undefined items from arrays', () => {
    const input = [1, undefined, 3, undefined, 5];
    expect(removeUndefinedValues(input)).toEqual([1, 3, 5]);
  });

  it('recursively cleans arrays of objects', () => {
    const input = [{ a: 1, b: undefined }, { c: undefined }];
    expect(removeUndefinedValues(input) as unknown).toEqual([{ a: 1 }, {}]);
  });

  it('preserves empty objects after cleanup', () => {
    const input = { a: undefined };
    // All values removed → empty object
    expect(removeUndefinedValues(input) as unknown).toEqual({});
  });

  it('preserves empty arrays after cleanup', () => {
    const input = [undefined, undefined];
    expect(removeUndefinedValues(input)).toEqual([]);
  });

  it('handles mixed nested structures', () => {
    const input = {
      values: {
        image: { tag: 'latest', pullPolicy: undefined },
        replicas: 3,
        env: [
          { name: 'FOO', value: 'bar' },
          { name: 'BAZ', value: undefined },
        ],
      },
    };
    expect(removeUndefinedValues(input) as unknown).toEqual({
      values: {
        image: { tag: 'latest' },
        replicas: 3,
        env: [{ name: 'FOO', value: 'bar' }, { name: 'BAZ' }],
      },
    });
  });
});

// ===========================================================================
// 2. preserveNonEnumerableProperties
// ===========================================================================

describe('preserveNonEnumerableProperties', () => {
  describe('readinessEvaluator', () => {
    it('copies readinessEvaluator from source to target via WeakMap metadata', () => {
      const evaluator = () => ({ ready: true, message: '' });
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, 'readinessEvaluator', {
        value: evaluator,
        enumerable: false,
      });

      const target: Record<string, unknown> = { kind: 'Service' };
      preserveNonEnumerableProperties(source, target);

      // readinessEvaluator is now stored in WeakMap, not as an object property
      expect(getReadinessEvaluator(target)).toBe(evaluator);
    });

    it('does NOT copy readinessEvaluator if source lacks it', () => {
      const source: Record<string, unknown> = { kind: 'Service' };
      const target: Record<string, unknown> = { kind: 'Service' };
      preserveNonEnumerableProperties(source, target);

      expect(Object.getOwnPropertyDescriptor(target, 'readinessEvaluator')).toBeUndefined();
    });

    it('does NOT copy readinessEvaluator if it is not a function', () => {
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, 'readinessEvaluator', {
        value: 'not-a-function',
        enumerable: false,
      });

      const target: Record<string, unknown> = {};
      preserveNonEnumerableProperties(source, target);

      // Non-function values should NOT be stored in WeakMap readinessEvaluator
      // (copyResourceMetadata only copies if desc.value !== undefined, and the
      // string value will be stored but getReadinessEvaluator won't return it
      // since it checks typeof === 'function')
      expect(getReadinessEvaluator(target)).toBeUndefined();
    });

    it('stores readinessEvaluator in WeakMap (not as object property)', () => {
      const evaluator = () => ({ ready: true, message: '' });
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, 'readinessEvaluator', {
        value: evaluator,
        enumerable: false,
      });

      const target: Record<string, unknown> = {};
      preserveNonEnumerableProperties(source, target);

      // readinessEvaluator is stored in WeakMap via copyResourceMetadata
      expect(getReadinessEvaluator(target)).toBe(evaluator);
      // Should NOT be a property on the target object
      expect(Object.getOwnPropertyDescriptor(target, 'readinessEvaluator')).toBeUndefined();
    });
  });

  describe('__resourceId', () => {
    it('copies __resourceId from source to target via WeakMap metadata', () => {
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, '__resourceId', {
        value: 'deploymentPostgres',
        enumerable: false,
      });

      const target: Record<string, unknown> = { kind: 'Deployment' };
      preserveNonEnumerableProperties(source, target);

      // __resourceId is now stored in WeakMap, not as an object property
      expect(getResourceId(target)).toBe('deploymentPostgres');
    });

    it('does NOT copy __resourceId if source lacks it', () => {
      const source: Record<string, unknown> = { kind: 'Service' };
      const target: Record<string, unknown> = { kind: 'Service' };
      preserveNonEnumerableProperties(source, target);

      expect(Object.getOwnPropertyDescriptor(target, '__resourceId')).toBeUndefined();
    });

    it('does NOT copy __resourceId if it is undefined', () => {
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, '__resourceId', {
        value: undefined,
        enumerable: false,
      });

      const target: Record<string, unknown> = {};
      preserveNonEnumerableProperties(source, target);

      // copyResourceMetadata skips undefined values
      expect(getResourceId(target)).toBeUndefined();
    });

    it('stores __resourceId in WeakMap (not as object property)', () => {
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, '__resourceId', {
        value: 'myId',
        enumerable: false,
      });

      const target: Record<string, unknown> = {};
      preserveNonEnumerableProperties(source, target);

      // __resourceId is stored in WeakMap
      expect(getResourceId(target)).toBe('myId');
      // Should NOT be a property on the target object
      expect(Object.getOwnPropertyDescriptor(target, '__resourceId')).toBeUndefined();
    });
  });

  describe('combined', () => {
    it('copies both properties when both exist', () => {
      const evaluator = () => ({ ready: false, message: 'waiting' });
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, 'readinessEvaluator', {
        value: evaluator,
        enumerable: false,
      });
      Object.defineProperty(source, '__resourceId', {
        value: 'svcBackend',
        enumerable: false,
      });

      const target: Record<string, unknown> = {};
      preserveNonEnumerableProperties(source, target);

      expect(getReadinessEvaluator(target)).toBe(evaluator);
      expect(getResourceId(target)).toBe('svcBackend');
    });

    it('does not affect existing enumerable properties on target', () => {
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, '__resourceId', {
        value: 'test',
        enumerable: false,
      });

      const target: Record<string, unknown> = { kind: 'Pod', apiVersion: 'v1' };
      preserveNonEnumerableProperties(source, target);

      expect(target.kind).toBe('Pod');
      expect(target.apiVersion).toBe('v1');
      expect(Object.keys(target)).toEqual(['kind', 'apiVersion']);
    });

    it('non-enumerable properties do not appear in Object.keys', () => {
      const evaluator = () => ({ ready: true, message: '' });
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, 'readinessEvaluator', {
        value: evaluator,
        enumerable: false,
      });
      Object.defineProperty(source, '__resourceId', {
        value: 'test',
        enumerable: false,
      });

      const target: Record<string, unknown> = { kind: 'Deployment' };
      preserveNonEnumerableProperties(source, target);

      // Non-enumerable properties must NOT appear in keys/entries
      expect(Object.keys(target)).toEqual(['kind']);
      expect(JSON.stringify(target)).toBe('{"kind":"Deployment"}');
    });

    it('non-enumerable properties do not survive JSON round-trip', () => {
      // This documents the core problem that WeakMap migration solves
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, '__resourceId', {
        value: 'myResource',
        enumerable: false,
      });

      const target: Record<string, unknown> = { kind: 'Service' };
      preserveNonEnumerableProperties(source, target);

      // JSON round-trip loses non-enumerable properties
      const roundTripped = JSON.parse(JSON.stringify(target));
      expect(roundTripped.__resourceId).toBeUndefined();
      expect(roundTripped.kind).toBe('Service');
    });

    it('non-enumerable properties do not survive object spread', () => {
      // This documents why preserveNonEnumerableProperties exists
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, '__resourceId', {
        value: 'myResource',
        enumerable: false,
      });
      Object.defineProperty(source, 'readinessEvaluator', {
        value: () => ({ ready: true, message: '' }),
        enumerable: false,
      });

      // Object spread loses non-enumerable properties
      const spread = { ...source };
      expect((spread as Record<string, unknown>).__resourceId).toBeUndefined();
      expect(spread.readinessEvaluator).toBeUndefined();
    });
  });
});

// ===========================================================================
// 3. escapeRegExp
// ===========================================================================

describe('escapeRegExp', () => {
  it('escapes dots', () => {
    expect(escapeRegExp('hello.world')).toBe('hello\\.world');
  });

  it('escapes asterisks', () => {
    expect(escapeRegExp('a*b')).toBe('a\\*b');
  });

  it('escapes plus signs', () => {
    expect(escapeRegExp('a+b')).toBe('a\\+b');
  });

  it('escapes question marks', () => {
    expect(escapeRegExp('a?b')).toBe('a\\?b');
  });

  it('escapes caret and dollar', () => {
    expect(escapeRegExp('^start$')).toBe('\\^start\\$');
  });

  it('escapes braces', () => {
    expect(escapeRegExp('a{1,3}')).toBe('a\\{1,3\\}');
  });

  it('escapes parentheses', () => {
    expect(escapeRegExp('(group)')).toBe('\\(group\\)');
  });

  it('escapes pipe', () => {
    expect(escapeRegExp('a|b')).toBe('a\\|b');
  });

  it('escapes brackets', () => {
    expect(escapeRegExp('[abc]')).toBe('\\[abc\\]');
  });

  it('escapes backslash', () => {
    expect(escapeRegExp('path\\to')).toBe('path\\\\to');
  });

  it('returns plain strings unchanged', () => {
    expect(escapeRegExp('hello-world')).toBe('hello-world');
    expect(escapeRegExp('my_resource_name')).toBe('my_resource_name');
  });

  it('escapes multiple special characters together', () => {
    const input = 'my-app.v1.0+build(1)';
    const escaped = escapeRegExp(input);
    // Should be safe for new RegExp()
    const regex = new RegExp(escaped);
    expect(regex.test(input)).toBe(true);
    expect(regex.test('my-appXv1X0Xbuild(1)')).toBe(false);
  });
});
