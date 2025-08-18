# typekro

[![NPM Version](https://img.shields.io/npm/v/typekro.svg)](https://www.npmjs.com/package/typekro)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

TypeKro is a hypermodern infrastructure-as-code library for Kubernetes that blends the type safety of TypeScript, the GitOps-friendly output of declarative YAML, and the runtime intelligence of continuous reconciliation.

If you've worked with Kubernetes before, you've probably faced one of these trade-offs:

- **Writing raw YAML** — declarative but error-prone, hard to refactor, and brittle with dependencies
- **Using imperative IaC** — type-safe but stateful, and often awkward to integrate with GitOps
- **Hand-managing resource dependencies** — either in code or with fragile dependsOn patterns

TypeKro removes those trade-offs: you define Kubernetes infrastructure in pure TypeScript, get full IDE autocomplete and compile-time validation, and then choose your deployment mode:

- **Generate deterministic YAML** for ArgoCD, Flux, or kubectl
- **Deploy directly to a cluster** for rapid feedback
- **Combine with Kro** for runtime dependency resolution and self-healing drift correction

Think of it as CDK8s + Pulumi + Kubernetes-native reconciliation, in one workflow.

---

## At a Glance

| Feature | Benefit |
|---------|---------|
| **Full TypeScript type safety** | Catch errors before they hit your CI/CD pipeline. |
| **Runtime cross-resource references** | Link resources and evaluate conditions at reconciliation time. |
| **GitOps-friendly** | Deterministic YAML generation for ArgoCD, Flux, and similar. |
| **Multiple deployment modes** | Choose YAML output, direct deployment, or hybrid cloud integration. |
| **Kubernetes-native** | No external state backends or custom orchestration layers. |

---

If you’ve used tools like Pulumi or CDK8s, you’ll find familiar concepts — but TypeKro goes further by combining **developer ergonomics**, **runtime intelligence**, and **Kubernetes-native reconciliation** into a single workflow.

The sections below dive into the architecture, usage patterns, and advanced features in detail.

---

## TL;DR - Show Me the Code

Here's a complete web application with database in ~30 lines of TypeScript:

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

// Define your app's interface
const WebAppSchema = {
  spec: type({ name: 'string', image: 'string', replicas: 'number' }),
  status: type({ ready: 'boolean', url: 'string' })
};

// Create your infrastructure
const webapp = toResourceGraph(
  { name: 'my-webapp', apiVersion: 'example.com/v1', kind: 'WebApp', ...WebAppSchema },
  (schema) => ({
    // Database
    database: simpleDeployment({
      name: 'postgres', image: 'postgres:15',
      env: { POSTGRES_DB: 'app', POSTGRES_USER: 'user', POSTGRES_PASSWORD: 'secret' }
    }),
    
    // Service (defined first to show cross-references work in any order)
    service: simpleService({
      name: schema.spec.name,  // Type-safe schema reference
      id: 'webappService',
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    }),
    
    // Web app that references schema fields
    app: simpleDeployment({
      name: schema.spec.name,    // Type-safe schema reference
      image: schema.spec.image,  // Full IDE autocomplete
      replicas: schema.spec.replicas,
      id: 'webappDeployment',
      env: { DATABASE_HOST: 'postgres' }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0'),  // Runtime logic
    url: Cel.template('http://%s', schema.spec.name)  // String templating with schema reference
  })
);

// Deploy it
console.log(webapp.toYaml());  // GitOps-ready YAML
// OR: await webapp.factory('direct').deploy({ name: 'my-app', image: 'nginx', replicas: 3 });
```

**That's it!** TypeScript gives you full type safety, Kro handles the runtime dependencies, and you get production-ready infrastructure.

---

## Overview

* **Full Type Safety:** Catch errors at build time, not in your CI/CD pipeline. All resource definitions use the official Kubernetes types.
* **IDE Support:** Get intelligent autocompletion, refactoring, and error detection for all resource properties and cross-references.
* **Type-Safe Cross-Resource References:** Effortlessly link resources together by referencing runtime properties (like a Service IP or Deployment status) before they exist.
* **Continuous Reconciliation:** Kro continuously monitors and maintains your infrastructure, automatically healing drift and ensuring desired state.
* **Advanced CEL Expressions:** Build complex runtime logic with type-safe CEL expressions that can reference multiple resources and perform calculations.
* **Deterministic Resource IDs:** Generate stable, predictable resource identifiers for reliable GitOps workflows and redeployments.
* **Automatic YAML Generation:** Compile your entire application stack into a single, declarative `ResourceGraphDefinition` manifest.
* **Custom Resource Support:** Define and validate your own CRDs with `arktype` schemas, giving them the same level of type safety as native resources.

---

## The TypeKro & Kro Workflow

TypeKro's "magic" is a partnership between a local compiler and an in-cluster controller.

1.  **You Write TypeScript:** Using TypeKro's helper functions, you define your application stack. When you need to link resources, you access properties directly or use CEL expressions for complex logic (e.g., `Cel.expr(database.status.readyReplicas, ' > 0')`). TypeKro's proxy system creates special `KubernetesRef` objects in memory.
2.  **TypeKro Compiles to a Resource Graph:** The `toResourceGraph()` function acts as a compiler. It analyzes the references between your resources and outputs a single `ResourceGraphDefinition` YAML file. Both simple references and complex CEL expressions are converted into `${...}` CEL expressions that Kro can evaluate.
3.  **Kro's Reconciliation Loop Takes Over:** The generated YAML is a Custom Resource for **Kro**, a Kubernetes controller running in your cluster.
    * You apply this manifest (typically via a GitOps tool like ArgoCD or Flux).
    * The Kro controller sees the `ResourceGraphDefinition`.
    * During its **reconciliation loop**, Kro reads the graph and begins creating the actual resources (Deployments, Services, etc.) in the correct order.
    * When it creates a resource like a Service, the Kubernetes API assigns it a `clusterIP`. Kro captures this live value.
    * Before creating the next resource, Kro evaluates the `${...}` CEL expressions using the live values it has captured, supporting both simple references and complex logic.

This process allows you to define complex, state-dependent infrastructure in a purely declarative way, leaving the imperative "how" to the in-cluster controller.

## How It's Different

### Built on Kro

TypeKro is built on top of [KRO](https://kro.run), a powerful Kubernetes controller that enables declarative resource composition. We chose Kro as our foundation because:

* **Declarative-First Design** - KRO's approach aligns perfectly with GitOps and declarative infrastructure principles
* **Runtime Dependency Resolution** - Kro handles complex resource dependencies and cross-references at runtime using CEL expressions
* **Kubernetes-Native** - Kro extends Kubernetes naturally through Custom Resource Definitions, requiring no external state management
* **Production-Ready** - Kro is battle-tested and designed for enterprise Kubernetes environments

TypeKro enhances Kro by adding **full TypeScript type safety**, **IDE support**, and **developer-friendly abstractions** while preserving all of Kro's declarative power.

### vs. Pulumi

**Pulumi** is a powerful imperative infrastructure-as-code framework that manages resources directly:

| Aspect | TypeKro | Pulumi |
|--------|---------|---------|
| **Approach** | Declarative compilation to YAML | Imperative resource management |
| **State Management** | Kubernetes-native (via Kro) | External state backend required |
| **Cluster Communication** | Multiple modes: YAML generation, direct deployment, alchemy integration | Direct API calls to cloud providers |
| **GitOps Integration** | Native - generates pure YAML | Requires additional tooling |
| **Dependency Resolution** | Both execution-time and runtime: TypeKro resolves at execution-time, Kro handles runtime dependencies | Execution-time via imperative engine |
| **Continuous Reconciliation** | ✅ Kro continuously maintains desired state and heals drift | ❌ One-time deployment, manual intervention for drift |
| **Rollback Strategy** | Kubernetes-native declarative | Imperative state reconciliation |

### Key Advantages Over Pulumi

- **🔄 Continuous Reconciliation**: Kro continuously monitors and reconciles your infrastructure, automatically healing drift and maintaining desired state
- **📦 No External State**: Uses Kubernetes-native state management instead of requiring external backends
- **🔀 GitOps Native**: Generates pure YAML that integrates seamlessly with ArgoCD, Flux, and other GitOps tools
- **⚡ Faster Feedback**: Declarative approach means faster deployments and easier rollbacks
- **🛡️ Production Proven**: Built on Kubernetes primitives that are battle-tested at scale

### vs. CDK8s

TypeKro provides everything CDK8s offers plus powerful runtime capabilities:

| Capability | TypeKro | CDK8s |
|------------|---------|-------|
| **Cross-Resource References** | ✅ Runtime resolution via CEL | ❌ Static values only |
| **Type Safety** | ✅ Full TypeScript + runtime validation | ⚠️ TypeScript only |
| **Resource Dependencies** | ✅ Automatic dependency graph | ❌ Manual ordering required |
| **Status Field Access** | ✅ Type-safe runtime status references | ❌ Not supported |
| **Custom Resources** | ✅ Full CRD support with validation | ⚠️ Basic YAML generation |
| **Runtime Logic** | ✅ CEL expressions for complex logic | ❌ Static configuration only |
| **Continuous Reconciliation** | ✅ Kro controller maintains desired state | ❌ One-time YAML generation |
| **Drift Detection** | ✅ Automatic detection and correction | ❌ Manual intervention required |

**TypeKro supersedes CDK8s** by providing all the same static generation capabilities plus dynamic runtime features that CDK8s cannot support.

## TypeKro's Deployment Strategies

TypeKro provides **two core deployment strategies** with optional **Alchemy integration** for hybrid infrastructure management:

### 1. YAML Generation (Declarative)
Generate pure Kubernetes YAML for GitOps workflows:
```typescript
const yaml = graph.toYaml();
// Deploy via kubectl, ArgoCD, Flux, etc.
```
- ✅ **No cluster access required** during generation
- ✅ **GitOps-friendly** - commit YAML to Git
- ✅ **Kro controller** handles runtime dependency resolution

### 2. Direct Deployment (Imperative)
Deploy directly to Kubernetes clusters:
```typescript
const factory = await graph.factory('direct', { namespace: 'prod' });
const instance = await factory.deploy(spec);
```
- ✅ **Full cluster communication** - TypeKro talks directly to Kubernetes API
- ✅ **Immediate feedback** - get deployment status in real-time
- ✅ **Dependency resolution** - TypeKro resolves dependencies at execution-time

### Alchemy Integration (Works with Both Strategies)

**Alchemy** is an integration layer that can be used with **both Kro and Direct factories** to manage hybrid cloud-native infrastructure:

#### With Kro Factory + Alchemy
```typescript
const kroFactory = await graph.factory('kro', { 
  namespace: 'prod',
  alchemyScope: scope  // Pass alchemy scope as option
});
const instance = await kroFactory.deploy(spec);
```
- ✅ **Declarative Kubernetes** - Kro handles Kubernetes resources
- ✅ **Imperative Cloud** - Alchemy manages cloud resources
- ✅ **Cross-platform references** - cloud resources can reference Kubernetes resources

#### With Direct Factory + Alchemy
```typescript
const directFactory = await graph.factory('direct', { 
  namespace: 'prod',
  alchemyScope: scope  // Pass alchemy scope as option
});
const instance = await directFactory.deploy(spec);
```
- ✅ **Imperative Kubernetes** - Direct deployment to Kubernetes API
- ✅ **Imperative Cloud** - Alchemy manages cloud resources
- ✅ **Unified lifecycle** - both cloud and Kubernetes resources managed together

This flexibility allows TypeKro to support **declarative GitOps workflows** (YAML generation), **imperative deployment patterns** (direct deployment), and **hybrid cloud-native integration** (Alchemy integration via `alchemyScope` option works with both Kro and Direct factories to manage cloud and Kubernetes resources together).

### Why TypeKro is the Superior Choice

TypeKro delivers everything other tools promise, plus capabilities they can't match:

* **🚀 Best Developer Experience** - Full TypeScript type safety with intelligent IDE support that surpasses all alternatives
* **🔄 Continuous Reconciliation** - Unlike Pulumi/CDK8s, your infrastructure self-heals and maintains desired state automatically  
* **⚡ Multiple Deployment Modes** - YAML generation, direct deployment, AND hybrid cloud integration in one tool
* **🎯 Runtime Intelligence** - Dynamic cross-resource references and status-aware logic that static tools cannot provide
* **📦 Zero External Dependencies** - No state backends, no external services - just Kubernetes-native infrastructure

**TypeKro is the only tool that combines enterprise-grade type safety with Kubernetes-native continuous reconciliation.** Why settle for partial solutions when you can have it all?

## Architecture & Core Mechanisms

### The Factory Pattern

TypeKro uses a **factory pattern** to create typed resource graphs. The `toResourceGraph()` function takes three key components:

1. **Schema Definition** - Defines the CRD structure using ArkType schemas
2. **Resource Builder Function** - Creates Kubernetes resources with cross-references
3. **Status Builder Function** - Maps runtime status from deployed resources

```typescript
const graph = toResourceGraph(
  // 1. Schema Definition
  {
    name: 'my-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp', 
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  // 2. Resource Builder - runs at execution time
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,  // Creates a reference
      image: schema.spec.image,
    }),
  }),
  // 3. Status Builder - defines runtime status mapping
  (schema, resources) => ({
    // CEL expression required for runtime evaluation by Kro
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' > 0'),
    
    // Direct reference - automatically converted to CEL
    replicas: resources.deployment.status.readyReplicas,
  })
);
```

### Status Builder Patterns

The **Status Builder** function defines how runtime status fields are populated. There are two important patterns to understand:

#### Direct References (Automatically Converted to CEL)
```typescript
(schema, resources) => ({
  // This creates: ${resources.deployment-default-webapp.status.readyReplicas}
  replicas: resources.webapp.status.readyReplicas,
  
  // This creates: ${schema.spec.name}
  name: schema.spec.name,
})
```

#### Complex Logic (Requires Explicit CEL)
```typescript
(schema, resources) => ({
  // ❌ WRONG: JavaScript expressions don't work in Kro
  // ready: resources.webapp.status.readyReplicas > 0,
  
  // ✅ CORRECT: Use Cel.expr for runtime logic
  ready: Cel.expr(resources.webapp.status.readyReplicas, ' > 0'),
  
  // ✅ CORRECT: Complex conditional logic
  status: Cel.conditional(
    Cel.expr(resources.webapp.status.readyReplicas, ' > 0'),
    'ready',
    'not-ready'
  ),
})
```

**Key Rule**: If your status field contains any JavaScript logic (comparisons, conditionals, calculations), you must use `Cel.expr()` or other CEL functions. Simple property references are automatically converted to CEL expressions.

### The Magic Proxy System

TypeKro's "magic" comes from its **proxy system** that creates different behaviors for execution-time vs runtime values:

#### Static Values (Known at Execution Time)
```typescript
const deployment = simpleDeployment({
  name: 'my-app',        // Static string
  replicas: 3,           // Static number
});

