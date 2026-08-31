/**
 * HERMETIC FINAL-PIPELINE resolution for the raw-`Cel.expr` status fields (PR #99).
 *
 * The direct-hydration tests cover the JS re-execution stage (natural template literals → concrete). This
 * file closes the remaining gap the review flagged: the fields that stay raw `Cel.expr` — ClickHouse
 * `clusterName` + `keeper.host`/`keeper.port`, and ClickStack `ready`/`phase` (the `.exists()` macro) — are
 * preserved as expression objects by re-execution and only become concrete in the SUBSEQUENT cel-js
 * resolution stage. Here we drive that stage HERMETICALLY (no cluster): we pull the ACTUAL `CelExpression`
 * objects the factories emit out of the re-executed status, then evaluate them through the real
 * `CelEvaluator` (the same cel-js engine the direct-mode reference resolver uses) against a synthetic
 * resource map. This proves both that the factory emits the right CEL AND that the engine resolves it to
 * the correct concrete, correctly-TYPED values — the behavior the cluster-gated integration suite asserts,
 * now provable in normal CI.
 */
import { describe, expect, it } from 'bun:test';

import { CEL_EXPRESSION_BRAND } from '../../src/core/constants/brands.js';
import { CelEvaluator } from '../../src/core/references/index.js';
import { makeClickHouseCluster } from '../../src/factories/clickhouse/index.js';
import { clickstackBootstrap } from '../../src/factories/clickstack/index.js';

interface DirectReExec {
  reExecuteWithLiveStatus(
    spec: Record<string, unknown>,
    liveStatusMap: Map<string, Record<string, unknown>>
  ): Record<string, any> | null;
}

/** A value the re-execution stage left as a raw CEL marker (brand + expression string). */
const isCelMarker = (v: unknown): v is { expression: string } =>
  typeof v === 'object' && v !== null && (v as Record<PropertyKey, unknown>)[CEL_EXPRESSION_BRAND] === true;

const evalCel = (marker: unknown, resources: Record<string, unknown>) => {
  expect(isCelMarker(marker)).toBe(true);
  const context = { resources: new Map(Object.entries(resources)), variables: {}, functions: {} };
  return new CelEvaluator().evaluate(marker as any, context as any);
};

describe('final-pipeline CEL resolution for raw-Cel.expr status fields (hermetic, no cluster)', () => {
  it('resolves ClickHouse clusterName + keeper host/port (numeric) to concrete typed values', async () => {
    const factory = makeClickHouseCluster({ users: [{ name: 'app' }], keeper: true }).factory('direct', {
      namespace: 'ch',
    }) as unknown as DirectReExec;

    const status = factory.reExecuteWithLiveStatus(
      {
        name: 'demo',
        namespace: 'ch',
        version: '25.7',
        storage: { size: '1Gi' },
        users: { app: { passwordSha256Hex: 'abc' } },
        keeper: { host: 'placeholder' },
      },
      new Map([['clickhouse', { status: 'Completed', endpoint: 'demo.ch:9000', hosts: 1, hostsCompleted: 1 }]])
    );
    expect(status).not.toBeNull();

    // These are raw Cel.expr after re-execution (NOT yet concrete) — that is the contract this test
    // completes: they resolve in the cel-js stage below, so they are bimodal, not KRO-only.
    const mockChi = {
      clickhouse: {
        spec: {
          configuration: {
            clusters: [{ name: 'cluster' }],
            zookeeper: { nodes: [{ host: 'chk-demo.ch.svc.cluster.local', port: 9181 }] },
          },
        },
      },
    };

    const clusterName = await evalCel(status!.clickhouse.clusterName, mockChi);
    expect(clusterName).toBe('cluster');

    const keeperHost = await evalCel(status!.keeper.host, mockChi);
    expect(keeperHost).toBe('chk-demo.ch.svc.cluster.local');

    const keeperPort = await evalCel(status!.keeper.port, mockChi);
    expect(keeperPort).toBe(9181);
    // The whole reason keeper.port stays raw Cel.expr (not a template literal): it must stay NUMERIC.
    expect(typeof keeperPort).toBe('number');
  });

  it('resolves ClickStack ready===true and phase==="Ready" from the HelmRelease conditions (.exists() macro)', async () => {
    const factory = clickstackBootstrap.factory('direct', {
      namespace: 'observability',
    }) as unknown as DirectReExec;

    const status = factory.reExecuteWithLiveStatus(
      {
        name: 'hdx',
        namespace: 'observability',
        clickhouse: { host: 'clickhouse-demo.ch.svc.cluster.local', username: 'app', password: 'x' },
        apiKey: 'hermetic-api-key',
      },
      new Map()
    );
    expect(status).not.toBeNull();

    // Both the chart and the authoritative ingestion-Team bootstrap have
    // reconciled — what the graph looks like post-waitForReady.
    const ready = {
      clickstackHelmRelease: {
        metadata: { generation: 2 },
        status: {
          observedGeneration: 2,
          conditions: [{ type: 'Ready', status: 'True', observedGeneration: 2 }],
        },
      },
      clickstackTeamBootstrap: {
        status: {
          lastScheduleTime: '2026-08-28T10:00:00Z',
          lastSuccessfulTime: '2026-08-28T10:00:05Z',
        },
      },
    };
    expect(await evalCel(status!.ready, ready)).toBe(true);
    expect(await evalCel(status!.phase, ready)).toBe('Ready');

    // A failed HelmRelease drives phase to Failed — proves the macro chain, not a constant.
    const failed = {
      clickstackHelmRelease: {
        metadata: { generation: 2 },
        status: {
          observedGeneration: 2,
          conditions: [{ type: 'Ready', status: 'False', observedGeneration: 2 }],
        },
      },
      clickstackTeamBootstrap: { status: {} },
    };
    expect(await evalCel(status!.ready, failed)).toBe(false);
    expect(await evalCel(status!.phase, failed)).toBe('Failed');

    const bootstrapPending = {
      clickstackHelmRelease: {
        metadata: { generation: 2 },
        status: {
          observedGeneration: 2,
          conditions: [{ type: 'Ready', status: 'True', observedGeneration: 2 }],
        },
      },
      clickstackTeamBootstrap: {
        status: {
          lastScheduleTime: '2026-08-28T10:01:00Z',
          lastSuccessfulTime: '2026-08-28T10:00:05Z',
        },
      },
    };
    expect(await evalCel(status!.ready, bootstrapPending)).toBe(false);
    expect(await evalCel(status!.phase, bootstrapPending)).toBe('Installing');
  });
});
