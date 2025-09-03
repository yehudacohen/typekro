# Imperative Composition Pattern

The **Imperative Composition Pattern** is the recommended approach for creating TypeKro resource graphs. It provides a natural, JavaScript-first API that automatically handles resource registration and status building.

## Overview

The `kubernetesComposition` function allows you to write intuitive, imperative code while automatically generating the same robust, type-safe ResourceGraphDefinitions as the traditional `toResourceGraph` API.

### Key Benefits

- **Natural JavaScript**: Write code the way you think about resources
- **Automatic Registration**: Factory functions auto-register when called within composition context
- **Type Safety**: Full TypeScript support with enhanced type inference
- **CEL Integration**: Seamless integration with CEL expressions for dynamic status
- **Composition of Compositions**: Easily combine multiple compositions together

## Basic Usage

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service, Pvc } from 'typekro/simple';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string',
});

const webApp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  (spec) => {
    // Resources auto-register - no explicit builders needed!
    const deployment = Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
    });

    const service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
    });

    // ✨ Return status with natural JavaScript expressions
    return {
      ready: deployment.status.readyReplicas > 0,
      url: `http://${service.status.loadBalancer.ingress[0].ip}`,
    };
  }
);

// Use directly - no .toResourceGraph() needed
const factory = webApp.factory('kro');
const yaml = webApp.toYaml();
```

## Comparison with Declarative toResourceGraph

TypeKro offers two approaches for creating resource graphs:

### Imperative Composition (Primary)

```typescript
const webapp = kubernetesComposition(
  definition,
  (spec) => {
    const deployment = Deployment({ name: spec.name });
    const service = Service({ name: spec.name });
    
    return {
      // ✨ Natural JavaScript expressions
      ready: deployment.status.readyReplicas > 0,
      url: `http://${service.status.loadBalancer.ingress[0].ip}`,
    };
  }
);
```

### Declarative Alternative (toResourceGraph)

```typescript
const webapp = toResourceGraph(
  definition,
  (schema) => ({
    deployment: Deployment({ name: schema.spec.name }),
    service: Service({ name: schema.spec.name }),
  }),
  (schema, resources) => ({
    // ✨ Natural JavaScript expressions work here too
    ready: resources.deployment.status.readyReplicas > 0,
    url: `http://${resources.service.status.loadBalancer.ingress[0].ip}`,
  })
);
```

### Key Differences

1. **Single vs Separate Functions**: Imperative uses one function, declarative uses separate resource and status builders
2. **Direct vs Proxy Access**: Imperative accesses `spec` directly, declarative uses `schema.spec`
3. **Auto vs Manual Registration**: Imperative auto-registers resources, declarative requires explicit resource objects
4. **Natural vs Explicit Flow**: Imperative follows natural thinking, declarative is more explicit about structure

Both approaches generate identical output and support the same features. Choose based on your preference for code style.

## Advanced Patterns

### Complex Status Objects

```typescript
const complexApp = kubernetesComposition(definition, (spec) => {
  const database = Deployment({ name: 'db', image: 'postgres' });
  const api = Deployment({ name: 'api', image: spec.apiImage });
  const frontend = Deployment({ name: 'frontend', image: spec.frontendImage });

  return {
    // ✨ Complex JavaScript expressions work seamlessly
    phase: database.status.readyReplicas > 0 && 
           api.status.readyReplicas > 0 && 
           frontend.status.readyReplicas > 0 ? "Ready" : "Pending",
    services: {
      database: {
        ready: database.status.readyReplicas > 0,
        replicas: database.status.readyReplicas,
      },
      api: {
        ready: api.status.readyReplicas === spec.apiReplicas,
        replicas: api.status.readyReplicas,
      },
      frontend: {
        ready: frontend.status.readyReplicas === spec.frontendReplicas,
        replicas: frontend.status.readyReplicas,
      },
    },
    totalReplicas: database.status.readyReplicas + 
                   api.status.readyReplicas + 
                   frontend.status.readyReplicas,
  };
});
```

### Composition of Compositions

```typescript
// Individual compositions
const database = kubernetesComposition(dbDefinition, (spec) => {
  const postgres = Deployment({ name: 'postgres', image: spec.image });
  return { ready: postgres.status.readyReplicas > 0 };
});

const api = kubernetesComposition(apiDefinition, (spec) => {
  const deployment = Deployment({ name: 'api', image: spec.image });
  return { ready: deployment.status.readyReplicas > 0 };
});

// Composed composition
const fullStack = kubernetesComposition(fullStackDefinition, (spec) => {
  // Use compositions directly - resources are automatically merged
  const db = database;
  const apiService = api;
  
  return {
    // ✨ JavaScript expressions work across compositions
    ready: db.status.ready && apiService.status.ready,
    components: {
      database: db.status.ready,
      api: apiService.status.ready,
    },
  };
});
```

### Configuration-Driven Resources

```typescript
const configApp = kubernetesComposition(definition, (spec) => {
  // Create configuration first
  const config = ConfigMap({
    name: `${spec.name}-config`,
    data: {
      'database.url': spec.databaseUrl,
      'api.key': spec.apiKey,
    },
  });

  // Use configuration in deployment
  const deployment = Deployment({
    name: spec.name,
    image: spec.image,
    env: {
      CONFIG_PATH: '/etc/config',
    },
    volumes: [{ name: 'config', configMap: { name: config.metadata.name } }],
    volumeMounts: [{ name: 'config', mountPath: '/etc/config' }],
  });

  return {
    // ✨ JavaScript expressions with fallbacks
    ready: deployment.status.readyReplicas > 0,
    configVersion: config.metadata.resourceVersion || 'unknown',
  };
});
```

## Status Building Guidelines

### Use JavaScript Expressions for Dynamic Logic

```typescript
// ✅ Recommended - Natural JavaScript expressions (automatically converted to CEL)
return {
  ready: deployment.status.readyReplicas > 0,
  phase: deployment.status.readyReplicas > 0 ? "Ready" : "Pending",
  url: `https://${spec.hostname}/api`,
};

