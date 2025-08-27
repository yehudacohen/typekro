# External References

External references coordinate between different compositions. TypeKro provides two approaches: explicit external references using `externalRef()`, and magic proxy returns that allow direct usage of resources from other compositions.

## Magic Proxy Returns

The magic proxy system allows you to return resources from one composition and use them directly in another. This creates seamless cross-composition coordination without explicit external reference calls.

```typescript
// Database composition exports resources via magic proxy
const database = kubernetesComposition(dbDefinition, (spec) => {
  const postgres = Deployment({
    name: 'postgres',
    image: 'postgres:15'
  });
  
  const service = Service({
    name: 'postgres-service',
    selector: { app: 'postgres' },
    ports: [{ port: 5432 }]
  });
  
  return {
    ready: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0'),
    host: service.status.clusterIP,
    // Export the service resource itself via magic proxy
    service: service,
    postgres: postgres
  };
});

// Application composition uses returned resources directly
const application = kubernetesComposition(appDefinition, (spec) => {
  // Get a deployed instance of the database composition
  const dbInstance = database.getInstance('my-postgres');
  
  const app = Deployment({
    name: spec.name,
    image: spec.image,
    env: {
      // Direct usage of magic proxy returned resources
      DATABASE_HOST: dbInstance.service.status.clusterIP,
      DATABASE_PORT: dbInstance.service.spec.ports[0].port,
      // Can also use status values
      DATABASE_READY: dbInstance.ready
    }
  });
  
  return {
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0 && ', dbInstance.ready),
    databaseHost: dbInstance.host
  };
});
```

### Magic Proxy vs External References

| Aspect | Magic Proxy Returns | Explicit External References |
|--------|-------------------|------------------------------|
| **Setup** | Return resources from composition | Call `externalRef()` with type parameters |
| **Type Safety** | Automatic from returned types | Manual via generic type parameters |
| **Resource Access** | Direct property access | Same API as regular resources |
| **Cross-team Usage** | Requires shared composition definitions | Works with just API contract knowledge |
| **Runtime Resolution** | Resolved via composition instances | Resolved via Kubernetes resource lookup |

## Explicit External References

External references allow one composition to reference resources created by another composition, enabling true multi-composition architectures:

```typescript
// Database composition (deployed separately)
const database = kubernetesComposition(dbDefinition, (spec) => {
  const postgres = Deployment({
    name: 'postgres',
    image: 'postgres:15'
  });
  
  const service = Service({
    name: 'postgres-service',
    selector: { app: 'postgres' },
    ports: [{ port: 5432 }]
  });
  
  return {
    ready: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0'),
    host: service.status.clusterIP
  };
});

// Application composition (references database)
const application = kubernetesComposition(appDefinition, (spec) => {
  // External reference to database composition
  const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
    'database.example.com/v1alpha1',
    'Database',
    'my-postgres',
    'default'
  );
  
  const app = Deployment({
    name: spec.name,
    image: spec.image,
    env: {
      // Use database host from external composition
      DATABASE_HOST: dbRef.status.host,
      DATABASE_READY: dbRef.status.ready
    }
  });
  
  return {
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    databaseConnected: dbRef.status.ready
  };
});
```

## The `externalRef()` Function

The `externalRef()` function creates a reference to a resource managed by another composition:

```typescript
import { externalRef } from 'typekro';

const dbRef = externalRef<TSpec, TStatus>(
  'database.example.com/v1alpha1',  // API version
  'Database',                       // Kind
  'my-postgres',                    // Instance name
  'default'                         // Namespace (optional)
);

// Now use it like any other Enhanced resource
const host = dbRef.status.host;
const ready = dbRef.status.ready;
```

### Type Safety

External references maintain full type safety when you provide the correct type parameters:

```typescript
// Define the external resource types
interface DatabaseSpec {
  name: string;
  size: string;
}

interface DatabaseStatus {
  ready: boolean;
  host: string;
  port: number;
}

// Create typed external reference
const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
  'database.example.com/v1alpha1',
  'Database',
  'my-postgres'
);

// ✅ These work - proper types
dbRef.spec.name;      // string
dbRef.spec.size;      // string  
dbRef.status.ready;   // boolean
dbRef.status.host;    // string

// ❌ These fail at compile time
dbRef.status.invalid; // Property doesn't exist
dbRef.spec.port;      // Wrong, port is in status
```

