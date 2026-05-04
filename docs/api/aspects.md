# Aspects API

Typed resource aspects apply validated metadata and spec overrides to resources at render or factory time.

Import from the dedicated subpath for aspect-heavy code:

```typescript
import { aspect, allResources, metadata, merge, withLabels } from 'typekro/aspects';
```

The same APIs are also exported from `typekro`.

## Render and Factory Options

Pass aspects to `toYaml(...)` or factory options:

```typescript
import { withLabels } from 'typekro/aspects';

const aspects = [withLabels({ team: 'platform' })];

app.toYaml({ aspects });
app.factory('direct', { namespace: 'dev', aspects });
app.factory('kro', { namespace: 'prod', aspects });
```

## Convenience Helpers

Convenience helpers return chainable aspect definitions.

### Metadata

```typescript
withLabels({ team: 'platform' });
withAnnotations({ owner: 'platform' });
withMetadata({
  labels: { app: 'api' },
  annotations: { owner: 'platform' },
});
```

### Workloads

Workload helpers target workload pod templates.

```typescript
withReplicas(1).where({ slot: 'api' });
withEnvVars({ NODE_ENV: 'development' });
withEnvFrom([{ secretRef: { name: 'api-secret' } }]);
withImagePullPolicy('Always').where({ kind: 'Deployment' });
withServiceAccount('api-runner');
withResourceDefaults({
  requests: { cpu: '100m', memory: '128Mi' },
  limits: { cpu: '500m', memory: '512Mi' },
});
```

### Development

```typescript
withLocalWorkspace({
  workspacePath: '/Users/me/workspace/app',
  mountPath: '/workspace',
});

withHotReload({
  replicas: 1,
  labels: { 'typekro.dev/hot-reload': 'true' },
  containers: [{ name: 'api', image: 'oven/bun:1.3.13' }],
  volumes: [{ name: 'workspace', hostPath: { path: '/workspace', type: 'Directory' } }],
});
```

## Chainable Definition Methods

All aspect definitions support:

| Method | Meaning |
|--------|---------|
| `.where(selector)` | Narrow matching resources |
| `.optional()` | Allow zero matches |
| `.expectOne()` | Require exactly one match |

```typescript
withEnvVars({ LOG_LEVEL: 'debug' })
  .where({ slot: 'api' })
  .expectOne();
```

Supported selector fields are `slot`, `id`, `name`, `namespace`, `kind`, and `labels`.

## Low-Level Primitives

Use primitives when a convenience helper is not specific enough.

```typescript
import { allResources, aspect, merge, metadata } from 'typekro/aspects';

aspect
  .on(allResources, metadata({ labels: merge({ team: 'platform' }) }))
  .where({ namespace: 'prod' });
```

For typed spec overrides, target a specific factory or target group:

```typescript
import { aspect, override, replace, simple } from 'typekro';

aspect.on(
  simple.Deployment,
  override({
    spec: {
      replicas: replace(3),
    },
  })
);
```

## Targets

| Target | Surface | Use case |
|--------|---------|----------|
| `allResources` | `metadata(...)` | Labels and annotations on every rendered resource |
| `resources` | `override(...)` | Broad spec overrides on schema-capable resources |
| `workloads` | `override(...)` | Workload pod-template helpers |
| Factory target | `metadata(...)` or `override(...)` | Kind-specific typed targeting, such as `simple.Deployment` |

Factory targets match by produced Kubernetes kind. For example, a `simple.Deployment` aspect can also match custom Deployment factories that advertise the same TypeKro aspect metadata.

## Operations

| Operation | Field type | Behavior |
|-----------|------------|----------|
| `replace(value)` | scalar, object, or array | Replace the selected field |
| `merge(object)` | object | Merge keys into an object field |
| `append(array)` | array | Append entries to an array field |

Kro mode rejects unsafe `merge(...)` and `append(...)` operations when either the current field or operation payload contains Kubernetes references or CEL expressions.

## Hot Reload Surface

`hotReload(...)` returns an override surface rather than a complete aspect. Use it when you want to choose the target explicitly:

```typescript
import { aspect, hotReload, simple } from 'typekro';

aspect
  .on(
    simple.Deployment,
    hotReload({ containers: [{ name: 'api', image: 'oven/bun:1.3.13' }] })
  )
  .where({ id: 'api' })
  .expectOne();
```

Use `withHotReload(...)` when workload-wide targeting is sufficient.

## Errors

`AspectDefinitionError` is thrown before resources are mutated when an aspect definition is invalid.

`AspectApplicationError` is thrown during application when a definition matches resources but cannot be safely applied, such as selector cardinality mismatches, unsupported writable fields, or Kro safety violations.

## Next Steps

- [Aspects Guide](/guide/aspects) - Conceptual overview and recommended patterns
- [Import Patterns](/api/imports) - All TypeKro import paths
- [kubernetesComposition](/api/kubernetes-composition) - Composition API reference
