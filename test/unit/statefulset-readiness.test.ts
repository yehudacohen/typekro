import { describe, expect, it } from 'bun:test';
import type { V1StatefulSet } from '@kubernetes/client-node';
import { statefulSet } from '../../src/factories/kubernetes/workloads/stateful-set.js';

describe('StatefulSet Factory with Readiness Evaluation', () => {
  it('should create statefulset with readiness evaluator', () => {
    const resource: V1StatefulSet = {
      metadata: { name: 'test-statefulset' },
      spec: {
        replicas: 3,
        serviceName: 'test-service',
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
        updateStrategy: { type: 'RollingUpdate' },
      },
    };

    const enhanced = statefulSet(resource);
    expect(enhanced.readinessEvaluator).toBeDefined();
    expect(typeof enhanced.readinessEvaluator).toBe('function');
  });

  it('should evaluate RollingUpdate StatefulSet as ready when all replicas are ready, current, and updated', () => {
    const resource: V1StatefulSet = {
      metadata: { name: 'test-statefulset' },
      spec: {
        replicas: 3,
        serviceName: 'test-service',
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
        updateStrategy: { type: 'RollingUpdate' },
      },
    };

    const enhanced = statefulSet(resource);
    const liveResource: V1StatefulSet = {
      ...resource,
      status: {
        readyReplicas: 3,
        currentReplicas: 3,
        updatedReplicas: 3,
        replicas: 3,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(true);
    expect(status.message).toContain('all 3 replicas ready, current, and updated');
  });

  it('should evaluate RollingUpdate StatefulSet as not ready when replicas are not all updated', () => {
    const resource: V1StatefulSet = {
      metadata: { name: 'test-statefulset' },
      spec: {
        replicas: 3,
        serviceName: 'test-service',
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
        updateStrategy: { type: 'RollingUpdate' },
      },
    };

    const enhanced = statefulSet(resource);
    const liveResource: V1StatefulSet = {
      ...resource,
      status: {
        readyReplicas: 2,
        currentReplicas: 3,
        updatedReplicas: 2,
        replicas: 3,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('RollingUpdateInProgress');
    expect(status.message).toContain('2/3 ready, 3/3 current, 2/3 updated');
    expect(status.details).toEqual({
      expectedReplicas: 3,
      readyReplicas: 2,
      currentReplicas: 3,
      updatedReplicas: 2,
      updateStrategy: 'RollingUpdate',
    });
  });

  it('should evaluate OnDelete StatefulSet as ready when ready replicas match expected', () => {
    const resource: V1StatefulSet = {
      metadata: { name: 'test-statefulset' },
      spec: {
        replicas: 2,
        serviceName: 'test-service',
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
        updateStrategy: { type: 'OnDelete' },
      },
    };

    const enhanced = statefulSet(resource);
    const liveResource: V1StatefulSet = {
      ...resource,
      status: {
        readyReplicas: 2,
        currentReplicas: 2,
        updatedReplicas: 1, // OnDelete doesn't care about updated replicas
        replicas: 2,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(true);
    expect(status.message).toContain('StatefulSet (OnDelete) has 2/2 ready replicas');
  });

  it('should handle missing status gracefully', () => {
    const resource: V1StatefulSet = {
      metadata: { name: 'test-statefulset' },
      spec: {
        replicas: 1,
        serviceName: 'test-service',
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    };

    const enhanced = statefulSet(resource);
    const liveResource: V1StatefulSet = { ...resource }; // No status

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('StatusMissing');
    expect(status.message).toBe('StatefulSet status not available yet');
    expect(status.details).toEqual({
      expectedReplicas: 1,
      updateStrategy: 'RollingUpdate', // default
    });
  });

  it('should handle default values correctly', () => {
    const resource: V1StatefulSet = {
      metadata: { name: 'test-statefulset' },
      spec: {
        // No replicas specified - should default to 1
        serviceName: 'test-service',
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
        // No updateStrategy specified - should default to RollingUpdate
      },
    };

    const enhanced = statefulSet(resource);
    const liveResource: V1StatefulSet = {
      ...resource,
      status: {
        readyReplicas: 1,
        currentReplicas: 1,
        updatedReplicas: 1,
        replicas: 1,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(true);
    expect(status.message).toContain('all 1 replicas ready, current, and updated');
  });

  it('should handle evaluation errors gracefully', () => {
    const resource: V1StatefulSet = {
      metadata: { name: 'test-statefulset' },
      spec: {
        replicas: 1,
        serviceName: 'test-service',
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    };

    const enhanced = statefulSet(resource);

    // Pass malformed resource that will cause an error
    const malformedResource = null as any;

    const status = enhanced.readinessEvaluator!(malformedResource);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('EvaluationError');
    expect(status.message).toContain('Error evaluating StatefulSet readiness');
    expect(status.details?.error).toBeDefined();
  });
});
