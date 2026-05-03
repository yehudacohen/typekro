/**
 * Compile-time type tests for typed resource aspects.
 *
 * These tests intentionally exercise the public type contracts approved in the
 * INTERFACES phase. If an invalid case stops producing a type error, TypeScript
 * will report an unused @ts-expect-error directive.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import type {
  AspectOverridePatch,
  AspectSurfaceForTarget,
  CommonAspectSchemaForTargets,
  CommonAspectSurfaceForTargets,
  CompatibleAspectTargets,
  ResourceSpecOverrideSchema,
  ToYamlOptions,
  WorkloadAspectFactoryTarget,
} from '../../src/core/aspects/types.js';
import {
  allResources,
  append,
  aspect,
  kubernetesComposition,
  merge,
  metadata,
  override,
  replace,
  resources,
  simple,
  workloads,
} from '../../src/index.js';

function assertType<T>(_value: T): void {
  // Compile-time only.
}

const COMPILE_ONLY = false as boolean;

type DeploymentAspectSchema = ResourceSpecOverrideSchema<{
  replicas: number;
  template: {
    metadata: { labels: Record<string, string> };
    spec: {
      containers: readonly {
        name: string;
        image: string;
        command?: string[];
        workingDir?: string;
        env?: { name: string; value: string }[];
        volumeMounts?: { name: string; mountPath: string }[];
      }[];
      volumes: { name: string; emptyDir?: Record<string, never> }[];
    };
  };
}>;

describe('typed resource aspect contracts', () => {
  it('distinguishes allResources from workloads', () => {
    if (COMPILE_ONLY) {
      type AllResourcesSurface = AspectSurfaceForTarget<typeof allResources>;
      type WorkloadsSurface = AspectSurfaceForTarget<typeof workloads>;

      assertType<AllResourcesSurface>(metadata({ labels: merge({ team: 'platform' }) }));
      assertType<WorkloadsSurface>(
        override<ResourceSpecOverrideSchema<Record<string, unknown>>>({
          spec: { replicas: replace(2) },
        })
      );

      assertType<AllResourcesSurface>(
        // @ts-expect-error allResources is metadata-only.
        override<ResourceSpecOverrideSchema<Record<string, unknown>>>({
          spec: { replicas: replace(2) },
        })
      );

      // @ts-expect-error workloads is an override target group, not metadata.
      assertType<WorkloadsSurface>(metadata({ labels: merge({ team: 'platform' }) }));
    }

    expect(true).toBe(true);
  });

  it('requires aspects on render options to avoid spec/options ambiguity', () => {
    if (COMPILE_ONLY) {
      const valid: ToYamlOptions = { aspects: [] };
      assertType<ToYamlOptions>(valid);

      // @ts-expect-error render options require an own aspects array.
      const invalid: ToYamlOptions = {};
      void invalid;
    }

    expect(true).toBe(true);
  });

  it('exposes aspects through public composition render and factory options', () => {
    if (COMPILE_ONLY) {
      const graph = kubernetesComposition(
        {
          name: 'type-aspect-app',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TypeAspectApp',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const deployment = simple.Deployment({
            id: 'app',
            name: spec.name,
            image: spec.image,
          });

          return { ready: deployment.status.readyReplicas > 0 };
        }
      );

      const aspects = [aspect.on(allResources, metadata({ labels: merge({ team: 'platform' }) }))];

      assertType<string>(graph.toYaml({ aspects }));
      graph.factory('direct', { aspects });
      graph.factory('kro', { aspects });

      // @ts-expect-error render options must provide an aspects array.
      graph.toYaml({ aspects: undefined });
    }

    expect(true).toBe(true);
  });

  it('supports broad resource override targeting through advertised schemas', () => {
    if (COMPILE_ONLY) {
      type GenericServiceSchema = ResourceSpecOverrideSchema<{
        type: string;
        ports: readonly { port: number; targetPort?: number }[];
      }>;

      type ResourceSurface = AspectSurfaceForTarget<typeof resources>;
      assertType<ResourceSurface>(
        override<GenericServiceSchema>({
          spec: {
            type: replace('NodePort'),
            ports: append([{ port: 443, targetPort: 8443 }]),
          },
        })
      );

      aspect
        .on(
          resources,
          override<GenericServiceSchema>({
            spec: { type: replace('ClusterIP') },
          })
        )
        .where({ kind: 'Service' })
        .expectOne();

      // @ts-expect-error allResources remains metadata-only; use resources for overrides.
      aspect.on(
        allResources,
        override<GenericServiceSchema>({ spec: { type: replace('ClusterIP') } })
      );
    }

    expect(true).toBe(true);
  });

  it('types aspect.on, cardinality, and selectors from public helpers', () => {
    if (COMPILE_ONLY) {
      aspect.on(allResources, metadata({ labels: merge({ app: 'demo' }) }));
      aspect.on(
        workloads,
        override<ResourceSpecOverrideSchema<Record<string, unknown>>>({
          spec: { replicas: replace(2) },
        })
      );
      aspect
        .on(
          simple.Deployment,
          override<DeploymentAspectSchema>({
            spec: {
              replicas: replace(2),
              template: {
                spec: {
                  containers: append([
                    {
                      name: 'dev-tools',
                      image: 'busybox',
                      command: ['sh', '-c', 'sleep infinity'],
                      workingDir: '/workspace',
                      env: [{ name: 'LOG_LEVEL', value: 'debug' }],
                      volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
                    },
                  ]),
                  volumes: append([{ name: 'workspace', emptyDir: {} }]),
                },
              },
            },
          })
        )
        .where({
          slot: 'app',
          id: 'deployment',
          name: 'demo',
          namespace: 'default',
          kind: 'Deployment',
          labels: { app: 'demo' },
        })
        .expectOne();
      aspect.on(allResources, metadata({ annotations: replace({ owner: 'platform' }) })).optional();

      // @ts-expect-error allResources cannot receive override surfaces.
      aspect.on(
        allResources,
        override<ResourceSpecOverrideSchema<Record<string, unknown>>>({
          spec: { replicas: replace(2) },
        })
      );

      // @ts-expect-error workloads cannot receive metadata surfaces.
      aspect.on(workloads, metadata({ labels: merge({ app: 'demo' }) }));
    }

    expect(true).toBe(true);
  });

  it('allows replace and append for arrays but rejects merge', () => {
    if (COMPILE_ONLY) {
      type PodSpec = ResourceSpecOverrideSchema<{
        containers: readonly { name: string; image: string }[];
        labels: Record<string, string>;
        replicas: number;
      }>;

      assertType<AspectOverridePatch<PodSpec>>({
        spec: { containers: append([{ name: 'sidecar', image: 'busybox' }]) },
      });
      assertType<AspectOverridePatch<PodSpec>>({
        spec: { containers: replace([{ name: 'app', image: 'nginx' }]) },
      });
      assertType<AspectOverridePatch<PodSpec>>({ spec: { labels: merge({ app: 'demo' }) } });
      assertType<AspectOverridePatch<PodSpec>>({ spec: { replicas: replace(3) } });

      assertType<AspectOverridePatch<PodSpec>>({
        spec: {
          // @ts-expect-error arrays accept append/replace, not merge.
          containers: merge([{ name: 'sidecar', image: 'busybox' }]),
        },
      });

      // @ts-expect-error scalars accept replace only.
      assertType<AspectOverridePatch<PodSpec>>({ spec: { replicas: merge({}) } });

      // @ts-expect-error objects accept replace/merge, not append.
      assertType<AspectOverridePatch<PodSpec>>({ spec: { labels: append([]) } });
    }

    expect(true).toBe(true);
  });

  it('constrains multi-target override patches to recursively common spec fields', () => {
    if (COMPILE_ONLY) {
      type DeploymentSchema = ResourceSpecOverrideSchema<{
        replicas: number;
        strategy: { type: string };
        template: {
          spec: {
            containers: readonly { name: string; image: string }[];
            volumes: { name: string; emptyDir?: Record<string, never> }[];
          };
        };
      }>;
      type StatefulSetSchema = ResourceSpecOverrideSchema<{
        replicas: number;
        serviceName: string;
        template: {
          spec: {
            containers: readonly { name: string; image: string }[];
            volumes: { name: string; emptyDir?: Record<string, never> }[];
          };
        };
      }>;

      const deploy = undefined as unknown as WorkloadAspectFactoryTarget<DeploymentSchema>;
      const stateful = undefined as unknown as WorkloadAspectFactoryTarget<StatefulSetSchema>;
      type SharedSchema = CommonAspectSchemaForTargets<readonly [typeof deploy, typeof stateful]>;
      type SharedSurface = CommonAspectSurfaceForTargets<readonly [typeof deploy, typeof stateful]>;
      type SharedPatch = AspectOverridePatch<SharedSchema>;

      assertType<SharedPatch>({ spec: { replicas: replace(2) } });
      assertType<SharedPatch>({
        spec: {
          template: {
            spec: {
              containers: append([{ name: 'sidecar', image: 'busybox' }]),
              volumes: append([{ name: 'workspace', emptyDir: {} }]),
            },
          },
        },
      });
      assertType<SharedSurface>(override<SharedSchema>({ spec: { replicas: replace(2) } }));
      aspect.on([deploy, stateful], override<SharedSchema>({ spec: { replicas: replace(3) } }));

      // @ts-expect-error target arrays must share a compatible public surface.
      assertType<CompatibleAspectTargets<readonly [typeof allResources, typeof workloads]>>([
        allResources,
        workloads,
      ]);

      assertType<CommonAspectSurfaceForTargets<readonly [typeof allResources, typeof workloads]>>(
        // @ts-expect-error target arrays must share a compatible public surface.
        metadata({ labels: merge({ app: 'demo' }) })
      );

      // @ts-expect-error Deployment-only fields are not common to StatefulSet.
      assertType<SharedPatch>({ spec: { strategy: replace({ type: 'RollingUpdate' }) } });

      // @ts-expect-error StatefulSet-only fields are not common to Deployment.
      assertType<SharedPatch>({ spec: { serviceName: replace('headless') } });
    }

    expect(true).toBe(true);
  });
});
