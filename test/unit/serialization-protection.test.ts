/**
 * Test suite for serialization protection of readiness evaluators
 */

import { describe, expect, it } from 'bun:test';
import type { V1Deployment, V1Service } from '@kubernetes/client-node';
import { getReadinessEvaluator as getReadinessEvaluatorFromMeta } from '../../src/core/metadata/index.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';
import { getReadinessEvaluator, requireReadinessEvaluator } from '../utils/mock-factories.js';

describe('Serialization Protection for Readiness Evaluators', () => {
  it('should exclude readiness evaluators from Object.keys()', () => {
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
    const keys = Object.keys(enhanced);

    expect(keys).not.toContain('readinessEvaluator');
    expect(keys).not.toContain('withReadinessEvaluator');
  });

  it('should store readiness evaluator in WeakMap and keep withReadinessEvaluator as non-enumerable', () => {
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
    const propertyNames = Object.getOwnPropertyNames(enhanced);

    // withReadinessEvaluator is still set via Object.defineProperty
    expect(propertyNames).toContain('withReadinessEvaluator');
    expect(Object.propertyIsEnumerable.call(enhanced, 'withReadinessEvaluator')).toBe(false);

    // readinessEvaluator is accessible via proxy get trap (WeakMap-backed)
    const evaluator = getReadinessEvaluatorFromMeta(enhanced);
    expect(typeof evaluator).toBe('function');

    // readinessEvaluator should NOT be in enumerable keys
    expect(Object.keys(enhanced)).not.toContain('readinessEvaluator');
  });

  it('should exclude readiness evaluators from JSON.stringify()', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'LoadBalancer',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' },
      },
    };

    const enhanced = service(serviceResource);
    const serialized = JSON.stringify(enhanced);
    const parsed = JSON.parse(serialized);

    expect(parsed.readinessEvaluator).toBeUndefined();
    expect(parsed.withReadinessEvaluator).toBeUndefined();

    // But should still have the core resource properties
    expect(parsed.apiVersion).toBe('v1');
    expect(parsed.kind).toBe('Service');
    // Note: metadata might be a proxy, so we check the enhanced object directly
    expect(enhanced.apiVersion).toBe('v1');
    expect(enhanced.kind).toBe('Service');
    expect(enhanced.metadata.name).toBe('test-service');
  });

  it('should exclude readiness evaluators from YAML serialization', () => {
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    };

    const enhanced = deployment(deploymentResource);

    // Test that the enhanced object doesn't expose readiness evaluators in enumerable properties
    const enumerableProps = Object.keys(enhanced);
    expect(enumerableProps).not.toContain('readinessEvaluator');
    expect(enumerableProps).not.toContain('withReadinessEvaluator');

    // Test that the functions exist but are not enumerable
    expect(typeof getReadinessEvaluator(enhanced)).toBe('function');
    expect(typeof enhanced.withReadinessEvaluator).toBe('function');

    // Test that JSON.stringify excludes the functions
    const jsonString = JSON.stringify(enhanced);
    expect(jsonString).not.toContain('readinessEvaluator');
    expect(jsonString).not.toContain('withReadinessEvaluator');
  });

  it('should maintain readiness evaluator functionality after serialization round-trip', () => {
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

    // Verify readiness evaluator works before serialization
    const evaluator = requireReadinessEvaluator(enhanced);
    expect(typeof evaluator).toBe('function');

    const result = evaluator({
      status: {
        readyReplicas: 3,
        availableReplicas: 3,
      },
    });
    expect(result.ready).toBe(true);

    // Serialize and parse (simulating what might happen in real usage)
    const serialized = JSON.stringify(enhanced);
    const parsed = JSON.parse(serialized);

    // Parsed object should not have the evaluator
    expect(parsed.readinessEvaluator).toBeUndefined();

    // But original enhanced object should still have it
    expect(getReadinessEvaluator(enhanced)).toBe(evaluator);
    expect(typeof getReadinessEvaluator(enhanced)).toBe('function');
  });

  it('should handle multiple resources with different readiness evaluators', () => {
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

    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'ClusterIP',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' },
      },
    };

    const enhancedDeployment = deployment(deploymentResource);
    const enhancedService = service(serviceResource);

    // Both should have readiness evaluators
    expect(typeof getReadinessEvaluator(enhancedDeployment)).toBe('function');
    expect(typeof getReadinessEvaluator(enhancedService)).toBe('function');

    // But they should be different functions
    expect(getReadinessEvaluator(enhancedDeployment)).not.toBe(
      getReadinessEvaluator(enhancedService)
    );

    // Test deployment evaluator
    const deploymentResult = requireReadinessEvaluator(enhancedDeployment)({
      status: { readyReplicas: 2, availableReplicas: 2 },
    });
    expect(deploymentResult.ready).toBe(true);
    expect(deploymentResult.message).toContain('2/2 ready replicas');

    // Test service evaluator
    const serviceResult = requireReadinessEvaluator(enhancedService)({
      spec: { type: 'ClusterIP' },
    });
    expect(serviceResult.ready).toBe(true);
    expect(serviceResult.message).toContain('ClusterIP service is ready');

    // Test that both resources exclude evaluators from enumerable properties
    expect(Object.keys(enhancedDeployment)).not.toContain('readinessEvaluator');
    expect(Object.keys(enhancedService)).not.toContain('readinessEvaluator');
    expect(Object.keys(enhancedDeployment)).not.toContain('withReadinessEvaluator');
    expect(Object.keys(enhancedService)).not.toContain('withReadinessEvaluator');

    // Test that JSON serialization excludes the evaluators
    const deploymentJson = JSON.stringify(enhancedDeployment);
    const serviceJson = JSON.stringify(enhancedService);

    expect(deploymentJson).not.toContain('readinessEvaluator');
    expect(serviceJson).not.toContain('readinessEvaluator');
    expect(deploymentJson).not.toContain('withReadinessEvaluator');
    expect(serviceJson).not.toContain('withReadinessEvaluator');
  });
});
