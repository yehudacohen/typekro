import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { ValidationError } from '../../../src/core/errors.js';
import { getResourceScope } from '../../../src/core/metadata/resource-metadata.js';
import {
  ingressClassParams,
  type TargetGroupBindingSpec,
  targetGroupBinding,
  targetGroupBindingReadinessEvaluator,
} from '../../../src/factories/aws-load-balancer-controller/index.js';

const TARGET_GROUP_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/web/0123456789abcdef';
const serviceRef = { name: 'web', port: 80 };

describe('targetGroupBinding', () => {
  it('creates an elbv2.k8s.aws/v1beta1 TargetGroupBinding', () => {
    const binding = targetGroupBinding({
      name: 'web',
      namespace: 'apps',
      spec: {
        serviceRef: { name: 'web', port: 'http' },
        targetGroupARN:
          'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/web/0123456789abcdef',
        targetType: 'ip',
        targetGroupProtocol: 'HTTP',
        networking: {
          ingress: [
            {
              from: [{ securityGroup: { groupID: 'sg-0123456789abcdef0' } }],
              ports: [{ port: 8080 }],
            },
          ],
        },
      },
      id: 'webTargets',
    });
    expect(binding.apiVersion).toBe('elbv2.k8s.aws/v1beta1');
    expect(binding.kind).toBe('TargetGroupBinding');
    expect(binding.metadata.namespace).toBe('apps');
    expect(binding.spec.serviceRef).toEqual({ name: 'web', port: 'http' });
    expect(binding.spec.targetType).toBe('ip');
    expect(binding.spec.targetGroupProtocol).toBe('HTTP');
    expect(binding.readinessEvaluator).toBe(targetGroupBindingReadinessEvaluator);
  });

  it('accepts a target group by name, by ARN, or both', () => {
    const byName = targetGroupBinding({
      name: 'by-name',
      spec: { serviceRef, targetGroupName: 'web' },
    });
    expect(byName.spec.targetGroupName).toBe('web');
    const both = targetGroupBinding({
      name: 'both',
      spec: { serviceRef, targetGroupARN: TARGET_GROUP_ARN, targetGroupName: 'web' },
    });
    expect(both.spec.targetGroupARN).toBe(TARGET_GROUP_ARN);
    expect(both.spec.targetGroupName).toBe('web');
  });

  it('requires a target group in the type', () => {
    // @ts-expect-error neither targetGroupARN nor targetGroupName
    const missing: TargetGroupBindingSpec = { serviceRef };
    // @ts-expect-error both optional fields explicitly undefined
    const undefinedBoth: TargetGroupBindingSpec = {
      serviceRef,
      targetGroupARN: undefined,
      targetGroupName: undefined,
    };
    const byArn: TargetGroupBindingSpec = { serviceRef, targetGroupARN: TARGET_GROUP_ARN };
    const byName: TargetGroupBindingSpec = { serviceRef, targetGroupName: 'web' };
    expect([missing, undefinedBoth, byArn, byName]).toHaveLength(4);
    expect(() =>
      // @ts-expect-error the factory config carries the same requirement
      targetGroupBinding({ name: 'web', spec: { serviceRef, targetType: 'ip' } })
    ).toThrow(ValidationError);
  });

  it('rejects a binding with no target group at build time', () => {
    const build = (spec: Partial<TargetGroupBindingSpec>) => () =>
      targetGroupBinding({ name: 'web', spec: spec as TargetGroupBindingSpec });
    expect(build({ serviceRef })).toThrow(
      "TargetGroupBinding 'web' names no target group: set spec.targetGroupARN or spec.targetGroupName"
    );
    // The controller treats an empty string as unset.
    expect(build({ serviceRef, targetGroupARN: '', targetGroupName: '' })).toThrow(ValidationError);
    expect(build({ serviceRef, targetGroupARN: '', targetGroupName: 'web' })).not.toThrow();
  });

  it('accepts schema references, which only resolve per instance', () => {
    const graph = kubernetesComposition(
      {
        name: 'tgb-refs',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TgbRefs',
        spec: type({ service: 'string', targetGroupName: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        targetGroupBinding({
          id: 'binding',
          name: spec.service,
          spec: {
            serviceRef: { name: spec.service, port: 80 },
            targetGroupName: spec.targetGroupName,
          },
        });
        return { ready: true };
      }
    );
    expect(graph.toYaml()).toContain('targetGroupName: ${schema.spec.targetGroupName}');
  });

  const evaluate = (resource: unknown) => targetGroupBindingReadinessEvaluator(resource);

  it('is not ready before the controller has reconciled it', () => {
    expect(evaluate({ metadata: { generation: 1 } }).ready).toBe(false);
    expect(evaluate(null).ready).toBe(false);
  });

  it('is not ready while the reconciled generation is stale', () => {
    const result = evaluate({ metadata: { generation: 3 }, status: { observedGeneration: 2 } });
    expect(result).toMatchObject({ ready: false, reason: 'NotReconciled' });
  });

  it('is not ready while a condition is False', () => {
    const result = evaluate({
      metadata: { generation: 2 },
      status: {
        observedGeneration: 2,
        conditions: [
          { type: 'Ready', status: 'False', reason: 'TargetGroupNotFound', message: 'gone' },
        ],
      },
    });
    expect(result).toMatchObject({ ready: false, reason: 'TargetGroupNotFound', message: 'gone' });
  });

  it('is ready once the current generation is reconciled without failures', () => {
    expect(evaluate({ metadata: { generation: 2 }, status: { observedGeneration: 2 } }).ready).toBe(
      true
    );
    expect(
      evaluate({
        metadata: { generation: 2 },
        status: { observedGeneration: 2, conditions: [{ type: 'Ready', status: 'True' }] },
      }).ready
    ).toBe(true);
  });
});

describe('ingressClassParams', () => {
  it('creates a cluster-scoped IngressClassParams that is ready on creation', () => {
    const params = ingressClassParams({
      name: 'internal',
      spec: {
        scheme: 'internal',
        group: { name: 'internal' },
        targetType: 'ip',
        listeners: [
          {
            port: 443,
            protocol: 'HTTPS',
            listenerAttributes: [{ key: 'routing.http.response.server.enabled', value: 'false' }],
          },
        ],
        minimumLoadBalancerCapacity: { capacityUnits: 100 },
        sslRedirectPort: '443',
      },
    });
    expect(params.apiVersion).toBe('elbv2.k8s.aws/v1beta1');
    expect(params.kind).toBe('IngressClassParams');
    expect(Object.keys(params.metadata)).not.toContain('namespace');
    expect(params.spec.scheme).toBe('internal');
    expect(params.spec.group).toEqual({ name: 'internal' });
    expect(params.spec.targetType).toBe('ip');
    expect(params.spec.minimumLoadBalancerCapacity).toEqual({ capacityUnits: 100 });
    expect(getResourceScope(params)).toBe('cluster');
    expect(params.readinessEvaluator?.(params).ready).toBe(true);
  });
});
