# Advanced Composition Patterns

This guide demonstrates advanced patterns using TypeKro's imperative composition system, including composition nesting, reusable components, and complex status aggregation.

## Reusable Database Component

Create a reusable database composition that can be used across multiple applications:

```typescript
import { type } from 'arktype';
import { kubernetesComposition, simpleDeployment, simpleService, simplePvc, simpleIngress, Cel } from 'typekro';

const DatabaseSpec = type({
  name: 'string',
  image: 'string',
  storageSize: 'string',
  password: 'string'
});

const DatabaseStatus = type({
  ready: 'boolean',
  host: 'string',
  port: 'number',
  storageReady: 'boolean'
});

export const database = kubernetesComposition(
  {
    name: 'database',
    apiVersion: 'example.com/v1alpha1',
    kind: 'Database',
    spec: DatabaseSpec,
    status: DatabaseStatus,
  },
  (spec) => {
    // Persistent storage for the database
    const storage = simplePvc({
      name: Cel.template('%s-storage', spec.name),
      size: spec.storageSize,
      accessModes: ['ReadWriteOnce']
    });

    // Database deployment
    const postgres = simpleDeployment({
      name: spec.name,
      image: spec.image,
      env: {
        POSTGRES_DB: spec.name,
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: spec.password
      },
      ports: [{ containerPort: 5432 }],
      volumeMounts: [{
        name: 'data',
        mountPath: '/var/lib/postgresql/data'
      }],
      volumes: [{
        name: 'data',
        persistentVolumeClaim: { claimName: storage.metadata.name }
      }]
    });

    // Service to expose the database
    const service = simpleService({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 5432, targetPort: 5432 }]
    });

    return {
      ready: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0'),
      host: service.status.clusterIP,
      port: 5432,
      storageReady: Cel.expr<boolean>(storage.status.phase, ' == "Bound"')
    };
  }
);
```

## API Service Component

Create a reusable API service composition:

```typescript
const ApiServiceSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  databaseHost: 'string',
  environment: '"development" | "staging" | "production"'
});

const ApiServiceStatus = type({
  ready: 'boolean',
  replicas: 'number',
  endpoint: 'string'
});

export const apiService = kubernetesComposition(
  {
    name: 'api-service',
    apiVersion: 'example.com/v1alpha1',
    kind: 'ApiService',
    spec: ApiServiceSpec,
    status: ApiServiceStatus,
  },
  (spec) => {
    const deployment = simpleDeployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      env: {
        DATABASE_HOST: spec.databaseHost,
        NODE_ENV: spec.environment,
        PORT: '8080'
      },
      ports: [{ containerPort: 8080 }],
      resources: spec.environment === 'production' 
        ? { cpu: '500m', memory: '1Gi' }
        : { cpu: '100m', memory: '256Mi' }
    });

    const service = simpleService({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 8080 }]
    });

    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' == ', spec.replicas),
      replicas: deployment.status.readyReplicas,
      endpoint: service.status.clusterIP
    };
  }
);
```

## Full-Stack Application Composition

Combine the database and API service into a complete application:

