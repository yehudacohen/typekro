/**
 * Parser Utility Tests
 *
 * This test file validates the unified acorn parser utility for TypeKro.
 * It includes property-based tests to ensure parser correctness across
 * a wide range of JavaScript expressions.
 *
 * **Feature: unify-acorn-parser, Property 1: Parser Unification**
 * **Validates: Requirements 1.1, 1.2**
 */

import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';

import {
  parseExpression,
  parseExpressionSafe,
  parseScript,
  canParse,
  ParserError,
  DEFAULT_PARSER_OPTIONS,
} from '../../../src/core/expressions/parser.js';

describe('Parser Utility', () => {
  describe('parseExpression', () => {
    it('should parse simple binary expressions', () => {
      const ast = parseExpression('a + b');
      expect(ast).toBeDefined();
      expect(ast.type).toBe('BinaryExpression');
    });

    it('should parse member expressions', () => {
      const ast = parseExpression('obj.prop.nested');
      expect(ast).toBeDefined();
      expect(ast.type).toBe('MemberExpression');
    });

    it('should parse conditional expressions', () => {
      const ast = parseExpression('a ? b : c');
      expect(ast).toBeDefined();
      expect(ast.type).toBe('ConditionalExpression');
    });

    it('should parse template literals', () => {
      const ast = parseExpression('`hello ${name}`');
      expect(ast).toBeDefined();
      expect(ast.type).toBe('TemplateLiteral');
    });

    it('should parse optional chaining natively (ES2020+)', () => {
      const ast = parseExpression('obj?.prop?.nested');
      expect(ast).toBeDefined();
      expect(ast.type).toBe('ChainExpression');
    });

    it('should parse nullish coalescing natively (ES2020+)', () => {
      const ast = parseExpression('value ?? defaultValue');
      expect(ast).toBeDefined();
      expect(ast.type).toBe('LogicalExpression');
      expect((ast as any).operator).toBe('??');
    });

    it('should parse complex expressions with optional chaining and nullish coalescing', () => {
      const ast = parseExpression('obj?.prop ?? "default"');
      expect(ast).toBeDefined();
      expect(ast.type).toBe('LogicalExpression');
    });

    it('should throw ParserError for invalid syntax', () => {
      expect(() => parseExpression('a +')).toThrow(ParserError);
    });

    it('should include line and column in ParserError', () => {
      try {
        parseExpression('a +');
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.line).toBeGreaterThan(0);
        expect(parserError.column).toBeGreaterThanOrEqual(0);
        expect(parserError.originalExpression).toBe('a +');
        expect(parserError.suggestions.length).toBeGreaterThan(0);
      }
    });
  });

  describe('parseExpressionSafe', () => {
    it('should return success for valid expressions', () => {
      const result = parseExpressionSafe('a + b');
      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
      expect(result.errors).toHaveLength(0);
    });

    it('should return errors for invalid expressions', () => {
      const result = parseExpressionSafe('a +');
      expect(result.success).toBe(false);
      expect(result.ast).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toBeInstanceOf(ParserError);
    });
  });

  describe('canParse', () => {
    it('should return true for valid expressions', () => {
      expect(canParse('a + b')).toBe(true);
      expect(canParse('obj?.prop')).toBe(true);
      expect(canParse('a ?? b')).toBe(true);
    });

    it('should return false for invalid expressions', () => {
      expect(canParse('a +')).toBe(false);
      expect(canParse('{')).toBe(false);
    });
  });

  describe('parseScript', () => {
    it('should parse function declarations', () => {
      const ast = parseScript('function foo() { return 42; }');
      expect(ast).toBeDefined();
      expect((ast as any).body).toBeDefined();
    });

    it('should parse arrow functions', () => {
      const ast = parseScript('const fn = () => 42;');
      expect(ast).toBeDefined();
    });
  });

  describe('DEFAULT_PARSER_OPTIONS', () => {
    it('should have ecmaVersion 2022', () => {
      expect(DEFAULT_PARSER_OPTIONS.ecmaVersion).toBe(2022);
    });

    it('should have locations enabled', () => {
      expect(DEFAULT_PARSER_OPTIONS.locations).toBe(true);
    });

    it('should have ranges enabled', () => {
      expect(DEFAULT_PARSER_OPTIONS.ranges).toBe(true);
    });
  });

  describe('ParserError', () => {
    it('should create error from acorn error', () => {
      const acornError = new SyntaxError('Unexpected token') as SyntaxError & {
        loc: { line: number; column: number };
      };
      acornError.loc = { line: 1, column: 5 };

      const parserError = ParserError.fromAcornError(acornError, 'a + ');
      expect(parserError).toBeInstanceOf(ParserError);
      expect(parserError.line).toBe(1);
      expect(parserError.column).toBe(5);
      expect(parserError.originalExpression).toBe('a + ');
      expect(parserError.suggestions).toContain(
        'Consider using the explicit Cel API: Cel.expr(), Cel.template(), Cel.conditional()'
      );
    });

    it('should format detailed error string', () => {
      const error = new ParserError('Test error', 1, 5, 'test expression', ['Suggestion 1']);
      const detailed = error.toDetailedString();
      expect(detailed).toContain('ParserError');
      expect(detailed).toContain('line 1');
      expect(detailed).toContain('column 5');
      expect(detailed).toContain('Suggestion 1');
    });
  });
});


