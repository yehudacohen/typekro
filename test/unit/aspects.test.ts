/**
 * Runtime behavior tests for typed resource aspects.
 *
 * These tests describe the implemented public behavior for aspect descriptors,
 * public exports, and factory/render wiring.
 *
 * Coverage deliberately exercises public seams instead of private adapter helpers:
 * helper constructors, `kubernetesComposition().toYaml({ aspects })`, direct/Kro
 * factory options, and generated resource graphs. That tradeoff keeps the suite
 * resilient to internal implementation choices while still catching broken public
 * exports, missing render wiring, unsafe Kro mutation, and diagnostic regressions.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import type {
  CommonAspectSchemaForTargets,
  ResourceSpecOverrideSchema,
} from '../../src/core/aspects/types.js';
import {
  allResources,
  append,
  aspect,
  Cel,
  hotReload,
  kubernetesComposition,
  merge,
  metadata,
  override,
  replace,
  resources,
  simple,
  slot,
  workloads,
} from '../../src/index.js';
import { deployment as kubernetesDeployment } from '../../src/factories/kubernetes/workloads/deployment.js';
import { isCelExpression } from '../../src/utils/type-guards.js';

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

type WorkloadReplicasSchema = ResourceSpecOverrideSchema<{ replicas: number }>;

type MultiWorkloadAspectSchema = CommonAspectSchemaForTargets<
  readonly [typeof simple.Deployment, typeof simple.StatefulSet]
>;

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

const app = kubernetesComposition(
  {
    name: 'aspect-test-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'AspectTestApp',
    spec: type({ name: 'string', image: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const deployment = slot(
      'app',
      simple.Deployment({
        id: 'appDeployment',
        name: spec.name,
        image: spec.image,
      })
    );

    simple.Service({
      id: 'appService',
      name: `${spec.name}-svc`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
    });

    return {
      ready: deployment.status.readyReplicas > 0,
    };
  }
);

const staticSelectorApp = kubernetesComposition(
  {
    name: 'aspect-static-selector-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'AspectStaticSelectorApp',
    spec: type({ image: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const deployment = slot(
      'static-app',
      simple.Deployment({
        id: 'staticDeployment',
        name: 'static-demo',
        namespace: 'test-ns',
        image: spec.image,
      })
    );

    return {
      ready: deployment.status.readyReplicas > 0,
    };
  }
);

const baseFactoryApp = kubernetesComposition(
  {
    name: 'aspect-base-factory-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'AspectBaseFactoryApp',
    spec: type({ name: 'string', image: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const deployment = slot(
      'base-app',
      kubernetesDeployment({
        id: 'baseDeployment',
        metadata: {
          name: spec.name,
          labels: { app: spec.name },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: spec.name } },
          template: {
            metadata: { labels: { app: spec.name } },
            spec: {
              containers: [{ name: spec.name, image: spec.image }],
              volumes: [{ name: 'production-config', emptyDir: {} }],
            },
          },
        },
      })
    );

    return {
      ready: deployment.status.readyReplicas > 0,
    };
  }
);

describe('typed resource aspects', () => {
  it('constructs immutable operation, surface, aspect, and slot descriptors', () => {
    const resource = { kind: 'Example' };

    expect(replace(1)).toEqual({ kind: 'replace', value: 1 });
    expect(merge({ app: 'demo' })).toEqual({ kind: 'merge', value: { app: 'demo' } });
    expect(append(['sidecar'])).toEqual({ kind: 'append', value: ['sidecar'] });
    expect(metadata({ labels: merge({ app: 'demo' }) })).toEqual({
      kind: 'metadata',
      labels: { kind: 'merge', value: { app: 'demo' } },
    });
    expect(override<DeploymentAspectSchema>({ spec: { replicas: replace(2) } })).toEqual({
      kind: 'override',
      patch: { spec: { replicas: { kind: 'replace', value: 2 } } },
    });
    expect(aspect.on(allResources, metadata({ labels: merge({ app: 'demo' }) }))).toMatchObject({
      kind: 'aspect',
      target: allResources,
      cardinality: 'one-or-more',
    });
    expect(slot('example', resource)).toBe(resource);
  });

  it('rejects invalid helper and surface payloads before resource mutation', () => {
    expect(() => merge(null as unknown as Record<string, string>)).toThrow(
      /AspectDefinitionError|merge|object/i
    );
    expect(() => append(undefined as unknown as string[])).toThrow(
      /AspectDefinitionError|append|array/i
    );
    expect(() => metadata({ labels: append(['not-a-metadata-operation']) as never })).toThrow(
      /AspectDefinitionError|metadata|labels/i
    );
    expect(() =>
      override<WorkloadReplicasSchema>({
        spec: { replicas: merge(null as unknown as object) as never },
      })
    ).toThrow(/AspectDefinitionError|override|replicas|merge/i);
    expect(() => slot('', { kind: 'Example' })).toThrow(/AspectDefinitionError|slot|empty/i);
    const slottedResource = slot('first', { kind: 'Example' });
    expect(slot('first', slottedResource)).toBe(slottedResource);
    expect(() => slot('second', slottedResource)).toThrow(/AspectDefinitionError|slot|different/i);
    expect(() => aspect.on(simple.Deployment, metadata({ labels: merge({ app: 'demo' }) }))).not.toThrow();
    expect(() =>
      aspect.on(
        (() => ({ kind: 'Deployment' })) as unknown as typeof simple.Deployment,
        metadata({ labels: merge({ app: 'demo' }) })
      )
    ).toThrow(/AspectDefinitionError|registered TypeKro factory|aspect metadata/i);
  });

  it('rejects conflicting selector and cardinality builder calls', () => {
    expect(() =>
      aspect
        .on(allResources, metadata({ labels: merge({ app: 'demo' }) }))
        .where({ slot: 'first' })
        .where({ slot: 'second' })
    ).toThrow(/AspectDefinitionError|where|selector/i);
    expect(() =>
      aspect
        .on(allResources, metadata({ labels: merge({ app: 'demo' }) }))
        .expectOne()
        .optional()
    ).toThrow(/AspectDefinitionError|optional|expectOne/i);
    expect(() =>
      aspect
        .on(allResources, metadata({ labels: merge({ app: 'demo' }) }))
        .optional()
        .expectOne()
    ).toThrow(/AspectDefinitionError|expectOne|optional/i);
  });

  it('rejects selector typos and invalid selector value shapes at runtime', () => {
    expect(() =>
      aspect
        .on(allResources, metadata({ labels: merge({ app: 'demo' }) }))
        .where({ lables: { app: 'demo' } } as never)
    ).toThrow(/AspectDefinitionError|selector field lables|not supported/i);
    expect(() =>
      aspect
        .on(allResources, metadata({ labels: merge({ app: 'demo' }) }))
        .where({ labels: { app: 1 } } as never)
    ).toThrow(/AspectDefinitionError|selector label app|string/i);
    expect(() =>
      aspect
        .on(allResources, metadata({ labels: merge({ app: 'demo' }) }))
        .where({ name: 1 } as never)
    ).toThrow(/AspectDefinitionError|selector name|string/i);
  });

  it('keeps aspect builder refinements immutable', () => {
    const base = aspect.on(allResources, metadata({ labels: merge({ app: 'demo' }) }));
    const selector = { slot: 'app', labels: { app: 'demo' } };
    const selected = base.where(selector);
    const exact = selected.expectOne();
    selector.slot = 'mutated';
    selector.labels.app = 'mutated';

    expect(base).toMatchObject({ cardinality: 'one-or-more' });
    expect(base.selector).toBeUndefined();
    expect(selected).toMatchObject({
      selector: { slot: 'app', labels: { app: 'demo' } },
      cardinality: 'one-or-more',
    });
    expect(exact).toMatchObject({
      selector: { slot: 'app', labels: { app: 'demo' } },
      cardinality: 'exactly-one',
    });
  });

  it('keeps operation and surface descriptors deeply immutable from caller mutation', () => {
    const labelPatch = { app: 'demo' };
    const labelOperation = merge(labelPatch);
    labelPatch.app = 'mutated';

    expect(labelOperation.value).toEqual({ app: 'demo' });
    expect(Object.isFrozen(labelOperation.value)).toBe(true);

    const metadataInput = { labels: { kind: 'merge' as const, value: { team: 'platform' } } };
    const surface = metadata(metadataInput);
    metadataInput.labels.value.team = 'mutated';

    expect(surface.labels?.value).toEqual({ team: 'platform' });
    expect(Object.isFrozen(surface.labels?.value)).toBe(true);

    const overridePatch = { spec: { replicas: { kind: 'replace' as const, value: 2 } } };
    const overrideSurface = override<DeploymentAspectSchema>(overridePatch);
    overridePatch.spec.replicas.value = 5;

    expect(overrideSurface).toMatchObject({
      patch: { spec: { replicas: { kind: 'replace', value: 2 } } },
    });
  });

  it('leaves YAML unchanged when no aspects are provided', () => {
    expect(app.toYaml({ aspects: [] })).toEqual(app.toYaml());
  });

  it('applies stack-wide metadata aspects during YAML rendering', () => {
    const yaml = app.toYaml({
      aspects: [
        aspect.on(
          allResources,
          metadata({
            labels: merge({ environment: 'test' }),
            annotations: merge({ 'typekro.io/aspect-test': 'true' }),
          })
        ),
      ],
    });

    expect(countOccurrences(yaml, 'environment: test')).toBeGreaterThanOrEqual(2);
    expect(countOccurrences(yaml, 'typekro.io/aspect-test: "true"')).toBeGreaterThanOrEqual(2);
  });

  it('replaces metadata maps without preserving prior labels', () => {
    const yaml = staticSelectorApp.toYaml({
      aspects: [aspect.on(allResources, metadata({ labels: replace({ only: 'replacement' }) }))],
    });

    expect(yaml).toContain('only: replacement');
    expect(yaml).not.toContain(
      'metadata:\n          name: static-demo\n          namespace: test-ns\n          labels:\n            app: static-demo'
    );
  });

  it('applies spec-derived overrides to a selected workload slot', () => {
    const yaml = app.toYaml({
      aspects: [
        aspect
          .on(
            simple.Deployment,
            override<DeploymentAspectSchema>({
              spec: {
                replicas: replace(3),
              },
            })
          )
          .where({ slot: 'app' })
          .expectOne(),
      ],
    });

    expect(yaml).toContain('replicas: 3');
  });

  it('preserves CelExpression identity when replace overrides clone values', () => {
    const replicas = Cel.expr<number>('2');
    const factory = app.factory('direct', {
      aspects: [
        aspect
          .on(
            simple.Deployment,
            override<DeploymentAspectSchema>({
              spec: { replicas: replace(replicas as never) },
            })
          )
          .where({ slot: 'app' })
          .expectOne(),
      ],
    });

    const graph = factory.createResourceGraphForInstance({ name: 'demo', image: 'nginx' });
    const deployment = Object.values(graph.resources).find(
      (resource) => (resource as { manifest?: { kind?: string } }).manifest?.kind === 'Deployment'
    ) as { manifest: { spec: { replicas: unknown } } } | undefined;

    expect(isCelExpression(deployment?.manifest.spec.replicas)).toBe(true);
  });

  it('applies hot-reload container and volume overrides to array fields', () => {
    const yaml = app
      .factory('direct', {
        aspects: [
          aspect
            .on(
              simple.Deployment,
              override<DeploymentAspectSchema>({
                spec: {
                  template: {
                    spec: {
                      containers: append([
                        {
                          name: 'sidecar',
                          image: 'busybox:latest',
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
            .where({ slot: 'app' })
            .expectOne(),
        ],
      })
      .toYaml({ name: 'demo', image: 'nginx' });

    expect(yaml).toContain('name: sidecar');
    expect(yaml).toContain('image: busybox:latest');
    expect(yaml).toContain('workingDir: /workspace');
    expect(yaml).toContain('name: LOG_LEVEL');
    expect(yaml).toContain('mountPath: /workspace');
    expect(yaml).toContain('emptyDir: {}');
  });

  it('builds dev-mode hot reload overrides for targeted workloads', () => {
    const yaml = app
      .factory('direct', {
        aspects: [
          aspect
            .on(
              simple.Deployment,
              hotReload({
                replicas: 1,
                labels: { 'typekro.dev/hot-reload': 'true' },
                containers: [
                  {
                    name: 'demo',
                    image: 'oven/bun:1.3.13',
                    command: ['bun', 'run', 'dev'],
                    workingDir: '/workspace',
                    env: [{ name: 'NODE_ENV', value: 'development' }],
                    volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
                  },
                ],
                volumes: [{ name: 'workspace', hostPath: { path: '/workspace', type: 'Directory' } }],
              })
            )
            .where({ slot: 'app' })
            .expectOne(),
        ],
      })
      .toYaml({ name: 'demo', image: 'nginx' });

    expect(yaml).toContain('typekro.dev/hot-reload: \'true\'');
    expect(yaml).toContain('replicas: 1');
    expect(yaml).toContain('image: oven/bun:1.3.13');
    expect(yaml).toContain('workingDir: /workspace');
    expect(yaml).toContain('name: NODE_ENV');
    expect(yaml).toContain('mountPath: /workspace');
    expect(yaml).toContain('path: /workspace');
  });

  it('applies hot reload labels to reference-backed Kro workload labels', () => {
    const yaml = app.toYaml({
      aspects: [
        aspect
          .on(
            simple.Deployment,
            hotReload({
              labels: { 'typekro.dev/hot-reload': 'true' },
              containers: [{ name: 'demo', image: 'oven/bun:1.3.13' }],
            })
          )
          .where({ slot: 'app' })
          .expectOne(),
      ],
    });

    expect(yaml).toContain('typekro.dev/hot-reload: "true"');
    expect(yaml).toContain('image: oven/bun:1.3.13');
  });

  it('applies kind-level factory targets to base Kubernetes factories through createResource metadata', () => {
    const yaml = baseFactoryApp
      .factory('direct', {
        aspects: [
          aspect
            .on(
              kubernetesDeployment,
              hotReload({
                replicas: 1,
                labels: { 'typekro.dev/hot-reload': 'true' },
                containers: [
                  {
                    name: 'demo',
                    image: 'oven/bun:1.3.13',
                    command: ['bun', 'run', 'dev'],
                    workingDir: '/workspace',
                    volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
                  },
                ],
                volumes: [{ name: 'workspace', emptyDir: {} }],
              })
            )
            .where({ slot: 'base-app' })
            .expectOne(),
        ],
      })
      .toYaml({ name: 'demo', image: 'nginx' });

    expect(yaml).toContain('typekro.dev/hot-reload: \'true\'');
    expect(yaml).toContain('image: oven/bun:1.3.13');
    expect(yaml).toContain('mountPath: /workspace');
    expect(yaml).toContain('emptyDir: {}');
    expect(yaml).not.toContain('production-config');
  });

  it('applies kind-level factory-target metadata aspects without manual factory schemas', () => {
    const yaml = baseFactoryApp
      .factory('direct', {
        aspects: [
          aspect
            .on(
              kubernetesDeployment,
              metadata({ labels: merge({ 'aspect.target': 'base-factory' }) })
            )
            .where({ slot: 'base-app' })
            .expectOne(),
        ],
      })
      .toYaml({ name: 'demo', image: 'nginx' });

    expect(yaml).toContain('aspect.target: base-factory');
  });

  it('applies workload group aspects to all matching workload resources', () => {
    const yaml = app.toYaml({
      aspects: [
        aspect.on(
          workloads,
          override<WorkloadReplicasSchema>({
            spec: {
              replicas: replace(2),
            },
          })
        ),
      ],
    });

    expect(yaml).toContain('replicas: 2');
  });

  it('applies resource group overrides to fields present on structured spec resources', () => {
    const yaml = app
      .factory('direct', {
        aspects: [
          aspect
            .on(
              resources,
              override<
                ResourceSpecOverrideSchema<{ ports: { port: number; targetPort: number }[] }>
              >({
                spec: { ports: append([{ port: 443, targetPort: 8443 }]) },
              })
            )
            .where({ kind: 'Service' })
            .expectOne(),
        ],
      })
      .toYaml({ name: 'demo', image: 'nginx' });

    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('port: 443');
    expect(yaml).toContain('targetPort: 8443');
  });

  it('allows typed optional resource overrides even when the field is absent initially', () => {
    const yaml = app
      .factory('direct', {
        aspects: [
          aspect
            .on(
              resources,
              override<ResourceSpecOverrideSchema<{ externalName: string }>>({
                spec: { externalName: replace('example.com') },
              })
            )
            .where({ kind: 'Service' })
            .expectOne(),
        ],
      })
      .toYaml({ name: 'demo', image: 'nginx' });

    expect(yaml).toContain('externalName: example.com');
  });

  it('does not let resource group overrides mutate resources without structured specs', () => {
    const configOnly = kubernetesComposition(
      {
        name: 'aspect-config-only',
        apiVersion: 'example.com/v1alpha1',
        kind: 'AspectConfigOnly',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        simple.ConfigMap({ id: 'config', name: spec.name, data: { key: 'value' } });
        return { ready: true };
      }
    );

    expect(() =>
      configOnly.toYaml({
        aspects: [
          aspect
            .on(
              resources,
              override<ResourceSpecOverrideSchema<{ replicas: number }>>({
                spec: { replicas: replace(2) },
              })
            )
            .where({ kind: 'ConfigMap' })
            .expectOne(),
        ],
      })
    ).toThrow(/expected one resources match but found 0|selector|match/i);
  });

  it('allows typed optional workload overrides without manual deep schemas', () => {
    const yaml = app.toYaml({
      aspects: [
        aspect.on(
          simple.Deployment,
          override<ResourceSpecOverrideSchema<{ strategy: { type: string } }>>({
            spec: {
              strategy: replace({ type: 'Recreate' }),
            },
          })
        ),
      ],
    });

    expect(yaml).toContain('type: Recreate');
  });

  it('rejects operations placed on incompatible advertised field types', () => {
    expect(() =>
      app.toYaml({
        aspects: [
          aspect.on(
            simple.Deployment,
            override<DeploymentAspectSchema>({
              spec: {
                replicas: append([2]),
              } as never,
            })
          ),
        ],
      })
    ).toThrow(/AspectApplicationError|append|array|spec\.replicas/i);
  });

  it('applies one aspect across all matching Deployment and StatefulSet targets', () => {
    const multi = kubernetesComposition(
      {
        name: 'aspect-multi-workload',
        apiVersion: 'example.com/v1alpha1',
        kind: 'AspectMultiWorkload',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const web = slot('web', simple.Deployment({ id: 'web', name: 'web', image: spec.image }));
        const db = slot(
          'db',
          simple.StatefulSet({
            id: 'db',
            name: 'db',
            image: spec.image,
            serviceName: 'db-headless',
          })
        );

        return {
          ready: web.status.readyReplicas > 0 && db.status.readyReplicas > 0,
        };
      }
    );

    const multiTargetAspect = aspect.on(
      [simple.Deployment, simple.StatefulSet],
      override<MultiWorkloadAspectSchema>({
        spec: {
          replicas: replace(2),
        },
      })
    );

    const yaml = multi
      .factory('direct', { aspects: [multiTargetAspect] })
      .toYaml({ image: 'nginx' });

    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: StatefulSet');
    expect(countOccurrences(yaml, 'replicas: 2')).toBe(2);
  });

  it('preserves slot metadata after nested composition flattening', () => {
    const child = kubernetesComposition(
      {
        name: 'aspect-nested-child',
        apiVersion: 'example.com/v1alpha1',
        kind: 'AspectNestedChild',
        spec: type({ name: 'string', image: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const deployment = slot(
          'nested-app',
          simple.Deployment({ id: 'nestedDeployment', name: spec.name, image: spec.image })
        );
        return { ready: deployment.status.readyReplicas > 0 };
      }
    );

    const parent = kubernetesComposition(
      {
        name: 'aspect-nested-parent',
        apiVersion: 'example.com/v1alpha1',
        kind: 'AspectNestedParent',
        spec: type({ name: 'string', image: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const nested = child({ name: `${spec.name}-child`, image: spec.image });
        return { ready: nested.status.ready };
      }
    );

    const yaml = parent.toYaml({
      aspects: [
        aspect
          .on(
            simple.Deployment,
            override<DeploymentAspectSchema>({ spec: { replicas: replace(7) } })
          )
          .where({ slot: 'nested-app' })
          .expectOne(),
      ],
    });

    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('replicas: 7');
  });

  it('supports selector fields for id, name, namespace, kind, and labels', () => {
    const yaml = staticSelectorApp.toYaml({
      aspects: [
        aspect
          .on(
            simple.Deployment,
            override<DeploymentAspectSchema>({
              spec: { replicas: replace(4) },
            })
          )
          .where({
            id: 'staticDeployment',
            name: 'static-demo',
            namespace: 'test-ns',
            kind: 'Deployment',
            labels: { app: 'static-demo' },
          })
          .expectOne(),
      ],
    });

    expect(yaml).toContain('replicas: 4');
  });

  it('treats an empty selector as matching the selected target set', () => {
    const yaml = app.toYaml({
      aspects: [
        aspect
          .on(
            simple.Deployment,
            override<DeploymentAspectSchema>({ spec: { replicas: replace(6) } })
          )
          .where({})
          .expectOne(),
      ],
    });

    expect(yaml).toContain('replicas: 6');
  });

  it('fails by default when a selector matches no resources', () => {
    const aspects = [
      aspect
        .on(allResources, metadata({ labels: merge({ missing: 'true' }) }))
        .where({ slot: 'missing' }),
    ];

    expect(() => app.toYaml({ aspects })).toThrow(/no resources|no match|selector/i);
  });

  it('allows no resources when optional is used', () => {
    const aspects = [
      aspect
        .on(allResources, metadata({ labels: merge({ optional: 'true' }) }))
        .where({ slot: 'missing' })
        .optional(),
    ];

    expect(() => app.toYaml({ aspects })).not.toThrow();
  });

  it('fails expectOne when multiple resources match', () => {
    const aspects = [
      aspect.on(allResources, metadata({ labels: merge({ one: 'true' }) })).expectOne(),
    ];

    expect(() => app.toYaml({ aspects })).toThrow(/multiple|expected one|expectOne/i);
  });

  it('applies aspects in order so later selectors observe earlier mutations', () => {
    const yaml = app.toYaml({
      aspects: [
        aspect.on(allResources, metadata({ labels: merge({ tier: 'app' }) })),
        aspect
          .on(
            simple.Deployment,
            override<DeploymentAspectSchema>({ spec: { replicas: replace(5) } })
          )
          .where({ labels: { tier: 'app' } })
          .expectOne(),
      ],
    });

    expect(yaml).toContain('tier: app');
    expect(yaml).toContain('replicas: 5');
  });

  it('is idempotent when rendering repeatedly with append aspects', () => {
    const aspects = [
      aspect.on(
        simple.Deployment,
        override<DeploymentAspectSchema>({
          spec: {
            template: {
              spec: {
                containers: append([{ name: 'logger', image: 'busybox:latest' }]),
              },
            },
          },
        })
      ),
    ];

    const factory = app.factory('direct', { aspects });
    expect(factory.toYaml({ name: 'demo', image: 'nginx' })).toEqual(
      factory.toYaml({ name: 'demo', image: 'nginx' })
    );
  });

  it('accepts empty merge and append operations as no-op mutations', () => {
    const yaml = app.toYaml({
      aspects: [
        aspect.on(allResources, metadata({ labels: merge({}) })),
        aspect.on(
          simple.Deployment,
          override<DeploymentAspectSchema>({
            spec: { template: { spec: { containers: append([]) } } },
          })
        ),
      ],
    });

    expect(yaml).toContain('kind: Deployment');
  });

  it('accepts factory-time aspects for direct and Kro factories', () => {
    const aspects = [
      aspect.on(
        allResources,
        metadata({
          labels: merge({ managedBy: 'typekro-aspects' }),
        })
      ),
    ];

    expect(() => app.factory('direct', { aspects })).not.toThrow();
    expect(() => app.factory('kro', { aspects })).not.toThrow();
  });

  it('applies aspects to direct factory resource graphs', () => {
    const factory = app.factory('direct', {
      aspects: [
        aspect.on(
          allResources,
          metadata({
            labels: merge({ direct: 'true' }),
            annotations: merge({ 'typekro.io/direct': 'true' }),
          })
        ),
      ],
    });

    const graph = factory.createResourceGraphForInstance({ name: 'demo', image: 'nginx' });
    expect(JSON.stringify(graph.resources)).toContain('direct');
    expect(JSON.stringify(graph.resources)).toContain('typekro.io/direct');

    const yaml = factory.toYaml({ name: 'demo', image: 'nginx' });
    expect(yaml).toContain('direct:');
    expect(yaml).toContain('typekro.io/direct:');
  });

  it('applies equivalent legal mutations in direct and Kro YAML paths', () => {
    const aspects = [aspect.on(allResources, metadata({ labels: merge({ parity: 'true' }) }))];
    const directYaml = app.factory('direct', { aspects }).toYaml({ name: 'demo', image: 'nginx' });
    const kroYaml = app.toYaml({ aspects });

    expect(directYaml).toMatch(/parity: ["']?true["']?/);
    expect(kroYaml).toMatch(/parity: ["']?true["']?/);
  });

  it('applies Kro ternary post-processing on repeated aspect renders', () => {
    const ternaryApp = kubernetesComposition(
      {
        name: 'aspect-ternary-repeat',
        apiVersion: 'example.com/v1alpha1',
        kind: 'AspectTernaryRepeat',
        spec: type({ name: 'string', 'annotation?': 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const optionalSection = spec.annotation ? `\nextra: ${spec.annotation}` : '';
        simple.ConfigMap({
          id: 'config',
          name: spec.name,
          data: { 'settings.yml': `base: true${optionalSection}` },
        });
        return { ready: true };
      }
    );
    const aspects = [aspect.on(allResources, metadata({ labels: merge({ repeated: 'true' }) }))];

    const firstYaml = ternaryApp.toYaml({ aspects });
    const secondYaml = ternaryApp.toYaml({ aspects });

    expect(firstYaml).toContain('has(schema.spec.annotation)');
    expect(secondYaml).toContain('has(schema.spec.annotation)');
    expect(secondYaml).toContain('repeated:');
  });

  it('rejects unsafe merge operations against reference-backed composites in Kro mode', () => {
    const aspects = [
      aspect.on(
        simple.Deployment,
        override<DeploymentAspectSchema>({
          spec: {
            template: {
              metadata: {
                labels: merge({ injected: 'true' }),
              },
            },
          },
        })
      ),
    ];

    expect(() => app.toYaml({ aspects })).toThrow(/reference-backed|Kro|merge/i);
  });

  it('rejects unsafe merge or append payloads that introduce references in Kro mode', () => {
    const dynamicImage = Cel.expr<string>('schema.spec.image');
    const appendAspects = [
      aspect.on(
        simple.Deployment,
        override<DeploymentAspectSchema>({
          spec: {
            template: {
              spec: {
                containers: append([
                  { name: 'dynamic-extra', image: dynamicImage as unknown as string },
                ]),
              },
            },
          },
        })
      ),
    ];
    const mergeAspects = [
      aspect.on(
        simple.Deployment,
        override<DeploymentAspectSchema>({
          spec: {
            template: {
              metadata: {
                labels: merge({ dynamic: dynamicImage as unknown as string }),
              },
            },
          },
        })
      ),
    ];
    const concrete = kubernetesComposition(
      {
        name: 'aspect-kro-payload-safety',
        apiVersion: 'example.com/v1alpha1',
        kind: 'AspectKroPayloadSafety',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (_spec) => {
        simple.Deployment({ id: 'concrete', name: 'concrete', image: 'nginx' });
        return { ready: true };
      }
    );

    expect(() => concrete.toYaml({ aspects: appendAspects })).toThrow(
      /reference-backed|payload|Kro|append/i
    );
    expect(() => concrete.toYaml({ aspects: mergeAspects })).toThrow(
      /reference-backed|payload|Kro|merge/i
    );
  });

  it('allows append operations when the current Kro array is concrete', () => {
    const aspects = [
      aspect.on(
        simple.Deployment,
        override<DeploymentAspectSchema>({
          spec: {
            template: {
              spec: {
                containers: append([{ name: 'safe-extra', image: 'busybox:latest' }]),
              },
            },
          },
        })
      ),
    ];

    const concrete = kubernetesComposition(
      {
        name: 'aspect-concrete-append',
        apiVersion: 'example.com/v1alpha1',
        kind: 'AspectConcreteAppend',
        spec: type({}),
        status: type({ ready: 'boolean' }),
      },
      () => {
        simple.Deployment({ id: 'concrete', name: 'concrete', image: 'nginx' });
        return { ready: true };
      }
    );

    expect(concrete.toYaml({ aspects })).toContain('name: safe-extra');
  });

  it('reports structured diagnostics for aspect application failures', () => {
    const aspects = [
      aspect
        .on(simple.Deployment, override<DeploymentAspectSchema>({ spec: { replicas: replace(2) } }))
        .where({ slot: 'missing' })
        .expectOne(),
    ];

    try {
      app.toYaml({ aspects });
      throw new Error('Expected aspect application to fail');
    } catch (error) {
      expect(String(error)).toMatch(/aspect|selector|match|Deployment|direct|kro|reason/i);
      expect(error).toMatchObject({
        code: 'ASPECT_APPLICATION_ERROR',
        aspectIndex: 0,
        target: expect.stringMatching(/Deployment/i),
        matchCount: 0,
        mode: expect.stringMatching(/direct|kro/i),
        reason: expect.any(String),
        context: {
          aspectIndex: 0,
          matchCount: 0,
          reason: expect.any(String),
        },
      });
      expect(JSON.stringify(error)).not.toMatch(/secretData|envValue|serializedAspectPayload/i);
    }
  });
});