// Accessing static values returns the actual value
console.log(deployment.spec.replicas); // Returns: 3
```

#### Dynamic References (Unknown at Execution Time)
```typescript
const deployment = simpleDeployment({
  name: schema.spec.name,  // Schema reference - unknown until runtime
});

// Accessing schema or status fields creates KubernetesRef objects
const nameRef = schema.spec.name;        // Creates: KubernetesRef<string>
const statusRef = deployment.status.readyReplicas; // Creates: KubernetesRef<number>
```

#### The `$` Prefix for Explicit References
```typescript
const configMap = simpleConfigMap({
  name: 'config',
  data: { key: 'value' }  // Static value
});

const deployment = simpleDeployment({
  name: 'app',
  env: {
    // Static behavior: Uses the known value "value" at execution time
    // Good for: Values that won't change, faster resolution
    STATIC_VALUE: configMap.data.key,
    
    // Dynamic behavior: Creates reference resolved by Kro at runtime
    // Good for: Values that might change, live updates from cluster
    DYNAMIC_VALUE: configMap.data.$key,
  }
});
```

**Both approaches are valid** - choose based on whether you want execution-time resolution (static) or runtime resolution (dynamic). The `$` prefix gives you explicit control over when values are resolved.

### Cross-Resource Reference Resolution

TypeKro analyzes all `KubernetesRef` objects to build a **dependency graph**:

1. **Reference Detection** - Scans all resource definitions for `KubernetesRef` objects
2. **Dependency Analysis** - Builds a graph showing which resources depend on others
3. **CEL Expression Generation** - Converts references to `${...}` CEL expressions
4. **Resource Ordering** - Ensures resources are created in dependency order

```typescript
// This TypeScript code...
const database = simpleDeployment({ name: 'db', image: 'postgres' });
const webapp = simpleDeployment({
  name: 'web',
  env: { DB_HOST: database.status.podIP }  // Creates dependency
});

