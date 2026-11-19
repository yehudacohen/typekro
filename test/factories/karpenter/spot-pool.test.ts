/**
 * karpenterSpotPool: the controller (through karpenterBootstrap), one
 * EC2NodeClass and one spot NodePool, checked against the published CRDs.
 */
import { describe, expect, it } from 'bun:test';
import { loadAll } from 'js-yaml';

import {
  assertPinnedAmiAlias,
  DEFAULT_SPOT_INSTANCE_FAMILIES,
  isPinnedAmiAlias,
  karpenterSpotPool,
} from '../../../src/factories/karpenter/index.js';
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
  it('lets a graph reference through to admission and refuses non-strings', () => {
    expect(() => assertPinnedAmiAlias(undefined)).not.toThrow();
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
      'string | pattern="^[a-z0-9]+@v[0-9][0-9A-Za-z._-]*$"'
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

  it('refuses an unpinned alias at admission, where the composition body never runs', () => {
    const yaml = karpenterSpotPool.toYaml();
    for (const amiAlias of ['al2023@latest', 'al2023', 'al2023@v20251117@foo']) {
      expect(admissionErrors(yaml, 'KarpenterSpotPool', { ...spec, amiAlias })).toEqual([
        `spec.amiAlias: ${JSON.stringify(amiAlias)} does not match ^[a-z0-9]+@v[0-9][0-9A-Za-z._-]*$`,
      ]);
    }
  });
});
