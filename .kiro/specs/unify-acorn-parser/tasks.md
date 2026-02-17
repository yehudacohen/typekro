# Implementation Plan

- [x] 1. Create centralized parser utility module
  - [x] 1.1 Create `src/core/expressions/parser.ts` with unified acorn configuration
    - Export `parseExpression()` function with default options (ecmaVersion: 2022, locations: true, ranges: true)
    - Export `parseExpressionSafe()` function with error handling
    - Export `canParse()` utility function
    - Export `DEFAULT_PARSER_OPTIONS` constant
    - _Requirements: 1.1, 1.2, 6.1_
  - [x] 1.2 Create `ParserError` class with enhanced error information
    - Include line, column, originalExpression, and suggestions properties
    - Add static `fromAcornError()` factory method
    - Include suggestion to use explicit Cel API in error messages
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 1.3 Write property test for parser utility
    - **Property 1: Parser Unification**
    - **Validates: Requirements 1.1, 1.2**

- [x] 2. Migrate analyzer.ts from esprima to acorn
  - [x] 2.1 Update imports in `src/core/expressions/analyzer.ts`
    - Replace `import * as esprima from 'esprima'` with import from new parser utility
    - Keep `estraverse` import (ESTree-compatible)
    - _Requirements: 1.1, 2.3_
  - [x] 2.2 Update `analyzeStringExpression()` method to use new parser
    - Replace `esprima.parseScript()` calls with `parseExpression()` or `parseExpressionSafe()`
    - Remove `preprocessModernSyntax()` call
    - Update error handling to use `ParserError`
    - _Requirements: 1.1, 2.4_
  - [x] 2.3 Remove or simplify `preprocessModernSyntax()` method
    - Method is no longer needed with acorn's native ES2022 support
    - _Requirements: 2.4, 1.3, 1.4_
  - [x] 2.4 Write property test for CEL output equivalence in analyzer
    - **Property 3: CEL Output Equivalence (Round-Trip)**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Migrate magic-proxy-analyzer.ts from esprima to acorn
  - [x] 4.1 Update imports in `src/core/expressions/magic-proxy-analyzer.ts`
    - Replace `import * as esprima from 'esprima'` with import from parser utility
    - Keep `estraverse` import
    - _Requirements: 1.2, 2.3_
  - [x] 4.2 Update `parseExpression()` method to use new parser
    - Replace `esprima.parseScript()` with unified parser
    - Update error handling
    - _Requirements: 1.2_
  - [x] 4.3 Write property test for magic proxy analyzer
    - **Property 2: Modern Syntax Native Support**
    - **Validates: Requirements 1.3, 1.4, 6.2**

- [x] 5. Migrate field-hydration-processor.ts from esprima to acorn
  - [x] 5.1 Update imports in `src/core/expressions/field-hydration-processor.ts`
    - Replace `import * as esprima from 'esprima'` with import from parser utility
    - Keep `estraverse` import
    - _Requirements: 2.3_
  - [x] 5.2 Update parsing logic to use new parser
    - Replace all `esprima.parseScript()` calls with unified parser
    - Update error handling
    - _Requirements: 1.1_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Remove esprima dependencies
  - [x] 7.1 Remove esprima from package.json
    - Remove `esprima` from dependencies
    - Remove `@types/esprima` from dependencies
    - Run `bun install` to update lock file
    - _Requirements: 2.1, 2.2_
  - [x] 7.2 Verify no remaining esprima imports
    - Search codebase for any remaining esprima references
    - Update any missed files
    - _Requirements: 2.3_

- [x] 8. Add property tests for source location and error handling
  - [x] 8.1 Write property test for source location preservation
    - **Property 4: Source Location Preservation**
    - **Validates: Requirements 4.3**
  - [x] 8.2 Write property test for error message quality
    - **Property 5: Error Message Quality**
    - **Validates: Requirements 5.1, 5.2, 5.3**

- [x] 9. Update exports and documentation
  - [x] 9.1 Export parser utility from expressions index
    - Add exports to `src/core/expressions/index.ts`
    - _Requirements: 1.1_
  - [x] 9.2 Update any documentation referencing esprima
    - Check README files in expressions directory
    - Update any comments mentioning esprima
    - _Requirements: 2.3_

- [x] 10. Final Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