## External Reference Use Cases

External references solve several common infrastructure coordination problems:

- **Multi-team environments**: Teams can reference resources they don't own
- **Shared services**: Common databases, caches, and infrastructure components  
- **Environment dependencies**: Reference external services in different namespaces
- **Cross-cluster coordination**: Reference resources in other clusters (when using KRO mode)

## Real-World Example: Microservices Architecture

Let's build a realistic microservices system with external references:

### 1. Shared Database Service

```typescript
// database.ts
import { type } from 'arktype';
import { kubernetesComposition, Cel } from 'typekro';
import { Deployment, Service, Ingress } from 'typekro/simple';

const DatabaseSpec = type({
  name: 'string',
  storage: 'string',
  password: 'string'
});

const DatabaseStatus = type({
  ready: 'boolean',
  host: 'string',
  port: 'number',
  connectionString: 'string'
});

export const databaseService = kubernetesComposition(
  {
    name: 'database-service',
    apiVersion: 'data.company.com/v1alpha1',
    kind: 'Database', 
    spec: DatabaseSpec,
    status: DatabaseStatus,
  },
  (spec) => {
    const postgres = Deployment({
      name: spec.name,
      image: 'postgres:15',
      env: {
        POSTGRES_DB: 'app',
        POSTGRES_PASSWORD: spec.password
      },
      ports: [{ containerPort: 5432 }]
    });
    
    const service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 5432, targetPort: 5432 }]
    });
    
    return {
      ready: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0'),
      host: service.status.clusterIP,
      port: 5432,
      connectionString: Cel.template(
        'postgresql://postgres:%s@%s:5432/app',
        spec.password,
        service.status.clusterIP
      )
    };
  }
);
```

### 2. User Service (References Database)

```typescript
// user-service.ts  
import { type } from 'arktype';
import { kubernetesComposition, simple, externalRef, Cel } from 'typekro';

const UserServiceSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number'
});

const UserServiceStatus = type({
  ready: 'boolean',
  endpoint: 'string',
  databaseConnected: 'boolean'
});

export const userService = kubernetesComposition(
  {
    name: 'user-service',
    apiVersion: 'services.company.com/v1alpha1',
    kind: 'UserService',
    spec: UserServiceSpec,
    status: UserServiceStatus,
  },
  (spec) => {
    // External reference to database
    const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
      'data.company.com/v1alpha1',
      'Database',
      'main-database',
      'default'
    );
    
    const app = Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      env: {
        DATABASE_URL: dbRef.status.connectionString,
        SERVICE_NAME: spec.name
      },
      ports: [{ containerPort: 3000 }]
    });
    
    const service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    });
    
    return {
      ready: Cel.expr<boolean>(
        app.status.readyReplicas, ' > 0 && ',
        dbRef.status.ready
      ),
      endpoint: Cel.template('http://%s:80', service.status.clusterIP),
      databaseConnected: dbRef.status.ready
    };
  }
);
```

### 3. API Gateway (References User Service)

```typescript
// api-gateway.ts
import { type } from 'arktype';
import { kubernetesComposition, simple, externalRef, Cel } from 'typekro';

const ApiGatewaySpec = type({
  name: 'string',
  image: 'string',
  domain: 'string'
});

const ApiGatewayStatus = type({
  ready: 'boolean',
  url: 'string',
  servicesHealthy: 'boolean'
});

export const apiGateway = kubernetesComposition(
  {
    name: 'api-gateway',
    apiVersion: 'gateway.company.com/v1alpha1',
    kind: 'ApiGateway',
    spec: ApiGatewaySpec,
    status: ApiGatewayStatus,
  },
  (spec) => {
    // External references to microservices
    const userServiceRef = externalRef<UserServiceSpec, UserServiceStatus>(
      'services.company.com/v1alpha1',
      'UserService',
      'user-api',
      'default'
    );
    
    const gateway = Deployment({
      name: spec.name,
      image: spec.image,
      env: {
        USER_SERVICE_URL: userServiceRef.status.endpoint,
        GATEWAY_DOMAIN: spec.domain
      },
      ports: [{ containerPort: 8080 }]
    });
    
    const service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 8080 }],
      type: 'LoadBalancer'
    });
    
    const ingress = Ingress({
      name: `${spec.name}-ingress`,
      host: spec.domain,
      serviceName: service.metadata.name,
      servicePort: 80
    });
    
    return {
      ready: Cel.expr<boolean>(
        gateway.status.readyReplicas, ' > 0 && ',
        userServiceRef.status.ready
      ),
      url: Cel.template('https://%s', spec.domain),
      servicesHealthy: userServiceRef.status.databaseConnected
    };
  }
);
```

