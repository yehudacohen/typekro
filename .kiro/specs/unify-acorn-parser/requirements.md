# Requirements Document

## Introduction

TypeKro currently uses two different JavaScript parsers for expression analysis: `esprima` (v4.0.1) and `acorn` (v8.15.0). This dual-parser approach creates technical debt, inconsistent behavior, and maintenance burden. The `esprima` parser is older and lacks support for modern JavaScript syntax (ES2020+), requiring workarounds like `preprocessModernSyntax()`. This feature unifies all expression parsing on `acorn`, which is already a dependency and supports modern JavaScript natively.

## Glossary

- **Acorn**: A modern, actively maintained JavaScript parser that supports ES2022+ syntax natively
- **Esprima**: An older JavaScript parser (v4.0.1) with limited ES6+ support, requiring preprocessing for modern syntax
- **AST**: Abstract Syntax Tree - the parsed representation of JavaScript code
- **CEL**: Common Expression Language - the expression language used by Kubernetes/Kro for runtime evaluation
- **KubernetesRef**: A branded object representing a reference to a Kubernetes resource field
- **Magic Proxy**: TypeKro's proxy system that intercepts property access and creates KubernetesRef objects
- **Expression Analyzer**: The system that converts JavaScript expressions containing KubernetesRef objects to CEL expressions

## Requirements

### Requirement 1

**User Story:** As a TypeKro developer, I want the expression analyzer to use a single modern parser, so that I can use modern JavaScript syntax without workarounds.

#### Acceptance Criteria

1. WHEN the JavaScriptToCelAnalyzer parses an expression THEN the system SHALL use acorn instead of esprima for AST generation
2. WHEN the MagicProxyAnalyzer parses an expression THEN the system SHALL use acorn instead of esprima for AST generation
3. WHEN parsing expressions with optional chaining (?.) THEN the system SHALL parse them natively without preprocessing
4. WHEN parsing expressions with nullish coalescing (??) THEN the system SHALL parse them natively without preprocessing
5. WHEN parsing template literals with complex interpolations THEN the system SHALL handle them correctly using acorn's native support

### Requirement 2

**User Story:** As a TypeKro maintainer, I want to remove the esprima dependency, so that the codebase has fewer dependencies and less technical debt.

#### Acceptance Criteria

1. WHEN the unification is complete THEN the system SHALL have esprima removed from package.json dependencies
2. WHEN the unification is complete THEN the system SHALL have @types/esprima removed from package.json dependencies
3. WHEN any module imports a parser THEN the system SHALL import from acorn only
4. WHEN the preprocessModernSyntax method is called THEN the system SHALL no longer require this method (it can be removed or simplified)

### Requirement 3

**User Story:** As a TypeKro user, I want existing expressions to continue working after the parser change, so that my compositions don't break.

#### Acceptance Criteria

1. WHEN parsing binary expressions (===, !==, >, <, >=, <=, &&, ||) THEN the system SHALL produce identical CEL output as before
2. WHEN parsing member expressions (resource.status.field) THEN the system SHALL produce identical CEL output as before
3. WHEN parsing conditional expressions (a ? b : c) THEN the system SHALL produce identical CEL output as before
4. WHEN parsing template literals (`https://${host}/api`) THEN the system SHALL produce identical CEL output as before
5. WHEN parsing call expressions (array.map(), string.startsWith()) THEN the system SHALL produce identical CEL output as before

### Requirement 4

**User Story:** As a TypeKro developer, I want consistent AST node types across all analyzers, so that the codebase is easier to maintain.

#### Acceptance Criteria

1. WHEN converting AST nodes to CEL THEN the system SHALL use acorn's ESTree-compatible node types consistently
2. WHEN traversing AST nodes THEN the system SHALL use estraverse with acorn-generated ASTs (estraverse is ESTree-compatible)
3. WHEN handling source locations THEN the system SHALL use acorn's loc and range properties consistently

### Requirement 5

**User Story:** As a TypeKro developer, I want improved error messages when parsing fails, so that I can debug expression issues more easily.

#### Acceptance Criteria

1. WHEN parsing fails due to syntax error THEN the system SHALL include the line and column number in the error message
2. WHEN parsing fails due to unsupported syntax THEN the system SHALL suggest using the explicit Cel API as an alternative
3. WHEN parsing fails THEN the system SHALL preserve the original expression in the error for debugging

### Requirement 6

**User Story:** As a TypeKro developer, I want the parser to be configurable, so that I can control which ECMAScript version features are supported.

#### Acceptance Criteria

1. WHEN initializing the parser THEN the system SHALL use ecmaVersion 2022 as the default
2. WHEN parsing expressions THEN the system SHALL support all ES2022 features including optional chaining and nullish coalescing
3. WHEN the parser encounters unsupported syntax THEN the system SHALL provide a clear error message indicating the limitation
