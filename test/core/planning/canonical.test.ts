import { describe, expect, it } from 'bun:test';

import {
  canonicalDigest,
  CanonicalizationError,
  canonicalStringify,
} from '../../../src/core/planning/canonical.js';

describe('semantic plan canonicalization', () => {
  it('sorts keys recursively and normalizes negative zero', () => {
    const left = { z: [{ b: -0, a: 1 }], a: { d: true, c: null } };
    const right = { a: { c: null, d: true }, z: [{ a: 1, b: 0 }] };

    expect(canonicalStringify(left)).toBe(canonicalStringify(right));
    expect(canonicalDigest(left)).toBe(canonicalDigest(right));
  });

  it.each([
    ['undefined', { value: undefined }],
    ['non-finite number', { value: Number.POSITIVE_INFINITY }],
    ['function', { value: () => true }],
    ['bigint', { value: 1n }],
  ])('rejects non-canonical %s values', (_label, value) => {
    expect(() => canonicalStringify(value)).toThrow(CanonicalizationError);
  });

  it('rejects circular data with a source path', () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(() => canonicalStringify(value)).toThrow('Circular object at $.self');
  });
});
