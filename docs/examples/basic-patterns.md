# Basic Patterns

This guide demonstrates fundamental TypeKro patterns through practical examples. We'll cover simple web applications, database integration, and essential concepts like resource graphs, factory functions, cross-resource references, and deployment strategies.

## Simple Web Application

Let's start with the basics: a simple web application with type-safe configuration and environment-specific settings.

### What You'll Build

- A web application deployment running nginx
- A service to expose the application  
- Type-safe configuration with environment variants

### Complete Example

```typescript
import { type } from 'arktype';
import { toResourceGraph, Cel, simple } from 'typekro';

// Define the application interface
const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"'
});

const WebAppStatus = type({
  url: 'string',
  phase: '"pending" | "running" | "failed"',
  readyReplicas: 'number'
});

// Create the resource graph
export const simpleWebApp = toResourceGraph(
  {
    name: 'simple-webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  // ResourceBuilder function - defines the Kubernetes resources
  (schema) => ({
    // Web application deployment
    deployment: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 80 }],
      
      // Environment-specific resource limits
      resources: schema.spec.environment === 'production' 
        ? { cpu: '500m', memory: '1Gi' }
        : { cpu: '100m', memory: '256Mi' }
    }),

    // Service to expose the application
    service: simple.Service({
      name: Cel.expr(schema.spec.name, '-service'),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 80 }],
      
      // LoadBalancer in production, ClusterIP elsewhere
      type: schema.spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
    })
  }),
  // StatusBuilder function - defines how status fields map to resource status
  (schema, resources) => ({
    url: schema.spec.environment === 'production'
      ? Cel.expr(
          resources.service.status.loadBalancer.ingress,
          '.size() > 0 ? "http://" + ',
          resources.service.status.loadBalancer.ingress[0].ip,
          ': "pending"'
        )
      : Cel.template('http://%s', resources.service.spec.clusterIP),
    phase: Cel.expr(
      resources.deployment.status.readyReplicas,
      '== ',
      resources.deployment.spec.replicas,
      '? "running" : "pending"'
    ),
    readyReplicas: resources.deployment.status.readyReplicas
  })
);
```

### Deployment Options

#### Option 1: Direct Deployment

Perfect for development and testing:

```typescript
// deploy-direct.ts
import { simpleWebApp } from './simple-webapp.js';

async function deployDirect() {
  const factory = simpleWebApp.factory('direct', {
    namespace: 'development'
  });

  const instance = await factory.deploy({
    name: 'my-webapp',
    image: 'nginx:latest',
    replicas: 2,
    environment: 'development'
  });

  console.log('✅ Deployed successfully!');
  
  // Check deployment status
  const status = await factory.getStatus(instance);
  console.log('📊 Status:', status);
}

deployDirect().catch(console.error);
```

#### Option 2: Generate YAML

For GitOps workflows:

```typescript
// generate-yaml.ts
import { writeFileSync } from 'fs';
import { simpleWebApp } from './simple-webapp.js';

// Generate ResourceGraphDefinition for KRO
const rgdYaml = simpleWebApp.toYaml();
writeFileSync('webapp-definition.yaml', rgdYaml);

// Generate production instance
const prodInstanceYaml = simpleWebApp.toYaml({
  metadata: { name: 'production-webapp', namespace: 'production' },
  spec: {
    name: 'production-webapp',
    image: 'nginx:1.24',
    replicas: 5,
    environment: 'production'
  }
});
writeFileSync('webapp-production.yaml', prodInstanceYaml);

// Generate development instance
const devInstanceYaml = simpleWebApp.toYaml({
  metadata: { name: 'dev-webapp', namespace: 'development' },
  spec: {
    name: 'dev-webapp',
    image: 'nginx:latest',
    replicas: 1,
    environment: 'development'
  }
});
writeFileSync('webapp-development.yaml', devInstanceYaml);

console.log('📄 YAML files generated!');
```

Deploy with kubectl:

```bash
kubectl apply -f webapp-definition.yaml
kubectl apply -f webapp-production.yaml
```

### Key Concepts Demonstrated

#### 1. Type-Safe Configuration

The `WebAppSpec` type ensures your configuration is valid:

```typescript
// ✅ This works
const instance = await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  environment: 'production'
});

// ❌ This causes a TypeScript error
const invalidInstance = await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: '3',  // Error: string not assignable to number
  environment: 'prod'  // Error: not a valid environment
});
```

#### 2. Environment-Specific Configuration

Resources adapt based on the environment:

```typescript
// Production gets more resources
resources: schema.spec.environment === 'production' 
  ? { cpu: '500m', memory: '1Gi' }
  : { cpu: '100m', memory: '256Mi' }

// Production gets LoadBalancer, others get ClusterIP
type: schema.spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
```

#### 3. Status Builder

