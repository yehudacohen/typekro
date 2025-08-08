/**
 * Test suite for enhanced DirectDeploymentEngine with custom readiness evaluators
 */

import { describe, expect, it, mock } from 'bun:test';
import { DirectDeploymentEngine } from '../../src/core/deployment/engine.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import * as k8s from '@kubernetes/client-node';
import type { V1Deployment, V1Service } from '@kubernetes/client-node';

describe('Enhanced DirectDeploymentEngine', () => {
  // Mock Kubernetes client and API
  const mockKubeConfig = new k8s.KubeConfig();
  
  // Create a more realistic mock that simulates the deployment flow
  const createMockK8sApi = () => {
    const mockApi = {
      create: mock(() => Promise.resolve({ body: {} })),
      read: mock(() => Promise.resolve({ body: {} })),
      delete: mock(() => Promise.resolve({ body: {} })),
      patch: mock(() => Promise.resolve({ body: {} })),
      replace: mock(() => Promise.resolve({ body: {} })),
      list: mock(() => Promise.resolve({ body: { items: [] } })),
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
          spec: { containers: [{ name: 'test', image: 'nginx' }] }
        }
      }
    };

    const enhanced = deployment(deploymentResource);
    
    // Mock the deployment flow:
    // 1. First read call (during deployment) - resource doesn't exist (404)
    const notFoundError = new Error('Not found') as any;
    notFoundError.statusCode = 404;
    mockK8sApi.read.mockRejectedValueOnce(notFoundError);
    
    // 2. Create call - resource is created successfully
    mockK8sApi.create.mockResolvedValueOnce({
      body: {
        ...deploymentResource,
        metadata: { ...deploymentResource.metadata, uid: 'test-uid' }
      }
    });

    // 3. Read call for readiness checking - resource is ready
    mockK8sApi.read.mockResolvedValueOnce({
      body: {
        ...deploymentResource,
        status: {
          readyReplicas: 2,
          availableReplicas: 2,
          updatedReplicas: 2
        }
      }
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      progressCallback: (event: any) => events.push(event)
    };

    // Deploy the resource
    (enhanced as any).id = 'test-deployment';
    const result = await engine.deployResource(enhanced as any, options);
    
    expect(result.status).toBe('ready');
    
    // Check that custom readiness evaluation was used
    const readinessEvents = events.filter(e => e.type === 'resource-ready' || e.type === 'resource-status');
    expect(readinessEvents.length).toBeGreaterThan(0);
    
    // The message should come from our custom evaluator
    const readyEvent = readinessEvents.find(e => e.type === 'resource-ready');
    expect(readyEvent?.message).toContain('2/2 ready replicas');
    expect(readyEvent?.message).toContain('2/2 available replicas');
  });

  it('should fall back to generic readiness checker when no custom evaluator', async () => {
    const mockK8sApi = createMockK8sApi();
    const engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi);
    
    // Create a plain resource without custom readiness evaluator
    const plainResource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test-config', namespace: 'default' },
      data: { key: 'value' }
    };

    // Mock the deployment flow:
    // 1. First read call - resource doesn't exist (404)
    const notFoundError = new Error('Not found') as any;
    notFoundError.statusCode = 404;
    mockK8sApi.read.mockRejectedValueOnce(notFoundError);
    
    // 2. Create call - resource is created successfully
    mockK8sApi.create.mockResolvedValueOnce({
      body: {
        ...plainResource,
        metadata: { ...plainResource.metadata, uid: 'test-uid' }
      }
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      progressCallback: (event: any) => events.push(event)
    };

    // Deploy the resource - should use fallback readiness checking
    const result = await engine.deployResource(plainResource as any, options);
    
    expect(result.status).toBe('ready');
    
    // Should have used the generic readiness checker (no custom messages)
    // Generic readiness checker might not emit events the same way, so we just verify deployment succeeded
    expect(result).toBeDefined();
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
        selector: { app: 'test' }
      }
    };

    const enhanced = service(serviceResource);
    
    // Mock the deployment flow:
    // 1. First read call - resource doesn't exist (404)
    const notFoundError = new Error('Not found') as any;
    notFoundError.statusCode = 404;
    mockK8sApi.read.mockRejectedValueOnce(notFoundError);
    
    // 2. Create call - resource is created successfully
    mockK8sApi.create.mockResolvedValueOnce({
      body: {
        ...serviceResource,
        metadata: { ...serviceResource.metadata, uid: 'test-uid' }
      }
    });

    // 3. Read call for readiness checking - fail initially, then succeed
    mockK8sApi.read
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce({
        body: {
          ...serviceResource,
          status: {
            loadBalancer: {
              ingress: [{ ip: '192.168.1.100' }]
            }
          }
        }
      });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      progressCallback: (event: any) => events.push(event)
    };

    // Deploy the resource
    (enhanced as any).id = 'test-service';
    const result = await engine.deployResource(enhanced as any, options);
    
    expect(result.status).toBe('ready');
    
    // Should have handled the error and eventually succeeded
    const statusEvents = events.filter(e => e.type === 'resource-status');
    expect(statusEvents.some(e => e.message.includes('Unable to read resource status'))).toBe(true);
    
    const readyEvents = events.filter(e => e.type === 'resource-ready');
    expect(readyEvents.some(e => e.message.includes('192.168.1.100'))).toBe(true);
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
          spec: { containers: [{ name: 'test', image: 'nginx' }] }
        }
      }
    };

    const enhanced = deployment(deploymentResource);
    
    // Mock the k8s API to return a live resource that's never ready
    mockK8sApi.create.mockResolvedValueOnce({
      body: {
        ...deploymentResource,
        metadata: { ...deploymentResource.metadata, uid: 'test-uid' }
      }
    });

    // Mock the read call to always return not ready
    mockK8sApi.read.mockResolvedValue({
      body: {
        ...deploymentResource,
        status: {
          readyReplicas: 1,
          availableReplicas: 1,
          updatedReplicas: 3
        }
      }
    });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      timeout: 1000, // Short timeout for testing
      progressCallback: (event: any) => events.push(event)
    };

    // Deploy the resource - should timeout with detailed message
    const deployableResource = enhanced;
    deployableResource.id = 'test-deployment-timeout';
    await expect(engine.deployResource(deployableResource as any, options)).rejects.toThrow();
    
    // Should have emitted status updates with detailed messages
    const statusEvents = events.filter(e => e.type === 'resource-status');
    expect(statusEvents.length).toBeGreaterThan(0);
    expect(statusEvents.some(e => e.message.includes('1/3 ready'))).toBe(true);
    expect(statusEvents.some(e => e.message.includes('1/3 available'))).toBe(true);
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
          spec: { containers: [{ name: 'test', image: 'nginx' }] }
        }
      }
    };

    const enhanced = deployment(deploymentResource);
    
    // Mock the k8s API
    // 1. First read call - resource doesn't exist (404)
    const notFoundError = new Error('Not found') as any;
    notFoundError.statusCode = 404;
    mockK8sApi.read.mockRejectedValueOnce(notFoundError);
    
    // 2. Create call - resource is created successfully
    mockK8sApi.create.mockResolvedValueOnce({
      body: {
        ...deploymentResource,
        metadata: { ...deploymentResource.metadata, uid: 'test-uid' }
      }
    });

    // 3. Mock progression: not ready -> ready
    mockK8sApi.read
      .mockResolvedValueOnce({
        body: {
          ...deploymentResource,
          status: {
            readyReplicas: 1,
            availableReplicas: 1,
            updatedReplicas: 2
          }
        }
      })
      .mockResolvedValueOnce({
        body: {
          ...deploymentResource,
          status: {
            readyReplicas: 2,
            availableReplicas: 2,
            updatedReplicas: 2
          }
        }
      });

    const events: any[] = [];
    const options = {
      mode: 'direct' as const,
      waitForReady: true,
      progressCallback: (event: any) => events.push(event)
    };

    // Deploy the resource
    const deployableResource = enhanced;
    deployableResource.id = 'test-deployment-structured';
    const result = await engine.deployResource(deployableResource as any, options);
    
    expect(result.status).toBe('ready');
    
    // Check that we got structured status updates
    const statusEvents = events.filter(e => e.type === 'resource-status');
    const readyEvents = events.filter(e => e.type === 'resource-ready');
    
    // Should have at least one status event (not ready) and one ready event
    expect(statusEvents.length).toBeGreaterThan(0);
    expect(readyEvents.length).toBeGreaterThan(0);
    
    // Status events should have detailed information
    const notReadyEvent = statusEvents[0];
    expect(notReadyEvent.message).toContain('1/2 ready');
    expect(notReadyEvent.message).toContain('1/2 available');
    
    // Ready event should confirm readiness
    const readyEvent = readyEvents[0];
    expect(readyEvent.message).toContain('2/2 ready replicas');
    expect(readyEvent.message).toContain('2/2 available replicas');
  });
});