// ...generates this CEL expression in YAML:
// env:
//   - name: DB_HOST
//     value: ${resources.deployment-default-db.status.podIP}
```

### CEL Expression System

TypeKro provides a comprehensive CEL (Common Expression Language) system for complex runtime logic:

#### Simple References
```typescript
// Automatic CEL generation
env: {
  DB_REPLICAS: database.status.readyReplicas,
}
// Generates: ${resources.deployment-default-database.status.readyReplicas}
```

#### Complex Expressions
```typescript
import { Cel } from 'typekro';

env: {
  // Boolean logic
  DB_READY: Cel.expr(database.status.readyReplicas, ' > 0'),
  
  // Conditional logic
  DB_STATUS: Cel.conditional(
    Cel.expr(database.status.readyReplicas, ' > 0'),
    'ready',
    'not-ready'
  ),
  
  // String templating
  DB_URL: Cel.template('postgresql://%s:5432/db', database.status.podIP),
  
  // Type conversions
  DB_COUNT: Cel.string(database.status.readyReplicas),
  DB_PORT: Cel.number('5432'),
  DB_AVAILABLE: Cel.bool(database.status.readyReplicas),
}
```

### Deterministic Resource IDs

TypeKro generates **stable, predictable resource identifiers** for GitOps workflows:

#### Automatic ID Generation
```typescript
const deployment = simpleDeployment({
  name: 'web-app',
  namespace: 'production'
});
// Generated ID: "deployment-production-web-app"
```

#### Explicit ID Override
```typescript
const deployment = simpleDeployment({
  name: schema.spec.name,  // Dynamic name
  id: 'webapp-deployment'  // Explicit stable ID
});
// Uses ID: "webapp-deployment"
```

### Deployment Strategies

TypeKro supports multiple deployment strategies through its factory pattern:

#### Kro Deployment (Default)
```typescript
const factory = await graph.factory('kro', { namespace: 'production' });
const instance = await factory.deploy({ name: 'my-app', image: 'nginx:latest' });
```

#### Direct Deployment
```typescript
const factory = await graph.factory('direct', { namespace: 'production' });
const instance = await factory.deploy({ name: 'my-app', image: 'nginx:latest' });
```

#### Alchemy Integration
```typescript
// Use with Kro factory
const kroFactory = await graph.factory('kro', { 
  namespace: 'production',
  alchemyScope: alchemyScope
});
const instance = await kroFactory.deploy({ 
  name: 'my-app', 
  image: 'nginx:latest' 
});

