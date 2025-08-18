# CEL Expression Architecture

This document explains how CEL expressions are handled in TypeKro across different deployment modes.

## Overview

TypeKro has two different CEL-related modules that serve different purposes:

### 1. CEL Optimizer (`cel-optimizer.ts`)
- **Purpose**: Compile-time optimization and reference resolution
- **When used**: During ResourceGraphDefinition generation and serialization
- **What it does**: 
  - Resolves known resource references to concrete values when possible
  - Optimizes CEL expressions by substituting known values
  - Prepares expressions for serialization to ResourceGraphDefinitions
- **What it does NOT do**: Runtime CEL expression evaluation

### 2. CEL Runtime Evaluator (`../references/cel-evaluator.ts`)
- **Purpose**: Actual runtime CEL expression evaluation using cel-js library
- **When used**: Direct mode deployment only
- **What it does**:
  - Evaluates CEL expressions at runtime using live cluster data
  - Resolves resource references to actual values from deployed resources
  - Supports standard CEL functions and operations
- **What it does NOT do**: Compile-time optimization

## Deployment Mode Architecture

### Kro Mode (ResourceGraphDefinition)
```
CEL Expression → CEL Optimizer → CEL String → Kro Operator → Evaluated Value
```

1. **CEL Optimizer** prepares expressions for serialization
2. **ReferenceResolver** converts expressions to CEL strings (e.g., `${database-deployment.status.podIP}`)
3. **Kro Operator** evaluates CEL strings at runtime in the cluster
4. TypeKro reads the evaluated results via status hydration

### Direct Mode (Individual Kubernetes Resources)
```
CEL Expression → CEL Runtime Evaluator → Concrete Value → Kubernetes Manifest
```

1. **ReferenceResolver** uses **CEL Runtime Evaluator** to evaluate expressions
2. **CEL Runtime Evaluator** queries live cluster resources and evaluates expressions
3. Concrete values are embedded in Kubernetes manifests before deployment

## Key Files

- `src/core/evaluation/cel-optimizer.ts` - Compile-time optimization
- `src/core/references/cel-evaluator.ts` - Runtime evaluation
- `src/core/references/resolver.ts` - Orchestrates CEL handling based on deployment mode

## Usage Examples

### Kro Mode
```typescript
// CEL expression gets converted to string for Kro operator
const status = {
  url: Cel.template(`https://%s`, schema.spec.hostname)
};
// Becomes: url: ${schema.spec.hostname} in ResourceGraphDefinition
```

### Direct Mode
```typescript
// CEL expression gets evaluated by TypeKro before deployment
const status = {
  url: Cel.template(`https://%s`, database.status.podIP)
};
// Becomes: url: "https://10.0.0.1" in Kubernetes manifest
```

## Important Notes

1. **The CEL Optimizer does NOT evaluate CEL expressions** - it only optimizes them for serialization
2. **Runtime CEL evaluation is only used in Direct mode** - Kro mode delegates to the Kro operator
3. **Both modules work together correctly** - the architecture is sound and functional
4. **The naming was misleading** - "cel-evaluator.ts" in the evaluation directory was actually an optimizer

This architecture ensures that CEL expressions work correctly in both deployment modes while maintaining clear separation of concerns.