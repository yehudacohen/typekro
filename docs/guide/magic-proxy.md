# Magic Proxy System

The magic proxy system makes resource references feel natural while generating CEL expressions under the hood.

## How It Works

TypeKro intercepts property access on resources to generate CEL expressions:

```typescript
const app = Deployment({ name: spec.name, image: spec.image });
return {
  ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
  endpoint: service.status.clusterIP
};
```

**The magic:** TypeKro understands your intent and generates the correct CEL expressions automatically, while maintaining full type safety.

## What is the Magic Proxy?

When you create resources in TypeKro, you get back **Enhanced** resources that look and feel like normal objects, but have magical properties:

```typescript
import { kubernetesComposition, Cel } from 'typekro';
import { Deployment, Service, Ingress, ConfigMap } from 'typekro/simple';

const composition = kubernetesComposition(definition, (spec) => {
  const deployment = Deployment({
    name: spec.name,
    image: spec.image
  });
  
  // This looks like a normal property access...
  const ready = deployment.status.readyReplicas;
  
  // But it's actually creating a CEL expression!
  // deployment.status.readyReplicas becomes: 
  // '${resources.deployment.status.readyReplicas}'
});
```

The magic proxy system automatically converts your natural TypeScript code into CEL expressions that run in the Kubernetes cluster.

## How It Works: The Schema Proxy Architecture

TypeKro's magic proxy system operates on two levels:

### **1. Schema Proxy System**
The foundation that makes `spec` references work:

```typescript
const composition = kubernetesComposition(
  {
    spec: type({ name: 'string', replicas: 'number' }),
    // ... other definition
  },
  (spec) => {
    // 'spec' is a schema proxy object
    // When you access spec.name, the proxy captures this as `${self.spec.name}`
    const app = Deployment({
      name: spec.name,        // Schema proxy captures: `${self.spec.name}`
      replicas: spec.replicas // Schema proxy captures: `${self.spec.replicas}`
    });
  }
);
```

**Under the hood:** TypeKro creates a proxy object that:
1. **Intercepts** all property access on `spec`
2. **Records** the property path (`name`, `replicas`, etc.)
3. **Generates** CEL template references (`${self.spec.name}`)
4. **Maintains** full TypeScript type safety

### **2. Enhanced Resource System**  
The magic that makes resource references work:

```typescript
const app = Deployment({ name: 'web-app' });

// 'app' is an Enhanced<DeploymentSpec, DeploymentStatus> object
// When you access app.status.readyReplicas, the proxy captures this as ${resources.app.status.readyReplicas}
const ready = app.status.readyReplicas;  // Resource proxy captures reference
```

**Under the hood:** TypeKro wraps each resource in an Enhanced proxy that:
1. **Knows** the resource's position in the resource graph
2. **Captures** property access chains (`status.readyReplicas`)  
3. **Generates** CEL resource references (`${resources.app.status.readyReplicas}`)
4. **Preserves** the original Kubernetes resource types

### Schema References

When you access properties on `spec`, the proxy creates schema references:

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const app = Deployment({
    name: spec.name,        // Becomes: ${self.spec.name}
    replicas: spec.replicas // Becomes: ${self.spec.replicas}
  });
  
  return {
    appName: spec.name      // Becomes: ${self.spec.name}
  };
});
```

At deployment time:
1. Your app schema defines `{ name: 'string', replicas: 'number' }`
2. User provides `{ name: 'my-app', replicas: 3 }`
3. CEL evaluates `${self.spec.name}` → `'my-app'`
4. CEL evaluates `${self.spec.replicas}` → `3`

### Resource References

When you access properties on resources, the proxy creates resource references:

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const deployment = Deployment({
    name: 'web-app',
    image: 'nginx:latest'
  });
  
  const service = Service({
    name: 'web-service',
    selector: { app: 'web-app' },
    ports: [{ port: 80 }]
  });
  
  return {
    // These create resource references:
    ready: deployment.status.readyReplicas,    // {{resources.deployment.status.readyReplicas}}
    endpoint: service.status.clusterIP,        // {{resources.service.status.clusterIP}}
    replicas: deployment.spec.replicas         // {{resources.deployment.spec.replicas}}
  };
});
```

