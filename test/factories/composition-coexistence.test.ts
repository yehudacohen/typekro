/**
 * Compositions that share a namespace may not declare the same object.
 *
 * LIVE FAILURE THIS COVERS. Deploying an observability stack whose ClickHouse
 * cluster and ClickStack release were both named after the stack, into one
 * namespace, made KRO refuse the second instance outright:
 *
 *   resource belongs to a different ApplySet: <ns>/<release>-contract
 *   (ConfigMap) belongs to ApplySet "<A>", cannot reassign to "<B>"
 *
 * Both compositions appended a bare `-contract` to their release name for the
 * status-projection ConfigMap they each OWN. The two ConfigMaps carry
 * different keys — the ClickHouse one the database/ports/user/durability
 * block, the ClickStack one the app ports and retention — so neither could
 * consume the other's; they only ever collided on the NAME. The ClickHouse one
 * is now component-scoped (`<installation>-clickhouse-contract`), following
 * the convention the Envoy AI Gateway family already used.
 *
 * Nothing in a single-composition render can catch this, so the check renders
 * the compositions that realistically co-exist in one namespace against ONE
 * shared name and asserts their declared `(kind, namespace, name)` triples are
 * disjoint. `assertNoDuplicateDeclarations` is generic — point it at any set
 * of renders.
 */

import { describe, expect, it } from 'bun:test';
import { dump } from 'js-yaml';

import { clickHouseCluster } from '../../src/factories/clickhouse/compositions/clickhouse-cluster.js';
import { clickHouseKeeperInstallation } from '../../src/factories/clickhouse/resources/keeper.js';
import { clickstackBootstrap } from '../../src/factories/clickstack/compositions/clickstack-bootstrap.js';
import { clickstackK8sTelemetry } from '../../src/factories/clickstack/compositions/k8s-telemetry.js';
import {
  assertNoDuplicateDeclarations,
  findDuplicateDeclarations,
  type RenderedComposition,
} from '../utils/duplicate-declarations.js';

/**
 * The live failure's own shape: one 23-byte name shared by every component of
 * the stack, in one namespace.
 */
const RELEASE_NAME = 'observability-clickstack';
const NAMESPACE = 'observability';

/** Placeholder credentials — never a real secret, and never applied anywhere. */
const TEST_PASSWORD = 'unit-test-only';

function renderStack(): RenderedComposition[] {
  const clickhouse = clickHouseCluster.factory('direct', { namespace: NAMESPACE }).toYaml({
    name: RELEASE_NAME,
    namespace: NAMESPACE,
    version: '25.12.5',
    storage: { size: '10Gi' },
  } as never);

  const bootstrap = clickstackBootstrap.factory('direct', { namespace: NAMESPACE }).toYaml({
    name: RELEASE_NAME,
    namespace: NAMESPACE,
    clickhouse: {
      host: `${RELEASE_NAME}.${NAMESPACE}.svc.cluster.local`,
      username: 'otelcollector',
      password: TEST_PASSWORD,
    },
    apiKey: TEST_PASSWORD,
  } as never);

  const telemetry = clickstackK8sTelemetry.factory('direct', { namespace: NAMESPACE }).toYaml({
    name: RELEASE_NAME,
    namespace: NAMESPACE,
    endpoint: `http://${RELEASE_NAME}-otel-collector.${NAMESPACE}.svc.cluster.local:4318`,
    apiKeySecret: { name: `${RELEASE_NAME}-api-key` },
  } as never);

  // The keeper is a bare resource factory rather than a composition, so it is
  // rendered directly — it is applied into the same namespace under the same
  // name and belongs in the same disjointness check.
  const keeper = clickHouseKeeperInstallation({
    name: RELEASE_NAME,
    namespace: NAMESPACE,
    replicas: 3,
  });
  const keeperYaml = dump({
    apiVersion: keeper.apiVersion,
    kind: keeper.kind,
    metadata: { name: keeper.metadata.name, namespace: keeper.metadata.namespace },
  });

  return [
    { source: 'clickHouseCluster', yaml: clickhouse },
    { source: 'clickHouseKeeperInstallation', yaml: keeperYaml },
    { source: 'clickstackBootstrap', yaml: bootstrap },
    { source: 'clickstackK8sTelemetry', yaml: telemetry },
  ];
}

describe('compositions co-existing in one namespace', () => {
  it('declare no object twice across the shipped observability stack', () => {
    assertNoDuplicateDeclarations(renderStack());
  });

  it('give the two contract ConfigMaps distinct names under one release name', () => {
    const renders = renderStack();
    const contracts = renders.flatMap((rendered) =>
      rendered.yaml
        .split('\n')
        .filter((line) => line.includes('contract') && line.trimStart().startsWith('name:'))
        .map((line) => line.trim())
    );

    // The ClickStack release keeps the original name and keys; the ClickHouse
    // cluster's is component-scoped.
    expect(contracts).toContain(`name: ${RELEASE_NAME}-contract`);
    expect(contracts).toContain(`name: ${RELEASE_NAME}-clickhouse-contract`);
  });

  it('detects a duplicate declaration when one is introduced', () => {
    // The helper is only worth anything if it fails on the real thing: two
    // sources declaring the same (kind, namespace, name).
    const collision = [
      {
        source: 'a',
        yaml: dump({ kind: 'ConfigMap', metadata: { name: 'x-contract', namespace: NAMESPACE } }),
      },
      {
        source: 'b',
        yaml: dump({ kind: 'ConfigMap', metadata: { name: 'x-contract', namespace: NAMESPACE } }),
      },
    ];

    expect(findDuplicateDeclarations(collision)).toEqual([
      { kind: 'ConfigMap', namespace: NAMESPACE, name: 'x-contract', sources: ['a', 'b'] },
    ]);
    expect(() => assertNoDuplicateDeclarations(collision)).toThrow(
      /declared by more than one composition/
    );
  });

  it('ignores a repeat WITHIN one composition (one composition is one ApplySet)', () => {
    const repeated = [
      {
        source: 'a',
        yaml: [
          dump({ kind: 'ConfigMap', metadata: { name: 'x', namespace: NAMESPACE } }),
          dump({ kind: 'ConfigMap', metadata: { name: 'x', namespace: NAMESPACE } }),
        ].join('---\n'),
      },
    ];

    expect(findDuplicateDeclarations(repeated)).toEqual([]);
  });

  it('separates objects by kind and by namespace', () => {
    const distinct = [
      {
        source: 'a',
        yaml: dump({ kind: 'ConfigMap', metadata: { name: 'x', namespace: 'one' } }),
      },
      {
        source: 'b',
        yaml: dump({ kind: 'Secret', metadata: { name: 'x', namespace: 'one' } }),
      },
      {
        source: 'c',
        yaml: dump({ kind: 'ConfigMap', metadata: { name: 'x', namespace: 'two' } }),
      },
    ];

    expect(findDuplicateDeclarations(distinct)).toEqual([]);
  });
});
