# Your First TypeKro App

Welcome to TypeKro! This guide will walk you through creating your first application step by step. By the end, you'll understand the core concepts and be ready to dive deeper into TypeKro's unique capabilities.

## What We're Building

We'll create a simple web application with:
- A **Deployment** to run our app
- A **Service** to expose it
- **Type-safe configuration** using schemas
- **Dynamic status** that reflects the real cluster state

## Step 1: Create the App Schema

First, define what your application needs using TypeKro's schema system:

```typescript
// first-app.ts
import { type } from 'arktype';
import { kubernetesComposition, Cel } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

// Define your app's input parameters
const AppSpec = type({
  name: 'string',
  image: 'string', 
  replicas: 'number'
});

// Define what status information you want to track
const AppStatus = type({
  ready: 'boolean',
  url: 'string',
  readyReplicas: 'number'
});
```

::: tip Why Schemas?
Schemas provide:
- **Type safety** at compile time
- **Runtime validation** of inputs
- **Auto-generated APIs** for your infrastructure
- **Documentation** that's always up-to-date
:::

## Step 2: Create Your First Composition

Use the **imperative composition pattern** to define your infrastructure:

```typescript
export const firstApp = kubernetesComposition(
  {
    name: 'first-app',
    apiVersion: 'example.com/v1alpha1', 
    kind: 'FirstApp',
    spec: AppSpec,
    status: AppStatus,
  },
  (spec) => {
    // Create resources - they auto-register when created!
    const deployment = Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      ports: [{ containerPort: 80 }]
    });
    
    const service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    });

    // Return dynamic status based on actual cluster state
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      url: Cel.template('http://%s:80', service.status.clusterIP),
      readyReplicas: deployment.status.readyReplicas
    };
  }
);
```

::: tip What Just Happened?
This single function:
1. **Auto-registered** two Kubernetes resources
2. **Created cross-references** between them (service selector → deployment)
3. **Defined dynamic status** that updates with cluster state
4. **Provided full type safety** throughout
:::

## Step 3: Deploy Your App

Now deploy it directly to your cluster:

```typescript
// deploy.ts
import { firstApp } from './first-app.js';

async function deploy() {
  // Create a deployment factory
  const factory = firstApp.factory('direct', {
    namespace: 'default'
  });

  // Deploy with specific configuration
  const result = await factory.deploy({
    name: 'hello-world',
    image: 'nginx:latest', 
    replicas: 2
  });

  console.log('🚀 Deployed successfully!');
  console.log('Status:', result.status);
}

deploy().catch(console.error);
```

Run it:

```bash
bun run deploy.ts
```

## Step 4: Verify It Works

Check your deployment:

```bash
# See your pods
kubectl get pods -l app=hello-world

# See your service  
kubectl get services

# Check the actual status
kubectl get firstapp hello-world -o yaml
```

## Understanding What Happened

### Magic Happens Automatically

When you ran your composition, TypeKro:

1. **Generated Kubernetes YAML** from your TypeScript code
2. **Applied resources** to your cluster in the correct order
3. **Created cross-references** between resources automatically
4. **Monitored deployment** until resources were ready
5. **Hydrated status** with live cluster data

### Type Safety Throughout

Your entire infrastructure is type-safe:

```typescript
// ✅ This works - all fields are properly typed
await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3
});

// ❌ This fails at compile time
await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest', 
  replicas: 'three' // Type error: string not assignable to number
});
```

### Dynamic Status Updates

Your status isn't static - it reflects the real cluster:

```typescript
const status = await factory.getStatus();
console.log(status.ready);        // true when deployment is ready
console.log(status.readyReplicas); // actual number from cluster
console.log(status.url);          // real service IP
```

## What Makes This Special?

### Compared to Raw YAML
- **Type safety** prevents configuration errors
- **Cross-references** handled automatically  
- **Dynamic status** reflects real cluster state
- **Reusable** across environments

### Compared to Helm
- **No templating** - use real programming language
- **Type checking** catches errors at development time
- **Composable** - combine multiple apps easily
- **IDE support** with autocomplete and refactoring

### Compared to Pulumi/CDK8s
- **Magic proxy system** - seamless resource references
- **Schema-first design** - your API is automatically generated
- **External references** - coordinate across multiple compositions
- **Kubernetes-native** - generates standard Kubernetes resources

## What's Next?

Now that you've built your first app, continue your TypeKro journey:

### Next: [Factory Functions →](./factories.md)
Learn about TypeKro's built-in factories and how to use them effectively.

**Coming up in your learning path:**
- **Magic Proxy System** - How TypeKro's unique reference system works
- **External References** - Coordinate between multiple applications
- **Advanced Architecture** - Deep dive into TypeKro's design

## Quick Reference

### Essential Imports
```typescript
import { kubernetesComposition, simple, Cel } from 'typekro';
import { type } from 'arktype';
```

### Basic Composition Structure
```typescript
const myApp = kubernetesComposition(
  { name, apiVersion, kind, spec, status },
  (spec) => {
    // Create resources
    const resource = ResourceType({ /* config */ });
    
    // Return status
    return {
      field: Cel.expr<type>(resource.status.field, ' condition')
    };
  }
);
```

### Deployment Options
```typescript
// Direct deployment
const factory = myApp.factory('direct', { namespace: 'default' });
await factory.deploy({ /* spec values */ });

// Generate YAML
const yaml = myApp.toYaml({ /* spec values */ });
```

Ready to learn more? Head to [Factory Functions →](./factories.md) to continue your TypeKro journey!