At runtime in the cluster:
1. Kubernetes updates the actual Deployment status
2. CEL evaluates `${resources.deployment.status.readyReplicas}` against live data
3. Your status updates automatically with real cluster state

## The Magic in Action

### Static vs Dynamic Values

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const app = Deployment({
    name: 'web-app',           // Static value
    replicas: spec.replicas    // Dynamic - comes from schema
  });
  
  return {
    // Mix of static and dynamic status
    appName: 'web-app',                               // Static string
    configuredReplicas: spec.replicas,                // Dynamic from spec
    actualReplicas: app.status.readyReplicas,         // Dynamic from cluster
    isReady: app.status.readyReplicas > 0             // ❌ Won't work - see below
  };
});
```

::: warning JavaScript Logic Doesn't Transfer
The proxy can capture property access, but not JavaScript logic. For conditions, use CEL expressions:

```typescript
// ❌ This won't work (JavaScript condition)
isReady: app.status.readyReplicas > 0

// ✅ Use CEL expression instead
isReady: Cel.expr<boolean>(app.status.readyReplicas, ' > 0')
```
:::

### Progressive Complexity: The TypeKro Advantage

TypeKro's magic proxy enables progressive complexity - start simple, add sophistication as needed. This progression showcases why TypeKro is unique:

**🎯 This progression is TypeKro's killer feature** - no other tool offers this seamless escalation from static values to dynamic cluster-aware references.

```typescript
// Level 1: Simple static values
const basic = kubernetesComposition(definition, (spec) => {
  const app = Deployment({
    name: 'my-app',
    image: 'nginx:latest'
  });
  
  return {
    ready: true  // Static
  };
});

// Level 2: Schema references
const withSchema = kubernetesComposition(definition, (spec) => {
  const app = Deployment({
    name: spec.name,     // Schema reference
    image: spec.image    // Schema reference
  });
  
  return {
    appName: spec.name   // Schema reference in status
  };
});

// Level 3: Resource references
const withResources = kubernetesComposition(definition, (spec) => {
  const app = Deployment({
    name: spec.name,
    image: spec.image
  });
  
  return {
    ready: app.status.readyReplicas,      // Resource reference
    endpoint: service.status.clusterIP   // Cross-resource reference
  };
});

// Level 4: CEL expressions
const withLogic = kubernetesComposition(definition, (spec) => {
  const app = Deployment({
    name: spec.name,
    image: spec.image
  });
  
  return {
    // Complex logic with CEL
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    health: Cel.expr<string>(
      app.status.readyReplicas, 
      ' == ', 
      app.spec.replicas, 
      ' ? "healthy" : "degraded"'
    )
  };
});
```

## Cross-Resource Magic

The proxy makes cross-resource references seamless:

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  // Database tier
  const postgres = Deployment({
    name: 'postgres',
    image: 'postgres:15'
  });
  
  const dbService = Service({
    name: 'postgres-service',
    selector: { app: 'postgres' },
    ports: [{ port: 5432 }]
  });
  
  // Application tier - references database
  const app = Deployment({
    name: spec.name,
    image: spec.image,
    env: {
      // Magic proxy makes this natural
      DATABASE_HOST: dbService.status.clusterIP,
      DATABASE_PORT: '5432'
    }
  });
  
  const appService = Service({
    name: 'app-service',
    selector: { app: spec.name },
    ports: [{ port: 80, targetPort: 3000 }]
  });
  
  return {
    // Status aggregates across resources
    databaseReady: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0'),
    appReady: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    
    // Combined status with CEL logic
    ready: Cel.expr<boolean>(
      postgres.status.readyReplicas, ' > 0 && ',
      app.status.readyReplicas, ' > 0'
    ),
    
    // Service endpoints
    databaseEndpoint: Cel.template('%s:5432', dbService.status.clusterIP),
    appEndpoint: Cel.template('http://%s:80', appService.status.clusterIP)
  };
});
```

