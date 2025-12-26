# Types API

Core TypeScript types for TypeKro's type-safe resource system.

## External References

### `externalRef<TSpec, TStatus>()`

Creates a reference to a resource deployed by another composition.

```typescript
function externalRef<TSpec extends object, TStatus extends object>(
  apiVersion: string,
  kind: string,
  instanceName: string,
  namespace?: string
): Enhanced<TSpec, TStatus>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `apiVersion` | `string` | API version of the external CRD |
| `kind` | `string` | Kind of the external CRD |
| `instanceName` | `string` | Name of the CRD instance to reference |
| `namespace` | `string` (optional) | Namespace of the CRD instance |

**Returns:** `Enhanced<TSpec, TStatus>` - A proxy that can be used in resource templates.

**Example:**

```typescript
import { externalRef, kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';

interface DatabaseSpec { name: string; }
interface DatabaseStatus { ready: boolean; host: string; }

const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
  'database.example.com/v1alpha1',
  'Database',
  'production-db',
  'databases'  // optional namespace
);

const app = kubernetesComposition(definition, (spec) => {
  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    env: {
      DATABASE_HOST: dbRef.status.host  // Reference external resource
    }
  });
  
  return { ready: deploy.status.readyReplicas > 0 };
});
```

See [External References Guide](/guide/external-references) for more patterns.

## Core Types

### `Enhanced<TSpec, TStatus>`

A Kubernetes resource enhanced with TypeKro functionality.

```typescript
type Enhanced<TSpec, TStatus> = KubernetesResource<TSpec, TStatus> & {
  withReadinessEvaluator(evaluator: ReadinessEvaluator): Enhanced<TSpec, TStatus>;
  withDependencies(...deps: string[]): Enhanced<TSpec, TStatus>;
}
```

**Usage:**

```typescript
import { Deployment } from 'typekro/simple';

const deploy = Deployment({ id: 'app', name: 'app', image: 'nginx' });
// deploy is Enhanced<V1DeploymentSpec, V1DeploymentStatus>

// Access spec and status with full type safety
deploy.spec.replicas;           // number | undefined
deploy.status.readyReplicas;    // KubernetesRef<number>
```

### `RefOrValue<T>`

Union type for values that can be direct values, references, or expressions.

```typescript
type RefOrValue<T> = T | KubernetesRef<NonNullable<T>> | CelExpression<T>
```

**Usage:**

```typescript
// All valid RefOrValue<string>:
const direct: RefOrValue<string> = 'hello';
const ref: RefOrValue<string> = deploy.metadata.name;
const expr: RefOrValue<string> = Cel.template('app-%s', schema.spec.name);
```

### `KubernetesRef<T>`

Type-safe reference to a field in another Kubernetes resource.

```typescript
interface KubernetesRef<T = unknown> {
  readonly [KUBERNETES_REF_BRAND]: true;
  readonly resourceId: string;
  readonly fieldPath: string;
}
```

**How it works:**

```typescript
const deploy = Deployment({ id: 'myDeploy', name: 'app', image: 'nginx' });

// TypeScript sees: string
// Runtime value: KubernetesRef<string>
const name = deploy.metadata.name;

// Serializes to CEL: ${myDeploy.metadata.name}
```

### `CelExpression<T>`

A CEL expression that evaluates to type `T` at runtime.

```typescript
interface CelExpression<T = unknown> {
  readonly [CEL_EXPRESSION_BRAND]: true;
  readonly expression: string;
}
```

**Usage:**

```typescript
import { Cel } from 'typekro';

// Recommended: Use natural JavaScript (auto-converted to CEL)
// ready: deploy.status.readyReplicas > 0

// Explicit CEL for advanced patterns (list operations, etc.)
const containerCount: CelExpression<number> = Cel.size(deploy.spec.template.spec.containers);
const podNames: CelExpression<string[]> = Cel.expr('pods.map(p, p.metadata.name)');
```

## Resource Types

### `KubernetesResource<TSpec, TStatus>`

Base interface for all Kubernetes resources.

```typescript
interface KubernetesResource<TSpec = unknown, TStatus = unknown> {
  apiVersion: string;
  kind: string;
  metadata: V1ObjectMeta;
  spec?: TSpec;
  status?: TStatus;
  id?: string;
}
```

### `DeploymentClosure<T>`

A closure that executes during deployment phase.

```typescript
type DeploymentClosure<T> = {
  readonly [DEPLOYMENT_CLOSURE_BRAND]: true;
  readonly name: string;
  execute(context: DeploymentContext): Promise<T>;
}
```

**Used by:** `yamlFile()`, `yamlDirectory()`

## Proxy Types

TypeKro uses two proxy types to create references at runtime while preserving TypeScript types at compile time.

### `SchemaProxy<TSpec, TStatus>`

The proxy for the `spec` parameter in composition functions. Creates references to input schema values.

```typescript
interface SchemaProxy<TSpec, TStatus> {
  spec: SchemaMagicProxy<TSpec>;
  status: SchemaMagicProxy<TStatus>;
}
```

**How it works:**

```typescript
// The spec parameter is a SchemaProxy
kubernetesComposition(definition, (spec) => {
  // TypeScript sees: spec.name as string
  // Runtime: spec.name is KubernetesRef with resourceId: '__schema__'
  const deploy = Deployment({ name: spec.name, ... });
  // Generates: name: ${schema.spec.name}
});
```

### `MagicProxy<T>`

The proxy wrapping resources (Deployment, Service, etc.). Creates references to live Kubernetes resource state.

```typescript
type MagicProxy<T> = T & {
  [P in keyof T]: MagicAssignable<T[P]>;
}
```

**How it works:**

```typescript
// Resources are wrapped with MagicProxy
const deploy = Deployment({ id: 'app', name: 'app', image: 'nginx' });

