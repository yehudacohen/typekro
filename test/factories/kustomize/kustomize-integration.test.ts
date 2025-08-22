import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kustomization, simpleDeployment, toResourceGraph } from '../../../src/index.js';

describe('Kustomize Integration', () => {
  it('should create Kustomization with basic configuration', () => {
    const kustomizationResource = kustomization({
      name: 'webapp-config',
      source: {
        kind: 'GitRepository',
        name: 'webapp-repo',
      },
      path: './overlays/production',
    });

    expect(kustomizationResource.apiVersion).toBe('kustomize.toolkit.fluxcd.io/v1');
    expect(kustomizationResource.kind).toBe('Kustomization');
    expect(kustomizationResource.metadata.name).toBe('webapp-config');
    expect(kustomizationResource.spec.sourceRef.kind).toBe('GitRepository');
    expect(kustomizationResource.spec.sourceRef.name).toBe('webapp-repo');
    expect(kustomizationResource.spec.path).toBe('./overlays/production');
    expect(kustomizationResource.spec.interval).toBe('5m');
    expect(kustomizationResource.spec.prune).toBe(true);
    expect(kustomizationResource.spec.wait).toBe(true);
  });

  it('should support TypeKro references in patches', () => {
    const WebAppSchema = type({
      name: 'string',
      image: 'string',
      replicas: 'number',
      version: 'string',
    });

    const graph = toResourceGraph(
      {
        name: 'webapp-with-kustomize',
        apiVersion: 'example.com/v1alpha1',
        kind: 'WebApp',
        spec: WebAppSchema,
        status: type({
          ready: 'boolean',
          url: 'string',
        }),
      },
      (schema) => ({
        database: simpleDeployment({
          id: 'database',
          name: 'database',
          image: 'postgres:13',
          replicas: 1,
        }),
        webapp: kustomization({
          name: 'webapp-config',
          source: {
            kind: 'GitRepository',
            name: 'webapp-repo',
          },
          path: './base',
          patches: [
            {
              target: {
                kind: 'Deployment',
                name: 'webapp',
              },
              patch: {
                spec: {
                  replicas: schema.spec.replicas, // TypeKro schema reference
                  template: {
                    spec: {
                      containers: [
                        {
                          name: 'webapp',
                          image: schema.spec.image,
                          env: [
                            {
                              name: 'DATABASE_HOST',
                              // Cross-resource reference to database service
                              value: 'database-service',
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            },
          ],
          images: [
            {
              name: 'webapp',
              newTag: schema.spec.version, // TypeKro schema reference
            },
          ],
        }),
      }),
      (_schema, _resources) => ({
        ready: false,
        url: 'http://pending',
      })
    );

    expect(graph).toBeDefined();
    expect(graph.name).toBe('webapp-with-kustomize');

    // The resource graph should contain both the database deployment and kustomization
    expect(graph.resources).toBeDefined();
    expect(graph.resources).toHaveLength(2);

    // Find the kustomization resource
    const kustomizationResource = graph.resources.find((r: any) => r.kind === 'Kustomization');
    expect(kustomizationResource).toBeDefined();
    expect((kustomizationResource as any).spec.patches).toBeDefined();
    expect((kustomizationResource as any).spec.patches).toHaveLength(1);
    expect((kustomizationResource as any).spec.images).toBeDefined();
    expect((kustomizationResource as any).spec.images).toHaveLength(1);

    // Find the deployment resource
    const deploymentResource = graph.resources.find((r: any) => r.kind === 'Deployment');
    expect(deploymentResource).toBeDefined();
  });

  it('should support strategic merge patches', () => {
    const kustomizationResource = kustomization({
      name: 'webapp-patches',
      source: {
        kind: 'GitRepository',
        name: 'webapp-repo',
      },
      path: './base',
      patchesStrategicMerge: ['deployment-patch.yaml', 'service-patch.yaml'],
    });

    expect(kustomizationResource.spec.patchesStrategicMerge).toEqual([
      'deployment-patch.yaml',
      'service-patch.yaml',
    ]);
  });

  it('should support JSON 6902 patches', () => {
    const kustomizationResource = kustomization({
      name: 'webapp-json-patches',
      source: {
        kind: 'GitRepository',
        name: 'webapp-repo',
      },
      path: './base',
      patchesJson6902: [
        {
          target: {
            kind: 'Deployment',
            name: 'webapp',
          },
          path: 'deployment-patch.yaml',
        },
      ],
    });

    expect(kustomizationResource.spec.patchesJson6902).toHaveLength(1);
    expect((kustomizationResource as any).spec.patchesJson6902?.[0].target.kind).toBe('Deployment');
    expect((kustomizationResource as any).spec.patchesJson6902?.[0].target.name).toBe('webapp');
  });

  it('should support image and replica transformations', () => {
    const kustomizationResource = kustomization({
      name: 'webapp-transforms',
      source: {
        kind: 'GitRepository',
        name: 'webapp-repo',
      },
      path: './base',
      images: [
        {
          name: 'webapp',
          newName: 'my-registry/webapp',
          newTag: 'v1.2.3',
        },
      ],
      replicas: [
        {
          name: 'webapp',
          count: 3,
        },
      ],
    });

    expect((kustomizationResource as any).spec.images).toHaveLength(1);
    expect((kustomizationResource as any).spec.images?.[0].name).toBe('webapp');
    expect((kustomizationResource as any).spec.images?.[0].newName).toBe('my-registry/webapp');
    expect((kustomizationResource as any).spec.images?.[0].newTag).toBe('v1.2.3');

    expect((kustomizationResource as any).spec.replicas).toHaveLength(1);
    expect((kustomizationResource as any).spec.replicas?.[0].name).toBe('webapp');
    expect((kustomizationResource as any).spec.replicas?.[0].count).toBe(3);
  });

  it('should have readiness evaluator attached', () => {
    const kustomizationResource = kustomization({
      name: 'test-kustomization',
      source: {
        kind: 'GitRepository',
        name: 'test-repo',
      },
    });

    expect(kustomizationResource.readinessEvaluator).toBeDefined();
  });
});
