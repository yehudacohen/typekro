/**
 * Assertions shared by the direct-mode and KRO-mode halves of the S3-backed
 * ClickStack suite.
 *
 * They live here so the two modes are held to the SAME bar: every leaf of
 * `ClickStackBootstrapStatusSchema`, checked the same way. A direct-mode
 * assertion that covered only `ready`, `storage.mode` and the gateway endpoint
 * would let one mode pass on weaker evidence than the other — which is exactly
 * what a bimodal suite exists to rule out. The status parameter is typed as the
 * DECLARED status type, so a leaf renamed in the schema breaks this file at
 * compile time rather than silently going unasserted.
 */
import { expect } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';

import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/index.js';
import {
  CLICKSTACK_API_PORT,
  CLICKSTACK_APP_PORT,
  CLICKSTACK_GATEWAY_NAME_SUFFIX,
  CLICKSTACK_OTLP_GRPC_PORT,
  CLICKSTACK_OTLP_HTTP_PORT,
} from '../../../src/factories/clickstack/resources/helm.js';
import type { ClickStackBootstrapStatus } from '../../../src/factories/clickstack/types.js';

/** The owned Flux HelmRelease, as read back from the API server. */
export interface ObservedClickStackHelmRelease {
  spec?: { chart?: { spec?: { chart?: string; version?: string } } };
}

/** Read the owned ClickStack HelmRelease through the shared custom-objects client. */
export async function readClickStackHelmRelease(
  namespace: string,
  name: string,
  kubeConfig: k8s.KubeConfig
): Promise<ObservedClickStackHelmRelease> {
  const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
  const raw = (await customApi.getNamespacedCustomObject({
    group: 'helm.toolkit.fluxcd.io',
    version: 'v2',
    namespace,
    plural: 'helmreleases',
    name,
  })) as { body?: ObservedClickStackHelmRelease } & ObservedClickStackHelmRelease;
  return raw?.body ?? raw;
}

/** What the caller has to state for the whole declared contract to be checkable. */
export interface ClickStackS3StatusExpectation {
  /** HelmRelease name — the naming anchor every endpoint in the contract hangs off. */
  instanceName: string;
  namespace: string;
  /** The chart version this bootstrap was built to install. */
  chartVersion: string;
  /**
   * The owned HelmRelease as the cluster has it. `status.version` is projected
   * straight off its `spec.chart.spec.version`, so the reported version is
   * asserted against the LIVE chart pin — not only against the constant — in
   * both modes.
   */
  helmRelease: ObservedClickStackHelmRelease;
  /** The construction-time storage contract this bootstrap was built with. */
  storage: {
    mode: 'pvc' | 's3';
    diskType: 's3' | 's3_plain_rewritable';
    persistentQueue: boolean;
  };
}

/**
 * Assert EVERY field `ClickStackBootstrapStatusSchema` declares.
 *
 * Called identically by both modes. The declared-optional fields that this
 * topology legitimately does not carry are asserted as ABSENT rather than
 * skipped:
 * - `storage.policyName` is only set when the caller states the external
 *   ClickHouse's default policy, and neither mode here does.
 * - `storage.retention` is only present when a retention CronJob is rendered,
 *   which the factory refuses against an `s3_plain_rewritable` CHI (an
 *   immutable metadata type rejects the `ALTER TABLE ... MODIFY TTL` the
 *   CronJob would issue).
 */
export function assertClickStackS3StatusContract(
  status: ClickStackBootstrapStatus | undefined,
  expected: ClickStackS3StatusExpectation
): void {
  expect(status).toBeDefined();
  const appHost = `${expected.instanceName}.${expected.namespace}.svc.cluster.local`;
  const gatewayHost =
    `${expected.instanceName}${CLICKSTACK_GATEWAY_NAME_SUFFIX}` +
    `.${expected.namespace}.svc.cluster.local`;

  expect(status?.ready).toBe(true);
  expect(status?.phase).toBe('Ready');
  // The version is the chart pin on the owned HelmRelease, not an echo of the
  // request: assert it against the LIVE release, and assert that release is
  // pinned where this bootstrap said — so a pair of `undefined`s cannot pass.
  expect(expected.helmRelease.spec?.chart?.spec?.version).toBe(expected.chartVersion);
  expect<string | undefined>(status?.version).toBe(expected.helmRelease.spec?.chart?.spec?.version);

  // ── ui / gateway / app: the endpoints a consumer wires itself to ─────────
  expect(status?.ui.url).toBe(`http://${appHost}:${CLICKSTACK_APP_PORT}`);
  expect(status?.gateway.otlpHttpEndpoint).toBe(
    `http://${gatewayHost}:${CLICKSTACK_OTLP_HTTP_PORT}`
  );
  expect(status?.gateway.otlpGrpcEndpoint).toBe(
    `http://${gatewayHost}:${CLICKSTACK_OTLP_GRPC_PORT}`
  );
  expect(status?.app.host).toBe(appHost);
  expect(status?.app.appPort).toBe(CLICKSTACK_APP_PORT);
  expect(status?.app.apiPort).toBe(CLICKSTACK_API_PORT);
  // Projected through CEL `int(...)` out of a ConfigMap whose values are
  // strings: a regression that dropped the conversion would give '3000'.
  expect(typeof status?.app.appPort).toBe('number');
  expect(typeof status?.app.apiPort).toBe('number');

  // ── storage: the durability half of the contract ─────────────────────────
  expect(status?.storage.mode).toBe(expected.storage.mode);
  expect(status?.storage.diskType).toBe(expected.storage.diskType);
  expect(status?.storage.persistentQueue).toBe(expected.storage.persistentQueue);
  expect(typeof status?.storage.persistentQueue).toBe('boolean');
  expect(status?.storage.policyName).toBeUndefined();
  expect(status?.storage.retention).toBeUndefined();
}
