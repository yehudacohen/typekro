/**
 * Unit tests for deployment-state-discovery.ts — pure functions that
 * reconstruct a DeploymentStateRecord from tagged cluster resources.
 */

import { describe, expect, it } from 'bun:test';
// We can't import the private functions directly, so we test through
// the public API by constructing fake resources and calling
// discoverDeployedResourcesByInstance with a mock k8sApi.
import { discoverDeployedResourcesByInstance } from '../../src/core/deployment/deployment-state-discovery.js';
import type { GvkTarget } from '../../src/core/deployment/deployment-state-discovery.js';
import {
  DEPENDS_ON_ANNOTATION,
  DEPLOYMENT_ID_ANNOTATION,
  FACTORY_NAME_ANNOTATION,
  FACTORY_NAME_LABEL,
  FACTORY_NAMESPACE_ANNOTATION,
  INSTANCE_NAME_ANNOTATION,
  INSTANCE_NAME_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  RESOURCE_ID_ANNOTATION,
  SCOPES_ANNOTATION,
} from '../../src/core/deployment/resource-tagging.js';

/** Build a fake tagged K8s resource as it would appear from a list call. */
function makeTaggedResource(opts: {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  factoryName: string;
  instanceName: string;
  deploymentId: string;
  resourceId: string;
  scopes?: string[];
  dependencies?: string[];
  creationTimestamp?: Date;
}) {
  return {
    apiVersion: opts.apiVersion,
    kind: opts.kind,
    metadata: {
      name: opts.name,
      namespace: opts.namespace ?? 'default',
      creationTimestamp: opts.creationTimestamp ?? new Date('2026-04-05T00:00:00Z'),
      labels: {
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        [FACTORY_NAME_LABEL]: opts.factoryName,
        [INSTANCE_NAME_LABEL]: opts.instanceName,
      },
      annotations: {
        [FACTORY_NAME_ANNOTATION]: opts.factoryName,
        [INSTANCE_NAME_ANNOTATION]: opts.instanceName,
        [DEPLOYMENT_ID_ANNOTATION]: opts.deploymentId,
        [RESOURCE_ID_ANNOTATION]: opts.resourceId,
        [FACTORY_NAMESPACE_ANNOTATION]: 'factory-ns',
        ...(opts.scopes?.length && { [SCOPES_ANNOTATION]: JSON.stringify(opts.scopes) }),
        ...(opts.dependencies?.length && { [DEPENDS_ON_ANNOTATION]: JSON.stringify(opts.dependencies) }),
      },
    },
  };
}

/**
 * Create a mock KubernetesObjectApi that returns a fixed list of
 * resources for any list call whose labelSelector matches the factory.
 */
function makeFakeK8sApi(resources: ReturnType<typeof makeTaggedResource>[]) {
  return {
    list: async (
      _apiVersion: string,
      _kind: string,
      _namespace?: string,
      _pretty?: string,
      _exact?: boolean,
      _exportt?: boolean,
      _fieldSelector?: string,
      labelSelector?: string
    ) => {
      // Only return resources when the selector matches our factory
      if (labelSelector?.includes('my-factory')) {
        // Filter by kind to simulate per-GVK list calls
        const matching = resources.filter(
          (r) => r.apiVersion === _apiVersion && r.kind === _kind
        );
        return { items: matching };
      }
      return { items: [] };
    },
  } as any;
}

