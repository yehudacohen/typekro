/**
 * Simple tests for StatusHydrator - New interface
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { StatusHydrator } from '../../src/core/deployment/status-hydrator.js';
import type { DeployedResource } from '../../src/core/types/deployment.js';

describe('StatusHydrator - New Interface', () => {
  let statusHydrator: StatusHydrator;
  let mockK8sApi: k8s.KubernetesObjectApi;

  beforeEach(() => {
    // Create a mock Kubernetes API
    mockK8sApi = {
      read: async () => ({
        body: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'test-deployment', namespace: 'default' },
          status: {
            replicas: 3,
            readyReplicas: 3,
            availableReplicas: 3,
            conditions: [
              { type: 'Available', status: 'True' },
              { type: 'Progressing', status: 'True' }
            ]
          }
        }
      })
    } as any;

    statusHydrator = new StatusHydrator(mockK8sApi);
  });

  it('should create StatusHydrator instance', () => {
    expect(statusHydrator).toBeDefined();
    expect(statusHydrator.getCacheStats().size).toBe(0);
  });

  it('should handle cache operations correctly', () => {
    const stats = statusHydrator.getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.keys).toEqual([]);
    
    statusHydrator.clearCache();
    expect(statusHydrator.getCacheStats().size).toBe(0);
  });

  it('should handle missing resource gracefully', async () => {
    // Create a mock API that returns 404
    const notFoundApi = {
      read: async () => {
        const error: any = new Error('Not found');
        error.statusCode = 404;
        throw error;
      }
    } as any;

    const hydrator = new StatusHydrator(notFoundApi);
    
    const mockEnhanced = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'non-existent-deployment',
        namespace: 'default'
      },
      spec: {},
      status: {}
    } as any;

    const mockDeployedResource: DeployedResource = {
      id: 'test-missing-resource',
      kind: 'Deployment',
      name: 'non-existent-deployment',
      namespace: 'default',
      manifest: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'non-existent-deployment',
          namespace: 'default'
        },
        spec: {}
      },
      status: 'deployed',
      deployedAt: new Date()
    };

    const result = await hydrator.hydrateStatus(mockEnhanced, mockDeployedResource);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle invalid resource metadata gracefully', async () => {
    const mockEnhanced = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'unknown',
        namespace: 'default'
      },
      spec: {},
      status: {}
    } as any;

    const mockDeployedResource: DeployedResource = {
      id: 'test-invalid-resource',
      kind: 'Deployment',
      name: '', // Invalid empty name
      namespace: '', // Invalid empty namespace
      manifest: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {},
        spec: {}
      },
      status: 'deployed',
      deployedAt: new Date()
    };

    const result = await statusHydrator.hydrateStatus(mockEnhanced, mockDeployedResource);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle Enhanced proxy hydration with missing resources', async () => {
    const mockEnhancedProxy = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'test-proxy',
        namespace: 'default'
      },
      spec: {},
      status: {}
    } as any;

    // Should not throw even with empty deployed resources array
    await expect(statusHydrator.hydrateEnhancedProxy(mockEnhancedProxy, [])).resolves.toBeUndefined();
  });

  it('should successfully hydrate status for valid resource', async () => {
    const mockEnhanced = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'test-deployment',
        namespace: 'default'
      },
      spec: {},
      status: {}
    } as any;

    const mockDeployedResource: DeployedResource = {
      id: 'testDeployment',
      kind: 'Deployment',
      name: 'test-deployment',
      namespace: 'default',
      manifest: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'test-deployment',
          namespace: 'default'
        },
        spec: {}
      },
      status: 'deployed',
      deployedAt: new Date()
    };

    const result = await statusHydrator.hydrateStatus(mockEnhanced, mockDeployedResource);
    
    // Should return success result
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.hydratedFields).toBeDefined();
  });
});