// Or use with Direct factory
const directFactory = await graph.factory('direct', { 
  namespace: 'production',
  alchemyScope: alchemyScope
});
const instance = await directFactory.deploy({ 
  name: 'my-app', 
  image: 'nginx:latest' 
});
```

### Type Safety Throughout

TypeKro maintains **full type safety** at every level:

- **Schema Validation** - ArkType schemas validate input at runtime
- **Resource Types** - Official `@kubernetes/client-node` types for all Kubernetes resources
- **Cross-References** - TypeScript ensures referenced fields actually exist
- **CEL Expressions** - Type-safe CEL expression building with proper return types
- **Status Mapping** - Execution-time validation of status field mappings

This architecture enables TypeKro to provide a **declarative, type-safe, GitOps-friendly** approach to Kubernetes infrastructure management while maintaining the flexibility and power needed for complex applications.

## Documentation

For comprehensive documentation, examples, and guides:

- **[Getting Started Guide](docs/getting-started.md)** - Step-by-step tutorial for new users
- **[API Reference](docs/api-reference.md)** - Complete API documentation with examples
- **[Factory Functions](docs/factory-functions.md)** - Guide to all available resource factories
- **[CEL Expressions](docs/cel-expressions.md)** - Advanced CEL expression patterns
- **[Cross-Resource References](docs/cross-references.md)** - Linking resources together
- **[Deployment Strategies](docs/deployment-strategies.md)** - Direct vs Kro vs Alchemy deployment
- **[Examples](examples/)** - Real-world usage examples and patterns
- **[Contributing Guide](CONTRIBUTING.md)** - How to contribute to TypeKro

> **Note**: Comprehensive documentation site is coming soon! The above links will be available once the documentation site is deployed.

## Installation

```bash
bun add typekro
```

TypeKro automatically includes all necessary dependencies:
- `@kubernetes/client-node` - Official Kubernetes client types
- `arktype` - Runtime type validation and schema definition
- `js-yaml` - YAML serialization
- `cel-js` - CEL expression support
- `pino` - Structured logging

## Quick Start

Create a complete web application stack with TypeKro's modern API.

**`my-app.ts`**

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

// 1. Define your application schema
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
});

const WebAppStatusSchema = type({
  ready: 'boolean',
  url: 'string',
  replicas: 'number',
});

// 2. Create your resource graph
const webappGraph = toResourceGraph(
  {
    name: 'my-webapp',
    apiVersion: 'example.com/v1alpha1', 
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  // Define your Kubernetes resources
  (schema) => ({
    database: simpleDeployment({
      name: 'postgres',
      image: 'postgres:13',
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'webapp', 
        POSTGRES_PASSWORD: 'secure-password',
      },
      ports: [{ name: 'postgres', containerPort: 5432 }],
    }),

    webapp: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      id: 'webappDeployment', // Explicit ID when using schema references
      env: {
        // Type-safe reference to database service
        DATABASE_HOST: 'postgres',
        DATABASE_PORT: '5432',
      },
      ports: [{ name: 'http', containerPort: 80 }],
    }),

    service: simpleService({
      name: 'webapp-service',
      selector: { app: 'webapp' }, // Use static value for selector
      ports: [{ name: 'http', port: 80, targetPort: 80 }],
    }),
  }),
  // Define status field mappings
  (schema, resources) => ({
    // CEL expression for runtime logic
    ready: Cel.expr(resources.webapp.status.readyReplicas, ' > 0'),
    // Static string (hydrated client-side)
    url: `http://webapp-service`,
    // Direct reference (automatically converted to CEL)
    replicas: resources.webapp.status.readyReplicas,
  })
);

// 3. Generate the Kro ResourceGraphDefinition YAML
console.log(webappGraph.toYaml());
```

**Deploy to your cluster:**

```bash
# Generate and apply the resource graph
bun run my-app.ts | kubectl apply -f -
```

This generates a complete `ResourceGraphDefinition` that Kro can deploy:

```yaml
apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: my-webapp
  namespace: default
spec:
  schema:
    apiVersion: v1alpha1
    kind: WebApp
    spec:
      image: string
      name: string
      replicas: integer
    status:
      ready: ${webappDeployment.status.readyReplicas > 0}
      replicas: ${webappDeployment.status.readyReplicas}
  resources:
    - id: deploymentPostgres
      template:
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: postgres
          labels:
            app: postgres
        spec:
          replicas: 1
          selector:
            matchLabels:
              app: postgres
          template:
            metadata:
              labels:
                app: postgres
            spec:
              containers:
                - name: postgres
                  image: postgres:13
                  env:
                    - name: POSTGRES_DB
                      value: webapp
                    - name: POSTGRES_USER
                      value: webapp
                    - name: POSTGRES_PASSWORD
                      value: secure-password
                  ports:
                    - name: postgres
                      containerPort: 5432
    - id: webappDeployment
      template:
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: ${schema.spec.name}
          labels:
            app: ${schema.spec.name}
        spec:
          replicas: ${schema.spec.replicas}
          selector:
            matchLabels:
              app: ${schema.spec.name}
          template:
            metadata:
              labels:
                app: ${schema.spec.name}
            spec:
              containers:
                - name: ${schema.spec.name}
                  image: ${schema.spec.image}
                  env:
                    - name: DATABASE_HOST
                      value: postgres
                    - name: DATABASE_PORT
                      value: "5432"
                  ports:
                    - name: http
                      containerPort: 80
    - id: webappService
      template:
        apiVersion: v1
        kind: Service
        metadata:
          name: webapp-service
        spec:
          selector:
            app: webapp
          ports:
            - name: http
              port: 80
              targetPort: 80
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
import { simpleDeployment, Cel, toKroResourceGraph } from 'typekro';

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

