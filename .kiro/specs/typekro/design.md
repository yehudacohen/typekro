# TypeKro - Design Document

## Overview

TypeKro is a standalone TypeScript library that enables developers to define Kro resource graphs using familiar TypeScript syntax. The library provides compile-time type safety, magic proxy-based cross-resource references, and automatic serialization to Kro YAML manifests. The architecture clearly separates compile-time type safety from runtime behavior and serialization, using a sophisticated proxy system to provide seamless property access and dynamic reference creation.

## Core Design Principles

### 1. Generic CRD-First Architecture

**CRITICAL DESIGN TENANT**: All resources (built-in and custom) are treated as Custom Resource Definitions with spec/status structures. Everything is built on generics of `Enhanced<TSpec, TStatus>`.

```typescript
// ✅ CORRECT: Generic system based on spec/status structures
export function deployment(resource: V1Deployment): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  return createResource({ ...resource, apiVersion: 'apps/v1', kind: 'Deployment' });
}

export function customResource<TSpec, TStatus>(
  schema: { apiVersion: string; kind: string; spec: Type<TSpec> },
  definition: { metadata: V1ObjectMeta; spec: TSpec }
): Enhanced<TSpec, TStatus> {
  return createResource({
    apiVersion: schema.apiVersion,
    kind: schema.kind,
    metadata: definition.metadata,
    spec: definition.spec,
  });
}

// ❌ WRONG: Different systems for built-in vs custom resources
export function deployment(spec: DeploymentSpec): EnhancedDeployment { /* different pattern */ }
export function customResource<T>(spec: T): EnhancedCustomResource<T> { /* different pattern */ }
```

**Core Principles:**
1. **Generic foundation** - `Enhanced<TSpec, TStatus>` works for any resource type
2. **CRD-first** - Built-in resources are just specialized CRDs
3. **Zero manual unpacking** - Factory functions do LITERALLY ZERO unpacking
4. **Single proxy system** - `createGenericProxyResource<TSpec, TStatus>()` works for everything
5. **One utility function** - `processResourceReferences()` handles ALL reference processing

### 2. Type-First Development

All tests should be statically typed and compile safely because we're literally mostly testing type behavior, not runtime logic.

```typescript
// ✅ CORRECT: Type-safe tests with no assertions
it('should support cross-resource references naturally', () => {
  const deploy = simpleDeployment({
    name: 'web-app',
    image: 'nginx:latest'
  });

  const svc = simpleService({
    name: 'web-service',
    selector: { app: deploy.metadata.labels!.app! }, // Type-safe reference
    ports: [{ port: 80 }]
  });

  // Test that references work - no type assertions needed
  const statusRef = deploy.status.replicas;
  expect(isKubernetesRef(statusRef)).toBe(true);
});

// ❌ WRONG: Type assertions and manual casting
const svc = service({
  selector: { app: deploy.metadata?.labels?.app as any }, // Type assertion
  ports: config.ports as any // More type assertions
});
```

### 3. Single Point of Reference Processing

There should be exactly ONE function that processes references - the serializer's `processResourceReferences()` utility. Everything else should preserve references as-is.

```typescript
// ✅ CORRECT: Single utility processes all references
function processResourceReferences(obj: unknown): unknown {
  if (isKubernetesRef(obj)) {
    return `\${resources.${obj.resourceId}.${obj.fieldPath}}`;
  }
  // ... recursive processing
}

// ❌ WRONG: Multiple places doing reference processing
function deployment(spec) {
  // Manual reference processing - WRONG
  const processedImage = isKubernetesRef(spec.image) ? 'nginx' : spec.image;
  // ...
}
```

## Architecture Overview

```mermaid
graph TB
    subgraph "Compile Time"
        TS_CODE[TypeScript Resource Definitions]
        IDE[IDE with IntelliSense & Autocomplete]
        TYPE_CHECK[TypeScript Type Checking]
    end
    
    subgraph "Runtime (Development)"
        RESOURCE_FACTORY[Resource Factory Functions]
        PROXY_OBJECTS[Typed Proxy Objects]
        REF_OBJECTS[Resource Reference Objects]
    end
    
    subgraph "Serialization Time"
        SERIALIZER[Pure Serialization Function]
        CEL_CONVERTER[Reference to CEL Converter]
        YAML_GENERATOR[Kro YAML Generator]
    end
    
    subgraph "Type Libraries"
        K8S_TYPES[@kubernetes/client-node]
        CRD_TYPES[Generated CRD Types]
    end
    
    TS_CODE --> TYPE_CHECK
    TYPE_CHECK --> RESOURCE_FACTORY
    RESOURCE_FACTORY --> PROXY_OBJECTS
    PROXY_OBJECTS --> REF_OBJECTS
    REF_OBJECTS --> SERIALIZER
    SERIALIZER --> CEL_CONVERTER
    CEL_CONVERTER --> YAML_GENERATOR
    
    K8S_TYPES --> TS_CODE
    CRD_TYPES --> TS_CODE
```

