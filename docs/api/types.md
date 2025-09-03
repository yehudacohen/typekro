# Types API

TypeKro provides a comprehensive type system that ensures type safety across resource definitions, references, and deployments. This page documents the core types and interfaces used throughout the TypeKro ecosystem.

## Core Types

### `KubernetesResource<TSpec, TStatus>`

Base interface for all Kubernetes resources in TypeKro.

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

#### Type Parameters

- **`TSpec`**: Type of the resource specification
- **`TStatus`**: Type of the resource status

#### Properties

- **`apiVersion`**: Kubernetes API version (e.g., "apps/v1")
- **`kind`**: Resource type (e.g., "Deployment", "Service")
- **`metadata`**: Kubernetes metadata including name, namespace, labels
- **`spec`**: Resource specification (optional)
- **`status`**: Resource status (optional)
- **`id`**: Unique identifier for TypeKro dependency tracking

#### Example

```typescript
import type { KubernetesResource } from 'typekro';
import type { V1DeploymentSpec, V1DeploymentStatus } from '@kubernetes/client-node';

// Custom deployment resource type
type MyDeployment = KubernetesResource<V1DeploymentSpec, V1DeploymentStatus>;
```

### `Enhanced<TSpec, TStatus>`

Enhanced version of a Kubernetes resource with TypeKro functionality.

```typescript
type Enhanced<TSpec, TStatus> = KubernetesResource<TSpec, TStatus> & {
  // TypeKro enhancement methods
  withReadinessEvaluator(evaluator: ReadinessEvaluator<any>): Enhanced<TSpec, TStatus>;
  withDependencies(...deps: string[]): Enhanced<TSpec, TStatus>;
}
```

#### Features

- **Readiness evaluation**: Custom logic to determine when a resource is ready
- **Dependency management**: Explicit dependency declarations
- **Type preservation**: Maintains original Kubernetes types

#### Example

```typescript
import { deployment } from 'typekro';

const myDeploy = deployment({
  metadata: { name: 'web-server' },
  spec: { /* deployment spec */ }
})
.withReadinessEvaluator((resource) => ({
  ready: resource.status?.readyReplicas === resource.spec?.replicas,
  message: 'Deployment ready when all replicas are available'
}))
.withDependencies('database', 'config');
```

## Reference Types

### `KubernetesRef<T>`

Type-safe reference to a field in another Kubernetes resource.

```typescript
interface KubernetesRef<T = unknown> {
  [KUBERNETES_REF_BRAND]: true;
  resourceId: string;
  fieldPath: string;
  expectedType: string;
  _type?: T;
}
```

#### Type Parameters

- **`T`**: Expected type of the referenced value

#### Properties

- **`resourceId`**: ID of the target resource
- **`fieldPath`**: Path to the specific field (e.g., "spec.replicas")
- **`expectedType`**: TypeScript type name for validation

#### Example

```typescript
import { deployment, service } from 'typekro';

const myDeploy = deployment({ /* spec */ });
const myService = service({
  spec: {
    selector: { app: myDeploy.metadata.name }, // KubernetesRef<string>
    ports: [{ port: 80, targetPort: myDeploy.spec.containers[0].ports[0].containerPort }]
  }
});
```

### `CelExpression<T>`

Type-safe CEL expression that evaluates to type `T`.

```typescript
interface CelExpression<T = unknown> {
  [CEL_EXPRESSION_BRAND]: true;
  expression: string;
  _type?: T;
}
```

#### Type Parameters

- **`T`**: Expected type of the expression result

#### Properties

- **`expression`**: CEL expression string
- **`_type`**: TypeScript type marker (compile-time only)

#### Example

```typescript
import { deployment } from 'typekro';

const myDeploy = deployment({ /* spec */ });

// ✨ Natural JavaScript expressions - automatically converted to CEL
// Boolean expression
const isHealthy = myDeploy.status.readyReplicas >= myDeploy.spec.replicas;

// String template
const statusMessage = `Deployment ${myDeploy.metadata.name} has ${myDeploy.status.readyReplicas} ready replicas`;
```

### `RefOrValue<T>`

Union type for values that can be either direct values, references, or expressions.

```typescript
type RefOrValue<T> = T | KubernetesRef<NonNullable<T>> | CelExpression<T>
```

#### Type Parameters

- **`T`**: Base type of the value

#### Usage

Used throughout TypeKro APIs to accept flexible value types:

```typescript
import { configMap } from 'typekro';

const config = configMap({
  metadata: { name: 'app-config' },
  data: {
    // Direct string value
    environment: 'production',
    
    // Reference to another resource
    databaseUrl: myDatabase.status.connectionString, // KubernetesRef<string>
    
    // ✨ JavaScript expression - automatically converted to CEL
    maxConnections: `${myDatabase.spec.maxConnections}` // Automatically converted to CEL
  }
});
```