- **Type Safety**: All CEL expressions are validated at execution time
- **IDE Support**: Full autocomplete and error checking for referenced properties
- **Runtime Evaluation**: Expressions are evaluated by Kro during resource reconciliation
- **Complex Logic**: Support for conditionals, math operations, and string manipulation
- **Multi-Resource References**: Reference properties from multiple resources in a single expression

## Real-World Examples

### Microservices Architecture

Create a complete microservices stack with service discovery and load balancing:

```typescript
import { type } from 'arktype';
import { 
  toResourceGraph, 
  simpleDeployment, 
  simpleService, 
  simpleIngress,
  simpleConfigMap,
  Cel 
} from 'typekro';

const MicroservicesSpecSchema = type({
  environment: "'development' | 'staging' | 'production'",
  hostname: 'string',
  apiReplicas: 'number',
  frontendReplicas: 'number',
});

const MicroservicesStatusSchema = type({
  ready: 'boolean',
  url: 'string',
  services: {
    api: 'boolean',
    frontend: 'boolean',
    database: 'boolean',
  },
});

const microservicesGraph = toResourceGraph(
  {
    name: 'microservices-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'MicroservicesApp',
    spec: MicroservicesSpecSchema,
    status: MicroservicesStatusSchema,
  },
  (schema) => ({
    // Configuration
    appConfig: simpleConfigMap({
      name: 'app-config',
      data: {
        environment: schema.spec.environment,
        apiUrl: 'http://api-service:3000',
        databaseUrl: 'postgresql://postgres-service:5432/app',
      },
    }),

    // Database
    database: simpleDeployment({
      name: 'postgres',
      image: 'postgres:15',
      env: {
        POSTGRES_DB: 'app',
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'secure-password',
      },
      ports: [{ name: 'postgres', containerPort: 5432 }],
    }),

    databaseService: simpleService({
      name: 'postgres-service',
      selector: { app: 'postgres' },
      ports: [{ name: 'postgres', port: 5432, targetPort: 5432 }],
    }),

    // API Service
    api: simpleDeployment({
      name: 'api',
      image: 'my-api:latest',
      replicas: schema.spec.apiReplicas,
      env: {
        NODE_ENV: schema.spec.environment,
        DATABASE_URL: 'postgresql://postgres-service:5432/app',
        // Wait for database to be ready
        DB_READY: Cel.expr(database.status.readyReplicas, ' > 0'),
      },
      ports: [{ name: 'http', containerPort: 3000 }],
    }),

    apiService: simpleService({
      name: 'api-service',
      selector: { app: 'api' },
      ports: [{ name: 'http', port: 3000, targetPort: 3000 }],
    }),

    // Frontend
    frontend: simpleDeployment({
      name: 'frontend',
      image: 'my-frontend:latest',
      replicas: schema.spec.frontendReplicas,
      env: {
        NODE_ENV: schema.spec.environment,
        API_URL: 'http://api-service:3000',
        // Only start when API is ready
        API_READY: Cel.expr(api.status.readyReplicas, ' > 0'),
      },
      ports: [{ name: 'http', containerPort: 80 }],
    }),

    frontendService: simpleService({
      name: 'frontend-service',
      selector: { app: 'frontend' },
      ports: [{ name: 'http', port: 80, targetPort: 80 }],
    }),

    // Ingress
    ingress: simpleIngress({
      name: 'app-ingress',
      ingressClassName: 'nginx',
      rules: [
        {
          host: schema.spec.hostname,
          http: {
            paths: [
              {
                path: '/api',
                pathType: 'Prefix',
                backend: {
                  service: { name: 'api-service', port: { number: 3000 } },
                },
              },
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: { name: 'frontend-service', port: { number: 80 } },
                },
              },
            ],
          },
        },
      ],
    }),
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.database.status.readyReplicas, ' > 0 && ',
      resources.api.status.readyReplicas, ' > 0 && ',
      resources.frontend.status.readyReplicas, ' > 0'
    ),
    url: Cel.template('https://%s', schema.spec.hostname),
    services: {
      database: Cel.expr(resources.database.status.readyReplicas, ' > 0'),
      api: Cel.expr(resources.api.status.readyReplicas, ' > 0'),
      frontend: Cel.expr(resources.frontend.status.readyReplicas, ' > 0'),
    },
  })
);
```

### Database Integration with Secrets

Secure database connections using Kubernetes secrets:

```typescript
import { simpleSecret, simpleDeployment, simpleService } from 'typekro';

const databaseGraph = toResourceGraph(
  {
    name: 'secure-database',
    apiVersion: 'example.com/v1alpha1',
    kind: 'SecureDatabase',
    spec: type({ name: 'string', storageSize: 'string' }),
    status: type({ ready: 'boolean', endpoint: 'string' }),
  },
  (schema) => ({
    // Database credentials secret
    dbSecret: simpleSecret({
      name: 'db-credentials',
      data: {
        username: btoa('dbuser'),
        password: btoa('secure-random-password'),
        database: btoa(schema.spec.name),
      },
    }),

    // Database deployment with secret references
    database: simpleDeployment({
      name: schema.spec.name,
      image: 'postgres:15',
      env: {
        // Reference secret values using $ prefix
        POSTGRES_USER: dbSecret.data.$username,
        POSTGRES_PASSWORD: dbSecret.data.$password,
        POSTGRES_DB: dbSecret.data.$database,
      },
      ports: [{ name: 'postgres', containerPort: 5432 }],
      volumeMounts: [
        {
          name: 'postgres-storage',
          mountPath: '/var/lib/postgresql/data',
        },
      ],
    }),

    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ name: 'postgres', port: 5432, targetPort: 5432 }],
    }),
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.database.status.readyReplicas, ' > 0'),
    endpoint: Cel.template('%s-service:5432', schema.spec.name),
  })
);
```

