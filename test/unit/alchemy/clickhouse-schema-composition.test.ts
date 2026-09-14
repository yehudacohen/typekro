/**
 * Offline proof that the `ClickHouseSchema` e2e suite's ClickHouse composition deploys.
 *
 * The suite itself needs a cluster and skips without one, which is exactly how a broken
 * composition stays hidden: `makeClickHouseCluster({ users: [{ name: 'probe' }] })` makes
 * `spec.users.probe.passwordSha256Hex` a REQUIRED field, and a deploy that omits it throws
 * inside the composition body — before a single request reaches an API server. A failure
 * that needs no cluster to happen should need no cluster to catch.
 *
 * `factory('direct').toYaml(spec)` is the cluster-free form of that deploy: it validates
 * the spec against the generated schema and RE-EXECUTES the composition body against the
 * concrete values, which is the step that throws. It renders manifests and talks to
 * nothing.
 *
 * The topology and the spec are imported from the suite's own fixture, so this proves the
 * composition the e2e suite actually deploys rather than a copy that can drift from it.
 */

import { describe, expect, it } from 'bun:test';
import {
  CLICKHOUSE_SCHEMA_E2E_PASSWORD,
  CLICKHOUSE_SCHEMA_E2E_PASSWORD_SHA256,
  CLICKHOUSE_SCHEMA_E2E_USER,
  clickHouseSchemaE2EClusterSpec,
  makeClickHouseSchemaE2ECluster,
} from '../../integration/alchemy/clickhouse-schema-fixture.js';

interface YamlRenderer {
  toYaml(spec: unknown): string;
}

const NAMESPACE = 'tk-chschema-chi-offline';

function directRenderer(): YamlRenderer {
  return makeClickHouseSchemaE2ECluster().factory('direct', {
    namespace: NAMESPACE,
  }) as unknown as YamlRenderer;
}

const spec = clickHouseSchemaE2EClusterSpec({
  name: 'ch-schema',
  namespace: NAMESPACE,
  version: '25.7',
  storage: { size: '2Gi', storageClassName: 'standard' },
});

describe("ClickHouseSchema e2e fixture — the CHI composition's deployability", () => {
  it('renders the whole composition from the concrete spec, without a cluster', () => {
    const yaml = directRenderer().toYaml(spec);
    expect(yaml).toContain('ClickHouseInstallation');
    expect(yaml).toContain(NAMESPACE);
  });

  it('carries the declared credential into the CHI user configuration', () => {
    const yaml = directRenderer().toYaml(spec);
    expect(yaml).toContain(`${CLICKHOUSE_SCHEMA_E2E_USER}/password_sha256_hex`);
    expect(yaml).toContain(CLICKHOUSE_SCHEMA_E2E_PASSWORD_SHA256);
  });

  it('agrees with what the ClickHouseSchema resource can actually present', () => {
    // The resource expands `--password "${CLICKHOUSE_PASSWORD:-}"` inside the CHI server
    // container, where nothing sets that variable. The hash the CHI declares must
    // therefore be the hash of the empty password, or the schema resource cannot log in.
    expect(CLICKHOUSE_SCHEMA_E2E_PASSWORD).toBe('');
    expect(CLICKHOUSE_SCHEMA_E2E_PASSWORD_SHA256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('rejects the spec that omitted the declared user, which is the bug this pins', () => {
    const { users: _omitted, ...withoutUser } = spec;
    expect(() => directRenderer().toYaml(withoutUser)).toThrow();
  });
});