## Templates and Expressions

The magic proxy works with CEL templates and expressions:

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const service = Service({
    name: spec.name,
    selector: { app: spec.name },
    ports: [{ port: 80 }]
  });
  
  return {
    // CEL template with schema reference
    serviceName: Cel.template('%s-service', spec.name),
    
    // CEL template with resource reference  
    endpoint: Cel.template('http://%s:80', service.status.clusterIP),
    
    // CEL expression with condition
    ready: Cel.expr<boolean>(service.status.clusterIP, ' != ""'),
    
    // Complex CEL with multiple references
    healthUrl: Cel.template(
      'http://%s:80/health?name=%s', 
      service.status.clusterIP, 
      spec.name
    )
  };
});
```

## Type Safety Magic

The proxy system maintains full type safety:

```typescript
const app = Deployment({
  name: 'web-app',
  image: 'nginx:latest'
});

// ✅ These work - proper types
app.metadata.name;              // string
app.spec.replicas;              // number  
app.status.readyReplicas;       // number
app.status.conditions;          // DeploymentCondition[]

// ❌ These fail at compile time
app.spec.invalidField;          // Property doesn't exist
app.status.readyReplicas + 'x'; // Can't add string to number
```

The TypeScript compiler knows the exact shape of every Kubernetes resource and prevents errors at development time.

## TypeKro vs Alternatives: The Proxy Advantage

Here's how TypeKro's magic proxy compares to other infrastructure tools:

### **Resource References**

```typescript
// 🔥 TypeKro: Natural and type-safe
const db = Deployment({ name: 'postgres', image: 'postgres:15' });
const app = Deployment({
  env: { DATABASE_HOST: db.status.clusterIP }  // Direct reference!
});
```

```typescript
// 😰 Pulumi: Explicit async handling
const db = new k8s.apps.v1.Deployment(...);
const app = new k8s.apps.v1.Deployment({
  spec: {
    template: {
      spec: {
        containers: [{
          env: [{
            name: "DATABASE_HOST",
            value: db.status.apply(status => status.clusterIP)  // Async complexity
          }]
        }]
      }
    }
  }
});
```

```typescript
// 😰 CDK8s: Manual reference management
const db = new kplus.Deployment(this, 'postgres', {...});
const app = new kplus.Deployment(this, 'app', {
  containers: [{
    envVariables: {
      'DATABASE_HOST': kplus.EnvValue.fromValue(
        k8s.KubeService.fromResourceName('postgres-service').clusterIp
      )  // Complex binding
    }
  }]
});
```

### **Status Aggregation**

```typescript
// 🔥 TypeKro: Intuitive with CEL
return {
  ready: Cel.expr<boolean>(
    db.status.readyReplicas, ' > 0 && ',
    app.status.readyReplicas, ' > 0'
  )  // Natural logical expression
};
```

```typescript  
// 😰 Pulumi: Complex async composition
export const ready = pulumi.all([db.status, app.status])
  .apply(([dbStatus, appStatus]) => 
    (dbStatus.readyReplicas || 0) > 0 && 
    (appStatus.readyReplicas || 0) > 0
  );
```

**🎯 Key Advantage:** TypeKro's magic proxy eliminates async complexity while maintaining runtime awareness.

## Behind the Scenes

When you write this:

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const app = Deployment({
    name: spec.name,
    replicas: spec.replicas
  });
  
  return {
    ready: app.status.readyReplicas > 0  // ❌ Won't work as intended
  };
});
```

The magic proxy:
1. **Captures** `spec.name` and `spec.replicas` as schema references
2. **Converts** them to `${self.spec.name}` and `${self.spec.replicas}`
3. **Captures** `app.status.readyReplicas` as resource reference
4. **Converts** it to `${resources.app.status.readyReplicas}`
5. **Cannot capture** the `> 0` JavaScript logic (requires explicit CEL)