## Deployment Orchestration

With external references, you can deploy compositions in order:

### 1. Deploy Database First

```typescript
// deploy-database.ts
import { databaseService } from './database.js';

const dbFactory = databaseService.factory('direct', {
  namespace: 'default'
});

await dbFactory.deploy({
  name: 'main-database',
  storage: '50Gi',
  password: 'supersecret'
});

console.log('✅ Database deployed');
```

### 2. Deploy User Service (References Database)

```typescript
// deploy-user-service.ts
import { userService } from './user-service.js';

const userFactory = userService.factory('direct', {
  namespace: 'default'
});

await userFactory.deploy({
  name: 'user-api',
  image: 'company/user-service:v1.0.0',
  replicas: 3
});

console.log('✅ User service deployed');
```

### 3. Deploy API Gateway (References User Service)

```typescript
// deploy-gateway.ts
import { apiGateway } from './api-gateway.js';

const gatewayFactory = apiGateway.factory('direct', {
  namespace: 'default'  
});

await gatewayFactory.deploy({
  name: 'main-gateway',
  image: 'company/api-gateway:v1.0.0',
  domain: 'api.company.com'
});

console.log('✅ API gateway deployed');
```

## Multi-Team Patterns

Common patterns for teams working with shared resources:

### **Team Independence with Type Safety**

```typescript
// Platform Team: Defines shared database contract
export interface PlatformDatabaseStatus {
  ready: boolean;
  primaryHost: string;
  replicaHost: string;
  port: number;
  tlsEnabled: boolean;
}

// App Team A: Uses database with type safety
const appA = kubernetesComposition(defA, (spec) => {
  const dbRef = externalRef<any, PlatformDatabaseStatus>(
    'platform.company.com/v1', 'Database', 'shared-postgres'
  );
  
  return {
    // Type-safe access to platform team's database
    connected: dbRef.status.ready,
    dbHost: dbRef.status.primaryHost
  };
});

// App Team B: Same database, different usage
const appB = kubernetesComposition(defB, (spec) => {
  const dbRef = externalRef<any, PlatformDatabaseStatus>(
    'platform.company.com/v1', 'Database', 'shared-postgres'  
  );
  
  return {
    // Uses replica for read-only workloads
    readerEndpoint: Cel.template('postgresql://%s:%d/readonly', 
      dbRef.status.replicaHost, 
      dbRef.status.port
    )
  };
});
```

### **Cross-Environment References**

```typescript
// Development references staging database
const devApp = kubernetesComposition(definition, (spec) => {
  const stagingDbRef = externalRef<DatabaseSpec, DatabaseStatus>(
    'data.company.com/v1alpha1', 
    'Database', 
    'staging-postgres',
    'staging-namespace'  // Cross-namespace reference
  );
  
  const app = Deployment({
    name: spec.name,
    env: {
      DATABASE_HOST: stagingDbRef.status.host,
      DATABASE_PORT: stagingDbRef.status.port
    }
  });
  
  return {
    ready: Cel.expr<boolean>(
      app.status.readyReplicas, ' > 0 && ',
      stagingDbRef.status.ready
    ),
    usingStagingData: true
  };
});
```

### **Service Mesh Integration**

```typescript
// External reference to service mesh control plane
const meshApp = kubernetesComposition(definition, (spec) => {
  const meshRef = externalRef<MeshSpec, MeshStatus>(
    'mesh.company.com/v1beta1', 'ServiceMesh', 'istio-system'
  );
  
  const app = Deployment({
    name: spec.name,
    annotations: {
      'mesh.istio.io/inject': 'true',
      'mesh.company.com/mesh-id': meshRef.status.meshId
    }
  });
  
  return {
    meshed: meshRef.status.ready,
    meshVersion: meshRef.status.version
  };
});
```