## Core Interfaces

### Compile Time vs Runtime Clarity

**Compile Time:**
- TypeScript provides full type safety for resource definitions
- `database.status.endpoint` is typed as `KubernetesRef<string>`
- IDE autocomplete and error checking work perfectly
- No actual promises are created or resolved

**Runtime (Development):**
- `customResource()` and `deployment()` return plain objects with proxy getters
- Accessing `.status.endpoint` creates a reference object (not a real promise)
- Objects are serializable and debuggable
- No async behavior or actual promise resolution

**Serialization Time:**
- `toKroResourceGraph()` walks the object tree
- Finds all reference objects and converts them to CEL expressions
- Generates proper Kro ResourceGraphDefinition YAML
- Validates dependencies and resource relationships

### Type System Architecture

TypeKro leverages the official `@kubernetes/client-node` TypeScript definitions as its foundation, providing:

- **Complete API Coverage**: All Kubernetes resources with accurate spec and status field definitions (733k weekly downloads, official Kubernetes client)
- **Version Compatibility**: Automatic updates with Kubernetes releases, supports K8s 1.25+ 
- **Zero Maintenance**: Types are auto-generated from OpenAPI specifications, eliminating manual type maintenance
- **Perfect IDE Support**: Full autocomplete and validation for all Kubernetes fields
- **Proven Stability**: Battle-tested in production environments across thousands of projects
- **Ecosystem Compatibility**: Works seamlessly with other Kubernetes tooling and libraries

**Why @kubernetes/client-node over alternatives:**
- **Official**: Maintained by the Kubernetes team, not a third-party interpretation
- **Comprehensive**: Covers 100% of Kubernetes API surface area
- **Accurate**: Generated directly from OpenAPI specs, guaranteed correctness
- **Current**: Automatically updated with each Kubernetes release
- **Lightweight**: No additional abstraction layers or opinions

### Core Type Definitions

```typescript
// Import official Kubernetes types as foundation
import { V1ObjectMeta } from '@kubernetes/client-node';

// =============================================================================
// 1. CORE REFERENCE & RESOURCE TYPES
// =============================================================================

export interface KubernetesRef<T = unknown> {
  readonly [Symbol.for('TypeKro.KubernetesRef')]: true;
  readonly resourceId: string;
  readonly fieldPath: string;
  readonly _type?: T;
}

export interface ResourceReference<T = unknown> {
  readonly __type: 'ResourceReference';
  readonly resourceId: string;
  readonly fieldPath: string;
  readonly expectedType: string;
}

export type RefOrValue<T> = T | KubernetesRef<NonNullable<T>>;

export interface KubernetesResource<TSpec = unknown, TStatus = unknown> {
  apiVersion: string;
  kind: string;
  metadata: V1ObjectMeta;
  spec?: TSpec;
  status?: TStatus;
}

/**
 * The "Magic Proxy" type. It contains all the real properties of the base type `T`.
 * For any OTHER property that is accessed, it returns a KubernetesRef. This provides
 * a seamless experience for both accessing existing data and creating new references.
 */
export type MagicProxy<T> = T & {
    [key: string]: KubernetesRef<any>;
};

/**
 * The final, user-facing type. All key properties are now magic proxies,
 * providing a consistent and powerful developer experience.
 */
export type Enhanced<TSpec, TStatus> = KubernetesResource<TSpec, TStatus> & {
  readonly status: MagicProxy<TStatus>;
  readonly spec: MagicProxy<TSpec>;
  readonly metadata: MagicProxy<V1ObjectMeta>;
};
```

## Clean User Experience

The library provides a clean, intuitive API that hides complexity while maintaining full type safety across all Kubernetes resource types:

