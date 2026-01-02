/**
 * Tests for CRD establishment logic in DirectDeploymentEngine
 *
 * NOTE: In the new @kubernetes/client-node API (v1.x), methods return objects directly
 * without a .body wrapper. The mocks must return the resource directly.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { DependencyGraph, type DeployableK8sResource, DirectDeploymentEngine, type Enhanced, type ResourceGraph,  } from '../../src/core.js';

// Mock the Kubernetes client (new API returns objects directly, no .body wrapper)
const mockK8sApi = {
  read: mock((resource?: any) => {
    // Mock CRD status check - return established CRD (object directly)
    if (resource?.kind === 'CustomResourceDefinition') {
      return Promise.resolve({
        status: {
          conditions: [{ type: 'Established', status: 'True' }],
        },
      });
    }
    return Promise.reject({ statusCode: 404 });
  }),
  list: mock((apiVersion?: string, kind?: string) => {
    // Mock CRD listing for CRD name discovery (object directly)
    if (apiVersion === 'apiextensions.k8s.io/v1' && kind === 'CustomResourceDefinition') {
      return Promise.resolve({
        items: [
          {
            metadata: { name: 'myresources.example.com' },
            spec: {
              group: 'example.com',
              names: { kind: 'MyResource', plural: 'myresources' },
            },
          },
          {
            metadata: { name: 'slowresources.example.com' },
            spec: {
              group: 'example.com',
              names: { kind: 'SlowResource', plural: 'slowresources' },
            },
          },
        ],
      });
    }
    return Promise.resolve({ items: [] });
  }),
  create: mock((resource?: any) =>
    // Returns object directly (no .body wrapper)
    Promise.resolve({
      ...resource,
      metadata: { ...resource.metadata, uid: 'test-uid' },
    })
  ),
  patch: mock((resource?: any) =>
    // Returns object directly (no .body wrapper)
    Promise.resolve({
      ...resource,
      metadata: { ...resource.metadata, uid: 'test-uid' },
    })
  ),
};

const mockKubeConfig = {} as any;
const mockReferenceResolver = {
  resolveReferences: mock((resource: any) => Promise.resolve(resource)),
} as any;

// Helper function to create a mock CRD
function createMockCRD(name: string): DeployableK8sResource<Enhanced<any, any>> {
  const crd = {
    id: `crd-${name}`,
    kind: 'CustomResourceDefinition',
    apiVersion: 'apiextensions.k8s.io/v1',
    metadata: { name: `${name}.example.com` },
    spec: {
      group: 'example.com',
      versions: [{ name: 'v1', served: true, storage: true }],
      scope: 'Namespaced',
      names: {
        plural: `${name}s`,
        singular: name,
        kind: name.charAt(0).toUpperCase() + name.slice(1),
      },
    },
    status: {},
  } as DeployableK8sResource<Enhanced<any, any>>;

  // Add a mock readiness evaluator
  Object.defineProperty(crd, 'readinessEvaluator', {
    value: () => ({ ready: true, message: 'Mock CRD ready' }),
    enumerable: false,
    configurable: true,
    writable: false,
  });

  return crd;
}

// Helper function to create a mock custom resource
function createMockCustomResource(kind: string): DeployableK8sResource<Enhanced<any, any>> {
  const resource = {
    id: `custom-${kind.toLowerCase()}`,
    kind: kind,
    apiVersion: 'example.com/v1',
    metadata: { name: `test-${kind.toLowerCase()}` },
    spec: { replicas: 1 },
    status: {},
  } as DeployableK8sResource<Enhanced<any, any>>;

  // Add a mock readiness evaluator
  Object.defineProperty(resource, 'readinessEvaluator', {
    value: () => ({ ready: true, message: 'Mock custom resource ready' }),
    enumerable: false,
    configurable: true,
    writable: false,
  });

  return resource;
}

describe('DirectDeploymentEngine CRD Establishment', () => {
  let engine: DirectDeploymentEngine;

  beforeEach(() => {
    engine = new DirectDeploymentEngine(
      mockKubeConfig,
      mockK8sApi as any,
      mockReferenceResolver as any
    );

    // Clear mocks
    mockK8sApi.read.mockClear();
    mockK8sApi.list.mockClear();
    mockK8sApi.create.mockClear();
    mockK8sApi.patch.mockClear();
    mockReferenceResolver.resolveReferences.mockClear();
  });

  it('should wait for CRD establishment before deploying custom resources', async () => {
    // Create a resource graph with a CRD and a custom resource
    const crd = createMockCRD('myresource');
    const customResource = createMockCustomResource('MyResource');

    const dependencyGraph = new DependencyGraph();
    dependencyGraph.addNode(crd.id, crd);
    dependencyGraph.addNode(customResource.id, customResource);

    const graph: ResourceGraph = {
      name: 'test-crd-graph',
      resources: [
        { id: crd.id, manifest: crd },
        { id: customResource.id, manifest: customResource },
      ],
      dependencyGraph,
    };

    const options = {
      mode: 'direct' as const,
      namespace: 'test-namespace',
      timeout: 5000,
      waitForReady: false,
    };

    // Deploy the graph
    const result = await engine.deploy(graph, options);

    // Verify deployment was successful
    expect(result.status).toBe('success');
    expect(result.resources).toHaveLength(2);

    // Verify deployment was successful
    expect(result.status).toBe('success');
    expect(result.resources).toHaveLength(2);

    // The CRD already exists (mock returns it as established), so only the custom resource is created
    expect(mockK8sApi.create).toHaveBeenCalledTimes(1);
    expect(mockK8sApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'MyResource',
        apiVersion: 'example.com/v1',
      })
    );

    // Verify CRD status was checked for establishment before deploying custom resource
    expect(mockK8sApi.read).toHaveBeenCalledWith({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'myresources.example.com' },
    });
  });

  it('should handle graphs with no CRDs normally', async () => {
    // Create a resource graph with only regular resources
    const deployment = {
      id: 'test-deployment',
      kind: 'Deployment',
      apiVersion: 'apps/v1',
      metadata: { name: 'test-deployment' },
      spec: { replicas: 1 },
      status: {},
    } as DeployableK8sResource<Enhanced<any, any>>;

    // Add a mock readiness evaluator
    Object.defineProperty(deployment, 'readinessEvaluator', {
      value: () => ({ ready: true, message: 'Mock deployment ready' }),
      enumerable: false,
      configurable: true,
      writable: false,
    });

    const dependencyGraph = new DependencyGraph();
    dependencyGraph.addNode(deployment.id, deployment);

    const graph: ResourceGraph = {
      name: 'test-no-crd-graph',
      resources: [{ id: deployment.id, manifest: deployment }],
      dependencyGraph,
    };

    const options = {
      mode: 'direct' as const,
      namespace: 'test-namespace',
      timeout: 5000,
      waitForReady: false,
    };

    // Deploy the graph
    const result = await engine.deploy(graph, options);

    // Verify deployment was successful
    expect(result.status).toBe('success');
    expect(result.resources).toHaveLength(1);

    // Verify no CRD status checks were made
    expect(mockK8sApi.read).not.toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'CustomResourceDefinition',
      })
    );
  });

  it('should handle CRD establishment timeout gracefully for custom resources', async () => {
    // Mock CRD status to never be established
    // NOTE: In the new @kubernetes/client-node API (v1.x), methods return objects directly
    mockK8sApi.read.mockImplementation((resource?: any) => {
      if (resource?.kind === 'CustomResourceDefinition') {
        return Promise.resolve({
          status: {
            conditions: [
              { type: 'Established', status: 'False' }, // Never established
            ],
          },
        });
      }
      return Promise.reject({ statusCode: 404 });
    });

    // Also mock list to return the SlowResource CRD
    // NOTE: In the new @kubernetes/client-node API (v1.x), methods return objects directly
    mockK8sApi.list.mockImplementation((apiVersion?: string, kind?: string) => {
      if (apiVersion === 'apiextensions.k8s.io/v1' && kind === 'CustomResourceDefinition') {
        return Promise.resolve({
          items: [
            {
              metadata: { name: 'slowresources.example.com' },
              spec: {
                group: 'example.com',
                names: { kind: 'SlowResource', plural: 'slowresources' },
              },
            },
          ],
        });
      }
      return Promise.resolve({ items: [] });
    });

    // Only create a custom resource (no CRD in the graph)
    // This simulates trying to deploy a CR when its CRD isn't established
    const customResource = createMockCustomResource('SlowResource');
    const dependencyGraph = new DependencyGraph();
    dependencyGraph.addNode(customResource.id, customResource);

    const graph: ResourceGraph = {
      name: 'test-slow-cr-graph',
      resources: [{ id: customResource.id, manifest: customResource }],
      dependencyGraph,
    };

    const options = {
      mode: 'direct' as const,
      namespace: 'test-namespace',
      timeout: 3000, // Short timeout for test
      waitForReady: false,
    };

    // This should result in a failed deployment due to CRD establishment timeout
    const result = await engine.deploy(graph, options);

    // The deployment should fail because the only resource failed to deploy
    expect(result.status).toBe('failed');
    expect(result.errors).toHaveLength(1);
    // With abort signal support, the error can be either:
    // - "Timeout waiting for CRD...to be established" (if CRD timeout is reached first)
    // - "Delay aborted" or "Operation aborted" (if deployment timeout triggers abort signal)
    const errorMessage = result.errors?.[0]?.error.message || '';
    const isExpectedError = 
      /Timeout waiting for CRD.*to be established/.test(errorMessage) ||
      /aborted/i.test(errorMessage);
    expect(isExpectedError).toBe(true);
  });
});