## Advanced External Reference Patterns

### Conditional External References

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  // Only reference external cache in production
  const cacheRef = spec.environment === 'production'
    ? externalRef<CacheSpec, CacheStatus>(
        'cache.company.com/v1alpha1',
        'Cache', 
        'redis-cluster',
        'production'
      )
    : null;
  
  const app = Deployment({
    name: spec.name,
    image: spec.image,
    env: {
      // Conditional environment variables
      ...(cacheRef && {
        CACHE_URL: cacheRef.status.connectionString,
        CACHE_ENABLED: 'true'
      })
    }
  });
  
  return {
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    cacheEnabled: spec.environment === 'production',
    cacheReady: Cel.expr<boolean>('cacheRef != null ? cacheRef.status.ready : false')
  };
});
```

### Multiple External References

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  // Reference multiple external services
  const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
    'data.company.com/v1alpha1',
    'Database',
    'main-db'
  );
  
  const cacheRef = externalRef<CacheSpec, CacheStatus>(
    'cache.company.com/v1alpha1', 
    'Cache',
    'redis-cluster'
  );
  
  const authRef = externalRef<AuthSpec, AuthStatus>(
    'auth.company.com/v1alpha1',
    'AuthService', 
    'oauth-provider'
  );
  
  const app = Deployment({
    name: spec.name,
    image: spec.image,
    env: {
      DATABASE_URL: dbRef.status.connectionString,
      CACHE_URL: cacheRef.status.connectionString,
      AUTH_URL: authRef.status.endpoint
    }
  });
  
  return {
    ready: Cel.expr<boolean>(
      app.status.readyReplicas, ' > 0 && ',
      dbRef.status.ready, ' && ',
      cacheRef.status.ready, ' && ',
      authRef.status.ready
    ),
    servicesReady: {
      database: dbRef.status.ready,
      cache: cacheRef.status.ready, 
      auth: authRef.status.ready
    }
  };
});
```

### Cross-Namespace References

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  // Reference service in different namespace
  const sharedDbRef = externalRef<DatabaseSpec, DatabaseStatus>(
    'data.company.com/v1alpha1',
    'Database',
    'shared-postgres',
    'shared-services'  // Different namespace
  );
  
  const app = Deployment({
    name: spec.name,
    image: spec.image,
    env: {
      DATABASE_URL: sharedDbRef.status.connectionString
    }
  });
  
  return {
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    databaseReady: sharedDbRef.status.ready
  };
});
```

## External References in GitOps

External references work seamlessly with GitOps workflows:

### 1. Generate YAML with External References

```typescript
// generate-yaml.ts
import { userService } from './user-service.js';
import { writeFileSync } from 'fs';

// Generate ResourceGraphDefinition
const rgdYaml = userService.toYaml();
writeFileSync('user-service-rgd.yaml', rgdYaml);

// Generate instance with external reference
const instanceYaml = userService.toYaml({
  name: 'user-api',
  image: 'company/user-service:v1.0.0', 
  replicas: 3
});
writeFileSync('user-service-instance.yaml', instanceYaml);
```

### 2. Deploy via GitOps

The generated YAML includes external reference metadata:

```yaml
# user-service-instance.yaml
apiVersion: services.company.com/v1alpha1
kind: UserService
metadata:
  name: user-api
spec:
  name: user-api
  image: company/user-service:v1.0.0
  replicas: 3
status:
  ready: "{{resources.app.status.readyReplicas > 0 && resources.dbRef.status.ready}}"
  databaseConnected: "{{resources.dbRef.status.ready}}"
  # External reference metadata automatically included
  externalRefs:
    - apiVersion: data.company.com/v1alpha1
      kind: Database
      name: main-database
      namespace: default
```

## Best Practices for External References

### 1. Defensive Reference Handling

Always handle cases where external references might not be ready:

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
    'data.company.com/v1alpha1',
    'Database',
    'main-database'
  );

  const app = Deployment({
    name: spec.name,
    image: spec.image,
    env: {
      DATABASE_URL: dbRef.status.connectionString,
      // Provide fallback values for robustness
      MAX_CONNECTIONS: Cel.expr<string>(
        dbRef.status.ready, 
        ' ? "100" : "10"'
      ),
      CACHE_ENABLED: Cel.expr<string>(
        dbRef.status.ready,
        ' ? "true" : "false"'
      )
    }
  });

  return {
    ready: Cel.expr<boolean>(
      app.status.readyReplicas, ' > 0 && ',
      // Graceful degradation - app can start without DB for health checks
      '(', dbRef.status.ready, ' || "', spec.environment, '" == "development")'
    ),
    degradedMode: Cel.expr<boolean>('!', dbRef.status.ready),
    databaseConnected: dbRef.status.ready
  };
});
```

