import { describe, expect, it } from 'bun:test';
import { mapAwsLoadBalancerControllerConfigToHelmValues } from '../../../src/factories/aws-load-balancer-controller/index.js';

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
    const values = mapAwsLoadBalancerControllerConfigToHelmValues({
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
    });
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

  it('lays build-time values over the mapped ones: a set key replaces, serviceAccount merges', () => {
    const values = mapAwsLoadBalancerControllerConfigToHelmValues(
      {
        name: 'lbc',
        clusterName: 'prod',
        serviceAccount: { annotations: { a: '1' } },
        tolerations: [{ key: 'one', operator: 'Exists' }],
      },
      {
        serviceAccount: { automountServiceAccountToken: false, annotations: { b: '2' } },
        tolerations: [{ key: 'two', operator: 'Exists' }],
        defaultTargetType: 'instance',
        enableShield: false,
      }
    );
    expect(values.serviceAccount).toEqual({
      create: true,
      name: 'aws-load-balancer-controller',
      // A spec-derived value is replaced whole, as KRO mode has to.
      annotations: { b: '2' },
      automountServiceAccountToken: false,
    });
    expect(values.tolerations).toEqual([{ key: 'two', operator: 'Exists' }]);
    expect(values.defaultTargetType).toBe('instance');
    expect(values.enableShield).toBe(false);
  });

  it('replaces podDisruptionBudget as a whole, so its exclusive keys never combine', () => {
    const values = mapAwsLoadBalancerControllerConfigToHelmValues(
      { name: 'lbc', clusterName: 'prod', resources: { requests: { cpu: '100m' } } },
      {
        podDisruptionBudget: { minAvailable: 1 },
        resources: { limits: { memory: '256Mi' } },
      }
    );
    expect(values.podDisruptionBudget).toEqual({ minAvailable: 1 });
    expect(values.resources).toEqual({ limits: { memory: '256Mi' } });
  });

  it('ignores prototype keys in build-time values', () => {
    const overlay = JSON.parse('{"__proto__": {"polluted": true}, "logLevel": "info"}');
    const values = mapAwsLoadBalancerControllerConfigToHelmValues(
      { name: 'lbc', clusterName: 'prod' },
      overlay
    );
    expect(values.logLevel).toBe('info');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
