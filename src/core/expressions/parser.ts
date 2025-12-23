/**
 * Unified Acorn Parser Utility
 *
 * This module provides a centralized parser configuration for all JavaScript expression
 * parsing in TypeKro. It uses acorn with ES2022 support for modern JavaScript syntax
 * including optional chaining (?.) and nullish coalescing (??).
 *
 * Key Features:
 * - Unified parser configuration across all analyzers
 * - Native ES2022 support without preprocessing
 * - Enhanced error handling with source location information
 * - Suggestions for using explicit Cel API on parse failures
 *
 * @module parser
 */

import { Parser, type Options } from 'acorn';
import type { Node as ESTreeNode } from 'estree';

/**
 * Custom error class for parser errors with enhanced information
 */
export class ParserError extends Error {
  /** Line number where the error occurred (1-indexed) */
  public readonly line: number;

  /** Column number where the error occurred (0-indexed) */
  public readonly column: number;

  /** The original expression that failed to parse */
  public readonly originalExpression: string;

  /** Suggestions for fixing the error */
  public readonly suggestions: string[];

  constructor(
    message: string,
    line: number,
    column: number,
    originalExpression: string,
    suggestions: string[] = []
  ) {
    super(message);
    this.name = 'ParserError';
    this.line = line;
    this.column = column;
    this.originalExpression = originalExpression;
    this.suggestions = suggestions;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ParserError);
    }
  }

  /**
   * Create a ParserError from an acorn SyntaxError
   */
  static fromAcornError(
    error: SyntaxError & { loc?: { line: number; column: number }; pos?: number },
    expression: string
  ): ParserError {
    const line = error.loc?.line ?? 1;
    const column = error.loc?.column ?? 0;

    const suggestions = [
      'Check for syntax errors in your expression',
      'Consider using the explicit Cel API: Cel.expr(), Cel.template(), Cel.conditional()',
      'Ensure all brackets and parentheses are balanced',
      'Verify that all string literals are properly quoted',
    ];

    const enhancedMessage = `Parse error at line ${line}, column ${column}: ${error.message}`;

    return new ParserError(enhancedMessage, line, column, expression, suggestions);
  }

  /**
   * Format the error with context for debugging
   */
  toDetailedString(): string {
    const lines = [
      `ParserError: ${this.message}`,
      `  at line ${this.line}, column ${this.column}`,
      `  Expression: ${this.originalExpression.substring(0, 100)}${this.originalExpression.length > 100 ? '...' : ''}`,
    ];

    if (this.suggestions.length > 0) {
      lines.push('  Suggestions:');
      for (const suggestion of this.suggestions) {
        lines.push(`    - ${suggestion}`);
      }
    }

    return lines.join('\n');
  }
}


/**
 * Options for parsing expressions
 */
export interface ParseOptions {
  /** Source type for parsing ('script' or 'module') */
  sourceType?: 'script' | 'module';

  /** Whether to include location information in AST nodes */
  locations?: boolean;

  /** Whether to include range information in AST nodes */
  ranges?: boolean;

  /** ECMAScript version to use (default: 2022) */
  ecmaVersion?: 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 'latest';
}

/**
 * Result of a safe parse operation
 */
export interface ParseResult {
  /** The parsed AST (null if parsing failed) */
  ast: ESTreeNode | null;

  /** Parse errors encountered */
  errors: ParserError[];

  /** Whether parsing was successful */
  success: boolean;
}

/**
 * Default parser options for TypeKro expression analysis
 *
 * These options provide:
 * - ES2022 support for modern syntax (optional chaining, nullish coalescing)
 * - Location information for error reporting
 * - Range information for source mapping
 */
export const DEFAULT_PARSER_OPTIONS: Options = {
  ecmaVersion: 2022,
  sourceType: 'script',
  locations: true,
  ranges: true,
};

/**
 * Merge user options with default options
 */
function mergeOptions(userOptions?: ParseOptions): Options {
  return {
    ...DEFAULT_PARSER_OPTIONS,
    ...userOptions,
  };
}

/**
 * Parse a JavaScript expression using acorn
 *
 * This function parses a JavaScript expression string into an ESTree-compatible AST.
 * It uses acorn with ES2022 support for modern JavaScript syntax.
 *
 * @param expression - The JavaScript expression to parse
 * @param options - Optional parser configuration
 * @returns The parsed AST
 * @throws ParserError if parsing fails
 *
 * @example
 * ```typescript
 * // Parse a simple expression
 * const ast = parseExpression('a + b');
 *
 * // Parse with optional chaining (ES2020+)
 * const ast = parseExpression('obj?.prop?.nested');
 *
 * // Parse with nullish coalescing (ES2020+)
 * const ast = parseExpression('value ?? defaultValue');
 * ```
 */
