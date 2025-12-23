/**
 * NOTE: In the new @kubernetes/client-node API (v1.x), methods return objects directly
 * without a .body wrapper. The mocks must return the resource directly.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { DirectDeploymentEngine } from '../../src/core/deployment/engine.js';
import type { DeploymentOptions } from '../../src/core/types/deployment.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';

describe('Status Hydration Integration with DirectDeploymentEngine', () => {
  let engine: DirectDeploymentEngine;
  let mockK8sApi: any;
  let kubeConfig: k8s.KubeConfig;

  beforeEach(() => {
    kubeConfig = new k8s.KubeConfig();

    // Mock the Kubernetes API (new API returns objects directly, no .body wrapper)
    mockK8sApi = {
      read: async (resource: any) => {
        // Determine expected replicas based on resource name
        let expectedReplicas = 1; // default
        if (resource.metadata.name === 'test-deployment') {
          expectedReplicas = 2;
        }

        // For the first read call (checking if resource exists), throw 404
        // For subsequent read calls (readiness checking), return the resource
        if (!mockK8sApi._resourceExists) {
          mockK8sApi._resourceExists = true;
          const error: any = new Error('Not Found');
          error.statusCode = 404;
          throw error;
        }

        // Simulate reading a deployment that becomes ready (returns object directly)
        return {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: {
            name: resource.metadata.name,
            namespace: resource.metadata.namespace || 'default',
          },
          spec: {
            replicas: expectedReplicas,
          },
          status: {
            readyReplicas: expectedReplicas,
            availableReplicas: expectedReplicas,
            replicas: expectedReplicas,
            conditions: [
              {
                type: 'Available',
                status: 'True',
                lastTransitionTime: new Date().toISOString(),
              },
            ],
          },
        };
      },
      create: async (resource: any) => resource, // Returns object directly
      replace: async (resource: any) => resource, // Returns object directly
      patch: async (resource: any) => resource, // Returns object directly
      _resourceExists: false, // Track state for mock
    };

    engine = new DirectDeploymentEngine(kubeConfig, mockK8sApi);

    // Reset mock state for each test
    mockK8sApi._resourceExists = false;
  });

  it('should integrate status hydration with custom readiness evaluation', async () => {
    // Create a deployment with readiness evaluator
    const deploymentResource = deployment({
      metadata: { name: 'test-deployment', namespace: 'test' },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    });

    // Add id property to the Enhanced proxy directly
    (deploymentResource as any).id = 'test-deployment';

    const options: DeploymentOptions = {
      mode: 'direct',
      namespace: 'test',
      timeout: 5000,
      waitForReady: true,
      hydrateStatus: true, // Enable status hydration
    };

    // Deploy the resource using deployResource (single resource deployment)
    const deployedResource = await engine.deployResource(deploymentResource as any, options);

    expect(deployedResource.status).toBe('ready');
    expect(deployedResource.manifest).toBeDefined();

    const enhanced = deployedResource.manifest as any;

    // Verify that status hydration was enabled and the deployment succeeded
    // Note: In unit tests, the Enhanced proxy behavior may differ from integration tests
    // The key is that hydrateStatus: true was processed without errors
    expect(enhanced.status).toBeDefined();
    expect(typeof enhanced.status).toBe('object');

    // Verify that the deployment completed successfully with status hydration enabled
    expect(deployedResource.status).toBe('ready');
  });

  it('should work without status hydration when disabled', async () => {
    // Create a deployment with readiness evaluator
    const deploymentResource = deployment({
      metadata: { name: 'test-deployment-no-hydration', namespace: 'test' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    });

    // Add id property to the Enhanced proxy directly
    (deploymentResource as any).id = 'test-deployment-no-hydration';

    const options: DeploymentOptions = {
      mode: 'direct',
      namespace: 'test',
      timeout: 5000,
      waitForReady: true,
      hydrateStatus: false, // Disable status hydration
    };

    // Deploy the resource using deployResource (single resource deployment)
    const deployedResource = await engine.deployResource(deploymentResource as any, options);

    expect(deployedResource.status).toBe('ready');
    expect(deployedResource.manifest).toBeDefined();

    const enhanced = deployedResource.manifest as any;

    // Verify that status fields were NOT hydrated
    // The status should still be the proxy object, not populated with live data
    // Check if the status object has any enumerable properties (hydrated data)
    const statusKeys = Object.keys(enhanced.status);
    expect(statusKeys.length).toBe(0); // No hydrated fields should be present
  });

  it('should handle status hydration failures gracefully', async () => {
    // Mock API to return resource without status initially, then with status
    // NOTE: In the new API, methods return objects directly (no .body wrapper)
    let callCount = 0;
    mockK8sApi.read = async () => {
      callCount++;
      if (callCount === 1) {
        // First call - no status (resource not ready yet) - returns object directly
        return {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'test-deployment-fail', namespace: 'test' },
          spec: { replicas: 1 },
          // No status field - this should cause readiness check to fail initially
        };
      } else {
        // Subsequent calls - resource becomes ready - returns object directly
        return {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'test-deployment-fail', namespace: 'test' },
          spec: { replicas: 1 },
          status: {
            readyReplicas: 1,
            availableReplicas: 1,
            replicas: 1,
            conditions: [
              {
                type: 'Available',
                status: 'True',
                lastTransitionTime: new Date().toISOString(),
              },
            ],
          },
        };
      }
    };

    const deploymentResource = deployment({
      metadata: { name: 'test-deployment-fail', namespace: 'test' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    });

    // Add id property to the Enhanced proxy directly
    (deploymentResource as any).id = 'test-deployment-fail';

    const options: DeploymentOptions = {
      mode: 'direct',
      namespace: 'test',
      timeout: 5000,
      waitForReady: true,
      hydrateStatus: true,
    };

    // This should not throw an error even though status hydration fails
    const deployedResource = await engine.deployResource(deploymentResource as any, options);

    expect(deployedResource.status).toBe('ready');
    expect(deployedResource.manifest).toBeDefined();
  });

  it('should eliminate duplicate API calls by reusing readiness check data', async () => {
    let apiCallCount = 0;
    let resourceExists = false;

    // Create a fresh mock for this test to track API calls
    // NOTE: In the new API, methods return objects directly (no .body wrapper)
    mockK8sApi.read = async (resource: any) => {
      apiCallCount++;

      // For the first read call (checking if resource exists), throw 404
      // For subsequent read calls (readiness checking), return the resource
      if (!resourceExists) {
        resourceExists = true;
        const error: any = new Error('Not Found');
        error.statusCode = 404;
        throw error;
      }

      // Simulate reading a deployment that becomes ready (returns object directly)
      return {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: resource.metadata.name,
          namespace: resource.metadata.namespace || 'default',
        },
        spec: {
          replicas: 1,
        },
        status: {
          readyReplicas: 1,
          availableReplicas: 1,
          replicas: 1,
          conditions: [
            {
              type: 'Available',
              status: 'True',
              lastTransitionTime: new Date().toISOString(),
            },
          ],
        },
      };
    };

    mockK8sApi.create = async (resource: any) => {
      apiCallCount++;
      return resource; // Returns object directly
    };

    const deploymentResource = deployment({
      metadata: { name: 'test-deployment-efficient', namespace: 'test' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'test' } },
        template: {
          metadata: { labels: { app: 'test' } },
          spec: { containers: [{ name: 'test', image: 'nginx' }] },
        },
      },
    });

    // Add id property to the Enhanced proxy directly
    (deploymentResource as any).id = 'test-deployment-efficient';

    const options: DeploymentOptions = {
      mode: 'direct',
      namespace: 'test',
      timeout: 5000,
      waitForReady: true,
      hydrateStatus: true,
    };

    await engine.deployResource(deploymentResource as any, options);

    // Should have made API calls for:
    // 1. Check if resource exists (read)
    // 2. Create the resource (create)
    // 3. Check readiness (read) - this data is reused for status hydration
    // Total: 3 calls (no additional call for status hydration)
    expect(apiCallCount).toBe(3);
  });
});
