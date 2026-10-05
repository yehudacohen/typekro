import { describe, expect, it } from 'bun:test';
import { ValidationError } from '../../../src/core/errors.js';
import {
  type AwsLoadBalancerControllerBootstrapConfig,
  mapAwsLoadBalancerControllerConfigToHelmValues,
} from '../../../src/factories/aws-load-balancer-controller/index.js';

const FULL_SPEC: AwsLoadBalancerControllerBootstrapConfig = {
  name: 'lbc',
  namespace: 'aws-lbc',
  chartVersion: '3.4.0',
  clusterName: 'prod',
  region: 'us-east-1',
  vpcId: 'vpc-0123456789abcdef0',
  replicaCount: 3,
  image: { repository: 'registry.example.com/aws-load-balancer-controller', tag: 'v3.5.0' },
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
    },
  ],
  enableServiceMutatorWebhook: true,
  createIngressClassResource: false,
  ingressClass: 'alb-internal',
  defaultTargetType: 'instance',
  resources: { requests: { cpu: '100m' } },
  nodeSelector: { 'kubernetes.io/os': 'linux' },
  tolerations: [{ key: 'CriticalAddonsOnly', operator: 'Exists' }],
  logLevel: 'debug',
};

describe('mapAwsLoadBalancerControllerConfigToHelmValues', () => {
  it('maps a minimal spec to TypeKro defaults and leaves the rest to the chart', () => {
    expect(
      mapAwsLoadBalancerControllerConfigToHelmValues({ name: 'lbc', clusterName: 'prod' })
    ).toEqual({
      clusterName: 'prod',
      serviceAccount: { create: true, name: 'aws-load-balancer-controller' },
      podDisruptionBudget: { maxUnavailable: 1 },
      enableServiceMutatorWebhook: false,
      defaultTargetType: 'ip',
      keepTLSSecret: true,
    });
  });

  it('maps every typed field and keeps bootstrap-only fields out of the values', () => {
    const values = mapAwsLoadBalancerControllerConfigToHelmValues(FULL_SPEC);
    expect(values).toEqual({
      clusterName: 'prod',
      region: 'us-east-1',
      vpcId: 'vpc-0123456789abcdef0',
      replicaCount: 3,
      image: { repository: 'registry.example.com/aws-load-balancer-controller', tag: 'v3.5.0' },
      serviceAccount: {
        create: true,
        name: 'lbc',
        annotations: { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/lbc' },
      },
      podDisruptionBudget: { minAvailable: 2 },
      topologySpreadConstraints: [
        {
          maxSkew: 1,
          topologyKey: 'topology.kubernetes.io/zone',
          whenUnsatisfiable: 'ScheduleAnyway',
        },
      ],
      enableServiceMutatorWebhook: true,
      createIngressClassResource: false,
      ingressClass: 'alb-internal',
      defaultTargetType: 'instance',
      resources: { requests: { cpu: '100m' } },
      nodeSelector: { 'kubernetes.io/os': 'linux' },
      tolerations: [{ key: 'CriticalAddonsOnly', operator: 'Exists' }],
      logLevel: 'debug',
      keepTLSSecret: true,
    });
    for (const key of ['name', 'namespace', 'chartVersion']) {
      expect(Object.keys(values)).not.toContain(key);
    }
  });

  it('adds build-time values the spec does not map; serviceAccount takes extra fields', () => {
    const values = mapAwsLoadBalancerControllerConfigToHelmValues(
      { name: 'lbc', clusterName: 'prod', serviceAccount: { annotations: { a: '1' } } },
      {
        serviceAccount: { automountServiceAccountToken: false },
        enableShield: false,
        keepTLSSecret: false,
      }
    );
    expect(values.serviceAccount).toEqual({
      create: true,
      name: 'aws-load-balancer-controller',
      annotations: { a: '1' },
      automountServiceAccountToken: false,
    });
    expect(values.enableShield).toBe(false);
    // A TypeKro constant, not a spec value, so build-time values may change it.
    expect(values.keepTLSSecret).toBe(false);
  });

  it('rejects build-time values the spec maps, at any depth, naming the spec field', () => {
    const map = (overlay: Record<string, unknown>) => () =>
      mapAwsLoadBalancerControllerConfigToHelmValues({ name: 'lbc', clusterName: 'prod' }, overlay);
    expect(map({ image: { tag: 'v3.5.1' } })).toThrow(/values\.image .*spec\.image/);
    expect(map({ serviceAccount: { annotations: { team: 'platform' } } })).toThrow(
      /spec\.serviceAccount\.annotations/
    );
    expect(map({ serviceAccount: 'lbc' })).toThrow(ValidationError);
    expect(map({ resources: { limits: { memory: '256Mi' } } })).toThrow(ValidationError);

    // Every value the mapper derives from the spec is covered.
    const mapped = mapAwsLoadBalancerControllerConfigToHelmValues(FULL_SPEC);
    const paths = Object.entries(mapped).flatMap(([key, value]) =>
      key === 'serviceAccount' ? Object.keys(value as object).map((field) => [key, field]) : [[key]]
    );
    for (const path of paths) {
      const [key, field] = path as [string, string?];
      if (key === 'keepTLSSecret' || key === 'podDisruptionBudget') continue;
      expect(map(field ? { [key]: { [field]: 'x' } } : { [key]: 'x' })).toThrow(ValidationError);
    }
  });

  it('uses a build-time PDB as the default, which an instance PDB replaces whole', () => {
    const overlay = { podDisruptionBudget: { maxUnavailable: '50%' } };
    expect(
      mapAwsLoadBalancerControllerConfigToHelmValues({ name: 'lbc', clusterName: 'prod' }, overlay)
        .podDisruptionBudget
    ).toEqual({ maxUnavailable: '50%' });
    expect(
      mapAwsLoadBalancerControllerConfigToHelmValues(
        { name: 'lbc', clusterName: 'prod', podDisruptionBudget: { minAvailable: 1 } },
        overlay
      ).podDisruptionBudget
    ).toEqual({ minAvailable: 1 });
  });

  it('ignores prototype keys in build-time values', () => {
    const overlay = JSON.parse('{"__proto__": {"polluted": true}, "enableShield": false}');
    const values = mapAwsLoadBalancerControllerConfigToHelmValues(
      { name: 'lbc', clusterName: 'prod' },
      overlay
    );
    expect(values.enableShield).toBe(false);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.hasOwn(values, '__proto__')).toBe(false);
    expect((values as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