## Deployment Flexibility

One of TypeKro's key strengths is **deployment flexibility** - you write your infrastructure code once, then deploy it multiple ways depending on your needs. The same resource graph can be deployed with different strategies, reconciliation behaviors, and environments.

### The Same Code, Multiple Deployment Modes

```typescript
// Define your infrastructure once
const webappGraph = toResourceGraph(/* ... your resource definition ... */);

// Deploy the SAME code in different ways:

// 1. Generate YAML for GitOps (no cluster interaction)
const yaml = webappGraph.toYaml();
writeFileSync('k8s/webapp.yaml', yaml);

// 2. Deploy directly to cluster (immediate)
const directFactory = await webappGraph.factory('direct', { namespace: 'dev' });
const directInstance = await directFactory.deploy(spec);

// 3. Deploy via Kro controller (declarative)
const kroFactory = await webappGraph.factory('kro', { namespace: 'prod' });
const kroInstance = await kroFactory.deploy(spec);

// 4. Deploy with Alchemy integration (works with both kro and direct)
const kroWithAlchemy = await webappGraph.factory('kro', { 
  namespace: 'staging',
  alchemyScope: scope
});
const alchemyInstance = await kroWithAlchemy.deploy(spec);
```

### Deployment Strategies Explained

#### 1. YAML Generation (GitOps)

**Best for**: Production deployments, GitOps workflows, CI/CD pipelines

```typescript
// Generate ResourceGraphDefinition YAML
const yaml = webappGraph.toYaml();

// Save for GitOps deployment
writeFileSync('manifests/webapp.yaml', yaml);

// Or pipe directly to kubectl
console.log(yaml); // bun run generate.ts | kubectl apply -f -
```

**Characteristics:**
- ✅ No cluster access required
- ✅ Perfect for GitOps (ArgoCD, Flux)
- ✅ Auditable and version-controlled
- ✅ Kro controller handles reconciliation
- ❌ No immediate feedback on deployment status

#### 2. Direct Deployment

**Best for**: Development, testing, immediate deployment needs

```typescript
const factory = await webappGraph.factory('direct', {
  namespace: 'development',
  waitForReady: true,    // Wait for resources to be ready
  timeout: 300000,       // 5 minute timeout
  hydrateStatus: true,   // Populate status fields with live data
});

// Deploy with immediate feedback
const instance = await factory.deploy({
  name: 'my-dev-app',
  image: 'nginx:latest',
  replicas: 1,
});

// Status is immediately available
console.log('Ready replicas:', instance.status.replicas);
console.log('App URL:', instance.status.url);
```

**Characteristics:**
- ✅ Immediate deployment and feedback
- ✅ TypeKro resolves dependencies and deploys in order
- ✅ Status fields hydrated with live cluster data
- ✅ No Kro controller required
- ❌ Requires cluster access from deployment environment
- ❌ Not ideal for production GitOps workflows

#### 3. Kro Deployment (Recommended for Production)

**Best for**: Production deployments, complex dependency management, declarative infrastructure

```typescript
const factory = await webappGraph.factory('kro', {
  namespace: 'production',
});

// Deploy via Kro ResourceGraphDefinition
const instance = await factory.deploy({
  name: 'webapp-prod',
  image: 'nginx:1.21',
  replicas: 3,
});

// Get the generated ResourceGraphDefinition
console.log('Generated RGD:', factory.toYaml());
```

**Characteristics:**
- ✅ Declarative - Kro controller handles reconciliation
- ✅ Advanced dependency management and ordering
- ✅ CEL expressions evaluated at runtime
- ✅ GitOps friendly
- ✅ Automatic rollback on failures
- ❌ Requires Kro controller in cluster
- ❌ Slightly more complex setup

#### 4. Alchemy Integration

**Best for**: Complex resource lifecycle management, multi-environment deployments

```typescript
import { createScope } from 'alchemy';

const scope = createScope('webapp-scope');
const factory = await webappGraph.factory('kro', {
  namespace: 'staging',
  alchemyScope: scope,
});

// Deploy with Alchemy resource management
const instance = await factory.deploy({
  name: 'webapp-staging',
  image: 'nginx:1.21-staging',
  replicas: 2,
});

// Alchemy provides advanced lifecycle management
await scope.cleanup(); // Clean up all resources
```

**Characteristics:**
- ✅ Advanced resource lifecycle management
- ✅ Automatic cleanup and garbage collection
- ✅ Multi-environment resource tracking
- ✅ Integration with existing Alchemy workflows
- ❌ Requires Alchemy setup
- ❌ Additional complexity

### Reconciliation Control

TypeKro gives you fine-grained control over deployment reconciliation:

#### Synchronous Deployment (Wait for Ready)

```typescript
const factory = await webappGraph.factory('direct', {
  namespace: 'production',
  waitForReady: true,      // Wait for all resources to be ready
  timeout: 600000,         // 10 minute timeout
  rollbackOnFailure: true, // Rollback if deployment fails
});

try {
  const instance = await factory.deploy(spec);
  console.log('✅ Deployment successful and ready!');
  console.log('Status:', instance.status);
} catch (error) {
  console.error('❌ Deployment failed:', error.message);
  // Resources automatically rolled back
}
```

#### Asynchronous Deployment (Fire and Forget)

```typescript
const factory = await webappGraph.factory('direct', {
  namespace: 'development',
  waitForReady: false,     // Don't wait - deploy and return immediately
  timeout: 30000,          // Short timeout for initial deployment
});

const instance = await factory.deploy(spec);
console.log('🚀 Deployment initiated');

// Check status later
setTimeout(async () => {
  const status = await factory.getStatus();
  console.log('Current status:', status);
}, 30000);
```

#### Progress Monitoring

