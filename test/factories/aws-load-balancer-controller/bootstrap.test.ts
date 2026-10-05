/**
 * `awsLoadBalancerControllerBootstrap` in direct and KRO mode.
 *
 * The KRO side is evaluated per instance the way KRO would: each `${...}` in
 * the RGD's HelmRelease template is evaluated with `schema.spec` bound to the
 * instance spec, and `omit()` drops the field. The templates use a small CEL
 * subset (`has()` guards joined by `&&`, `dyn()`, `!= null`, ternaries, field
 * paths and literals), evaluated as JavaScript because cel-js, unlike KRO's
 * cel-go, does not absorb an error on the right of a false `&&`. Anything
 * outside the subset fails the test.
 */

import { describe, expect, it } from 'bun:test';
import { load, loadAll } from 'js-yaml';
import {
  awsLoadBalancerControllerBootstrap,
  makeAwsLoadBalancerControllerBootstrap,
} from '../../../src/factories/aws-load-balancer-controller/index.js';
import type { AwsLoadBalancerControllerBootstrapConfig } from '../../../src/factories/aws-load-balancer-controller/types.js';

const RELEASE_ID = 'awsLoadBalancerControllerHelmRelease';
const OMIT = Symbol('omit');
const CEL_SUBSET =
  /^(?:has\(|dyn\(|omit\(\)|schema\.spec(?:\.[A-Za-z_][A-Za-z0-9_]*)*|&&|!=|null|true|false|\?|:|\(|\)|\{|\}|,|"[^"\\]*"|-?\d+|\s+)+$/;

interface HelmReleaseDocument {
  kind: string;
  metadata: { name: string; namespace?: string };
  spec: Record<string, unknown> & { values?: Record<string, unknown> };
}

function lookup(spec: unknown, path: string): unknown {
  let node: unknown = { schema: { spec } };
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function evaluateCel(expression: string, spec: AwsLoadBalancerControllerBootstrapConfig): unknown {
  expect(expression).toMatch(CEL_SUBSET);
  const js = expression.replace(/has\((schema\.spec[.\w]*)\)/g, (_m, path: string) =>
    String(lookup(spec, path) !== undefined)
  );
  return new Function('schema', 'dyn', 'omit', `return (${js});`)(
    { spec },
    (value: unknown) => value,
    () => OMIT
  );
}

function instantiate(template: unknown, spec: AwsLoadBalancerControllerBootstrapConfig): unknown {
  if (typeof template === 'string') {
    const whole = /^\$\{([\s\S]*)\}$/.exec(template);
    if (whole?.[1]) return evaluateCel(whole[1], spec);
    expect(template).not.toContain('${');
    return template;
  }
  if (Array.isArray(template)) return template.map((item) => instantiate(item, spec));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(template)) {
      const value = instantiate(child, spec);
      if (value !== OMIT) out[key] = value;
    }
    return out;
  }
  return template;
}

type Bootstrap = typeof awsLoadBalancerControllerBootstrap;

function directRelease(
  spec: AwsLoadBalancerControllerBootstrapConfig,
  composition: Bootstrap = awsLoadBalancerControllerBootstrap
): HelmReleaseDocument {
  const yaml = composition.factory('direct', { namespace: 'default' }).toYaml(spec);
  const release = (loadAll(yaml) as HelmReleaseDocument[]).find((d) => d?.kind === 'HelmRelease');
  if (!release) throw new Error('direct render has no HelmRelease');
  return release;
}

function rgd(composition: Bootstrap = awsLoadBalancerControllerBootstrap): {
  spec: {
    resources: { id: string; template?: unknown }[];
    schema: { status: Record<string, string> };
  };
} {
  const docs = loadAll(composition.toYaml()) as {
    metadata: { name: string };
    spec: {
      resources: { id: string; template?: unknown }[];
      schema: { status: Record<string, string> };
    };
  }[];
  const bootstrap = docs.find((d) => d.metadata.name === 'aws-load-balancer-controller-bootstrap');
  if (!bootstrap) throw new Error('no bootstrap RGD');
  return bootstrap;
}

function kroRelease(
  spec: AwsLoadBalancerControllerBootstrapConfig,
  composition: Bootstrap = awsLoadBalancerControllerBootstrap
): HelmReleaseDocument {
  const template = rgd(composition).spec.resources.find((r) => r.id === RELEASE_ID)?.template;
  if (!template) throw new Error(`RGD has no ${RELEASE_ID}`);
  return instantiate(template, spec) as HelmReleaseDocument;
}

const SPECS: Record<string, AwsLoadBalancerControllerBootstrapConfig> = {
  minimal: { name: 'aws-load-balancer-controller', clusterName: 'prod' },
  customNamespace: {
    name: 'lbc',
    namespace: 'aws-lbc',
    chartVersion: '3.4.0',
    clusterName: 'staging',
  },
  full: {
    name: 'aws-load-balancer-controller',
    clusterName: 'prod',
    region: 'us-east-1',
    vpcId: 'vpc-0123456789abcdef0',
    replicaCount: 3,
    image: { repository: 'registry.example.com/eks/aws-load-balancer-controller' },
    serviceAccount: {
      name: 'lbc',
      annotations: { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/lbc' },
    },
    podDisruptionBudget: { minAvailable: 2 },
    topologySpreadConstraints: [
      {
        maxSkew: 1,
        topologyKey: 'topology.kubernetes.io/zone',
        whenUnsatisfiable: 'ScheduleAnyway',
        labelSelector: {
          matchLabels: { 'app.kubernetes.io/name': 'aws-load-balancer-controller' },
        },
      },
    ],
    enableServiceMutatorWebhook: true,
    createIngressClassResource: false,
    ingressClass: 'alb-internal',
    defaultTargetType: 'instance',
    resources: { requests: { cpu: '100m', memory: '128Mi' } },
    nodeSelector: { 'kubernetes.io/os': 'linux' },
    tolerations: [{ key: 'CriticalAddonsOnly', operator: 'Exists' }],
    logLevel: 'debug',
  },
};

describe('awsLoadBalancerControllerBootstrap', () => {
  for (const [name, spec] of Object.entries(SPECS)) {
    it(`${name}: KRO renders the same HelmRelease as direct mode`, () => {
      const direct = directRelease(spec);
      const kro = kroRelease(spec);
      expect(kro.spec.values).toEqual(direct.spec.values as Record<string, unknown>);
      for (const field of ['targetNamespace', 'releaseName', 'install', 'upgrade', 'chart']) {
        expect(kro.spec[field]).toEqual(direct.spec[field]);
      }
    });
  }

  it('applies the TypeKro defaults in KRO mode when the spec omits them', () => {
    const { spec } = kroRelease(SPECS.minimal as AwsLoadBalancerControllerBootstrapConfig);
    expect(spec.values).toEqual({
      clusterName: 'prod',
      serviceAccount: { create: true, name: 'aws-load-balancer-controller' },
      podDisruptionBudget: { maxUnavailable: 1 },
      enableServiceMutatorWebhook: false,
      defaultTargetType: 'ip',
      keepTLSSecret: true,
    });
    expect(spec.targetNamespace).toBe('kube-system');
    expect(spec.install).toMatchObject({ crds: 'CreateReplace' });
    expect(spec.upgrade).toMatchObject({ crds: 'CreateReplace' });
  });

  it('keeps replicas, PDB, spread constraints and service account settings in KRO mode', () => {
    const values = kroRelease(SPECS.full as AwsLoadBalancerControllerBootstrapConfig).spec
      .values as Record<string, unknown>;
    expect(values.replicaCount).toBe(3);
    expect(values.podDisruptionBudget).toEqual({ minAvailable: 2 });
    expect(values.topologySpreadConstraints).toEqual(SPECS.full?.topologySpreadConstraints);
    expect(values.serviceAccount).toEqual({
      create: true,
      name: 'lbc',
      annotations: { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/lbc' },
    });
    expect(values.enableServiceMutatorWebhook).toBe(true);
  });

  it('projects status from the HelmRelease, never from the spec', () => {
    const status = rgd().spec.schema.status;
    expect(Object.keys(status).sort()).toEqual(['failed', 'phase', 'ready', 'version']);
    for (const expression of Object.values(status)) {
      expect(expression).toContain(`${RELEASE_ID}.`);
      expect(expression).not.toContain('schema.spec');
    }
    expect(status.version).toContain(`${RELEASE_ID}.status.history`);
  });

  it('delegates the eks-charts HelmRepository to a singleton', () => {
    const docs = loadAll(awsLoadBalancerControllerBootstrap.toYaml()) as {
      metadata: { name: string };
    }[];
    expect(docs.map((d) => d.metadata.name)).toContain(
      'aws-load-balancer-controller-helm-repository'
    );
    const refs = rgd().spec.resources.filter((r) => !r.template);
    expect(refs).toHaveLength(1);
  });

  it('rejects a spec without clusterName', () => {
    expect(() =>
      awsLoadBalancerControllerBootstrap
        .factory('direct', { namespace: 'default' })
        .toYaml({ name: 'lbc' } as AwsLoadBalancerControllerBootstrapConfig)
    ).toThrow(/clusterName/);
  });
});

describe('makeAwsLoadBalancerControllerBootstrap', () => {
  it('applies build-time lifecycle options and raw values in both modes', () => {
    const composition = makeAwsLoadBalancerControllerBootstrap({
      name: 'lbc-custom',
      kind: 'LbcCustom',
      upgrade: { crds: 'Skip', timeout: '20m' },
      driftDetection: { mode: 'enabled' },
      values: { enableShield: false, serviceAccount: { automountServiceAccountToken: false } },
    });
    const directDocs = loadAll(
      composition
        .factory('direct', { namespace: 'default' })
        .toYaml({ name: 'lbc', clusterName: 'prod' })
    ) as HelmReleaseDocument[];
    const direct = directDocs.find((d) => d?.kind === 'HelmRelease');
    expect(direct?.spec.upgrade).toMatchObject({ crds: 'Skip', timeout: '20m' });
    expect(direct?.spec.driftDetection).toEqual({ mode: 'enabled' });
    expect(direct?.spec.values).toMatchObject({
      enableShield: false,
      serviceAccount: {
        create: true,
        name: 'aws-load-balancer-controller',
        automountServiceAccountToken: false,
      },
    });

    const kroYaml = load(
      composition
        .toYaml()
        .split('---')
        .find((d) => d.includes('kind: LbcCustom')) ?? ''
    ) as { spec: { resources: { id: string; template?: HelmReleaseDocument }[] } };
    const release = kroYaml.spec.resources.find((r) => r.id === RELEASE_ID)?.template;
    expect(release?.spec.upgrade).toMatchObject({ crds: 'Skip', timeout: '20m' });
    expect(release?.spec.values).toMatchObject({ enableShield: false });
  });
});

describe('build-time values overlay', () => {
  // Only values the spec does not map, plus a percentage PDB default.
  const overlaid = makeAwsLoadBalancerControllerBootstrap({
    values: {
      podDisruptionBudget: { maxUnavailable: '50%' },
      enableShield: false,
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [
              { matchExpressions: [{ key: 'arch', operator: 'In', values: ['arm64'] }] },
            ],
          },
        },
      },
      serviceAccount: { automountServiceAccountToken: false },
    },
  });

  for (const [name, spec] of Object.entries(SPECS)) {
    it(`renders the same values in KRO and direct mode: ${name}`, () => {
      const direct = directRelease(spec, overlaid).spec.values ?? {};
      expect(kroRelease(spec, overlaid).spec.values).toEqual(direct);
      // An instance PDB replaces the build-time default whole; never both fields.
      expect(direct.podDisruptionBudget).toEqual(
        spec.podDisruptionBudget ?? { maxUnavailable: '50%' }
      );
      expect(direct.serviceAccount).toMatchObject({ automountServiceAccountToken: false });
      // What the instance sets through the spec survives the overlay.
      if (spec.serviceAccount?.annotations) {
        expect(direct.serviceAccount).toMatchObject({
          annotations: spec.serviceAccount.annotations,
        });
      }
      if (spec.image) expect(direct.image).toEqual(spec.image);
    });
  }

  it('rejects build-time values that would drop an instance IRSA annotation or image', () => {
    expect(() =>
      makeAwsLoadBalancerControllerBootstrap({
        values: {
          serviceAccount: { annotations: { team: 'platform' } },
          image: { tag: 'v3.5.1' },
        },
      })
    ).toThrow(
      /values\.serviceAccount\.annotations, values\.image .*spec\.serviceAccount\.annotations, spec\.image/
    );
  });
});