## Magic Proxy Types

### `MagicProxy<T>`

Advanced proxy type that enables transparent reference creation while preserving TypeScript types.

```typescript
type MagicProxy<T> = T & {
  [P in keyof T as `${P & string}`]: MagicAssignable<T[P]>;
} & {
  [key: string]: MagicAssignable<any>;
}
```

#### Features

- **Type preservation**: Maintains original TypeScript types for IDE support
- **Reference creation**: Automatically creates `KubernetesRef` objects at runtime
- **Unknown property access**: Allows accessing any property path

#### Example

```typescript
// TypeScript sees this as a regular Deployment object
const myDeploy = deployment({ /* spec */ });

// But these create KubernetesRef objects at runtime:
const deployName = myDeploy.metadata.name; // KubernetesRef<string>
const replicas = myDeploy.spec.replicas; // KubernetesRef<number>
const readyReplicas = myDeploy.status.readyReplicas; // KubernetesRef<number>
```

### `MagicAssignable<T>`

Type that defines what values can be assigned in the magic proxy system.

```typescript
type MagicAssignable<T> = T | undefined | KubernetesRef<T> | KubernetesRef<T | undefined> | CelExpression<T>
```

#### Use Cases

- Function parameters that accept references or direct values
- Resource field assignments with dynamic values
- Status builder computations

## Resource Graph Types

### `ResourceGraph`

Represents a complete resource graph with dependencies and metadata.

```typescript
interface ResourceGraph {
  id: string;
  resources: Map<string, DeployableK8sResource>;
  dependencies: DependencyGraph;
  metadata: {
    name: string;
    created: Date;
    namespace?: string;
  };
}
```

#### Properties

- **`id`**: Unique identifier for the resource graph
- **`resources`**: Map of resource ID to resource definition
- **`dependencies`**: Dependency graph for ordered deployment
- **`metadata`**: Graph metadata including name and creation time

### `ResourceGraphDefinition<T>`

Type-safe resource graph definition with schema validation.

```typescript
type ResourceGraphDefinition<T> = (schema: SchemaProxy<T>) => Record<string, Enhanced<any, any>>
```

#### Type Parameters

- **`T`**: Type of the input schema

#### Example

```typescript
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';
import { type } from 'arktype';

const WebAppSpec = type({
  name: 'string',
  replicas: 'number', 
  image: 'string'
});

const webApp = kubernetesComposition(
  {
    name: 'web-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    deploy: Deployment({
      name: schema.spec.name,
    spec: {
      replicas: schema.replicas,
      template: {
        spec: {
          containers: [{
            name: 'web',
            image: schema.image
          }]
        }
      }
    }
  });

  const svc = service({
    metadata: { name: `${schema.name}-service` },
    spec: {
      selector: { app: schema.name },
      ports: [{ port: 80, targetPort: 8080 }]
    }
  });

  return { deployment: deploy, service: svc };
});
```

## Deployment Types

### `DeploymentOptions`

Configuration options for resource deployment.

```typescript
interface DeploymentOptions {
  namespace?: string;
  kubeconfig?: string | KubeConfig;
  dryRun?: boolean;
  waitForReady?: boolean;
  timeout?: number;
  alchemyScope?: Scope;
}
```

#### Properties

- **`namespace`**: Target Kubernetes namespace
- **`kubeconfig`**: Kubernetes configuration (file path or object)
- **`dryRun`**: If true, validate without applying changes
- **`waitForReady`**: Wait for resources to become ready
- **`timeout`**: Maximum wait time in milliseconds
- **`alchemyScope`**: Alchemy integration scope

### `DeploymentResult`

Result of a deployment operation.

```typescript
interface DeploymentResult {
  success: boolean;
  resourceGraph: ResourceGraph;
  deployedResources: DeployedResource[];
  errors: Error[];
  duration: number;
}
```

#### Properties

- **`success`**: Whether deployment completed successfully
- **`resourceGraph`**: The deployed resource graph
- **`deployedResources`**: List of successfully deployed resources
- **`errors`**: Any errors encountered during deployment
- **`duration`**: Total deployment time in milliseconds

### `DeployedResource`

Metadata about a deployed Kubernetes resource.

```typescript
interface DeployedResource {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  manifest: KubernetesResource;
  status: 'deployed' | 'ready' | 'failed';
  deployedAt: Date;
  error?: Error;
}
```

## Status and Readiness Types

### `ResourceStatus`

Standardized status information for resources.

```typescript
interface ResourceStatus {
  ready: boolean;
  reason?: string;
  message?: string;
  details?: Record<string, unknown>;
}
```