```typescript
const factory = await webappGraph.factory('direct', {
  namespace: 'production',
  waitForReady: true,
  progressCallback: (event) => {
    console.log(`📊 ${event.phase}: ${event.resource} - ${event.status}`);
    if (event.error) {
      console.error(`❌ Error: ${event.error.message}`);
    }
  },
});

// Get real-time deployment progress
const instance = await factory.deploy(spec);
```

### Environment-Specific Deployments

Deploy the same code to different environments with different configurations:

```typescript
// Development: Direct deployment with debugging
const devFactory = await webappGraph.factory('direct', {
  namespace: 'development',
  waitForReady: true,
  hydrateStatus: true,
});

const devInstance = await devFactory.deploy({
  name: 'webapp-dev',
  image: 'nginx:latest',
  replicas: 1,
});

// Staging: Kro deployment with staging config
const stagingFactory = await webappGraph.factory('kro', {
  namespace: 'staging',
});

const stagingInstance = await stagingFactory.deploy({
  name: 'webapp-staging',
  image: 'nginx:1.21-rc',
  replicas: 2,
});

// Production: GitOps deployment
const prodYaml = webappGraph.toYaml();
writeFileSync('k8s/production/webapp.yaml', prodYaml);
// Deployed via ArgoCD/Flux
```

### Deployment Strategy Decision Matrix

| Use Case | Strategy | Wait for Ready | Best For |
|----------|----------|----------------|----------|
| **Local Development** | Direct | ✅ Yes | Fast iteration, immediate feedback |
| **CI/CD Testing** | Direct | ✅ Yes | Automated testing, validation |
| **Staging Environment** | Kro | ❌ No | Production-like testing |
| **Production Deployment** | YAML + GitOps | N/A | Auditable, controlled releases |
| **Multi-Environment** | Alchemy | ✅ Yes | Complex lifecycle management |
| **Emergency Hotfix** | Direct | ✅ Yes | Immediate deployment needs |

This flexibility means you can use TypeKro throughout your entire development lifecycle - from local development to production deployment - with the same infrastructure code.

### GitOps Integration

TypeKro is designed for GitOps workflows with **deterministic YAML generation**:

```typescript
// generate-manifests.ts
import { writeFileSync } from 'fs';

const graph = toResourceGraph(/* ... */);

// Same input always generates identical YAML
const yaml = graph.toYaml();

// Write to file for GitOps
writeFileSync('k8s/my-app.yaml', yaml);
console.log('Generated k8s/my-app.yaml for GitOps deployment');
```

**Multi-Environment GitOps Workflow:**

```typescript
// scripts/generate-all-environments.ts
const environments = ['development', 'staging', 'production'];

for (const env of environments) {
  const yaml = webappGraph.toYaml();
  writeFileSync(`k8s/${env}/webapp.yaml`, yaml);
  
  // Environment-specific instance specs can be in separate files
  const instanceSpec = {
    name: `webapp-${env}`,
    image: env === 'production' ? 'nginx:1.21' : 'nginx:latest',
    replicas: env === 'production' ? 3 : 1,
  };
  
  writeFileSync(`k8s/${env}/webapp-instance.yaml`, `
apiVersion: example.com/v1alpha1
kind: WebApp
metadata:
  name: webapp-${env}
  namespace: ${env}
spec:
  name: ${instanceSpec.name}
  image: ${instanceSpec.image}
  replicas: ${instanceSpec.replicas}
`);
}
```

**Benefits for GitOps:**
- **Deterministic Output** - Same input always generates identical YAML
- **Git-Friendly** - Clean, readable YAML that diffs well  
- **Stable Resource IDs** - Consistent resource identifiers across deployments
- **Declarative** - Pure infrastructure-as-code with no imperative side effects
- **Environment Parity** - Same resource graph deployed across all environments

**Integration with ArgoCD:**
```yaml
# argocd-application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: webapp-production
spec:
  source:
    repoURL: https://github.com/my-org/my-app
    path: k8s/production/
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

**Integration with Flux:**
```yaml
# flux-kustomization.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1beta2
kind: Kustomization
metadata:
  name: webapp-production
spec:
  interval: 10m
  path: "./k8s/production"
  prune: true
  sourceRef:
    kind: GitRepository
    name: webapp-repo
```

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

Define your own CRDs with `arktype` for execution-time and runtime validation.

```typescript
import { customResource, Type } from 'typekro';

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
- **Cross-Resource References** with execution-time validation
- **IDE Autocomplete** for all properties and fields
- **Deterministic Resource IDs** for GitOps workflows

## Alchemy Integration

