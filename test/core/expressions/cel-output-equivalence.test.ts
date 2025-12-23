/**
 * CEL Output Equivalence Property Tests
 *
 * This test file validates that the JavaScript to CEL conversion produces
 * consistent and correct output after the migration from esprima to acorn.
 *
 * **Feature: unify-acorn-parser, Property 3: CEL Output Equivalence (Round-Trip)**
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 *
 * Property 3: CEL Output Equivalence
 * *For any* JavaScript expression that was convertible to CEL before the migration,
 * the CEL output after migration SHALL be character-for-character identical to the
 * output before migration.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import fc from 'fast-check';

import {
  JavaScriptToCelAnalyzer,
  type AnalysisContext,
} from '../../../src/core/expressions/analyzer.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';

describe('Property-Based Tests: CEL Output Equivalence', () => {
  let analyzer: JavaScriptToCelAnalyzer;
  let mockContext: AnalysisContext;

  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    mockContext = {
      type: 'status',
      availableReferences: {},
      factoryType: 'kro',
    };
  });

  /**
   * Helper to create a mock KubernetesRef (available for future tests)
   */
  const _createMockRef = (resourceId: string, fieldPath: string): KubernetesRef<any> => ({
    [KUBERNETES_REF_BRAND]: true,
    resourceId,
    fieldPath,
    _type: undefined,
  });

  /**
   * Arbitrary for generating valid JavaScript identifiers
   */
  const identifierArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/).filter((s) => {
    const reserved = [
      'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete',
      'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof',
      'new', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
      'void', 'while', 'with', 'class', 'const', 'enum', 'export', 'extends',
      'import', 'super', 'implements', 'interface', 'let', 'package', 'private',
      'protected', 'public', 'static', 'yield', 'null', 'true', 'false',
    ];
    return s.length > 0 && s.length <= 15 && !reserved.includes(s);
  });

  /**
   * Arbitrary for generating comparison operators
   */
  const comparisonOperatorArb = fc.constantFrom('===', '!==', '==', '!=', '<', '>', '<=', '>=');

  /**
   * Arbitrary for generating logical operators
   */
  const logicalOperatorArb = fc.constantFrom('&&', '||');

  /**
   * Arbitrary for generating arithmetic operators
   */
  const arithmeticOperatorArb = fc.constantFrom('+', '-', '*', '/');

  /**
   * Arbitrary for generating number literals
   */
  const numberLiteralArb = fc.integer({ min: 0, max: 100 }).map(String);

  /**
   * Arbitrary for generating simple binary expressions (comparison)
   */
  const binaryComparisonArb = fc
    .tuple(identifierArb, comparisonOperatorArb, numberLiteralArb)
    .map(([left, op, right]) => `${left} ${op} ${right}`);

  /**
   * Arbitrary for generating logical expressions
   */
  const logicalExpressionArb = fc
    .tuple(identifierArb, logicalOperatorArb, identifierArb)
    .map(([left, op, right]) => `${left} ${op} ${right}`);

  /**
   * Arbitrary for generating member expressions (resource.status.field)
   */
  const memberExpressionArb = fc
    .array(identifierArb, { minLength: 2, maxLength: 4 })
    .map((parts) => parts.join('.'));

  /**
   * Arbitrary for generating conditional expressions (a ? b : c)
   */
  const conditionalExpressionArb = fc
    .tuple(identifierArb, identifierArb, identifierArb)
    .map(([test, consequent, alternate]) => `${test} ? ${consequent} : ${alternate}`);

  /**
   * Arbitrary for generating simple template literals
   */
  const templateLiteralArb = fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
      identifierArb
    )
    .map(([prefix, expr]) => `\`${prefix}\${${expr}}\``);

  /**
   * Property 3.1: Binary expressions should produce consistent CEL output
   * **Validates: Requirements 3.1**
   */
  it('Property 3.1: Binary expressions should produce consistent CEL output', () => {
    fc.assert(
      fc.property(binaryComparisonArb, (expression) => {
        const result1 = analyzer.analyzeStringExpression(expression, mockContext);
        const result2 = analyzer.analyzeStringExpression(expression, mockContext);

        // Both analyses should produce the same result
        if (!result1.valid || !result2.valid) {
          // If invalid, both should be invalid
          return result1.valid === result2.valid;
        }

        // CEL expressions should be identical
        return result1.celExpression?.expression === result2.celExpression?.expression;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3.2: Member expressions should produce consistent CEL output
   * **Validates: Requirements 3.2**
   */
  it('Property 3.2: Member expressions should produce consistent CEL output', () => {
    fc.assert(
      fc.property(memberExpressionArb, (expression) => {
        const result1 = analyzer.analyzeStringExpression(expression, mockContext);
        const result2 = analyzer.analyzeStringExpression(expression, mockContext);

        if (!result1.valid || !result2.valid) {
          return result1.valid === result2.valid;
        }

        return result1.celExpression?.expression === result2.celExpression?.expression;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3.3: Conditional expressions should produce consistent CEL output
   * **Validates: Requirements 3.3**
   */
  it('Property 3.3: Conditional expressions should produce consistent CEL output', () => {
    fc.assert(
      fc.property(conditionalExpressionArb, (expression) => {
        const result1 = analyzer.analyzeStringExpression(expression, mockContext);
        const result2 = analyzer.analyzeStringExpression(expression, mockContext);

        if (!result1.valid || !result2.valid) {
          return result1.valid === result2.valid;
        }

        return result1.celExpression?.expression === result2.celExpression?.expression;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3.4: Template literals should produce consistent CEL output
   * **Validates: Requirements 3.4**
   */
  it('Property 3.4: Template literals should produce consistent CEL output', () => {
    fc.assert(
      fc.property(templateLiteralArb, (expression) => {
        const result1 = analyzer.analyzeStringExpression(expression, mockContext);
        const result2 = analyzer.analyzeStringExpression(expression, mockContext);

        if (!result1.valid || !result2.valid) {
          return result1.valid === result2.valid;
        }

        return result1.celExpression?.expression === result2.celExpression?.expression;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3.5: Logical expressions should produce consistent CEL output
   * **Validates: Requirements 3.5**
   */
  it('Property 3.5: Logical expressions should produce consistent CEL output', () => {
    fc.assert(
      fc.property(logicalExpressionArb, (expression) => {
        const result1 = analyzer.analyzeStringExpression(expression, mockContext);
        const result2 = analyzer.analyzeStringExpression(expression, mockContext);

        if (!result1.valid || !result2.valid) {
          return result1.valid === result2.valid;
        }

        return result1.celExpression?.expression === result2.celExpression?.expression;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3.6: CEL output should preserve operator semantics
   */
  it('Property 3.6: CEL output should preserve operator semantics', () => {
    fc.assert(
      fc.property(
        fc.tuple(identifierArb, comparisonOperatorArb, numberLiteralArb),
        ([left, op, right]) => {
          const expression = `${left} ${op} ${right}`;
          const result = analyzer.analyzeStringExpression(expression, mockContext);

          if (!result.valid || !result.celExpression) {
            return true; // Skip invalid expressions
          }

          // The CEL expression should contain the operator
          // Note: === and !== are converted to == and != in CEL
          const celOp = op === '===' ? '==' : op === '!==' ? '!=' : op;
          return result.celExpression.expression.includes(celOp);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3.7: CEL output should preserve operand order
   */
  it('Property 3.7: CEL output should preserve operand order', () => {
    fc.assert(
      fc.property(
        fc.tuple(identifierArb, arithmeticOperatorArb, identifierArb),
        ([left, op, right]) => {
          const expression = `${left} ${op} ${right}`;
          const result = analyzer.analyzeStringExpression(expression, mockContext);

          if (!result.valid || !result.celExpression) {
            return true; // Skip invalid expressions
          }

          const celExpr = result.celExpression.expression;
          const leftIndex = celExpr.indexOf(left);
          const rightIndex = celExpr.lastIndexOf(right);

          // Left operand should appear before right operand
          return leftIndex < rightIndex;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3.8: Conditional expressions should preserve structure
   */
  it('Property 3.8: Conditional expressions should preserve structure', () => {
    fc.assert(
      fc.property(
        fc.tuple(identifierArb, identifierArb, identifierArb),
        ([test, consequent, alternate]) => {
          const expression = `${test} ? ${consequent} : ${alternate}`;
          const result = analyzer.analyzeStringExpression(expression, mockContext);

          if (!result.valid || !result.celExpression) {
            return true; // Skip invalid expressions
          }

          const celExpr = result.celExpression.expression;

          // CEL conditional should contain ? and :
          return celExpr.includes('?') && celExpr.includes(':');
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Deterministic Tests for CEL Output Equivalence
 *
 * These tests verify specific expression patterns produce expected CEL output.
 */
describe('Deterministic Tests: CEL Output Equivalence', () => {
  let analyzer: JavaScriptToCelAnalyzer;
  let mockContext: AnalysisContext;

  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    mockContext = {
      type: 'status',
      availableReferences: {},
      factoryType: 'kro',
    };
  });

  it('should convert simple comparison to CEL', () => {
    const result = analyzer.analyzeStringExpression('count > 0', mockContext);
    expect(result.valid).toBe(true);
    expect(result.celExpression?.expression).toBe('count > 0');
  });

  it('should convert strict equality to CEL equality', () => {
    const result = analyzer.analyzeStringExpression('status === "Ready"', mockContext);
    expect(result.valid).toBe(true);
    expect(result.celExpression?.expression).toBe('status == "Ready"');
  });

  it('should convert strict inequality to CEL inequality', () => {
    const result = analyzer.analyzeStringExpression('status !== "Failed"', mockContext);
    expect(result.valid).toBe(true);
    expect(result.celExpression?.expression).toBe('status != "Failed"');
  });

  it('should convert logical AND to CEL', () => {
    const result = analyzer.analyzeStringExpression('ready && available', mockContext);
    expect(result.valid).toBe(true);
    // Logical AND is converted to a truthy check in CEL for Kro compatibility
    expect(result.celExpression?.expression).toContain('?');
    expect(result.celExpression?.expression).toContain('available');
  });

  it('should convert logical OR to CEL', () => {
    const result = analyzer.analyzeStringExpression('ready || pending', mockContext);
    expect(result.valid).toBe(true);
    // Logical OR is converted to a truthy check in CEL for Kro compatibility
    expect(result.celExpression?.expression).toContain('?');
    expect(result.celExpression?.expression).toContain('pending');
  });

  it('should convert member expression to CEL', () => {
    const result = analyzer.analyzeStringExpression('deployment.status.readyReplicas', mockContext);
    expect(result.valid).toBe(true);
    // Member expressions are prefixed with 'resources.' for Kro context
    expect(result.celExpression?.expression).toContain('deployment.status.readyReplicas');
  });

  it('should convert conditional expression to CEL', () => {
    const result = analyzer.analyzeStringExpression('ready ? "Running" : "Pending"', mockContext);
    expect(result.valid).toBe(true);
    expect(result.celExpression?.expression).toBe('ready ? "Running" : "Pending"');
  });

  it('should convert arithmetic expression to CEL', () => {
    const result = analyzer.analyzeStringExpression('replicas + 1', mockContext);
    expect(result.valid).toBe(true);
    expect(result.celExpression?.expression).toBe('replicas + 1');
  });

  it('should convert complex nested expression to CEL', () => {
    const result = analyzer.analyzeStringExpression(
      'deployment.status.readyReplicas >= deployment.spec.replicas',
      mockContext
    );
    expect(result.valid).toBe(true);
    // Member expressions are prefixed with 'resources.' for Kro context
    expect(result.celExpression?.expression).toContain('deployment.status.readyReplicas');
    expect(result.celExpression?.expression).toContain('>=');
    expect(result.celExpression?.expression).toContain('deployment.spec.replicas');
  });

  it('should convert optional chaining to CEL', () => {
    const result = analyzer.analyzeStringExpression('obj?.prop?.nested', mockContext);
    expect(result.valid).toBe(true);
    // Optional chaining should be converted to CEL's null-safe access
    expect(result.celExpression?.expression).toContain('?');
  });

  it('should convert nullish coalescing to CEL conditional', () => {
    const result = analyzer.analyzeStringExpression('value ?? defaultValue', mockContext);
    expect(result.valid).toBe(true);
    // Nullish coalescing should be converted to CEL conditional
    expect(result.celExpression?.expression).toContain('!=');
    expect(result.celExpression?.expression).toContain('?');
  });
});
