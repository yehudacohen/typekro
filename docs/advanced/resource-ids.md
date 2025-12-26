# Resource IDs

Resource IDs enable cross-resource references in TypeKro compositions.

## When is `id` Required?

| Scenario | `id` Required? | Example |
|----------|----------------|---------|
| Reference resource in status expressions | ✅ Yes | `deploy.status.readyReplicas > 0` |
| Reference resource from another resource | ✅ Yes | `env: { DB_HOST: service.status.clusterIP }` |
| Standalone resource with no references | ❌ Optional | ConfigMap with static data |

**Rule of thumb:** If you access `.status` or `.metadata` on a resource, it needs an `id`.

## `id` vs `name`

These serve different purposes:

| | `id` | `name` |
|---|------|--------|
| **Purpose** | CEL path generation | Kubernetes resource name |
| **Where it appears** | TypeKro only | `metadata.name` in YAML |
| **Must be unique in** | Composition | Kubernetes namespace |
| **Format** | camelCase recommended | DNS-compatible (lowercase, hyphens) |

```typescript
const deploy = Deployment({
  id: 'webApp',           // → CEL path: ${webApp.status.readyReplicas}
  name: 'web-app',        // → metadata.name: web-app
  image: 'nginx'
});
```

## Why IDs Are Required

The `id` parameter maps resources to CEL expression paths. When you reference a resource's status or metadata, TypeKro uses the ID to generate the correct CEL expression:

```typescript
import { Deployment } from 'typekro/simple';

const deploy = Deployment({
  id: 'webApp',  // ← This becomes the CEL path prefix
  name: 'my-app',
  image: 'nginx'
});

// Reference in status builder:
return {
  ready: deploy.status.readyReplicas > 0
  // Generates: ${webApp.status.readyReplicas > 0}
};
```

Without an ID, TypeKro can't generate the CEL path for runtime evaluation.

## How IDs Map to CEL

| TypeScript Reference | Generated CEL |
|---------------------|---------------|
| `deploy.status.readyReplicas` | `${webApp.status.readyReplicas}` |
| `deploy.metadata.name` | `${webApp.metadata.name}` |
| `svc.spec.clusterIP` | `${service.spec.clusterIP}` |
| `db.status.ready` | `${database.status.ready}` |

The ID becomes the resource identifier in the CEL expression path.

## Naming Conventions

Use descriptive, camelCase IDs that reflect the resource's purpose:

```typescript
import { Deployment } from 'typekro/simple';

// ✅ Good - descriptive and camelCase
const deploy = Deployment({ id: 'webApp', ... });
const db = Deployment({ id: 'database', ... });
const cache = Deployment({ id: 'redisCache', ... });
const api = Deployment({ id: 'apiServer', ... });

// ❌ Avoid - not descriptive
const deploy = Deployment({ id: 'dep1', ... });
const db = Deployment({ id: 'd', ... });

// ❌ Avoid - hyphens (use camelCase)
const db = Deployment({ id: 'my-database', ... });

// ❌ Avoid - underscores (use camelCase)
const cache = Deployment({ id: 'redis_cache', ... });
```

Best practices:
- Use camelCase: `webApp`, `apiServer`, `redisCache`
- Be descriptive: `database` not `db`, `webFrontend` not `fe`
- Match the resource's role: `primaryDb`, `replicaDb`
- Keep IDs unique within a composition

## Missing IDs

Without an `id`, resources can't be referenced in status expressions:

```typescript
import { Deployment } from 'typekro/simple';

// ❌ No id - can't reference this resource
const deploy = Deployment({
  name: 'my-app',
  image: 'nginx'
  // Missing: id: 'webApp'
});

// This won't work - no CEL path available
return { ready: deploy.status.readyReplicas > 0 };
// Error: Resource has no id for CEL path generation
```

Always add an `id` when you need to:
- Reference the resource in status expressions
- Reference the resource from other resources (cross-references)
- Track the resource in the dependency graph

## Duplicate IDs

Duplicate IDs cause conflicts and undefined behavior:

```typescript
import { Deployment } from 'typekro/simple';

// ❌ Duplicate IDs - which 'app' does the CEL reference?
const frontend = Deployment({ id: 'app', name: 'frontend', ... });
const backend = Deployment({ id: 'app', name: 'backend', ... });

return {
  ready: app.status.readyReplicas > 0  // Ambiguous!
};
```

Use unique IDs for each resource:

```typescript
import { Deployment } from 'typekro/simple';

// ✅ Unique IDs - clear references
const frontend = Deployment({ id: 'frontend', name: 'frontend', ... });
const backend = Deployment({ id: 'backend', name: 'backend', ... });

return {
  frontendReady: frontend.status.readyReplicas > 0,
  backendReady: backend.status.readyReplicas > 0
};
```

## Multi-Resource Example

A complete example showing proper ID usage across multiple resources:

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const fullStack = kubernetesComposition({
  name: 'full-stack',
  apiVersion: 'example.com/v1',
  kind: 'FullStack',
  spec: type({ name: 'string', dbPassword: 'string' }),
  status: type({
    dbReady: 'boolean',
    apiReady: 'boolean',
    webReady: 'boolean',
    allReady: 'boolean'
  })
}, (spec) => {
  // Database layer
  const db = Deployment({
    id: 'database',  // Used in: apiServer env, status
    name: `${spec.name}-db`,
    image: 'postgres:15',
    env: { POSTGRES_PASSWORD: spec.dbPassword }
  });

  const dbService = Service({
    id: 'databaseService',  // Used in: apiServer env
    name: `${spec.name}-db`,
    selector: { app: `${spec.name}-db` },
    ports: [{ port: 5432 }]
  });

  // API layer - references database
  const api = Deployment({
    id: 'apiServer',  // Used in: webFrontend env, status
    name: `${spec.name}-api`,
    image: 'node:20',
    env: {
      DB_HOST: dbService.metadata.name,  // Cross-reference
      DB_PASSWORD: spec.dbPassword
    }
  });

  const apiService = Service({
    id: 'apiService',  // Used in: webFrontend env
    name: `${spec.name}-api`,
    selector: { app: `${spec.name}-api` },
    ports: [{ port: 3000 }]
  });

  // Web layer - references API
  const web = Deployment({
    id: 'webFrontend',  // Used in: status
    name: `${spec.name}-web`,
    image: 'nginx',
    env: {
      API_URL: `http://${apiService.metadata.name}:3000`  // Cross-reference
    }
  });

  // Status expressions reference all resources by ID
  return {
    dbReady: db.status.readyReplicas > 0,
    apiReady: api.status.readyReplicas > 0,
    webReady: web.status.readyReplicas > 0,
    allReady: db.status.readyReplicas > 0 && 
              api.status.readyReplicas > 0 && 
              web.status.readyReplicas > 0
  };
});
```

Generated CEL expressions:
- `${database.status.readyReplicas > 0}`
- `${apiServer.status.readyReplicas > 0}`
- `${webFrontend.status.readyReplicas > 0}`
- `${database.status.readyReplicas > 0 && apiServer.status.readyReplicas > 0 && webFrontend.status.readyReplicas > 0}`

## When IDs Are Optional

IDs are optional when you don't reference the resource anywhere:

```typescript
import { ConfigMap, Secret } from 'typekro/simple';

// ✅ No id needed - not referenced in status or other resources
ConfigMap({
  name: 'static-config',
  data: { key: 'value' }
});

// ✅ No id needed - standalone Secret
Secret({
  name: 'api-key',
  stringData: { token: 'secret123' }
});
```

**When to add `id` anyway:**
- Debugging and traceability (easier to identify resources in logs)
- Future-proofing (you might need references later)
- Consistent code style across your compositions

```typescript
// ✅ Good practice: always include id for consistency
ConfigMap({
  id: 'config',  // Optional but recommended
  name: 'static-config',
  data: { key: 'value' }
});
```

## Next Steps

- [Cross-Resource References](/guide/external-references) - Reference patterns
- [JavaScript to CEL](/guide/javascript-to-cel) - Expression conversion
- [Troubleshooting](/guide/troubleshooting) - Debug ID issues
- [Magic Proxy](/guide/magic-proxy) - How references work