TypeKro integrates with [Alchemy](https://alchemy.js.org) to provide **resource lifecycle management** for your Kubernetes deployments. This integration allows you to manage TypeKro resources through Alchemy's state management system alongside your other infrastructure.

### Resource Lifecycle Management

```typescript
import alchemy from 'alchemy';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

// 1. Create your TypeKro resource graph
const webappGraph = toResourceGraph(
  {
    name: 'webapp-with-alchemy',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: type({ 
      name: 'string', 
      image: 'string',
      replicas: 'number',
      databaseUrl: 'string',
    }),
    status: type({ 
      ready: 'boolean', 
      url: 'string',
      readyReplicas: 'number',
    }),
  },
  (schema) => ({
    database: simpleDeployment({
      name: 'postgres',
      image: 'postgres:13',
      id: 'database',
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'webapp',
        POSTGRES_PASSWORD: 'secret',
      },
      ports: [{ name: 'postgres', containerPort: 5432 }],
    }),

    webapp: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      id: 'webapp',
      env: {
        DATABASE_URL: schema.spec.databaseUrl,
        // Cross-resource reference within TypeKro
        DATABASE_HOST: database.status.podIP,
      },
      ports: [{ name: 'http', containerPort: 80 }],
    }),

    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 80 }],
    }),
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.webapp.status.readyReplicas, ' > 0'),
    url: Cel.template('http://%s:80', resources.service.status.loadBalancer.ingress[0].ip),
    readyReplicas: resources.webapp.status.readyReplicas,
  })
);

// 2. Create Alchemy scope for resource management
const scope = await alchemy('my-app-infrastructure');

// 3. Deploy TypeKro resources through Alchemy
await scope.run(async () => {
  // Create factory with alchemy integration
  const factory = await webappGraph.factory('kro', { 
    namespace: 'production',
    alchemyScope: scope,
  });

  // Deploy through Alchemy's resource management
  const instance = await factory.deploy({
    name: 'my-webapp',
    image: 'my-app:v1.2.3',
    replicas: 3,
    databaseUrl: 'postgresql://postgres-service:5432/webapp',
  });

  // Alchemy manages the lifecycle of both the ResourceGraphDefinition
  // and the custom resource instances
  console.log('Deployment ready:', instance.status.ready);
  console.log('Service URL:', instance.status.url);
});
```

### How Alchemy Integration Works

1. **ResourceGraphDefinition Management**: Alchemy manages the RGD as a resource with proper lifecycle
2. **Instance Management**: Each deployment creates an Alchemy-managed custom resource instance
3. **State Tracking**: Alchemy tracks the state of both RGDs and instances
4. **Cleanup**: Alchemy handles proper cleanup when resources are no longer needed
5. **Dependencies**: Alchemy resolves dependencies between TypeKro resources and other infrastructure

### Combining Cloud Resources with TypeKro

While TypeKro focuses on Kubernetes resources, you can combine it with Alchemy-managed cloud resources:

```typescript
import alchemy from 'alchemy';
import { File } from 'alchemy/fs';

const scope = await alchemy('full-stack-app');

await scope.run(async () => {
  // 1. Create cloud resources with Alchemy
  const dbConfig = await File('database-config', {
    path: 'config/database.json',
    content: JSON.stringify({
      engine: 'postgres',
      endpoint: 'my-app-db.cluster-xyz.us-east-1.rds.amazonaws.com',
      port: 5432,
      database: 'webapp'
    })
  });

  // 2. Use cloud resource outputs in TypeKro
  const factory = await webappGraph.factory('direct', { 
    namespace: 'production',
    alchemyScope: scope,
  });

  const instance = await factory.deploy({
    name: 'webapp',
    image: 'my-app:latest',
    replicas: 3,
    // Reference the cloud resource configuration
    databaseUrl: `postgresql://${dbConfig.content.endpoint}:${dbConfig.content.port}/${dbConfig.content.database}`,
  });

  console.log('Full stack deployed:', instance.status.ready);
});
```

### Benefits of Alchemy Integration

- **Unified State Management**: All infrastructure resources managed in one place
- **Proper Lifecycle**: Resources are created, updated, and destroyed consistently
- **Dependency Resolution**: Automatic dependency management between resources
- **State Persistence**: Resource state is tracked and persisted across deployments
- **Rollback Capabilities**: Easy rollback of failed deployments
- **Resource Cleanup**: Automatic cleanup of unused resources

## Enhanced Type System

TypeKro provides **enhanced types** through its magic proxy system, eliminating the need for optional chaining (`?.`) when working with schema and resource references.

### Schema References - Always Present

When you access schema fields in the resource builder, TypeScript treats them as always present:

```typescript
const graph = toResourceGraph(
  {
    name: 'my-app',
    spec: type({
      name: 'string',
      image: 'string',
      replicas: 'number',
      environment: 'string',
    }),
    status: type({
      ready: 'boolean',
      url: 'string',
    }),
  },
  (schema) => ({
    deployment: simpleDeployment({
      // ✅ No optional chaining needed - TypeScript knows these exist
      name: schema.spec.name,           // Type: string (not string | undefined)
      image: schema.spec.image,         // Type: string (not string | undefined)
      replicas: schema.spec.replicas,   // Type: number (not number | undefined)
      
      env: {
        NODE_ENV: schema.spec.environment,  // Type: string
      },
    }),
  }),
  (schema, resources) => ({
    // ✅ Status fields are also enhanced - no optional chaining needed
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' > 0'),
    url: Cel.template('https://%s.example.com', schema.spec.name),
  })
);
```

### Resource Status References - Enhanced Types

Resource status fields are enhanced to be non-optional within the builders:

```typescript
// Without TypeKro (regular Kubernetes types)
const regularK8s = {
  // These would require optional chaining
  replicas: deployment.status?.readyReplicas,        // number | undefined
  conditions: deployment.status?.conditions?.[0],   // Condition | undefined
};

// With TypeKro (enhanced types)
const graph = toResourceGraph(
  // ... schema definition
  (schema, resources) => ({
    // ✅ No optional chaining needed - enhanced types guarantee presence
    replicas: resources.deployment.status.readyReplicas,     // Type: number
    phase: resources.deployment.status.phase,                // Type: string
    conditions: resources.deployment.status.conditions[0],   // Type: Condition
    
    // Complex expressions work naturally
    healthy: Cel.expr(
      resources.deployment.status.readyReplicas, ' == ',
      resources.deployment.spec.replicas
    ),
  })
);
```

### How Enhanced Types Work

The magic proxy system provides three levels of type enhancement:

1. **Schema Proxy**: `schema.spec.*` and `schema.status.*` are always non-optional
2. **Resource Proxy**: `resources.*.spec.*` and `resources.*.status.*` are enhanced
3. **Reference Resolution**: All proxied values become `KubernetesRef<T>` at runtime

```typescript
// At execution time - TypeScript sees these as regular types
const name: string = schema.spec.name;                    // string
const replicas: number = resources.webapp.status.readyReplicas;  // number

// At runtime - TypeKro creates references for CEL generation
const nameRef: KubernetesRef<string> = schema.spec.name;           // Reference
const replicasRef: KubernetesRef<number> = resources.webapp.status.readyReplicas; // Reference
```

### Benefits of Enhanced Types

- **No Optional Chaining**: Write cleaner code without `?.` operators
- **Better IntelliSense**: Full autocomplete for all schema and status fields
- **Execution-Time Safety**: Catch typos and missing fields when building resources
- **Runtime Flexibility**: References are resolved dynamically by Kro
- **Natural Syntax**: Write code that looks like direct property access

This enhanced type system makes TypeKro feel natural to use while maintaining the powerful reference resolution capabilities needed for complex Kubernetes deployments.

## Development

```bash
# Install dependencies
bun install

# Build the library
bun run build

# Run tests
bun run test

# Type checking
bun run typecheck

# Linting and formatting
bun run lint
bun run format

# Run all quality checks
bun run quality
