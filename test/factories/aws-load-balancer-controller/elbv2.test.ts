import { describe, expect, it } from 'bun:test';
import { getResourceScope } from '../../../src/core/metadata/resource-metadata.js';
import {
  ingressClassParams,
  targetGroupBinding,
  targetGroupBindingReadinessEvaluator,
} from '../../../src/factories/aws-load-balancer-controller/index.js';

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
