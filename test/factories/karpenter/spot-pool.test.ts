/**
 * karpenterSpotPool: the controller (through karpenterBootstrap), one
 * EC2NodeClass and one spot NodePool, checked against the published CRDs.
 */
import { describe, expect, it } from 'bun:test';
import { type Type, type } from 'arktype';
import { loadAll } from 'js-yaml';

import { TypeKroError } from '../../../src/core/errors.js';
import {
  assertPinnedAmiAlias,
  DEFAULT_SPOT_INSTANCE_FAMILIES,
  isPinnedAmiAlias,
  type KarpenterSpotPoolConfig,
  karpenterSpotPool,
  PinnedAmiAliasSchema,
} from '../../../src/factories/karpenter/index.js';
import { Cel, kubernetesComposition, simple } from '../../../src/index.js';
import { admissionErrors } from '../../utils/kro-admission.js';
import { crdSchema, validate } from './crd-schema.js';

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec: Record<string, unknown>;
}

const spec = {
  name: 'karpenter',
  clusterName: 'platform',
  interruptionQueue: 'platform-karpenter',
  nodeRole: 'platform-karpenter-node',
  stableTaintKey: 'example.com/capacity-class',
  zones: ['us-east-1a', 'us-east-1b', 'us-east-1c'],
  amiAlias: 'al2023@v20251117',
};

async function render(input: Record<string, unknown> = spec): Promise<Manifest[]> {
  const factory = await karpenterSpotPool.factory('direct', { namespace: 'kube-system' });
  return (loadAll(factory.toYaml(input as typeof spec)) as Manifest[]).filter(Boolean);
}

function byKind(manifests: Manifest[], kind: string, name?: string): Manifest {
  const found = manifests.find(
    (item) => item.kind === kind && (name === undefined || item.metadata.name === name)
  );
  if (!found) throw new Error(`no ${kind} ${name ?? ''}`);
  return found;
}

type Requirement = { key: string; operator: string; values?: string[]; minValues?: number };
function requirement(pool: Manifest, key: string): Requirement | undefined {
  const template = pool.spec.template as { spec: { requirements: Requirement[] } };
  return template.spec.requirements.find((entry) => entry.key === key);
}

const crdErrors = (manifest: Manifest, file: string) =>
  validate(
    {
      apiVersion: manifest.apiVersion,
      kind: manifest.kind,
      metadata: manifest.metadata,
      spec: manifest.spec,
    },
    crdSchema(file)
  );

