/**
 * NodePool and EC2NodeClass in a composition: the KRO RGD templates, with the
 * schema references substituted, must equal the direct-mode manifests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import {
  KARPENTER_DISCOVERY_TAG,
  KARPENTER_LABELS,
} from '../../../src/factories/karpenter/constants.js';
import { ec2NodeClass } from '../../../src/factories/karpenter/resources/ec2-node-class.js';
import { nodePool } from '../../../src/factories/karpenter/resources/node-pool.js';
import { karpenterReady } from '../../../src/factories/karpenter/resources/readiness.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});
afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
});

const capacity = kubernetesComposition(
  {
    name: 'karpenter-capacity',
    kind: 'KarpenterCapacity',
    spec: type({ clusterName: 'string', nodeRole: 'string', spotCpuLimit: 'string' }),
    status: type({ ready: 'boolean', spotNodes: 'number' }),
  },
  (spec) => {
    const nodeClass = ec2NodeClass({
      name: 'default',
      spec: {
        role: spec.nodeRole,
        amiSelectorTerms: [{ alias: 'al2023@latest' }],
        subnetSelectorTerms: [{ tags: { [KARPENTER_DISCOVERY_TAG]: spec.clusterName } }],
        securityGroupSelectorTerms: [{ tags: { [KARPENTER_DISCOVERY_TAG]: spec.clusterName } }],
        tags: { cluster: spec.clusterName },
      },
      id: 'defaultNodeClass',
    });
    const spot = nodePool({
      name: 'spot',
      spec: {
        template: {
          spec: {
            nodeClassRef: { name: 'default' },
            requirements: [
              { key: KARPENTER_LABELS.capacityType, operator: 'In', values: ['spot'] },
            ],
            taints: [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }],
          },
        },
        limits: { cpu: spec.spotCpuLimit },
      },
      id: 'spotPool',
    });
    return { ready: karpenterReady(nodeClass, spot), spotNodes: spot.status.nodes };
  }
);

const SPEC = { clusterName: 'demo', nodeRole: 'KarpenterNodeRole-demo', spotCpuLimit: '64' };

interface Doc {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    resources?: { id: string; template: Doc }[];
    schema?: { status?: Record<string, string> };
  };
}

function substitute(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = /^\$\{schema\.spec\.(\w+)\}$/.exec(value);
    return match ? SPEC[match[1] as keyof typeof SPEC] : value;
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, substitute(child)])
    );
  }
  return value;
}

describe('NodePool and EC2NodeClass — KRO/direct parity', () => {
  it('renders the same manifests in both modes', () => {
    const direct = loadAll(
      capacity.factory('direct', { namespace: 'default' }).toYaml(SPEC)
    ) as Doc[];
    const rgd = (loadAll(capacity.toYaml()) as Doc[]).find(
      (doc) => doc.kind === 'ResourceGraphDefinition'
    );
    const templates = (rgd?.spec?.resources ?? []).map((resource) => substitute(resource.template));

    const byName = (docs: unknown[]) =>
      Object.fromEntries((docs as Doc[]).map((doc) => [`${doc.kind}/${doc.metadata?.name}`, doc]));
    expect(byName(templates)).toEqual(byName(direct));
  });

  it('emits readiness and node count status from the owned resources', () => {
    const rgd = (loadAll(capacity.toYaml()) as Doc[]).find(
      (doc) => doc.kind === 'ResourceGraphDefinition'
    );
    const status = rgd?.spec?.schema?.status ?? {};

    expect(status.spotNodes).toBe('${spotPool.status.nodes}');
    expect(status.ready).toContain('defaultNodeClass.status.conditions');
    expect(status.ready).toContain('spotPool.metadata.generation');
  });

  it('keeps runtime values out of the structure', () => {
    const yaml = capacity.toYaml();
    expect(yaml).toContain('karpenter.sh/discovery: ${schema.spec.clusterName}');
    expect(yaml).toContain('role: ${schema.spec.nodeRole}');
    expect(yaml).toContain('cpu: ${schema.spec.spotCpuLimit}');
  });
});
