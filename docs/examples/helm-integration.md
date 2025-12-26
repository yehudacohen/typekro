# Helm Integration

HelmRelease with type-safe values.

::: warning Flux CD Required
HelmRelease requires Flux CD installed in your cluster. See [Runtime Bootstrap](/api/kro/compositions/runtime) for setup, or install Flux manually:

```bash
flux bootstrap github --owner=<org> --repository=<repo> --path=clusters/my-cluster
```
:::

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition, helmRelease } from 'typekro';
import { Secret } from 'typekro/simple';

const DatabaseSpec = type({
  name: 'string',
  size: 'string',
  password: 'string',
  replicas: 'number'
});

const DatabaseStatus = type({
  ready: 'boolean',
  phase: '"Pending" | "Installing" | "Ready" | "Failed"'
});

export const database = kubernetesComposition({
  name: 'database',
  apiVersion: 'data.example.com/v1alpha1',
  kind: 'Database',
  spec: DatabaseSpec,
  status: DatabaseStatus,
}, (spec) => {
  const dbSecret = Secret({
    id: 'dbSecret',
    name: `${spec.name}-secret`,
    stringData: { 'postgres-password': spec.password }
  });

  const postgres = helmRelease({
    id: 'postgres',
    name: spec.name,
    namespace: 'databases',
    chart: {
      repository: 'https://charts.bitnami.com/bitnami',
      name: 'postgresql',
      version: '12.1.9'
    },
    values: {
      auth: { 
        existingSecret: dbSecret.metadata.name, 
        database: spec.name 
      },
      primary: { 
        persistence: { size: spec.size } 
      },
      readReplicas: { 
        replicaCount: spec.replicas - 1  // ✨ JavaScript expression
      }
    }
  });

  return {
    ready: postgres.status.conditions?.[0]?.status === 'True',
    phase: postgres.status.conditions?.[0]?.status === 'True' ? 'Ready' : 'Installing'
  };
});
```

## Deploy

```typescript
const factory = database.factory('direct', { namespace: 'databases' });
await factory.deploy({ name: 'mydb', size: '10Gi', password: 'secret', replicas: 3 });
```

## Key Concepts

- **Type-safe Helm values**: Schema references work in chart values
- **Cross-resource references**: `dbSecret.metadata.name` references the secret
- **HelmRelease status**: Access `postgres.status.conditions` for readiness
- **Flux CD compatible**: Uses HelmRelease CRD for GitOps workflows

## Next Steps

- [Multi-Environment](./multi-environment.md) - Environment-specific Helm values
- [Custom CRDs](./custom-crd.md) - Create factories for any CRD
- [Runtime Bootstrap](/api/kro/compositions/runtime) - Install Flux and Kro