// ✅ Also works - Explicit CEL expressions for complex cases
return {
  ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
  phase: Cel.expr<string>(
    deployment.status.readyReplicas, ' > 0 ? "Ready" : "Pending"'
  ),
  url: Cel.template('https://%s/api', spec.hostname),
};
```

### Mix Literal Values and JavaScript Expressions

```typescript
return {
  // Literal values work fine
  version: '1.0.0',
  environment: spec.environment,
  
  // ✨ JavaScript expressions for dynamic values (automatically converted to CEL)
  ready: deployment.status.readyReplicas > 0,
  endpoint: `https://${service.status.loadBalancer.ingress[0].ip}`,
  
  // Resource references work directly
  replicas: deployment.status.readyReplicas,
};
```

## Deployment Strategies

### Kro Deployment (Recommended)

```typescript
const factory = composition.factory('kro');

// Deploy ResourceGraphDefinition to cluster
const rgd = await factory.deploy();

// Create instances
const instance = await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
});
```

### Direct Deployment

```typescript
const factory = composition.factory('direct');

// Deploy individual resources
const result = await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
});
```

## Debugging and Troubleshooting

### Enable Debug Mode

```typescript
import { enableCompositionDebugging, getCompositionDebugLogs } from 'typekro';

enableCompositionDebugging();

const composition = kubernetesComposition(definition, compositionFn);

// Check debug logs
const logs = getCompositionDebugLogs();
console.log('Composition logs:', logs);
```

### Common Issues

#### Resources Not Registering

**Problem**: Resources created outside composition context don't register.

```typescript
// ❌ Wrong - resource created outside composition
const globalDeployment = Deployment({ name: 'global' });

const composition = kubernetesComposition(definition, (spec) => {
  // This won't be registered
  return { ready: Cel.expr<boolean>(globalDeployment.status.readyReplicas, ' > 0') };
});
```

**Solution**: Create resources inside the composition function.

```typescript
// ✅ Correct - resource created inside composition
const composition = kubernetesComposition(definition, (spec) => {
  const deployment = Deployment({ name: spec.name });
  return { ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0') };
});
```

#### Status Object Type Errors

**Problem**: Status object doesn't match schema type.

**Solution**: Ensure return type matches your status schema exactly.

```typescript
const StatusSchema = type({
  ready: 'boolean',
  count: 'number',
});

const composition = kubernetesComposition(
  { /* ... */, status: StatusSchema },
  (spec) => {
    const deployment = Deployment({ name: spec.name });
    
    // ✅ Matches schema exactly
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      count: deployment.status.readyReplicas,
    };
  }
);
```

## Best Practices

### 1. Keep Compositions Focused

Create focused compositions that handle a single concern:

```typescript
// ✅ Good - focused on web application
const webApp = kubernetesComposition(webAppDefinition, (spec) => {
  const deployment = Deployment({ /* ... */ });
  const service = Service({ /* ... */ });
  return { /* web app status */ };
});

// ✅ Good - focused on database
const database = kubernetesComposition(databaseDefinition, (spec) => {
  const deployment = Deployment({ /* ... */ });
  const pvc = Pvc({ /* ... */ });
  return { /* database status */ };
});
```

### 2. Use Descriptive Resource Names

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  // ✅ Good - descriptive names
  const webDeployment = Deployment({ name: `${spec.name}-web` });
  const webService = Service({ name: `${spec.name}-web-service` });
  const dbDeployment = Deployment({ name: `${spec.name}-database` });
  
  return { /* ... */ };
});
```

### 3. Organize Complex Status Objects

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const web = Deployment({ /* ... */ });
  const db = Deployment({ /* ... */ });
  
  return {
    // ✨ High-level status with JavaScript expressions
    ready: web.status.readyReplicas > 0 && db.status.readyReplicas > 0,
    phase: web.status.readyReplicas > 0 && db.status.readyReplicas > 0 ? 'Ready' : 'Pending',
    
    // Detailed component status
    components: {
      web: {
        ready: web.status.readyReplicas > 0,
        replicas: web.status.readyReplicas,
      },
      database: {
        ready: db.status.readyReplicas > 0,
        replicas: db.status.readyReplicas,
      },
    },
    
    // Computed metrics
    metrics: {
      totalReplicas: web.status.readyReplicas + db.status.readyReplicas,
    },
  };
});
```

### 4. Handle Dependencies Explicitly

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  // Create dependencies first
  const database = Deployment({ name: 'database', image: 'postgres' });
  const databaseService = Service({ name: 'database-service', selector: { app: 'database' } });
  
  // Then create dependents
  const api = Deployment({
    name: 'api',
    image: spec.apiImage,
    env: {
      // ✨ JavaScript template literals work seamlessly
      DATABASE_URL: `postgres://user:pass@${databaseService.metadata.name}:5432/app`,
    },
  });
  
  return { /* ... */ };
});
```

## Performance Considerations

- **Context Overhead**: Minimal performance impact from AsyncLocalStorage
- **Resource Registration**: O(1) HashMap operations for resource storage
- **Status Processing**: Processed once during composition execution
- **Memory Usage**: Lightweight context objects with automatic cleanup

## Next Steps

- Explore the [examples](../../examples/imperative-composition.ts) for more patterns
- Learn about [CEL expressions](./cel-expressions.md) for dynamic status
- Understand [deployment strategies](./deployment/index.md) for different environments
- Check out [factory functions](./factories.md) for available resource types