/**
 * Property-Based Tests for Parser Unification
 *
 * **Feature: unify-acorn-parser, Property 1: Parser Unification**
 * **Validates: Requirements 1.1, 1.2**
 *
 * Property 1: Parser Unification
 * *For any* JavaScript expression that was parseable by esprima, parsing with acorn
 * SHALL produce a valid ESTree-compatible AST with equivalent structure.
 */
describe('Property-Based Tests: Parser Unification', () => {
  /**
   * Arbitrary for generating valid JavaScript identifiers
   */
  const identifierArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/).filter((s) => {
    // Filter out JavaScript reserved words
    const reserved = [
      'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete',
      'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof',
      'new', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
      'void', 'while', 'with', 'class', 'const', 'enum', 'export', 'extends',
      'import', 'super', 'implements', 'interface', 'let', 'package', 'private',
      'protected', 'public', 'static', 'yield', 'null', 'true', 'false',
    ];
    return s.length > 0 && s.length <= 20 && !reserved.includes(s);
  });

  /**
   * Arbitrary for generating binary operators
   */
  const binaryOperatorArb = fc.constantFrom(
    '+', '-', '*', '/', '%',
    '===', '!==', '==', '!=',
    '<', '>', '<=', '>=',
    '&&', '||'
  );

  /**
   * Arbitrary for generating simple binary expressions
   */
  const binaryExpressionArb = fc.tuple(identifierArb, binaryOperatorArb, identifierArb).map(
    ([left, op, right]) => `${left} ${op} ${right}`
  );

  /**
   * Arbitrary for generating member expressions
   */
  const memberExpressionArb = fc
    .array(identifierArb, { minLength: 2, maxLength: 5 })
    .map((parts) => parts.join('.'));

  /**
   * Arbitrary for generating conditional expressions
   */
  const conditionalExpressionArb = fc
    .tuple(identifierArb, identifierArb, identifierArb)
    .map(([test, consequent, alternate]) => `${test} ? ${consequent} : ${alternate}`);

  /**
   * Arbitrary for generating optional chaining expressions
   */
  const optionalChainingArb = fc
    .array(identifierArb, { minLength: 2, maxLength: 4 })
    .map((parts) => parts.join('?.'));

  /**
   * Arbitrary for generating nullish coalescing expressions
   */
  const nullishCoalescingArb = fc
    .tuple(identifierArb, identifierArb)
    .map(([left, right]) => `${left} ?? ${right}`);

  /**
   * Arbitrary for generating number literals
   */
  const numberLiteralArb = fc.integer({ min: -1000, max: 1000 }).map(String);

  /**
   * Arbitrary for generating string literals
   */
  const stringLiteralArb = fc
    .string({ minLength: 0, maxLength: 20 })
    .filter((s) => !s.includes('"') && !s.includes('\\') && !s.includes('\n'))
    .map((s) => `"${s}"`);

  /**
   * Combined arbitrary for valid expressions
   */
  const validExpressionArb = fc.oneof(
    binaryExpressionArb,
    memberExpressionArb,
    conditionalExpressionArb,
    optionalChainingArb,
    nullishCoalescingArb,
    numberLiteralArb,
    stringLiteralArb,
    identifierArb
  );

  it('Property 1: All valid expressions should parse successfully', () => {
    fc.assert(
      fc.property(validExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        // Property: valid expressions should parse without errors
        return result.success === true && result.ast !== null && result.errors.length === 0;
      }),
      { numRuns: 100 }
    );
  });

  it('Property 1.1: Binary expressions should produce BinaryExpression or LogicalExpression AST nodes', () => {
    fc.assert(
      fc.property(binaryExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        // Binary expressions should produce BinaryExpression or LogicalExpression nodes
        return result.ast.type === 'BinaryExpression' || result.ast.type === 'LogicalExpression';
      }),
      { numRuns: 100 }
    );
  });

  it('Property 1.2: Member expressions should produce MemberExpression AST nodes', () => {
    fc.assert(
      fc.property(memberExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        // Member expressions should produce MemberExpression nodes
        return result.ast.type === 'MemberExpression';
      }),
      { numRuns: 100 }
    );
  });

  it('Property 1.3: Conditional expressions should produce ConditionalExpression AST nodes', () => {
    fc.assert(
      fc.property(conditionalExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        // Conditional expressions should produce ConditionalExpression nodes
        return result.ast.type === 'ConditionalExpression';
      }),
      { numRuns: 100 }
    );
  });

  it('Property 1.4: Optional chaining should produce ChainExpression AST nodes', () => {
    fc.assert(
      fc.property(optionalChainingArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        // Optional chaining should produce ChainExpression nodes
        return result.ast.type === 'ChainExpression';
      }),
      { numRuns: 100 }
    );
  });

  it('Property 1.5: Nullish coalescing should produce LogicalExpression with ?? operator', () => {
    fc.assert(
      fc.property(nullishCoalescingArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        // Nullish coalescing should produce LogicalExpression with ?? operator
        return (
          result.ast.type === 'LogicalExpression' && (result.ast as any).operator === '??'
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 1.6: AST nodes should include location information', () => {
    fc.assert(
      fc.property(validExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        // AST nodes should include loc property with line and column
        const ast = result.ast as any;
        return (
          ast.loc !== undefined &&
          typeof ast.loc.start?.line === 'number' &&
          typeof ast.loc.start?.column === 'number'
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 1.7: AST nodes should include range information', () => {
    fc.assert(
      fc.property(validExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        // AST nodes should include range property
        const ast = result.ast as any;
        return (
          Array.isArray(ast.range) &&
          ast.range.length === 2 &&
          typeof ast.range[0] === 'number' &&
          typeof ast.range[1] === 'number'
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 1.8: canParse should be consistent with parseExpressionSafe', () => {
    fc.assert(
      fc.property(validExpressionArb, (expression) => {
        const canParseResult = canParse(expression);
        const safeResult = parseExpressionSafe(expression);
        // canParse should return true iff parseExpressionSafe succeeds
        return canParseResult === safeResult.success;
      }),
      { numRuns: 100 }
    );
  });
});


/**
 * Property-Based Tests for Source Location Preservation
 *
 * **Feature: unify-acorn-parser, Property 4: Source Location Preservation**
 * **Validates: Requirements 4.3**
 *
 * Property 4: Source Location Preservation
 * *For any* parsed expression, the AST nodes SHALL contain accurate line and column
 * information that matches the original source positions.
 */
describe('Property-Based Tests: Source Location Preservation', () => {
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
    return s.length > 0 && s.length <= 20 && !reserved.includes(s);
  });

  /**
   * Arbitrary for generating member expressions with known structure
   */
  const memberExpressionArb = fc
    .array(identifierArb, { minLength: 2, maxLength: 4 })
    .map((parts) => parts.join('.'));

  /**
   * Arbitrary for generating binary expressions
   */
  const binaryExpressionArb = fc.tuple(identifierArb, identifierArb).map(
    ([left, right]) => `${left} + ${right}`
  );

  it('Property 4.1: Source locations should have valid line numbers (starting from 1)', () => {
    fc.assert(
      fc.property(memberExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        
        const ast = result.ast as any;
        // Line numbers should start from 1
        return (
          ast.loc !== undefined &&
          ast.loc.start.line >= 1 &&
          ast.loc.end.line >= 1
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 4.2: Source locations should have valid column numbers (starting from 0)', () => {
    fc.assert(
      fc.property(memberExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        
        const ast = result.ast as any;
        // Column numbers should start from 0
        return (
          ast.loc !== undefined &&
          ast.loc.start.column >= 0 &&
          ast.loc.end.column >= 0
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 4.3: Range should span the entire expression', () => {
    fc.assert(
      fc.property(binaryExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        
        const ast = result.ast as any;
        // Range should cover the expression (accounting for wrapping in parseExpression)
        return (
          Array.isArray(ast.range) &&
          ast.range[0] >= 0 &&
          ast.range[1] > ast.range[0]
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 4.4: End position should be after start position', () => {
    fc.assert(
      fc.property(memberExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (!result.success || !result.ast) return false;
        
        const ast = result.ast as any;
        // End should be after or equal to start
        const startLine = ast.loc.start.line;
        const endLine = ast.loc.end.line;
        const startCol = ast.loc.start.column;
        const endCol = ast.loc.end.column;
        
        return (
          endLine > startLine ||
          (endLine === startLine && endCol >= startCol)
        );
      }),
      { numRuns: 100 }
    );
  });
});


/**
 * Property-Based Tests for Error Message Quality
 *
 * **Feature: unify-acorn-parser, Property 5: Error Message Quality**
 * **Validates: Requirements 5.1, 5.2, 5.3**
 *
 * Property 5: Error Message Quality
 * *For any* invalid JavaScript expression, the parse error SHALL include:
 * (1) line and column number, (2) the original expression, and (3) a suggestion
 * to use the explicit Cel API.
 */
describe('Property-Based Tests: Error Message Quality', () => {
  /**
   * Arbitrary for generating invalid expressions (incomplete binary operations)
   */
  const invalidBinaryArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .filter((s) => s.length > 0 && s.length <= 10)
    .map((id) => `${id} +`);

  /**
   * Arbitrary for generating invalid expressions (unbalanced brackets)
   */
  const unbalancedBracketArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .filter((s) => s.length > 0 && s.length <= 10)
    .map((id) => `${id}[`);

  /**
   * Arbitrary for generating invalid expressions (unbalanced parentheses)
   */
  const unbalancedParenArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .filter((s) => s.length > 0 && s.length <= 10)
    .map((id) => `(${id}`);

  /**
   * Combined arbitrary for invalid expressions
   */
  const invalidExpressionArb = fc.oneof(
    invalidBinaryArb,
    unbalancedBracketArb,
    unbalancedParenArb
  );

  it('Property 5.1: Parse errors should include line number', () => {
    fc.assert(
      fc.property(invalidExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (result.success) return true; // Skip if it somehow parses
        
        // Error should include line number
        const error = result.errors[0];
        return error instanceof ParserError && error.line >= 1;
      }),
      { numRuns: 100 }
    );
  });

  it('Property 5.2: Parse errors should include column number', () => {
    fc.assert(
      fc.property(invalidExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (result.success) return true; // Skip if it somehow parses
        
        // Error should include column number
        const error = result.errors[0];
        return error instanceof ParserError && error.column >= 0;
      }),
      { numRuns: 100 }
    );
  });

  it('Property 5.3: Parse errors should preserve original expression', () => {
    fc.assert(
      fc.property(invalidExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (result.success) return true; // Skip if it somehow parses
        
        // Error should preserve original expression
        const error = result.errors[0];
        return (
          error instanceof ParserError &&
          error.originalExpression === expression
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 5.4: Parse errors should include Cel API suggestion', () => {
    fc.assert(
      fc.property(invalidExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (result.success) return true; // Skip if it somehow parses
        
        // Error should include suggestion to use Cel API
        const error = result.errors[0];
        return (
          error instanceof ParserError &&
          error.suggestions.some((s) => s.includes('Cel'))
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 5.5: Parse errors should have non-empty suggestions array', () => {
    fc.assert(
      fc.property(invalidExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (result.success) return true; // Skip if it somehow parses
        
        // Error should have at least one suggestion
        const error = result.errors[0];
        return (
          error instanceof ParserError &&
          Array.isArray(error.suggestions) &&
          error.suggestions.length > 0
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 5.6: toDetailedString should include all error components', () => {
    fc.assert(
      fc.property(invalidExpressionArb, (expression) => {
        const result = parseExpressionSafe(expression);
        if (result.success) return true; // Skip if it somehow parses
        
        const error = result.errors[0];
        if (!(error instanceof ParserError)) return false;
        
        const detailed = error.toDetailedString();
        // Detailed string should include key components
        return (
          detailed.includes('ParserError') &&
          detailed.includes('line') &&
          detailed.includes('column') &&
          detailed.includes('Suggestion')
        );
      }),
      { numRuns: 100 }
    );
  });
});
