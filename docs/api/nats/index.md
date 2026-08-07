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

## Streams and consumers

```ts
const events = jetStreamStream({
  id: 'events',
  name: 'application-events',       // Kubernetes object name
  streamName: 'APPLIK8S_EVENTS',    // JetStream stream name
  namespace: 'apps',
  subjects: ['applik8s.events.>'],
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
  streamName: 'APPLIK8S_EVENTS',
  ackPolicy: 'explicit',
  ackWait: '30s',
  maxDeliver: 10,
  filterSubject: 'applik8s.events.account-changed.>',
  servers: ['nats://nats.nats-system.svc:4222'],
});
```

NACK owns the declarative Stream/Consumer lifecycle. Applications own message envelopes,
idempotency, command results, retry classification, dead-letter semantics, and safe handler
behavior. JetStream publication is at-least-once; message-ID deduplication is bounded by the
configured duplicate window and does not replace an application inbox.

For authenticated installations, configure the official charts through passthrough values.
Stream and Consumer factories expose `creds`, `nkey`, `servers`, and `jsDomain`; these are paths or
routing settings, never inline credential contents. Because the controller is shared, prefer
per-resource connection fields or NACK `Account` resources over controller-global credentials.
