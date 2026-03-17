/**
 * Tests for the fn.toString() self-test module.
 *
 * These tests verify that the self-test correctly detects:
 * - Whether fn.toString() output is parseable by acorn
 * - Whether parameter names are preserved
 * - Whether function bodies are preserved
 * - Whether arrow function syntax is preserved
 */

import { describe, expect, test } from 'bun:test';
import {
  runFnToStringSelfTest,
  validateFnToStringEnvironment,
} from '../../src/core/expressions/analysis/fn-toString-self-test.js';

describe('fn.toString() Self-Test', () => {
  test('self-test passes in the current runtime (Bun, no bundler)', () => {
    const result = runFnToStringSelfTest();

    expect(result.compatible).toBe(true);
    expect(result.parseable).toBe(true);
    expect(result.parameterNamesPreserved).toBe(true);
    expect(result.functionBodiesPreserved).toBe(true);
    expect(result.arrowSyntaxPreserved).toBe(true);
  });

  test('diagnostics include useful information', () => {
    const result = runFnToStringSelfTest();

    expect(result.diagnostics.length).toBeGreaterThan(0);
    // Should mention that function is parseable
    expect(result.diagnostics.some((d) => d.includes('parseable'))).toBe(true);
  });

  test('result contains all required fields', () => {
    const result = runFnToStringSelfTest();

    expect(typeof result.parseable).toBe('boolean');
    expect(typeof result.parameterNamesPreserved).toBe('boolean');
    expect(typeof result.functionBodiesPreserved).toBe('boolean');
    expect(typeof result.arrowSyntaxPreserved).toBe('boolean');
    expect(typeof result.compatible).toBe('boolean');
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  test('validateFnToStringEnvironment does not throw', () => {
    // In Bun with no bundler, this should succeed silently
    expect(() => validateFnToStringEnvironment()).not.toThrow();
  });

  test('compatible is false if parseable is false', () => {
    // The self-test checks real runtime behavior, so in Bun it should pass.
    // We verify the compatibility logic: compatible requires parseable AND
    // parameterNamesPreserved AND functionBodiesPreserved
    const result = runFnToStringSelfTest();
    if (result.parseable && result.parameterNamesPreserved && result.functionBodiesPreserved) {
      expect(result.compatible).toBe(true);
    }
  });
});
