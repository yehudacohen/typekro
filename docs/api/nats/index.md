---
title: NATS and JetStream Factories
description: Official NATS Helm, NACK, Stream, and Consumer factories
---

# NATS and JetStream Factories

TypeKro installs the official NATS Helm chart with persistent JetStream storage, installs the
official NACK controller, and manages Stream and Consumer resources through NACK CRDs.

```ts
import {
  jetStreamConsumer,
  jetStreamStream,
  makeNatsBootstrap,
  natsBootstrap,
} from 'typekro/nats';
```

## Platform installation

```ts
const factory = natsBootstrap.factory('kro', {
  namespace: 'nats-system',
});

await factory.deploy({
  name: 'nats',
  namespace: 'nats-system',
  namespaceOwnership: 'external', // pre-create this Namespace
  replicas: 3,
  storageSize: '100Gi',
  pvcRetentionPolicy: 'retain',
});
```

When TypeKro owns the target Namespace (the default `namespaceOwnership: 'owned'`), it **hoists
that Namespace out of the RGD graph** — emitting it as a retained resource created deps-first —
so the instance can safely live in it without a namespace/finalizer deadlock on delete. With
`namespaceOwnership: 'external'` the Namespace is not owned (you pre-create it) and nothing is
hoisted. Shared platform
installations should be singleton-owned. The bootstrap pins the official `nats` chart and consumes
one cluster-wide NACK controller through TypeKro's singleton owner boundary. Deleting one NATS
installation therefore cannot remove the fixed-name ClusterRole or ClusterRoleBinding used by
another installation.

The shared NACK controller runs in the chart's CRD-connect mode: it has no installation-specific
default NATS URL. Each `Stream`, `Consumer`, or `Account` identifies its NATS system through its
typed connection fields. This is what allows one controller to reconcile resources for multiple
NATS systems without per-installation controller races.

NATS server `values` remain a graph-aware passthrough map merged after safe defaults. Shared NACK
configuration is build-time because every consumer must agree on one concrete singleton spec.
TypeKro applies the singleton's routing and ownership invariants after custom values:
cluster-wide watching, the controller-runtime control loop, write reconciliation, its owned
namespace, and a TypeKro-prefixed release-specific service-account/RBAC identity cannot be
overridden. The prefix keeps every legal controller name disjoint from the v0.33.5
`jetstream-controller` identity. Global
`jetstream.nats` values are rejected because they would disable CRD-connect routing; put the
connection on each typed JetStream resource instead. Other chart customization remains available:

```ts
const productionNats = makeNatsBootstrap({
  controller: {
    version: '0.34.0',
    values: {
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
      },
    },
  },
});
```

Use `nackControllerBootstrap` directly only when explicitly installing, inspecting, or deleting
the singleton owner. Normal applications should consume it through `natsBootstrap`.

### Upgrading installations created by TypeKro v0.33.5

v0.33.5 installed `HelmRelease/nack` inside each NATS workload Namespace. The singleton uses a
different, deterministic service-account and ClusterRole identity, so Helm never has to adopt
resources owned by the old release. Imperative `factory.deploy()` makes the singleton Ready first,
then retires only an exact UID-leased v0.33.5 child whose TypeKro factory, instance, resource ID,
and chart all match. A current NATS server itself named `nack` is recognized by its distinct
`natsHelmRelease` resource identity and is left untouched; every unrelated same-named HelmRelease
fails closed and is never deleted.

KRO and Alchemy preserve the same dependency order: create the singleton before updating the
consumer, then let their normal graph/state pruning remove the retired child. Static direct YAML
cannot perform an ownership-checked live migration; upgrade through `factory.deploy()` or the
original Alchemy state before returning to a render-only workflow.

The former runtime `nackVersion` and `nackValues` fields remain in the generated schema so existing
KRO CRDs can upgrade without a destructive schema transition. They are deprecated compatibility
assertions: when present they must equal the build-time singleton configuration. Move those values
to `makeNatsBootstrap({ controller: ... })`; mismatches fail closed instead of silently changing a
cluster-shared controller from one consumer instance.

JetStream is enabled with file-backed PVC storage. One replica is suitable for development. A
production cluster normally uses three NATS replicas, three stream replicas, fast local storage,
resource limits, authentication, TLS, disruption budgets, monitoring, and tested backup/recovery
procedures.

