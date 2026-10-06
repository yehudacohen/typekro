/**
 * `kedaBootstrap`: serialization in direct and KRO mode (no cluster).
 *
 * Runs under TYPEKRO_STRICT_CEL=1 with a hermetic kubeconfig, like the other
 * bootstrap suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';

import {
  kedaBootstrap,
  makeKedaBootstrap,
} from '../../../src/factories/keda/compositions/keda-bootstrap.js';
import {
  DEFAULT_KEDA_CHART_VERSION,
  DEFAULT_KEDA_REPOSITORY_NAME,
  DEFAULT_KEDA_REPOSITORY_URL,
} from '../../../src/factories/keda/constants.js';
import { kedaHelmRepository } from '../../../src/factories/keda/resources/helm.js';
import type { KedaBootstrapConfig } from '../../../src/factories/keda/types.js';
import { mapKedaConfigToHelmValues } from '../../../src/factories/keda/utils/helm-values-mapper.js';
import { validateKedaBootstrapConfig } from '../../../src/factories/keda/utils/validation.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-keda-'));
  const kubeconfigPath = join(kubeconfigDir, 'kubeconfig');
  writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- cluster: { server: "https://127.0.0.1:1" }',
      '  name: hermetic',
      'contexts:',
      '- context: { cluster: hermetic, user: hermetic }',
      '  name: hermetic',
      'current-context: hermetic',
      'users:',
      '- name: hermetic',
      '  user: {}',
      '',
    ].join('\n')
  );
  process.env.KUBECONFIG = kubeconfigPath;
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
  if (ORIGINAL_KUBECONFIG === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = ORIGINAL_KUBECONFIG;
  if (kubeconfigDir) rmSync(kubeconfigDir, { recursive: true, force: true });
});

interface Doc {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: Record<string, unknown>;
}

interface ReleaseSpec {
  chart: {
    spec: {
      chart: string;
      version: string;
      sourceRef: { kind: string; name: string; namespace: string };
    };
  };
  targetNamespace: string;
  releaseName: string;
  install: { crds?: string; createNamespace?: boolean };
  upgrade: { crds?: string };
  values: Record<string, Record<string, unknown>>;
}

interface RgdResource {
  id: string;
  template?: Doc;
  externalRef?: Doc;
}

function documents(yaml: string): Doc[] {
  return loadAll(yaml).filter(
    (document): document is Doc => document !== null && typeof document === 'object'
  );
}

function release(docs: Doc[]): ReleaseSpec {
  const found = docs.find((doc) => doc.kind === 'HelmRelease');
  if (!found) throw new Error('Missing HelmRelease');
  return found.spec as unknown as ReleaseSpec;
}

function rgd(yaml: string, kind: string): Doc | undefined {
  return documents(yaml).find(
    (doc) =>
      doc.kind === 'ResourceGraphDefinition' &&
      (doc.spec?.schema as { kind?: string } | undefined)?.kind === kind
  );
}

const SPEC: KedaBootstrapConfig = {
  name: 'keda',
  namespace: 'autoscaling',
  watchNamespace: 'shop,jobs',
  logFormat: 'json',
  operator: {
    replicas: 2,
    resources: { requests: { cpu: '200m', memory: '256Mi' }, limits: { memory: '1Gi' } },
    podDisruptionBudget: { minAvailable: 1 },
    nodeSelector: { 'node-role.example.com/system': 'true' },
    tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'system', effect: 'NoSchedule' }],
    topologySpreadConstraints: [
      {
        maxSkew: 1,
        topologyKey: 'topology.kubernetes.io/zone',
        whenUnsatisfiable: 'ScheduleAnyway',
      },
    ],
    logLevel: 'debug',
    serviceAccountAnnotations: { 'example.com/owner': 'platform' },
  },
  metricsServer: { replicas: 2, podDisruptionBudget: { maxUnavailable: 1 } },
  webhooks: { failurePolicy: 'Fail', replicas: 2 },
  podIdentity: {
    awsIrsa: { enabled: true, roleArn: 'arn:aws:iam::111122223333:role/keda-operator' },
  },
  priorityClassName: 'system-cluster-critical',
};

const direct = (spec: KedaBootstrapConfig = SPEC, composition = kedaBootstrap) =>
  documents(composition.factory('direct', { namespace: 'flux-system' }).toYaml(spec));

describe('kedaBootstrap — direct mode', () => {
  it('installs the pinned kedacore chart, CRDs included', () => {
    const spec = release(direct());
    expect(spec.chart.spec.chart).toBe('keda');
    expect(spec.chart.spec.version).toBe(DEFAULT_KEDA_CHART_VERSION);
    expect(spec.chart.spec.sourceRef).toEqual({
      kind: 'HelmRepository',
      name: DEFAULT_KEDA_REPOSITORY_NAME,
      namespace: 'flux-system',
    });
    // The chart renders its CRDs as templates.
    expect(spec.install.crds).toBeUndefined();
    expect(spec.targetNamespace).toBe('autoscaling');
    expect(spec.releaseName).toBe('keda');
    expect(spec.install.createNamespace).toBe(true);
  });

  it('renders its lifecycle policy through the shared helper, with caller overrides', () => {
    const lifecycle = (spec: ReleaseSpec) => {
      const { install, upgrade, driftDetection, timeout } = spec as unknown as Record<
        string,
        unknown
      >;
      return { timeout, install, upgrade, driftDetection };
    };
    expect(lifecycle(release(direct()))).toEqual({
      timeout: '10m',
      install: { remediation: { retries: 3 }, createNamespace: true },
      upgrade: { remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' } },
      driftDetection: { mode: 'enabled' },
    });

    const tuned = makeKedaBootstrap({
      install: { timeout: '20m' },
      upgrade: { remediation: { retries: 5 } },
      driftDetection: { mode: 'warn' },
    });
    expect(lifecycle(release(direct(SPEC, tuned)))).toEqual({
      timeout: '10m',
      install: { timeout: '20m', remediation: { retries: 3 }, createNamespace: true },
      upgrade: { remediation: { retries: 5, remediateLastFailure: true, strategy: 'rollback' } },
      driftDetection: { mode: 'warn' },
    });
  });

  it('maps every component onto the chart layout', () => {
    const values = release(direct()).values;
    expect(values.watchNamespace as unknown).toBe('shop,jobs');
    expect(values.priorityClassName as unknown).toBe('system-cluster-critical');
    expect(values.operator).toEqual({
      replicaCount: 2,
      nodeSelector: { 'node-role.example.com/system': 'true' },
      tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'system', effect: 'NoSchedule' }],
      affinity: {},
    });
    expect(values.webhooks).toMatchObject({
      enabled: true,
      failurePolicy: 'Fail',
      replicaCount: 2,
    });
    expect(values.resources?.operator).toEqual({
      requests: { cpu: '200m', memory: '256Mi' },
      limits: { memory: '1Gi' },
    });
    expect(values.podDisruptionBudget).toEqual({
      operator: { minAvailable: 1 },
      metricServer: { maxUnavailable: 1 },
      webhooks: {},
    });
    expect(values.topologySpreadConstraints?.operator).toHaveLength(1);
    expect(values.logging).toEqual({
      operator: { level: 'debug', format: 'json' },
      metricServer: { zapLevel: 'info', zapEncoder: 'json' },
      webhooks: { level: 'info', format: 'json' },
    });
    expect(values.serviceAccount).toEqual({
      operator: { annotations: { 'example.com/owner': 'platform' } },
    });
    expect(values.podIdentity?.aws).toEqual({
      irsa: { enabled: true, roleArn: 'arn:aws:iam::111122223333:role/keda-operator' },
    });
  });

  it('defaults to one replica each, the chart resources and no PDB', () => {
    const values = release(direct({ name: 'keda' })).values;
    for (const component of ['operator', 'metricsServer', 'webhooks']) {
      expect(values[component]?.replicaCount).toBe(1);
    }
    for (const key of ['operator', 'metricServer', 'webhooks']) {
      expect(values.resources?.[key]).toEqual({
        requests: { cpu: '100m', memory: '100Mi' },
        limits: { cpu: '1', memory: '1000Mi' },
      });
      expect(values.podDisruptionBudget?.[key]).toEqual({});
    }
    expect(values.watchNamespace as unknown).toBe('');
    expect(values.certificates).toEqual({ certManager: { enabled: false } });
    expect(values.podIdentity?.aws).toEqual({ irsa: { enabled: false, roleArn: '' } });
    expect(release(direct({ name: 'keda' })).targetNamespace).toBe('keda');
  });

  it('keeps the CRDs on uninstall by default', () => {
    expect(release(direct()).values.crds).toEqual({
      install: true,
      additionalAnnotations: { 'helm.sh/resource-policy': 'keep' },
    });
    const removable = makeKedaBootstrap({ keepCrdsOnUninstall: false });
    expect(release(direct(SPEC, removable)).values.crds).toEqual({
      install: true,
      additionalAnnotations: {},
    });
  });

  it('owns the namespace only when asked', () => {
    expect(direct().some((doc) => doc.kind === 'Namespace')).toBe(false);
    const owned = direct(SPEC, makeKedaBootstrap({ namespaceOwnership: 'owned' }));
    expect(owned.find((doc) => doc.kind === 'Namespace')?.metadata?.name).toBe('autoscaling');
    expect(release(owned).install.createNamespace).toBe(false);
  });

  it('deep-merges build-time raw values last', () => {
    const composition = makeKedaBootstrap({
      values: { prometheus: { operator: { enabled: true } }, operator: { replicaCount: 3 } },
    });
    const values = release(direct(SPEC, composition)).values;
    expect(values.prometheus).toEqual({ operator: { enabled: true } });
    expect(values.operator?.replicaCount).toBe(3);
    expect(values.operator?.nodeSelector).toEqual({ 'node-role.example.com/system': 'true' });
  });

  it('references the shared repository instead of emitting it', () => {
    expect(direct().some((doc) => doc.kind === 'HelmRepository')).toBe(false);
  });
});

describe('kedaBootstrap — kro mode', () => {
  const yaml = () => kedaBootstrap.factory('kro', { namespace: 'flux-system' }).toYaml();

  it('emits the release and the singleton repository reference', () => {
    const resources = (rgd(yaml(), 'KedaBootstrap')?.spec?.resources ?? []) as RgdResource[];
    expect(resources.map((resource) => resource.id)).toContain('kedaHelmRelease');
    expect(resources.find((resource) => resource.externalRef)?.externalRef?.kind).toBe(
      'KedaHelmRepository'
    );
  });

  it('defaults optional fields in CEL with the same fallbacks as direct mode', () => {
    const output = yaml();
    expect(output).toContain(`: "${DEFAULT_KEDA_CHART_VERSION}"`);
    expect(output).toContain(': "keda"}');
    expect(output).toContain('"console"');
    expect(output).not.toContain('[object Object]');
    expect(output).not.toContain('__KUBERNETES_REF_');
  });

  it('produces the same chart values shape as direct mode', () => {
    const resources = (rgd(yaml(), 'KedaBootstrap')?.spec?.resources ?? []) as RgdResource[];
    const kroValues = (
      resources.find((resource) => resource.id === 'kedaHelmRelease')?.template?.spec as {
        values?: Record<string, unknown>;
      }
    ).values;
    const directValues = release(direct()).values;
    const shape = (values: Record<string, unknown> | undefined) =>
      Object.fromEntries(
        Object.entries(values ?? {}).map(([key, value]) => [
          key,
          value && typeof value === 'object' ? Object.keys(value).sort() : 'leaf',
        ])
      );
    expect(shape(kroValues)).toEqual(shape(directValues));
  });

  it('derives status from the release and the installed chart version', () => {
    const status = (
      rgd(yaml(), 'KedaBootstrap')?.spec?.schema as { status: Record<string, string> }
    ).status;
    for (const field of ['ready', 'failed', 'phase']) {
      expect(status[field]).toContain('kedaHelmRelease');
    }
    expect(status.version).toContain('kedaHelmRelease.status.history');
  });

  it('emits the singleton owner instance before the bootstrap instance', () => {
    const docs = documents(
      kedaBootstrap.factory('kro', { namespace: 'flux-system' }).toYaml({ name: 'keda' })
    );
    const owner = docs.findIndex((doc) => doc.kind === 'KedaHelmRepository');
    const instance = docs.findIndex((doc) => doc.kind === 'KedaBootstrap');
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(owner).toBeLessThan(instance);
    expect(docs[owner]?.spec).toMatchObject({
      name: DEFAULT_KEDA_REPOSITORY_NAME,
      namespace: 'flux-system',
      url: DEFAULT_KEDA_REPOSITORY_URL,
    });
  });
});

describe('KEDA Helm repository', () => {
  it('points at the kedacore charts', () => {
    const repository = kedaHelmRepository();
    expect(repository.spec.url).toBe('https://kedacore.github.io/charts');
    expect(
      repository.readinessEvaluator?.({
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      })
    ).toMatchObject({ ready: true });
  });
});

describe('mapKedaConfigToHelmValues', () => {
  it('never emits bootstrap-only fields as chart values', () => {
    const values = mapKedaConfigToHelmValues({ ...SPEC, version: '1.0.0' });
    expect(values).not.toHaveProperty('namespace');
    expect(values).not.toHaveProperty('version');
    expect(values).not.toHaveProperty('name');
  });

  it('replaces lists and ignores prototype keys in raw values', () => {
    const raw = JSON.parse('{"operator": {"tolerations": []}, "__proto__": {"polluted": true}}');
    const values = mapKedaConfigToHelmValues(SPEC, raw) as { operator: { tolerations: [] } };
    expect(values.operator.tolerations).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('validateKedaBootstrapConfig', () => {
  it('warns about disabled webhooks, a blocking PDB and IRSA without a role', () => {
    const issues = validateKedaBootstrapConfig({
      name: 'keda',
      webhooks: { enabled: false },
      operator: { podDisruptionBudget: { minAvailable: 1 } },
      podIdentity: { awsIrsa: { enabled: true } },
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'webhooks.enabled',
      'operator.podDisruptionBudget.minAvailable',
      'podIdentity.awsIrsa.roleArn',
    ]);
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('accepts the default and the documented HA setups', () => {
    expect(validateKedaBootstrapConfig({ name: 'keda' })).toEqual([]);
    expect(validateKedaBootstrapConfig(SPEC)).toEqual([]);
  });
});
