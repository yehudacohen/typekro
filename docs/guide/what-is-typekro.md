# What is TypeKro?

TypeKro is a hypermodern infrastructure-as-code library that brings the type safety of TypeScript, the declarative nature of Kubernetes YAML, and the runtime intelligence of continuous reconciliation into a single, cohesive workflow.

## The Problem TypeKro Solves

If you've worked with Kubernetes infrastructure before, you've probably encountered these common trade-offs:

### Traditional Approaches and Their Limitations

**Raw YAML Manifests:**
- ✅ Declarative and GitOps-friendly
- ❌ Error-prone and hard to refactor
- ❌ No compile-time validation
- ❌ Brittle cross-resource dependencies

**Imperative IaC Tools (Terraform, Pulumi):**
- ✅ Type-safe and programmable
- ❌ Stateful and complex
- ❌ Awkward GitOps integration
- ❌ External state backends required

**Kubernetes Templating (Helm, Kustomize):**
- ✅ Reusable and configurable
- ❌ Limited programming capabilities
- ❌ Complex dependency management
- ❌ No type safety

## The TypeKro Solution

TypeKro eliminates these trade-offs by combining the best aspects of each approach:

```typescript
// Type-safe infrastructure definition
const webApp = toResourceGraph('webapp', (schema) => ({
  database: simpleDeployment({
    name: `${schema.spec.name}-db`,
    image: 'postgres:15'
  }),
  
  app: simpleDeployment({
    name: schema.spec.name,
    image: schema.spec.image,
    env: {
      // Runtime cross-resource reference
      DATABASE_URL: `postgresql://${database.status.podIP}:5432/webapp`
    }
  })
}), {
  apiVersion: 'example.com/v1alpha1',
  kind: 'WebApp',
  spec: WebAppSpec,
  status: WebAppStatus
});

// Choose your deployment strategy
const directFactory = await webApp.factory('direct');  // Direct deployment
const yaml = webApp.toYaml();                          // GitOps YAML
const kroFactory = await webApp.factory('kro');       // Kro integration
```

## Core Principles

### 1. Type Safety First

Every resource, field, and reference is fully typed. Catch configuration errors at compile time, not runtime:

```typescript
// This will cause a TypeScript error
const deployment = simpleDeployment({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: '3'  // ❌ Error: string not assignable to number
});
```

### 2. Runtime Intelligence

Cross-resource references are resolved at runtime, enabling truly dynamic infrastructure:

```typescript
const app = simpleDeployment({
  name: 'web-app',
  env: {
    // This resolves to the actual pod IP at runtime
    DATABASE_HOST: database.status.podIP,
    // CEL expressions for complex logic
    READY: Cel.expr(database.status.readyReplicas, '> 0 ? "true" : "false"')
  }
});
```

### 3. GitOps Compatible

Generate deterministic YAML that works perfectly with any GitOps workflow:

```yaml
# Generated YAML is clean and GitOps-ready
apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: webapp
spec:
  resources:
    - id: database
      template:
        apiVersion: apps/v1
        kind: Deployment
        # ... standard Kubernetes YAML
```

### 4. Kubernetes Native

Built on standard Kubernetes primitives. No custom controllers or external dependencies required for basic functionality.

## Architecture Overview

TypeKro consists of several key components:

### Factory Functions
Pre-built, type-safe functions for creating common Kubernetes resources:

```typescript
import { simpleDeployment, simpleService, simplePvc } from 'typekro';
```

### Resource Graphs
Composable infrastructure definitions that can reference each other:

```typescript
const graph = toResourceGraph('my-stack', (schema) => ({
  // Resources can reference each other
  database: simpleDeployment({ /* ... */ }),
  app: simpleDeployment({
    env: { DB_HOST: database.status.podIP }
  })
}));
```

### Deployment Strategies
Multiple ways to deploy your infrastructure:

- **Direct**: Deploy resources directly to Kubernetes
- **YAML**: Generate GitOps-ready YAML files
- **Kro**: Use Kro controller for advanced reconciliation
- **Alchemy**: Integrate with multi-cloud scenarios

### CEL Expressions
Common Expression Language for dynamic field evaluation:

```typescript
status: {
  ready: Cel.expr(deployment.status.readyReplicas, '== ', deployment.spec.replicas),
  url: Cel.template('https://%s/api', service.status.loadBalancer.ingress[0].hostname)
}
```

## When to Use TypeKro

TypeKro is ideal for:

- **Complex Kubernetes applications** with multiple interconnected services
- **GitOps workflows** that need type-safe infrastructure generation
- **Development teams** that want infrastructure-as-code with full IDE support
- **Multi-environment deployments** with varying configurations
- **Organizations** transitioning from manual YAML to programmatic infrastructure

TypeKro might not be the best fit for:

- **Simple, static applications** with no cross-resource dependencies
- **Teams** heavily invested in existing Terraform/Pulumi workflows
- **Environments** where TypeScript/Node.js tooling is not available

## Next Steps

Ready to get started? Check out our [Getting Started Guide](./getting-started.md) to install TypeKro and build your first resource graph.

Or explore our [Examples](../examples/) to see TypeKro in action with real-world scenarios.