`pvcRetentionPolicy` configures the StatefulSet's
`persistentVolumeClaimRetentionPolicy`: PVCs are retained across StatefulSet deletion and scaling
by default. It cannot preserve PVCs when their Namespace is deleted. To retain data across deletion
of the complete NATS installation, pre-create the target Namespace and set
`namespaceOwnership: 'external'`; TypeKro then removes the installation but leaves that Namespace
and its retained PVCs intact. With the default `namespaceOwnership: 'owned'`, deleting the complete
installation deletes the Namespace and therefore its PVCs regardless of this StatefulSet setting.
In direct mode, complete owned-Namespace teardown is explicit:
`factory.deleteInstance('nats', { scopes: ['cluster'] })`.

Set `pvcRetentionPolicy: 'delete'` for explicitly ephemeral installations, such as disposable
integration environments. Scaling retains PVCs in both modes.

The bootstrap status distinguishes an explicit Flux failure from an in-progress reconciliation:

```typescript
status: {
  ready: boolean;       // both NATS and NACK HelmReleases report Ready=True
  failed: boolean;      // either HelmRelease reports Ready=False
  phase: 'Ready' | 'Installing' | 'Failed';
  serverVersion: string;
  controllerVersion: string;
  endpoint: string;
}
```

`Installing` includes the interval before either release has reported a definitive `Ready`
condition. The aggregate never reports `Ready` unless both releases are ready.

## Operator mode: accounts and users

`issueNatsOperatorAccounts` issues a NATS operator, its system account, accounts and
per-workload users in TypeScript with the official `@nats-io/jwt` and `@nats-io/nkeys`
libraries, and renders the server configuration for operator (JWT) mode with the memory
resolver. No `nsc` or toolbox container is involved.

```ts
import { generateNatsSeed, issueNatsOperatorAccounts, natsBootstrap } from 'typekro/nats';

// Generate each seed once and keep it in a secret store; `getOrCreateSecrets`
// stands for your store's get-or-create. Never regenerate a seed on redeploy:
// the account's public key is its identity, and JetStream data is stored under it.
const seeds = await getOrCreateSecrets({
  operator: () => generateNatsSeed('operator'),
  system: () => generateNatsSeed('account'),
  orders: () => generateNatsSeed('account'),
  ordersWorker: () => generateNatsSeed('user'),
});

const issued = await issueNatsOperatorAccounts({
  operator: { name: 'platform', seed: seeds.operator },
  systemAccount: { seed: seeds.system }, // named SYS by default
  accounts: [
    {
      name: 'orders',
      seed: seeds.orders,
      subjectPrefix: 'orders',
      limits: {
        fileStorage: '2Gi',
        memoryStorage: '256Mi',
        streams: 32,
        consumers: 256,
        connections: 128,
      },
      users: [{ name: 'worker', seed: seeds.ordersWorker }],
    },
  ],
  issuedAt: new Date('2026-01-01T00:00:00Z'), // fixed: reissue is byte-identical
});

await natsBootstrap.factory('direct', { namespace: 'nats-system' }).deploy({
  name: 'nats',
  namespace: 'nats-system',
  operatorConfig: issued.serverConfig,
});

// Store the issued user's `creds` as a Kubernetes Secret and pass the issued
// `inboxPrefix` to the NATS client as its custom inbox prefix.
```

- **Seeds are inputs.** TypeKro never stores keys. The caller persists each seed once and
  passes it on every issue, so identities stay stable across recreates.
- **Deterministic.** The same seeds, configuration and `issuedAt` produce byte-identical
  JWTs, server configuration and credentials, so reissuing on every deploy causes no drift.
  Keep `issuedAt` fixed; change it only when you intend to reissue.
- **Limits are required.** Every account states its JetStream file and memory storage
  (bytes or a quantity such as `'2Gi'`), streams, consumers and connections. `-1` means
  unlimited and must be written out. While an account has any JetStream storage, `streams`
  and `consumers` must be at least 1, because the server reads 0 there as unlimited. Accounts
  get no leaf node connections and refuse bearer tokens. The system account has no JetStream.
