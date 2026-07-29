# Hatchet

TypeKro installs the official Hatchet chart as a durable-workflow platform while
keeping database and administrator credentials outside the application CR and
ResourceGraphDefinition.

```ts
import { hatchetInstallation } from 'typekro/hatchet';

const factory = hatchetInstallation.factory('kro', {
  namespace: 'typekro-system',
  waitForReady: true,
  timeout: 20 * 60_000,
});

await factory.deploy({
  name: 'hatchet',
  namespace: 'workflow-system',
  database: {
    connectionSecret: {
      name: 'hatchet-db-app',
    },
  },
  adminCredentialsSecret: {
    name: 'hatchet-admin',
  },
});
```

## What the composition owns

`hatchetInstallation` creates:

- an optional target Namespace;
- an optional repository Namespace when it differs from the target;
- one installation-scoped `<namespace>-<name>-hatchet` HelmRepository and the official
  `hatchet-stack` HelmRelease;
- a non-sensitive metadata ConfigMap used for the complete public status
  contract.

It observes, but does not own:

- the PostgreSQL connection Secret;
- the administrator credential Secret;
- the PostgreSQL database and its backup/recovery infrastructure.

The database provider remains responsible for PostgreSQL availability,
high-availability policy, backups, point-in-time recovery, monitoring, capacity,
and deletion. For CloudNativePG, install the operator and Cluster separately,
then reference the Cluster-generated application Secret. Hatchet requires a
PostgreSQL database configured with UTC timezone.

## Required Secrets

The database Secret contains a complete PostgreSQL URI:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: hatchet-db-app
  namespace: workflow-system
stringData:
  DATABASE_URL: postgres://app:password@hatchet-db-rw:5432/hatchet?sslmode=require
```

The administrator Secret contains the bootstrap account:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: hatchet-admin
  namespace: workflow-system
stringData:
  ADMIN_EMAIL: operator@example.com
  ADMIN_PASSWORD: replace-me
```

The composition appends both Secrets to the official chart's `api.envFrom` and
`engine.envFrom` lists after the chart-generated shared configuration Secret.
This preserves every credential byte without Helm `--set` interpretation and
works with TypeKro's Flux 2.7.5 baseline. The fixed key names are the
environment variables consumed by Hatchet. Secret values never appear in Helm
values, the generated RGD, or the HatchetInstallation instance.

The official chart's `hatchet-admin` command creates `hatchet-client-config`
with `HATCHET_CLIENT_TOKEN` when `workerTokenJob` is enabled. The Secret name is
reported as `status.workerTokenSecret`; the field is empty when
`workerTokenJob` is false.

The chart also creates `hatchet-config` with Hatchet's encryption and signing
keysets. Its name is reported as `status.configurationSecret`. These are
upstream CLI defaults and are intentionally independent of the Helm release
name.

## Operational defaults

The composition pins:

| Component | Default |
| --- | --- |
| Chart | `hatchet-stack` |
| Chart version | `0.13.3` |
| Hatchet server | `v0.94.10` |
| Message queue | PostgreSQL |
| Bundled PostgreSQL | disabled |
| Bundled RabbitMQ | disabled |
| Flux drift detection | enabled |
| Install retries | 3 |
| Upgrade rollback | disabled |

Hatchet upgrades can commit database migrations. TypeKro therefore retries a
failed desired revision but does not automatically roll back to an older chart.
Review Hatchet's migration notes and verify database recovery before upgrading.

User `values` are merged first. TypeKro then reapplies the external-state,
message-queue, version, endpoint, replica, and credential-safety values so
custom chart values cannot silently re-enable bundled state or replace the
declared authority.

## Namespace lifecycle

The target Namespace is owned by default. Set `namespaceOwnership: 'external'`
when another platform composition owns it or when database retention must
survive Hatchet installation deletion.

When the Namespace is external, the official chart leaves
`hatchet-config` and `hatchet-client-config` after uninstall. The configuration
Secret is recovery state for the retained Hatchet database, not an ordinary
disposable chart artifact. Back up and retain it with the database. Delete both
Secrets explicitly only when permanently abandoning that database and its
workers. An owned Namespace deletes them with the installation.

The same rule applies independently to `repositoryNamespaceOwnership`.
The default HelmRepository name includes a length-prefixed workload Namespace
followed by the release name. The length prefix makes the tuple encoding
injective: `team-a`/`worker` cannot collide with `team`/`a-worker`, even when
both installations share a repository Namespace. Set `repositoryName` only
when an explicit platform naming policy is required; explicit names must be
unique within the repository Namespace.

Delete through the factory so TypeKro preserves dependency order:

```ts
await factory.deleteInstance('hatchet');
await factory.dispose();
```

Do not delete the RGD before its instances finish finalizing.

## Status

The complete status contract is available in direct and KRO modes:

```ts
interface HatchetInstallationStatus {
  ready: boolean;
  failed: boolean;
  phase: 'Installing' | 'Ready' | 'Failed';
  chartVersion: string;
  serverVersion: string;
  endpoint: string;
  grpcEndpoint: string;
  configurationSecret: string;
  workerTokenSecret: string;
  dashboardEnabled: boolean;
}
```

`ready` is derived from the current HelmRelease generation. External Secret
existence is a prerequisite; successful Helm readiness is the bounded evidence
that Hatchet integrated with those inputs.

## Direct mode

```ts
const direct = hatchetInstallation.factory('direct', {
  namespace: 'workflow-system',
  waitForReady: true,
  timeout: 20 * 60_000,
});

const result = await direct.deploy({
  name: 'hatchet',
  namespace: 'workflow-system',
  namespaceOwnership: 'external',
  database: {
    connectionSecret: { name: 'hatchet-db-app' },
  },
  adminCredentialsSecret: { name: 'hatchet-admin' },
  replicas: { api: 2, engine: 2, frontend: 2 },
});

console.log(result.status.endpoint);
```

Direct mode expects the observed Secrets to exist before `deploy()`. KRO mode
records them as `externalRef` dependencies and waits for them.
