/**
 * Test suite for deployment factory with readiness evaluation
 */

import { describe, expect, it } from 'bun:test';
import type { V1Deployment } from '@kubernetes/client-node';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';

describe('Deployment Factory with Readiness Evaluation', () => {
  it('should create deployment with readiness evaluator', () => {
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: {
        replicas: 3,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    };

    const enhanced = deployment(deploymentResource);

    expect(enhanced).toBeDefined();
    expect((enhanced as any).readinessEvaluator).toBeDefined();
    expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
  });

  it('should evaluate deployment as not ready when status is missing', () => {
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    };

    const enhanced = deployment(deploymentResource);
    const evaluator = (enhanced as any).readinessEvaluator;

    const result = evaluator({ status: null });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('StatusMissing');
    expect(result.message).toContain('status not available');
    expect(result.details?.expectedReplicas).toBe(2);
  });

  it('should evaluate deployment as ready when replicas match', () => {
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: {
        replicas: 3,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    };

    const enhanced = deployment(deploymentResource);
    const evaluator = (enhanced as any).readinessEvaluator;

    const liveResource = {
      status: {
        readyReplicas: 3,
        availableReplicas: 3,
        updatedReplicas: 3,
      },
    };

    const result = evaluator(liveResource);

    expect(result.ready).toBe(true);
    expect(result.message).toContain('3/3 ready replicas');
    expect(result.message).toContain('3/3 available replicas');
  });

  it('should evaluate deployment as not ready when replicas do not match', () => {
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: {
        replicas: 3,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    };

    const enhanced = deployment(deploymentResource);
    const evaluator = (enhanced as any).readinessEvaluator;

    const liveResource = {
      status: {
        readyReplicas: 1,
        availableReplicas: 2,
        updatedReplicas: 3,
      },
    };

    const result = evaluator(liveResource);

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('ReplicasNotReady');
    expect(result.message).toContain('1/3 ready');
    expect(result.message).toContain('2/3 available');
    expect(result.details?.expectedReplicas).toBe(3);
    expect(result.details?.readyReplicas).toBe(1);
    expect(result.details?.availableReplicas).toBe(2);
  });

  it('should handle default replica count of 1', () => {
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: {
        // No replicas specified, should default to 1
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    };

    const enhanced = deployment(deploymentResource);
    const evaluator = (enhanced as any).readinessEvaluator;

    const liveResource = {
      status: {
        readyReplicas: 1,
        availableReplicas: 1,
      },
    };

    const result = evaluator(liveResource);

    expect(result.ready).toBe(true);
    expect(result.message).toContain('1/1 ready replicas');
  });

  it('should handle evaluation errors gracefully', () => {
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    };

    const enhanced = deployment(deploymentResource);
    const evaluator = (enhanced as any).readinessEvaluator;

    // Pass malformed resource that might cause errors
    const result = evaluator(null);

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('EvaluationError');
    expect(result.message).toContain('Error evaluating deployment readiness');
    expect(result.details?.expectedReplicas).toBe(2);
  });
});