describe('karpenterSpotPool (direct mode)', () => {
  it('renders the controller, one EC2NodeClass and one spot NodePool', async () => {
    const kinds = (await render()).map((item) => `${item.kind}/${item.metadata.name}`).sort();
    expect(kinds).toContain('EC2NodeClass/karpenter');
    expect(kinds).toContain('NodePool/karpenter-spot');
    expect(kinds.filter((kind) => kind.startsWith('NodePool/'))).toEqual([
      'NodePool/karpenter-spot',
    ]);
    expect(kinds.filter((kind) => kind.startsWith('HelmRelease/')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('matches the published v1.15.2 NodePool and EC2NodeClass schemas', async () => {
    const manifests = await render();
    expect(crdErrors(byKind(manifests, 'NodePool'), 'karpenter.sh_nodepools.yaml')).toEqual([]);
    expect(
      crdErrors(byKind(manifests, 'EC2NodeClass'), 'karpenter.k8s.aws_ec2nodeclasses.yaml')
    ).toEqual([]);
  });

  it('passes the AWS names through and pins the AMI', async () => {
    const nodeClass = byKind(await render(), 'EC2NodeClass');
    expect(nodeClass.spec.role).toBe('platform-karpenter-node');
    expect(nodeClass.spec.amiSelectorTerms).toEqual([{ alias: 'al2023@v20251117' }]);
    expect(nodeClass.spec.subnetSelectorTerms).toEqual([
      { tags: { 'karpenter.sh/discovery': 'platform' } },
    ]);
    expect(nodeClass.spec.securityGroupSelectorTerms).toEqual(nodeClass.spec.subnetSelectorTerms);
  });

  it('the controller tolerates the caller-chosen stable taint and keeps the chart affinity', async () => {
    const controller = byKind(await render(), 'HelmRelease', 'karpenter');
    const values = controller.spec.values as {
      settings?: { clusterName?: string; interruptionQueue?: string };
      tolerations?: Array<{ key?: string }>;
      affinity?: unknown;
    };
    expect(values.settings).toMatchObject({
      clusterName: 'platform',
      interruptionQueue: 'platform-karpenter',
    });
    expect(values.tolerations?.map((toleration) => toleration.key)).toEqual([
      'CriticalAddonsOnly',
      'example.com/capacity-class',
    ]);
    // An empty map: Helm merges it with the chart's default affinity, which keeps
    // the controller off nodes that carry karpenter.sh/nodepool.
    expect(values.affinity).toEqual({});
  });

  it('sizes the controller from replicas and resources, keeping the bootstrap defaults otherwise', async () => {
    const controllerValues = async (input: Record<string, unknown>) =>
      byKind(await render(input), 'HelmRelease', 'karpenter').spec.values as {
        replicas?: number;
        controller?: { resources?: unknown };
      };

    const defaults = await controllerValues(spec);
    expect(defaults.replicas).toBe(2);
    expect(defaults.controller?.resources).toEqual({
      requests: { cpu: '1', memory: '1Gi' },
      limits: { memory: '1Gi' },
    });

    const resources = { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '768Mi' } };
    const sized = await controllerValues({ ...spec, replicas: 1, resources });
    expect(sized.replicas).toBe(1);
    expect(sized.controller?.resources).toEqual(resources);

    expect((await controllerValues({ ...spec, resources: {} })).controller?.resources).toEqual({});
  });

  it('prefers spot with on-demand fallback over at least 8 arm64 types', async () => {
    const pool = byKind(await render(), 'NodePool');
    expect(requirement(pool, 'karpenter.sh/capacity-type')?.values).toEqual(['spot', 'on-demand']);
    expect(requirement(pool, 'karpenter.k8s.aws/instance-family')?.values).toEqual(
      DEFAULT_SPOT_INSTANCE_FAMILIES
    );
    expect(requirement(pool, 'karpenter.k8s.aws/instance-size')?.values).toEqual([
      'large',
      'xlarge',
    ]);
    expect(requirement(pool, 'node.kubernetes.io/instance-type')).toEqual({
      key: 'node.kubernetes.io/instance-type',
      operator: 'Exists',
      minValues: 8,
    });
    expect(requirement(pool, 'kubernetes.io/arch')?.values).toEqual(['arm64']);
    expect(requirement(pool, 'topology.kubernetes.io/zone')?.values).toEqual(spec.zones);
    expect(pool.spec.limits).toEqual({ cpu: '16' });
    expect(pool.spec.disruption).toEqual({
      consolidationPolicy: 'WhenEmptyOrUnderutilized',
      consolidateAfter: '5m',
      budgets: [{ nodes: '1' }],
    });
  });

  it('bounds every disruption reason, node repair included, to one node at a time', async () => {
    // A budget without `reasons` applies to every reason the CRD lists. From 1.15 that
    // includes `Unhealthy` (node repair), so the pool never repairs more than one node at once.
    const budget = crdSchema('karpenter.sh_nodepools.yaml').properties?.spec?.properties?.disruption
      ?.properties?.budgets?.items;
    expect(budget?.properties?.reasons?.items?.enum).toEqual([
      'Underutilized',
      'Empty',
      'Drifted',
      'Unhealthy',
    ]);
    const pool = byKind(await render(), 'NodePool');
    const budgets = (pool.spec.disruption as { budgets: Record<string, unknown>[] }).budgets;
    expect(budgets.map((entry) => entry.reasons)).toEqual([undefined]);
  });

  it('refuses an unpinned AMI alias', async () => {
    await expect(render({ ...spec, amiAlias: 'al2023@latest' })).rejects.toThrow(
      'amiAlias must be pinned, like "al2023@v20251117"; got "al2023@latest".'
    );
  });
});

describe('pinned AMI aliases', () => {
  it('refuses a missing alias and non-strings', () => {
    expect(() => assertPinnedAmiAlias(undefined)).toThrow(
      'amiAlias must be pinned, like "al2023@v20251117"; got "undefined".'
    );
    expect(isPinnedAmiAlias(20251117)).toBe(false);
  });

  it('accepts versions and refuses latest, a missing version and a second @', () => {
    expect(isPinnedAmiAlias('al2023@v20251117')).toBe(true);
    expect(isPinnedAmiAlias('bottlerocket@v1.20.0')).toBe(true);
    for (const alias of ['al2023@latest', 'al2023', 'al2023@v20251117@foo']) {
      expect(isPinnedAmiAlias(alias)).toBe(false);
      expect(() => assertPinnedAmiAlias(alias)).toThrow(
        `amiAlias must be pinned, like "al2023@v20251117"; got "${alias}".`
      );
    }
  });
});

/** The code of the innermost TypeKroError `run` throws, through composition wrappers. */
function refusalCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    let code: string | undefined;
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      if (cause instanceof TypeKroError) code = cause.code;
    }
    return code ?? `untyped: ${String(error)}`;
  }
  return undefined;
}

