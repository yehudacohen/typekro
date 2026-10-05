import { describe, expect, it } from 'bun:test';

import { KARPENTER_LABELS } from '../../../src/factories/karpenter/constants.js';
import { nodePool } from '../../../src/factories/karpenter/resources/node-pool.js';
import type { NodePoolSpec } from '../../../src/factories/karpenter/types.js';
import { validateNodePoolSpec } from '../../../src/factories/karpenter/utils/validation.js';

/** The resource's own data, without the proxy. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function spec(overrides: Partial<NodePoolSpec> = {}): NodePoolSpec {
  return {
    template: {
      spec: {
        nodeClassRef: { name: 'default' },
        requirements: [{ key: KARPENTER_LABELS.capacityType, operator: 'In', values: ['spot'] }],
      },
    },
    limits: { cpu: '100', memory: '400Gi' },
    ...overrides,
  };
}

describe('nodePool', () => {
  it('creates a cluster-scoped karpenter.sh/v1 NodePool', () => {
    const pool = nodePool({ name: 'general', spec: spec(), id: 'generalPool' });

    expect(pool.apiVersion).toBe('karpenter.sh/v1');
    expect(pool.kind).toBe('NodePool');
    expect(pool.metadata.name).toBe('general');
    expect(plain(pool.metadata)).toEqual({ name: 'general' });
  });

  it('defaults nodeClassRef group and kind to the AWS EC2NodeClass', () => {
    const pool = nodePool({ name: 'general', spec: spec() });

    expect(pool.spec.template.spec.nodeClassRef).toEqual({
      group: 'karpenter.k8s.aws',
      kind: 'EC2NodeClass',
      name: 'default',
    });
  });

  it('keeps an explicit nodeClassRef group and kind', () => {
    const pool = nodePool({
      name: 'custom',
      spec: spec({
        template: {
          spec: {
            nodeClassRef: { name: 'x', group: 'example.com', kind: 'ExampleNodeClass' },
            requirements: [],
          },
        },
      }),
    });

    expect(pool.spec.template.spec.nodeClassRef).toEqual({
      group: 'example.com',
      kind: 'ExampleNodeClass',
      name: 'x',
    });
  });

  it('passes the full spec through', () => {
    const full = spec({
      template: {
        metadata: { labels: { workload: 'batch' }, annotations: { team: 'data' } },
        spec: {
          nodeClassRef: { name: 'default' },
          requirements: [
            {
              key: KARPENTER_LABELS.instanceFamily,
              operator: 'In',
              values: ['c7g', 'm7g'],
              minValues: 2,
            },
            { key: KARPENTER_LABELS.instanceGeneration, operator: 'Gt', values: ['5'] },
            { key: KARPENTER_LABELS.zone, operator: 'NotIn', values: ['us-east-1e'] },
            { key: KARPENTER_LABELS.arch, operator: 'Exists' },
          ],
          taints: [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }],
          startupTaints: [{ key: 'node.example.com/initializing', effect: 'NoExecute' }],
          expireAfter: '168h',
          terminationGracePeriod: '1h',
        },
      },
      disruption: {
        consolidationPolicy: 'WhenEmpty',
        consolidateAfter: '30s',
        budgets: [{ nodes: '0', schedule: '@daily', duration: '2h', reasons: ['Drifted'] }],
      },
      weight: 50,
    });
    const pool = nodePool({ name: 'batch', spec: full, labels: { tier: 'batch' } });

    expect(pool.metadata.labels).toEqual({ tier: 'batch' });
    expect(pool.spec.template.spec.requirements).toHaveLength(4);
    expect(pool.spec.template.spec.startupTaints?.[0]?.effect).toBe('NoExecute');
    expect(pool.spec.disruption?.budgets?.[0]?.reasons).toEqual(['Drifted']);
    expect(pool.spec.limits).toEqual({ cpu: '100', memory: '400Gi' });
    expect(pool.spec.weight).toBe(50);
  });

  it('throws on validator errors', () => {
    expect(() =>
      nodePool({
        name: 'bad',
        spec: spec({
          template: {
            spec: {
              nodeClassRef: { name: 'default' },
              requirements: [{ key: KARPENTER_LABELS.capacityType, operator: 'In', values: [] }],
            },
          },
        }),
      })
    ).toThrow(/Invalid NodePool "bad".*'In' needs at least one value/);
  });
});

describe('nodePool readiness', () => {
  const evaluate = (live: unknown) =>
    nodePool({ name: 'p', spec: spec() }).readinessEvaluator?.(live);

  it('is not ready without status', () => {
    expect(evaluate({ metadata: { generation: 1 } })).toMatchObject({
      ready: false,
      reason: 'StatusMissing',
    });
  });

  it('is not ready without a Ready condition', () => {
    expect(
      evaluate({ status: { conditions: [{ type: 'NodeClassReady', status: 'True' }] } })
    ).toMatchObject({ ready: false, reason: 'ReadyConditionMissing' });
  });

  it('is ready on Ready=True for the current generation', () => {
    expect(
      evaluate({
        metadata: { generation: 2 },
        status: { conditions: [{ type: 'Ready', status: 'True', observedGeneration: 2 }] },
      })
    ).toMatchObject({ ready: true });
  });

  it('rejects a Ready=True left over from an earlier generation', () => {
    expect(
      evaluate({
        metadata: { generation: 3 },
        status: { conditions: [{ type: 'Ready', status: 'True', observedGeneration: 2 }] },
      })
    ).toMatchObject({ ready: false, reason: 'StaleCondition' });
  });

  it('reports the condition reason when not ready', () => {
    expect(
      evaluate({
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              reason: 'NodeClassNotReady',
              message: 'EC2NodeClass default is not ready',
            },
          ],
        },
      })
    ).toEqual({
      ready: false,
      reason: 'NodeClassNotReady',
      message: 'EC2NodeClass default is not ready',
    });
  });
});

describe('validateNodePoolSpec', () => {
  const messages = (input: NodePoolSpec) => validateNodePoolSpec(input);

  it('accepts a well-formed pool', () => {
    expect(messages(spec())).toEqual([]);
  });

  it('warns on empty requirements and missing limits', () => {
    const { limits: _omit, ...withoutLimits } = spec();
    const issues = messages({
      ...withoutLimits,
      template: { spec: { nodeClassRef: { name: 'default' }, requirements: [] } },
    });

    expect(issues.map((issue) => [issue.severity, issue.path])).toEqual([
      ['warning', 'template.spec.requirements'],
      ['warning', 'limits'],
    ]);
  });

  it('errors on a missing nodeClassRef', () => {
    // @ts-expect-error nodeClassRef is required
    const broken: NodePoolSpec = { template: { spec: { requirements: [] } }, limits: {} };

    expect(messages(broken).filter((issue) => issue.severity === 'error')).toHaveLength(1);
    expect(messages(broken)[0]?.path).toBe('template.spec.nodeClassRef');
  });

  it('errors on malformed requirements', () => {
    const issues = messages(
      spec({
        template: {
          spec: {
            nodeClassRef: { name: 'default' },
            requirements: [
              { key: 'kubernetes.io/hostname', operator: 'Exists' },
              { key: KARPENTER_LABELS.instanceCpu, operator: 'Gt', values: ['4', '8'] },
              { key: KARPENTER_LABELS.instanceCpu, operator: 'Lt', values: ['many'] },
              {
                key: KARPENTER_LABELS.instanceFamily,
                operator: 'In',
                values: ['c7g'],
                minValues: 3,
              },
            ],
          },
        },
      })
    );

    expect(issues.map((issue) => issue.path)).toEqual([
      'template.spec.requirements[0].key',
      'template.spec.requirements[1].values',
      'template.spec.requirements[2].values',
      'template.spec.requirements[3].minValues',
    ]);
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true);
  });

  it('errors on a budget schedule without a duration and an out-of-range weight', () => {
    const issues = messages(
      spec({
        disruption: { consolidateAfter: '0s', budgets: [{ nodes: '0', schedule: '@daily' }] },
        weight: 101,
      })
    );

    expect(issues.map((issue) => issue.path)).toEqual(['disruption.budgets[0]', 'weight']);
  });

  it('errors on missing values, out-of-range minValues and a disruption without consolidateAfter', () => {
    const issues = messages(
      spec({
        template: {
          spec: {
            nodeClassRef: { name: 'default' },
            requirements: [
              { key: KARPENTER_LABELS.capacityType, operator: 'In' },
              { key: KARPENTER_LABELS.instanceCpu, operator: 'Gt' },
              { key: KARPENTER_LABELS.instanceFamily, operator: 'Exists', minValues: 51 },
            ],
          },
        },
        // @ts-expect-error consolidateAfter is required when disruption is set
        disruption: { consolidationPolicy: 'WhenEmpty' },
      })
    );

    expect(issues.map((issue) => issue.path)).toEqual([
      'template.spec.requirements[0].values',
      'template.spec.requirements[1].values',
      'template.spec.requirements[2].minValues',
      'disruption.consolidateAfter',
    ]);
  });
});

describe('validateNodePoolSpec: names and CRD mirrors', () => {
  const paths = (input: NodePoolSpec, name?: string) =>
    validateNodePoolSpec(input, name)
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.path);
  const withTemplate = (
    template: Partial<NodePoolSpec['template']['spec']>,
    labels?: Record<string, string>
  ) => {
    const base = spec();
    return spec({
      template: {
        ...(labels ? { metadata: { labels } } : {}),
        spec: { ...base.template.spec, ...template },
      },
    });
  };

  it('caps the name at 63, the karpenter.sh/nodepool label value', () => {
    expect(paths(spec(), 'a'.repeat(63))).toEqual([]);
    expect(paths(spec(), 'a'.repeat(64))).toEqual(['name']);
    expect(() => nodePool({ name: 'a'.repeat(64), spec: spec() })).toThrow(
      /NodePool name is 64 characters/
    );
    // Names only known at reconcile time are skipped.
    expect(paths(spec(), `__KUBERNETES_REF___schema___spec.name__${'a'.repeat(60)}`)).toEqual([]);
  });

  it('rejects restricted label domains in requirements and template labels', () => {
    const requirement = (key: string) =>
      paths(
        withTemplate({
          requirements: [
            { key: KARPENTER_LABELS.capacityType, operator: 'In', values: ['spot'] },
            { key, operator: 'Exists' },
          ],
        })
      );
    expect(requirement('karpenter.sh/nodeclaim')).toEqual(['template.spec.requirements[1].key']);
    expect(requirement('example.karpenter.sh/x')).toEqual(['template.spec.requirements[1].key']);
    expect(requirement('karpenter.k8s.aws/made-up')).toEqual(['template.spec.requirements[1].key']);
    expect(requirement('karpenter.k8s.aws/instance-gpu-count')).toEqual([]);
    expect(requirement('karpenter.k8s.aws/capacity-reservation-id')).toEqual([]);
    expect(requirement('kubernetes.io/hostname')).toEqual(['template.spec.requirements[1].key']);
    expect(requirement('example.com/team')).toEqual([]);

    expect(paths(withTemplate({}, { 'karpenter.sh/nodepool': 'x' }))).toEqual([
      'template.metadata.labels.karpenter.sh/nodepool',
    ]);
    expect(paths(withTemplate({}, { 'karpenter.k8s.aws/foo': 'x', team: 'a' }))).toEqual([
      'template.metadata.labels.karpenter.k8s.aws/foo',
    ]);
    expect(paths(withTemplate({}, { 'karpenter.sh/capacity-type': 'spot' }))).toEqual([]);
  });

  it('checks durations and budget values against the CRD patterns', () => {
    expect(paths(withTemplate({ expireAfter: '720h', terminationGracePeriod: '48h' }))).toEqual([]);
    expect(paths(withTemplate({ expireAfter: 'Never' }))).toEqual([]);
    expect(paths(withTemplate({ expireAfter: '30d' }))).toEqual(['template.spec.expireAfter']);
    expect(paths(withTemplate({ terminationGracePeriod: 'Never' }))).toEqual([
      'template.spec.terminationGracePeriod',
    ]);
    expect(paths(spec({ disruption: { consolidateAfter: '1 minute' } }))).toEqual([
      'disruption.consolidateAfter',
    ]);
    expect(
      paths(
        spec({
          disruption: {
            consolidateAfter: '0s',
            budgets: [
              { nodes: '10%' },
              { nodes: '5', schedule: '@daily', duration: '1h30m' },
              { nodes: '101%' },
              { nodes: 'ten', schedule: '@daily', duration: '30s' },
            ],
          },
        })
      )
    ).toEqual([
      'disruption.budgets[2].nodes',
      'disruption.budgets[3].nodes',
      'disruption.budgets[3].duration',
    ]);
  });

  it('allows only limits.nodes and no weight on static NodePools', () => {
    const staticPool = (overrides: Partial<NodePoolSpec>) =>
      ({ ...spec(overrides), replicas: 3 }) as NodePoolSpec;
    expect(paths(staticPool({ limits: { nodes: '5' } }))).toEqual([]);
    expect(paths(staticPool({ limits: { cpu: '100' } }))).toEqual(['limits']);
    expect(paths(staticPool({ limits: { nodes: '5' }, weight: 10 }))).toEqual(['weight']);
    // No "no limits" warning for a static pool: replicas bound it.
    const { limits: _limits, ...unbounded } = spec();
    expect(
      validateNodePoolSpec({ ...unbounded, replicas: 3 } as NodePoolSpec).map((i) => i.path)
    ).toEqual([]);
  });
});