```typescript
// Define a comprehensive application stack with full type safety
import { 
  simpleDeployment, simpleService, simpleIngress, simpleConfigMap, simpleSecret, 
  simplePvc, simpleHpa, simpleNetworkPolicy, customResource, toKroResourceGraph 
} from '@yehudacohen/typekro';

// Configuration and secrets
const appConfig = simpleConfigMap({
  name: "app-config",
  data: {
    LOG_LEVEL: "info",
    FEATURE_FLAGS: "auth,metrics"
  }
});

const dbSecret = simpleSecret({
  name: "db-credentials",
  stringData: {
    username: "postgres",
    password: "secure-password"
  }
});

// Storage for file uploads
const uploadStorage = simplePvc({
  name: "upload-storage",
  size: "5Gi",
  accessModes: ["ReadWriteOnce"]
});

// Database deployment
const database = simpleDeployment({
  name: "postgres-db",
  image: "postgres:13",
  env: {
    POSTGRES_DB: "webapp",
    POSTGRES_USER: dbSecret.stringData.username,
    POSTGRES_PASSWORD: dbSecret.stringData.password
  }
});

// Main application deployment with cross-resource references
const webapp = simpleDeployment({
  name: "web-app",
  image: "nginx:latest",
  replicas: 3,
  env: {
    // Type-safe references to other resources
    DATABASE_READY_REPLICAS: database.status.readyReplicas, // KubernetesRef<number>
    LOG_LEVEL: appConfig.data.LOG_LEVEL,                     // KubernetesRef<string>
    DB_USERNAME: dbSecret.stringData.username,              // KubernetesRef<string>
    DB_PASSWORD: dbSecret.stringData.password               // KubernetesRef<string>
  }
});

// Networking
const webService = simpleService({
  name: "web-service",
  selector: { app: webapp.metadata.labels!.app! },
  ports: [{ port: 80, targetPort: 8080 }]
});

const webIngress = simpleIngress({
  name: "web-ingress",
  rules: [{
    host: "myapp.example.com",
    http: {
      paths: [{
        path: "/",
        pathType: "Prefix",
        backend: {
          service: {
            name: webService.metadata.name!,
            port: { number: 80 }
          }
        }
      }]
    }
  }],
  tls: [{
    hosts: ["myapp.example.com"],
    secretName: "web-tls-cert"
  }]
});

// Scaling and availability policies
const webHPA = simpleHpa({
  name: "web-hpa",
  target: {
    name: webapp.metadata.name!,
    kind: "Deployment"
  },
  minReplicas: 2,
  maxReplicas: 10,
  cpuUtilization: 70
});

// Network policies
const webNetworkPolicy = simpleNetworkPolicy({
  name: "web-netpol",
  podSelector: { matchLabels: { app: "web-app" } },
  policyTypes: ["Ingress"],
  ingress: [{
    from: [{ namespaceSelector: { matchLabels: { name: "ingress-nginx" } } }],
    ports: [{ protocol: "TCP", port: 80 }]
  }]
});

// Simple conversion - works with all resource types
const kroYaml = toKroResourceGraph("my-webapp", {
  database,
  appConfig,
  dbSecret,
  uploadStorage,
  webapp,
  webService,
  webIngress,
  webHPA,
  webNetworkPolicy
});
```

## GitOps and Infrastructure CRD Support

TypeKro is designed to support popular GitOps and infrastructure CRDs in the future, enabling complete GitOps workflows with full type safety. This includes:

- **ArgoCD CRDs**: Application, ApplicationSet, AppProject
- **Flux CRDs**: GitRepository, HelmRepository, Kustomization, HelmRelease  
- **Infrastructure CRDs**: cert-manager Certificate and ClusterIssuer, External Secrets Operator CRDs

These will be implemented using the same `customResource()` pattern with Arktype validation, providing the same developer experience as built-in Kubernetes resources.

## Resource Factory Functions

### Built-in Kubernetes Resources

TypeKro provides two layers of resource factories:

1. **Base Factories**: Direct wrappers around Kubernetes resource definitions
2. **Simple Factories**: Convenient, opinionated factories for common use cases

```typescript
// Base factory - accepts full Kubernetes resource definition
export function deployment(resource: V1Deployment): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  return createResource({ ...resource, apiVersion: 'apps/v1', kind: 'Deployment' });
}

// Simple factory - convenient interface for common deployments
export function simpleDeployment(config: {
  name: string;
  image: RefOrValue<string>;
  replicas?: RefOrValue<number>;
  namespace?: string;
  env?: Record<string, RefOrValue<any>>;
  ports?: V1Container['ports'];
  resources?: V1ResourceRequirements;
}): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  const env: V1EnvVar[] = config.env ? Object.entries(config.env).map(([name, value]) => ({ name, value })) : [];
  return deployment({
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }), labels: { app: config.name } },
    spec: {
      replicas: processValue(config.replicas, 1),
      selector: { matchLabels: { app: config.name } },
      template: {
        metadata: { labels: { app: config.name } },
        spec: {
          containers: [{
            name: config.name,
            image: processValue(config.image, 'nginx:latest'),
            ...(env.length > 0 && { env }),
            ...(config.ports && { ports: config.ports }),
            ...(config.resources && { resources: config.resources })
          }],
        },
      },
    },
  });
}
```

### Available Resource Factories

**Base Factories** (accept full Kubernetes definitions):
- `deployment()`, `service()`, `job()`, `statefulSet()`, `cronJob()`
- `configMap()`, `secret()`, `persistentVolumeClaim()`
- `horizontalPodAutoscaler()`, `ingress()`, `networkPolicy()`

**Simple Factories** (convenient interfaces):
- `simpleDeployment()`, `simpleService()`, `simpleJob()`, `simpleStatefulSet()`, `simpleCronJob()`
- `simpleConfigMap()`, `simpleSecret()`, `simplePvc()`
- `simpleHpa()`, `simpleIngress()`, `simpleNetworkPolicy()`

