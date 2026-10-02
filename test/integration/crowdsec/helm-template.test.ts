/**
 * Render the mapped values with `helm template` against the pinned chart.
 *
 * The chart validates values against its own `values.schema.json` and fails
 * on missing acquisitions, so a clean render proves the values tree is one
 * chart 0.24.2 accepts. Skips without `helm` or network access;
 * `REQUIRE_HELM_TESTS=true` fails instead.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, loadAll } from 'js-yaml';

import {
  type CrowdsecBootstrapOptions,
  DEFAULT_CROWDSEC_CHART_VERSION,
  DEFAULT_CROWDSEC_REPOSITORY_URL,
  mapCrowdsecConfigToHelmValues,
} from '../../../src/factories/crowdsec/index.js';

interface Manifest {
  kind?: string;
  metadata?: { name?: string };
  spec?: Record<string, unknown>;
  data?: Record<string, string>;
}

const workDir = mkdtempSync(join(tmpdir(), 'typekro-crowdsec-helm-'));
const chartDir = join(workDir, 'crowdsec');

function pullChart(): boolean {
  const result = Bun.spawnSync(
    [
      'helm',
      'pull',
      'crowdsec',
      '--repo',
      DEFAULT_CROWDSEC_REPOSITORY_URL,
      '--version',
      DEFAULT_CROWDSEC_CHART_VERSION,
      '--untar',
      '--untardir',
      workDir,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  return result.exitCode === 0;
}

const helmAvailable = Bun.which('helm') !== null && pullChart();
if (!helmAvailable && process.env.REQUIRE_HELM_TESTS === 'true') {
  throw new Error(
    'REQUIRE_HELM_TESTS=true but helm or the CrowdSec chart repository is unavailable'
  );
}
const describeOrSkip = helmAvailable ? describe : describe.skip;

function render(options: CrowdsecBootstrapOptions): Manifest[] {
  const values = mapCrowdsecConfigToHelmValues({ name: 'crowdsec' }, options);
  const valuesFile = join(workDir, `values-${crypto.randomUUID()}.yaml`);
  writeFileSync(valuesFile, dump(values));
  const result = Bun.spawnSync(
    ['helm', 'template', 'crowdsec', chartDir, '-n', 'crowdsec', '-f', valuesFile],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return loadAll(result.stdout.toString()).filter(
    (doc): doc is Manifest => doc !== null && typeof doc === 'object'
  );
}

const named = (manifests: Manifest[], kind: string, name: string) =>
  manifests.find((m) => m.kind === kind && m.metadata?.name === name);

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describeOrSkip(`helm template crowdsec ${DEFAULT_CROWDSEC_CHART_VERSION}`, () => {
  it('renders the defaults: SQLite LAPI, agent DaemonSet, no AppSec, no Ingress', () => {
    const manifests = render({});
    expect(named(manifests, 'Deployment', 'crowdsec-lapi')).toBeDefined();
    expect(named(manifests, 'DaemonSet', 'crowdsec-agent')).toBeDefined();
    expect(named(manifests, 'PersistentVolumeClaim', 'crowdsec-db-pvc')).toBeDefined();
    expect(manifests.some((m) => m.kind === 'Ingress')).toBe(false);
    expect(named(manifests, 'Deployment', 'crowdsec-appsec')).toBeUndefined();
    // CAPI is off, so no register Job runs.
    expect(manifests.some((m) => m.kind === 'Job')).toBe(false);
    const acquis = named(manifests, 'ConfigMap', 'acquis-configmap')?.data?.['acquis.yaml'];
    expect(acquis).toContain('/var/log/containers/traefik-*_traefik_*.log');
    expect(acquis).toContain('program: traefik');
  });

  it('renders the full policy with AppSec, allowlist and simulation', () => {
    const manifests = render({
      bouncers: [{ name: 'traefik', keySecretRef: { name: 'crowdsec-bouncer', key: 'api-key' } }],
      allowlist: { cidrs: ['198.51.100.0/24'] },
      simulation: { global: true, exclusions: ['crowdsecurity/http-cve-probing'] },
      appsec: { exclusions: [{ ruleId: 942100, pathPrefix: '/upload' }] },
      metrics: { serviceMonitor: false },
    });
    expect(named(manifests, 'Deployment', 'crowdsec-appsec')).toBeDefined();
    expect(named(manifests, 'ConfigMap', 'crowdsec-simulation')).toBeDefined();
    expect(named(manifests, 'ConfigMap', 'crowdsec-parsers-s02-enrich')).toBeDefined();
    expect(
      named(manifests, 'ConfigMap', 'crowdsec-appsec-postoverflows-s01-whitelist')
    ).toBeDefined();
    expect(
      named(manifests, 'ConfigMap', 'crowdsec-appsec-configs')?.data?.['typekro-appsec-policy.yaml']
    ).toContain('RemoveInBandRuleByID(942100)');
  });

  it('renders Postgres with three LAPI replicas and CAPI enrollment', () => {
    const manifests = render({
      storage: {
        type: 'postgres',
        host: 'postgres.db.svc.cluster.local',
        database: 'crowdsec',
        user: 'crowdsec',
        passwordSecretRef: { name: 'crowdsec-db', key: 'password' },
      },
      lapi: { replicas: 3 },
      centralApi: {
        communityBlocklist: true,
        enrollment: { keySecretRef: { name: 'crowdsec-enroll', key: 'key' } },
      },
    });
    const lapi = named(manifests, 'Deployment', 'crowdsec-lapi');
    expect(lapi?.spec?.replicas).toBe(3);
    expect(named(manifests, 'PersistentVolumeClaim', 'crowdsec-db-pvc')).toBeUndefined();
    expect(named(manifests, 'Job', 'crowdsec-capi-register-job')).toBeDefined();
    expect(named(manifests, 'Job', 'crowdsec-lapi-cscli-register-job')).toBeDefined();
  });
});