The status builder uses CEL expressions to reflect the actual state of your deployment:

```typescript
// StatusBuilder function - maps resource status to your custom status
(schema, resources) => ({
  url: schema.spec.environment === 'production'
    ? Cel.expr(
        resources.service.status.loadBalancer.ingress,
        '.size() > 0 ? "http://" + ',
        resources.service.status.loadBalancer.ingress[0].ip,
        ': "pending"'
      )
    : Cel.template('http://%s', resources.service.spec.clusterIP),
  phase: Cel.expr(
    resources.deployment.status.readyReplicas,
    '== ',
    resources.deployment.spec.replicas,
    '? "running" : "pending"'
  ),
  readyReplicas: resources.deployment.status.readyReplicas
})
```

## Database Integration

Now let's build a more complex example with a PostgreSQL database, demonstrating StatefulSets, Services, ConfigMaps, Secrets, and cross-resource references.

### What You'll Build

- **PostgreSQL StatefulSet** with persistent storage
- **Headless Service** for StatefulSet pod discovery
- **LoadBalancer Service** for external access
- **ConfigMap** for database configuration
- **Secret** for sensitive credentials
- **API application** that connects to the database

### Complete Database Example

```typescript
import { type } from 'arktype';
import { toResourceGraph, Cel, simple } from 'typekro';

// Define the database schema
const DatabaseSpec = type({
  name: 'string',
  replicas: 'number>=1',
  storageSize: 'string',
  databaseName: 'string',
  username: 'string',
  password: 'string',
  externalAccess: 'boolean'
});

const DatabaseStatus = type({
  ready: 'boolean',
  replicas: 'number',
  primaryEndpoint: 'string',
  externalEndpoint: 'string'
});

// Create the database resource graph
const database = toResourceGraph(
  {
    name: 'postgres-database',
    apiVersion: 'data.example.com/v1',
    kind: 'PostgresDatabase',
    spec: DatabaseSpec,
    status: DatabaseStatus
  },
  (schema) => ({
    // Configuration for the database
    config: simple({
      name: Cel.template('%s-config', schema.spec.name),
      data: {
        // Database configuration
        POSTGRES_DB: schema.spec.databaseName,
        POSTGRES_USER: schema.spec.username,
        PGPORT: '5432',
        PGDATA: '/var/lib/postgresql/data/pgdata',
        
        // Performance tuning
        shared_preload_libraries: 'pg_stat_statements',
        max_connections: '200',
        shared_buffers: '256MB',
        effective_cache_size: '1GB',
        work_mem: '4MB'
      }
    }),
    
    // Secret for sensitive data
    credentials: simple.Secret({
      name: Cel.template('%s-credentials', schema.spec.name),
      data: {
        POSTGRES_PASSWORD: schema.spec.password,
        // Additional database users
        REPLICATION_USER: 'replicator',
        REPLICATION_PASSWORD: 'repl-secret-password'
      }
    }),
    
    // StatefulSet for PostgreSQL with persistent storage
    statefulSet: simple.StatefulSet({
      name: schema.spec.name,
      image: 'postgres:15',
      replicas: schema.spec.replicas,
      serviceName: Cel.template('%s-headless', schema.spec.name),
      ports: [5432],
      env: {
        // Reference configuration and secrets
        POSTGRES_DB: schema.spec.databaseName,
        POSTGRES_USER: schema.spec.username,
        POSTGRES_PASSWORD: schema.spec.password,
        PGDATA: '/var/lib/postgresql/data/pgdata'
      }
      // Note: volumeClaimTemplates would be added in full StatefulSet specification
    }),
    
    // Headless service for StatefulSet pod discovery
    headlessService: simple.Service({
      name: Cel.template('%s-headless', schema.spec.name),
      selector: { app: schema.spec.name },
      ports: [{ port: 5432, targetPort: 5432, name: 'postgres' }],
      clusterIP: 'None'  // Makes it headless
    }),
    
    // Regular service for database access
    service: simple.Service({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 5432, targetPort: 5432, name: 'postgres' }],
      type: 'ClusterIP'
    }),
    
    // Conditional external service
    ...(schema.spec.externalAccess && {
      externalService: simple.Service({
        name: Cel.template('%s-external', schema.spec.name),
        selector: { app: schema.spec.name },
        ports: [{ port: 5432, targetPort: 5432, name: 'postgres' }],
        type: 'LoadBalancer'
      })
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.statefulSet.status.readyReplicas, '>=', schema.spec.replicas
    ),
    replicas: resources.statefulSet.status.readyReplicas,
    primaryEndpoint: Cel.template(
      '%s:5432',
      resources.service.spec.clusterIP
    ),
    externalEndpoint: schema.spec.externalAccess
      ? Cel.expr(
          resources.externalService?.status.loadBalancer.ingress,
          '.size() > 0 ? ',
          resources.externalService?.status.loadBalancer.ingress[0].ip,
          ' + ":5432" : "pending"'
        )
      : 'disabled'
  })
);
```

