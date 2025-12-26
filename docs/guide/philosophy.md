# Philosophy

## Core Philosophy

TypeKro bridges type-safe development and runtime-aware infrastructure. Write infrastructure like application code—with full IDE support, compile-time validation, and runtime intelligence.

**The key insight:** Kubernetes resources reference each other's live state. TypeKro expresses these relationships in TypeScript, converting them to CEL expressions that evaluate at runtime.

## Three-Layer Architecture

```
TypeScript (Compile-time)     →  CEL (Runtime)           →  Kubernetes (Cluster)
─────────────────────────────────────────────────────────────────────────────────
Type safety & IDE support        Expression evaluation       Resource management
Schema validation                Cross-resource refs         Status updates
Reference tracking               Conditional logic           Reconciliation
```

## Why TypeKro?

**Simple deployments:** Type-safe APIs with IDE autocomplete catch errors before deployment. Direct mode deploys immediately.

**Complex systems:** Cross-resource references, runtime status aggregation, and reusable composition patterns.

**Any workflow:** Generate deterministic YAML for GitOps, or deploy directly. Same TypeScript code, multiple strategies.

## Design Principles

1. **TypeScript-native** - No DSLs, no YAML templating
2. **Stateless** - No state backend, standard Kubernetes resources
3. **GitOps-ready** - Deterministic YAML output
4. **Progressive complexity** - Start simple, add sophistication as needed

## Terminology

| Term | Meaning |
|------|---------|
| **Composition** | The result of `kubernetesComposition()` - a reusable template that defines resources and status |
| **Composition Function** | The callback passed to `kubernetesComposition()` that creates resources |
| **Schema Proxy** | The proxy for the `spec` parameter that creates `KubernetesRef` objects when you access `spec.name` |
| **Magic Proxy** | The proxy wrapping resources that creates `KubernetesRef` objects when you access `deploy.status.ready` |
| **Resource Factory** | Functions like `Deployment()`, `Service()` that create Kubernetes resources |
| **Deployment Factory** | The `composition.factory('direct'|'kro')` that deploys compositions to a cluster |
| **`id`** | Resource identifier for CEL path generation (not the Kubernetes `name`) |
| **`name`** | The Kubernetes resource name in `metadata.name` |
| **Direct Mode** | TypeKro deploys resources directly to the cluster, no Kro controller needed |
| **Kro Mode** | TypeKro generates ResourceGraphDefinitions for the Kro controller to manage |
| **CEL** | Common Expression Language - used by Kro for runtime expression evaluation |

## When is Kro Required?

::: tip Quick Decision
- **Use Direct mode** for development, testing, and simple deployments
- **Use Kro mode** when you need runtime CEL evaluation or continuous reconciliation

See [Deployment Modes](/guide/deployment-modes) for the complete comparison.
:::

## Next Steps

- [Getting Started](./getting-started.md) - Deploy your first app
- [Magic Proxy](./magic-proxy.md) - Understand how references work
