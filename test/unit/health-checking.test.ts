/**
 * Health Checking Tests
 *
 * Tests the real health checking implementation using readiness evaluators
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { DirectResourceFactoryImpl } from '../../src/core/deployment/direct-factory.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';

describe('Health Checking with Readiness Evaluators', () => {
  const TestSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1',
  });

  const TestStatusSchema = type({
    ready: 'boolean',
    url: 'string',
  });

  let factory: DirectResourceFactoryImpl<any, any>;

  beforeEach(() => {
    // Create a test factory with static resources
    const testResources = {
      deployment: deployment({
        metadata: { name: 'test-app' },
        spec: {
          selector: { matchLabels: { app: 'test-app' } },
          template: {
            metadata: { labels: { app: 'test-app' } },
            spec: {
              containers: [
                {
                  name: 'test-app',
                  image: 'nginx:latest',
                },
              ],
            },
          },
          replicas: 1,
        },
      }),
    };

    factory = new DirectResourceFactoryImpl(
      'test-health-factory',
      testResources,
      {
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (_schema, _resources) => ({
        ready: true,
        url: 'http://test-service',
      })
    );
  });

  it('should return healthy status when no deployments exist', async () => {
    const status = await factory.getStatus();

    expect(status.health).toBe('healthy');
    expect(status.instanceCount).toBe(0);
    expect(status.name).toBe('test-health-factory');
    expect(status.mode).toBe('direct');
  });

  it('should have the checkFactoryHealth method available', () => {
    // Test that the private method exists by checking the factory has the getStatus method
    // which internally calls checkFactoryHealth
    expect(typeof factory.getStatus).toBe('function');
  });

  it('should use readiness evaluators for health checking', async () => {
    // This test verifies the structure is in place
    // Integration tests will verify the actual cluster interaction
    const testDeployment = deployment({
      metadata: { name: 'test-app' },
      spec: {
        selector: { matchLabels: { app: 'test-app' } },
        template: {
          metadata: { labels: { app: 'test-app' } },
          spec: {
            containers: [
              {
                name: 'test-app',
                image: 'nginx:latest',
              },
            ],
          },
        },
        replicas: 1,
      },
    });

    // Verify the deployment has a readiness evaluator
    expect(testDeployment.readinessEvaluator).toBeDefined();
    expect(typeof testDeployment.readinessEvaluator).toBe('function');

    // Test the readiness evaluator with mock data
    const mockDeployment = {
      status: {
        readyReplicas: 1,
        availableReplicas: 1,
        replicas: 1,
      },
    };

    const status = testDeployment.readinessEvaluator!(mockDeployment);
    expect(status.ready).toBe(true);
    expect(status.message).toContain('ready replicas');
  });

  it('should handle degraded resources correctly', async () => {
    const testDeployment = deployment({
      metadata: { name: 'test-app' },
      spec: {
        selector: { matchLabels: { app: 'test-app' } },
        template: {
          metadata: { labels: { app: 'test-app' } },
          spec: {
            containers: [
              {
                name: 'test-app',
                image: 'nginx:latest',
              },
            ],
          },
        },
        replicas: 2,
      },
    });

    // Test with partially ready deployment
    const mockDeployment = {
      status: {
        readyReplicas: 1,
        availableReplicas: 1,
        replicas: 2,
      },
    };

    const status = testDeployment.readinessEvaluator!(mockDeployment);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('ReplicasNotReady');
    expect(status.message).toContain('1/2');
  });

  it('should handle failed resources correctly', async () => {
    const testDeployment = deployment({
      metadata: { name: 'test-app' },
      spec: {
        selector: { matchLabels: { app: 'test-app' } },
        template: {
          metadata: { labels: { app: 'test-app' } },
          spec: {
            containers: [
              {
                name: 'test-app',
                image: 'nginx:latest',
              },
            ],
          },
        },
        replicas: 1,
      },
    });

    // Test with failed deployment (no status)
    const mockDeployment = {
      status: null,
    };

    const status = testDeployment.readinessEvaluator!(mockDeployment);
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('StatusMissing');
    expect(status.message).toContain('status not available');
  });

  it('should provide detailed health information via getHealthDetails', async () => {
    const healthDetails = await factory.getHealthDetails();

    expect(healthDetails).toHaveProperty('health');
    expect(healthDetails).toHaveProperty('resourceCounts');
    expect(healthDetails).toHaveProperty('errors');

    expect(healthDetails.health).toBe('healthy');
    expect(healthDetails.resourceCounts.total).toBe(0);
    expect(healthDetails.errors).toHaveLength(0);

    expect(typeof healthDetails.resourceCounts.healthy).toBe('number');
    expect(typeof healthDetails.resourceCounts.degraded).toBe('number');
    expect(typeof healthDetails.resourceCounts.failed).toBe('number');
  });
});
