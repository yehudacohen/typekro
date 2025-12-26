/**
 * Test suite for enhanced DirectDeploymentEngine with custom readiness evaluators
 *
 * NOTE: In the new @kubernetes/client-node API (v1.x), methods return objects directly
 * without a .body wrapper. The mocks must return the resource directly.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { V1Deployment, V1Service } from '@kubernetes/client-node';
import * as k8s from '@kubernetes/client-node';
import { DirectDeploymentEngine } from '../../src/core/deployment/engine.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';

describe('Enhanced DirectDeploymentEngine', () => {
  // Mock Kubernetes client and API
  const mockKubeConfig = new k8s.KubeConfig();

  // Create a more realistic mock that simulates the deployment flow
  // NOTE: In the new API, methods return objects directly (no .body wrapper)
  const createMockK8sApi = () => {
    const mockApi = {
      create: mock(() => Promise.resolve({})),
      read: mock(() => Promise.resolve({})),
      delete: mock(() => Promise.resolve({})),
      patch: mock(() => Promise.resolve({})),
      replace: mock(() => Promise.resolve({})),
      list: mock(() => Promise.resolve({ items: [] })),
    } as any;

    // Reset all mocks before each test
    mockApi.create.mockClear();
    mockApi.read.mockClear();
    mockApi.delete.mockClear();
    mockApi.patch.mockClear();
    mockApi.replace.mockClear();
    mockApi.list.mockClear();

    return mockApi;
  };

  it('should use custom readiness evaluator when available', async () => {
    const mockK8sApi = createMockK8sApi();
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

    // Mock the deployment flow (new API returns objects directly, no .body wrapper):
    // 1. First read call (existence check) - resource doesn't exist (404)
    const notFoundError = new Error('Not found') as any;
    notFoundError.statusCode = 404;
    mockK8sApi.read.mockRejectedValueOnce(notFoundError);

    // 2. Create call - resource is created successfully (returns object directly)
    mockK8sApi.create.mockResolvedValueOnce({
      ...deploymentResource,
      metadata: { ...deploymentResource.metadata, uid: 'test-uid' },
    });

    // 3. Read call for readiness checking - resource is ready (returns object directly)
    mockK8sApi.read.mockResolvedValueOnce({
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
      progressCallback: (event: any) => events.push(event),
    };

    // Deploy the resource
    (enhanced as any).id = 'test-deployment';
    const result = await engine.deployResource(enhanced as any, options);

    expect(result.status).toBe('ready');

    // Check that custom readiness evaluation was used
    const readinessEvents = events.filter(
      (e) => e.type === 'resource-ready' || e.type === 'resource-status'
    );
    expect(readinessEvents.length).toBeGreaterThan(0);

    // The message should come from our custom evaluator
    const readyEvent = readinessEvents.find((e) => e.type === 'resource-ready');
    expect(readyEvent?.message).toContain('2/2 ready replicas');
    expect(readyEvent?.message).toContain('2/2 available replicas');
  });

  it('should reject resources without factory-provided readiness evaluators', async () => {
    const mockK8sApi = createMockK8sApi();
    const engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi);

    // Create a plain resource without custom readiness evaluator
    const plainResource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test-config', namespace: 'default' },
      data: { key: 'value' },
    };

    // Mock the deployment flow (new API returns objects directly, no .body wrapper):
    // 1. First read call (existence check) - resource doesn't exist (404)
    const notFoundError = new Error('Not found') as any;
    notFoundError.statusCode = 404;
    mockK8sApi.read.mockRejectedValueOnce(notFoundError);

    // 2. Create call - resource is created successfully (returns object directly)
    mockK8sApi.create.mockResolvedValueOnce({
      ...plainResource,
      metadata: { ...plainResource.metadata, uid: 'test-uid' },
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      progressCallback: (event: any) => events.push(event),
    };

    // Deploy the resource - should fail because no factory-provided evaluator
    await expect(engine.deployResource(plainResource as any, options)).rejects.toThrow(
      'Resource ConfigMap/test-config does not have a factory-provided readiness evaluator'
    );
  });

  it('should handle custom evaluator errors gracefully', async () => {
    const mockK8sApi = createMockK8sApi();
    const engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi);

    // Create a service with custom readiness evaluator
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

    // Mock the deployment flow (new API returns objects directly, no .body wrapper):
    // 1. First read call (existence check) - resource doesn't exist (404)
    // 2. Create call - resource is created successfully
    // 3. Read calls for readiness checking - fail initially, then succeed
    mockK8sApi.read
      .mockRejectedValueOnce({ statusCode: 404 }) // Resource doesn't exist initially
      .mockRejectedValueOnce(new Error('API error')) // First readiness check fails
      .mockResolvedValueOnce({
        // Second readiness check succeeds (returns object directly)
        ...serviceResource,
        status: {
          loadBalancer: {
            ingress: [{ ip: '192.168.1.100' }],
          },
        },
      });

    // Create call - resource is created successfully (returns object directly)
    mockK8sApi.create.mockResolvedValueOnce({
      ...serviceResource,
      metadata: { ...serviceResource.metadata, uid: 'test-uid' },
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      progressCallback: (event: any) => events.push(event),
    };

    // Deploy the resource
    (enhanced as any).id = 'test-service';
    const result = await engine.deployResource(enhanced as any, options);

    expect(result.status).toBe('ready');

    // Should have handled the error and eventually succeeded
    const statusEvents = events.filter((e) => e.type === 'resource-status');
    expect(statusEvents.some((e) => e.message.includes('Unable to read resource status'))).toBe(
      true
    );

    const readyEvents = events.filter((e) => e.type === 'resource-ready');
    expect(readyEvents.some((e) => e.message.includes('192.168.1.100'))).toBe(true);
  });

  it('should provide detailed timeout messages from custom evaluators', async () => {
    const mockK8sApi = createMockK8sApi();
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

    // Mock the deployment flow (new API returns objects directly, no .body wrapper):
    // 1. First read call (existence check) - resource doesn't exist (404)
    const notFoundError = new Error('Not found') as any;
    notFoundError.statusCode = 404;
    mockK8sApi.read.mockRejectedValueOnce(notFoundError);

    // 2. Create call - resource is created successfully (returns object directly)
    mockK8sApi.create.mockResolvedValueOnce({
      ...deploymentResource,
      metadata: { ...deploymentResource.metadata, uid: 'test-uid' },
    });

    // 3. All subsequent read calls return not ready (returns object directly)
    mockK8sApi.read.mockResolvedValue({
      ...deploymentResource,
      status: {
        readyReplicas: 1,
        availableReplicas: 1,
        updatedReplicas: 3,
      },
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      timeout: 3000, // Short timeout for testing (but long enough for at least one status event)
      progressCallback: (event: any) => events.push(event),
    };

    // Deploy the resource - should timeout with detailed message
    // Use type assertion to set id since it's read-only on Enhanced type
    (enhanced as { id: string }).id = 'test-deployment-timeout';
    await expect(engine.deployResource(enhanced as any, options)).rejects.toThrow();

    // Should have emitted status updates with detailed messages
    // The deployment readiness evaluator message format is: "Waiting for replicas: X/Y ready, X/Y available"
    const statusEvents = events.filter((e) => e.type === 'resource-status');
    expect(statusEvents.length).toBeGreaterThan(0);
    expect(statusEvents.some((e) => e.message.includes('1/3 ready'))).toBe(true);
    expect(statusEvents.some((e) => e.message.includes('1/3 available'))).toBe(true);
  });

  it('should emit structured status updates with details', async () => {
    const mockK8sApi = createMockK8sApi();
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

    // Mock the k8s API (new API returns objects directly, no .body wrapper):
    // 1. First read call (existence check) - resource doesn't exist (404)
    // 2. Create call - resource is created successfully
    // 3. Mock progression: not ready -> ready
    mockK8sApi.read
      .mockRejectedValueOnce({ statusCode: 404 }) // Resource doesn't exist initially
      .mockResolvedValueOnce({
        // First readiness check - not ready (returns object directly)
        ...deploymentResource,
        status: {
          readyReplicas: 1,
          availableReplicas: 1,
          updatedReplicas: 2,
        },
      })
      .mockResolvedValueOnce({
        // Second readiness check - ready (returns object directly)
        ...deploymentResource,
        status: {
          readyReplicas: 2,
          availableReplicas: 2,
          updatedReplicas: 2,
        },
      });

    // Create call - resource is created successfully (returns object directly)
    mockK8sApi.create.mockResolvedValueOnce({
      ...deploymentResource,
      metadata: { ...deploymentResource.metadata, uid: 'test-uid' },
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      progressCallback: (event: any) => events.push(event),
    };

    // Deploy the resource
    // Use type assertion to set id since it's read-only on Enhanced type
    (enhanced as { id: string }).id = 'test-deployment-structured';
    const result = await engine.deployResource(enhanced as any, options);

    expect(result.status).toBe('ready');

    // Check that we got structured status updates
    const statusEvents = events.filter((e) => e.type === 'resource-status');
    const readyEvents = events.filter((e) => e.type === 'resource-ready');

    // Should have at least one status event (not ready) and one ready event
    expect(statusEvents.length).toBeGreaterThan(0);
    expect(readyEvents.length).toBeGreaterThan(0);

    // Status events should have detailed information
    // The deployment readiness evaluator message format is: "Waiting for replicas: X/Y ready, X/Y available"
    const notReadyEvent = statusEvents[0];
    expect(notReadyEvent.message).toContain('1/2 ready');
    expect(notReadyEvent.message).toContain('1/2 available');

    // Ready event should confirm readiness
    const readyEvent = readyEvents[0];
    expect(readyEvent.message).toContain('2/2 ready replicas');
    expect(readyEvent.message).toContain('2/2 available replicas');
  });
});
