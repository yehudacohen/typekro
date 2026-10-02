import { describe, expect, it } from 'bun:test';

import { ec2NodeClass } from '../../../src/factories/karpenter/resources/ec2-node-class.js';
import type {
  EC2NodeClassSpec,
  EC2NodeClassSpecBase,
} from '../../../src/factories/karpenter/types.js';
import { validateEC2NodeClassSpec } from '../../../src/factories/karpenter/utils/validation.js';

/** The resource's own data, without the proxy. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const discovery = { 'karpenter.sh/discovery': 'demo' };

const base: EC2NodeClassSpecBase = {
  amiSelectorTerms: [{ alias: 'al2023@latest' }],
  subnetSelectorTerms: [{ tags: discovery }],
  securityGroupSelectorTerms: [{ tags: discovery }],
};

function spec(overrides: Partial<EC2NodeClassSpecBase> = {}): EC2NodeClassSpec {
  return { role: 'KarpenterNodeRole-demo', ...base, ...overrides };
}

describe('ec2NodeClass', () => {
  it('creates a cluster-scoped karpenter.k8s.aws/v1 EC2NodeClass', () => {
    const nodeClass = ec2NodeClass({ name: 'default', spec: spec(), id: 'defaultNodeClass' });

    expect(nodeClass.apiVersion).toBe('karpenter.k8s.aws/v1');
    expect(nodeClass.kind).toBe('EC2NodeClass');
    expect(plain(nodeClass.metadata)).toEqual({ name: 'default' });
    expect(nodeClass.spec.role).toBe('KarpenterNodeRole-demo');
  });

  it('leaves IMDS options to the CRD default', () => {
    expect(plain(ec2NodeClass({ name: 'default', spec: spec() }).spec)).not.toHaveProperty(
      'metadataOptions'
    );
  });

  it('passes the full spec through', () => {
    const nodeClass = ec2NodeClass({
      name: 'gpu',
      spec: {
        instanceProfile: 'KarpenterNodeInstanceProfile',
        amiFamily: 'AL2023',
        amiSelectorTerms: [
          { name: 'custom-al2023-*', owner: 'self' },
          { id: 'ami-0123456789abcdef0' },
        ],
        subnetSelectorTerms: [{ id: 'subnet-0123456789abcdef0' }],
        securityGroupSelectorTerms: [{ name: 'eks-nodes' }],
        blockDeviceMappings: [
          {
            deviceName: '/dev/xvda',
            rootVolume: true,
            ebs: {
              volumeSize: '200Gi',
              volumeType: 'gp3',
              iops: 6000,
              throughput: 250,
              encrypted: true,
            },
          },
        ],
        metadataOptions: {
          httpEndpoint: 'enabled',
          httpProtocolIPv6: 'disabled',
          httpPutResponseHopLimit: 2,
          httpTokens: 'required',
        },
        tags: { team: 'ml' },
        userData: 'MIME-Version: 1.0\n',
        kubelet: {
          maxPods: 58,
          systemReserved: { cpu: '100m', memory: '100Mi' },
          kubeReserved: { cpu: '200m', memory: '500Mi' },
          evictionHard: { 'memory.available': '5%' },
        },
        detailedMonitoring: true,
      },
    });

    expect(nodeClass.spec.instanceProfile).toBe('KarpenterNodeInstanceProfile');
    expect(nodeClass.spec.kubelet?.evictionHard).toEqual({ 'memory.available': '5%' });
    expect(nodeClass.spec.blockDeviceMappings?.[0]?.ebs?.iops).toBe(6000);
  });

  it('throws when both role and instanceProfile are set', () => {
    expect(() =>
      ec2NodeClass({
        name: 'bad',
        // @ts-expect-error role and instanceProfile are mutually exclusive
        spec: { ...base, role: 'role', instanceProfile: 'profile' },
      })
    ).toThrow(/exactly one of role or instanceProfile/);
  });

  it('evaluates readiness from the Ready condition', () => {
    const evaluator = ec2NodeClass({ name: 'default', spec: spec() }).readinessEvaluator;

    expect(
      evaluator?.({ status: { conditions: [{ type: 'Ready', status: 'True' }] } })
    ).toMatchObject({ ready: true });
    expect(
      evaluator?.({
        status: {
          conditions: [
            { type: 'Ready', status: 'False', reason: 'SubnetsNotFound', message: 'none' },
          ],
        },
      })
    ).toMatchObject({ ready: false, reason: 'SubnetsNotFound' });
  });
});

describe('validateEC2NodeClassSpec', () => {
  it('accepts a well-formed node class', () => {
    expect(validateEC2NodeClassSpec(spec())).toEqual([]);
  });

  it('warns when IMDSv1 is allowed', () => {
    expect(validateEC2NodeClassSpec(spec({ metadataOptions: { httpTokens: 'optional' } }))).toEqual(
      [expect.objectContaining({ severity: 'warning', path: 'metadataOptions.httpTokens' })]
    );
  });

  it('errors on neither role nor instanceProfile', () => {
    // @ts-expect-error one of role or instanceProfile is required
    const issues = validateEC2NodeClassSpec(base);
    expect(issues.map((issue) => issue.path)).toEqual(['role']);
  });

  it('errors on AMI selector mistakes', () => {
    const paths = (amiSelectorTerms: EC2NodeClassSpec['amiSelectorTerms']) =>
      validateEC2NodeClassSpec(spec({ amiSelectorTerms })).map((issue) => issue.path);

    expect(paths([])).toEqual(['amiSelectorTerms']);
    expect(paths([{ alias: 'al2023@latest' }, { id: 'ami-0123' }])).toContain(
      'amiSelectorTerms[0]'
    );
    expect(paths([{ owner: 'self' }])).toEqual(['amiSelectorTerms[0]', 'amiFamily']);
    expect(paths([{ name: 'my-ami' }])).toEqual(['amiFamily']);
  });

  it('errors on empty or field-less subnet and security group selectors', () => {
    const issues = validateEC2NodeClassSpec(
      spec({ subnetSelectorTerms: [], securityGroupSelectorTerms: [{}] })
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      'subnetSelectorTerms',
      'securityGroupSelectorTerms[0]',
    ]);
  });

  it('errors on more than one root volume', () => {
    const issues = validateEC2NodeClassSpec(
      spec({ blockDeviceMappings: [{ rootVolume: true }, { rootVolume: true }] })
    );
    expect(issues.map((issue) => issue.path)).toEqual(['blockDeviceMappings']);
  });

  it('errors on malformed aliases and an amiFamily that contradicts the alias', () => {
    const paths = (alias: string, amiFamily?: EC2NodeClassSpecBase['amiFamily']) =>
      validateEC2NodeClassSpec(
        spec({ amiSelectorTerms: [{ alias }], ...(amiFamily ? { amiFamily } : {}) })
      ).map((issue) => issue.path);

    expect(paths('al2023')).toEqual(['amiSelectorTerms[0].alias']);
    expect(paths('ubuntu@latest')).toEqual(['amiSelectorTerms[0].alias']);
    expect(paths('windows2022@v1')).toEqual(['amiSelectorTerms[0].alias']);
    expect(paths('windows2022@latest')).toEqual([]);
    expect(paths('bottlerocket@v1.30.0', 'AL2023')).toEqual(['amiFamily']);
    expect(paths('bottlerocket@v1.30.0', 'Custom')).toEqual([]);
    expect(paths('al2023@latest', 'AL2023')).toEqual([]);
  });

  it('errors on an EBS mapping with neither volumeSize nor snapshotID', () => {
    const issues = validateEC2NodeClassSpec(
      spec({ blockDeviceMappings: [{ deviceName: '/dev/xvdb', ebs: { volumeType: 'gp3' } }] })
    );
    expect(issues.map((issue) => issue.path)).toEqual(['blockDeviceMappings[0].ebs']);
  });

  it('passes the newer EC2NodeClass fields through', () => {
    const nodeClass = ec2NodeClass({
      name: 'efa',
      spec: spec({
        capacityReservationSelectorTerms: [
          { tags: { team: 'ml' }, instanceMatchCriteria: 'targeted' },
        ],
        placementGroupSelector: { name: 'training' },
        networkInterfaces: [
          { networkCardIndex: 0, deviceIndex: 0, interfaceType: 'interface' },
          { networkCardIndex: 1, deviceIndex: 0, interfaceType: 'efa-only' },
        ],
        ipPrefixCount: 1,
        cpuOptions: { nestedVirtualization: 'disabled' },
        connectionTracking: { tcpEstablishedTimeout: 3600 },
        context: 'arn:aws:outposts:us-east-1:111122223333:outpost/op-0123456789abcdef0',
        blockDeviceMappings: [
          {
            deviceName: '/dev/xvdb',
            ebs: { snapshotID: 'snap-0123456789abcdef0', volumeInitializationRate: 200 },
          },
        ],
      }),
    });
    const plainSpec = plain(nodeClass.spec) as Record<string, unknown>;
    expect(Object.keys(plainSpec)).toEqual(
      expect.arrayContaining([
        'capacityReservationSelectorTerms',
        'placementGroupSelector',
        'networkInterfaces',
        'ipPrefixCount',
        'cpuOptions',
        'connectionTracking',
        'context',
      ])
    );
  });
});
