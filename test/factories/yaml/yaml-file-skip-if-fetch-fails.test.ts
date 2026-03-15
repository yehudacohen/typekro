/**
 * Unit tests for the yamlFile `skipIfFetchFails` feature.
 *
 * When YAML content cannot be fetched (e.g., HTTP 500 for a remote URL),
 * the optional `skipIfFetchFails` callback lets the closure check whether
 * resources are already installed on the cluster. If they are, the closure
 * returns an empty array instead of propagating the fetch error.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import type { DeploymentContext } from '../../../src/core/types/deployment.js';
import { PathResolver } from '../../../src/core/yaml/path-resolver.js';
import { yamlFile } from '../../../src/factories/kubernetes/yaml/yaml-file.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Minimal valid YAML content that `parseYamlManifests` can parse.
 */
const VALID_YAML_CONTENT = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: test-config
data:
  key: value
`;

/**
 * Create a mock KubernetesObjectApi with `read` and `create` methods.
 */
function createMockK8sApi() {
  return {
    read: mock(() => Promise.resolve({})),
    create: mock(() =>
      Promise.resolve({
        metadata: { name: 'test', namespace: 'default' },
        kind: 'ConfigMap',
        apiVersion: 'v1',
      })
    ),
    patch: mock(() => Promise.resolve({})),
    replace: mock(() => Promise.resolve({})),
    delete: mock(() => Promise.resolve({})),
    list: mock(() => Promise.resolve({ items: [] })),
  };
}

/**
 * Create a minimal DeploymentContext for testing.
 */
function createTestContext(overrides: Partial<DeploymentContext> = {}): DeploymentContext {
  const mockK8sApi = createMockK8sApi();
  return {
    kubernetesApi: mockK8sApi as unknown as k8s.KubernetesObjectApi,
    resolveReference: mock(() => Promise.resolve('default')),
    deployedResources: new Map(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('yamlFile skipIfFetchFails', () => {
  let resolveContentSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Spy on PathResolver.prototype.resolveContent so we can control fetch
    // success/failure without touching the filesystem or network.
    resolveContentSpy = spyOn(PathResolver.prototype, 'resolveContent');
  });

  afterEach(() => {
    resolveContentSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // 1. Fetch succeeds — skipIfFetchFails is never called
  // --------------------------------------------------------------------------
  it('does not call skipIfFetchFails when fetch succeeds', async () => {
    const skipCallback = mock(() => Promise.resolve(true));

    resolveContentSpy.mockResolvedValue({
      content: VALID_YAML_CONTENT,
      source: 'http' as const,
      originalPath: 'https://example.com/install.yaml',
    });

    const closure = yamlFile({
      name: 'test-resource',
      path: 'https://example.com/install.yaml',
      skipIfFetchFails: skipCallback,
    });

    const ctx = createTestContext();
    const results = await closure(ctx);

    expect(skipCallback).not.toHaveBeenCalled();
    // Should return the parsed manifest(s) from the YAML content
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.kind).toBe('ConfigMap');
  });

  // --------------------------------------------------------------------------
  // 2. Fetch fails + skipIfFetchFails returns true → empty array
  // --------------------------------------------------------------------------
  it('returns empty array when fetch fails and skipIfFetchFails returns true', async () => {
    resolveContentSpy.mockRejectedValue(new Error('HTTP 500: Internal Server Error'));

    const skipCallback = mock(() => Promise.resolve(true));

    const closure = yamlFile({
      name: 'flux-install',
      path: 'https://example.com/install.yaml',
      skipIfFetchFails: skipCallback,
    });

    const ctx = createTestContext();
    const results = await closure(ctx);

    expect(skipCallback).toHaveBeenCalledTimes(1);
    // Callback receives the kubernetesApi
    expect(skipCallback).toHaveBeenCalledWith(ctx.kubernetesApi);
    expect(results).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 3. Fetch fails + skipIfFetchFails returns false → re-throws
  // --------------------------------------------------------------------------
  it('re-throws the fetch error when skipIfFetchFails returns false', async () => {
    const fetchError = new Error('HTTP 500: Internal Server Error');
    resolveContentSpy.mockRejectedValue(fetchError);

    const skipCallback = mock(() => Promise.resolve(false));

    const closure = yamlFile({
      name: 'flux-install',
      path: 'https://example.com/install.yaml',
      skipIfFetchFails: skipCallback,
    });

    const ctx = createTestContext();

    await expect(closure(ctx)).rejects.toThrow('HTTP 500: Internal Server Error');
    expect(skipCallback).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // 4. Fetch fails + skipIfFetchFails not configured → re-throws directly
  // --------------------------------------------------------------------------
  it('re-throws the fetch error when skipIfFetchFails is not configured', async () => {
    const fetchError = new Error('Network timeout');
    resolveContentSpy.mockRejectedValue(fetchError);

    const closure = yamlFile({
      name: 'some-yaml',
      path: 'https://example.com/some.yaml',
      // No skipIfFetchFails configured
    });

    const ctx = createTestContext();

    await expect(closure(ctx)).rejects.toThrow('Network timeout');
  });

  // --------------------------------------------------------------------------
  // 5. Fetch fails + no kubernetesApi on context → re-throws
  // --------------------------------------------------------------------------
  it('re-throws the fetch error when context has no kubernetesApi', async () => {
    const fetchError = new Error('HTTP 503: Service Unavailable');
    resolveContentSpy.mockRejectedValue(fetchError);

    const skipCallback = mock(() => Promise.resolve(true));

    const closure = yamlFile({
      name: 'flux-install',
      path: 'https://example.com/install.yaml',
      skipIfFetchFails: skipCallback,
    });

    // Context without kubernetesApi
    const ctx = createTestContext({ kubernetesApi: undefined });

    await expect(closure(ctx)).rejects.toThrow('HTTP 503: Service Unavailable');
    // Callback should never be invoked — guard checks for kubernetesApi first
    expect(skipCallback).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 6. Fetch fails + skipIfFetchFails itself throws → callback error propagates
  // --------------------------------------------------------------------------
  it('propagates the error when skipIfFetchFails itself throws', async () => {
    resolveContentSpy.mockRejectedValue(new Error('HTTP 500: fetch failed'));

    const callbackError = new Error('Failed to check CRD existence');
    const skipCallback = mock(() => Promise.reject(callbackError));

    const closure = yamlFile({
      name: 'flux-install',
      path: 'https://example.com/install.yaml',
      skipIfFetchFails: skipCallback,
    });

    const ctx = createTestContext();

    await expect(closure(ctx)).rejects.toThrow('Failed to check CRD existence');
    expect(skipCallback).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // 7. Real-world pattern: callback checks for CRD existence
  // --------------------------------------------------------------------------
  it('mirrors typekro-runtime usage: checks CRD existence to decide skip', async () => {
    resolveContentSpy.mockRejectedValue(new Error('HTTP 500: GitHub is down'));

    const mockK8sApi = createMockK8sApi();

    // Simulate: CRD exists on the cluster (read succeeds)
    mockK8sApi.read.mockResolvedValue({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'helmreleases.helm.toolkit.fluxcd.io' },
    });

    const crdSpec = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'helmreleases.helm.toolkit.fluxcd.io' },
    };

    const closure = yamlFile({
      name: 'flux-install',
      path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml',
      skipIfFetchFails: async (k8sApi) => {
        // Real-world pattern: check if a sentinel CRD exists
        try {
          await k8sApi.read(crdSpec);
          return true; // CRD exists → already installed
        } catch {
          return false; // CRD missing → not installed
        }
      },
    });

    const ctx = createTestContext({
      kubernetesApi: mockK8sApi as unknown as k8s.KubernetesObjectApi,
    });

    const results = await closure(ctx);

    expect(results).toEqual([]);
    expect(mockK8sApi.read).toHaveBeenCalledTimes(1);

    // Now test the opposite: CRD does NOT exist → should re-throw
    mockK8sApi.read.mockRejectedValue(new Error('404: Not Found'));

    const closure2 = yamlFile({
      name: 'flux-install-2',
      path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml',
      skipIfFetchFails: async (k8sApi) => {
        try {
          await k8sApi.read(crdSpec);
          return true;
        } catch {
          return false;
        }
      },
    });

    await expect(closure2(ctx)).rejects.toThrow('HTTP 500: GitHub is down');
  });
});
