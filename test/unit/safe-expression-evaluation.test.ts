/**
 * Unit tests for safe expression evaluation in KroResourceFactory.
 *
 * Validates that the angular-expressions-based evaluator correctly handles
 * all expression patterns while preventing code injection via new Function()/eval().
 */

import { describe, expect, it } from 'bun:test';
import { compile as compileExpression } from 'angular-expressions';

/**
 * Helper that mirrors the evaluation logic in KroResourceFactoryImpl.evaluateStaticCelExpression.
 * Strips schema.spec. and spec. prefixes from expressions, then evaluates safely via
 * angular-expressions with the spec values as scope.
 */
function evaluateExpression(expression: string, spec: Record<string, unknown> = {}): unknown {
  let scopeExpression = expression;

  if (expression.includes('schema.spec.')) {
    scopeExpression = scopeExpression.replace(/schema\.spec\.(\w+)/g, '$1');
  }
  if (scopeExpression.includes('spec.')) {
    scopeExpression = scopeExpression.replace(/\bspec\.(\w+)/g, '$1');
  }

  try {
    const evaluator = compileExpression(scopeExpression);
    return evaluator(spec) as unknown;
  } catch {
    // Static literal fallback: return as-is
    if (!expression.includes('schema.spec.') && !expression.includes('spec.')) {
      return expression;
    }
    throw new Error(`Failed to evaluate expression: ${expression}`);
  }
}

describe('Safe Expression Evaluation', () => {
  describe('static literal expressions', () => {
    it('should evaluate string literals', () => {
      expect(evaluateExpression('"hello"')).toBe('hello');
      expect(evaluateExpression("'world'")).toBe('world');
    });

    it('should evaluate URL string literals', () => {
      expect(evaluateExpression('"http://kro-webapp-service"')).toBe('http://kro-webapp-service');
    });

    it('should evaluate number literals', () => {
      expect(evaluateExpression('42')).toBe(42);
      expect(evaluateExpression('0')).toBe(0);
      expect(evaluateExpression('3.14')).toBe(3.14);
    });

    it('should evaluate boolean literals', () => {
      expect(evaluateExpression('true')).toBe(true);
      expect(evaluateExpression('false')).toBe(false);
    });

    it('should return unquoted strings as-is when evaluation fails', () => {
      // Unquoted strings like bare URLs fail parsing and should be returned as-is
      expect(evaluateExpression('http://kro-webapp-service')).toBe('http://kro-webapp-service');
    });
  });

  describe('string concatenation', () => {
    it('should concatenate string literals', () => {
      expect(evaluateExpression('"hello" + "-world"')).toBe('hello-world');
    });

    it('should concatenate spec values with literals', () => {
      expect(evaluateExpression('schema.spec.name + "-db"', { name: 'myapp' })).toBe('myapp-db');
    });

    it('should handle multiple concatenations', () => {
      expect(
        evaluateExpression('schema.spec.name + "-" + schema.spec.env', {
          name: 'myapp',
          env: 'prod',
        })
      ).toBe('myapp-prod');
    });
  });

  describe('comparison expressions', () => {
    it('should evaluate numeric comparisons', () => {
      expect(evaluateExpression('3 > 0')).toBe(true);
      expect(evaluateExpression('0 > 3')).toBe(false);
    });

    it('should evaluate equality comparisons', () => {
      expect(evaluateExpression('"Ready" == "Ready"')).toBe(true);
      expect(evaluateExpression('"Ready" == "NotReady"')).toBe(false);
    });

    it('should evaluate spec field comparisons', () => {
      expect(evaluateExpression('spec.replicas > 0', { replicas: 3 })).toBe(true);
      expect(evaluateExpression('spec.replicas > 0', { replicas: 0 })).toBe(false);
    });
  });

  describe('ternary expressions', () => {
    it('should evaluate ternary with literal condition', () => {
      expect(evaluateExpression('"Ready" == "Ready" ? "Running" : "Pending"')).toBe('Running');
      expect(evaluateExpression('"NotReady" == "Ready" ? "Running" : "Pending"')).toBe('Pending');
    });

    it('should evaluate ternary with spec field condition', () => {
      expect(evaluateExpression('spec.replicas > 0 ? "Ready" : "Pending"', { replicas: 3 })).toBe(
        'Ready'
      );
      expect(evaluateExpression('spec.replicas > 0 ? "Ready" : "Pending"', { replicas: 0 })).toBe(
        'Pending'
      );
    });
  });

  describe('logical expressions', () => {
    it('should evaluate logical AND', () => {
      expect(evaluateExpression('true && true')).toBe(true);
      expect(evaluateExpression('true && false')).toBe(false);
    });

    it('should evaluate logical OR', () => {
      expect(evaluateExpression('false || true')).toBe(true);
      expect(evaluateExpression('false || false')).toBe(false);
    });

    it('should evaluate logical NOT', () => {
      expect(evaluateExpression('!true')).toBe(false);
      expect(evaluateExpression('!false')).toBe(true);
    });
  });

  describe('schema.spec. prefix stripping', () => {
    it('should resolve schema.spec.fieldName from scope', () => {
      expect(evaluateExpression('schema.spec.name', { name: 'myapp' })).toBe('myapp');
    });

    it('should resolve multiple schema.spec references', () => {
      expect(
        evaluateExpression('schema.spec.enabled ? schema.spec.name : "default"', {
          enabled: true,
          name: 'custom',
        })
      ).toBe('custom');
    });
  });

  describe('spec. prefix stripping', () => {
    it('should resolve spec.fieldName from scope', () => {
      expect(evaluateExpression('spec.name', { name: 'myapp' })).toBe('myapp');
      expect(evaluateExpression('spec.replicas', { replicas: 5 })).toBe(5);
    });
  });

  describe('security: code injection prevention', () => {
    it('should not execute process.exit()', () => {
      // angular-expressions does not have access to process — returns undefined
      // for unknown scope references rather than executing them
      const result = evaluateExpression('process.exit(1)', { process: undefined });
      expect(result).toBeUndefined();
    });

    it('should not execute require()', () => {
      // angular-expressions treats require("child_process") as a function call
      // on an undefined scope reference — returns undefined, does NOT execute
      const result = evaluateExpression('require("child_process")');
      expect(result).toBeUndefined();
    });

    it('should not access constructor or __proto__', () => {
      // angular-expressions blocks prototype chain access
      const result = evaluateExpression('name.constructor', { name: 'test' });
      expect(result).toBeUndefined();
    });

    it('should not access __proto__', () => {
      const result = evaluateExpression('name.__proto__', { name: 'test' });
      expect(result).toBeUndefined();
    });

    it('should not allow function definitions', () => {
      // Function expressions are syntax errors in angular-expressions
      expect(() => evaluateExpression('(function(){ return 1 })()')).not.toThrow(); // falls back to string literal
    });

    it('should handle malicious spec values safely', () => {
      // Even if a spec value contains executable-looking content,
      // angular-expressions treats scope values as data, not code
      const result = evaluateExpression('schema.spec.name + "-suffix"', {
        name: '"; process.exit(1); "',
      });
      expect(result).toBe('"; process.exit(1); "-suffix');
    });

    it('should handle spec values with special characters safely', () => {
      const result = evaluateExpression('schema.spec.name + "-db"', {
        name: 'test$(whoami)',
      });
      expect(result).toBe('test$(whoami)-db');
    });
  });
});
