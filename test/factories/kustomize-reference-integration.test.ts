import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph } from '../../src/core/serialization/core.js';
import { gitRepository } from '../../src/factories/flux/git-repository.js';
import { kustomization } from '../../src/factories/flux/kustomize/kustomization.js';
import { isKubernetesRef } from '../../src/utils/type-guards.js';

describe('Kustomize Reference Integration', () => {
  it('should support TypeKro references in patches', () => {
    const graph = toResourceGraph(
      {
        name: 'webapp-with-kustomize',
        apiVersion: 'example.com/v1alpha1',
        kind: 'WebAppKustomize',
        spec: type({
          appName: 'string',
          replicas: 'number',
          image: 'string',
          version: 'string',
        }),
        status: type({
          ready: 'boolean',
          url: 'string',
        }),
      },
      (schema) => ({
        // Source repository
        source: gitRepository({
          id: 'webappSourceRepo',
          name: 'webapp-source',
          url: 'https://github.com/example/webapp-manifests',
          ref: { branch: 'main' },
          interval: '5m',
        }),

        // Kustomization with TypeKro references in patches
        kustomize: kustomization({
          id: 'webappKustomize',
          name: 'webapp-app',
          source: {
            kind: 'GitRepository',
            name: 'webapp-source',
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
                  replicas: schema.spec.replicas, // Schema reference
                  template: {
                    spec: {
                      containers: [
                        {
                          name: 'webapp',
                          image: schema.spec.image, // Schema reference
                          env: [
                            {
                              name: 'APP_VERSION',
                              value: schema.spec.version, // Schema reference
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
              newTag: schema.spec.version, // Schema reference in image tag
            },
          ],
          replicas: [
            {
              name: 'webapp',
              count: schema.spec.replicas, // Schema reference in replicas
            },
          ],
        }),
      }),
      (_schema, _resources) => ({
        ready: true,
        url: 'https://webapp.example.com',
      })
    );

    const resources = graph.resources;
    const kustomizeResource = resources.find((r) => r.kind === 'Kustomization');

    // Verify the kustomization resource exists
    expect(kustomizeResource).toBeDefined();
    expect(kustomizeResource!.kind).toBe('Kustomization');
    expect(kustomizeResource!.apiVersion).toBe('kustomize.toolkit.fluxcd.io/v1');

    // Verify patches contain references
    const patches = (kustomizeResource as any).spec?.patches;
    expect(patches).toBeDefined();
    expect(patches).toHaveLength(1);

    const patch = patches![0];
    expect(patch.target?.kind).toBe('Deployment');
    expect(patch.target?.name).toBe('webapp');

    // Check that schema references are preserved in patch content
    const patchContent = patch.patch as any;
    expect(isKubernetesRef(patchContent.spec.replicas)).toBe(true);
    expect(isKubernetesRef(patchContent.spec.template.spec.containers[0].image)).toBe(true);
    expect(isKubernetesRef(patchContent.spec.template.spec.containers[0].env[0].value)).toBe(true);

    // Check that references in images array are preserved
    const images = (kustomizeResource as any).spec?.images;
    expect(images).toBeDefined();
    expect(images).toHaveLength(1);
    expect(isKubernetesRef(images![0].newTag)).toBe(true);

    // Check that references in replicas array are preserved
    const replicas = (kustomizeResource as any).spec?.replicas;
    expect(replicas).toBeDefined();
    expect(replicas).toHaveLength(1);
    expect(isKubernetesRef(replicas![0].count)).toBe(true);
  });

  it('should support string patches with references', () => {
    const graph = toResourceGraph(
      {
        name: 'webapp-string-patch',
        apiVersion: 'example.com/v1alpha1',
        kind: 'WebAppStringPatch',
        spec: type({
          replicas: 'number',
          namespace: 'string',
        }),
        status: type({
          ready: 'boolean',
        }),
      },
      (schema) => ({
        source: gitRepository({
          id: 'webappSourceRepo2',
          name: 'webapp-source',
          url: 'https://github.com/example/webapp-manifests',
          ref: { branch: 'main' },
          interval: '5m',
        }),

        kustomize: kustomization({
          id: 'webappStringPatchKustomize',
          name: 'webapp-string-patch',
          source: {
            kind: 'GitRepository',
            name: 'webapp-source',
          },
          path: './base',
          patches: [
            {
              target: {
                kind: 'Deployment',
                name: 'webapp',
                namespace: schema.spec.namespace, // Reference in target selector
              },
              patch: '- op: replace\n  path: /spec/replicas\n  value: 3', // Static string patch
            },
          ],
        }),
      }),
      (_schema, _resources) => ({
        ready: true,
      })
    );

    const kustomizeResource = graph.resources.find((r) => r.kind === 'Kustomization');
    const patches = (kustomizeResource as any).spec?.patches;

    expect(patches).toBeDefined();
    expect(patches).toHaveLength(1);

    const patch = patches![0];

    // Verify reference in target selector
    expect(isKubernetesRef(patch.target?.namespace)).toBe(true);

    // String patches should be preserved as-is
    expect(typeof patch.patch).toBe('string');
    expect(patch.patch).toContain('value: 3');
  });

  it('should handle complex patch scenarios with nested references', () => {
    const graph = toResourceGraph(
      {
        name: 'complex-kustomize',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ComplexKustomize',
        spec: type({
          environment: 'string',
          replicas: 'number',
          resources: {
            cpu: 'string',
            memory: 'string',
          },
        }),
        status: type({
          ready: 'boolean',
        }),
      },
      (schema) => ({
        source: gitRepository({
          id: 'appSourceRepo',
          name: 'app-source',
          url: 'https://github.com/example/app',
          ref: { branch: 'main' },
          interval: '5m',
        }),

        kustomize: kustomization({
          id: 'complexAppKustomize',
          name: 'complex-app',
          source: {
            kind: 'GitRepository',
            name: 'app-source',
          },
          path: './overlays/production',
          patches: [
            {
              target: {
                kind: 'Deployment',
                name: 'webapp',
              },
              patch: {
                spec: {
                  replicas: schema.spec.replicas,
                  template: {
                    spec: {
                      containers: [
                        {
                          name: 'webapp',
                          resources: {
                            requests: {
                              cpu: schema.spec.resources.cpu,
                              memory: schema.spec.resources.memory,
                            },
                            limits: {
                              cpu: schema.spec.resources.cpu,
                              memory: schema.spec.resources.memory,
                            },
                          },
                          env: [
                            {
                              name: 'ENVIRONMENT',
                              value: schema.spec.environment,
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
        }),
      }),
      (_schema, _resources) => ({
        ready: true,
      })
    );

    const kustomizeResource = graph.resources.find((r) => r.kind === 'Kustomization');

    // Verify complex patch structure with nested references
    const patches = (kustomizeResource as any).spec?.patches;
    expect(patches).toBeDefined();
    expect(patches).toHaveLength(1);

    const patchContent = patches![0].patch as any;
    const container = patchContent.spec.template.spec.containers[0];

    // Check resource references
    expect(isKubernetesRef(container.resources.requests.cpu)).toBe(true);
    expect(isKubernetesRef(container.resources.requests.memory)).toBe(true);
    expect(isKubernetesRef(container.resources.limits.cpu)).toBe(true);
    expect(isKubernetesRef(container.resources.limits.memory)).toBe(true);

    // Check environment variable references
    expect(isKubernetesRef(container.env[0].value)).toBe(true); // schema.spec.environment
  });
});