```typescript
const FullStackSpec = type({
  appName: 'string',
  apiImage: 'string',
  dbImage: 'string',
  environment: '"development" | "staging" | "production"',
  replicas: 'number'
});

const FullStackStatus = type({
  ready: 'boolean',
  phase: '"initializing" | "database-ready" | "api-ready" | "ready" | "failed"',
  components: {
    database: {
      ready: 'boolean',
      host: 'string'
    },
    api: {
      ready: 'boolean',
      replicas: 'number',
      endpoint: 'string'
    }
  },
  url: 'string'
});

export const fullStackApp = kubernetesComposition(
  {
    name: 'fullstack-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStackApp',
    spec: FullStackSpec,
    status: FullStackStatus,
  },
  (spec) => {
    // Use the database composition
    const db = database.withSpec({
      name: Cel.template('%s-db', spec.appName),
      image: spec.dbImage,
      storageSize: spec.environment === 'production' ? '100Gi' : '10Gi',
      password: 'secure-password'
    });

    // Use the API service composition, referencing the database
    const api = apiService.withSpec({
      name: Cel.template('%s-api', spec.appName),
      image: spec.apiImage,
      replicas: spec.replicas,
      databaseHost: db.status.host,
      environment: spec.environment
    });

    // Create ingress for external access (production only)
    const ingress = spec.environment === 'production'
      ? simpleIngress({
          name: Cel.template('%s-ingress', spec.appName),
          rules: [{
            host: Cel.template('%s.example.com', spec.appName),
            http: {
              paths: [{
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: Cel.template('%s-api-service', spec.appName),
                    port: { number: 80 }
                  }
                }
              }]
            }
          }]
        })
      : null;

    return {
      ready: Cel.expr<boolean>(db.status.ready, ' && ', api.status.ready),
      phase: Cel.expr<'initializing' | 'database-ready' | 'api-ready' | 'ready' | 'failed'>(
        '!', db.status.ready, ' ? "initializing" : ',
        '!', api.status.ready, ' ? "database-ready" : "ready"'
      ),
      components: {
        database: {
          ready: db.status.ready,
          host: db.status.host
        },
        api: {
          ready: api.status.ready,
          replicas: api.status.replicas,
          endpoint: api.status.endpoint
        }
      },
      url: spec.environment === 'production' 
        ? Cel.template('https://%s.example.com', spec.appName)
        : Cel.template('http://%s', api.status.endpoint)
    };
  }
);
```

## Microservices Platform

Build a complete microservices platform by composing multiple services:

```typescript
const MicroservicesPlatformSpec = type({
  name: 'string',
  environment: '"development" | "staging" | "production"',
  services: {
    frontend: {
      image: 'string',
      replicas: 'number'
    },
    userService: {
      image: 'string',
      replicas: 'number'
    },
    orderService: {
      image: 'string',
      replicas: 'number'
    }
  }
});

const MicroservicesPlatformStatus = type({
  ready: 'boolean',
  servicesReady: 'number',
  totalServices: 'number',
  services: {
    frontend: { ready: 'boolean', replicas: 'number' },
    userService: { ready: 'boolean', replicas: 'number' },
    orderService: { ready: 'boolean', replicas: 'number' },
    database: { ready: 'boolean' }
  },
  endpoints: {
    frontend: 'string',
    api: 'string'
  }
});

export const microservicesPlatform = kubernetesComposition(
  {
    name: 'microservices-platform',
    apiVersion: 'example.com/v1alpha1',
    kind: 'MicroservicesPlatform',
    spec: MicroservicesPlatformSpec,
    status: MicroservicesPlatformStatus,
  },
  (spec) => {
    // Shared database for all services
    const sharedDb = database.withSpec({
      name: Cel.template('%s-db', spec.name),
      image: 'postgres:15',
      storageSize: spec.environment === 'production' ? '200Gi' : '20Gi',
      password: 'platform-password'
    });

    // User service
    const userSvc = apiService.withSpec({
      name: Cel.template('%s-user-service', spec.name),
      image: spec.services.userService.image,
      replicas: spec.services.userService.replicas,
      databaseHost: sharedDb.status.host,
      environment: spec.environment
    });

    // Order service
    const orderSvc = apiService.withSpec({
      name: Cel.template('%s-order-service', spec.name),
      image: spec.services.orderService.image,
      replicas: spec.services.orderService.replicas,
      databaseHost: sharedDb.status.host,
      environment: spec.environment
    });

    // Frontend service
    const frontend = simpleDeployment({
      name: Cel.template('%s-frontend', spec.name),
      image: spec.services.frontend.image,
      replicas: spec.services.frontend.replicas,
      env: {
        USER_SERVICE_URL: Cel.template('http://%s', userSvc.status.endpoint),
        ORDER_SERVICE_URL: Cel.template('http://%s', orderSvc.status.endpoint),
        NODE_ENV: spec.environment
      },
      ports: [{ containerPort: 3000 }]
    });

    const frontendService = simpleService({
      name: Cel.template('%s-frontend-service', spec.name),
      selector: { app: Cel.template('%s-frontend', spec.name) },
      ports: [{ port: 80, targetPort: 3000 }],
      type: spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
    });

    // API Gateway (simple nginx proxy)
    const apiGateway = simpleDeployment({
      name: Cel.template('%s-api-gateway', spec.name),
      image: 'nginx:alpine',
      ports: [{ containerPort: 80 }]
    });

    const apiGatewayService = simpleService({
      name: Cel.template('%s-api-gateway-service', spec.name),
      selector: { app: Cel.template('%s-api-gateway', spec.name) },
      ports: [{ port: 80, targetPort: 80 }]
    });

    return {
      ready: Cel.expr<boolean>(
        sharedDb.status.ready, ' && ',
        userSvc.status.ready, ' && ',
        orderSvc.status.ready, ' && ',
        frontend.status.readyReplicas, ' > 0'
      ),
      servicesReady: Cel.expr<number>(
        '(', sharedDb.status.ready, ' ? 1 : 0) + ',
        '(', userSvc.status.ready, ' ? 1 : 0) + ',
        '(', orderSvc.status.ready, ' ? 1 : 0) + ',
        '(', frontend.status.readyReplicas, ' > 0 ? 1 : 0)'
      ),
      totalServices: 4,
      services: {
        frontend: {
          ready: Cel.expr<boolean>(frontend.status.readyReplicas, ' > 0'),
          replicas: frontend.status.readyReplicas
        },
        userService: {
          ready: userSvc.status.ready,
          replicas: userSvc.status.replicas
        },
        orderService: {
          ready: orderSvc.status.ready,
          replicas: orderSvc.status.replicas
        },
        database: {
          ready: sharedDb.status.ready
        }
      },
      endpoints: {
        frontend: frontendService.status.clusterIP,
        api: apiGatewayService.status.clusterIP
      }
    };
  }
);
```