### Custom Resource Support

```typescript
/**
 * Create a typed custom resource with Arktype validation
 * Provides the same developer experience as built-in Kubernetes resources
 */
function customResource<TSpec, TStatus>(
  schema: { apiVersion: string; kind: string; spec: Type<TSpec> },
  definition: { metadata: V1ObjectMeta; spec: TSpec }
): Enhanced<TSpec, TStatus> {
  // Runtime validation using Arktype
  const result = schema.spec(definition.spec);
  if (result instanceof type.errors) {
    throw new Error(`Invalid ${schema.kind} spec:\n- ${result.summary}`);
  }
  
  return createResource({
    apiVersion: schema.apiVersion,
    kind: schema.kind,
    metadata: definition.metadata,
    spec: result as TSpec,
  });
}
  if (specValidation.problems) {
    const errors = specValidation.problems.map(p => `${p.path?.join('.') || 'root'}: ${p.message}`);
    throw new Error(`Invalid ${kind} spec:\n${errors.join('\n')}`);
  }

  const resourceId = generateResourceId();
  
  const resource: CustomResource<TSpec, TStatus> = {
    apiVersion: schemas.apiVersion,
    kind,
    metadata: definition.metadata,
    spec: definition.spec
  };
  
  return createProxyResource(resourceId, resource);
}
```

## CRD Support with Arktype

The library provides first-class support for Custom Resource Definitions using Arktype for type safety and runtime validation:

```typescript
import { type } from 'arktype';

// 1. Define CRD schemas using Arktype (compile-time safe)
const DatabaseSpec = type({
  engine: "'postgresql' | 'mysql' | 'redis'",
  version: "string",
  replicas: "number | undefined",
  storage: {
    size: "string",
    storageClass: "string | undefined"
  },
  backup: {
    enabled: "boolean",
    schedule: "string | undefined",
    retention: "string | undefined"
  } | "undefined"
});

const DatabaseStatus = type({
  phase: "'pending' | 'ready' | 'failed'",
  endpoint: "string | undefined",
  readyReplicas: "number",
  conditions: "unknown[]"
});

// 2. Create typed CRD factory (same UX as built-in resources)
const database = customResource("Database", {
  apiVersion: "databases.example.com/v1",
  spec: DatabaseSpec,
  status: DatabaseStatus
}, {
  metadata: { name: "my-db" },
  spec: {
    engine: "postgresql",
    version: "13",
    storage: { size: "10Gi" },
    backup: {
      enabled: true,
      schedule: "0 2 * * *",
      retention: "7d"
    }
  }
});

// 3. Use with full type safety (same as built-in resources)
const webapp = deployment({
  name: "web-app",
  image: "nginx:latest",
  env: {
    // This is fully type-safe - TypeScript knows database.status.endpoint exists and is string | undefined
    DATABASE_URL: database.status.endpoint, // KubernetesRef<string | undefined>
  }
});

// 4. Simple conversion - works seamlessly with CRDs
const kroYaml = toKroResourceGraph("my-webapp", {
  database,
  webapp
});
```

### Benefits of Arktype-First CRD Support

1. **Compile-Time Safety** - Full TypeScript type checking and IDE support
2. **Runtime Validation** - Arktype validates CRD specs with helpful error messages
3. **Consistent Experience** - Same developer experience as built-in Kubernetes resources
4. **No Build Step** - No code generation or complex tooling required
5. **Incremental Enhancement** - Can add OpenAPI import later without breaking changes

## Serialization Engine

### Pure Function Approach

The serialization engine uses pure functions to convert TypeScript resource definitions to Kro YAML manifests:

```typescript
/**
 * Main serialization function - converts resources to Kro YAML
 * This is a pure function with no side effects
 */
function toKroResourceGraph(
  name: string,
  resources: Record<string, KubernetesResource>,
  options?: SerializationOptions
): string {
  // 1. Generate resource IDs and build dependency graph
  const resourceMap = new Map<string, { id: string; resource: KubernetesResource }>();
  const dependencies: ResourceDependency[] = [];
  
  // 2. Process each resource and extract references
  for (const [resourceName, resource] of Object.entries(resources)) {
    const resourceId = generateResourceId(resourceName);
    resourceMap.set(resourceName, { id: resourceId, resource });
    
    // Extract all ResourceReference objects from the resource
    const refs = extractResourceReferences(resource);
    for (const ref of refs) {
      dependencies.push({
        from: resourceId,
        to: ref.resourceId,
        field: ref.fieldPath,
        required: true
      });
    }
  }
  
  // 3. Generate Kro ResourceGraphDefinition
  const kroDefinition: KroResourceGraphDefinition = {
    apiVersion: 'kro.run/v1alpha1',
    kind: 'ResourceGraphDefinition',
    metadata: {
      name,
      namespace: options?.namespace || 'default'
    },
    spec: {
      schema: generateKroSchema(name, resources),
      resources: Array.from(resourceMap.values()).map(({ id, resource }) => ({
        id,
        template: processResourceReferences(resource)
      }))
    }
  };
  
  // 4. Convert to YAML
  return yaml.dump(kroDefinition, {
    indent: options?.indent || 2,
    lineWidth: options?.lineWidth || -1,
    noRefs: options?.noRefs ?? true
  });
}

/**
 * Serialization options
 */
interface SerializationOptions {
  namespace?: string;
  indent?: number;
  lineWidth?: number;
  noRefs?: boolean;
}

/**
 * Resource dependency information
 */
interface ResourceDependency {
  from: string;
  to: string;
  field: string;
  required: boolean;
}
```

