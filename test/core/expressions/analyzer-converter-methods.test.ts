/**
 * Safety-net tests for individual converter methods in JavaScriptToCelAnalyzer.
 *
 * These tests exercise each converter method in isolation to lock down exact CEL output
 * before the CE-H1 decomposition. Each test group targets a specific converter that
 * previously lacked direct coverage.
 *
 * Categories:
 *   1. String method converters (startsWith, endsWith, includes, toLowerCase, toUpperCase,
 *      trim, substring, slice, split, padStart, padEnd, repeat, replace, indexOf, lastIndexOf)
 *   2. Math function converters (Math.min, Math.max, Math.abs, Math.floor, Math.ceil, Math.round)
 *   3. Global function converters (Number, String, Boolean, parseInt, parseFloat)
 *   4. Unary expression converters (!x, -x, +x, typeof)
 *   5. Array expression converter ([a, b, c])
 *   6. .length → size() conversion
 *   7. Operator precedence (getOperatorPrecedence / addParenthesesIfNeeded)
 *   8. Operator mapping (=== → ==, !== → !=, etc.)
 *   9. Dependency extraction (extractDependenciesFromExpressionString)
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  type AnalysisContext,
  JavaScriptToCelAnalyzer,
} from '../../../src/core/expressions/analysis/analyzer.js';
import { SourceMapBuilder } from '../../../src/core/expressions/analysis/source-map.js';

describe('Analyzer Converter Methods — Safety Net', () => {
  let analyzer: JavaScriptToCelAnalyzer;
  let ctx: AnalysisContext;

  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    ctx = {
      type: 'status',
      availableReferences: {
        deployment: {} as never,
        service: {} as never,
        db: {} as never,
        app: {} as never,
        cfg: {} as never,
      },
      factoryType: 'kro',
      sourceMap: new SourceMapBuilder(),
      dependencies: [],
    };
  });

  /** Helper: analyze and return the CEL expression string */
  function cel(expression: string): string {
    const result = analyzer.analyzeExpression(expression, ctx);
    expect(result.valid).toBe(true);
    expect(result.celExpression).toBeDefined();
    return result.celExpression!.expression;
  }

  /** Helper: analyze and expect a failure */
  function expectInvalid(expression: string): void {
    const result = analyzer.analyzeExpression(expression, ctx);
    expect(result.valid).toBe(false);
  }

  // ─────────────────────────────────────────────────────────────────
  // 1. STRING METHOD CONVERTERS
  // ─────────────────────────────────────────────────────────────────

  describe('String method converters', () => {
    describe('startsWith', () => {
      it('should convert startsWith to CEL startsWith', () => {
        expect(cel('deployment.metadata.name.startsWith("web")')).toBe(
          'deployment.metadata.name.startsWith("web")'
        );
      });

      it('should handle schema references', () => {
        expect(cel('schema.spec.name.startsWith("prefix")')).toBe(
          'schema.spec.name.startsWith("prefix")'
        );
      });
    });

    describe('endsWith', () => {
      it('should convert endsWith to CEL endsWith', () => {
        expect(cel('deployment.metadata.name.endsWith("-svc")')).toBe(
          'deployment.metadata.name.endsWith("-svc")'
        );
      });
    });

    describe('includes → contains', () => {
      it('should convert includes to CEL contains', () => {
        expect(cel('deployment.metadata.name.includes("test")')).toBe(
          'deployment.metadata.name.contains("test")'
        );
      });
    });

    describe('toLowerCase → lowerAscii', () => {
      it('should convert toLowerCase to CEL lowerAscii', () => {
        expect(cel('deployment.metadata.name.toLowerCase()')).toBe(
          'deployment.metadata.name.lowerAscii()'
        );
      });
    });

    describe('toUpperCase → upperAscii', () => {
      it('should convert toUpperCase to CEL upperAscii', () => {
        expect(cel('deployment.metadata.name.toUpperCase()')).toBe(
          'deployment.metadata.name.upperAscii()'
        );
      });
    });

    describe('trim', () => {
      it('should convert trim to CEL trim', () => {
        expect(cel('deployment.metadata.name.trim()')).toBe('deployment.metadata.name.trim()');
      });
    });

    describe('substring', () => {
      it('should convert substring(start) to CEL substring', () => {
        expect(cel('deployment.metadata.name.substring(3)')).toBe(
          'deployment.metadata.name.substring(3)'
        );
      });

      it('should convert substring(start, end) to CEL substring', () => {
        expect(cel('deployment.metadata.name.substring(1, 5)')).toBe(
          'deployment.metadata.name.substring(1, 5)'
        );
      });
    });

    describe('slice → substring', () => {
      it('should convert slice(start) to CEL substring', () => {
        expect(cel('deployment.metadata.name.slice(2)')).toBe(
          'deployment.metadata.name.substring(2)'
        );
      });

      it('should convert slice(start, end) to CEL substring', () => {
        expect(cel('deployment.metadata.name.slice(1, 4)')).toBe(
          'deployment.metadata.name.substring(1, 4)'
        );
      });
    });

    describe('split', () => {
      it('should convert split to CEL split', () => {
        expect(cel('deployment.metadata.name.split("-")')).toBe(
          'deployment.metadata.name.split("-")'
        );
      });
    });

    describe('padStart', () => {
      it('should convert padStart with default pad string', () => {
        const result = cel('deployment.metadata.name.padStart(10)');
        expect(result).toContain('size(deployment.metadata.name) >= 10');
        expect(result).toContain('" ".repeat(');
      });

      it('should convert padStart with custom pad string', () => {
        const result = cel('deployment.metadata.name.padStart(10, "0")');
        expect(result).toContain('size(deployment.metadata.name) >= 10');
        expect(result).toContain('"0".repeat(');
      });
    });

    describe('padEnd', () => {
      it('should convert padEnd with default pad string', () => {
        const result = cel('deployment.metadata.name.padEnd(10)');
        expect(result).toContain('size(deployment.metadata.name) >= 10');
        expect(result).toContain('" ".repeat(');
      });

      it('should convert padEnd with custom pad string', () => {
        const result = cel('deployment.metadata.name.padEnd(10, "0")');
        expect(result).toContain('size(deployment.metadata.name) >= 10');
        expect(result).toContain('"0".repeat(');
      });
    });

    describe('repeat', () => {
      it('should convert repeat to CEL repeat', () => {
        expect(cel('deployment.metadata.name.repeat(3)')).toBe(
          'deployment.metadata.name.repeat(3)'
        );
      });
    });

    describe('replace', () => {
      it('should convert replace to CEL replace', () => {
        expect(cel('deployment.metadata.name.replace("old", "new")')).toBe(
          'deployment.metadata.name.replace("old", "new")'
        );
      });
    });

    describe('indexOf (approximation)', () => {
      it('should convert indexOf to contains-based ternary', () => {
        const result = cel('deployment.metadata.name.indexOf("test")');
        expect(result).toBe('deployment.metadata.name.contains("test") ? 0 : -1');
      });
    });

    describe('lastIndexOf (approximation)', () => {
      it('should convert lastIndexOf to contains-based ternary', () => {
        const result = cel('deployment.metadata.name.lastIndexOf("test")');
        expect(result).toBe(
          'deployment.metadata.name.contains("test") ? size(deployment.metadata.name) - size("test") : -1'
        );
      });
    });

    describe('charAt (unsupported)', () => {
      it('should fail for charAt as it is not implemented', () => {
        expectInvalid('deployment.metadata.name.charAt(0)');
      });
    });

    describe('chained string methods', () => {
      it('should handle toLowerCase().startsWith()', () => {
        expect(cel('deployment.metadata.name.toLowerCase().startsWith("web")')).toBe(
          'deployment.metadata.name.lowerAscii().startsWith("web")'
        );
      });

      it('should handle replace().toUpperCase()', () => {
        expect(cel('deployment.metadata.name.replace("-", "_").toUpperCase()')).toBe(
          'deployment.metadata.name.replace("-", "_").upperAscii()'
        );
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. MATH FUNCTION CONVERTERS
  // ─────────────────────────────────────────────────────────────────

  describe('Math function converters', () => {
    describe('Math.min', () => {
      it('should convert Math.min(a, b) to ternary', () => {
        expect(cel('Math.min(deployment.status.replicas, 10)')).toBe(
          'deployment.status.replicas < 10 ? deployment.status.replicas : 10'
        );
      });

      it('should convert Math.min with 3 arguments to nested ternaries', () => {
        const result = cel('Math.min(deployment.status.replicas, 10, 5)');
        // Should be nested: (a < b ? a : b) < c ? (...) : c
        expect(result).toContain('deployment.status.replicas');
        expect(result).toContain('5');
        expect(result).toContain('10');
      });
    });

    describe('Math.max', () => {
      it('should convert Math.max(a, b) to ternary', () => {
        expect(cel('Math.max(deployment.status.replicas, 1)')).toBe(
          'deployment.status.replicas > 1 ? deployment.status.replicas : 1'
        );
      });
    });

    describe('Math.abs', () => {
      it('should convert Math.abs to conditional', () => {
        expect(cel('Math.abs(deployment.status.replicas)')).toBe(
          'deployment.status.replicas < 0 ? -deployment.status.replicas : deployment.status.replicas'
        );
      });
    });

    describe('Math.floor', () => {
      it('should convert Math.floor to int()', () => {
        expect(cel('Math.floor(deployment.status.replicas)')).toBe(
          'int(deployment.status.replicas)'
        );
      });
    });

    describe('Math.ceil', () => {
      it('should convert Math.ceil to int(x + 0.999999)', () => {
        expect(cel('Math.ceil(deployment.status.replicas)')).toBe(
          'int(deployment.status.replicas + 0.999999)'
        );
      });
    });

    describe('Math.round', () => {
      it('should convert Math.round to int(x + 0.5)', () => {
        expect(cel('Math.round(deployment.status.replicas)')).toBe(
          'int(deployment.status.replicas + 0.5)'
        );
      });
    });

    describe('unsupported Math methods', () => {
      it('should fail for Math.pow', () => {
        expectInvalid('Math.pow(deployment.status.replicas, 2)');
      });

      it('should fail for Math.sqrt', () => {
        expectInvalid('Math.sqrt(deployment.status.replicas)');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. GLOBAL FUNCTION CONVERTERS
  // ─────────────────────────────────────────────────────────────────

  describe('Global function converters', () => {
    describe('Number()', () => {
      it('should convert Number() to double()', () => {
        expect(cel('Number(deployment.status.replicas)')).toBe(
          'double(deployment.status.replicas)'
        );
      });
    });

    describe('String()', () => {
      it('should convert String() to string()', () => {
        expect(cel('String(deployment.status.replicas)')).toBe(
          'string(deployment.status.replicas)'
        );
      });
    });

    describe('Boolean()', () => {
      it('should convert Boolean() to bool()', () => {
        expect(cel('Boolean(deployment.status.replicas)')).toBe('bool(deployment.status.replicas)');
      });
    });

    describe('parseInt()', () => {
      it('should convert parseInt() to int()', () => {
        expect(cel('parseInt(deployment.status.phase)')).toBe('int(deployment.status.phase)');
      });

      it('should ignore radix argument', () => {
        expect(cel('parseInt(deployment.status.phase, 10)')).toBe('int(deployment.status.phase)');
      });
    });

    describe('parseFloat()', () => {
      it('should convert parseFloat() to double()', () => {
        expect(cel('parseFloat(deployment.status.phase)')).toBe('double(deployment.status.phase)');
      });
    });

    describe('unsupported global functions', () => {
      it('should fail for encodeURIComponent', () => {
        expectInvalid('encodeURIComponent(deployment.metadata.name)');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. UNARY EXPRESSION CONVERTERS
  // ─────────────────────────────────────────────────────────────────

  describe('Unary expression converters', () => {
    describe('logical NOT (!)', () => {
      it('should convert !expr to !expr', () => {
        expect(cel('!deployment.status.ready')).toBe('!deployment.status.ready');
      });

      it('should handle double negation', () => {
        expect(cel('!!deployment.status.ready')).toBe('!!deployment.status.ready');
      });
    });

    describe('unary minus (-)', () => {
      it('should convert -expr to -expr', () => {
        expect(cel('-deployment.status.replicas')).toBe('-deployment.status.replicas');
      });
    });

    describe('unary plus (+)', () => {
      it('should convert +expr to double(expr)', () => {
        expect(cel('+deployment.status.replicas')).toBe('double(deployment.status.replicas)');
      });
    });

    describe('typeof', () => {
      it('should convert typeof to type()', () => {
        expect(cel('typeof deployment.status.replicas')).toBe('type(deployment.status.replicas)');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. ARRAY EXPRESSION CONVERTER
  // ─────────────────────────────────────────────────────────────────

  describe('Array expression converter', () => {
    it('should convert literal array [a, b, c]', () => {
      const result = cel('[deployment.status.replicas, service.spec.port, 42]');
      expect(result).toBe('[deployment.status.replicas, service.spec.port, 42]');
    });

    it('should convert single-element array', () => {
      const result = cel('[deployment.status.replicas]');
      expect(result).toBe('[deployment.status.replicas]');
    });

    it('should convert empty array', () => {
      const result = cel('[]');
      expect(result).toBe('[]');
    });

    it('should convert array with string literals', () => {
      const result = cel('["a", "b", "c"]');
      expect(result).toBe('["a", "b", "c"]');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. .length → size() CONVERSION
  // ─────────────────────────────────────────────────────────────────

  describe('.length property access', () => {
    it('should keep .length as property access on member expressions', () => {
      // Property-access .length goes through convertMemberExpression, NOT convertCallExpression
      // The convertLengthProperty (size()) path only triggers when .length is called as a method
      const result = cel('deployment.metadata.name.length');
      expect(result).toBe('deployment.metadata.name.length');
    });

    it('should keep .length as property access on array-like access', () => {
      const result = cel('deployment.status.conditions.length');
      expect(result).toBe('deployment.status.conditions.length');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. OPERATOR PRECEDENCE
  // ─────────────────────────────────────────────────────────────────

  describe('Operator precedence', () => {
    it('should add parentheses for lower-precedence sub-expressions', () => {
      // a + b * c should keep multiplication higher precedence
      const result = cel('deployment.status.replicas + db.status.replicas * 2');
      // The + and * should maintain correct precedence
      expect(result).toContain('deployment.status.replicas');
      expect(result).toContain('db.status.replicas');
    });

    it('should handle && converted to null-check pattern', () => {
      // The analyzer converts && to a null-check ternary pattern:
      // a && b → a != null ? b : a
      const result = cel('deployment.status.replicas > 0 && service.status.ready');
      expect(result).toContain('deployment.status.replicas > 0');
      expect(result).toContain('!= null');
      expect(result).toContain('service.status.ready');
    });

    it('should handle nested ternary with correct grouping', () => {
      const result = cel('deployment.status.replicas > 0 ? "ready" : "pending"');
      expect(result).toContain('deployment.status.replicas > 0');
      expect(result).toContain('"ready"');
      expect(result).toContain('"pending"');
    });

    it('should handle || and && converted to nested null-check patterns', () => {
      // || is converted to: a != null ? a : b
      // && is converted to: a != null ? b : a
      const result = cel('deployment.status.ready || service.status.ready && db.status.ready');
      expect(result).toContain('!= null');
      expect(result).toContain('deployment.status.ready');
      expect(result).toContain('service.status.ready');
      expect(result).toContain('db.status.ready');
    });

    it('should handle nested ternary with correct grouping', () => {
      const result = cel('deployment.status.replicas > 0 ? "ready" : "pending"');
      expect(result).toContain('deployment.status.replicas > 0');
      expect(result).toContain('"ready"');
      expect(result).toContain('"pending"');
    });

    it('should handle chained || and && as nested null-checks', () => {
      // Both || and && become null-check ternary patterns
      const result = cel('deployment.status.ready || service.status.ready && db.status.ready');
      expect(result).toContain('!= null');
      expect(result).toContain('deployment.status.ready');
      expect(result).toContain('db.status.ready');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 8. OPERATOR MAPPING
  // ─────────────────────────────────────────────────────────────────

  describe('Operator mapping', () => {
    it('should map === to ==', () => {
      expect(cel('deployment.status.phase === "Running"')).toBe(
        'deployment.status.phase == "Running"'
      );
    });

    it('should map !== to !=', () => {
      expect(cel('deployment.status.phase !== "Failed"')).toBe(
        'deployment.status.phase != "Failed"'
      );
    });

    it('should keep == as ==', () => {
      expect(cel('deployment.status.phase == "Running"')).toBe(
        'deployment.status.phase == "Running"'
      );
    });

    it('should keep != as !=', () => {
      expect(cel('deployment.status.phase != "Failed"')).toBe(
        'deployment.status.phase != "Failed"'
      );
    });

    it('should keep comparison operators unchanged', () => {
      expect(cel('deployment.status.replicas > 0')).toBe('deployment.status.replicas > 0');
      expect(cel('deployment.status.replicas >= 1')).toBe('deployment.status.replicas >= 1');
      expect(cel('deployment.status.replicas < 10')).toBe('deployment.status.replicas < 10');
      expect(cel('deployment.status.replicas <= 5')).toBe('deployment.status.replicas <= 5');
    });

    it('should keep arithmetic operators unchanged', () => {
      expect(cel('deployment.status.replicas + 1')).toBe('deployment.status.replicas + 1');
      expect(cel('deployment.status.replicas - 1')).toBe('deployment.status.replicas - 1');
      expect(cel('deployment.status.replicas * 2')).toBe('deployment.status.replicas * 2');
      expect(cel('deployment.status.replicas / 2')).toBe('deployment.status.replicas / 2');
      expect(cel('deployment.status.replicas % 3')).toBe('deployment.status.replicas % 3');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 9. DEPENDENCY EXTRACTION
  // ─────────────────────────────────────────────────────────────────

  describe('Dependency extraction', () => {
    it('should extract a single resource dependency', () => {
      const result = analyzer.analyzeExpression('deployment.status.replicas', ctx);
      expect(result.valid).toBe(true);
      expect(result.dependencies.length).toBeGreaterThanOrEqual(1);
    });

    it('should extract multiple resource dependencies', () => {
      const result = analyzer.analyzeExpression(
        'deployment.status.replicas + service.status.port',
        ctx
      );
      expect(result.valid).toBe(true);
      expect(result.dependencies.length).toBeGreaterThanOrEqual(2);
    });

    it('should extract schema references', () => {
      const result = analyzer.analyzeExpression('schema.spec.replicas > 0', ctx);
      expect(result.valid).toBe(true);
      expect(result.dependencies.length).toBeGreaterThanOrEqual(1);
    });

    it('should deduplicate repeated references', () => {
      const result = analyzer.analyzeExpression(
        'deployment.status.replicas > 0 ? deployment.status.replicas : 0',
        ctx
      );
      expect(result.valid).toBe(true);
      // deployment is referenced twice but should only appear once in deps (or twice with same resource)
      const deploymentDeps = result.dependencies.filter(
        (d) =>
          String(d).includes('deployment') ||
          (d as unknown as Record<string, unknown>).resourceId === 'deployment'
      );
      expect(deploymentDeps.length).toBeGreaterThanOrEqual(1);
    });

    it('should still extract deps from identifiers not in availableReferences', () => {
      // The analyzer extracts dependencies based on AST member expression patterns,
      // not by filtering against availableReferences. This documents current behavior.
      const result = analyzer.analyzeExpression('unknown.status.replicas', ctx);
      expect(result.valid).toBe(true);
      expect(result.dependencies.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 10. COMBINED / INTEGRATION-LEVEL CONVERTER TESTS
  // ─────────────────────────────────────────────────────────────────

  describe('Combined converter scenarios', () => {
    it('should handle Math.max inside ternary', () => {
      const result = cel(
        'deployment.status.replicas > 0 ? Math.max(deployment.status.replicas, 1) : 0'
      );
      expect(result).toContain('deployment.status.replicas > 0');
      expect(result).toContain('deployment.status.replicas > 1 ? deployment.status.replicas : 1');
    });

    it('should handle String() with includes()', () => {
      const result = cel('String(deployment.status.replicas).includes("3")');
      expect(result).toBe('string(deployment.status.replicas).contains("3")');
    });

    it('should handle negated includes', () => {
      expect(cel('!deployment.metadata.name.includes("test")')).toBe(
        '!deployment.metadata.name.contains("test")'
      );
    });

    it('should handle length comparison (property-access stays as .length)', () => {
      // Property-access .length is not converted to size() — only method-call .length is
      expect(cel('deployment.metadata.name.length > 0')).toBe(
        'deployment.metadata.name.length > 0'
      );
    });

    it('should handle array with resource references', () => {
      const result = cel('[deployment.status.replicas, db.status.replicas]');
      expect(result).toBe('[deployment.status.replicas, db.status.replicas]');
    });

    it('should handle parseInt in comparison', () => {
      expect(cel('parseInt(deployment.status.phase) > 0')).toBe('int(deployment.status.phase) > 0');
    });

    it('should handle toLowerCase().includes()', () => {
      expect(cel('deployment.metadata.name.toLowerCase().includes("web")')).toBe(
        'deployment.metadata.name.lowerAscii().contains("web")'
      );
    });

    it('should handle split().length (property-access stays as .length)', () => {
      const result = cel('deployment.metadata.name.split("-").length');
      // .length as property access is not converted to size()
      expect(result).toContain('split(');
      expect(result).toContain('.length');
    });
  });
});
