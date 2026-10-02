/**
 * `karpenterBootstrap`: serialization in direct and KRO mode (no cluster).
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
  karpenterBootstrap,
  makeKarpenterBootstrap,
} from '../../../src/factories/karpenter/compositions/karpenter-bootstrap.js';
import {
  DEFAULT_KARPENTER_CHART_VERSION,
  DEFAULT_KARPENTER_REPOSITORY_NAME,
  DEFAULT_KARPENTER_REPOSITORY_URL,
} from '../../../src/factories/karpenter/constants.js';
import { karpenterHelmRepository } from '../../../src/factories/karpenter/resources/helm.js';
import type { KarpenterBootstrapConfig } from '../../../src/factories/karpenter/types.js';
import { mapKarpenterConfigToHelmValues } from '../../../src/factories/karpenter/utils/helm-values-mapper.js';
import { validateKarpenterBootstrapConfig } from '../../../src/factories/karpenter/utils/validation.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-karpenter-'));
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
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
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
  dependsOn?: { name: string; namespace?: string }[];
  values?: Record<string, unknown>;
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

function release(docs: Doc[], name: string): ReleaseSpec {
  const found = docs.find((doc) => doc.kind === 'HelmRelease' && doc.metadata?.name === name);
  if (!found) throw new Error(`Missing HelmRelease ${name}`);
  return found.spec as unknown as ReleaseSpec;
}

function rgdResources(yaml: string, kind: string): RgdResource[] {
  const rgd = documents(yaml).find(
    (doc) =>
      doc.kind === 'ResourceGraphDefinition' &&
      (doc.spec?.schema as { kind?: string } | undefined)?.kind === kind
  );
  return (rgd?.spec?.resources ?? []) as RgdResource[];
}

function rgdStatus(yaml: string, kind: string): Record<string, string> {
  const rgd = documents(yaml).find(
    (doc) =>
      doc.kind === 'ResourceGraphDefinition' &&
      (doc.spec?.schema as { kind?: string } | undefined)?.kind === kind
  );
  return ((rgd?.spec?.schema as { status?: Record<string, string> }).status ?? {}) as Record<
    string,
    string
  >;
}

const SPEC: KarpenterBootstrapConfig = {
  name: 'karpenter',
  clusterName: 'demo',
  clusterEndpoint: 'https://ABCDEF.gr7.us-east-1.eks.amazonaws.com',
  interruptionQueue: 'demo',
  replicas: 3,
  logLevel: 'debug',
  dnsPolicy: 'Default',
  serviceAccount: {
    annotations: {
      'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/KarpenterController',
    },
  },
  podDisruptionBudget: { maxUnavailable: 2 },
  nodeSelector: { 'eks.amazonaws.com/nodegroup': 'system' },
  tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'system', effect: 'NoSchedule' }],
  resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '1Gi' } },
};

const direct = (spec: KarpenterBootstrapConfig = SPEC, composition = karpenterBootstrap) =>
  documents(composition.factory('direct', { namespace: 'flux-system' }).toYaml(spec));

describe('karpenterBootstrap — direct mode', () => {
  it('installs karpenter-crd first and the controller with its crds/ skipped', () => {
    const docs = direct();
    const crds = release(docs, 'karpenter-crd');
    const controller = release(docs, 'karpenter');

    expect(crds.chart.spec.chart).toBe('karpenter-crd');
    expect(crds.install.crds).toBeUndefined();
    expect(controller.chart.spec.chart).toBe('karpenter');
    expect(controller.install.crds).toBe('Skip');
    expect(controller.upgrade.crds).toBe('Skip');
    for (const spec of [crds, controller]) {
      expect(spec.chart.spec.version).toBe(DEFAULT_KARPENTER_CHART_VERSION);
      expect(spec.chart.spec.sourceRef).toEqual({
        kind: 'HelmRepository',
        name: DEFAULT_KARPENTER_REPOSITORY_NAME,
        namespace: 'flux-system',
      });
      expect(spec.targetNamespace).toBe('kube-system');
      expect(spec.install.createNamespace).toBe(true);
    }
    expect(controller.releaseName).toBe('karpenter');
    expect(crds.releaseName).toBe('karpenter-crd');
  });

  it('keeps the CRDs on uninstall by default', () => {
    expect(release(direct(), 'karpenter-crd').values).toEqual({
      additionalAnnotations: { 'helm.sh/resource-policy': 'keep' },
    });
    const removable = makeKarpenterBootstrap({ keepCrdsOnUninstall: false });
    expect(release(direct(SPEC, removable), 'karpenter-crd').values).toEqual({});
  });

  it('maps the spec onto chart values', () => {
    expect(release(direct(), 'karpenter').values).toEqual({
      fullnameOverride: 'karpenter',
      replicas: 3,
      logLevel: 'debug',
      dnsPolicy: 'Default',
      serviceAccount: {
        create: true,
        name: 'karpenter',
        annotations: {
          'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/KarpenterController',
        },
      },
      podDisruptionBudget: { maxUnavailable: 2 },
      nodeSelector: { 'eks.amazonaws.com/nodegroup': 'system' },
      affinity: {},
      topologySpreadConstraints: [
        {
          maxSkew: 1,
          topologyKey: 'topology.kubernetes.io/zone',
          whenUnsatisfiable: 'DoNotSchedule',
        },
      ],
      tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'system', effect: 'NoSchedule' }],
      controller: {
        resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '1Gi' } },
      },
      settings: {
        clusterName: 'demo',
        clusterEndpoint: 'https://ABCDEF.gr7.us-east-1.eks.amazonaws.com',
        interruptionQueue: 'demo',
      },
    });
  });

  it('applies chart defaults for omitted fields', () => {
    const values = release(direct({ name: 'karpenter', clusterName: 'demo' }), 'karpenter')
      .values as Record<string, unknown>;

    expect(values.replicas).toBe(2);
    expect(values.dnsPolicy).toBe('ClusterFirst');
    expect(values.tolerations).toEqual([{ key: 'CriticalAddonsOnly', operator: 'Exists' }]);
    expect(values.settings).toEqual({
      clusterName: 'demo',
      clusterEndpoint: '',
      interruptionQueue: '',
    });
    expect(values.serviceAccount).toEqual({ create: true, name: 'karpenter', annotations: {} });
    expect(values.controller).toEqual({
      resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '1Gi' } },
    });
  });

  it('sets no controller resources for resources: {}', () => {
    const values = release(direct({ ...SPEC, resources: {} }), 'karpenter').values as Record<
      string,
      unknown
    >;
    expect(values.controller).toEqual({ resources: {} });
  });

  it('makes Flux hold the controller until the CRD release is Ready', () => {
    const docs = direct();
    expect(release(docs, 'karpenter').dependsOn).toEqual([
      { name: 'karpenter-crd', namespace: 'flux-system' },
    ]);
    expect(release(docs, 'karpenter-crd').dependsOn).toBeUndefined();
    const external = direct(SPEC, makeKarpenterBootstrap({ crds: 'external' }));
    expect(release(external, 'karpenter').dependsOn).toBeUndefined();
  });

  it('honours a version override on both charts', () => {
    const docs = direct({ ...SPEC, version: '1.13.1' });
    expect(release(docs, 'karpenter-crd').chart.spec.version).toBe('1.13.1');
    expect(release(docs, 'karpenter').chart.spec.version).toBe('1.13.1');
  });

  it('installs only the controller when the CRDs are external', () => {
    const docs = direct(SPEC, makeKarpenterBootstrap({ crds: 'external' }));
    expect(
      docs.filter((doc) => doc.kind === 'HelmRelease').map((doc) => doc.metadata?.name)
    ).toEqual(['karpenter']);
    expect(release(docs, 'karpenter').install.crds).toBe('Skip');
  });

  it('owns the namespace only when asked', () => {
    expect(direct().some((doc) => doc.kind === 'Namespace')).toBe(false);
    const owned = direct(
      { ...SPEC, namespace: 'karpenter' },
      makeKarpenterBootstrap({ namespaceOwnership: 'owned' })
    );
    expect(owned.find((doc) => doc.kind === 'Namespace')?.metadata?.name).toBe('karpenter');
    expect(release(owned, 'karpenter').install.createNamespace).toBe(false);
  });

  it('deep-merges build-time raw values last', () => {
    const composition = makeKarpenterBootstrap({
      values: {
        settings: { featureGates: { spotToSpotConsolidation: true } },
        priorityClassName: 'system-node-critical',
        replicas: 4,
      },
    });
    const values = release(direct(SPEC, composition), 'karpenter').values as {
      settings: Record<string, unknown>;
      priorityClassName: string;
      replicas: number;
    };

    expect(values.settings).toMatchObject({
      clusterName: 'demo',
      featureGates: { spotToSpotConsolidation: true },
    });
    expect(values.priorityClassName).toBe('system-node-critical');
    expect(values.replicas).toBe(4);
  });

  it('references the shared repository instead of emitting it', () => {
    expect(direct().some((doc) => doc.kind === 'HelmRepository')).toBe(false);
  });
});

describe('karpenterBootstrap — kro mode', () => {
  const yaml = () => karpenterBootstrap.factory('kro', { namespace: 'flux-system' }).toYaml();

  it('emits both releases and the singleton repository reference', () => {
    const resources = rgdResources(yaml(), 'KarpenterBootstrap');
    expect(resources.map((resource) => resource.id)).toEqual(
      expect.arrayContaining(['karpenterCrdHelmRelease', 'karpenterHelmRelease'])
    );
    expect(resources.find((resource) => resource.externalRef)?.externalRef?.kind).toBe(
      'KarpenterHelmRepository'
    );
  });

  it('orders the controller after the CRD release', () => {
    const controller = rgdResources(yaml(), 'KarpenterBootstrap').find(
      (resource) => resource.id === 'karpenterHelmRelease'
    );
    expect(controller?.template?.metadata?.annotations).toEqual({
      'typekro.dev/depends-on-karpenterCrdHelmRelease': '${karpenterCrdHelmRelease.metadata.name}',
    });
  });

  it('templates the Flux dependsOn from the instance name', () => {
    const controller = rgdResources(yaml(), 'KarpenterBootstrap').find(
      (resource) => resource.id === 'karpenterHelmRelease'
    );
    expect((controller?.template?.spec as { dependsOn?: unknown }).dependsOn).toEqual([
      { name: '${schema.spec.name}-crd', namespace: 'flux-system' },
    ]);
  });

  it('defaults optional fields in CEL with the same fallbacks as direct mode', () => {
    const output = yaml();
    expect(output).toContain(`: "${DEFAULT_KARPENTER_CHART_VERSION}"`);
    expect(output).toContain(': "kube-system"');
    expect(output).toContain(': "ClusterFirst"');
    expect(output).toContain('"CriticalAddonsOnly"');
    expect(output).toContain('${schema.spec.name}-crd');
    expect(output).not.toContain('[object Object]');
    expect(output).not.toContain('__KUBERNETES_REF_');
  });

  it('produces the same chart values shape as direct mode', () => {
    const controller = rgdResources(yaml(), 'KarpenterBootstrap').find(
      (resource) => resource.id === 'karpenterHelmRelease'
    );
    const kroValues = (controller?.template?.spec as { values?: Record<string, unknown> }).values;
    const directValues = release(direct(SPEC), 'karpenter').values;
    const shape = (values: Record<string, unknown> | undefined) => {
      const sections = ['settings', 'serviceAccount', 'podDisruptionBudget', 'controller'];
      return {
        top: Object.keys(values ?? {}).sort(),
        ...Object.fromEntries(
          sections.map((key) => [key, Object.keys((values?.[key] as object) ?? {}).sort()])
        ),
      };
    };

    expect(shape(kroValues)).toEqual(shape(directValues));
  });

  it('derives status from both releases and the installed chart version', () => {
    const status = rgdStatus(yaml(), 'KarpenterBootstrap');
    for (const field of ['ready', 'failed', 'phase']) {
      expect(status[field]).toContain('karpenterCrdHelmRelease');
      expect(status[field]).toContain('karpenterHelmRelease');
    }
    expect(status.version).toContain('karpenterHelmRelease.status.history');
  });

  it('emits the singleton owner instance before the bootstrap instance', () => {
    const docs = documents(
      karpenterBootstrap.factory('kro', { namespace: 'flux-system' }).toYaml(SPEC)
    );
    const owner = docs.findIndex((doc) => doc.kind === 'KarpenterHelmRepository');
    const instance = docs.findIndex((doc) => doc.kind === 'KarpenterBootstrap');
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(owner).toBeLessThan(instance);
    expect(docs[owner]?.spec).toMatchObject({
      name: DEFAULT_KARPENTER_REPOSITORY_NAME,
      namespace: 'flux-system',
      url: DEFAULT_KARPENTER_REPOSITORY_URL,
    });
  });
});

describe('Karpenter Helm repository', () => {
  it('is an OCI repository for the official registry', () => {
    const repository = karpenterHelmRepository();
    expect(repository.spec.type).toBe('oci');
    expect(repository.spec.url).toBe('oci://public.ecr.aws/karpenter');
    expect(
      repository.readinessEvaluator?.({
        spec: { type: 'oci' },
        metadata: { generation: 1, resourceVersion: '1' },
      })
    ).toMatchObject({ ready: true });
  });
});

describe('mapKarpenterConfigToHelmValues', () => {
  it('never emits bootstrap-only fields as chart values', () => {
    const values = mapKarpenterConfigToHelmValues({ ...SPEC, namespace: 'x', version: '1.0.0' });
    expect(values).not.toHaveProperty('namespace');
    expect(values).not.toHaveProperty('version');
    expect(values).not.toHaveProperty('name');
  });

  it('replaces lists and ignores prototype keys in raw values', () => {
    const raw = JSON.parse('{"tolerations": [], "__proto__": {"polluted": true}}');
    const values = mapKarpenterConfigToHelmValues(SPEC, raw);
    expect(values.tolerations).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('validateKarpenterBootstrapConfig', () => {
  it('warns about a missing interruption queue, one replica, a permissive affinity and no requests', () => {
    const issues = validateKarpenterBootstrapConfig({
      name: 'karpenter',
      clusterName: 'demo',
      replicas: 1,
      affinity: { podAntiAffinity: {} },
      resources: {},
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'interruptionQueue',
      'replicas',
      'affinity',
      'resources.requests',
    ]);
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('accepts the recommended setup', () => {
    expect(validateKarpenterBootstrapConfig(SPEC)).toEqual([]);
  });

  it('does not warn about resources when the defaults apply', () => {
    const paths = validateKarpenterBootstrapConfig({
      name: 'karpenter',
      clusterName: 'demo',
      interruptionQueue: 'demo',
    }).map((issue) => issue.path);
    expect(paths).toEqual([]);
  });
});