export function parseExpression(expression: string, options?: ParseOptions): ESTreeNode {
  const mergedOptions = mergeOptions(options);

  try {
    // First try parsing as a standalone expression wrapped in parentheses
    // This handles most expression cases correctly
    const wrappedExpression = `(${expression})`;
    const ast = Parser.parse(wrappedExpression, mergedOptions) as unknown as ESTreeNode & {
      body: Array<{ type: string; expression: ESTreeNode }>;
    };

    // Extract the expression from the ExpressionStatement
    const firstBody = ast.body?.[0];
    if (firstBody && firstBody.type === 'ExpressionStatement' && firstBody.expression) {
      return firstBody.expression;
    }

    // If not an expression statement, return the first body element
    if (firstBody) {
      return firstBody as unknown as ESTreeNode;
    }

    throw new Error('Failed to extract expression from parsed AST');
  } catch (error) {
    // Try parsing without wrapping (for statements or complex expressions)
    try {
      const ast = Parser.parse(expression, mergedOptions) as unknown as ESTreeNode & {
        body: Array<{ type: string; expression?: ESTreeNode }>;
      };

      const firstStatement = ast.body?.[0];
      if (firstStatement) {
        if (firstStatement.type === 'ExpressionStatement' && firstStatement.expression) {
          return firstStatement.expression;
        }
        return firstStatement as unknown as ESTreeNode;
      }

      throw new Error('Empty AST body');
    } catch {
      // Use the original error for better error messages
      if (error instanceof SyntaxError) {
        throw ParserError.fromAcornError(
          error as SyntaxError & { loc?: { line: number; column: number } },
          expression
        );
      }
      throw error;
    }
  }
}

/**
 * Parse a JavaScript expression with error handling
 *
 * This function provides a safe way to parse expressions, returning a result object
 * instead of throwing exceptions. This is useful for validation and error reporting.
 *
 * @param expression - The JavaScript expression to parse
 * @param options - Optional parser configuration
 * @returns A ParseResult object containing the AST or errors
 *
 * @example
 * ```typescript
 * const result = parseExpressionSafe('a + b');
 * if (result.success) {
 *   console.log('Parsed successfully:', result.ast);
 * } else {
 *   console.log('Parse errors:', result.errors);
 * }
 * ```
 */
export function parseExpressionSafe(expression: string, options?: ParseOptions): ParseResult {
  try {
    const ast = parseExpression(expression, options);
    return {
      ast,
      errors: [],
      success: true,
    };
  } catch (error) {
    const parserError =
      error instanceof ParserError
        ? error
        : ParserError.fromAcornError(
            error as SyntaxError & { loc?: { line: number; column: number } },
            expression
          );

    return {
      ast: null,
      errors: [parserError],
      success: false,
    };
  }
}

/**
 * Check if an expression can be parsed successfully
 *
 * This is a quick validation function that returns true if the expression
 * is syntactically valid JavaScript.
 *
 * @param expression - The JavaScript expression to validate
 * @param options - Optional parser configuration
 * @returns true if the expression can be parsed, false otherwise
 *
 * @example
 * ```typescript
 * canParse('a + b')           // true
 * canParse('a +')             // false (incomplete expression)
 * canParse('obj?.prop')       // true (optional chaining)
 * canParse('a ?? b')          // true (nullish coalescing)
 * ```
 */
export function canParse(expression: string, options?: ParseOptions): boolean {
  const result = parseExpressionSafe(expression, options);
  return result.success;
}

/**
 * Parse a complete JavaScript program/script
 *
 * This function parses a complete JavaScript program, including function declarations,
 * statements, and expressions. It's useful for analyzing function bodies.
 *
 * @param source - The JavaScript source code to parse
 * @param options - Optional parser configuration
 * @returns The parsed AST
 * @throws ParserError if parsing fails
 */
export function parseScript(source: string, options?: ParseOptions): ESTreeNode {
  const mergedOptions = mergeOptions(options);

  try {
    return Parser.parse(source, mergedOptions) as unknown as ESTreeNode;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw ParserError.fromAcornError(
        error as SyntaxError & { loc?: { line: number; column: number } },
        source
      );
    }
    throw error;
  }
}

/**
 * Parse a complete JavaScript program/script with error handling
 *
 * @param source - The JavaScript source code to parse
 * @param options - Optional parser configuration
 * @returns A ParseResult object containing the AST or errors
 */
export function parseScriptSafe(source: string, options?: ParseOptions): ParseResult {
  try {
    const ast = parseScript(source, options);
    return {
      ast,
      errors: [],
      success: true,
    };
  } catch (error) {
    const parserError =
      error instanceof ParserError
        ? error
        : ParserError.fromAcornError(
            error as SyntaxError & { loc?: { line: number; column: number } },
            source
          );

    return {
      ast: null,
      errors: [parserError],
      success: false,
    };
  }
}
