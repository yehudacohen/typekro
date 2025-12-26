# Configuration API

Factory functions for ConfigMaps and Secrets.

## Quick Reference

| Factory | Description |
|---------|-------------|
| `ConfigMap()` | Non-sensitive configuration data |
| `Secret()` | Sensitive data (passwords, keys, certificates) |

## ConfigMap()

```typescript
import { ConfigMap } from 'typekro/simple';

const config = ConfigMap({
  id: 'config',
  name: 'app-config',
  data: {
    LOG_LEVEL: 'info',
    API_URL: spec.apiUrl  // Schema references work
  }
});
```

### Parameters

```typescript
interface SimpleConfigMapConfig {
  id: string;
  name: string;
  namespace?: string;
  data: Record<string, string | RefOrValue<string>>;
}
```

## Secret()

```typescript
import { Secret } from 'typekro/simple';

const secret = Secret({
  id: 'dbSecret',
  name: 'db-credentials',
  stringData: {
    username: spec.dbUser,
    password: spec.dbPassword
  }
});
```

### Parameters

```typescript
interface SimpleSecretConfig {
  id: string;
  name: string;
  namespace?: string;
  data?: Record<string, string>;       // Base64 encoded
  stringData?: Record<string, string>; // Plain text (auto-encoded)
  type?: string;                       // e.g., 'kubernetes.io/tls'
}
```

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, ConfigMap, Secret } from 'typekro/simple';

const app = kubernetesComposition({
  name: 'configured-app',
  apiVersion: 'example.com/v1',
  kind: 'ConfiguredApp',
  spec: type({ name: 'string', dbPassword: 'string' }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  ConfigMap({
    id: 'config',
    name: `${spec.name}-config`,
    data: { LOG_LEVEL: 'info' }
  });

  Secret({
    id: 'secret',
    name: `${spec.name}-secret`,
    stringData: { DB_PASSWORD: spec.dbPassword }
  });

  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: 'myapp:latest'
  });

  return { ready: deploy.status.readyReplicas > 0 };
});
```

## Best Practices

1. **Use Secrets for sensitive data** - Never put passwords in ConfigMaps
2. **Use `stringData`** - Easier than base64-encoding `data`
3. **Reference by name** - Use `secret.metadata.name` for volume mounts

## Next Steps

- [Workloads](./workloads.md) - Using config in deployments
- [Storage](./storage.md) - Persistent storage

