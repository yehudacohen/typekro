/**
 * `vpaBootstrap`: serialization in direct and KRO mode (no cluster).
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
  makeVpaBootstrap,
  vpaBootstrap,
} from '../../../src/factories/vpa/compositions/vpa-bootstrap.js';
import {
  DEFAULT_VPA_CHART_VERSION,
  DEFAULT_VPA_REPOSITORY_NAME,
  DEFAULT_VPA_REPOSITORY_URL,
  VPA_CERT_MANAGER_TLS_SECRET_KEYS,
} from '../../../src/factories/vpa/constants.js';
import { vpaHelmRepository } from '../../../src/factories/vpa/resources/helm.js';
import type { VpaBootstrapConfig } from '../../../src/factories/vpa/types.js';
import { mapVpaConfigToHelmValues } from '../../../src/factories/vpa/utils/helm-values-mapper.js';
import { validateVpaBootstrapConfig } from '../../../src/factories/vpa/utils/validation.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-vpa-'));
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

const SPEC: VpaBootstrapConfig = {
  name: 'vpa',
  namespace: 'autoscaling',
  recommender: {
    replicas: 1,
    resources: { requests: { cpu: '100m', memory: '1Gi' }, limits: { memory: '2Gi' } },
    nodeSelector: { 'node-role.example.com/system': 'true' },
    tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'system', effect: 'NoSchedule' }],
    logLevel: 2,
    podRecommendationMinCpuMillicores: 25,
    podRecommendationMinMemoryMb: 250,
    targetCpuPercentile: 0.95,
    memoryAggregationIntervalCount: 14,
  },
  updater: { minReplicas: 1, evictionTolerance: 0.25 },
  admissionController: {
    replicas: 2,
    podDisruptionBudget: { minAvailable: 1 },
    webhook: { failurePolicy: 'Ignore', timeoutSeconds: 10 },
  },
  priorityClassName: 'system-cluster-critical',
};

const direct = (spec: VpaBootstrapConfig = SPEC, composition = vpaBootstrap) =>
  documents(composition.factory('direct', { namespace: 'flux-system' }).toYaml(spec));

describe('vpaBootstrap — direct mode', () => {
  it('installs the pinned Fairwinds chart with Flux managing its crds/', () => {
    const spec = release(direct());
    expect(spec.chart.spec.chart).toBe('vpa');
    expect(spec.chart.spec.version).toBe(DEFAULT_VPA_CHART_VERSION);
    expect(spec.chart.spec.sourceRef).toEqual({
      kind: 'HelmRepository',
      name: DEFAULT_VPA_REPOSITORY_NAME,
      namespace: 'flux-system',
    });
    expect(spec.install.crds).toBe('CreateReplace');
    expect(spec.upgrade.crds).toBe('CreateReplace');
    expect(spec.targetNamespace).toBe('autoscaling');
    expect(spec.releaseName).toBe('vpa');
    expect(spec.install.createNamespace).toBe(true);
  });

  it('maps components, flags and placement onto chart values', () => {
    const values = release(direct()).values;
    expect(values.fullnameOverride as unknown).toBe('vpa');
    expect(values.priorityClassName as unknown).toBe('system-cluster-critical');
    expect(values.recommender).toMatchObject({
      enabled: true,
      replicaCount: 1,
      resources: { requests: { cpu: '100m', memory: '1Gi' }, limits: { memory: '2Gi' } },
      nodeSelector: { 'node-role.example.com/system': 'true' },
      tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'system', effect: 'NoSchedule' }],
      extraArgs: {
        v: 2,
        'pod-recommendation-min-cpu-millicores': 25,
        'pod-recommendation-min-memory-mb': 250,
        'target-cpu-percentile': 0.95,
        'target-memory-percentile': 0.9,
        'memory-aggregation-interval-count': 14,
        storage: 'checkpoint',
      },
    });
    expect(values.updater?.extraArgs).toEqual({ 'min-replicas': 1, 'eviction-tolerance': 0.25 });
    expect(values.admissionController).toMatchObject({
      enabled: true,
      replicaCount: 2,
      podDisruptionBudget: { minAvailable: 1 },
      registerWebhook: false,
      generateCertificate: true,
      mutatingWebhookConfiguration: { failurePolicy: 'Ignore', timeoutSeconds: 10 },
    });
  });

  it('defaults every component on, with the chart requests and a PDB', () => {
    const values = release(direct({ name: 'vpa' })).values;
    for (const [component, memory] of [
      ['recommender', '500Mi'],
      ['updater', '500Mi'],
      ['admissionController', '200Mi'],
    ] as const) {
      expect(values[component]).toMatchObject({
        enabled: true,
        replicaCount: 1,
        resources: { requests: { cpu: '50m', memory } },
        podDisruptionBudget: { maxUnavailable: 1 },
      });
    }
    expect(release(direct({ name: 'vpa' })).targetNamespace).toBe('vpa');
    expect(values.admissionController?.secretName).toBe(
      '{{ include "vpa.fullname" . }}-tls-secret'
    );
    expect(values['metrics-server']).toEqual({ enabled: false });
  });

  it('switches components off for a recommend-only install', () => {
    const values = release(
      direct({ name: 'vpa', updater: { enabled: false }, admissionController: { enabled: false } })
    ).values;
    expect(values.recommender?.enabled).toBe(true);
    expect(values.updater?.enabled).toBe(false);
    expect(values.admissionController?.enabled).toBe(false);
  });

  it('wires a cert-manager serving certificate', () => {
    const values = release(
      direct({
        name: 'vpa',
        admissionController: {
          certificate: {
            generate: false,
            secretName: 'vpa-webhook-tls',
            secretKeys: [...VPA_CERT_MANAGER_TLS_SECRET_KEYS],
          },
          webhook: { annotations: { 'cert-manager.io/inject-ca-from': 'vpa/vpa-webhook' } },
        },
      })
    ).values;
    expect(values.admissionController).toMatchObject({
      generateCertificate: false,
      secretName: 'vpa-webhook-tls',
      tlsSecretKeys: [
        { key: 'ca.crt', path: 'caCert.pem' },
        { key: 'tls.crt', path: 'serverCert.pem' },
        { key: 'tls.key', path: 'serverKey.pem' },
      ],
      mutatingWebhookConfiguration: {
        annotations: { 'cert-manager.io/inject-ca-from': 'vpa/vpa-webhook' },
      },
    });
  });

  it('honours a version override', () => {
    expect(release(direct({ ...SPEC, version: '5.0.1' })).chart.spec.version).toBe('5.0.1');
  });

  it('owns the namespace only when asked', () => {
    expect(direct().some((doc) => doc.kind === 'Namespace')).toBe(false);
    const owned = direct(SPEC, makeVpaBootstrap({ namespaceOwnership: 'owned' }));
    expect(owned.find((doc) => doc.kind === 'Namespace')?.metadata?.name).toBe('autoscaling');
    expect(release(owned).install.createNamespace).toBe(false);
  });

  it('deep-merges build-time raw values last', () => {
    const composition = makeVpaBootstrap({
      values: {
        admissionController: { extraArgs: { 'reload-cert': true } },
        updater: { replicaCount: 0 },
      },
    });
    const values = release(direct(SPEC, composition)).values;
    expect(values.admissionController?.extraArgs).toEqual({ 'reload-cert': true });
    expect(values.admissionController?.replicaCount).toBe(2);
    expect(values.updater?.replicaCount).toBe(0);
  });

  it('references the shared repository instead of emitting it', () => {
    expect(direct().some((doc) => doc.kind === 'HelmRepository')).toBe(false);
  });
});

describe('vpaBootstrap — kro mode', () => {
  const yaml = () => vpaBootstrap.factory('kro', { namespace: 'flux-system' }).toYaml();

  it('emits the release and the singleton repository reference', () => {
    const resources = (rgd(yaml(), 'VpaBootstrap')?.spec?.resources ?? []) as RgdResource[];
    expect(resources.map((resource) => resource.id)).toContain('vpaHelmRelease');
    expect(resources.find((resource) => resource.externalRef)?.externalRef?.kind).toBe(
      'VpaHelmRepository'
    );
  });

  it('defaults optional fields in CEL with the same fallbacks as direct mode', () => {
    const output = yaml();
    expect(output).toContain(`: "${DEFAULT_VPA_CHART_VERSION}"`);
    expect(output).toContain(': "vpa"}');
    expect(output).toContain('"checkpoint"');
    expect(output).toContain('. }}-tls-secret"}');
    expect(output).not.toContain('[object Object]');
    expect(output).not.toContain('__KUBERNETES_REF_');
  });

  it('produces the same chart values shape as direct mode', () => {
    const resources = (rgd(yaml(), 'VpaBootstrap')?.spec?.resources ?? []) as RgdResource[];
    const kroValues = (
      resources.find((resource) => resource.id === 'vpaHelmRelease')?.template?.spec as {
        values?: Record<string, unknown>;
      }
    ).values;
    const directValues = release(direct()).values;
    const shape = (values: Record<string, unknown> | undefined) => {
      const sections = ['recommender', 'updater', 'admissionController', 'serviceAccount'];
      return {
        top: Object.keys(values ?? {}).sort(),
        ...Object.fromEntries(
          sections.map((key) => [key, Object.keys((values?.[key] as object) ?? {}).sort()])
        ),
        recommenderArgs: Object.keys(
          ((values?.recommender as Record<string, unknown>)?.extraArgs as object) ?? {}
        ).sort(),
      };
    };
    expect(shape(kroValues)).toEqual(shape(directValues));
  });

  it('derives status from the release and the installed chart version', () => {
    const status = (rgd(yaml(), 'VpaBootstrap')?.spec?.schema as { status: Record<string, string> })
      .status;
    for (const field of ['ready', 'failed', 'phase']) {
      expect(status[field]).toContain('vpaHelmRelease');
    }
    expect(status.version).toContain('vpaHelmRelease.status.history');
  });

  it('emits the singleton owner instance before the bootstrap instance', () => {
    const docs = documents(
      vpaBootstrap.factory('kro', { namespace: 'flux-system' }).toYaml({ name: 'vpa' })
    );
    const owner = docs.findIndex((doc) => doc.kind === 'VpaHelmRepository');
    const instance = docs.findIndex((doc) => doc.kind === 'VpaBootstrap');
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(owner).toBeLessThan(instance);
    expect(docs[owner]?.spec).toMatchObject({
      name: DEFAULT_VPA_REPOSITORY_NAME,
      namespace: 'flux-system',
      url: DEFAULT_VPA_REPOSITORY_URL,
    });
  });
});

describe('VPA Helm repository', () => {
  it('points at the Fairwinds stable charts', () => {
    const repository = vpaHelmRepository();
    expect(repository.spec.url).toBe('https://charts.fairwinds.com/stable');
    expect(
      repository.readinessEvaluator?.({
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      })
    ).toMatchObject({ ready: true });
  });
});

describe('mapVpaConfigToHelmValues', () => {
  it('never emits bootstrap-only fields as chart values', () => {
    const values = mapVpaConfigToHelmValues({ ...SPEC, version: '1.0.0' });
    expect(values).not.toHaveProperty('namespace');
    expect(values).not.toHaveProperty('version');
    expect(values).not.toHaveProperty('name');
  });

  it('replaces lists and ignores prototype keys in raw values', () => {
    const raw = JSON.parse('{"recommender": {"tolerations": []}, "__proto__": {"polluted": true}}');
    const values = mapVpaConfigToHelmValues(SPEC, raw) as { recommender: { tolerations: [] } };
    expect(values.recommender.tolerations).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('validateVpaBootstrapConfig', () => {
  it('warns about an updater without the admission controller and parallel replicas', () => {
    const issues = validateVpaBootstrapConfig({
      name: 'vpa',
      recommender: { replicas: 2, storage: 'prometheus' },
      admissionController: { enabled: false },
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'updater.enabled',
      'recommender.replicas',
      'recommender.prometheusAddress',
    ]);
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('warns when the recommender is off', () => {
    expect(
      validateVpaBootstrapConfig({ name: 'vpa', recommender: { enabled: false } }).map(
        (issue) => issue.path
      )
    ).toEqual(['recommender.enabled']);
  });

  it('accepts the default and the recommend-only setups', () => {
    expect(validateVpaBootstrapConfig({ name: 'vpa' })).toEqual([]);
    expect(
      validateVpaBootstrapConfig({
        name: 'vpa',
        updater: { enabled: false },
        admissionController: { enabled: false },
      })
    ).toEqual([]);
  });
});
