/**
 * Assertions shared by the direct-mode and KRO-mode halves of the S3-backed
 * ClickHouse suite.
 *
 * They live here so the two modes are held to the SAME bar: every leaf of
 * `ClickHouseClusterStatusSchema`, checked against the same evidence. A
 * direct-mode assertion that covered only `ready` plus a few storage fields
 * would let one mode pass on weaker evidence than the other — which is exactly
 * what a bimodal suite exists to rule out. The status parameter is typed as the
 * DECLARED status type, so a leaf renamed in the schema breaks this file at
 * compile time rather than silently going unasserted.
 *
 * Everything reads through the shared Bun-compatible Kubernetes clients — no
 * `kubectl` — so the assertions stay correct when only the harness is running.
 */
import { expect } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';

import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/index.js';
import type { ClickHouseClusterStatus } from '../../../src/factories/clickhouse/types.js';

/**
 * The subset of the owned CHI's own status the composition projects the
 * `installation` block from.
 */
export interface ObservedClickHouseInstallation {
  status?: string;
  endpoint?: string;
  hosts?: number;
  hostsCompleted?: number;
}

/** The owned CHI, as read back from the API server. */
export interface ObservedChi {
  status?: ObservedClickHouseInstallation;
  spec?: {
    configuration?: {
      files?: Record<string, string>;
      settings?: Record<string, string>;
    };
  };
}

/** Read the KRO/direct-owned ClickHouseInstallation through the shared client. */
export async function readClickHouseInstallation(
  namespace: string,
  name: string,
  kubeConfig: k8s.KubeConfig
): Promise<ObservedChi> {
  const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
  const raw = (await customApi.getNamespacedCustomObject({
    group: 'clickhouse.altinity.com',
    version: 'v1',
    namespace,
    plural: 'clickhouseinstallations',
    name,
  })) as { body?: ObservedChi } & ObservedChi;
  return raw?.body ?? raw;
}

/** What the caller has to state for the whole declared contract to be checkable. */
export interface ClickHouseS3StatusExpectation {
  /** CHI name — also the `installation.name` and the DNS anchor. */
  instanceName: string;
  namespace: string;
  /** First declared user; `clickhouse.user` is absent only for a userless topology. */
  user: string;
  /** Resolved logical cluster name, read by the composition out of the CHI. */
  clusterName: string;
  database: string;
  /** The construction-time storage contract this topology was built with. */
  storage: {
    mode: 'pvc' | 's3';
    diskType: 's3' | 's3_plain_rewritable';
    policyName: string;
    bucket: string;
    selfDescribingBucket: boolean;
    /** Present iff the topology declares a backup schedule. */
    backupSchedule: string;
  };
  /**
   * The owned CHI's OWN status — the source the `installation` block is
   * projected from. Passed in rather than hard-coded so the two host counters
   * are asserted as AGREEING WITH THEIR SOURCE instead of pinned to numbers
   * that assert the operator's mid-reconcile behaviour. (Live finding, operator
   * release-0.27.1: `hostsCompleted` is not populated on a settled cluster, so
   * the declared-optional `hostsCompletedCount` is legitimately absent — in
   * both modes, for the same reason.)
   */
  chi: ObservedClickHouseInstallation;
}

/**
 * Assert EVERY field `ClickHouseClusterStatusSchema` declares.
 *
 * Called identically by both modes. The two legitimate absences are asserted
 * as absences rather than skipped:
 * - `keeper` is present iff the topology enables a keeper; the S3 topologies
 *   here have none, so it must be `undefined` — not merely unread.
 * - `installation.hostsCompletedCount` mirrors the CHI's `hostsCompleted`,
 *   which the operator leaves unset once reconciled.
 */
export function assertClickHouseS3StatusContract(
  status: ClickHouseClusterStatus | undefined,
  expected: ClickHouseS3StatusExpectation
): void {
  expect(status).toBeDefined();
  const host = `clickhouse-${expected.instanceName}.${expected.namespace}.svc.cluster.local`;

  expect(status?.ready).toBe(true);
  expect(status?.phase).toBe('Ready');

  // ── clickhouse: the connection contract downstream compositions consume ──
  expect(status?.clickhouse.host).toBe(host);
  expect(status?.clickhouse.port).toBe(9000);
  // Projected through CEL `int(...)` out of a ConfigMap whose values are
  // strings: a regression that dropped the conversion would give '9000'.
  expect(typeof status?.clickhouse.port).toBe('number');
  expect(status?.clickhouse.nativeUrl).toBe(`clickhouse://${host}:9000`);
  expect(status?.clickhouse.httpUrl).toBe(`http://${host}:8123`);
  expect(status?.clickhouse.clusterName).toBe(expected.clusterName);
  expect(status?.clickhouse.database).toBe(expected.database);
  expect(status?.clickhouse.user).toBe(expected.user);

  // ── keeper: declared, optional, and legitimately absent here ─────────────
  expect(status?.keeper).toBeUndefined();

  // ── storage: the durability contract, projected from the owned ConfigMap ─
  expect(status?.storage.mode).toBe(expected.storage.mode);
  expect(status?.storage.diskType).toBe(expected.storage.diskType);
  expect(status?.storage.policyName).toBe(expected.storage.policyName);
  expect(status?.storage.bucket).toBe(expected.storage.bucket);
  expect(status?.storage.selfDescribingBucket).toBe(expected.storage.selfDescribingBucket);
  expect(typeof status?.storage.selfDescribingBucket).toBe('boolean');
  expect(status?.storage.backupSchedule).toBe(expected.storage.backupSchedule);

  // ── installation: identity plus whatever the operator reports ────────────
  expect(status?.installation.name).toBe(expected.instanceName);
  expect(status?.installation.namespace).toBe(expected.namespace);
  // The endpoint is the OPERATOR's, so it is asserted against the CHI it comes
  // from — and the CHI's own value is asserted non-empty, so a pair of
  // `undefined`s cannot pass this as agreement.
  expect(expected.chi.endpoint).toContain(expected.instanceName);
  expect<string | undefined>(status?.installation.endpoint).toBe(expected.chi.endpoint);
  // Same rule for the host counter: agreement with the CHI, plus proof the CHI
  // actually reports one — otherwise `undefined === undefined` would pass.
  expect(typeof expected.chi.hosts).toBe('number');
  expect<number | undefined>(status?.installation.hostsCount).toBe(expected.chi.hosts);
  expect<number | undefined>(status?.installation.hostsCompletedCount).toBe(
    expected.chi.hostsCompleted
  );
}
