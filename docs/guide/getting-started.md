# Getting Started

Deploy type-safe Kubernetes infrastructure in 5 minutes. This streamlined guide gets you from zero to running application with minimal setup.

## Prerequisites

- **Node.js 18+** or **Bun** installed
- **kubectl** configured to access a Kubernetes cluster

::: tip Don't Have a Cluster?
Use [kind](https://kind.sigs.k8s.io/), [k3s](https://k3s.io/), or any cloud provider's managed Kubernetes service.
:::

## Installation

```bash
bun add typekro
# or npm install typekro
```

## 5-Minute Quick Start

### Step 1: Create Your App

Create `hello-world.ts`:

```typescript
import { type } from 'arktype';
import { kubernetesComposition, Cel } from 'typekro';
import { Deployment, Service, Ingress } from 'typekro/simple';

const AppSpec = type({
  name: 'string',
  image: 'string'
});

export const app = kubernetesComposition(
  {
    name: 'hello-world',
    apiVersion: 'example.com/v1alpha1',
    kind: 'HelloWorld',
    spec: AppSpec,
    status: type({ ready: 'boolean' })
  },
  (spec) => {
    const deployment = Deployment({
      name: spec.name,
      image: spec.image,
      ports: [{ containerPort: 80 }]
    });
    
    const service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    });

    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0')
    };
  }
);
```

### Step 2: Deploy It

Create `deploy.ts`:

```typescript
import { app } from './hello-world.js';

const factory = app.factory('direct', { namespace: 'default' });

await factory.deploy({
  name: 'hello-world',
  image: 'nginx:latest'
});

console.log('🚀 Deployed! Check with: kubectl get pods');
```

Run it:

```bash
bun run deploy.ts
```

### Step 3: Verify

```bash
kubectl get pods
# Should show: hello-world-xxx Running
```

**🎉 Success!** You've deployed your first type-safe Kubernetes app.

## What You Just Built

Your simple app demonstrates TypeKro's core concepts:

- **📋 Schema Definition**: Type-safe specification using `arktype`
- **🏗️ Resource Composition**: Automatic resource creation and registration  
- **🔗 Status Expressions**: Dynamic status using CEL expressions
- **🚀 Direct Deployment**: Immediate cluster deployment with TypeScript

## Advanced Features Preview

TypeKro offers much more power. Here's a taste of what's possible:

**Cross-Resource References**:
```typescript
const database = Deployment({ name: 'db', image: 'postgres:15' });
const app = Deployment({
  env: { DATABASE_HOST: database.status.clusterIP } // Magic!
});
```

**External References Between Compositions**:
```typescript
const webApp = otherComposition.database; // Cross-composition magic!
```

**Conditional Logic**:
```typescript
const ingress = spec.environment === 'production' 
  ? Ingress({ host: `${spec.name}.example.com` })
  : null;
```

## What's Next?

Ready to dive deeper? Follow the **Learning Path** for a structured progression:

### 🎯 **Recommended Next Steps**

1. **[📱 Build Your First App](./first-app.md)** - Complete tutorial with realistic patterns
2. **[🏭 Master Factory Functions](./factories.md)** - Learn TypeKro's building blocks
3. **[✨ Understand Magic Proxy](./magic-proxy.md)** - TypeKro's reference system  
4. **[🔗 External References](./external-references.md)** - Connect multiple compositions
5. **[🏗️ Advanced Architecture](./architecture.md)** - Deep technical understanding

### 🚀 **Choose Your Path**

**New to TypeKro?** → Start with [📱 First App](./first-app.md)  
**Experienced with Kubernetes?** → Jump to [✨ Magic Proxy](./magic-proxy.md)  
**Building complex systems?** → Explore [🔗 External References](./external-references.md)

### 📚 **More Resources**

- **[Examples](../examples/)** - Real-world patterns and complete applications
- **[API Reference](../api/)** - Complete function and type documentation  
- **[Deployment Guides](./deployment/)** - GitOps, KRO, and advanced strategies

## Quick Help

**Issues?** Check that kubectl can connect to your cluster:
```bash
kubectl cluster-info
```

**Need more help?** [Open an issue](https://github.com/yehudacohen/typekro/issues) or check our [Troubleshooting Guide](./troubleshooting.md).