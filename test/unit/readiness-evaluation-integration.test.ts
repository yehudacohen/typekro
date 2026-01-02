/**
 * Test suite for readiness evaluation integration
 *
 * This test focuses specifically on the readiness evaluation logic
 * without the complexity of full deployment simulation.
 *
 * NOTE: In the new @kubernetes/client-node API (v1.x), methods return objects directly
 * without a .body wrapper. The mocks must return the resource directly.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { V1Deployment, V1Service } from '@kubernetes/client-node';
import * as k8s from '@kubernetes/client-node';
import { DirectDeploymentEngine } from '../../src/core/deployment/engine.js';
import type { DeployedResource } from '../../src/core/types/deployment.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';

describe('Readiness Evaluation Integration', () => {
  // Create a minimal mock for testing readiness evaluation
  // NOTE: In the new API, methods return objects directly (no .body wrapper)
  const mockKubeConfig = new k8s.KubeConfig();
  let mockK8sApi: any;

  // Reset mock before each test to ensure clean state
  beforeEach(() => {
    mockK8sApi = {
      read: mock(() => Promise.resolve({})),
    };
  });

  it('should use custom deployment readiness evaluator', async () => {
    const engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi);

    // Create a deployment with custom readiness evaluator
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment', namespace: 'default' },
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

    // Verify the enhanced resource has a readiness evaluator
    expect((enhanced as any).readinessEvaluator).toBeDefined();
    expect(typeof (enhanced as any).readinessEvaluator).toBe('function');

    // Create a mock deployed resource
    const deployedResource: DeployedResource = {
      id: 'test-deployment',
      kind: 'Deployment',
      name: 'test-deployment',
      namespace: 'default',
      manifest: enhanced,
      status: 'deployed',
      deployedAt: new Date(),
    };

    // Mock the k8s API to return a ready deployment (returns object directly, no .body wrapper)
    // Use mockResolvedValue to return the same value for all calls (the readiness loop polls multiple times)
    mockK8sApi.read.mockResolvedValue({
      ...deploymentResource,
      status: {
        readyReplicas: 2,
        availableReplicas: 2,
        updatedReplicas: 2,
      },
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      timeout: 5000, // 5 second timeout for tests
      progressCallback: (event: any) => events.push(event),
    };

    // Test the readiness evaluation directly
    // Note: waitForResourceReady signature is (deployedResource, options, abortSignal?)
    // The progressCallback in options is used for event emission
    await (engine as any).waitForResourceReady(deployedResource, options);

    // Check that custom readiness evaluation was used
    const readyEvent = events.find((e) => e.type === 'resource-ready');
    expect(readyEvent).toBeDefined();
    expect(readyEvent.message).toContain('2/2 ready replicas');
    expect(readyEvent.message).toContain('2/2 available replicas');
  });

  it('should use custom service readiness evaluator', async () => {
    const engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi);

    // Create a LoadBalancer service with custom readiness evaluator
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service', namespace: 'default' },
      spec: {
        type: 'LoadBalancer',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' },
      },
    };

    const enhanced = service(serviceResource);

    // Verify the enhanced resource has a readiness evaluator
    expect((enhanced as any).readinessEvaluator).toBeDefined();
    expect(typeof (enhanced as any).readinessEvaluator).toBe('function');

    // Create a mock deployed resource
    const deployedResource: DeployedResource = {
      id: 'test-service',
      kind: 'Service',
      name: 'test-service',
      namespace: 'default',
      manifest: enhanced,
      status: 'deployed',
      deployedAt: new Date(),
    };

    // Mock the k8s API to return a service with LoadBalancer ingress (returns object directly, no .body wrapper)
    // Use mockResolvedValue to return the same value for all calls (the readiness loop polls multiple times)
    mockK8sApi.read.mockResolvedValue({
      ...serviceResource,
      status: {
        loadBalancer: {
          ingress: [{ ip: '192.168.1.100' }],
        },
      },
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      timeout: 5000, // 5 second timeout for tests
      progressCallback: (event: any) => events.push(event),
    };

    // Test the readiness evaluation directly
    // Note: waitForResourceReady signature is (deployedResource, options, abortSignal?)
    // The progressCallback in options is used for event emission
    await (engine as any).waitForResourceReady(deployedResource, options);

    // Check that custom readiness evaluation was used
    const readyEvent = events.find((e) => e.type === 'resource-ready');
    expect(readyEvent).toBeDefined();
    expect(readyEvent.message).toContain('external endpoint: 192.168.1.100');
  });

  it('should handle progression from not ready to ready', async () => {
    const engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi);

    // Create a deployment with custom readiness evaluator
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment', namespace: 'default' },
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

    // Create a mock deployed resource
    const deployedResource: DeployedResource = {
      id: 'test-deployment',
      kind: 'Deployment',
      name: 'test-deployment',
      namespace: 'default',
      manifest: enhanced,
      status: 'deployed',
      deployedAt: new Date(),
    };

    // Mock the k8s API to return progression: not ready -> ready (returns object directly, no .body wrapper)
    // After the two specific responses, return the ready state for any subsequent calls
    const readyDeployment = {
      ...deploymentResource,
      status: {
        readyReplicas: 3,
        availableReplicas: 3,
        updatedReplicas: 3,
      },
    };
    mockK8sApi.read
      .mockResolvedValueOnce({
        ...deploymentResource,
        status: {
          readyReplicas: 1,
          availableReplicas: 1,
          updatedReplicas: 3,
        },
      })
      .mockResolvedValue(readyDeployment); // All subsequent calls return ready state

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      timeout: 10000, // 10 second timeout for progression test
      progressCallback: (event: any) => events.push(event),
    };

    // Test the readiness evaluation directly
    // Note: waitForResourceReady signature is (deployedResource, options, abortSignal?)
    // The progressCallback in options is used for event emission
    await (engine as any).waitForResourceReady(deployedResource, options);

    // Check that we got both status and ready events
    const statusEvents = events.filter((e) => e.type === 'resource-status');
    const readyEvents = events.filter((e) => e.type === 'resource-ready');

    expect(statusEvents.length).toBeGreaterThan(0);
    expect(readyEvents.length).toBeGreaterThan(0);

    // Status event should show not ready state
    const statusEvent = statusEvents[0];
    expect(statusEvent.message).toContain('1/3 ready');
    expect(statusEvent.message).toContain('1/3 available');

    // Ready event should show final ready state
    const readyEvent = readyEvents[0];
    expect(readyEvent.message).toContain('3/3 ready replicas');
    expect(readyEvent.message).toContain('3/3 available replicas');
  });

  it('should use default readiness evaluator for ConfigMap resources', async () => {
    const engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi);

    // Import the configMap factory to get a resource with default readiness evaluator
    const { configMap } = await import('../../src/factories/kubernetes/config/config-map.js');

    // Create a ConfigMap using the factory (which provides a default readiness evaluator)
    const configMapResource = configMap({
      metadata: { name: 'test-config', namespace: 'default' },
      data: { key: 'value' },
    });

    // Create a mock deployed resource
    const deployedResource: DeployedResource = {
      id: 'test-config',
      kind: 'ConfigMap',
      name: 'test-config',
      namespace: 'default',
      manifest: configMapResource,
      status: 'deployed',
      deployedAt: new Date(),
    };

    // Mock the k8s API to return the ConfigMap (ConfigMaps are immediately ready)
    mockK8sApi.read.mockResolvedValue({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test-config', namespace: 'default' },
      data: { key: 'value' },
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      timeout: 5000, // 5 second timeout for tests
      progressCallback: (event: any) => events.push(event),
    };

    // Test the readiness evaluation - should use default evaluator
    // Note: waitForResourceReady signature is (deployedResource, options, abortSignal?)
    // The progressCallback in options is used for event emission
    await (engine as any).waitForResourceReady(deployedResource, options);

    // Should complete without errors using the default ConfigMap readiness evaluator
    const readyEvent = events.find((e) => e.type === 'resource-ready');
    expect(readyEvent).toBeDefined();
    expect(readyEvent.message).toContain('ConfigMap is ready when created');
  });

  it('should handle custom evaluator errors gracefully', async () => {
    const engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi);

    // Create a deployment with custom readiness evaluator
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment', namespace: 'default' },
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

    // Create a mock deployed resource
    const deployedResource: DeployedResource = {
      id: 'test-deployment',
      kind: 'Deployment',
      name: 'test-deployment',
      namespace: 'default',
      manifest: enhanced,
      status: 'deployed',
      deployedAt: new Date(),
    };

    // Mock the k8s API to fail initially
    mockK8sApi.read.mockRejectedValueOnce(new Error('API error'));

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      timeout: 1000, // Short timeout
      progressCallback: (event: any) => events.push(event),
    };

    // Test the readiness evaluation - should handle error gracefully
    // Note: waitForResourceReady signature is (deployedResource, options, abortSignal?)
    // The progressCallback in options is used for event emission
    await expect(
      (engine as any).waitForResourceReady(deployedResource, options)
    ).rejects.toThrow();

    // Should have emitted a status event about the API error
    const statusEvents = events.filter((e) => e.type === 'resource-status');
    expect(statusEvents.some((e) => e.message.includes('Unable to read resource status'))).toBe(
      true
    );
  });

  it('should demonstrate custom evaluator provides detailed messages', () => {
    // Test the custom evaluator directly to verify it provides detailed messages
    const deploymentResource: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment', namespace: 'default' },
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

    // Test not ready state
    const notReadyResult = evaluator({
      status: {
        readyReplicas: 1,
        availableReplicas: 1,
        updatedReplicas: 3,
      },
    });

    expect(notReadyResult.ready).toBe(false);
    expect(notReadyResult.reason).toBe('ReplicasNotReady');
    expect(notReadyResult.message).toContain('1/3 ready');
    expect(notReadyResult.message).toContain('1/3 available');
    expect(notReadyResult.details?.expectedReplicas).toBe(3);
    expect(notReadyResult.details?.readyReplicas).toBe(1);
    expect(notReadyResult.details?.availableReplicas).toBe(1);

    // Test ready state
    const readyResult = evaluator({
      status: {
        readyReplicas: 3,
        availableReplicas: 3,
        updatedReplicas: 3,
      },
    });

    expect(readyResult.ready).toBe(true);
    expect(readyResult.message).toContain('3/3 ready replicas');
    expect(readyResult.message).toContain('3/3 available replicas');
  });
});