### Reference Processing

The current implementation uses a two-step process for handling cross-resource references:

1. **KubernetesRef Detection**: The proxy system creates `KubernetesRef<T>` objects when accessing properties
2. **CEL Expression Generation**: During serialization, `KubernetesRef` objects are converted to CEL expressions

```typescript
/**
 * Extract all KubernetesRef objects from a resource recursively
 */
function extractResourceReferences(obj: unknown): KubernetesRef<unknown>[] {
  const refs: KubernetesRef<unknown>[] = [];

  if (isKubernetesRef(obj)) {
    refs.push(obj);
    return refs;
  }

  if (Array.isArray(obj)) {
    obj.forEach(item => {
      refs.push(...extractResourceReferences(item));
    });
  } else if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      refs.push(...extractResourceReferences(value));
    }
  }

  return refs;
}

/**
 * Generate CEL expression with automatic type conversion
 * CURRENT IMPLEMENTATION: Uses hardcoded field whitelist (BROKEN)
 * PLANNED: Type-aware detection using @kubernetes/client-node types
 */
function generateCelExpression(ref: KubernetesRef<unknown>, context?: SerializationContext): string {
  const baseExpression = `${ref.resourceId}.${ref.fieldPath}`;
  
  // CURRENT BROKEN IMPLEMENTATION: Hardcoded field whitelist
  const numericFields = [
    'readyReplicas', 'replicas', 'availableReplicas',
    'unavailableReplicas', 'updatedReplicas', 'observedGeneration', 'generation'
  ];
  
  const fieldName = ref.fieldPath.split('.').pop();
  const needsStringConversion = numericFields.includes(fieldName || '');
  
  if (needsStringConversion) {
    return `\${string(${baseExpression})}`;
  }
  
  return `\${${baseExpression}}`;
}

/**
 * Replace all KubernetesRef objects with CEL expressions for Kro
 * This is the ONLY function that should perform this transformation
 */
function processResourceReferences(obj: unknown, context?: SerializationContext): unknown {
  if (isKubernetesRef(obj)) {
    return generateCelExpression(obj, context);
  }

  if (isCelExpression(obj)) {
    return obj.expression;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => processResourceReferences(item, context));
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '__resourceId') continue; // Exclude internal properties
      result[key] = processResourceReferences(value, context);
    }
    return result;
  }

  return obj;
}
```

### Remove Broken Field Whitelist and Use Existing Type-Safe CEL Utilities

**Problem**: The current implementation uses a hardcoded whitelist of field names to determine when to apply `string()` conversion for numeric fields. This is brittle and will fail for any numeric field not in the list.

**Solution**: Remove the broken whitelist and leverage the existing `RefOrValue<T>` type system and `Cel.string()` utility that already provides type-safe conversions.

**Current Type System (Already Implemented)**:

```typescript
// Already exists - RefOrValue allows T, KubernetesRef<T>, or CelExpression
export type RefOrValue<T> = T | KubernetesRef<NonNullable<T>> | CelExpression;

// Already exists - EnvVarValue restricts environment variables to strings
export type EnvVarValue = string | KubernetesRef<string> | CelExpression;

// Already exists - Cel.string() converts any RefOrValue to CelExpression
export const Cel = {
  string: (value: RefOrValue<any>) => math('string', value), // Returns CelExpression
  // ... other utilities
};
```

**Correct Usage Pattern (Already Supported)**:

```typescript
// ✅ CORRECT: Use existing Cel.string() utility for type conversion
const webapp = simpleDeployment({
  name: 'webapp',
  env: {
    LOG_LEVEL: appConfig.data.LOG_LEVEL,                    // KubernetesRef<string> - OK
    DATABASE_READY_REPLICAS: Cel.string(database.status.readyReplicas), // CelExpression
    IS_PRODUCTION: Cel.string(cluster.spec.production),    // CelExpression
  }
});

// ❌ WRONG: This already causes a TypeScript compile error with EnvVarValue
const webapp = simpleDeployment({
  name: 'webapp',
  env: {
    DATABASE_READY_REPLICAS: database.status.readyReplicas, // KubernetesRef<number> - TYPE ERROR
  }
});
```

