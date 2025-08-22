# Database Integration Example

This example demonstrates how to create a complete database-backed application using TypeKro with PostgreSQL, including StatefulSets, Services, ConfigMaps, Secrets, and cross-resource references.

## Overview

We'll build a database system with:
- **PostgreSQL StatefulSet** with persistent storage
- **Headless Service** for StatefulSet pod discovery
- **LoadBalancer Service** for external access
- **ConfigMap** for database configuration
- **Secret** for sensitive credentials
- **API application** that connects to the database

## Complete Example

```typescript
import { type } from 'arktype';
import { 
  toResourceGraph, 
  simpleStatefulSet, 
  simpleService, 
  simpleConfigMap, 
  simpleSecret,
  simpleDeployment,
  simplePvc,
  Cel 
} from 'typekro';

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
    config: simpleConfigMap({
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
    credentials: simpleSecret({
      name: Cel.template('%s-credentials', schema.spec.name),
      data: {
        POSTGRES_PASSWORD: schema.spec.password,
        // Additional database users
        REPLICATION_USER: 'replicator',
        REPLICATION_PASSWORD: 'repl-secret-password'
      }
    }),
    
    // StatefulSet for PostgreSQL with persistent storage
    statefulSet: simpleStatefulSet({
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
    headlessService: simpleService({
      name: Cel.template('%s-headless', schema.spec.name),
      selector: { app: schema.spec.name },
      ports: [{ port: 5432, targetPort: 5432, name: 'postgres' }],
      clusterIP: 'None'  // Makes it headless
    }),
    
    // Regular service for database access
    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 5432, targetPort: 5432, name: 'postgres' }],
      type: 'ClusterIP'
    }),
    
    // Conditional external service
    externalService: Cel.conditional(
      schema.spec.externalAccess,
      simpleService({
        name: Cel.template('%s-external', schema.spec.name),
        selector: { app: schema.spec.name },
        ports: [{ port: 5432, targetPort: 5432, name: 'postgres' }],
        type: 'LoadBalancer'
      }),
      null
    )
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.statefulSet.status.readyReplicas, ' >= ', schema.spec.replicas
    ),
    replicas: resources.statefulSet.status.readyReplicas,
    primaryEndpoint: Cel.template(
      '%s:5432',
      resources.service.spec.clusterIP
    ),
    externalEndpoint: Cel.conditional(
      schema.spec.externalAccess,
      Cel.template(
        '%s:5432',
        resources.externalService?.status?.loadBalancer?.ingress?.[0]?.ip || 'pending'
      ),
      'disabled'
    )
  })
);

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
    // Database instance
    database: database,
    
    // API deployment that connects to database
    api: simpleDeployment({
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
        DATABASE_PASSWORD: 'password',  // In real usage, reference secret
        
        // Application configuration
        PORT: '8080',
        NODE_ENV: 'production'
      }
    }),
    
    // Service for the API
    apiService: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 8080 }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.database.status.ready, ' && ',
      resources.api.status.readyReplicas, ' > 0'
    ),
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

// For GitOps workflow
async function generateYaml() {
  const dbFactory = database.factory('kro', { namespace: 'database' });
  const dbYaml = dbFactory.toYaml();
  
  const apiFactory = apiApp.factory('kro', { namespace: 'default' });
  const apiYaml = apiFactory.toYaml();
  
  // Write YAML files for GitOps deployment
  writeFileSync('k8s/database.yaml', dbYaml);
  writeFileSync('k8s/api-app.yaml', apiYaml);
}
```

## Key Features Demonstrated

### 1. **StatefulSet with Persistent Storage**

```typescript
statefulSet: simpleStatefulSet({
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

### 2. **Headless vs Regular Services**

```typescript
// Headless service for StatefulSet internal communication
headlessService: simpleService({
  name: Cel.template('%s-headless', schema.spec.name),
  selector: { app: schema.spec.name },
  clusterIP: 'None'  // Makes it headless
}),

// Regular service for application access
service: simpleService({
  name: schema.spec.name,
  selector: { app: schema.spec.name },
  type: 'ClusterIP'
})
```

### 3. **Configuration Management**

```typescript
// ConfigMap for non-sensitive configuration
config: simpleConfigMap({
  name: Cel.template('%s-config', schema.spec.name),
  data: {
    POSTGRES_DB: schema.spec.databaseName,
    POSTGRES_USER: schema.spec.username,
    max_connections: '200'
  }
}),

