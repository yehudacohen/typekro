# Database + Application Pattern

A complete stack with PostgreSQL database and web application.

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition, Cel simple, Cel } from 'typekro';
import { Deployment, Service } from 'typekro/simple'; import { Deployment, Service } from 'typekro/simple';

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

export const fullStack = kubernetesComposition({
  {
    name: 'fullstack-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStack',
    spec: FullStackSpec,
    status: FullStackStatus,
  },
  (schema) => ({
    // Database configuration
    dbConfig: simple({
      name: Cel.template('%s-db-config', schema.spec.name),
      data: {
        POSTGRES_DB: schema.spec.name,
        POSTGRES_USER: 'app'
      }
    }),

    // Database deployment
    database: Deployment({
      name: Cel.template('%s-db', schema.spec.name),
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
      name: Cel.template('%s-db-service', schema.spec.name),
      selector: { app: Cel.template('%s-db', schema.spec.name) },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),

    // Application deployment
    app: Deployment({
      name: schema.spec.name,
      image: schema.spec.appImage,
      replicas: schema.spec.replicas,
      env: {
        DATABASE_HOST: Cel.template('%s-db-service', schema.spec.name),
        DATABASE_PORT: '5432',
        DATABASE_NAME: schema.spec.name,
        NODE_ENV: schema.spec.environment
      },
      ports: [{ containerPort: 3000 }]
    }),

    // Application service
    appService: Service({
      name: Cel.template('%s-service', schema.spec.name),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'LoadBalancer'
    })
  }),
  (schema, resources) => ({
    phase: Cel.expr<'pending' | 'ready' | 'failed'>(`
      resources.database.status.readyReplicas > 0 && 
      resources.app.status.readyReplicas > 0 ? "ready" : "pending"
    `),
    databaseReady: Cel.expr<boolean>(resources.database.status.readyReplicas, ' > 0'),
    appReady: Cel.expr<boolean>(resources.app.status.readyReplicas, ' >= ', schema.spec.replicas),
    url: Cel.expr<string>(
      resources.appService.status.loadBalancer.ingress,
      '.size() > 0 ? "http://" + ',
      resources.appService.status.loadBalancer.ingress[0].ip,
      ': "pending"'
    )
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