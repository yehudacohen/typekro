/**
 * HERMETIC direct-mode status hydration for the migrated ClickStack status fields (PR #99).
 *
 * Companion to the clickhouse direct-hydration test: proves the migrated endpoint contract
 * (`ui.url`, `gateway.otlpHttpEndpoint`/`otlpGrpcEndpoint`, `app.host`) — all natural JS template literals
 * over the HelmRelease resource proxy — hydrates to CONCRETE strings in direct mode WITHOUT a cluster,
 * via the `reExecuteWithLiveStatus` JS re-execution seam.
 *
 * NOT asserted here: `ready`/`phase` use the CEL `.exists()` macro over the HelmRelease conditions (no JS
 * equivalent), so they are `Cel.expr` objects that this JS-re-execution seam preserves rather than
 * resolves; their runtime value is settled by the cel-js resolver / KRO status and is covered by the
 * cluster-gated integration suite. This file's job is the migrated template-literal contract.
 */
import { describe, expect, it } from 'bun:test';

import { clickstackBootstrap } from '../../../src/factories/clickstack/index.js';
import { DEFAULT_CLICKSTACK_VERSION } from '../../../src/factories/clickstack/resources/helm.js';

interface DirectReExec {
  reExecuteWithLiveStatus(
    spec: Record<string, unknown>,
    liveStatusMap: Map<string, Record<string, unknown>>
  ): Record<string, any> | null;
}

describe('clickstack direct-mode status hydration (hermetic, no cluster)', () => {
  it('hydrates the migrated ui/gateway/app endpoint contract to concrete strings', () => {
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
      // The migrated fields are metadata-anchored, so no live status is required to resolve them.
      new Map()
    );

    expect(status).not.toBeNull();

    // The bimodal migration: metadata-anchored template literals → concrete strings in direct mode.
    expect(status!.ui.url).toBe('http://hdx.observability.svc.cluster.local:3000');
    expect(status!.gateway.otlpHttpEndpoint).toBe(
      'http://hdx-otel-collector.observability.svc.cluster.local:4318'
    );
    expect(status!.gateway.otlpGrpcEndpoint).toBe(
      'http://hdx-otel-collector.observability.svc.cluster.local:4317'
    );
    expect(status!.app.host).toBe('hdx.observability.svc.cluster.local');

    // Concrete strings, not leftover CEL marker objects.
    expect(typeof status!.ui.url).toBe('string');
    expect(typeof status!.gateway.otlpHttpEndpoint).toBe('string');
    expect(typeof status!.app.host).toBe('string');

    // `version` is a reference into the OWNED HelmRelease's own chart pin, and
    // that resource's spec is fully known to this seam — so it resolves here to
    // the concrete pin, with no cluster and no ConfigMap round-trip.
    expect(status!.version).toBe(DEFAULT_CLICKSTACK_VERSION);
    expect(typeof status!.version).toBe('string');

    // The remaining CONSTRUCTION-TIME fields (the ports and the storage block)
    // are no longer bare constants either: they are projected from the contract
    // ConfigMap this composition owns, which is what makes them visible on the
    // live KRO CR. Like `ready`/`phase`, they are therefore `Cel.expr` objects
    // that this JS-re-execution seam PRESERVES rather than resolves — the
    // cel-js reference resolver settles them against the live ConfigMap in a
    // real direct deploy (asserted in the cluster-gated integration suite).
    const celExpression = (value: unknown): string =>
      (value as { expression: string }).expression;

    expect(celExpression(status!.app.appPort)).toBe('int(clickstackContract.data.appPort)');
    expect(celExpression(status!.app.apiPort)).toBe('int(clickstackContract.data.apiPort)');
    expect(celExpression(status!.storage.mode)).toBe('clickstackContract.data.storageMode');
    expect(celExpression(status!.storage.persistentQueue)).toBe(
      'clickstackContract.data.storagePersistentQueue == "true"'
    );
  });
});
