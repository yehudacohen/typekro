# Aspects

Aspects let you apply cross-cutting changes to rendered resources without pushing those concerns into every composition.

Use aspects for environment overlays, organizational metadata, local-development wiring, and workload defaults that should stay separate from the app's core resource model.

## When to Use Aspects

Use aspects when the change is orthogonal to the composition:

- Add team, cost-center, or GitOps labels to every resource
- Add annotations required by policy or observability tooling
- Set local-development env vars, workspace mounts, or hot-reload containers
- Set workload defaults such as `imagePullPolicy`, resource requirements, or service accounts

Keep the composition responsible for the resources the app needs. Use aspects for deployment-context concerns.

## Basic Usage

Pass aspects when rendering YAML or creating a factory:

```typescript
import { withEnvVars, withLabels } from 'typekro/aspects';

const aspects = [
  withLabels({ team: 'platform' }),
  withEnvVars({ LOG_LEVEL: 'debug' }).where({ id: 'api' }).expectOne(),
];

const factory = app.factory('direct', {
  namespace: 'dev',
  aspects,
});

await factory.deploy({ name: 'api', image: 'nginx:latest' });
```

Convenience helpers such as `withLabels(...)` and `withEnvVars(...)` return normal aspect definitions, so they are chainable with `.where(...)`, `.optional()`, and `.expectOne()`.

## Selectors

Selectors narrow which matched resources receive an aspect. Selector fields use AND semantics.

```typescript
withLabels({ tier: 'backend' }).where({
  kind: 'Deployment',
  labels: { app: 'api' },
});
```

Supported selector fields are `slot`, `id`, `name`, `namespace`, `kind`, and `labels`.

By default, an aspect must match one or more resources. Use `.optional()` when zero matches are allowed, or `.expectOne()` when exactly one match is required.

## Slots

Use `slot(...)` when the Kubernetes name or labels are dynamic but the composition has a stable semantic role.

```typescript
import { simple, slot } from 'typekro';
import { withEnvVars } from 'typekro/aspects';

const api = slot(
  'api',
  simple.Deployment({ id: 'api', name: spec.name, image: spec.image })
);

const devAspect = withEnvVars({ LOG_LEVEL: 'debug' }).where({ slot: 'api' }).expectOne();
```

Slots are metadata for aspect matching only; they do not change the Kubernetes manifest.

## Direct and Kro Modes

The same aspects can be passed to direct and Kro factories:

```typescript
const aspects = [withLabels({ managedBy: 'typekro' })];

app.factory('direct', { namespace: 'dev', aspects });
app.factory('kro', { namespace: 'prod', aspects });
```

Kro mode is stricter for composite mutations. TypeKro rejects unsafe `merge(...)` and `append(...)` operations when the current field or payload contains Kubernetes references or CEL expressions.

## Convenience Helpers

Most use cases should start with the `withX(...)` helpers:

```typescript
import {
  withAnnotations,
  withEnvVars,
  withHotReload,
  withImagePullPolicy,
  withLabels,
  withReplicas,
} from 'typekro/aspects';

const devAspects = [
  withLabels({ env: 'dev' }),
  withAnnotations({ owner: 'platform' }),
  withImagePullPolicy('Always').where({ kind: 'Deployment' }),
  withReplicas(1).where({ slot: 'api' }),
  withEnvVars({ NODE_ENV: 'development' }),
  withHotReload({ containers: [{ name: 'api', image: 'oven/bun:1.3.13' }] }),
];
```

Use lower-level `aspect.on(...)`, `metadata(...)`, and `override(...)` when you need a typed override not covered by a convenience helper.

## Next Steps

- [Aspects API Reference](/api/aspects) - Complete aspect helpers and primitives
- [Deployment Modes](/guide/deployment-modes) - How direct and Kro rendering differ
- [Resource IDs](/advanced/resource-ids) - Stable IDs for selector targeting