describe('a pinned AMI alias from another composition spec', () => {
  const status = type({ ready: 'boolean' });

  /** Define and serialize a composition that checks `pick(spec)` as an alias. */
  const checked = (schema: Type<object>, pick: (spec: never) => unknown) => () =>
    kubernetesComposition(
      { name: 'alias-probe', kind: 'AliasProbe', spec: schema, status },
      (spec) => {
        assertPinnedAmiAlias(pick(spec as never));
        simple.ConfigMap({ id: 'config', name: 'probe', data: { a: 'b' } });
        return { ready: true };
      }
    ).toYaml();

  /** Define and serialize a composition that composes the spot pool with `pick(spec)`. */
  const composed = (schema: Type<object>, pick: (spec: never) => unknown) => () =>
    kubernetesComposition(
      { name: 'platform-capacity', kind: 'PlatformCapacity', spec: schema, status },
      (spec) => {
        karpenterSpotPool({
          ...(spec as unknown as KarpenterSpotPoolConfig),
          amiAlias: pick(spec as never) as string,
        });
        return { ready: true };
      }
    ).toYaml();

  const poolFields = {
    name: 'string',
    clusterName: 'string',
    interruptionQueue: 'string',
    nodeRole: 'string',
    stableTaintKey: 'string',
    zones: 'string[]',
  } as const;
  const fromAlias = (spec: { alias: unknown }) => spec.alias;

  it('accepts a reference to a required field declared with PinnedAmiAliasSchema', () => {
    expect(refusalCode(checked(type({ alias: PinnedAmiAliasSchema }), fromAlias))).toBeUndefined();
    expect(
      refusalCode(composed(type({ ...poolFields, alias: PinnedAmiAliasSchema }), fromAlias))
    ).toBeUndefined();
  });

  it('refuses at build time an alias from a field that does not carry the constraint', () => {
    const unguarded: [Type<object>, (spec: never) => unknown][] = [
      // An unconstrained string: an instance could send al2023@latest.
      [type({ alias: 'string' }), fromAlias],
      // The constrained type on an optional field: an instance could omit it.
      [type({ 'alias?': PinnedAmiAliasSchema }), fromAlias],
      // A CEL expression over the guarded field.
      [
        type({ alias: PinnedAmiAliasSchema }),
        (spec: { alias: unknown }) => Cel.expr('has(', spec.alias, ') ? ', spec.alias, " : ''"),
      ],
    ];
    for (const [schema, pick] of unguarded) {
      expect(refusalCode(checked(schema, pick))).toBe('KARPENTER_AMI_ALIAS_NOT_PINNED');
    }
    expect(refusalCode(composed(type({ ...poolFields, alias: 'string' }), fromAlias))).toBe(
      'KARPENTER_AMI_ALIAS_NOT_PINNED'
    );
  });

  it('refuses an optional field declared with PinnedAmiAliasSchema', () => {
    const optional = kubernetesComposition(
      {
        name: 'optional-alias',
        kind: 'OptionalAlias',
        spec: type({ 'alias?': PinnedAmiAliasSchema }),
        status,
      },
      () => {
        simple.ConfigMap({ id: 'config', name: 'probe', data: { a: 'b' } });
        return { ready: true };
      }
    );
    expect(() => optional.toYaml()).toThrow(/requires the field, but the field is optional/);
  });
});