### Application Connected to Database

Now let's create an API application that connects to our database:

```typescript
// Application that connects to the database
const ApiAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  databaseName: 'string'
});

const apiApp = toResourceGraph(
  {
    name: 'api-with-database',
    apiVersion: 'apps.example.com/v1',
    kind: 'ApiApp',
    spec: ApiAppSpec,
    status: type({ ready: 'boolean', url: 'string' })
  },
  (schema) => ({
    // API deployment that connects to database
    api: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [8080],
      env: {
        // Database connection configuration
        DATABASE_URL: Cel.template(
          'postgres://app:password@%s:5432/%s',
          schema.spec.databaseName,  // References database service
          schema.spec.databaseName
        ),
        DATABASE_HOST: schema.spec.databaseName,
        DATABASE_PORT: '5432',
        DATABASE_NAME: schema.spec.databaseName,
        DATABASE_USER: 'app',
        
        // Application configuration
        PORT: '8080',
        NODE_ENV: 'production'
      }
    }),
    
    // Service for the API
    apiService: simple.Service({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 8080 }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.api.status.readyReplicas, '> 0'),
    url: Cel.template('http://%s', resources.apiService.spec.clusterIP)
  })
);

// Deploy the complete system
async function deployDatabaseApp() {
  // Deploy database first
  const dbFactory = database.factory('direct', { namespace: 'database' });
  await dbFactory.deploy({
    name: 'postgres-main',
    replicas: 3,
    storageSize: '50Gi',
    databaseName: 'myapp',
    username: 'app',
    password: 'secure-password',
    externalAccess: true
  });
  
  // Deploy API application
  const apiFactory = apiApp.factory('direct', { namespace: 'default' });
  await apiFactory.deploy({
    name: 'myapp-api',
    image: 'myapp/api:v1.0',
    replicas: 2,
    databaseName: 'postgres-main'
  });
}
```

### Key Database Concepts

#### 1. StatefulSet with Persistent Storage

```typescript
statefulSet: simple.StatefulSet({
  name: schema.spec.name,
  image: 'postgres:15',
  replicas: schema.spec.replicas,
  serviceName: Cel.template('%s-headless', schema.spec.name),
  ports: [5432]
})
```

StatefulSets provide:
- **Stable network identities** for database pods
- **Ordered deployment** and scaling
- **Persistent storage** per pod
- **Stable hostnames** for replication

#### 2. Headless vs Regular Services

```typescript
// Headless service for StatefulSet internal communication
headlessService: simple.Service({
  name: Cel.template('%s-headless', schema.spec.name),
  selector: { app: schema.spec.name },
  clusterIP: 'None'  // Makes it headless
}),

// Regular service for application access
service: simple.Service({
  name: schema.spec.name,
  selector: { app: schema.spec.name },
  type: 'ClusterIP'
})
```

#### 3. Configuration Management

```typescript
// ConfigMap for non-sensitive configuration
config: simple({
  name: Cel.template('%s-config', schema.spec.name),
  data: {
    POSTGRES_DB: schema.spec.databaseName,
    POSTGRES_USER: schema.spec.username,
    max_connections: '200'
  }
}),

// Secret for sensitive data
credentials: simple.Secret({
  name: Cel.template('%s-credentials', schema.spec.name),
  data: {
    POSTGRES_PASSWORD: schema.spec.password
  }
})
```

#### 4. Cross-Resource References

```typescript
// API deployment references database
api: simple.Deployment({
  env: {
    DATABASE_URL: Cel.template(
      'postgres://app:password@%s:5432/%s',
      schema.spec.databaseName,  // References database service
      schema.spec.databaseName
    )
  }
})
```

## Common Pattern Extensions

### Add Health Checks

```typescript
const deployment = simple.Deployment({
  name: schema.spec.name,
  image: schema.spec.image,
  replicas: schema.spec.replicas,
  ports: [{ containerPort: 80 }],
  
  // Add health checks
  livenessProbe: {
    httpGet: { path: '/', port: 80 },
    initialDelaySeconds: 30,
    periodSeconds: 10
  },
  readinessProbe: {
    httpGet: { path: '/', port: 80 },
    initialDelaySeconds: 5,
    periodSeconds: 5
  }
});
```

### Add ConfigMap

```typescript
import { simple } from 'typekro';

const resources = {
  config: simple({
    name: Cel.expr(schema.spec.name, '-config'),
    data: {
      'nginx.conf': `
        server {
          listen 80;
          location / {
            return 200 'Hello from ${schema.spec.name}!';
          }
        }
      `
    }
  }),
  
  deployment: simple.Deployment({
    name: schema.spec.name,
    image: schema.spec.image,
    volumeMounts: [{
      name: 'config',
      mountPath: '/etc/nginx/conf.d'
    }],
    volumes: [{
      name: 'config',
      configMap: { name: 'config.metadata.name' }
    }]
  })
};
```

