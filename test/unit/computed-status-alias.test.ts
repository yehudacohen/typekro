import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { computed, kubernetesComposition, simple } from '../../src/index.js';

describe('computed status aliases', () => {
  it('serializes a computed alias returned from composition status', () => {
    const composition = kubernetesComposition(
      {
        name: 'computed-alias-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ComputedAliasApp',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const deployment = simple.Deployment({
          id: 'web',
          name: 'web',
          image: spec.image,
          replicas: 2,
        });
        const web = {
          ready: computed(
            { deployment },
            ({ deployment }) => deployment.status.availableReplicas >= deployment.spec.replicas
          ),
        };

        return { ready: web.ready };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.availableReplicas >= web.spec.replicas}');
  });

  it('supports a named resources parameter for computed expressions', () => {
    const composition = kubernetesComposition(
      {
        name: 'computed-resources-param-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ComputedResourcesParamApp',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const deployment = simple.Deployment({
          id: 'web',
          name: 'web',
          image: spec.image,
          replicas: 2,
        });
        const ready = computed(
          { deployment },
          (resources) =>
            resources.deployment.status.availableReplicas >= resources.deployment.spec.replicas
        );

        return { ready };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.availableReplicas >= web.spec.replicas}');
  });

  it('supports arbitrary named resource map parameters for computed expressions', () => {
    const composition = kubernetesComposition(
      {
        name: 'computed-param-alias-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ComputedParamAliasApp',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const deployment = simple.Deployment({
          id: 'web',
          name: 'web',
          image: spec.image,
          replicas: 2,
        });
        const ready = computed(
          { deployment },
          (refs) => refs.deployment.status.availableReplicas >= refs.deployment.spec.replicas
        );

        return { ready };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.availableReplicas >= web.spec.replicas}');
  });

  it('uses only the direct top-level return in block-body computed expressions', () => {
    const composition = kubernetesComposition(
      {
        name: 'computed-top-level-return-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ComputedTopLevelReturnApp',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const deployment = simple.Deployment({
          id: 'web',
          name: 'web',
          image: spec.image,
          replicas: 2,
        });
        const ready = computed({ deployment }, ({ deployment }) => {
          function helper() {
            return deployment.status.availableReplicas >= deployment.spec.replicas;
          }
          void helper;
          return deployment.status.readyReplicas > 0;
        });

        return { ready };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.readyReplicas > 0}');
    expect(yaml).not.toContain('ready: ${web.status.availableReplicas >= web.spec.replicas}');
  });

  it('rejects block-body computed expressions without a direct top-level return', () => {
    const deployment = simple.Deployment({
      id: 'web',
      name: 'web',
      image: 'nginx:latest',
      replicas: 2,
    });

    const branchOnlyReturn = new Function(
      'resources',
      'const { deployment } = resources; if (deployment.status.readyReplicas > 0) { return true; }'
    ) as (resources: { readonly deployment: typeof deployment }) => boolean;

    expect(() => computed({ deployment }, branchOnlyReturn)).toThrow(
      /direct top-level return expression/
    );
  });
});