**Simple Fix Required**:

```typescript
/**
 * CURRENT BROKEN: generateCelExpression with hardcoded whitelist
 */
function generateCelExpression(ref: KubernetesRef<unknown>, context?: SerializationContext): string {
  const baseExpression = `${ref.resourceId}.${ref.fieldPath}`;
  
  // REMOVE THIS BROKEN WHITELIST:
  const numericFields = ['readyReplicas', 'replicas', 'availableReplicas', ...];
  const fieldName = ref.fieldPath.split('.').pop();
  const needsStringConversion = numericFields.includes(fieldName || '');
  
  if (needsStringConversion) {
    return `\${string(${baseExpression})}`;
  }
  
  return `\${${baseExpression}}`;
}

/**
 * FIXED: Simple generateCelExpression without whitelist
 */
function generateCelExpression(ref: KubernetesRef<unknown>): string {
  // Just generate the basic CEL expression - no implicit conversions
  return `\${${ref.resourceId}.${ref.fieldPath}}`;
}
```

**Implementation Strategy**:

1. **Remove Broken Whitelist**: Delete the hardcoded `numericFields` array from `generateCelExpression`
2. **Simplify CEL Generation**: Make `generateCelExpression` only generate basic `${resource.field}` expressions
3. **Rely on Existing Types**: Use the existing `EnvVarValue` type to prevent type mismatches at compile time
4. **Use Existing Utilities**: Developers use `Cel.string()` for explicit conversions (already implemented)
5. **Update Examples**: Show proper usage of `Cel.string()` in documentation

**Benefits**:

- **Leverages Existing System**: Uses the already-implemented `RefOrValue<T>` and `Cel.string()` utilities
- **Type Safe**: `EnvVarValue` already prevents `KubernetesRef<number>` assignment to env vars
- **Simple Fix**: Just remove broken whitelist code, don't add new complexity
- **Maintainable**: No field lists to maintain, relies on TypeScript type system
- **Explicit**: Developers must use `Cel.string()` for conversions, making intent clear
```

## Utility Functions

```typescript
/**
 * Generate a unique resource ID
 */
function generateResourceId(name?: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return name ? `${name}-${timestamp}-${random}` : `resource-${timestamp}-${random}`;
}

/**
 * Convert string to PascalCase
 */
function pascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

/**
 * Create a field proxy that generates ResourceReference objects
 * This is used by the resource factory functions
 */
function createFieldProxy(resourceId: string, basePath: string): unknown {
  return new Proxy({}, {
    get(target, prop, receiver) {
      const fieldPath = `${basePath}.${String(prop)}`;
      return createResourceReference(resourceId, fieldPath);
    }
  });
}

/**
 * Create a ResourceReference object
 */
function createResourceReference<T>(resourceId: string, fieldPath: string): ResourceReference<T> {
  return {
    __type: 'ResourceReference',
    resourceId,
    fieldPath,
    expectedType: 'unknown' // Could be enhanced with better type detection
  };
}

/**
 * Create a proxy resource that intercepts field access
 * This is used by resource factory functions like deployment()
 */