### Add Ingress

```typescript
import { simple } from 'typekro';

// Only in production
...(schema.spec.environment === 'production' && {
  ingress: simple.Ingress({
    name: Cel.expr(schema.spec.name, '-ingress'),
    rules: [{
      host: Cel.template('%s.example.com', schema.spec.name),
      http: {
        paths: [{
          path: '/',
          pathType: 'Prefix',
          backend: {
            service: {
              name: 'service.metadata.name',
              port: { number: 80 }
            }
          }
        }]
      }
    }]
  })
})
```

### Conditional Resources

Create resources only when certain conditions are met:

```typescript
const resources = {
  app: simple.Deployment({ /* ... */ }),
  
  // Only create external service if external access is enabled
  ...(schema.spec.externalAccess && {
    externalService: simple.Service({
      name: Cel.template('%s-external', schema.spec.name),
      type: 'LoadBalancer'
    })
  }),
  
  // Only create ingress in production
  ...(schema.spec.environment === 'production' && {
    ingress: simple.Ingress({
      name: Cel.expr(schema.spec.name, '-ingress'),
      host: Cel.template('%s.example.com', schema.spec.name)
    })
  })
};
```

## Testing Your Deployments

### Verify Resources

```bash
# Check pods
kubectl get pods -l app=my-webapp

# Check service
kubectl get service my-webapp-service

# Check your custom resource (if using KRO)
kubectl get webapp my-webapp -o yaml
```

### Access Your Application

For development (ClusterIP):
```bash
kubectl port-forward service/my-webapp-service 8080:80
curl http://localhost:8080
```

For production (LoadBalancer):
```bash
kubectl get service my-webapp-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
curl http://<EXTERNAL-IP>
```

### Database Access

For development:
```bash
kubectl port-forward service/postgres-main 5432:5432
psql -h localhost -p 5432 -U app -d myapp
```

For external access:
```bash
kubectl get service postgres-main-external -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
psql -h <EXTERNAL-IP> -p 5432 -U app -d myapp
```

## Best Practices

### 1. Use Secrets for Passwords

Always store sensitive data in Kubernetes Secrets:

```typescript
credentials: simple.Secret({
  name: 'db-credentials',
  data: {
    POSTGRES_PASSWORD: process.env.DB_PASSWORD  // From environment
  }
})
```

### 2. Configure Resource Limits

Set appropriate resource limits for your workloads:

```typescript
deployment: simple.Deployment({
  name: 'my-app',
  image: 'nginx:latest',
  resources: {
    requests: { cpu: '100m', memory: '256Mi' },
    limits: { cpu: '500m', memory: '1Gi' }
  }
})
```

### 3. Use Descriptive Names

```typescript
// ✅ Good
const userApiDeployment = simple.Deployment({ name: 'user-api' });
const userApiService = simple.Service({ name: 'user-api-service' });

// ❌ Avoid
const d1 = simple.Deployment({ name: 'app' });
const s1 = simple.Service({ name: 'svc' });
```

### 4. Environment-Specific Configuration

```typescript
const config = schema.spec.environment === 'production' 
  ? { replicas: 5, resources: { cpu: '500m', memory: '1Gi' } }
  : { replicas: 1, resources: { cpu: '100m', memory: '256Mi' } };

const deployment = simple.Deployment({
  name: schema.spec.name,
  image: schema.spec.image,
  replicas: config.replicas,
  resources: config.resources
});
```

### 5. Validate Configuration Early

```typescript
async function deployApp(input: unknown) {
  const spec = AppSpec(input);  // Validate immediately
  if (spec instanceof type.errors) {
    throw new Error(`Invalid spec: ${spec.summary}`);
  }
  
  // Proceed with validated data
  const factory = app.factory('direct', { namespace: 'default' });
  return factory.deploy(spec);
}
```

## Next Steps

Now that you understand the basic patterns, try these examples:

- **[Microservices](./microservices.md)** - Multiple interconnected services
- **[Multi-Environment](./multi-environment.md)** - Deploy across environments
- **[CI/CD](./cicd.md)** - Continuous integration and deployment
- **[Monitoring](./monitoring.md)** - Set up monitoring and observability

Or explore advanced topics:

- **[Runtime Behavior](../guide/runtime-behavior.md)** - Status hydration and cross-references
- **[CEL Expressions](../guide/cel-expressions.md)** - Add dynamic logic
- **[Factories](../guide/factories.md)** - Build custom factory functions
- **[Deployment Strategies](../guide/deployment/)** - Learn different deployment methods