- **Users are confined to a subject prefix.** A user may publish and subscribe to its prefix
  and below it (the account's prefix, or a narrower one below it). For a trusted request/reply
  service, `responses: true` lets NATS grant one dynamic publish to the reply subject supplied
  with an incoming request. The default is `false`.
- **Reply inboxes are per user.** Use the issued user's `inboxPrefix` in the client connection
  options (`inboxPrefix` in NATS.js, `nats.CustomInboxPrefix` in NATS.go). It defaults to
  `_INBOX.<user public key>` and stays stable across reissues from the same seed. For a client
  that requires the standard NATS inbox prefix, explicitly set `inboxPrefix: '_INBOX'` when
  issuing the user. This grants a subscription to every `_INBOX.>` reply in the account.
- **JetStream API permissions are opt-in.** `jetStream` defaults to `false`.
  `jetStream: { streams: ['ORDERS_EVENTS'] }` lets a user manage the named streams and their
  consumers and acknowledge their deliveries. These permissions include changing the subjects
  the named streams capture. Account discovery and list calls require `jetStream: true`, which
  grants the account-wide `$JS.API.>`, `$JS.ACK.>` and `$JS.FC.>` permissions. In NATS.js, pass
  `{ checkAPI: false }` to `jetstreamManager` with a scoped user to skip its account-info probe.
  Use separate accounts for tenant isolation.
- **Secrets stay secret.** `serverConfig` holds only public JWTs and keys. User `creds`
  contain the user's seed and must be stored as a secret. Errors name the offending field,
  never a seed.

`natsBootstrap` takes the rendered fragment as `operatorConfig`, in direct mode and as a KRO
instance field. It becomes the file `operator.conf` in the chart's ConfigMap
(`configMap.merge.data`) and is included by `nats.conf` (`config.merge` with an `$include`
key), and the chart's `podTemplate.configChecksumAnnotation` is turned on so the servers roll
when it changes: nats-server cannot reload into or out of a resolver, so the config reloader
alone would leave a server running without authentication. Without the field nothing is
added. A fragment containing an nkey seed is refused in direct mode and at KRO admission, and
the field is limited to 512 KiB.

### NACK and toolbox credentials

Issue separate users in the account that owns the stream. For the chart configuration below,
give the NACK user and the toolbox user `jetStream: true` and `inboxPrefix: '_INBOX'` so they can
use account-wide management and the standard client inboxes. Put each `.creds` file in an
existing Kubernetes Secret under the key `nats.creds`. Put `orders-nack-creds` in the shared NACK
controller namespace and `orders-toolbox-creds` in the NATS server namespace.

```ts
import { makeNatsBootstrap } from 'typekro/nats';

const ordersNats = makeNatsBootstrap({
  controller: {
    values: {
      additionalVolumes: [{ name: 'orders-creds', secret: { secretName: 'orders-nack-creds' } }],
      additionalVolumeMounts: [
        { name: 'orders-creds', mountPath: '/etc/nats/orders', readOnly: true },
      ],
    },
  },
});

await ordersNats.factory('direct', { namespace: 'nats-system' }).deploy({
  name: 'nats',
  namespace: 'nats-system',
  operatorConfig: issued.serverConfig,
  values: {
    natsBox: {
      contexts: {
        default: { creds: { secretName: 'orders-toolbox-creds', key: 'nats.creds' } },
      },
    },
  },
});

// Pass these connection fields to both jetStreamStream and jetStreamConsumer.
const nackConnection = {
  servers: ['nats://nats.nats-system.svc:4222'],
  creds: '/etc/nats/orders/nats.creds',
};
```

The shared controller still uses CRD-connect mode. To use a NACK `Account` resource, put
the Secret and the `Account` in the Stream and Consumer namespace. Set `spec.creds.secret.name`
to the Secret name, `spec.creds.file` to `nats.creds`, and `spec.servers` to the NATS endpoint.
Reference the `Account` from the Stream and Consumer CRs via `spec.account`.

## Streams and consumers

```ts
const events = jetStreamStream({
  id: 'events',
  name: 'application-events',       // Kubernetes object name
  streamName: 'ORDERS_EVENTS',      // JetStream stream name
  namespace: 'apps',
  subjects: ['orders.events.>'],
  storage: 'file',
  retention: 'limits',
  replicas: 3,
  maxAge: '168h',
  duplicateWindow: '2m',
  preventDelete: true,
  servers: ['nats://nats.nats-system.svc:4222'],
});

const processor = jetStreamConsumer({
  id: 'accountProcessor',
  name: 'account-commands',
  namespace: 'apps',
  streamName: 'ORDERS_EVENTS',
  ackPolicy: 'explicit',
  ackWait: '30s',
  maxDeliver: 10,
  filterSubject: 'orders.events.order-placed.>',
  servers: ['nats://nats.nats-system.svc:4222'],
});
```

NACK owns the declarative Stream/Consumer lifecycle. Applications own message envelopes,
idempotency, command results, retry classification, dead-letter semantics, and safe handler
behavior. JetStream publication is at-least-once; message-ID deduplication is bounded by the
configured duplicate window and does not replace an application inbox.

For other authentication modes, configure the official charts through passthrough values.
Stream and Consumer factories expose `creds`, `nkey`, `servers`, and `jsDomain`; these are paths or
routing settings, never inline credential contents. Because the controller is shared, prefer
per-resource connection fields or NACK `Account` resources over controller-global credentials.