describe('discoverDeployedResourcesByInstance', () => {
  it('returns undefined when no resources match', async () => {
    const api = makeFakeK8sApi([]);
    const result = await discoverDeployedResourcesByInstance(api, {
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      knownGvks: [{ apiVersion: 'v1', kind: 'ConfigMap', namespaced: true }],
    });
    expect(result).toBeUndefined();
  });

  it('discovers resources and builds a record', async () => {
    const db = makeTaggedResource({
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      name: 'database',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'database',
    });
    const app = makeTaggedResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      name: 'my-app',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'app',
      dependencies: ['database'],
    });

    const knownGvks: GvkTarget[] = [
      { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', namespaced: true },
      { apiVersion: 'apps/v1', kind: 'Deployment', namespaced: true },
    ];

    const api = makeFakeK8sApi([db, app]);
    const result = await discoverDeployedResourcesByInstance(api, {
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      knownGvks,
    });

    expect(result).toBeDefined();
    expect(result!.resources).toHaveLength(2);
    expect(result!.resources.map((r) => r.id).sort()).toEqual(['app', 'database']);
    expect(result!.deploymentId).toBe('dep-1');
  });

  it('reconstructs dependency graph from annotations', async () => {
    const db = makeTaggedResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: 'db',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'database',
    });
    const pooler = makeTaggedResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: 'pooler',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'pooler',
      dependencies: ['database'],
    });
    const app = makeTaggedResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: 'app',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'app',
      dependencies: ['pooler'],
    });

    const api = makeFakeK8sApi([db, pooler, app]);
    const result = await discoverDeployedResourcesByInstance(api, {
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      knownGvks: [{ apiVersion: 'v1', kind: 'ConfigMap', namespaced: true }],
    });

    expect(result).toBeDefined();
    const graph = result!.dependencyGraph;
    expect(graph.getDependencies('pooler')).toEqual(['database']);
    expect(graph.getDependencies('app')).toEqual(['pooler']);
    expect(graph.getDependencies('database')).toEqual([]);
  });

  it('silently drops dangling dependency edges', async () => {
    const app = makeTaggedResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: 'app',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'app',
      dependencies: ['deleted-resource'],
    });

    const api = makeFakeK8sApi([app]);
    const result = await discoverDeployedResourcesByInstance(api, {
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      knownGvks: [{ apiVersion: 'v1', kind: 'ConfigMap', namespaced: true }],
    });

    expect(result).toBeDefined();
    // 'deleted-resource' doesn't exist, so no edge added, no crash
    expect(result!.dependencyGraph.getDependencies('app')).toEqual([]);
  });

  it('skips resources without resource-id annotation', async () => {
    const good = makeTaggedResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: 'good',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'good',
    });
    // Resource with no resource-id — simulate by removing annotation
    const bad = makeTaggedResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: 'bad',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'bad',
    });
    delete (bad.metadata.annotations as any)[RESOURCE_ID_ANNOTATION];

    const api = makeFakeK8sApi([good, bad]);
    const result = await discoverDeployedResourcesByInstance(api, {
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      knownGvks: [{ apiVersion: 'v1', kind: 'ConfigMap', namespaced: true }],
    });

    expect(result).toBeDefined();
    expect(result!.resources).toHaveLength(1);
    expect(result!.resources[0]!.id).toBe('good');
  });

  it('preserves scopes annotation on discovered resources', async () => {
    const operator = makeTaggedResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: 'operator',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'operator',
      scopes: ['cluster'],
    });

    const api = makeFakeK8sApi([operator]);
    const result = await discoverDeployedResourcesByInstance(api, {
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      knownGvks: [{ apiVersion: 'v1', kind: 'ConfigMap', namespaced: true }],
    });

    expect(result).toBeDefined();
    const manifest = result!.resources[0]!.manifest;
    const scopes = manifest.metadata?.annotations?.[SCOPES_ANNOTATION];
    expect(scopes).toBe('["cluster"]');
  });

  it('deduplicates resources seen at multiple GVK versions', async () => {
    const resource = makeTaggedResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: 'dedup-test',
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      deploymentId: 'dep-1',
      resourceId: 'dedup',
    });

    // Same resource returned by two "versions" of the GVK
    const api = makeFakeK8sApi([resource]);
    const result = await discoverDeployedResourcesByInstance(api, {
      factoryName: 'my-factory',
      instanceName: 'my-instance',
      knownGvks: [
        { apiVersion: 'v1', kind: 'ConfigMap', namespaced: true },
        { apiVersion: 'v1', kind: 'ConfigMap', namespaced: true },
      ],
    });

    expect(result).toBeDefined();
    expect(result!.resources).toHaveLength(1);
  });
});