function createProxyResource<T extends KubernetesResource>(
  resourceId: string, 
  resource: T
): T {
  return new Proxy(resource, {
    get(target, prop, receiver) {
      if (prop === 'status' || prop === 'spec') {
        return createFieldProxy(resourceId, String(prop));
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

/**
 * Generate Kro schema from resource definitions
 * Basic implementation - analyzes resources to create schema fields
 */
function generateKroSchema(name: string, resources: Record<string, KubernetesResource>): KroSimpleSchema {
  const specFields: Record<string, KroFieldDefinition> = {};
  
  // Analyze resources to determine what fields the schema needs
  for (const [resourceName, resource] of Object.entries(resources)) {
    // Add basic fields that most resources need
    specFields[`${resourceName}Name`] = {
      type: 'string',
      markers: 'required=true description="Name of the resource"'
    };
    
    // Add namespace field if resource uses namespaces
    if (resource.metadata.namespace !== undefined) {
      specFields[`${resourceName}Namespace`] = {
        type: 'string',
        markers: 'default="default" description="Namespace for the resource"'
      };
    }
  }
  
  return {
    apiVersion: `${name}.example.com/v1`,
    kind: pascalCase(name),
    spec: specFields,
    status: {
      phase: '${.status.phase}',
      message: '${.status.message}'
    }
  };
}
```

## Integration with Alchemy.run

The TypeKro library is designed to integrate seamlessly with Alchemy.run for complete infrastructure lifecycle management:

### Developer Experience

```typescript
// alchemy.run.ts - Developer defines infrastructure in pure TypeScript
import { simpleDeployment, simpleService, toKroResourceGraph } from '@yehudacohen/typekro';

// Define infrastructure using TypeKro
const database = simpleDeployment({
  name: "my-db",
  image: "postgres:13",
  env: {
    POSTGRES_DB: "webapp"
  }
});

const webapp = simpleDeployment({
  name: "web-app",
  image: "nginx:latest",
  env: {
    DATABASE_READY_REPLICAS: database.status.readyReplicas  // Type-safe cross-resource reference
  }
});

// Alchemy resource that internally calls toKroResourceGraph()
const kroResource = await KroResourceGraph("my-webapp", {
  database,
  webapp
});
```

### Benefits of This Integration

1. **Seamless Developer Experience**
   - Write pure TypeScript infrastructure code
   - Get full type safety and IDE support
   - Alchemy handles all YAML generation and Kubernetes management

2. **Automatic Change Detection**
   - Alchemy detects when TypeScript resources change
   - Automatically regenerates and reapplies Kro YAML
   - No manual conversion or deployment steps

3. **Clean Separation of Concerns**
   - TypeKro: Type safety + YAML generation
   - Alchemy: State management + Kubernetes lifecycle
   - Developer: Pure TypeScript infrastructure definitions

4. **Encapsulation**
   - YAML generation is an implementation detail
   - Developer never sees or manages YAML directly
   - Alchemy provides the complete infrastructure management experience

## Data Models

### Kro ResourceGraphDefinition Structure

```typescript
interface KroResourceGraphDefinition {
  apiVersion: 'kro.run/v1alpha1';
  kind: 'ResourceGraphDefinition';
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    schema: KroSimpleSchema;
    resources: KroResourceTemplate[];
  };
}

interface KroSimpleSchema {
  apiVersion: string;
  kind: string;
  spec: Record<string, KroFieldDefinition>;
  status?: Record<string, string>;
  types?: Record<string, Record<string, KroFieldDefinition>>;
  additionalPrinterColumns?: KroAdditionalPrinterColumn[];
}

interface KroFieldDefinition {
  type: string;
  markers?: string;
}

interface KroResourceTemplate {
  id: string;
  template?: unknown;
  externalRef?: {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace?: string;
    };
  };
  includeWhen?: string[];
  readyWhen?: string[];
}

interface KroAdditionalPrinterColumn {
  jsonPath: string;
  name: string;
  type: string;
  description?: string;
}
```

## Serialization Engine

### Pure Function Approach

The serialization engine uses pure functions to convert TypeScript resource definitions to Kro YAML manifests:

```typescript
/**
 * Main serialization function - converts resources to Kro YAML
 * This is a pure function with no side effects
 */
export function toKroResourceGraph(
  name: string,
  resources: Record<string, KubernetesResource>,
  options?: SerializationOptions
): string {
  // 1. Use embedded resource IDs and build dependency graph
  const resourceMap = new Map<string, { id: string; resource: KubernetesResource }>();
  const dependencies: ResourceDependency[] = [];
  
  // 2. Process each resource and extract references
  for (const [resourceName, resource] of Object.entries(resources)) {
    // Use the embedded resource ID if available, otherwise generate one
    const resourceId = (resource as any).__resourceId || generateResourceId(resourceName);
    resourceMap.set(resourceName, { id: resourceId, resource });
    
    // Extract all ResourceReference objects from the resource
    const refs = extractResourceReferences(resource);
    for (const ref of refs) {
      dependencies.push({
        from: resourceId,
        to: ref.resourceId,
        field: ref.fieldPath,
        required: true
      });
    }
  }
  
  // 3. Generate Kro ResourceGraphDefinition
  const kroDefinition: KroResourceGraphDefinition = {
    apiVersion: 'kro.run/v1alpha1',
    kind: 'ResourceGraphDefinition',
    metadata: {
      name,
      namespace: options?.namespace || 'default'
    },
    spec: {
      schema: generateKroSchema(name, resources),
      resources: Array.from(resourceMap.values()).map(({ id, resource }) => ({
        id,
        template: processResourceReferences(resource)
      }))
    }
  };
  
  // 4. Convert to YAML
  return yaml.dump(kroDefinition, {
    indent: options?.indent || 2,
    lineWidth: options?.lineWidth || -1,
    noRefs: options?.noRefs ?? true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false
  });
}
```

### Reference Processing

```typescript
/**
 * Replace all KubernetesRef objects with CEL expressions
 * This is the UNIFIED function that handles ALL reference processing
 */
function processResourceReferences(obj: unknown, context?: SerializationContext): unknown {
  if (isKubernetesRef(obj)) {
    // Use configurable CEL expression format instead of hardcoded "resources."
    return generateCelExpression(obj, context);
  }
  
  if (isCelExpression(obj)) {
    // CEL expressions are already processed - return the expression string
    return obj.expression;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => processResourceReferences(item, context));
  }
  
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip internal properties
      if (key === '__resourceId') continue;
      result[key] = processResourceReferences(value, context);
    }
    return result;
  }
  
  return obj;
}

