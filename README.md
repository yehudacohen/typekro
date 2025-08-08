
# @yehudacohen/typekro

[![NPM Version](https://img.shields.io/npm/v/@yehudacohen/typekro.svg)](https://www.npmjs.com/package/@yehudacohen/typekro)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**TypeKro** is a hypermodern infrastructure-as-code library for Kubernetes. More specifically, it is a lightweight and fast TypeScript-native "compiler" that generates declarative manifests for the [Kro](https://kro.run) runtime. It bridges the gap between your static TypeScript code and your runtime infrastructure, providing full type safety, autocompletion, and cross-resource awareness directly in your editor.

## Overview

* **Full Type Safety:** Catch errors at compile time, not in your CI/CD pipeline. All resource definitions use the official Kubernetes types.
* **IDE Support:** Get intelligent autocompletion, refactoring, and error detection for all resource properties and cross-references.
* **Type-Safe Cross-Resource References:** Effortlessly link resources together by referencing runtime properties (like a Service IP or Deployment status) before they exist.
* **Advanced CEL Expressions:** Build complex runtime logic with type-safe CEL expressions that can reference multiple resources and perform calculations.
* **Deterministic Resource IDs:** Generate stable, predictable resource identifiers for reliable GitOps workflows and redeployments.
* **Automatic YAML Generation:** Compile your entire application stack into a single, declarative `ResourceGraphDefinition` manifest.
* **Custom Resource Support:** Define and validate your own CRDs with `arktype` schemas, giving them the same level of type safety as native resources.

## The TypeKro & Kro Workflow

TypeKro's "magic" is a partnership between a local compiler and an in-cluster controller.

1.  **You Write TypeScript:** Using TypeKro's helper functions, you define your application stack. When you need to link resources, you access properties directly or use CEL expressions for complex logic (e.g., `Cel.expr(database.status.readyReplicas, ' > 0')`). TypeKro's proxy system creates special `KubernetesRef` objects in memory.
2.  **TypeKro Compiles to a Resource Graph:** The `toKroResourceGraph()` function acts as a compiler. It analyzes the references between your resources and outputs a single `ResourceGraphDefinition` YAML file. Both simple references and complex CEL expressions are converted into `${...}` CEL expressions that Kro can evaluate.
3.  **Kro's Reconciliation Loop Takes Over:** The generated YAML is a Custom Resource for **Kro**, a Kubernetes controller running in your cluster.
    * You apply this manifest (typically via a GitOps tool like ArgoCD or Flux).
    * The Kro controller sees the `ResourceGraphDefinition`.
    * During its **reconciliation loop**, Kro reads the graph and begins creating the actual resources (Deployments, Services, etc.) in the correct order.
    * When it creates a resource like a Service, the Kubernetes API assigns it a `clusterIP`. Kro captures this live value.
    * Before creating the next resource, Kro evaluates the `${...}` CEL expressions using the live values it has captured, supporting both simple references and complex logic.

This process allows you to define complex, state-dependent infrastructure in a purely declarative way, leaving the imperative "how" to the in-cluster controller.

## How It's Different

Tools like **Pulumi** and **cdk8s** are powerful imperative frameworks that manage infrastructure directly. **TypeKro** takes a different, declarative-first approach.

* **It does not talk to your Kubernetes cluster.** Its only job is to compile your TypeScript code into a single, declarative `ResourceGraphDefinition` YAML manifest.
* **It integrates natively with GitOps.** The generated manifest is designed to be checked into Git and managed by tools like ArgoCD or Flux.
* **It is a pre-processor, not a state manager.** TypeKro focuses purely on generating a high-fidelity manifest, leaving state management and reconciliation to the in-cluster controller.

## Installation

```bash
bun add @yehudacohen/typekro @kubernetes/client-node arktype js-yaml
````

## Quick Start

Define multiple resources in a single TypeScript file.

**`my-app.ts`**

```typescript
import { simpleDeployment, simpleService, toKroResourceGraph } from '@yehudacohen/typekro';

// 1. Define a database service
const dbService = simpleService({
  name: 'db',
  selector: { app: 'db' },
  ports: [{ port: 5432 }],
});

// 2. Define a web application that safely references the database service's IP
const webapp = simpleDeployment({
  name: 'app',
  image: 'my-app:latest',
  env: {
    // This is a type-safe reference!
    DATABASE_HOST: dbService.spec.clusterIP,
  },
});

// 3. Serialize the entire stack to a Kro ResourceGraphDefinition
const yaml = toKroResourceGraph('my-app-stack', {
  dbService,
  webapp,
});

console.log(yaml);
```

## Understanding References: Values vs. Refs

TypeKro's referencing system is designed to be intuitive but has a few simple rules that are important to understand. The default behavior depends on whether the value of a property is known when you define it.

### The Default: Eager Values for Known Properties

When you access a property that was defined with a static, known value, TypeKro will return that value directly. This is useful for building up resource configurations.

```typescript
const configMap = simpleConfigMap({
  name: 'app-config',
  data: { greeting: 'Hello World' },
});

// This access returns the primitive string "Hello World"
const greetingValue = configMap.data.greeting; 
```

### Implicit References for Unknown Properties (Schema & Status)

When you access a property whose value cannot be known at build time—such as a schema input (`schema.spec...`) or a runtime status field (`database.status...`)—TypeKro automatically returns a **deferred reference**.

```typescript
// `schema.spec.name` is an unknown input, so this creates a reference.
const webapp = simpleDeployment({
  name: schema.spec.name,
  image: 'my-image:latest'
});

// `database.status.readyReplicas` is an unknown runtime value,
// so this also creates a reference automatically.
const isReadyExpr = Cel.expr(database.status.readyReplicas, ' > 0');
```

### Explicit References for Known Properties (The `$` Prefix)

If you have a property with a known value but you need a **reference** to it instead of the value itself (for instance, to link a Deployment's environment variable to a ConfigMap's data), you must explicitly ask for it using a `$` prefix.

```typescript
const configMap = simpleConfigMap({
  name: 'app-config',
  data: { greeting: 'Hello World' },
});

const webapp = simpleDeployment({
  name: 'my-app',
  image: 'my-image:latest',
  env: {
    // WRONG: This would assign the static string "Hello World"
    // GREETING_VALUE: configMap.data.greeting,

    // CORRECT: Using '$' gets a reference to the 'greeting' field.
    // The value will be resolved by Kro at runtime.
    GREETING_REF: configMap.data.$greeting,
  }
});
```

This `$fieldName` syntax is the explicit way to override the default "eager value" behavior and create a deferred dependency.

## Advanced CEL Expressions

TypeKro provides powerful CEL (Common Expression Language) support for complex runtime logic. CEL expressions are type-safe and can reference multiple resources.

```typescript
import { simpleDeployment, Cel, toKroResourceGraph } from '@yehudacohen/typekro';

const database = simpleDeployment({
  name: 'postgres',
  image: 'postgres:13'
});

const webapp = simpleDeployment({
  name: 'web-app',
  image: 'nginx:latest',
  env: {
    // Simple reference - converted to CEL automatically
    DB_READY_REPLICAS: database.status.readyReplicas,
    
    // Type conversion - convert numbers to strings for environment variables
    DB_READY_COUNT: Cel.string(database.status.readyReplicas),
    
    // Complex CEL expression with logic
    DB_IS_READY: Cel.expr(database.status.readyReplicas, ' > 0'),
    
    // Conditional logic
    DB_STATUS: Cel.conditional(
      Cel.expr(database.status.readyReplicas, ' > 0'),
      'ready',
      'not-ready'
    ),
    
    // Mathematical operations
    DB_SCALE_FACTOR: Cel.math('max', database.status.readyReplicas, 1),
    
    // String templating
    DB_CONNECTION: Cel.template(
      'postgresql://user:pass@%s:5432/db',
      database.status.podIP
    ),
    
    // Boolean conversion
    DB_AVAILABLE: Cel.bool(database.status.readyReplicas),
    
    // Number conversion
    DB_PORT: Cel.number('5432')
  }
});

// All references are converted to CEL expressions in the final YAML:
// DB_READY_REPLICAS: ${resources.deployment-default-postgres.status.readyReplicas}
// DB_READY_COUNT: ${string(resources.deployment-default-postgres.status.readyReplicas)}
// DB_IS_READY: ${resources.deployment-default-postgres.status.readyReplicas > 0}
// DB_STATUS: ${resources.deployment-default-postgres.status.readyReplicas > 0 ? 'ready' : 'not-ready'}
```

### CEL Expression Benefits

- **Type Safety**: All CEL expressions are validated at compile time
- **IDE Support**: Full autocomplete and error checking for referenced properties
- **Runtime Evaluation**: Expressions are evaluated by Kro during resource reconciliation
- **Complex Logic**: Support for conditionals, math operations, and string manipulation
- **Multi-Resource References**: Reference properties from multiple resources in a single expression

## Features

### Type-Safe Cross-Resource References

Reference any property from another resource, even from `status` fields that only exist at runtime.

```typescript
const database = simpleDeployment({ name: 'db', image: 'postgres' });

const webapp = simpleDeployment({
  name: 'web-app',
  image: 'nginx:latest',
  env: {
    // Type-safe reference to the database's ready replicas count
    DB_READY_REPLICAS: Cel.string(database.status.readyReplicas),
  }
});
```

### Custom Resource Definitions

Define your own CRDs with `arktype` for compile-time and runtime validation.

```typescript
import { customResource, Type } from '@yehudacohen/typekro';

const DatabaseSpec = Type({
  engine: "'postgresql' | 'mysql'",
  version: "string",
  "storage?": "string",
});

const database = customResource({
    apiVersion: 'db.example.com/v1',
    kind: 'Database',
    spec: DatabaseSpec
}, {
    metadata: { name: 'my-db' },
    spec: {
        engine: "postgresql",
        version: "14.5",
    }
});
```

### Deterministic Resource IDs for GitOps

TypeKro generates stable, predictable resource identifiers that remain consistent across deployments, making it perfect for GitOps workflows.

```typescript
// Resources get deterministic IDs based on kind, namespace, and name
const webapp = simpleDeployment({
  name: 'web-app',
  image: 'nginx:latest'
});
// Generated ID: "deployment-default-web-app"

const prodApp = simpleDeployment({
  name: 'web-app',
  image: 'nginx:latest',
  namespace: 'production'
});
// Generated ID: "deployment-production-web-app"

// You can also specify explicit IDs (like Kro's approach)
const customApp = simpleDeployment({
  name: 'web-app',
  image: 'nginx:latest',
  id: 'my-custom-webapp-id'
});
```

**Benefits for GitOps:**
- **Stable Redeployments**: Same resource definition always generates identical YAML
- **Predictable References**: Cross-resource references use consistent IDs
- **Git-Friendly**: Generated YAML doesn't change unnecessarily between commits
- **Kro Compatible**: Supports explicit ID specification like native Kro resources

## Resource Coverage

TypeKro provides comprehensive coverage of Kubernetes resource types with 40+ factory functions:

### Core Workload Resources
- `deployment()` - Kubernetes Deployments
- `service()` - Kubernetes Services  
- `job()` - Kubernetes Jobs
- `statefulSet()` - Kubernetes StatefulSets
- `cronJob()` - Kubernetes CronJobs
- `configMap()` - Configuration data
- `secret()` - Sensitive data
- `persistentVolumeClaim()` - Storage claims
- `horizontalPodAutoscaler()` - Auto-scaling (V2 API)
- `horizontalPodAutoscalerV1()` - Auto-scaling (V1 API)
- `ingress()` - External access
- `networkPolicy()` - Network security

### RBAC Resources
- `role()` - Namespace-scoped permissions
- `roleBinding()` - Bind roles to subjects
- `clusterRole()` - Cluster-wide permissions
- `clusterRoleBinding()` - Bind cluster roles
- `serviceAccount()` - Pod identity

### Apps Resources
- `daemonSet()` - Node-wide deployments
- `replicaSet()` - Pod replicas
- `replicationController()` - Legacy pod controller

### Core Resources
- `pod()` - Individual pods
- `namespace()` - Resource isolation
- `persistentVolume()` - Storage volumes
- `node()` - Cluster nodes
- `componentStatus()` - Component health

### Policy Resources
- `podDisruptionBudget()` - Availability policies
- `resourceQuota()` - Resource limits
- `limitRange()` - Default limits

### Storage Resources
- `storageClass()` - Storage types
- `volumeAttachment()` - Volume attachments
- `csiDriver()` - CSI drivers
- `csiNode()` - CSI node info

### Networking Resources
- `endpoints()` - Service endpoints
- `endpointSlice()` - Scalable endpoints
- `ingressClass()` - Ingress controllers

### Certificate Resources
- `certificateSigningRequest()` - Certificate requests

### Coordination Resources
- `lease()` - Leader election and coordination

### Admission Resources
- `mutatingWebhookConfiguration()` - Mutating admission webhooks
- `validatingWebhookConfiguration()` - Validating admission webhooks

### Extensions Resources
- `customResourceDefinition()` - Define CRDs

### Priority and Runtime Resources
- `priorityClass()` - Pod priority classes
- `runtimeClass()` - Container runtime classes

### Custom Resources
- `customResource()` - Define custom resources with Arktype validation

All resources support:
- **Full Type Safety** using official `@kubernetes/client-node` types
- **Cross-Resource References** with compile-time validation
- **IDE Autocomplete** for all properties and fields
- **Deterministic Resource IDs** for GitOps workflows

## Development

```bash
# Install dependencies
bun install

# Build the library
bun run build

# Run tests
bun test
