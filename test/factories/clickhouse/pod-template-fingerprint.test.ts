/**
 * ClickHouse pod template digest (#238).
 *
 * The clickhouse-operator restarts a server IN PLACE, under its current pod
 * template, before rolling out a new one — unless a container's `env`
 * changed. The digest in `TYPEKRO_POD_TEMPLATE_HASH` is what makes a template
 * change (probes above all) visible to that check. These tests pin the two
 * properties that matter: the digest moves when the template moves, and it
 * does NOT move for a configuration-only change, which should keep the
 * operator's cheaper in-place restart.
 */

import { describe, expect, it } from 'bun:test';
import { makeClickHouseCluster } from '../../../src/factories/clickhouse/compositions/clickhouse-cluster.js';
import { clickHouseInstallation } from '../../../src/factories/clickhouse/resources/installation.js';
import type { ClickHouseS3StorageOptions } from '../../../src/factories/clickhouse/types.js';
import {
  CLICKHOUSE_POD_TEMPLATE_HASH_ENV,
  clickHousePodTemplateHash,
} from '../../../src/factories/clickhouse/utils/pod-template-fingerprint.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

type InstallationConfig = Parameters<typeof clickHouseInstallation>[0];

const IRSA_S3: ClickHouseS3StorageOptions = {
  mode: 's3',
  bucket: 'example-observability',
  prefix: 'clickhouse',
  region: 'us-east-2',
  cache: { size: '50Gi' },
  auth: { irsa: { roleArn: 'arn:aws:iam::123456789012:role/clickhouse-s3' } },
};

function chi(overrides: Partial<InstallationConfig> = {}) {
  return clickHouseInstallation({
    name: 'test-ch',
    namespace: 'observability',
    version: '25.7.8.71',
    storage: { size: '10Gi' },
    ...overrides,
  } as InstallationConfig);
}

type Env = { name: string; value?: string }[];

function envsOf(installation: ReturnType<typeof clickHouseInstallation>): Env[] {
  return (installation.spec.templates?.podTemplates ?? []).map(
    (template) =>
      ((template.spec as { containers: { env?: Env }[] }).containers[0]?.env ?? []) as Env
  );
}

function hashOf(installation: ReturnType<typeof clickHouseInstallation>): string {
  const value = envsOf(installation)[0]?.find(
    (entry) => entry.name === CLICKHOUSE_POD_TEMPLATE_HASH_ENV
  )?.value;
  if (value === undefined)
    throw new Error(`no ${CLICKHOUSE_POD_TEMPLATE_HASH_ENV} on the container`);
  return value;
}

describe('ClickHouse pod template digest (#238)', () => {
  it('is on the clickhouse container in PVC and S3 mode', () => {
    expect(hashOf(chi())).toMatch(/^[0-9a-f]{16}$/);
    expect(hashOf(chi({ storage: { ...IRSA_S3, size: '100Gi' } }))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is the last env entry, after the S3 credential env', () => {
    const env = envsOf(chi({ storage: { ...IRSA_S3, size: '100Gi' } }))[0] ?? [];
    expect(env.at(-1)?.name).toBe(CLICKHOUSE_POD_TEMPLATE_HASH_ENV);
  });

  it('is stable across constructions of the same input', () => {
    expect(hashOf(chi())).toBe(hashOf(chi()));
  });

  it('changes when a probe changes — the case that took ClickHouse down', () => {
    const before = hashOf(chi());
    expect(hashOf(chi({ probes: { startup: { failureThreshold: 180 } } }))).not.toBe(before);
    expect(hashOf(chi({ probes: { liveness: false } }))).not.toBe(before);
  });

  it('changes when resources, image or storage mode change', () => {
    const before = hashOf(chi());
    expect(
      hashOf(chi({ podResources: { requests: { cpu: '2' } } } as Partial<InstallationConfig>))
    ).not.toBe(before);
    expect(hashOf(chi({ version: '25.8.1.1' }))).not.toBe(before);
    expect(hashOf(chi({ storage: { ...IRSA_S3, size: '100Gi' } }))).not.toBe(before);
  });

  it('does NOT change for a configuration-only change', () => {
    // A system-log retention change is `settings/*` + `files/config.d/*.xml`:
    // restart-requiring, but no template change — the operator's in-place
    // restart is the right (and cheaper) path for it.
    const before = hashOf(chi());
    expect(hashOf(chi({ systemLogs: { retentionDays: 30 } }))).toBe(before);
    expect(hashOf(chi({ systemLogs: { ttl: false } }))).toBe(before);
  });

  it('hashes each zone template on its own, so adding a zone leaves the others alone', () => {
    const hashesOf = (installation: ReturnType<typeof clickHouseInstallation>) =>
      Object.fromEntries(
        (installation.spec.templates?.podTemplates ?? []).map((template) => [
          template.name,
          (template.spec as { containers: { env?: Env }[] }).containers[0]?.env?.find(
            (entry) => entry.name === CLICKHOUSE_POD_TEMPLATE_HASH_ENV
          )?.value ?? 'missing',
        ])
      ) as Record<string, string>;
    const two = hashesOf(
      chi({ replicas: 2, zones: ['us-east-2a', 'us-east-2b'] } as Partial<InstallationConfig>)
    );
    const three = hashesOf(
      chi({
        replicas: 3,
        zones: ['us-east-2a', 'us-east-2b', 'us-east-2c'],
      } as Partial<InstallationConfig>)
    );
    const names = Object.keys(two);
    expect(names).toHaveLength(2);
    // Different affinity, different template, different digest.
    expect(two[names[0] as string]).not.toBe(two[names[1] as string]);
    // The existing zones' templates are unchanged, so their digests are too:
    // adding a zone must not restart the replicas already running.
    for (const name of names) expect(three[name]).toBe(two[name] as string);
    expect(Object.keys(three)).toHaveLength(3);
  });

  it('hashes a schema reference by what it points at, without resolving it', () => {
    const ref = (fieldPath: string) =>
      ({ [KUBERNETES_REF_BRAND]: true, resourceId: '__schema__', fieldPath }) as unknown;
    const a = clickHousePodTemplateHash({ podSpec: { image: ref('spec.version') } });
    expect(a).toBe(clickHousePodTemplateHash({ podSpec: { image: ref('spec.version') } }));
    expect(a).not.toBe(clickHousePodTemplateHash({ podSpec: { image: ref('spec.image') } }));
  });

  it('renders into the RGD of a KRO-mode cluster', () => {
    const yaml = makeClickHouseCluster({ storage: IRSA_S3 }).toYaml();
    expect(yaml).toMatch(
      new RegExp(`name: ${CLICKHOUSE_POD_TEMPLATE_HASH_ENV}\\s+value: '?[0-9a-f]{16}'?`)
    );
  });
});