/**
 * Generate CEL expression with configurable context
 */
function generateCelExpression(ref: KubernetesRef<unknown>, context?: SerializationContext): string {
  const prefix = context?.celPrefix || 'resources';
  return `\${${prefix}.${ref.resourceId}.${ref.fieldPath}}`;
}

/**
 * Serialization context for configurable CEL generation
 */
interface SerializationContext {
  celPrefix?: string;
  namespace?: string;
  resourceIdStrategy?: 'deterministic' | 'random';
}
```

### Deterministic Resource ID Generation

```typescript
/**
 * Generate deterministic resource ID based on resource metadata
 * This ensures stable IDs across multiple applications for GitOps workflows
 */
function generateDeterministicResourceId(
  name: string, 
  resource: KubernetesResource,
  context?: SerializationContext
): string {
  if (context?.resourceIdStrategy === 'random') {
    // Fallback to random generation for development
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${name.replace(/[^a-zA-Z0-9-]/g, '')}-${timestamp}-${random}`;
  }
  
  // Create deterministic ID based on stable resource metadata
  // Format: {kind}-{namespace}-{name} (similar to Kro's approach)
  const kind = resource.kind.toLowerCase();
  const namespace = resource.metadata?.namespace || 'default';
  const resourceName = resource.metadata?.name || name;
  
  return `${kind}-${namespace}-${resourceName}`.replace(/[^a-zA-Z0-9-]/g, '');
}

/**
 * Enhanced resource factory functions that accept optional explicit IDs
 */
interface ResourceFactoryOptions {
  id?: string; // Explicit resource ID (like Kro's approach)
  namespace?: string;
}

/**
 * Updated factory function signature to support explicit IDs
 */
export function deployment(
  resource: V1Deployment, 
  options?: ResourceFactoryOptions
): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  const resourceId = options?.id || generateDeterministicResourceId(
    resource.metadata?.name || 'deployment',
    { ...resource, apiVersion: 'apps/v1', kind: 'Deployment' }
  );
  
  return createResource({ 
    ...resource, 
    apiVersion: 'apps/v1', 
    kind: 'Deployment' 
  }, resourceId);
}

/**
 * Example usage with deterministic IDs
 */
// Automatic deterministic ID: "deployment-default-web-app"
const webapp = deployment({
  metadata: { name: 'web-app' },
  spec: { /* ... */ }
});

// Explicit ID (like Kro's approach)
const database = deployment({
  metadata: { name: 'postgres-db', namespace: 'data' },
  spec: { /* ... */ }
}, { id: 'my-custom-db-id' });

// Both approaches ensure stable IDs for GitOps workflows
```

### Validation and Dependency Analysis

```typescript
/**
 * Validate resource graph for cycles and missing dependencies
 */
export function validateResourceGraph(
  resources: Record<string, KubernetesResource>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Extract all references and check for missing targets
  const resourceIds = new Set<string>();
  const allReferences: { from: string; to: string; field: string }[] = [];
  
  for (const [resourceName, resource] of Object.entries(resources)) {
    // Use the embedded resource ID if available, otherwise generate one
    const resourceId = (resource as any).__resourceId || generateResourceId(resourceName);
    resourceIds.add(resourceId);
    
    const refs = extractResourceReferences(resource);
    for (const ref of refs) {
      allReferences.push({
        from: resourceId,
        to: ref.resourceId,
        field: ref.fieldPath
      });
    }
  }
  
  // Check for missing dependencies
  for (const ref of allReferences) {
    if (!resourceIds.has(ref.to)) {
      errors.push(`Resource reference to '${ref.to}' not found in resource graph`);
    }
  }
  
  // Check for cycles using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  
  function hasCycle(nodeId: string): boolean {
    if (recursionStack.has(nodeId)) {
      return true;
    }
    if (visited.has(nodeId)) {
      return false;
    }
    
    visited.add(nodeId);
    recursionStack.add(nodeId);
    
    // Find all dependencies of this node
    const dependencies = allReferences.filter(ref => ref.from === nodeId);
    for (const dep of dependencies) {
      if (hasCycle(dep.to)) {
        return true;
      }
    }
    
    recursionStack.delete(nodeId);
    return false;
  }
  
  for (const resourceId of resourceIds) {
    if (!visited.has(resourceId) && hasCycle(resourceId)) {
      errors.push(`Circular dependency detected involving resource '${resourceId}'`);
      break;
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
```

This design provides a clean, type-safe, and intuitive way for developers to define infrastructure using TypeScript while seamlessly integrating with the Kro ecosystem and Alchemy.run for complete lifecycle management.