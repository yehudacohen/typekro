# TypeKro Factory Pattern: Implementation-Aligned Design
**Version**: 2.0 (Implementation-Aligned)
**Last Updated**: 2025-07-25

## 1. Overview

This document outlines the **implemented** design for the TypeKro Factory Pattern, reflecting the actual implementation and highlighting key changes from the original design. The primary goal remains to enable developers to define, compose, and deploy type-safe Kubernetes Custom Resource Definitions (CRDs) using a powerful factory model.

The implementation successfully introduces a builder function pattern while maintaining **full backward compatibility** with the existing static resources API. The guiding principle of **end-to-end type safety** has been achieved with additional constraints based on Kro's Simple Schema requirements.

## 2. Core Concepts (Implemented)

### 2.1. The Schema Proxy ✅ IMPLEMENTED

The Schema Proxy has been successfully implemented as designed. Developers provide a **builder function** to `toKroResourceGraph` that receives a `schema` argument with `MagicProxy` objects.

**Key Implementation Details:**
- Schema references use the special resource ID `__schema__` to distinguish them from external references
- Schema references are serialized to `${schema.spec.fieldName}` format (not `${resources.fieldName}`)
- The `createSchemaProxy<TSpec, TStatus>()` function creates the proxy objects
- Full type safety is maintained through TypeScript constraints

### 2.2. Kro Simple Schema Constraints 🆕 MAJOR ADDITION

**MAJOR DEPARTURE:** During implementation, we discovered that Kro requires schemas to follow a specific "Simple Schema" format. This led to a significant addition not in the original design:

```typescript
/**
 * Constraint type for TypeScript types that can be used with Kro schemas
 * Based on Kro Simple Schema specification: https://kro.run/docs/concepts/simple-schema/
 */
export type KroCompatibleType = {
  [K in string]: 
    | string 
    | number 
    | boolean 
    | string[] 
    | number[] 
    | boolean[]
    | Record<string, string>
    | Record<string, number>
    | Record<string, boolean>
    | KroCompatibleType; // Nested objects
};
```

**Impact:** All schema types (`TSpec` and `TStatus`) must extend `KroCompatibleType`, ensuring compatibility with Kro's Simple Schema format.

### 2.3. Two-Resource Alchemy Integration ❌ NOT IMPLEMENTED

**MAJOR DEPARTURE:** The Alchemy integration (KroResourceGraphDefinition and KroCrdInstance resources) has **not been implemented** in the current phase. This was deferred to future tasks.

**Current Status:** The `getInstance` method throws a placeholder error indicating it will be implemented in future tasks.

## 3. Components and Interfaces (Implemented)

### 3.1. Core Types ✅ IMPLEMENTED WITH CONSTRAINTS

The core types have been implemented with Kro compatibility constraints:

```typescript
/**
 * Schema proxy with Kro compatibility constraints
 */
export type SchemaProxy<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType> = {
  spec: MagicProxy<TSpec>;
  status: MagicProxy<TStatus>;
};

/**
 * Builder function with Kro compatibility constraints
 */
export type ResourceBuilder<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType> = (
  schema: SchemaProxy<TSpec, TStatus>
) => Record<string, KubernetesResource | Enhanced<any, any>>;

/**
 * Factory interface with Kro compatibility constraints
 */
export interface TypedResourceGraphFactory<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType> {
  getInstance(spec: TSpec): Enhanced<TSpec, TStatus>; // Placeholder - throws error
  toYaml(): string; // ✅ Fully implemented
  schema: SchemaProxy<TSpec, TStatus>; // ✅ Fully implemented
  definition: TypedKroResourceGraphDefinition<TSpec, TStatus>; // ✅ Fully implemented
}
```

### 3.2. `toKroResourceGraph` Function ✅ IMPLEMENTED WITH OVERLOADS

**MAJOR ENHANCEMENT:** The implementation includes **function overloads** to maintain backward compatibility:

```typescript
// Builder function overload (NEW)
export function toKroResourceGraph<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  name: string,
  builder: ResourceBuilder<TSpec, TStatus>,
  schemaDefinition: {
    apiVersion: string;
    kind: string;
    spec: TSpec;
    status: TStatus;
  },
  options?: SerializationOptions
): TypedResourceGraphFactory<TSpec, TStatus>;

// Static resources overload (BACKWARD COMPATIBILITY)
export function toKroResourceGraph(
  name: string,
  resources: Record<string, KubernetesResource>,
  options?: SerializationOptions
): string;
```

**Key Implementation Details:**
- Function detects the overload using `typeof resourcesOrBuilder === 'function'`
- Builder function receives a schema proxy created by `createSchemaProxy()`
- Schema references are properly serialized to `${schema.spec.fieldName}` format
- Custom schema definition is used instead of auto-generated schema

### 3.3. `externalRef` Function ✅ IMPLEMENTED AS DESIGNED

The `externalRef` function has been implemented exactly as designed, with the `__externalRef: true` flag for serialization.

## 4. Serialization Engine (Implemented)

### 4.1. Schema Reference Handling ✅ IMPLEMENTED

**Key Implementation Detail:** The serialization engine properly distinguishes between schema references and external references:

```typescript
function generateCelExpression(ref: KubernetesRef<unknown>, context?: SerializationContext): string {
  // Handle schema references specially
  if (ref.resourceId === '__schema__') {
    // Schema references use the format: ${schema.spec.fieldName} or ${schema.status.fieldName}
    return `\${schema.${ref.fieldPath}}`;
  }
  
  // External resource references use the format: ${resourceId.fieldPath}
  const expression = `${ref.resourceId}.${ref.fieldPath}`;
  return `\${${expression}}`;
}
```

### 4.2. Resource ID Generation Enhancement 🆕 IMPLEMENTATION DETAIL

**IMPLEMENTATION ENHANCEMENT:** The `generateDeterministicResourceId` function was enhanced to handle `KubernetesRef` objects when used as names (which happens with schema references):

```typescript
export function generateDeterministicResourceId(
  kind: string,
  name: string | KubernetesRef<any>, // Enhanced to handle KubernetesRef
  namespace?: string
): string {
  // Handle case where name is a KubernetesRef (schema reference)
  if (isKubernetesRef(name)) {
    // For schema references, generate a generic name based on the field path
    const fieldPath = name.fieldPath.replace(/\./g, '');
    return toCamelCase(`${cleanKind}${fieldPath}`);
  }
  // ... rest of implementation
}
```

## 5. Error Handling (Partially Implemented)

### 5.1. Custom Error Classes ❌ NOT IMPLEMENTED

**DEPARTURE:** The custom error classes (`ResourceGraphFactoryError` and `CRDInstanceError`) have **not been implemented** as they are primarily needed for the Alchemy integration which was deferred.

### 5.2. Current Error Handling ✅ BASIC IMPLEMENTATION

Currently, the `getInstance` method throws a simple error indicating future implementation:

```typescript
getInstance: (spec: TSpec): Enhanced<TSpec, TStatus> => {
  throw new Error('getInstance not yet implemented - will be added in future task');
}
```

## 6. Example Usage (Implemented)

### 6.1. Working Example ✅ IMPLEMENTED

