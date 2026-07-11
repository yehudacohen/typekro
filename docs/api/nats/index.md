---
title: NATS and JetStream Factories
description: Official NATS Helm, NACK, Stream, and Consumer factories
---

# NATS and JetStream Factories

TypeKro installs the official NATS Helm chart with persistent JetStream storage, installs the
official NACK controller, and manages Stream and Consumer resources through NACK CRDs.

```ts
import { jetStreamConsumer, jetStreamStream, natsBootstrap } from 'typekro/nats';
```

## Platform installation

```ts
const factory = natsBootstrap.factory('kro', {
  namespace: 'typekro-system', // KRO control-plane namespace
});

await factory.deploy({
  name: 'nats',
  namespace: 'nats-system',   // owned NATS/NACK namespace
  replicas: 3,
  storageSize: '100Gi',
});
```

The control-plane and owned namespaces must differ in KRO mode. TypeKro rejects an instance that
lives in the Namespace its graph owns, preventing namespace/finalizer deadlock. Shared platform
installations should be singleton-owned. The bootstrap pins the official `nats` and `nack` charts;
`values` and `nackValues` are graph-aware passthrough maps merged after safe defaults.

JetStream is enabled with file-backed PVC storage. One replica is suitable for development. A
production cluster normally uses three NATS replicas, three stream replicas, fast local storage,
resource limits, authentication, TLS, disruption budgets, monitoring, and tested backup/recovery
procedures.

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

For authenticated installations, configure the official charts through passthrough values and
mount credentials into NACK. Stream and Consumer factories expose `creds`, `nkey`, `servers`, and
`jsDomain`; these are paths or routing settings, never inline credential contents.