// TypeScript sees: deploy.status.readyReplicas as number
// Runtime: deploy.status.readyReplicas is KubernetesRef with resourceId: 'app'
return { ready: deploy.status.readyReplicas > 0 };
// Generates: ready: ${app.status.readyReplicas > 0}
```

### Key Difference

| Proxy | References | CEL Path Prefix |
|-------|------------|-----------------|
| Schema Proxy | Input spec values | `schema.spec.*` |
| Magic Proxy | Live resource state | `{resourceId}.*` |

### `MagicAssignable<T>`

Values that can be assigned through the magic proxy system.

```typescript
type MagicAssignable<T> = 
  | T 
  | undefined 
  | KubernetesRef<T> 
  | KubernetesRef<T | undefined> 
  | CelExpression<T>
```

### `MagicAssignableShape<T>`

The return type for composition status builders. Maps each property of `T` to `MagicAssignable`.

```typescript
type MagicAssignableShape<T> = {
  [K in keyof T]: MagicAssignable<T[K]>;
}
```

**Usage:**

When you return a status object from a composition function, TypeKro accepts `MagicAssignableShape<TStatus>`:

```typescript
// Your status schema
const WebAppStatus = type({ ready: 'boolean', url: 'string' });

// In composition function, you can return:
return {
  ready: deploy.status.readyReplicas > 0,  // JavaScript expression → CEL
  url: `https://${spec.hostname}`          // Template literal → CEL
};
// TypeKro accepts this as MagicAssignableShape<{ ready: boolean; url: string }>
```

This type allows you to mix:
- Direct values: `ready: true`
- Resource references: `ready: deploy.status.readyReplicas`
- JavaScript expressions: `ready: deploy.status.readyReplicas > 0`
- CEL expressions: `ready: Cel.expr(...)`

## Deployment Types

### `FactoryOptions`

Options for creating deployment factories.

```typescript
interface FactoryOptions {
  namespace?: string;
  timeout?: number;
  waitForReady?: boolean;
  progressCallback?: (event: DeploymentEvent) => void;
  
  // Event monitoring - stream control plane logs
  eventMonitoring?: {
    enabled?: boolean;
    eventTypes?: ('Normal' | 'Warning' | 'Error')[];
    includeChildResources?: boolean;
    deduplicationWindow?: number;
    maxEventsPerSecond?: number;
  };
  
  // Debug logging
  debugLogging?: {
    enabled?: boolean;
    statusPolling?: boolean;
    readinessEvaluation?: boolean;
    verboseMode?: boolean;
  };
}
```

### `DeploymentResult`

Result of a deployment operation.

```typescript
interface DeploymentResult {
  success: boolean;
  deployedResources: DeployedResource[];
  errors: Error[];
  duration: number;
}
```

## Status Types

### `ReadinessEvaluator<T>`

Function type for custom readiness evaluation.

```typescript
type ReadinessEvaluator<T extends KubernetesResource> = (
  resource: T
) => ResourceStatus | Promise<ResourceStatus>

interface ResourceStatus {
  ready: boolean;
  reason?: string;
  message?: string;
}
```

**Usage:**

```typescript
const deploy = Deployment({ id: 'app', name: 'app', image: 'nginx' })
  .withReadinessEvaluator((resource) => ({
    ready: resource.status?.readyReplicas === resource.spec?.replicas,
    message: `${resource.status?.readyReplicas}/${resource.spec?.replicas} ready`
  }));
```

## Type Guards

Runtime type checking functions:

```typescript
import { isKubernetesRef, isCelExpression } from 'typekro';

function processValue(value: RefOrValue<string>): string {
  if (isKubernetesRef(value)) {
    return `Reference: ${value.resourceId}.${value.fieldPath}`;
  }
  if (isCelExpression(value)) {
    return `CEL: ${value.expression}`;
  }
  return `Direct: ${value}`;
}
```

## Schema Types

### `KroCompatibleType`

Types that can be used in Kro schemas.

```typescript
type KroCompatibleType = 
  | string 
  | number 
  | boolean 
  | object 
  | unknown[]
```

### ArkType Integration

TypeKro uses ArkType for schema definitions:

```typescript
import { type } from 'arktype';

const AppSpec = type({
  name: 'string',
  replicas: 'number',
  'image?': 'string'  // Optional field
});

// Infer TypeScript type from schema
type AppSpecType = typeof AppSpec.infer;
// { name: string; replicas: number; image?: string }
```

## Next Steps

- [CEL Expressions](./cel.md) - Working with CelExpression
- [kubernetesComposition](./kubernetes-composition.md) - Using types in compositions
- [Magic Proxy Guide](/guide/magic-proxy) - Understanding the proxy system
