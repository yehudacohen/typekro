# External References

External references coordinate between different compositions, enabling multi-composition architectures.

## When to Use

| Scenario | Solution |
|----------|----------|
| Resources in the **same** composition | Direct references (magic proxy) |
| Resources in **different** compositions | `externalRef()` |
| Cross-team shared services | `externalRef()` with shared type definitions |

## Quick Start

```typescript
import { externalRef, kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';

// Define types for the external resource
interface DatabaseSpec { name: string; }
interface DatabaseStatus { ready: boolean; host: string; port: number; }

// Reference a resource from another composition
const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
  'database.example.com/v1alpha1',  // API version
  'Database',                       // Kind
  'my-postgres',                    // Instance name
  'default'                         // Namespace (optional)
);

// Use it in a composition
const app = kubernetesComposition(definition, (spec) => {
  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    env: {
      DATABASE_HOST: dbRef.status.host,
      DATABASE_READY: dbRef.status.ready
    }
  });
  
  return { ready: deploy.status.readyReplicas > 0 };
});
```

## Type Safety

External references maintain full type safety with proper type parameters:

```typescript
interface DatabaseStatus {
  ready: boolean;
  host: string;
  port: number;
}

const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
  'database.example.com/v1alpha1',
  'Database',
  'my-postgres'
);

// ✅ Type-safe access
dbRef.status.host;    // string
dbRef.status.ready;   // boolean

// ❌ Compile-time errors
dbRef.status.invalid; // Property doesn't exist
```

## Real-World Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition, externalRef } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

// Types for the external database resource
interface DatabaseSpec { name: string; storage: string; }
interface DatabaseStatus { ready: boolean; host: string; }

// Database composition (deployed separately)
const database = kubernetesComposition(dbDefinition, (spec) => {
  const postgres = Deployment({ id: 'db', name: 'postgres', image: 'postgres:15' });
  const service = Service({
    id: 'svc',
    name: 'postgres-service',
    selector: { app: 'postgres' },
    ports: [{ port: 5432 }]
  });
  
  return {
    ready: postgres.status.readyReplicas > 0,
    host: service.status.clusterIP
  };
});

// Application composition (references database)
const application = kubernetesComposition(appDefinition, (spec) => {
  const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
    'data.company.com/v1alpha1',
    'Database',
    'main-database'
  );
  
  const app = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    env: {
      DATABASE_HOST: dbRef.status.host,
      DATABASE_READY: dbRef.status.ready
    }
  });
  
  return {
    ready: app.status.readyReplicas > 0 && dbRef.status.ready,
    databaseConnected: dbRef.status.ready
  };
});
```

## Deployment Order

Deploy compositions in dependency order:

```typescript
// 1. Deploy database first
await databaseFactory.deploy({ name: 'main-database', storage: '50Gi' });

// 2. Deploy app that references it
await appFactory.deploy({ name: 'my-app', image: 'nginx' });
```

## Cross-Namespace References

Reference resources in different namespaces:

```typescript
const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
  'data.company.com/v1alpha1',
  'Database',
  'shared-postgres',
  'shared-services'  // Different namespace
);
```

## Best Practices

### Use Shared Type Definitions

```typescript
// shared-types/platform.ts
export interface PlatformDatabaseStatus {
  ready: boolean;
  connectionString: string;
  primaryHost: string;
}

// app-service/composition.ts
import { PlatformDatabaseStatus } from '../shared-types/platform.js';

const dbRef = externalRef<any, PlatformDatabaseStatus>(
  'data.platform.company.com/v1', 'Database', 'shared-postgres'
);
```

### Clear Naming Conventions

```typescript
// ✅ Good: Clear, predictable naming
const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
  'data.platform.company.com/v1',
  'Database',
  `${spec.environment}-postgres`,  // environment-service pattern
  `data-${spec.environment}`       // namespace pattern
);
```

## Debugging

```bash
# Check if external resource exists
kubectl get database main-database -o yaml

# Check status
kubectl get database main-database -o jsonpath='{.status}'

# Check RBAC permissions
kubectl auth can-i get database --as=system:serviceaccount:default:typekro
```

## Next Steps

- [Deployment Modes](./deployment-modes.md) - Deployment strategies