### 2. Resource Naming Conventions

Establish clear naming patterns for external references:

```typescript
// ✅ Good: Clear, predictable naming
const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
  'data.platform.company.com/v1',
  'Database',
  `${spec.environment}-postgres`,  // environment-service pattern
  `data-${spec.environment}`       // namespace pattern
);

// ✅ Good: Team-based naming
const authRef = externalRef<AuthSpec, AuthStatus>(
  'auth.platform.company.com/v1',
  'AuthService',
  'platform-oauth',               // team-service pattern
  'platform-services'             // team namespace
);

// ❌ Avoid: Cryptic or inconsistent names
const ref1 = externalRef('api.company.com/v1', 'Service', 'svc-xyz-123');
```

### 3. Type-Safe External Contracts

Create shared type definitions for external references:

```typescript
// shared-types/platform.ts - Shared across teams
export interface PlatformDatabaseStatus {
  ready: boolean;
  connectionString: string;
  primaryHost: string;
  replicaHost?: string;
  port: number;
  version: string;
  maintenanceWindow?: string;
}

export interface PlatformCacheStatus {
  ready: boolean;
  endpoint: string;
  clusterSize: number;
  memoryUsage: number;
  evictionPolicy: string;
}

// app-service/composition.ts - App team uses shared types
import { PlatformDatabaseStatus, PlatformCacheStatus } from '../shared-types/platform.js';

const appService = kubernetesComposition(definition, (spec) => {
  const dbRef = externalRef<any, PlatformDatabaseStatus>(
    'data.platform.company.com/v1', 'Database', 'shared-postgres'
  );
  
  const cacheRef = externalRef<any, PlatformCacheStatus>(
    'cache.platform.company.com/v1', 'Cache', 'shared-redis'
  );

  // Type-safe usage with IntelliSense support
  const app = Deployment({
    name: spec.name,
    env: {
      DATABASE_URL: dbRef.status.connectionString,
      DATABASE_VERSION: dbRef.status.version,
      CACHE_ENDPOINT: cacheRef.status.endpoint,
      CACHE_POLICY: cacheRef.status.evictionPolicy
    }
  });

  return {
    ready: Cel.expr<boolean>(
      app.status.readyReplicas, ' > 0 && ',
      dbRef.status.ready, ' && ',
      cacheRef.status.ready
    ),
    platformServices: {
      databaseVersion: dbRef.status.version,
      cacheClusterSize: cacheRef.status.clusterSize
    }
  };
});
```

### 4. Environment-Specific External References

Handle different environments systematically:

```typescript
interface EnvironmentConfig {
  database: {
    apiVersion: string;
    name: string;
    namespace: string;
  };
  cache: {
    apiVersion: string;
    name: string;
    namespace: string;
  };
}

const envConfigs: Record<string, EnvironmentConfig> = {
  development: {
    database: {
      apiVersion: 'data.dev.company.com/v1',
      name: 'dev-postgres',
      namespace: 'dev-data'
    },
    cache: {
      apiVersion: 'cache.dev.company.com/v1', 
      name: 'dev-redis',
      namespace: 'dev-cache'
    }
  },
  production: {
    database: {
      apiVersion: 'data.platform.company.com/v1',
      name: 'prod-postgres-cluster',
      namespace: 'platform-data'
    },
    cache: {
      apiVersion: 'cache.platform.company.com/v1',
      name: 'prod-redis-cluster', 
      namespace: 'platform-cache'
    }
  }
};

const composition = kubernetesComposition(definition, (spec) => {
  const envConfig = envConfigs[spec.environment];
  
  const dbRef = externalRef<any, DatabaseStatus>(
    envConfig.database.apiVersion,
    'Database',
    envConfig.database.name,
    envConfig.database.namespace
  );

  const cacheRef = externalRef<any, CacheStatus>(
    envConfig.cache.apiVersion,
    'Cache',
    envConfig.cache.name,
    envConfig.cache.namespace
  );

  // Environment-aware app configuration
  const app = Deployment({
    name: spec.name,
    image: spec.image,
    replicas: spec.environment === 'production' ? 3 : 1,
    env: {
      DATABASE_URL: dbRef.status.connectionString,
      CACHE_URL: cacheRef.status.endpoint,
      ENVIRONMENT: spec.environment
    }
  });

  return {
    ready: Cel.expr<boolean>(
      app.status.readyReplicas, ' > 0 && ',
      dbRef.status.ready, ' && ',
      cacheRef.status.ready
    ),
    environment: spec.environment,
    platformReady: Cel.expr<boolean>(
      dbRef.status.ready, ' && ', cacheRef.status.ready
    )
  };
});
```