// Secret for sensitive data
credentials: simpleSecret({
  name: Cel.template('%s-credentials', schema.spec.name),
  data: {
    POSTGRES_PASSWORD: schema.spec.password
  }
})
```

### 4. **Cross-Resource References**

```typescript
// API deployment references database
api: simpleDeployment({
  env: {
    DATABASE_URL: Cel.template(
      'postgres://app:password@%s:5432/%s',
      schema.spec.databaseName,  // References database service
      schema.spec.databaseName
    )
  }
})
```

### 5. **Conditional Resources**

```typescript
// Only create external service if external access is enabled
externalService: Cel.conditional(
  schema.spec.externalAccess,
  simpleService({
    name: Cel.template('%s-external', schema.spec.name),
    type: 'LoadBalancer'
  }),
  null
)
```

## Advanced Database Patterns

### Master-Slave Replication

```typescript
const replicatedDatabase = toResourceGraph(
  {
    name: 'postgres-replicated',
    apiVersion: 'data.example.com/v1',
    kind: 'ReplicatedPostgres',
    spec: type({
      name: 'string',
      masterReplicas: 'number',
      slaveReplicas: 'number'
    }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Master database
    master: simpleStatefulSet({
      name: Cel.template('%s-master', schema.spec.name),
      image: 'postgres:15',
      replicas: schema.spec.masterReplicas,
      env: {
        POSTGRES_REPLICATION_MODE: 'master',
        POSTGRES_REPLICATION_USER: 'replicator'
      }
    }),
    
    // Slave replicas
    slaves: simpleStatefulSet({
      name: Cel.template('%s-slave', schema.spec.name),
      image: 'postgres:15',
      replicas: schema.spec.slaveReplicas,
      env: {
        POSTGRES_REPLICATION_MODE: 'slave',
        POSTGRES_MASTER_SERVICE: Cel.template('%s-master', schema.spec.name)
      }
    }),
    
    // Read-write service (points to master)
    writeService: simpleService({
      name: Cel.template('%s-write', schema.spec.name),
      selector: { 
        app: Cel.template('%s-master', schema.spec.name),
        role: 'master'
      },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),
    
    // Read-only service (points to slaves)
    readService: simpleService({
      name: Cel.template('%s-read', schema.spec.name),
      selector: { 
        app: Cel.template('%s-slave', schema.spec.name),
        role: 'slave'
      },
      ports: [{ port: 5432, targetPort: 5432 }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.master.status.readyReplicas, ' >= ', schema.spec.masterReplicas,
      ' && ',
      resources.slaves.status.readyReplicas, ' >= ', schema.spec.slaveReplicas
    )
  })
);
```

### Database with Backup

```typescript
const databaseWithBackup = toResourceGraph(
  {
    name: 'postgres-with-backup',
    apiVersion: 'data.example.com/v1',
    kind: 'PostgresWithBackup',
    spec: type({
      name: 'string',
      backupSchedule: 'string',
      retentionDays: 'number'
    }),
    status: type({ 
      ready: 'boolean',
      lastBackup: 'string'
    })
  },
  (schema) => ({
    // Main database
    database: simpleStatefulSet({
      name: schema.spec.name,
      image: 'postgres:15'
    }),
    
    // Backup credentials
    backupSecret: simpleSecret({
      name: Cel.template('%s-backup-creds', schema.spec.name),
      data: {
        S3_ACCESS_KEY: 'your-access-key',
        S3_SECRET_KEY: 'your-secret-key'
      }
    }),
    
    // Backup CronJob
    backup: simpleCronJob({
      name: Cel.template('%s-backup', schema.spec.name),
      image: 'postgres-backup:latest',
      schedule: schema.spec.backupSchedule,
      command: ['backup-database'],
      env: {
        DATABASE_HOST: schema.spec.name,
        DATABASE_PORT: '5432',
        RETENTION_DAYS: Cel.expr('string(', schema.spec.retentionDays, ')')
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.database.status.readyReplicas, ' > 0'),
    lastBackup: Cel.expr('string(', resources.backup.status.lastScheduleTime, ')')
  })
);
```

## Deployment Strategies

### Development Environment

```typescript
// Quick local development deployment
async function deployDev() {
  const factory = database.factory('direct', { namespace: 'dev' });
  await factory.deploy({
    name: 'postgres-dev',
    replicas: 1,
    storageSize: '5Gi',
    databaseName: 'devdb',
    username: 'dev',
    password: 'devpass',
    externalAccess: true  // For local access
  });
}
```

### Production Environment

```typescript
// GitOps production deployment
async function deployProd() {
  const factory = database.factory('kro', { namespace: 'production' });
  const yaml = factory.toYaml();
  
  // Save for GitOps deployment
  writeFileSync('k8s/production/database.yaml', yaml);
}
```

## Best Practices

### 1. **Use Secrets for Passwords**

Always store sensitive data in Kubernetes Secrets:

```typescript
credentials: simpleSecret({
  name: 'db-credentials',
  data: {
    POSTGRES_PASSWORD: process.env.DB_PASSWORD  // From environment
  }
})
```

### 2. **Configure Resource Limits**

Set appropriate resource limits for database workloads:

```typescript
statefulSet: simpleStatefulSet({
  name: 'postgres',
  image: 'postgres:15',
  resources: {
    requests: { cpu: '500m', memory: '1Gi' },
    limits: { cpu: '2000m', memory: '4Gi' }
  }
})
```

### 3. **Use Persistent Storage**

Always configure persistent storage for databases:

```typescript
// In full StatefulSet specification
volumeClaimTemplates: [{
  metadata: { name: 'postgres-storage' },
  spec: {
    accessModes: ['ReadWriteOnce'],
    storageClassName: 'fast-ssd',
    resources: {
      requests: { storage: '50Gi' }
    }
  }
}]
```

### 4. **Monitor Database Health**

Include health checks and monitoring:

```typescript
statefulSet: simpleStatefulSet({
  name: 'postgres',
  healthCheck: {
    readinessProbe: {
      exec: {
        command: ['pg_isready', '-U', 'postgres']
      },
      initialDelaySeconds: 15,
      periodSeconds: 10
    }
  }
})
```

## Related Examples

- [Simple Web App](./simple-webapp.md) - Basic application deployment
- [Microservices](./microservices.md) - Multi-service architecture
- [Monitoring Stack](./monitoring.md) - Database monitoring setup

## Related APIs

- [Workloads API](../api/factories/workloads.md) - StatefulSet and Deployment factories
- [Configuration API](../api/factories/config.md) - ConfigMap and Secret management
- [Storage API](../api/factories/storage.md) - Persistent Volume Claims
- [CEL Expressions API](../api/cel.md) - Dynamic configuration patterns