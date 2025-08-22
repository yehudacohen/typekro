import { describe, expect, it } from 'bun:test';
import type { V1Job } from '@kubernetes/client-node';
import { job } from '../../src/factories/kubernetes/workloads/job.js';

describe('Job Factory with Readiness Evaluation', () => {
  it('should create job with readiness evaluator', () => {
    const resource: V1Job = {
      metadata: { name: 'test-job' },
      spec: {
        template: {
          spec: {
            containers: [{ name: 'test', image: 'busybox' }],
            restartPolicy: 'Never',
          },
        },
      },
    };

    const enhanced = job(resource);
    expect(enhanced.readinessEvaluator).toBeDefined();
    expect(typeof enhanced.readinessEvaluator).toBe('function');
  });

  it('should evaluate NonIndexed Job as ready when completions match expected', () => {
    const resource: V1Job = {
      metadata: { name: 'test-job' },
      spec: {
        completions: 3,
        parallelism: 2,
        completionMode: 'NonIndexed',
        template: {
          spec: {
            containers: [{ name: 'test', image: 'busybox' }],
            restartPolicy: 'Never',
          },
        },
      },
    };

    const enhanced = job(resource);
    const liveResource: V1Job = {
      ...resource,
      status: {
        succeeded: 3,
        failed: 0,
        active: 0,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(true);
    expect(status.message).toContain('Job completed: 3/3 completions succeeded');
  });

  it('should evaluate Indexed Job as ready when all completions succeed', () => {
    const resource: V1Job = {
      metadata: { name: 'test-indexed-job' },
      spec: {
        completions: 5,
        parallelism: 2,
        completionMode: 'Indexed',
        template: {
          spec: {
            containers: [{ name: 'test', image: 'busybox' }],
            restartPolicy: 'Never',
          },
        },
      },
    };

    const enhanced = job(resource);
    const liveResource: V1Job = {
      ...resource,
      status: {
        succeeded: 5,
        failed: 0,
        active: 0,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(true);
    expect(status.message).toContain('Job (Indexed) completed: 5/5 completions succeeded');
  });

  it('should evaluate Job as not ready when still in progress', () => {
    const resource: V1Job = {
      metadata: { name: 'test-job' },
      spec: {
        completions: 4,
        parallelism: 2,
        template: {
          spec: {
            containers: [{ name: 'test', image: 'busybox' }],
            restartPolicy: 'Never',
          },
        },
      },
    };

    const enhanced = job(resource);
    const liveResource: V1Job = {
      ...resource,
      status: {
        succeeded: 2,
        failed: 0,
        active: 2,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('JobInProgress');
    expect(status.message).toContain('2/4 completions succeeded, 2 active, 0 failed');
    expect(status.details).toEqual({
      expectedCompletions: 4,
      succeeded: 2,
      failed: 0,
      active: 2,
      parallelism: 2,
      completionMode: 'NonIndexed',
    });
  });

  it('should evaluate Job as failed when backoff limit exceeded', () => {
    const resource: V1Job = {
      metadata: { name: 'test-job' },
      spec: {
        completions: 1,
        backoffLimit: 3,
        template: {
          spec: {
            containers: [{ name: 'test', image: 'busybox' }],
            restartPolicy: 'Never',
          },
        },
      },
    };

    const enhanced = job(resource);
    const liveResource: V1Job = {
      ...resource,
      status: {
        succeeded: 0,
        failed: 4, // Exceeds backoff limit of 3
        active: 0,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('JobFailed');
    expect(status.message).toContain('4 failed pods exceed backoff limit of 3');
    expect(status.details).toEqual({
      expectedCompletions: 1,
      succeeded: 0,
      failed: 4,
      active: 0,
      backoffLimit: 3,
      completionMode: 'NonIndexed',
    });
  });

  it('should handle missing status gracefully', () => {
    const resource: V1Job = {
      metadata: { name: 'test-job' },
      spec: {
        completions: 2,
        template: {
          spec: {
            containers: [{ name: 'test', image: 'busybox' }],
            restartPolicy: 'Never',
          },
        },
      },
    };

    const enhanced = job(resource);
    const liveResource: V1Job = { ...resource }; // No status

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('StatusMissing');
    expect(status.message).toBe('Job status not available yet');
    expect(status.details).toEqual({
      expectedCompletions: 2,
      parallelism: 1, // default
      completionMode: 'NonIndexed', // default
    });
  });

  it('should handle default values correctly', () => {
    const resource: V1Job = {
      metadata: { name: 'test-job' },
      spec: {
        // No completions specified - should default to 1
        // No parallelism specified - should default to 1
        // No completionMode specified - should default to NonIndexed
        template: {
          spec: {
            containers: [{ name: 'test', image: 'busybox' }],
            restartPolicy: 'Never',
          },
        },
      },
    };

    const enhanced = job(resource);
    const liveResource: V1Job = {
      ...resource,
      status: {
        succeeded: 1,
        failed: 0,
        active: 0,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(true);
    expect(status.message).toContain('Job completed: 1/1 completions succeeded');
  });

  it('should handle evaluation errors gracefully', () => {
    const resource: V1Job = {
      metadata: { name: 'test-job' },
      spec: {
        template: {
          spec: {
            containers: [{ name: 'test', image: 'busybox' }],
            restartPolicy: 'Never',
          },
        },
      },
    };

    const enhanced = job(resource);

    // Pass malformed resource that will cause an error
    const malformedResource = null as any;

    const status = enhanced.readinessEvaluator!(malformedResource);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('EvaluationError');
    expect(status.message).toContain('Error evaluating Job readiness');
    expect(status.details?.error).toBeDefined();
  });

  it('should handle jobs with failures but within backoff limit', () => {
    const resource: V1Job = {
      metadata: { name: 'test-job' },
      spec: {
        completions: 3,
        backoffLimit: 5,
        template: {
          spec: {
            containers: [{ name: 'test', image: 'busybox' }],
            restartPolicy: 'Never',
          },
        },
      },
    };

    const enhanced = job(resource);
    const liveResource: V1Job = {
      ...resource,
      status: {
        succeeded: 2,
        failed: 2, // Within backoff limit
        active: 1,
      },
    };

    const status = enhanced.readinessEvaluator!(liveResource);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('JobInProgress');
    expect(status.message).toContain('2/3 completions succeeded, 1 active, 2 failed');
  });
});
