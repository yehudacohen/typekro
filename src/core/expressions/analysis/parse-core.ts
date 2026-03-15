/**
 * Core Acorn Parse Utilities
 *
 * Low-level parsing functions and error classes that do NOT depend on the
 * fn.toString() self-test. This module exists to break the circular dependency
 * between parser.ts and fn-toString-self-test.ts: the self-test needs to parse
 * code, but the parser calls the self-test on first use. By extracting the raw
 * parse logic and ParserError here, both modules can import from this file
 * without creating a cycle.
 *
 * Dependency graph:
 *   parse-core.ts  ← parser.ts (re-exports + adds self-test guard)
 *   parse-core.ts  ← fn-toString-self-test.ts (uses parseScriptCore)
 *   fn-toString-self-test.ts ← parser.ts (calls validate on first parse)
 *
 * @module parse-core
 * @internal
 */

import { type Options, Parser } from 'acorn';
import type { Node as ESTreeNode } from 'estree';
import { TypeKroError } from '../../errors.js';

/**
 * Custom error class for parser errors with enhanced information
 */
export class ParserError extends TypeKroError {
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
    super(message, 'PARSER_ERROR', {
      line,
      column,
      originalExpression,
      suggestions,
    });
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
 * Default parser options for TypeKro expression analysis
 */
export const DEFAULT_PARSER_OPTIONS: Options = {
  ecmaVersion: 2022,
  sourceType: 'script',
  locations: true,
  ranges: true,
};

/**
 * Parse a complete JavaScript program/script without the fn.toString() self-test.
 *
 * This is the raw acorn parse call used by fn-toString-self-test.ts to avoid
 * the circular dependency with parser.ts.
 *
 * @internal
 */
export function parseScriptCore(source: string, options?: Partial<Options>): ESTreeNode {
  const mergedOptions: Options = {
    ...DEFAULT_PARSER_OPTIONS,
    ...options,
  };

  try {
    return Parser.parse(source, mergedOptions) as unknown as ESTreeNode;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw ParserError.fromAcornError(
        error as SyntaxError & { loc?: { line: number; column: number } },
        source
      );
    }
    throw error;
  }
}