The correct version:

```typescript
return {
  ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0')  // ✅ Works
};
```

## Advanced Proxy Patterns

### Conditional Resource Creation

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const app = Deployment({
    name: spec.name,
    image: spec.image
  });
  
  // Only create ingress in production
  const ingress = spec.environment === 'production' 
    ? Ingress({
        name: `${spec.name}-ingress`,
        host: Cel.template('%s.example.com', spec.name),  // Schema reference in template
        serviceName: `${spec.name}-service`
      })
    : null;
  
  return {
    hasIngress: spec.environment === 'production',
    ingressHost: ingress 
      ? Cel.template('%s.example.com', spec.name)
      : Cel.expr<string>`'no-ingress'`
  };
});
```

### Proxy Chaining

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const configMap = ConfigMap({
    name: 'app-config',
    data: {
      'database.host': spec.databaseHost,     // Schema reference
      'app.name': spec.name                   // Schema reference
    }
  });
  
  const app = Deployment({
    name: spec.name,
    image: spec.image,
    envFrom: [{
      configMapRef: {
        name: configMap.metadata.name         // Resource reference to ConfigMap
      }
    }]
  });
  
  return {
    configName: configMap.metadata.name,      // Proxy chain: config → metadata → name
    ready: app.status.readyReplicas          // Proxy chain: app → status → readyReplicas
  };
});
```

## Debugging Proxy Magic

When things don't work as expected, remember:

### Check Your CEL

Use `toYaml()` to see the generated CEL expressions:

```typescript
const yaml = composition.toYaml({ name: 'test', image: 'nginx' });
console.log(yaml);  // See the actual CEL expressions generated
```

### Understand the Limitations

```typescript
// ✅ Works - simple property access
deployment.status.readyReplicas

// ✅ Works - nested property access  
deployment.metadata.labels.app

// ❌ Won't work - JavaScript method calls
deployment.spec.containers.length

// ❌ Won't work - JavaScript operators
deployment.status.readyReplicas > 0

// ❌ Won't work - JavaScript logic
deployment.status.readyReplicas || 0
```

For complex logic, use explicit CEL expressions.

## What's Next?

Now that you understand the magic proxy system, let's see how it enables powerful cross-composition coordination:

### Next: [External References →](./external-references.md)
Learn how to coordinate between multiple compositions using external references.

**In this learning path:**
- ✅ Your First App - Built your first TypeKro application
- ✅ Factory Functions - Mastered resource creation
- ✅ Magic Proxy System - Understood TypeKro's reference magic
- 🎯 **Next**: External References - Cross-composition coordination
- **Finally**: Advanced Architecture - Deep technical understanding

## Quick Reference

### What the Proxy Captures
```typescript
// ✅ Schema references
spec.name                    // {{self.spec.name}}
spec.replicas               // {{self.spec.replicas}}

// ✅ Resource references  
deployment.status.ready     // {{resources.deployment.status.ready}}
service.metadata.name       // {{resources.service.metadata.name}}

// ✅ Nested property access
deployment.metadata.labels.app  // {{resources.deployment.metadata.labels.app}}
```

### What Requires Explicit CEL
```typescript
// ❌ JavaScript logic
deployment.status.readyReplicas > 0

// ✅ Use CEL expression
Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0')

// ❌ JavaScript methods
deployment.spec.containers.length

// ✅ Use CEL expression  
Cel.expr<number>(deployment.spec.containers, '.size()')
```

### Common Patterns
```typescript
// Schema references in configuration
name: spec.name
replicas: spec.replicas

// Resource references in status
ready: deployment.status.readyReplicas
endpoint: service.status.clusterIP

// CEL logic for conditions
healthy: Cel.expr<boolean>(deployment.status.readyReplicas, ' == ', deployment.spec.replicas)
```

Ready for cross-composition magic? Continue to [External References →](./external-references.md)