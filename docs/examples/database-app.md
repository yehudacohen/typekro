# Database + Application Pattern

A complete stack with PostgreSQL database and web application.

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service, ConfigMap } from 'typekro/simple';

const FullStackSpec = type({
  name: 'string',
  appImage: 'string',
  replicas: 'number',
  dbSize: 'string',
  environment: '"development" | "staging" | "production"'
});

const FullStackStatus = type({
  phase: '"pending" | "ready" | "failed"',
  databaseReady: 'boolean',
  appReady: 'boolean',
  url: 'string'
});

export const fullStack = kubernetesComposition(
  {
    name: 'fullstack-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStack',
    spec: FullStackSpec,
    status: FullStackStatus,
  },
  (schema) => ({
    // Database configuration
    dbConfig: ConfigMap({
      name: `${schema.spec.name}-db-config`,
      data: {
        POSTGRES_DB: schema.spec.name,
        POSTGRES_USER: 'app'
      }
    }),

    // Database deployment
    database: Deployment({
      name: `${schema.spec.name}-db`,
      image: 'postgres:15',
      env: {
        POSTGRES_DB: schema.spec.name,
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'password' // Use secrets in production
      },
      ports: [{ containerPort: 5432 }],
      resources: schema.spec.environment === 'production' 
        ? { cpu: '500m', memory: '1Gi' }
        : { cpu: '100m', memory: '256Mi' }
    }),

    // Database service
    dbService: Service({
      name: `${schema.spec.name}-db-service`,
      selector: { app: `${schema.spec.name}-db` },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),

    // Application deployment
    app: Deployment({
      name: schema.spec.name,
      image: schema.spec.appImage,
      replicas: schema.spec.replicas,
      env: {
        DATABASE_HOST: `${schema.spec.name}-db-service`,
        DATABASE_PORT: '5432',
        DATABASE_NAME: schema.spec.name,
        NODE_ENV: schema.spec.environment
      },
      ports: [{ containerPort: 3000 }]
    }),

    // Application service
    appService: Service({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'LoadBalancer'
    })
  }),
  // Status builder using JavaScript expressions
  (schema, resources) => ({
    phase: resources.database.status.readyReplicas > 0 && 
           resources.app.status.readyReplicas > 0 ? 'ready' : 'pending',
    databaseReady: resources.database.status.readyReplicas > 0,
    appReady: resources.app.status.readyReplicas >= schema.spec.replicas,
    url: resources.appService.status.loadBalancer.ingress?.length > 0 
      ? `http://${resources.appService.status.loadBalancer.ingress[0].ip}` 
      : 'pending'
  })
);
```

## Key Features

- **Database Integration**: PostgreSQL with proper configuration
- **Environment Variables**: Database connection details passed to app
- **Resource Scaling**: Different resource allocations per environment
- **Health Checking**: Status reflects both database and app readiness
- **Service Discovery**: App connects to database via service name

## Usage Patterns

### Development
```typescript
const factory = fullStack.factory('direct');
await factory.deploy({
  name: 'dev-app',
  appImage: 'myapp:latest',
  replicas: 1,
  dbSize: '1Gi',
  environment: 'development'
});
```

### Production
```typescript
const factory = fullStack.factory('kro');
await factory.deploy({
  name: 'prod-app', 
  appImage: 'myapp:v1.2.3',
  replicas: 5,
  dbSize: '100Gi',
  environment: 'production'
});
```