```typescript
import { toKroResourceGraph, simpleDeployment, simpleService, externalRef } from 'typekro';

// 1. Define Kro-compatible TypeScript interfaces
interface DatabaseSpec extends KroCompatibleType {
  name: string;
  storage: string;
  replicas: number;
}

interface DatabaseStatus extends KroCompatibleType {
  ready: boolean;
  connectionString: string;
  host: string;
  port: number;
}

// 2. Create a factory using the builder function
const dbFactory = toKroResourceGraph(
  'database-stack',
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name, // Type-safe schema reference
      image: 'postgres:13',
      replicas: schema.spec.replicas,
      env: {
        POSTGRES_DB: schema.spec.name,
        POSTGRES_PASSWORD: 'secure-password'
      }
    }),
    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 5432, targetPort: 5432 }]
    })
  }),
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'Database',
    spec: { name: 'test', storage: '10Gi', replicas: 1 } as DatabaseSpec,
    status: { ready: true, connectionString: 'test', host: 'test', port: 5432 } as DatabaseStatus
  }
);

// 3. Generate YAML (works immediately)
const yaml = dbFactory.toYaml();
console.log(yaml); // Outputs valid Kro ResourceGraphDefinition YAML

// 4. Access schema proxy (works immediately)
const nameRef = dbFactory.schema.spec.name; // Returns KubernetesRef<string>

// 5. getInstance (placeholder - will be implemented in future)
// const instance = dbFactory.getInstance({ name: 'my-db', storage: '50Gi', replicas: 3 });
```

### 6.2. Backward Compatibility ✅ MAINTAINED

```typescript
// This continues to work exactly as before
const yaml = toKroResourceGraph('legacy-stack', {
  deployment: simpleDeployment({ name: 'legacy-app', image: 'nginx' }),
  service: simpleService({
    name: 'legacy-service',
    selector: { app: 'legacy-app' },
    ports: [{ port: 80, targetPort: 80 }]
  })
});
```

## 7. Implementation Status Summary

### ✅ Completed (Tasks 1-3)
- **Schema Proxy Types and Builder Function Support** - Fully implemented with Kro constraints
- **Schema Proxy Factory** - `createSchemaProxy()` function working correctly
- **Builder Function Support in toKroResourceGraph** - Full implementation with overloads
- **Schema Reference Serialization** - Proper `${schema.spec.field}` format
- **Backward Compatibility** - Existing API continues to work unchanged
- **Type Safety** - Full TypeScript type checking with Kro compatibility constraints

### ❌ Deferred (Future Tasks)
- **Alchemy Integration Module** - KroResourceGraphDefinition and KroCrdInstance resources
- **getInstance Implementation** - Currently throws placeholder error
- **Custom Error Classes** - ResourceGraphFactoryError and CRDInstanceError
- **Complete Example Updates** - Some examples need updating for new API

## 8. Key Departures from Original Design

### 8.1. Kro Simple Schema Constraints 🆕 MAJOR ADDITION
- **Why:** Discovered during implementation that Kro requires specific schema format
- **Impact:** Added `KroCompatibleType` constraint to all schema types
- **Benefit:** Ensures generated schemas are valid for Kro

### 8.2. Function Overloads for Backward Compatibility 🆕 ENHANCEMENT
- **Why:** Original design would have broken existing code
- **Impact:** Added overloads to maintain existing API while adding new functionality
- **Benefit:** Zero breaking changes for existing users

### 8.3. Enhanced Resource ID Generation 🆕 IMPLEMENTATION DETAIL
- **Why:** Schema references as names caused runtime errors
- **Impact:** Enhanced `generateDeterministicResourceId` to handle `KubernetesRef` objects
- **Benefit:** Seamless handling of schema references in resource names

### 8.4. Deferred Alchemy Integration ⏸️ SCOPE REDUCTION
- **Why:** Complex orchestration logic deserves dedicated implementation phase
- **Impact:** `getInstance` is placeholder, no Alchemy resources yet
- **Benefit:** Allows focus on core factory pattern functionality first

## 9. Next Steps

The implementation successfully delivers the core factory pattern functionality with full type safety and backward compatibility. Future tasks will focus on:

1. **Task 4:** Update Serialization for Schema References (if needed)
2. **Task 5:** Create Alchemy Integration Module
3. **Task 6:** Add Error Classes for New Patterns
4. **Task 7:** Update Exports for New Features
5. **Tasks 8-10:** Comprehensive testing and examples

The foundation is solid and ready for the next phase of development.