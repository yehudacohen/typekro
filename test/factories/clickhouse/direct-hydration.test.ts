/**
 * HERMETIC direct-mode status hydration for the migrated status fields (PR #99).
 *
 * The migration's core claim is that normal TypeScript (natural JS template literals over the CHI
 * resource proxy) hydrates to CONCRETE values in direct mode — not just in the cluster-gated integration
 * suite. This test proves that deterministically WITHOUT a cluster by driving the direct factory's
 * `reExecuteWithLiveStatus` seam (the same JS re-execution the deploy pipeline runs against live resource
 * values) with a synthetic live-status map. Template-literal fields must come back as concrete strings; the
 * `clickhouse.status.*`-backed fields hydrate from the supplied map.
 *
 * NOTE ON SCOPE: `reExecuteWithLiveStatus` performs the JS re-execution step only — natural template
 * literals resolve here, while raw `Cel.expr(...)` fields (`clusterName`, `keeper.*`) are preserved as
 * expression objects and are resolved by the SEPARATE cel-js reference resolver later in the deploy
 * pipeline (that resolver evaluates resource-path CEL in direct mode too — proved live for `clusterName`
 * in the integration suite). So this file asserts the template-literal bimodal win; it does not assert the
 * cel-js layer.
 */
import { describe, expect, it } from 'bun:test';

import { makeClickHouseCluster } from '../../../src/factories/clickhouse/index.js';

interface DirectReExec {
  reExecuteWithLiveStatus(
    spec: Record<string, unknown>,
    liveStatusMap: Map<string, Record<string, unknown>>
  ): Record<string, any> | null;
}

describe('clickhouse direct-mode status hydration (hermetic, no cluster)', () => {
  it('hydrates the migrated natural-template-literal fields to concrete strings', () => {
    const factory = makeClickHouseCluster({ users: [{ name: 'app' }] }).factory('direct', {
      namespace: 'ch',
    }) as unknown as DirectReExec;

    const status = factory.reExecuteWithLiveStatus(
      {
        name: 'demo',
        namespace: 'ch',
        version: '25.7',
        storage: { size: '1Gi' },
        users: { app: { passwordSha256Hex: 'abc' } },
      },
      // CHI resource id is `clickhouse` (CHI_RESOURCE_ID); value is its live `.status`.
      new Map([['clickhouse', { status: 'Completed', endpoint: 'demo.ch:9000', hosts: 1, hostsCompleted: 1 }]])
    );

    expect(status).not.toBeNull();

    // The migrated bimodal fields (metadata-anchored template literals) hydrate to CONCRETE strings —
    // the PR #99 win over the old opaque `Cel.expr("...")` markers.
    expect(status!.clickhouse.host).toBe('clickhouse-demo.ch.svc.cluster.local');
    expect(status!.clickhouse.nativeUrl).toBe('clickhouse://clickhouse-demo.ch.svc.cluster.local:9000');
    expect(status!.clickhouse.httpUrl).toBe('http://clickhouse-demo.ch.svc.cluster.local:8123');
    expect(status!.installation.name).toBe('demo');
    expect(status!.installation.namespace).toBe('ch');
    // None of them are leftover CEL markers (objects) — they are plain strings.
    expect(typeof status!.clickhouse.host).toBe('string');
    expect(typeof status!.installation.name).toBe('string');

    // `ready`/`phase` are natural JS comparisons over `clickhouse.status.*`, so they hydrate concretely.
    expect(status!.ready).toBe(true);
    expect(status!.phase).toBe('Ready');

    // `installation.*` status reads hydrate from the supplied live-status map.
    expect(status!.installation.endpoint).toBe('demo.ch:9000');
    expect(status!.installation.hostsCount).toBe(1);
    expect(status!.installation.hostsCompletedCount).toBe(1);
  });

  it('reflects an Installing CHI in the JS-derived phase (not a static constant)', () => {
    const factory = makeClickHouseCluster({ users: [{ name: 'app' }] }).factory('direct', {
      namespace: 'ch',
    }) as unknown as DirectReExec;

    const status = factory.reExecuteWithLiveStatus(
      { name: 'demo', namespace: 'ch', version: '25.7', storage: { size: '1Gi' }, users: { app: { passwordSha256Hex: 'abc' } } },
      new Map([['clickhouse', { status: 'InProgress', endpoint: '', hosts: 0, hostsCompleted: 0 }]])
    );

    expect(status).not.toBeNull();
    expect(status!.ready).toBe(false);
    expect(status!.phase).toBe('Installing');
    // The metadata-anchored URL is still concrete regardless of readiness.
    expect(status!.clickhouse.host).toBe('clickhouse-demo.ch.svc.cluster.local');
  });
});
