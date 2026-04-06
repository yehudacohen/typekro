# Resource Scopes & Lifecycle

TypeKro's scope system controls which resources survive instance deletion and enables cross-process cleanup. It replaces the older binary `lifecycle: 'shared'` flag with a flexible, multi-scope model.

## The Problem

A typical TypeKro composition deploys a mix of:

- **Instance-private resources** — the app's Deployment, Service, database Cluster. These belong exclusively to one deployment and should be deleted when the instance is torn down.
- **Shared infrastructure** — the CNPG operator, the Valkey operator, Flux HelmRepositories. These are cluster-wide singletons shared across many consumers and should survive any individual instance deletion.

Without scopes, `factory.deleteInstance('my-app')` would either delete everything (breaking other consumers of the operator) or require manual tracking of what's shared.

## How Scopes Work

Every resource can optionally belong to one or more **scopes** — string tags that describe its lifecycle boundary. Scopes are set in compositions via `setMetadataField` and are persisted as Kubernetes annotations on the live resource.

```typescript
import { setMetadataField } from 'typekro';

// Tag as cluster-wide shared infrastructure
setMetadataField(operatorRelease, 'scopes', ['cluster']);

// Tag as team-shared (e.g., monitoring stack)
setMetadataField(grafanaDashboard, 'scopes', ['team:platform']);

// No scope = instance-private (default)
// setMetadataField not needed — resources are instance-private by default
```

### Delete Behavior

| Resource scopes | `deleteInstance(name)` | `deleteInstance(name, { scopes: ['cluster'] })` |
|---|---|---|
| `[]` (instance-private) | **Deleted** | **Deleted** |
| `['cluster']` | **Preserved** | **Deleted** |
| `['team:platform']` | **Preserved** | **Preserved** |
| `['cluster', 'team:platform']` | **Preserved** | **Deleted** (any match) |

The rule is simple:
- **Instance-private** resources (no scopes) are always deleted
- **Scoped** resources are deleted only when the caller explicitly targets at least one of their scopes

This means `factory.deleteInstance('my-app')` is always safe — it can never accidentally tear down shared infrastructure.

### Deploy Behavior

You can also target scopes at deploy time to deploy only a subset of the resource graph:

```typescript
// Deploy only cluster-scoped resources (install operators first)
await factory.deploy(spec, { targetScopes: ['cluster'] });

// Deploy only instance-private resources (operators already running)
await factory.deploy(spec, { targetScopes: [] });

// Deploy everything (default)
await factory.deploy(spec);
```

When `targetScopes` is `undefined` (the default), all resources deploy. When set, only matching resources deploy — others are silently skipped.

## Built-in Scope: `'cluster'`

TypeKro's bootstrap compositions use the `'cluster'` scope by default for operator installs:

```typescript
// In cnpg-bootstrap.ts (simplified)
const isShared = spec.shared !== false; // default: true

if (isShared) {
  setMetadataField(operatorNamespace, 'scopes', ['cluster']);
  setMetadataField(helmRepository, 'scopes', ['cluster']);
  setMetadataField(helmRelease, 'scopes', ['cluster']);
}
```

This means:
- Multiple `webAppWithProcessing` deployments converge on one CNPG operator install
- `deleteInstance` on any one consumer leaves the operator running
- To remove the operator: `deleteInstance(name, { scopes: ['cluster'] })`
- To opt out of sharing: `{ shared: false }` in the bootstrap config gives you a dedicated operator

## Cross-Process Cleanup

TypeKro stamps every deployed resource with ownership labels and annotations:

**Labels** (selector-queryable):
- `typekro.io/managed-by=typekro`
- `typekro.io/factory-name=<name>`
- `typekro.io/instance-name=<name>`

**Annotations** (state data):
- `typekro.io/deployment-id` — groups resources from a single deploy
- `typekro.io/resource-id` — composition-local identifier
- `typekro.io/scopes` — JSON array of scope names
- `typekro.io/depends-on` — JSON array of dependency ids

This means `factory.deleteInstance('my-app')` works even from a **completely different process** than the one that deployed — the factory discovers resources by label selector, reconstructs the dependency graph from annotations, and performs reverse-topological deletion. No shared database, no ConfigMap state backend. The cluster IS the state.

```typescript
// Process A: deploy
const factory = webapp.factory('direct', { namespace: 'prod' });
await factory.deploy({ name: 'my-app', ... });
// Process A exits

// Process B (hours later): clean up
const factory = webapp.factory('direct', { namespace: 'prod' });
await factory.deleteInstance('my-app');
// Works! Resources discovered by labels, graph rebuilt from annotations
```

## Scope Naming Conventions

Scope names are free-form strings. We recommend these conventions:

| Scope | Meaning | Example |
|---|---|---|
| `'cluster'` | Cluster-wide singleton (operators, CRDs) | CNPG operator, Valkey operator |
| `'team:<name>'` | Shared within a team | Team monitoring stack |
| `'tenant:<name>'` | Shared within a tenant | Multi-tenant infra |
| `'env:<name>'` | Shared within an environment | Staging-specific certs |

Resources can belong to multiple scopes. A resource is deleted if **any** of its scopes matches the caller's filter.

## Migration from `lifecycle: 'shared'`

The older `lifecycle: 'shared'` mechanism continues to work as an alias. Resources with `lifecycle: 'shared'` are treated as having `scopes: ['shared']`. The scope name `'shared'` behaves the same as any other scope — it protects the resource from default deletion and requires explicit targeting.

```typescript
// Old way (still works)
setMetadataField(resource, 'lifecycle', 'shared');

// New way (recommended)
setMetadataField(resource, 'scopes', ['cluster']);
```

The new API is more expressive: you can have multiple named scopes, target specific scopes for deploy/delete, and use any naming convention.

## KRO Mode Limitations

Scope-targeted deployment and deletion are currently supported in **direct mode** only. In KRO mode, passing `scopes` or `targetScopes` throws a `TypeKroError` with code `UNSUPPORTED_OPTION`. KRO mode uses the Kro controller's own lifecycle management for resource deletion.
