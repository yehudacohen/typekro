import { describe, expect, it } from 'bun:test';
import { Parser } from 'acorn';
import { type } from 'arktype';
import {
  buildLexicalAliasScope,
  inlineLexicalAliases,
} from '../../src/core/expressions/analysis/alias-inliner.js';
import { alias, aliases, computed, kubernetesComposition, simple } from '../../src/index.js';

describe('computed status aliases', () => {
  it('inlines const identifier aliases returned from composition status', () => {
    const composition = kubernetesComposition(
      {
        name: 'const-identifier-alias-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ConstIdentifierAliasApp',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean', available: 'number' }),
      },
      (spec) => {
        const deployment = simple.Deployment({
          id: 'web',
          name: 'web',
          image: spec.image,
          replicas: 2,
        });
        const ready = deployment.status.readyReplicas >= deployment.spec.replicas;
        const available = deployment.status.availableReplicas;

        return { ready, available };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.readyReplicas >= web.spec.replicas}');
    expect(yaml).toContain('available: ${web.status.availableReplicas}');
  });

  it('inlines object property aliases returned from composition status', () => {
    const composition = kubernetesComposition(
      {
        name: 'object-property-alias-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ObjectPropertyAliasApp',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean', available: 'number' }),
      },
      (spec) => {
        const deployment = simple.Deployment({
          id: 'web',
          name: 'web',
          image: spec.image,
          replicas: 2,
        });
        const web = {
          ready: deployment.status.readyReplicas >= deployment.spec.replicas,
          stats: {
            available: deployment.status.availableReplicas,
          },
        };

        return { ready: web.ready, available: web.stats.available };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.readyReplicas >= web.spec.replicas}');
    expect(yaml).toContain('available: ${web.status.availableReplicas}');
  });

  it('inlines aliases that reference earlier aliases', () => {
    const composition = kubernetesComposition(
      {
        name: 'chained-alias-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ChainedAliasApp',
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
        const available = deployment.status.availableReplicas;
        const desired = deployment.spec.replicas;
        const ready = available >= desired;

        return { ready };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.availableReplicas >= web.spec.replicas}');
  });

  it('inlines aliases inside returned expressions', () => {
    const composition = kubernetesComposition(
      {
        name: 'nested-return-alias-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'NestedReturnAliasApp',
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
        const available = deployment.status.availableReplicas;

        return { ready: available >= deployment.spec.replicas };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.availableReplicas >= web.spec.replicas}');
  });

  it('inlines explicit alias objects through the same status path', () => {
    const composition = kubernetesComposition(
      {
        name: 'explicit-alias-inline-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ExplicitAliasInlineApp',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean', available: 'number' }),
      },
      (spec) => {
        const deployment = simple.Deployment({
          id: 'web',
          name: 'web',
          image: spec.image,
          replicas: 2,
        });
        const web = alias(deployment, {
          ready: (d) => d.status.readyReplicas >= d.spec.replicas,
          available: (d) => d.status.availableReplicas,
        });

        return { ready: web.ready, available: web.available };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.readyReplicas >= web.spec.replicas}');
    expect(yaml).toContain('available: ${web.status.availableReplicas}');
  });

  it('inlines explicit multi-resource aliases through the same status path', () => {
    const composition = kubernetesComposition(
      {
        name: 'explicit-multi-alias-inline-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ExplicitMultiAliasInlineApp',
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
        const service = simple.Service({
          id: 'webService',
          name: 'web',
          selector: { app: 'web' },
          ports: [{ port: 80 }],
        });
        const app = aliases(
          { deployment, service },
          {
            ready: ({ deployment, service }) =>
              deployment.status.readyReplicas >= deployment.spec.replicas &&
              service.status.loadBalancer.ingress!.length > 0,
          }
        );

        return { ready: app.ready };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain(
      'ready: ${web.status.readyReplicas >= web.spec.replicas && webService.status.loadBalancer.ingress.length > 0}'
    );
  });

  it('does not inline aliases from nested function scopes', () => {
    const composition = kubernetesComposition(
      {
        name: 'nested-scope-alias-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'NestedScopeAliasApp',
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
        const ready = false;
        function nested() {
          const ready = deployment.status.readyReplicas >= deployment.spec.replicas;
          return ready;
        }
        void nested;

        return { ready };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).not.toContain('ready: ${web.status.readyReplicas >= web.spec.replicas}');
  });

  it('fails closed for cyclic lexical aliases', () => {
    const source = `() => {
      const ready = available;
      const available = ready;
      return { ready };
    }`;
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    const aliases = buildLexicalAliasScope(ast, source);

    expect(() => inlineLexicalAliases('ready', aliases)).toThrow(/Could not fully inline/);
  });

  it('serializes single-resource aliases returned from composition status', () => {
    const composition = kubernetesComposition(
      {
        name: 'single-resource-alias-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'SingleResourceAliasApp',
        spec: type({ image: 'string' }),
        status: type({ ready: 'boolean', available: 'number' }),
      },
      (spec) => {
        const deployment = simple.Deployment({
          id: 'web',
          name: 'web',
          image: spec.image,
          replicas: 2,
        });
        const web = alias(deployment, {
          ready: (d) => d.status.readyReplicas >= d.spec.replicas,
          available: (d) => d.status.availableReplicas,
        });

        return { ready: web.ready, available: web.available };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain('ready: ${web.status.readyReplicas >= web.spec.replicas}');
    expect(yaml).toContain('available: ${web.status.availableReplicas}');
  });

  it('serializes multi-resource aliases returned from composition status', () => {
    const composition = kubernetesComposition(
      {
        name: 'multi-resource-alias-app',
        apiVersion: 'example.com/v1alpha1',
        kind: 'MultiResourceAliasApp',
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
        const service = simple.Service({
          id: 'webService',
          name: 'web',
          selector: { app: 'web' },
          ports: [{ port: 80 }],
        });
        const app = aliases(
          { deployment, service },
          {
            ready: ({ deployment, service }) =>
              deployment.status.readyReplicas >= deployment.spec.replicas &&
              service.status.loadBalancer.ingress!.length > 0,
          }
        );

        return { ready: app.ready };
      }
    );

    const yaml = composition.toYaml();
    expect(yaml).toContain(
      'ready: ${web.status.readyReplicas >= web.spec.replicas && webService.status.loadBalancer.ingress.length > 0}'
    );
  });

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
