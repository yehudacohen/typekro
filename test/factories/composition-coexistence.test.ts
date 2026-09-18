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
import {
  clickHouseKeeperInstallation,
  DEFAULT_CHK_CLUSTER_NAME,
} from '../../src/factories/clickhouse/resources/keeper.js';
import { clickstackBootstrap } from '../../src/factories/clickstack/compositions/clickstack-bootstrap.js';
import { clickstackK8sTelemetry } from '../../src/factories/clickstack/compositions/k8s-telemetry.js';
import {
  assertNoDuplicateDeclarations,
  collectDeclaredObjects,
  findDuplicateDeclarations,
  type RenderedComposition,
} from '../utils/duplicate-declarations.js';

/**
 * The live failure's own shape: one over-long (24-byte) name shared by every
 * component of the stack, in one namespace.
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
    // The release name is past the CRD's 15-byte cap on the internal cluster
    // name, so the keeper requires an explicit one (see keeper.test.ts).
    clusterName: DEFAULT_CHK_CLUSTER_NAME,
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

  /**
   * UPGRADE PATH for the contract-ConfigMap rename.
   *
   * WHAT IS ASSERTED HERE, AND WHAT IS NOT. The post-upgrade END STATE is
   * conflict-free and that is checked below: the ClickHouse cluster declares
   * only `<name>-clickhouse-contract` and no longer mentions the old
   * `<name>-contract` anywhere, so once its instance reconciles, the old object
   * falls outside its ApplySet and KRO prunes it — after which the ClickStack
   * bootstrap can claim `<name>-contract`.
   *
   * The ORDERING of those two reconciles cannot be asserted offline, and is not
   * guaranteed: the two instances are separate RGDs with no dependency between
   * them, ApplySet pruning is KRO's own server-side behaviour, and TypeKro has
   * no prune engine to model. Upgrading both at once therefore has a transient
   * window in which ClickStack may still see the old owner and be rejected; it
   * clears on the next converge. That window is documented in the CHANGELOG
   * `### Changed` entry rather than asserted here.
   */
  it('leaves no declarer of the OLD contract name after the rename', () => {
    const renders = renderStack();
    const oldName = `${RELEASE_NAME}-contract`;

    const declarersOfOldName = renders
      .flatMap((rendered) => collectDeclaredObjects(rendered))
      .filter((object) => object.name === oldName);

    // Exactly one composition may own it, and it is the ClickStack bootstrap —
    // the ClickHouse cluster has moved off the name entirely.
    expect(declarersOfOldName.map((object) => object.source)).toEqual(['clickstackBootstrap']);

    const clickhouse = renders.find((rendered) => rendered.source === 'clickHouseCluster');
    expect(clickhouse?.yaml).not.toContain(`name: ${oldName}\n`);
    expect(clickhouse?.yaml).toContain(`${RELEASE_NAME}-clickhouse-contract`);
  });

  it('detects a duplicate declaration when one is introduced', () => {
    // The helper is only worth anything if it fails on the real thing: two
    // sources declaring the same (kind, namespace, name).
    const collision = [
      {
        source: 'a',
        yaml: dump({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'x-contract', namespace: NAMESPACE },
        }),
      },
      {
        source: 'b',
        yaml: dump({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'x-contract', namespace: NAMESPACE },
        }),
      },
    ];

    expect(findDuplicateDeclarations(collision)).toEqual([
      {
        apiVersion: 'v1',
        group: '',
        kind: 'ConfigMap',
        namespace: NAMESPACE,
        name: 'x-contract',
        sources: ['a', 'b'],
      },
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

  it('separates objects by API GROUP, so same-named CRs of different groups do not collide', () => {
    // KRO's identity for an object includes its group. Two `Widget`s from
    // different API groups are different objects.
    const differentGroups = [
      {
        source: 'a',
        yaml: dump({
          apiVersion: 'example.com/v1',
          kind: 'Widget',
          metadata: { name: 'w', namespace: NAMESPACE },
        }),
      },
      {
        source: 'b',
        yaml: dump({
          apiVersion: 'other.example.com/v1',
          kind: 'Widget',
          metadata: { name: 'w', namespace: NAMESPACE },
        }),
      },
    ];

    expect(findDuplicateDeclarations(differentGroups)).toEqual([]);
    expect(() => assertNoDuplicateDeclarations(differentGroups)).not.toThrow();
  });

  it('still flags the SAME group/kind/name declared at two API VERSIONS', () => {
    // The version is not part of the identity: `example.com/v1` and
    // `example.com/v1beta1` are one stored object, so this IS a collision.
    const sameGroupTwoVersions = [
      {
        source: 'a',
        yaml: dump({
          apiVersion: 'example.com/v1',
          kind: 'Widget',
          metadata: { name: 'w', namespace: NAMESPACE },
        }),
      },
      {
        source: 'b',
        yaml: dump({
          apiVersion: 'example.com/v1beta1',
          kind: 'Widget',
          metadata: { name: 'w', namespace: NAMESPACE },
        }),
      },
    ];

    const [duplicate] = findDuplicateDeclarations(sameGroupTwoVersions);
    expect(duplicate?.group).toBe('example.com');
    expect(duplicate?.sources).toEqual(['a', 'b']);
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
