# JavaScript to CEL Expression Analysis with Type Safety Integration

This module provides comprehensive type safety integration for JavaScript to CEL expression conversion in TypeKro. It includes compile-time validation, runtime type inference, and resource reference validation.

## Overview

The type safety integration consists of several key components:

### 1. Core Analyzer (`analyzer.ts`)
- **JavaScriptToCelAnalyzer**: Main class that orchestrates the conversion and validation process
- Integrates all validation layers (type checking, resource validation, compile-time validation)
- Provides caching for performance optimization
- Generates comprehensive validation reports

### 2. Type Safety Integration (`type-safety.ts`)
- **ExpressionTypeValidator**: Validates JavaScript expressions against TypeScript types
- **TypeRegistry**: Manages available types in different contexts
- **TypeSafetyUtils**: Utility functions for type safety operations
- Provides type validation results with errors, warnings, and suggestions

### 3. Type Inference (`type-inference.ts`)
- **CelTypeInferenceEngine**: Infers types for CEL expressions
- Analyzes binary operations, function calls, resource references, and literals
- Validates type compatibility between different expressions
- Provides confidence scores and metadata about expressions

### 4. Resource Validation (`resource-validation.ts`)
- **ResourceReferenceValidator**: Validates KubernetesRef objects and resource references
- Checks resource existence, field path validity, and circular dependencies
- Provides suggestions for typos and missing resources
- Validates both resource references and schema references

### 5. Compile-Time Validation (`compile-time-validation.ts`)
- **CompileTimeTypeChecker**: Performs compile-time type checking for expressions
- Validates expression compatibility with TypeScript type system
- Detects unsupported syntax and potential runtime issues
- Provides type compatibility analysis and suggestions

### 6. Source Mapping and Error Handling
- **SourceMapBuilder**: Creates source maps linking JavaScript to CEL expressions
- **CelRuntimeErrorMapper**: Maps runtime CEL errors back to original JavaScript
- Provides detailed error reports with suggestions for fixes

## Key Features

### Type Safety Integration
- **Compile-time validation**: Validates expressions against TypeScript types before conversion
- **Runtime type inference**: Infers types of CEL expressions after conversion
- **Resource reference validation**: Ensures resource references are valid and type-safe
- **Cross-validation**: Validates compatibility between JavaScript and CEL types

### Comprehensive Error Handling
- **Detailed error messages**: Provides context-aware error messages with suggestions
- **Source mapping**: Links errors back to original JavaScript expressions
- **Error categorization**: Categorizes errors by type (syntax, type mismatch, resource not found, etc.)
- **Actionable suggestions**: Provides specific suggestions for fixing issues

### Performance Optimization
- **Expression caching**: Caches validation results for repeated expressions
- **Lazy evaluation**: Only performs expensive validations when needed
- **Batch processing**: Supports validating multiple expressions efficiently

### Developer Experience
- **IDE integration**: Designed to work with TypeScript language services
- **Comprehensive reporting**: Generates detailed validation reports
- **Confidence scoring**: Provides confidence scores for validation results
- **Progressive validation**: Supports different levels of validation strictness

## Usage Examples

### Basic Type Validation
```typescript
import { ExpressionTypeValidator, TypeRegistry } from './type-safety.js';

const validator = new ExpressionTypeValidator();
const registry = new TypeRegistry();

// Register available types
registry.registerType('name', { typeName: 'string', optional: false, nullable: false });
registry.registerType('replicas', { typeName: 'number', optional: false, nullable: false });

// Validate expression
const result = validator.validateExpression(
  'replicas > 0',
  registry.getAvailableTypes(),
  { typeName: 'boolean', optional: false, nullable: false }
);

console.log(result.valid); // true
console.log(result.resultType); // { typeName: 'boolean', ... }
```

### CEL Type Inference
```typescript
import { CelTypeInferenceEngine } from './type-inference.js';

const engine = new CelTypeInferenceEngine();
const context = {
  availableResources: { webapp: deploymentResource },
  factoryType: 'kro'
};

const celExpression = {
  expression: 'resources.webapp.status.readyReplicas > 0',
  _type: 'boolean'
};

const result = engine.inferType(celExpression, context);
console.log(result.resultType); // { typeName: 'boolean', ... }
console.log(result.metadata.resourceReferences); // ['resources.webapp.status.readyReplicas']
```

### Resource Reference Validation
```typescript
import { ResourceReferenceValidator } from './resource-validation.js';

const validator = new ResourceReferenceValidator();
const ref = {
  resourceId: 'webapp',
  fieldPath: 'status.readyReplicas',
  _type: 'number'
};

const result = validator.validateKubernetesRef(ref, availableResources);
console.log(result.valid); // true/false
console.log(result.suggestions); // Array of suggestions if invalid
```

### Comprehensive Analysis
```typescript
import { JavaScriptToCelAnalyzer } from './analyzer.js';

const analyzer = new JavaScriptToCelAnalyzer();
const context = {
  type: 'status',
  availableReferences: { webapp: deploymentResource },
  factoryType: 'kro',
  strictTypeChecking: true,
  validateResourceReferences: true,
  compileTimeTypeChecking: true
};

const result = analyzer.analyzeExpression(
  'resources.webapp.status.readyReplicas > 0',
  context
);

console.log(result.celExpression); // Generated CEL expression
console.log(result.typeValidation); // Type validation results
console.log(result.resourceValidation); // Resource validation results
console.log(result.compileTimeValidation); // Compile-time validation results
```

## Integration with TypeKro

This type safety integration is designed to work seamlessly with TypeKro's existing systems:

### Magic Proxy System
- Validates that schema references (`schema.spec.name`) are type-safe
- Ensures resource references (`resources.database.status.podIP`) are valid
- Provides compile-time checking for proxy-generated references

### Factory Pattern
- Validates expressions in both direct and Kro factory contexts
- Adapts validation rules based on deployment strategy
- Ensures type safety across different factory implementations

### Enhanced Types
- Integrates with TypeKro's Enhanced type system
- Validates field paths against actual Kubernetes resource schemas
- Provides type information for status builders and resource factories

## Current Status

✅ **Completed Features:**
- Type safety integration framework
- Compile-time validation infrastructure
- Resource reference validation
- Type inference engine
- Source mapping and error handling
- Comprehensive test suite

🚧 **Areas for Enhancement:**
- Integration with actual TypeScript compiler API
- Enhanced CEL expression parsing
- More sophisticated type inference algorithms
- Performance optimizations for large codebases
- Integration with IDE language services

## Testing

The module includes comprehensive tests covering:
- Type validation scenarios
- CEL expression type inference
- Resource reference validation
- Compile-time type checking
- Error handling and suggestions
- Performance and caching

Run tests with:
```bash
bun test test/core/expressions/type-safety-integration.test.ts
```

## Future Enhancements

1. **TypeScript Compiler Integration**: Direct integration with TypeScript's type checker
2. **Advanced CEL Parsing**: More sophisticated CEL expression analysis
3. **IDE Language Services**: Integration with VS Code and other IDEs
4. **Performance Optimization**: Further caching and optimization strategies
5. **Machine Learning**: AI-powered error suggestions and type inference