describe('karpenterSpotPool (KRO mode)', () => {
  it('serializes with the taint key and AMI alias as required inputs', () => {
    const docs = loadAll(karpenterSpotPool.toYaml()) as Array<{
      kind: string;
      spec: { resources: Array<{ id: string }>; schema: { spec: Record<string, string> } };
    }>;
    const rgd = docs[docs.length - 1];
    if (!rgd) throw new Error('no RGD');
    expect(rgd.kind).toBe('ResourceGraphDefinition');
    const ids = rgd.spec.resources.map((resource) => resource.id);
    expect(ids).toContain('nodeClass');
    expect(ids).toContain('spotPool');
    expect(rgd.spec.schema.spec.stableTaintKey).toContain('string');
    expect(rgd.spec.schema.spec.amiAlias).toBe(
      'string | pattern="^[a-z0-9]+@v[0-9][0-9A-Za-z._-]*$" required=true'
    );
  });

  it('renders each template and default once, as valid CEL', () => {
    const yaml = karpenterSpotPool.toYaml();
    expect(yaml).not.toContain('${${');
    expect(yaml).not.toContain('has(has(');
    expect(yaml).toContain('name: ${schema.spec.name}-spot');
    expect(yaml).toContain('releaseName: ${schema.spec.name}-crd');
  });

  it('admits an instance with a pinned alias', () => {
    expect(admissionErrors(karpenterSpotPool.toYaml(), 'KarpenterSpotPool', spec)).toEqual([]);
  });

  it('passes controller replicas and resources through to the controller release', () => {
    const yaml = karpenterSpotPool.toYaml();
    const resources = { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '768Mi' } };
    expect(admissionErrors(yaml, 'KarpenterSpotPool', { ...spec, replicas: 1, resources })).toEqual(
      []
    );
    expect(yaml).toContain('schema.spec.replicas');
    expect(yaml).toContain('schema.spec.resources');
    expect(yaml).not.toContain('has(has(');
  });

  it('refuses a missing alias at admission', () => {
    const { amiAlias: _omitted, ...withoutAlias } = spec;
    expect(admissionErrors(karpenterSpotPool.toYaml(), 'KarpenterSpotPool', withoutAlias)).toEqual([
      'spec.amiAlias: Required value',
    ]);
  });

  it('refuses an unpinned alias at admission, where the composition body never runs', () => {
    const yaml = karpenterSpotPool.toYaml();
    for (const amiAlias of ['al2023@latest', 'al2023', 'al2023@v20251117@foo']) {
      expect(admissionErrors(yaml, 'KarpenterSpotPool', { ...spec, amiAlias })).toEqual([
        `spec.amiAlias: ${JSON.stringify(amiAlias)} does not match ^[a-z0-9]+@v[0-9][0-9A-Za-z._-]*$`,
      ]);
    }
  });
});
