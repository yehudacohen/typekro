# What is TypeKro?

TypeKro is a **hypermodern Infrastructure-as-Code** tool that brings the type safety of TypeScript, the GitOps-friendly output of declarative YAML, and the runtime intelligence of **Kubernetes Resource Orchestrator (KRO)** to Kubernetes infrastructure management.

## Core Philosophy

**Write infrastructure in pure TypeScript with full IDE support, then deploy directly to clusters or generate deterministic YAML for GitOps workflows.**

TypeKro eliminates the traditional trade-offs between type safety, deployment flexibility, and runtime intelligence by providing:

- **Compile-time type safety** with full TypeScript validation
- **Deployment flexibility** - same code works with Direct, YAML, or KRO deployment strategies  
- **Runtime intelligence** through CEL expressions and cross-resource references
- **GitOps compatibility** with deterministic YAML generation

## What is KRO?

[Kubernetes Resource Orchestrator (KRO)](https://kro.run/) is an open-source project by AWS Labs that enables resources to reference each other's runtime state using CEL expressions. KRO provides:

- **Runtime dependency resolution** between Kubernetes resources
- **CEL expression evaluation** for dynamic resource configuration
- **Automatic reconciliation** and drift correction
- **Status propagation** and health monitoring

TypeKro works in **Direct Mode** (no KRO required) for simple deployments, or **KRO Mode** for advanced orchestration scenarios.

## Key Benefits

### 📝 **TypeScript-First Development**

Write infrastructure using familiar TypeScript syntax with full IDE support:

```typescript
import { type } from 'arktype';
import { kubernetesComposition, Cel } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const WebAppSpec = type({
  name: 'string',
  image: 'string', 
  replicas: 'number'
});

const webapp = kubernetesComposition({
  name: 'my-webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: WebAppSpec
}, (schema) => {
  // Write imperative TypeScript - no builders required
  const app = Deployment({
    name: schema.spec.name,    // Type-safe schema reference
    image: schema.spec.image,  // Full IDE autocomplete
    replicas: schema.spec.replicas
  });
  
  const service = Service({
    name: schema.spec.name,
    selector: { app: schema.spec.name },
    ports: [{ port: 80, targetPort: 80 }]
  });
  
  // Status automatically derived from resources
  return { app, service };
});
```

### 🚀 **Deployment Flexibility**

The same TypeScript code can be deployed in multiple ways without modification:

```typescript
const spec = { name: 'my-app', image: 'nginx:1.21', replicas: 3 };

// 1. Generate YAML for GitOps (no cluster interaction)
const kroFactory = webapp.factory('kro', { namespace: 'dev' });
const yaml = kroFactory.toYaml();
writeFileSync('k8s/webapp.yaml', yaml);

// 2. Deploy directly to cluster (immediate)
const directFactory = webapp.factory('direct', { namespace: 'dev' });
await directFactory.deploy(spec);

// 3. Integrate with Alchemy for multi-cloud
await alchemyScope.run(async () => {
  const factory = webapp.factory('direct', { 
    namespace: 'dev',
    alchemyScope: alchemyScope 
  });
  await factory.deploy(spec);
});
```

### 🔗 **Runtime Intelligence**

TypeKro's magic proxy system enables compile-time type safety with runtime flexibility:

```typescript
// Schema references become CEL expressions at runtime
const deployment = Deployment({
  name: schema.spec.name,        // Type-safe reference
  image: schema.spec.image,      // Full autocomplete
  env: {
    SERVICE_URL: Cel.template('http://%s:8080', schema.spec.name)
  }
});

// Cross-resource references work naturally
const ingress = Ingress({
  name: schema.spec.name,
  host: schema.spec.hostname,
  serviceName: service.metadata.name,  // References other resource
  servicePort: 80
});
```

### 🎯 **GitOps Ready**

Generate deterministic, Git-friendly YAML output:

```typescript
// Deterministic YAML generation
const factory = webapp.factory('kro', { namespace: 'production' });
const yaml = factory.toYaml();

// Same input always generates identical YAML
// Perfect for GitOps workflows with ArgoCD, Flux, etc.
writeFileSync('k8s/production/webapp.yaml', yaml);
```

## How TypeKro Works

### Magic Proxy System

TypeKro's core innovation is its **magic proxy system** that creates different behaviors for static values vs. dynamic references:

```typescript
// Static values (known at execution time)
const deployment = Deployment({
  name: 'my-app',      // Static string
  replicas: 3          // Static number
});

// Dynamic references (resolved at runtime)
const deployment = Deployment({
  name: schema.spec.name,    // Schema reference → CEL expression
  replicas: schema.spec.replicas
});

// Cross-resource references (runtime resolution)
const deployment = Deployment({
  env: {
    DB_HOST: database.service.spec.clusterIP  // Runtime cluster state
  }
});
```

### Enhanced Types (RefOrValue Pattern)

Every factory function accepts `RefOrValue<T>`, which means any parameter can be:

1. **Direct value**: `name: "my-app"`
2. **Schema reference**: `name: schema.spec.name`
3. **CEL expression**: `name: Cel.template("%s-service", schema.spec.name)`
4. **Resource reference**: `env: { DB_HOST: database.service.spec.clusterIP }`

This provides **compile-time type safety** while enabling **runtime flexibility**.

## TypeKro vs. Alternatives

| Feature | TypeKro | Pulumi | CDK8s | Helm | Kustomize |
|---------|---------|---------|--------|------|-----------|
| **Type Safety** | ✅ Full TypeScript | ✅ Multi-language | ✅ TypeScript | ❌ Templates | ❌ YAML |
| **GitOps Ready** | ✅ Deterministic YAML | ❌ State backend | ✅ YAML output | ✅ Charts | ✅ YAML |
| **Runtime Dependencies** | ✅ KRO + CEL expressions | ❌ Deploy-time only | ❌ Static | ❌ Templates | ❌ Static |
| **IDE Support** | ✅ Full autocomplete | ✅ Language support | ✅ TypeScript | ❌ Limited | ❌ Limited |
| **Learning Curve** | 🟢 Just TypeScript | 🔴 New concepts | 🟡 TypeScript + K8s | 🔴 Templates | 🔴 YAML complexity |
| **Kubernetes Native** | ✅ Pure K8s resources | ❌ Abstraction layer | ✅ Pure K8s | ✅ K8s resources | ✅ K8s resources |
| **Cross-Resource Refs** | ✅ Runtime resolution | ❌ Deploy-time | ❌ Manual | ❌ Manual | ❌ Manual |
| **Multi-Cloud** | ✅ Via Alchemy | ✅ Native | ❌ K8s only | ❌ K8s only | ❌ K8s only |
| **State Management** | ✅ Stateless | ❌ State backend | ✅ Stateless | ✅ Stateless | ✅ Stateless |

## Why Choose TypeKro?

### 🚀 **TypeKro Excels At:**

- **Type-safe infrastructure** - Full TypeScript support with IDE autocomplete and compile-time validation
- **GitOps workflows** - Generate deterministic YAML that works seamlessly with ArgoCD, Flux, and other GitOps tools
- **Complex applications** - Handle runtime dependencies between resources with CEL expressions and cross-resource references
- **Multi-environment deployments** - Environment-specific configurations with type safety across dev, staging, and production
- **Team collaboration** - External references enable type-safe coordination between different teams and services
- **Rapid development** - Write infrastructure in familiar TypeScript with instant feedback and refactoring capabilities
- **Production reliability** - Stateless, Kubernetes-native approach with no vendor lock-in or state backends to manage

### ⚡ **Key Advantages:**

- **No YAML debugging** - Say goodbye to indentation errors and template complexity
- **Runtime intelligence** - Your infrastructure code understands actual cluster state
- **Multi-cloud ready** - Seamless integration with Alchemy for unified cloud + Kubernetes management
- **Zero vendor lock-in** - Generate standard Kubernetes YAML, deploy anywhere

## Next Steps

Ready to get started with TypeKro?

1. **[Quick Start](./getting-started.md)** - Get TypeKro running in 5 minutes
2. **[Getting Started](./getting-started.md)** - Comprehensive setup guide
3. **[Core Concepts](./resource-graphs.md)** - Understand resource graphs and references
4. **[Deployment Strategies](./deployment/)** - Choose the right deployment approach

## Community and Support

- **GitHub**: [typekro](https://github.com/yehudacohen/typekro) - Source code, issues, and contributions
- **NPM**: [@typekro](https://www.npmjs.com/package/typekro) - Package downloads and versions
- **Examples**: [examples/](https://github.com/yehudacohen/typekro/tree/main/examples) - Real-world usage patterns

TypeKro is open-source and released under the Apache 2.0 license. We welcome contributions, feedback, and community involvement!