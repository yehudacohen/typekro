/**
 * The ClickHouse cluster the `ClickHouseSchema` e2e suite targets.
 *
 * Extracted from the suite so the composition can be rendered — and therefore PROVEN to
 * be deployable — without a cluster. `test/unit/alchemy/clickhouse-schema-composition.test.ts`
 * runs the same topology and the same spec through `factory('direct').toYaml(spec)`, which
 * re-executes the composition body against the concrete spec exactly as a deploy does.
 * Keeping the two in one module is what makes that proof about the real suite rather than
 * about a copy of it.
 */

import { createHash } from 'node:crypto';
import { makeClickHouseCluster } from '../../../src/factories/clickhouse/index.js';

/** The CHI user every part of the suite authenticates as. */
export const CLICKHOUSE_SCHEMA_E2E_USER = 'probe';

export const CLICKHOUSE_SCHEMA_E2E_DATABASE = 'orders';

/**
 * The password that user authenticates with — deliberately EMPTY.
 *
 * Three places have to agree on one credential, and only one value satisfies all three:
 *
 * 1. the CHI's own user configuration, which needs a `password_sha256_hex`;
 * 2. the throwaway `clickhouse-client` Pod that queries the server for independent
 *    evidence, which can be given anything;
 * 3. the `ClickHouseSchema` resource, which reads its password from an environment
 *    variable INSIDE the CHI server container (`--password "${CLICKHOUSE_PASSWORD:-}"`).
 *
 * (3) is the binding constraint. A CHI server container has no such variable — the
 * Altinity operator injects user credentials into ClickHouse's own configuration, not
 * into the container environment, and `makeClickHouseCluster` exposes no way to add one —
 * so the POSIX default expansion resolves to the empty password. The identity the
 * resource can present over loopback is therefore one whose password is empty, and the
 * CHI has to declare it as such for the three to agree.
 *
 * The hash is DERIVED from this constant rather than pasted as a literal, so the
 * agreement is enforced by the code instead of by a comment.
 */
export const CLICKHOUSE_SCHEMA_E2E_PASSWORD = '';

export const CLICKHOUSE_SCHEMA_E2E_PASSWORD_SHA256 = createHash('sha256')
  .update(CLICKHOUSE_SCHEMA_E2E_PASSWORD)
  .digest('hex');

/**
 * A single-replica ClickHouse cluster with one declared user.
 *
 * Declaring a user makes `spec.users.<name>` a REQUIRED field of the generated instance
 * schema — that is the whole point of `makeClickHouseCluster`'s literal-key user map —
 * so the spec below must supply it. {@link clickHouseSchemaE2EClusterSpec} is the only
 * supported way to build that spec for this topology.
 */
export function makeClickHouseSchemaE2ECluster() {
  return makeClickHouseCluster({ users: [{ name: CLICKHOUSE_SCHEMA_E2E_USER }] });
}

export interface ClickHouseSchemaE2EClusterSpecOptions {
  readonly name: string;
  readonly namespace: string;
  readonly version: string;
  readonly storage: { readonly size: string; readonly storageClassName?: string };
}

/** The concrete instance spec, credential included. */
export function clickHouseSchemaE2EClusterSpec(options: ClickHouseSchemaE2EClusterSpecOptions) {
  return {
    name: options.name,
    namespace: options.namespace,
    version: options.version,
    storage: {
      size: options.storage.size,
      ...(options.storage.storageClassName !== undefined
        ? { storageClassName: options.storage.storageClassName }
        : {}),
    },
    users: {
      [CLICKHOUSE_SCHEMA_E2E_USER]: {
        passwordSha256Hex: CLICKHOUSE_SCHEMA_E2E_PASSWORD_SHA256,
      },
    },
  };
}