## Debugging External References

### Check Reference Resolution

```typescript
const factory = composition.factory('direct', { namespace: 'default' });

// Deploy and check status
const result = await factory.deploy(spec);
const status = await factory.getStatus();

console.log('External references:', status.externalRefs);
console.log('Database ready:', status.databaseConnected);
```

### Verify External Resources Exist

```bash
# Check if external resource exists
kubectl get database main-database -o yaml

# Check status of external resource
kubectl get database main-database -o jsonpath='{.status}'
```

### Debug External Reference Issues

Use TypeKro's debugging capabilities:

```bash
# Enable debug logging for external references
export TYPEKRO_LOG_LEVEL=debug
export TYPEKRO_DEBUG_COMPONENTS="external-refs,composition"

# Deploy and watch logs
node deploy-app.js 2>&1 | grep -E "(external-ref|reference-resolution)"
```

**Expected debug output**:
```json
{"level":"debug","component":"external-refs","msg":"Creating external reference","apiVersion":"data.company.com/v1","kind":"Database","name":"main-database","namespace":"default"}
{"level":"debug","component":"reference-resolution","msg":"External reference resolved","resourceId":"dbRef","status":{"ready":true}}
```

### Common External Reference Issues

**Issue 1: External resource not found**
```bash
# Check if external resource exists in expected namespace
kubectl get database main-database -n default

# If not found, check other namespaces
kubectl get database --all-namespaces
```

**Issue 2: External resource exists but status is not ready**
```bash
# Check the status of the external resource
kubectl describe database main-database
kubectl get database main-database -o jsonpath='{.status}' | jq .
```

**Issue 3: Permission issues**
```bash
# Check RBAC permissions for external resource access
kubectl auth can-i get database --as=system:serviceaccount:default:typekro
kubectl auth can-i watch database --as=system:serviceaccount:default:typekro
```

## What's Next?

You now understand TypeKro's complete reference system - from magic proxy to external references. Let's dive into the architecture that makes it all work:

### Next: [Advanced Architecture →](./architecture.md)
Understand the deep technical architecture behind TypeKro's capabilities.

**In this learning path:**
- ✅ Your First App - Built your first TypeKro application  
- ✅ Factory Functions - Mastered resource creation
- ✅ Magic Proxy System - Understood TypeKro's reference magic
- ✅ External References - Learned cross-composition coordination
- 🎯 **Next**: Advanced Architecture - Deep technical understanding

## Quick Reference

### Creating External References
```typescript
import { externalRef } from 'typekro';

const dbRef = externalRef<TSpec, TStatus>(
  'database.example.com/v1alpha1',  // API version
  'Database',                       // Kind  
  'instance-name',                  // Name
  'namespace'                       // Namespace (optional)
);
```

### Using External References
```typescript
// In resource configuration
env: {
  DATABASE_URL: dbRef.status.connectionString,
  DATABASE_READY: dbRef.status.ready
}

// In status
return {
  databaseConnected: dbRef.status.ready,
  ready: Cel.expr<boolean>(
    app.status.readyReplicas, ' > 0 && ',
    dbRef.status.ready
  )
};
```

### Deployment Order
```typescript
// 1. Deploy dependencies first
await databaseFactory.deploy(dbSpec);

// 2. Deploy services that reference them
await appFactory.deploy(appSpec);
```

Ready for the deep dive? Continue to [Advanced Architecture →](./architecture.md)