# ProcessValue Function Correction

## Issue Identified

The architecture guide referenced an outdated `processValue` function that no longer exists in the codebase.

## Current Implementation

The current system uses `processFactoryValue` function instead, which has a different signature and behavior:

### Old (Incorrect) Reference
```typescript
function processValue<T>(value: RefOrValue<T> | undefined, fallback: T): T {
  if (value === undefined || isKubernetesRef(value)) return fallback;
  return value as T;
}
```

### Current (Correct) Implementation
```typescript
function processFactoryValue<T>(
  value: MagicAssignable<T>,
  context: FactoryExpressionContext,
  fieldPath: string
): T {
  // Handle KubernetesRef objects - preserve for runtime resolution
  if (isKubernetesRef(value)) {
    return value as T; // Preserved for serialization system
  }

  // Handle CelExpression objects - preserve for serialization
  if (isCelExpression(value)) {
    return value as T; // Serialization converts to ${expression} format
  }

  // Return static values as-is
  return value as T;
}
```

## Key Differences

1. **Function Name**: `processValue` → `processFactoryValue`
2. **Parameters**: 
   - Old: `value`, `fallback`
   - New: `value`, `context`, `fieldPath`
3. **Behavior**:
   - Old: Returned fallback values for KubernetesRef objects
   - New: Preserves KubernetesRef and CelExpression objects for serialization system
4. **Purpose**:
   - Old: Simple fallback handling
   - New: Context-aware processing with expression analysis

## Location in Codebase

- **Definition**: `src/core/expressions/factory-integration.ts`
- **Usage**: Throughout simple factory functions (e.g., `src/factories/simple/workloads/deployment.ts`)

## Impact on Documentation

The architecture guide has been updated to:
- Reference the correct function name and signature
- Explain the current behavior accurately
- Clarify that references are preserved rather than converted to fallbacks

## Verification

The correction was verified by:
1. Searching the codebase for `processValue` (no matches found)
2. Finding `processFactoryValue` in active use
3. Examining the actual implementation in factory functions
4. Confirming the behavior matches the current system design

This correction ensures the architecture guide accurately reflects the current TypeKro implementation.