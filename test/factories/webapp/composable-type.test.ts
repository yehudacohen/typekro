/**
 * Type-level tests for the Composable<T> utility type.
 *
 * These tests verify at compile time that Composable:
 * - Preserves required fields (compile error if missing)
 * - Makes optional fields accept undefined
 * - Recurses into nested objects
 * - Passes arrays through unchanged
 * - Passes built-in object types through unchanged
 */

import { describe, expect, it } from 'bun:test';
import type { Composable } from '../../../src/core/types/composable.js';

// ── Test interfaces ──────────────────────────────────────────────────

interface TestConfig {
  requiredString: string;
  requiredNumber: number;
  optionalString?: string;
  optionalNumber?: number;
  requiredObject: {
    nestedRequired: string;
    nestedOptional?: boolean;
  };
  optionalObject?: {
    innerRequired: string;
    innerOptional?: number;
  };
  requiredArray: string[];
  optionalArray?: number[];
  optionalUnion?: 'a' | 'b' | 'c';
}

// ── Type-level assertions (compile-time) ─────────────────────────────

// These assignments verify the type system at compile time.
// If Composable breaks, this file won't compile.

function acceptsComposable(_config: Composable<TestConfig>) {}

describe('Composable<T> type utility', () => {
  it('should accept all required fields with correct types', () => {
    // This compiles — all required fields present
    acceptsComposable({
      requiredString: 'hello',
      requiredNumber: 42,
      requiredObject: { nestedRequired: 'yes' },
      requiredArray: ['a', 'b'],
    });
    expect(true).toBe(true);
  });

  it('should accept undefined for optional fields', () => {
    const maybeString: string | undefined = undefined;
    const maybeNumber: number | undefined = undefined;
    const maybeUnion: 'a' | 'b' | 'c' | undefined = undefined;

    // This compiles — optional fields accept undefined
    acceptsComposable({
      requiredString: 'hello',
      requiredNumber: 42,
      requiredObject: {
        nestedRequired: 'yes',
        nestedOptional: undefined,
      },
      requiredArray: ['a'],
      optionalString: maybeString,
      optionalNumber: maybeNumber,
      optionalUnion: maybeUnion,
      optionalObject: undefined,
      optionalArray: undefined,
    });
    expect(true).toBe(true);
  });

  it('should accept omitted optional fields', () => {
    // This compiles — optional fields can be entirely omitted
    acceptsComposable({
      requiredString: 'hello',
      requiredNumber: 42,
      requiredObject: { nestedRequired: 'yes' },
      requiredArray: ['a'],
      // optionalString, optionalNumber, optionalObject, optionalArray all omitted
    });
    expect(true).toBe(true);
  });

  it('should preserve arrays without recursing', () => {
    // This compiles — arrays pass through as-is
    acceptsComposable({
      requiredString: 'hello',
      requiredNumber: 42,
      requiredObject: { nestedRequired: 'yes' },
      requiredArray: ['a', 'b', 'c'],
      optionalArray: [1, 2, 3],
    });
    expect(true).toBe(true);
  });

  it('should recurse into nested optional objects', () => {
    const maybeNumber: number | undefined = undefined;

    // This compiles — nested optional fields accept undefined
    acceptsComposable({
      requiredString: 'hello',
      requiredNumber: 42,
      requiredObject: { nestedRequired: 'yes' },
      requiredArray: [],
      optionalObject: {
        innerRequired: 'yes',  // still required inside optional object
        innerOptional: maybeNumber,
      },
    });
    expect(true).toBe(true);
  });

  // ── Negative tests (verified by @ts-expect-error) ──────────────────

  it('should reject missing required fields', () => {
    // @ts-expect-error — requiredString is missing
    acceptsComposable({
      requiredNumber: 42,
      requiredObject: { nestedRequired: 'yes' },
      requiredArray: [],
    });

    // @ts-expect-error — requiredObject is missing
    acceptsComposable({
      requiredString: 'hello',
      requiredNumber: 42,
      requiredArray: [],
    });

    // @ts-expect-error — nestedRequired is missing inside requiredObject
    acceptsComposable({
      requiredString: 'hello',
      requiredNumber: 42,
      requiredObject: {},
      requiredArray: [],
    });

    expect(true).toBe(true);
  });

  it('should reject undefined for required fields', () => {
    // @ts-expect-error — requiredString can't be undefined
    acceptsComposable({
      requiredString: undefined,
      requiredNumber: 42,
      requiredObject: { nestedRequired: 'yes' },
      requiredArray: [],
    });

    // @ts-expect-error — nestedRequired can't be undefined
    acceptsComposable({
      requiredString: 'hello',
      requiredNumber: 42,
      requiredObject: { nestedRequired: undefined },
      requiredArray: [],
    });

    expect(true).toBe(true);
  });
});
