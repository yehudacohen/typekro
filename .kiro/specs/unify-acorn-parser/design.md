# Design Document: Unify on Acorn Parser

## Overview

This design document describes the migration from the dual-parser approach (esprima + acorn) to a unified acorn-only parser for TypeKro's JavaScript to CEL expression conversion system. The migration affects three main files that currently use esprima and ensures backward compatibility with all existing expression patterns.

## Architecture

### Current State

```
┌─────────────────────────────────────────────────────────────────┐
│                    Expression Analysis System                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │   analyzer.ts       │    │   imperative-analyzer.ts        │ │
│  │   (uses esprima)    │    │   (uses acorn)                  │ │
│  │                     │    │                                 │ │
│  │ - preprocessModern  │    │ - Parser.parse()                │ │
│  │   Syntax()          │    │ - ecmaVersion: 2022             │ │
│  │ - esprima.parse()   │    │                                 │ │
│  └─────────────────────┘    └─────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │ magic-proxy-        │    │ field-hydration-processor.ts    │ │
│  │ analyzer.ts         │    │ (uses esprima)                  │ │
│  │ (uses esprima)      │    │                                 │ │
│  └─────────────────────┘    └─────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────┐                                        │
│  │ status-builder-     │                                        │
│  │ analyzer.ts         │                                        │
│  │ (uses acorn)        │                                        │
│  └─────────────────────┘                                        │
└─────────────────────────────────────────────────────────────────┘
```

### Target State

```
┌─────────────────────────────────────────────────────────────────┐
│                    Expression Analysis System                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Unified Acorn Parser                      ││
│  │                                                              ││
│  │  - Parser.parse() with ecmaVersion: 2022                    ││
│  │  - Native optional chaining (?.) support                    ││
│  │  - Native nullish coalescing (??) support                   ││
│  │  - ESTree-compatible AST output                             ││
│  └─────────────────────────────────────────────────────────────┘│
│                           │                                      │
│           ┌───────────────┼───────────────┐                     │
│           ▼               ▼               ▼                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ analyzer.ts │  │ magic-proxy │  │ field-      │             │
│  │             │  │ -analyzer   │  │ hydration   │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. Parser Utility Module (New)

Create a centralized parser utility to ensure consistent configuration:

```typescript
// src/core/expressions/parser.ts

import { Parser, type Options } from 'acorn';
import type { Node as ESTreeNode } from 'estree';

export interface ParseOptions {
  /** Source type for parsing */
  sourceType?: 'script' | 'module';
  /** Whether to include location information */
  locations?: boolean;
  /** Whether to include range information */
  ranges?: boolean;
}

export interface ParseResult {
  ast: ESTreeNode;
  errors: ParseError[];
}

export interface ParseError {
  message: string;
  line: number;
  column: number;
  originalExpression: string;
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
 * Parse a JavaScript expression using acorn
 */
export function parseExpression(
  expression: string,
  options?: ParseOptions
): ESTreeNode;

/**
 * Parse a JavaScript expression with detailed error handling
 */
export function parseExpressionSafe(
  expression: string,
  options?: ParseOptions
): ParseResult;

/**
 * Check if an expression can be parsed successfully
 */
export function canParse(expression: string): boolean;
```

### 2. Updated Analyzer Interface

The `JavaScriptToCelAnalyzer` class will be updated to use the new parser utility:

```typescript
// Changes to src/core/expressions/analyzer.ts

import { parseExpression, parseExpressionSafe, DEFAULT_PARSER_OPTIONS } from './parser.js';

export class JavaScriptToCelAnalyzer {
  // Remove: private preprocessModernSyntax(expression: string): string
  
  analyzeStringExpression(
    expression: string,
    context: AnalysisContext
  ): CelConversionResult {
    // Use unified parser instead of esprima
    const parseResult = parseExpressionSafe(expression);
    
    if (parseResult.errors.length > 0) {
      return this.createParseErrorResult(parseResult.errors, expression);
    }
    
    // Continue with AST analysis...
  }
}
```

### 3. Error Handling Enhancement

```typescript
// src/core/expressions/parser.ts

export class ParserError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number,
    public readonly originalExpression: string,
    public readonly suggestions: string[]
  ) {
    super(message);
    this.name = 'ParserError';
  }

  static fromAcornError(
    error: SyntaxError & { loc?: { line: number; column: number } },
    expression: string
  ): ParserError {
    const line = error.loc?.line ?? 1;
    const column = error.loc?.column ?? 0;
    
    const suggestions = [
      'Check for syntax errors in your expression',
      'Consider using the explicit Cel API: Cel.expr(), Cel.template(), Cel.conditional()',
      'Ensure all brackets and parentheses are balanced',
    ];
    
    return new ParserError(
      `Parse error at line ${line}, column ${column}: ${error.message}`,
      line,
      column,
      expression,
      suggestions
    );
  }
}
```

## Data Models

### AST Node Types (ESTree Standard)

Both esprima and acorn produce ESTree-compatible AST nodes. The migration preserves all existing node type handling:

```typescript
// Supported node types (unchanged)
type SupportedNodeType =
  | 'BinaryExpression'      // a === b, a > b, a && b
  | 'MemberExpression'      // obj.prop, obj?.prop
  | 'ConditionalExpression' // a ? b : c
  | 'LogicalExpression'     // a && b, a || b
  | 'ChainExpression'       // obj?.prop?.field (optional chaining wrapper)
  | 'TemplateLiteral'       // `hello ${name}`
  | 'Literal'               // 42, "string", true
  | 'CallExpression'        // fn(), obj.method()
  | 'ArrayExpression'       // [1, 2, 3]
  | 'Identifier'            // variableName
  | 'UnaryExpression';      // !a, -b
