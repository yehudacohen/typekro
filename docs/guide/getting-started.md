# Getting Started

Deploy type-safe Kubernetes infrastructure in 5 minutes.

## Prerequisites

- **Node.js 18+** or **Bun** installed
- **kubectl** configured to access a Kubernetes cluster

::: tip Don't Have a Cluster?
Use [kind](https://kind.sigs.k8s.io/), [k3s](https://k3s.io/), or any cloud provider's managed Kubernetes service.
:::

## Installation

```bash
bun add typekro arktype
# or: npm install typekro arktype
```

## 5-Minute Quick Start

### Step 1: Create Your App

Create `hello-world.ts`:

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

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
      id: 'deploy',  // Enables status references (see Resource IDs guide)
      name: spec.name,
      image: spec.image,
      ports: [{ containerPort: 80 }]
    });
    
    Service({
      id: 'svc',
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    });

    // ✨ Natural JavaScript - automatically converted to CEL
    return { ready: deployment.status.readyReplicas > 0 };
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
- **🆔 Resource IDs**: The `id` field enables cross-resource references ([learn more](/advanced/resource-ids))
- **🚀 Direct Deployment**: Immediate cluster deployment with TypeScript

::: tip Write Natural JavaScript!
TypeKro automatically converts JavaScript expressions to CEL. No special syntax needed:

```typescript
// ✅ Just write normal JavaScript - TypeKro handles the rest
return {
  ready: deployment.status.readyReplicas > 0,
  url: `https://${service.status.clusterIP}`,
  phase: deployment.status.readyReplicas > 0 ? 'running' : 'pending'
};
```

See [JavaScript to CEL](/guide/javascript-to-cel) for all supported patterns.
:::

::: info When is `id` Required?
The `id` field is required when you need to **reference a resource** in status expressions or from other resources.

| Scenario | `id` Required? |
|----------|----------------|
| Reference in status: `deploy.status.readyReplicas` | ✅ Yes |
| Cross-resource reference: `service.status.clusterIP` | ✅ Yes |
| Standalone resource with no references | ❌ Optional |

**`id` vs `name`:**
- **`id`**: TypeKro's internal identifier for CEL paths (e.g., `${deploy.status.readyReplicas}`)
- **`name`**: The Kubernetes resource name in `metadata.name` (what you see in `kubectl`)

Example: `Deployment({ id: 'webApp', name: 'web-app', ... })` creates a Deployment named `web-app` that you reference as `webApp` in expressions.

See [Resource IDs](/advanced/resource-ids) for complete documentation.
:::

::: tip When is Kro Required?
The example above uses **Direct mode** which deploys resources immediately without any additional controllers. 

**You don't need Kro for:**
- Development and testing
- Simple deployments
- Static configurations

**You need Kro for:**
- Runtime CEL evaluation (status updates as cluster state changes)
- Continuous reconciliation
- Self-healing infrastructure

See [Deployment Modes](/guide/deployment-modes) for details.
:::

## Advanced Features Preview

TypeKro offers much more power. Here's a taste of what's possible:

**Cross-Resource References**:
```typescript
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

// Inside a composition function:
const database = Deployment({ id: 'db', name: 'db', image: 'postgres:15' });
const dbService = Service({
  id: 'dbSvc',
  name: 'db-svc',
  selector: { app: 'db' },
  ports: [{ port: 5432 }]
});
const app = Deployment({
  id: 'app',
  name: 'app',
  image: 'myapp:latest',
  env: { 
    // ✨ JavaScript template literals work seamlessly
    DATABASE_URL: `postgres://user:pass@${dbService.status.clusterIP}:5432/mydb`
  }
});
```

**External References Between Compositions**:
```typescript
import { externalRef } from 'typekro';
import { Deployment } from 'typekro/simple';

// Reference a resource deployed by another composition
const dbRef = externalRef<DbSpec, DbStatus>(
  'db.example.com/v1',
  'Database',
  'shared-db',
  'databases'  // namespace
);

const app = Deployment({
  id: 'app',
  name: 'app',
  image: 'myapp:latest',
  env: { DATABASE_HOST: dbRef.status.host }
});
```

**Conditional Logic**:
```typescript
import { kubernetesComposition } from 'typekro';
import { Ingress } from 'typekro/simple';

// Inside a composition function:
const ingress = spec.environment === 'production' 
  ? Ingress({ 
      id: 'ingress', 
      name: `${spec.name}-ingress`, 
      host: `${spec.name}.example.com`,
      serviceName: spec.name,
      servicePort: 80
    })
  : null;

// Status with JavaScript expressions
return {
  ready: deployment.status.readyReplicas > 0,
  url: ingress ? `https://${spec.name}.example.com` : 'http://localhost'
};
```

## What's Next?

Ready to dive deeper? Here's the recommended progression:

1. [Magic Proxy System](./magic-proxy.md) - Understand TypeKro's reference system  
2. [JavaScript to CEL](./javascript-to-cel.md) - How expressions are converted
3. [External References](./external-references.md) - Connect multiple compositions
4. [Deployment Modes](./deployment-modes.md) - Direct, Kro, and GitOps strategies

## Quick Help

**Issues?** Check that kubectl can connect to your cluster:
```bash
kubectl cluster-info
```

**Need more help?** [Open an issue](https://github.com/yehudacohen/typekro/issues) or check our [Troubleshooting Guide](./troubleshooting.md).
