---
title: OpenSearch Factories
description: Official OpenSearch Kubernetes operator lifecycle and cluster compositions
---

# OpenSearch Factories

TypeKro wraps the official OpenSearch Kubernetes operator and its
`opensearch.org/v1` `OpenSearchCluster` CRD. The integration does not copy the
operator's StatefulSets or encode an alternate cluster controller.

## Import

```typescript
import {
  makeOpenSearchCluster,
  openSearchCluster,
  openSearchOperatorBootstrap,
} from 'typekro/opensearch';
```

## Operator bootstrap

Install the cluster-scoped operator once. Its Helm repository is singleton
owned, and the operator Namespace and HelmRelease use the `cluster` lifecycle
scope by default.

```typescript
await openSearchOperatorBootstrap.factory('kro', {
  namespace: 'typekro-system',
}).deploy({
  name: 'opensearch-operator',
  namespace: 'opensearch-operator-system',
});
```

The pinned default is the official `opensearch-operator` chart `3.0.2` from
`https://opensearch-project.github.io/opensearch-k8s-operator/`.
Direct and KRO bootstrap status both report the reconciled HelmRelease chart
version alongside `ready`, `failed`, and `phase`.

## Development cluster

```typescript
await openSearchCluster.factory('kro', {
  namespace: 'search-control',
}).deploy({
  name: 'search',
  namespace: 'search-system',
  storage: {
    size: '20Gi',
    storageClassName: 'local-path',
  },
  tls: { source: 'generated' },
});
```

`openSearchCluster` is `makeOpenSearchCluster()` with the upstream minimum of
three cluster-manager-capable nodes, generated TLS, no snapshot repository, and
no NetworkPolicy.

## Production topology

Topology and fields that become Kubernetes path/map keys are fixed at
composition construction. Runtime values remain typed KRO instance fields.

```typescript
const search = makeOpenSearchCluster({
  profile: 'production',
  nodes: 3,
  tls: 'cert-manager',
  snapshots: true,
  snapshotCredentialKeys: {
    accessKey: 'accessKey',
    secretKey: 'secretKey',
  },
  networkPolicy: {
    enabled: true,
    // Defaults to opensearch-operator-system and is admitted separately from
    // application traffic so operator health reconciliation remains live.
    operatorNamespace: 'opensearch-operator-system',
    ingressNamespaceLabels: {
      'kubernetes.io/metadata.name': 'application-system',
    },
    egressCidrs: ['10.0.0.0/8'],
  },
});

await search.factory('kro', {
  namespace: 'search-control',
}).deploy({
  name: 'evidence',
  namespace: 'search-system',
  lifecycle: 'external-retain',
  storage: {
    size: '100Gi',
    storageClassName: 'fast-expandable',
  },
  adminCredentialsSecret: {
    name: 'evidence-admin-credentials',
  },
  dashboardCredentialsSecret: {
    name: 'evidence-dashboards-credentials',
  },
  tls: {
    source: 'cert-manager',
    secretName: 'evidence-http-tls',
    adminSecretName: 'evidence-admin-tls',
    adminDn: ['CN=opensearch-admin'],
    issuerName: 'platform-ca',
    issuerKind: 'ClusterIssuer',
    dnsNames: ['evidence.search.example.com'],
  },
  snapshots: {
    repository: 'snapshots',
    bucket: 'evidence-search',
    endpoint: 'https://s3.example.com',
    credentialsSecret: {
      name: 'snapshot-credentials',
    },
  },
  monitoring: true,
});
```

The operator installs `repository-s3`, maps the declared Secret keys into the
OpenSearch keystore, and registers the S3 repository. Secret values never enter
the `OpenSearchCluster` manifest.

External TLS modes require a non-empty `adminDn` list matching the subject of
the administrator certificate in `adminSecretName`. The production
NetworkPolicy always admits the configured OpenSearch operator Namespace on the
HTTP port in addition to the caller-selected application Namespace labels.

## Lifecycle

Lifecycle is one atomic field so an unsafe namespace/storage combination cannot
be represented:

| Value | Namespace owner | PVC expectation |
| --- | --- | --- |
| `owned-delete` | Cluster instance | Deleted with the instance namespace |
| `external-delete` | External platform | PVC deletion is caller-managed |
| `external-retain` | External platform | Operator-retained PVCs survive cluster deletion |

`external-retain` deliberately does not create the Namespace. StatefulSet PVC
retention cannot survive deletion of an owned Namespace.

Use `factory.deleteInstance()` for cluster and operator teardown. Shared
operator infrastructure requires explicit `scopes: ['cluster']` deletion.

## TLS

- `generated` lets the operator create transport, HTTP, and admin material.
- `secret` consumes externally managed HTTP and admin certificate Secrets.
- `cert-manager` creates the HTTP server Certificate and consumes a separately
  supplied admin client certificate Secret.

External HTTP certificates require `adminSecretName`; the integration does not
silently pretend a server-only certificate is also a privileged client
certificate.

## Credentials

`adminCredentialsSecret` and `dashboardCredentialsSecret` reference existing
Secrets containing `username` and `password`. Supplying both makes credential
ownership explicit and is recommended for production and externally owned
Namespaces.

When omitted, the operator creates `<name>-admin-password` and
`<name>-dashboards-password`. The `credentialsSecret` status field reports the
configured admin Secret or the operator-generated admin Secret name.

## Status

Both direct and KRO factories expose:

```typescript
{
  ready: boolean;
  failed: boolean;
  phase: 'Installing' | 'Ready' | 'Failed';
  endpoint: string;
  credentialsSecret: string;
  version: string;
  availableNodes: number;
  health: string;
  snapshotRepository: string;
}
```

Readiness requires operator initialization, the expected node count, and
OpenSearch health `green` or `yellow`. Any failed component makes the phase
`Failed`.