```

### Parser Configuration

```typescript
interface AcornParserConfig {
  ecmaVersion: 2022;           // ES2022 for modern syntax
  sourceType: 'script';        // Parse as script (not module)
  locations: true;             // Include line/column info
  ranges: true;                // Include character ranges
  allowAwaitOutsideFunction?: boolean;  // For async expressions
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Parser Unification
*For any* JavaScript expression that was parseable by esprima, parsing with acorn SHALL produce a valid ESTree-compatible AST with equivalent structure.
**Validates: Requirements 1.1, 1.2**

### Property 2: Modern Syntax Native Support
*For any* JavaScript expression containing optional chaining (?.) or nullish coalescing (??), the parser SHALL parse it successfully without any preprocessing transformation.
**Validates: Requirements 1.3, 1.4, 6.2**

### Property 3: CEL Output Equivalence (Round-Trip)
*For any* JavaScript expression that was convertible to CEL before the migration, the CEL output after migration SHALL be character-for-character identical to the output before migration.
**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

### Property 4: Source Location Preservation
*For any* parsed expression, the AST nodes SHALL contain accurate line and column information that matches the original source positions.
**Validates: Requirements 4.3**

### Property 5: Error Message Quality
*For any* invalid JavaScript expression, the parse error SHALL include: (1) line and column number, (2) the original expression, and (3) a suggestion to use the explicit Cel API.
**Validates: Requirements 5.1, 5.2, 5.3**

## Error Handling

### Parse Errors

When parsing fails, the system will:

1. Capture the acorn error with location information
2. Create a `ParserError` with enhanced context
3. Include suggestions for using the explicit `Cel` API
4. Preserve the original expression for debugging

```typescript
try {
  const ast = parseExpression(expression);
} catch (error) {
  if (error instanceof SyntaxError) {
    throw ParserError.fromAcornError(error, expression);
  }
  throw error;
}
```

### Fallback Strategy

For expressions that fail to parse, the system will:

1. Log the error with full context
2. Suggest using `Cel.expr()`, `Cel.template()`, or `Cel.conditional()`
3. Return a `CelConversionResult` with `valid: false` and detailed error information

## Testing Strategy

### Dual Testing Approach

The migration requires both unit tests and property-based tests to ensure correctness.

### Unit Tests

1. **Parser Module Tests**
   - Test `parseExpression()` with various expression types
   - Test `parseExpressionSafe()` error handling
   - Test `canParse()` for valid/invalid expressions

2. **Migration Regression Tests**
   - Capture CEL output for all existing test expressions before migration
   - Verify identical output after migration

3. **Error Message Tests**
   - Verify error messages include line/column
   - Verify suggestions are included

### Property-Based Tests

Using `fast-check` for property-based testing:

```typescript
import fc from 'fast-check';

// Property 1: Parser Unification
describe('Parser Unification', () => {
  it('should parse all valid expressions', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          binaryExpressionArb,
          memberExpressionArb,
          conditionalExpressionArb,
          templateLiteralArb
        ),
        (expression) => {
          const result = parseExpressionSafe(expression);
          return result.errors.length === 0;
        }
      )
    );
  });
});

// Property 3: CEL Output Equivalence
describe('CEL Output Equivalence', () => {
  it('should produce identical CEL for all expressions', () => {
    fc.assert(
      fc.property(
        validExpressionArb,
        (expression) => {
          const celBefore = convertWithEsprima(expression);
          const celAfter = convertWithAcorn(expression);
          return celBefore === celAfter;
        }
      )
    );
  });
});
```

### Test Configuration

- Property-based tests: minimum 100 iterations per property
- Test annotation format: `**Feature: unify-acorn-parser, Property {number}: {property_text}**`