#### Properties

- **`ready`**: Whether the resource is ready for use
- **`reason`**: Machine-readable reason code
- **`message`**: Human-readable status message
- **`details`**: Additional status details

### `ReadinessEvaluator<T>`

Function type for custom readiness evaluation logic.

```typescript
type ReadinessEvaluator<T extends KubernetesResource> = (
  resource: T
) => ResourceStatus | Promise<ResourceStatus>
```

#### Example

```typescript
import { deployment } from 'typekro';

const myDeploy = deployment({
  metadata: { name: 'web-server' },
  spec: { /* deployment spec */ }
})
.withReadinessEvaluator((resource) => {
  const ready = resource.status?.readyReplicas === resource.spec?.replicas;
  
  return {
    ready,
    reason: ready ? 'AllReplicasReady' : 'ReplicasPending',
    message: ready 
      ? 'All replicas are ready and available'
      : `${resource.status?.readyReplicas || 0}/${resource.spec?.replicas || 1} replicas ready`,
    details: {
      readyReplicas: resource.status?.readyReplicas,
      desiredReplicas: resource.spec?.replicas
    }
  };
});
```

## Validation Types

### `ValidationResult`

Result of resource or schema validation.

```typescript
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}
```

### `ValidationError`

Detailed validation error information.

```typescript
interface ValidationError {
  path: string;
  message: string;
  code: string;
  value?: unknown;
}
```

## Utility Types

### `KroCompatibleType`

Union type for types that can be used in KRO schemas.

```typescript
type KroCompatibleType = 
  | string 
  | number 
  | boolean 
  | object 
  | unknown[]
```

### `EnvVarValue`

Specific type for environment variable values.

```typescript
type EnvVarValue = 
  | string
  | KubernetesRef<string>
  | KubernetesRef<string | undefined>
  | CelExpression<string>
```

#### Usage

```typescript
import { deployment, configMap } from 'typekro';

const config = configMap({ /* config spec */ });

const deploy = deployment({
  spec: {
    template: {
      spec: {
        containers: [{
          name: 'web',
          image: 'nginx:1.21',
          env: [
            {
              name: 'API_URL',
              value: config.data.apiUrl // EnvVarValue (KubernetesRef<string>)
            },
            {
              name: 'PORT',
              value: '8080' // EnvVarValue (string)
            }
          ]
        }]
      }
    }
  }
});
```

## Type Guards

TypeKro provides several type guard functions for runtime type checking:

### `isKubernetesRef()`

```typescript
function isKubernetesRef(value: unknown): value is KubernetesRef
```

### `isCelExpression()`

```typescript
function isCelExpression(value: unknown): value is CelExpression
```

### `isSchemaReference()`

```typescript
function isSchemaReference(value: unknown): value is SchemaReference
```

#### Example

```typescript
import { isKubernetesRef, isCelExpression } from 'typekro';

function processValue(value: RefOrValue<string>): string {
  if (isKubernetesRef(value)) {
    return `Reference to ${value.resourceId}.${value.fieldPath}`;
  }
  
  if (isCelExpression(value)) {
    return `CEL expression: ${value.expression}`;
  }
  
  return `Direct value: ${value}`;
}
```

## Best Practices

### 1. Use Specific Types

Always use the most specific types available:

```typescript
// Good: Specific deployment type
import type { V1Deployment } from '@kubernetes/client-node';
const deploy: Enhanced<V1DeploymentSpec, V1DeploymentStatus> = deployment({...});

// Avoid: Generic resource type
const deploy: KubernetesResource = deployment({...});
```

### 2. Leverage Type Parameters

Use type parameters for reusable functions:

```typescript
function createWebService<TSpec>(
  spec: TSpec
): Enhanced<TSpec, V1ServiceStatus> {
  return service({
    metadata: { name: 'web-service' },
    spec
  });
}
```

### 3. Type-Safe References

Always specify expected types for references:

```typescript
// Good: Explicit type
const serviceName: KubernetesRef<string> = myService.metadata.name;

// Better: Type assertion in usage
const selector = { app: myService.metadata.name as string };
```

### 4. Validate Input Types

Use type guards for runtime validation:

```typescript
function deployResource(resource: RefOrValue<KubernetesResource>) {
  if (isKubernetesRef(resource)) {
    throw new Error('Cannot deploy resource reference directly');
  }
  
  // Safe to use as direct resource
  return resource;
}
```

## Related APIs

- [CEL Expressions API](/api/cel) - Working with expressions and references
- [Factory Functions API](/api/factories) - Creating typed resources
- [Resource Graphs Guide](/guide/resource-graphs) - Understanding resource relationships
- [Type Safety Guide](/guide/type-safety) - Advanced TypeScript patterns