## Usage Examples

### Deploy Development Environment

```typescript
const devFactory = await fullStackApp.factory('direct', { namespace: 'development' });

await devFactory.deploy({
  appName: 'myapp-dev',
  apiImage: 'myapp/api:latest',
  dbImage: 'postgres:15',
  environment: 'development',
  replicas: 1
});
```

### Deploy Production Microservices

```typescript
const prodFactory = await microservicesPlatform.factory('kro', { namespace: 'production' });

await prodFactory.deploy({
  name: 'ecommerce-platform',
  environment: 'production',
  services: {
    frontend: {
      image: 'ecommerce/frontend:v2.1.0',
      replicas: 3
    },
    userService: {
      image: 'ecommerce/user-service:v1.5.0',
      replicas: 2
    },
    orderService: {
      image: 'ecommerce/order-service:v1.3.0',
      replicas: 2
    }
  }
});
```

### Generate YAML for GitOps

```typescript
import { writeFileSync } from 'fs';

// Generate ResourceGraphDefinition
const rgdYaml = microservicesPlatform.toYaml();
writeFileSync('k8s/microservices-platform-rgd.yaml', rgdYaml);

// Generate production instance
const prodInstanceYaml = microservicesPlatform.toYaml({
  name: 'prod-platform',
  environment: 'production',
  services: {
    frontend: { image: 'myapp/frontend:v1.0.0', replicas: 5 },
    userService: { image: 'myapp/user-service:v1.0.0', replicas: 3 },
    orderService: { image: 'myapp/order-service:v1.0.0', replicas: 3 }
  }
});
writeFileSync('k8s/prod-platform-instance.yaml', prodInstanceYaml);
```

## Key Benefits of Composition Patterns

1. **Reusability**: Components can be used across multiple applications
2. **Maintainability**: Changes to a component automatically propagate
3. **Type Safety**: Full TypeScript support across composition boundaries
4. **Resource Merging**: Resources from nested compositions are automatically combined
5. **Status Aggregation**: Complex status objects with cross-component references
6. **Deployment Flexibility**: Same compositions work with direct, KRO, and GitOps deployments

## Best Practices

1. **Keep Compositions Focused**: Each composition should handle a single concern
2. **Use Descriptive Names**: Make component purposes clear
3. **Design for Reuse**: Consider how components might be used in different contexts
4. **Document Dependencies**: Make cross-component relationships explicit
5. **Test Compositions**: Validate that nested compositions work correctly
6. **Version Components**: Use semantic versioning for reusable compositions

## Next Steps

- **[Imperative Composition Guide](../guide/imperative-composition.md)** - Deep dive into composition patterns
- **[CEL Expressions](../guide/cel-expressions.md)** - Advanced status logic
- **[Deployment Strategies](../guide/deployment/)** - Different ways to deploy compositions
- **[Testing Guide](../guide/testing.md)** - How to test complex compositions