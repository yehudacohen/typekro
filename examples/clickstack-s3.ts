/**
 * S3-backed ClickStack Example
 *
 * Object storage is the durable record; the ClickHouse node keeps only a
 * bounded local cache. A lost node or namespace is a rebuild, not data loss,
 * and retention can be long without paying for EBS.
 *
 * Three pieces, in dependency order:
 * 1. the Altinity clickhouse-operator (once per cluster),
 * 2. a `makeClickHouseCluster` whose storage is S3-backed, and
 * 3. `clickstackBootstrap` wired at that cluster's status contract.
 *
 * The storage POLICY needs no ClickStack-side DDL: the ClickHouse factory sets
 * `merge_tree/storage_policy` as the server default, so the gateway
 * collector's goose migrations create `otel_logs` / `otel_traces` /
 * `otel_metrics_*` on object storage by themselves.
 */

import {
  clickhouseOperatorBootstrap,
  makeClickHouseCluster,
} from '../src/factories/clickhouse/index.js';
import { makeClickstackBootstrap } from '../src/factories/clickstack/index.js';

const NAMESPACE = 'observability';
const BUCKET = 'example-observability';

// ─── 1. The operator (cluster-scoped; install exactly one) ──────────────────

const operator = clickhouseOperatorBootstrap.factory('kro', { namespace: 'typekro-system' });

// ─── 2. S3-backed ClickHouse ────────────────────────────────────────────────
//
// BUILD-TIME: bucket/region/credentials/disk type compile into the CHI's
// `storage_configuration` XML and select which resources exist (the IRSA
// ServiceAccount here). Only the thin local volume sizing is runtime spec.
//
// `s3_plain_rewritable` keeps part METADATA in the bucket, so the bucket is
// self-describing and node loss is a restart + reattach with no restore step.
// The trade: single replica, no mutations, ClickHouse >= 24.5. Use
// `diskType: 's3'` plus `backup` when you need replication or mutations.
const clickhouse = makeClickHouseCluster({
  users: [{ name: 'otelcollector' }],
  storage: {
    mode: 's3',
    diskType: 's3_plain_rewritable',
    bucket: BUCKET,
    prefix: 'clickhouse',
    region: 'us-east-2',
    // Sized for the working set, not the dataset — it must fit inside
    // `storage.size` below, which is the volume that hosts it.
    cache: { size: '50Gi' },
    auth: { irsa: { roleArn: `arn:aws:iam::123456789012:role/${NAMESPACE}-clickhouse-s3` } },
  },
});

// ─── 3. ClickStack on top ───────────────────────────────────────────────────

const clickstack = makeClickstackBootstrap({
  mongo: { mode: 'internal', storage: { storageClassName: 'gp3-expandable' } },
  storage: {
    mode: 's3',
    diskType: 's3_plain_rewritable',
    // TTL is the one thing the server-default policy cannot express.
    retention: { logs: '30d', traces: '7d', metrics: '90d' },
    // A ClickHouse restart during a node rebuild must not drop telemetry.
    // Read the persistent-queue caveat in docs/api/clickstack/index.md first.
    persistentQueue: { enabled: true, size: '10Gi' },
  },
});

// ─── Deploy ─────────────────────────────────────────────────────────────────

export async function deploy(): Promise<void> {
  await operator.deploy({ name: 'clickhouse-operator', namespace: 'clickhouse-system' });

  const cluster = await clickhouse.factory('kro', { namespace: NAMESPACE }).deploy({
    name: 'observability',
    namespace: NAMESPACE,
    // >= 24.5 for the plain_rewritable metadata type; the factory rejects
    // anything older at construction time rather than at reconcile.
    version: '25.12.5',
    // The LOCAL volume: server metadata + the read-through cache.
    storage: { size: '100Gi', storageClassName: 'gp3-expandable' },
    users: { otelcollector: { passwordSha256Hex: process.env.CLICKHOUSE_PASSWORD_SHA256 ?? '' } },
  });

  console.log('storage mode:', cluster.status.storage.mode);
  console.log('bucket is self-describing:', cluster.status.storage.selfDescribingBucket);

  const stack = await clickstack.factory('kro', { namespace: NAMESPACE }).deploy({
    name: 'clickstack',
    namespace: NAMESPACE,
    clickhouse: {
      // Wired from the typed status contract — never a hand-built hostname.
      host: cluster.status.clickhouse.host,
      username: 'otelcollector',
      password: process.env.CLICKHOUSE_PASSWORD ?? '',
    },
    apiKey: process.env.HYPERDX_API_KEY ?? '',
  });

  console.log('send OTLP to:', stack.status.gateway.otlpHttpEndpoint);
  console.log('telemetry lands on:', stack.status.storage.diskType);
}
