/**
 * Test suite for fluent builder pattern implementation
 */

import { describe, expect, it } from 'bun:test';
import type { ResourceStatus } from '../../src/core/types.js';
import { createResource } from '../../src/factories/shared.js';

describe('Fluent Builder Pattern', () => {
  it('should add withReadinessEvaluator method to Enhanced resources', () => {
    const resource = createResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: { replicas: 1 },
      status: {},
    });

    expect(typeof resource.withReadinessEvaluator).toBe('function');
  });

  it('should allow chaining withReadinessEvaluator method', () => {
    const resource = createResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: { replicas: 1 },
      status: {},
    });

    const evaluator = (_liveResource: any): ResourceStatus => ({
      ready: true,
      message: 'Test deployment is ready',
    });

    const enhanced = resource.withReadinessEvaluator(evaluator);

    expect(enhanced).toBeDefined();
    expect((enhanced as any).readinessEvaluator).toBe(evaluator);
  });

  it('should prevent serialization of withReadinessEvaluator method', () => {
    const resource = createResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: { replicas: 1 },
      status: {},
    });

    const keys = Object.keys(resource);
    expect(keys).not.toContain('withReadinessEvaluator');

    const propertyNames = Object.getOwnPropertyNames(resource);
    expect(propertyNames).toContain('withReadinessEvaluator');

    expect(Object.propertyIsEnumerable.call(resource, 'withReadinessEvaluator')).toBe(false);
  });

  it('should prevent serialization of readinessEvaluator property', () => {
    const resource = createResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: { replicas: 1 },
      status: {},
    });

    const evaluator = (_liveResource: any): ResourceStatus => ({
      ready: true,
      message: 'Test deployment is ready',
    });

    const enhanced = resource.withReadinessEvaluator(evaluator);

    const keys = Object.keys(enhanced);
    expect(keys).not.toContain('readinessEvaluator');

    const propertyNames = Object.getOwnPropertyNames(enhanced);
    expect(propertyNames).toContain('readinessEvaluator');

    expect(Object.propertyIsEnumerable.call(enhanced, 'readinessEvaluator')).toBe(false);
  });

  it('should not include readiness evaluator in JSON serialization', () => {
    const resource = createResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: { replicas: 1 },
      status: {},
    });

    const evaluator = (_liveResource: any): ResourceStatus => ({
      ready: true,
      message: 'Test deployment is ready',
    });

    const enhanced = resource.withReadinessEvaluator(evaluator);
    const serialized = JSON.stringify(enhanced);
    const parsed = JSON.parse(serialized);

    expect(parsed.readinessEvaluator).toBeUndefined();
    expect(parsed.withReadinessEvaluator).toBeUndefined();
  });

  it('should handle error cases gracefully in readiness evaluators', () => {
    const resource = createResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: { replicas: 1 },
      status: {},
    });

    const evaluator = (liveResource: any): ResourceStatus => {
      try {
        // Simulate some readiness logic that might fail
        if (!liveResource.status) {
          return {
            ready: false,
            reason: 'StatusMissing',
            message: 'Deployment status not available yet',
            details: { expectedReplicas: 1 },
          };
        }

        return {
          ready: true,
          message: 'Deployment is ready',
        };
      } catch (error) {
        return {
          ready: false,
          reason: 'EvaluationError',
          message: `Error evaluating deployment readiness: ${error}`,
          details: { error: String(error) },
        };
      }
    };

    const enhanced = resource.withReadinessEvaluator(evaluator);
    const result = (enhanced as any).readinessEvaluator({ status: null });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('StatusMissing');
    expect(result.message).toContain('status not available');
  });

  it('should work unchanged outside composition context (backward compatibility)', () => {
    // This test ensures that createResource works exactly as before when not in composition context
    const resource = createResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment' },
      spec: { replicas: 1 },
      status: {},
    });

    // Should have all the expected properties and methods
    expect(resource.apiVersion).toBe('apps/v1');
    expect(resource.kind).toBe('Deployment');
    expect(resource.metadata?.name).toBe('test-deployment');
    expect(resource.spec?.replicas).toBe(1);
    expect(typeof resource.withReadinessEvaluator).toBe('function');
    expect(typeof (resource as any).readinessEvaluator).toBe('function');

    // Should have the resource ID
    expect((resource as any).id).toBeDefined();
    expect(typeof (resource as any).id).toBe('string');

    // Should be serializable
    const serialized = JSON.stringify(resource);
    const parsed = JSON.parse(serialized);
    expect(parsed.apiVersion).toBe('apps/v1');
    expect(parsed.kind).toBe('Deployment');
    expect(parsed.metadata.name).toBe('test-deployment');

    // Should not include function properties in serialization
    expect(parsed.readinessEvaluator).toBeUndefined();
    expect(parsed.withReadinessEvaluator).toBeUndefined();
  });
});
