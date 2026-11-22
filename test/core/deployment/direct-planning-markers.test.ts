import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { mergeValuesExpression } from '../../../src/core/aspects/values-merge.js';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { artifactOutput } from '../../../src/core/planning/values.js';
import { helmRelease } from '../../../src/factories/helm/helm-release.js';
import { Deployment } from '../../../src/factories/simple/workloads/deployment.js';

const plan = {
  strict: true,
  inputs: {
    issued: {
      kind: 'artifact' as const,
      requirement: {
        id: 'issued',
        kind: 'example',
        descriptor: { kind: 'literal' as const, value: 'example' },
        outputs: ['config'],
      },
    },
  },
};

describe('direct mode planning markers', () => {
  it('resolves a nested chart values reference inside an object with an unrelated symbol', async () => {
    const metadata = Symbol('settings metadata');
    const composition = kubernetesComposition(
      {
        name: 'symbol-values',
        apiVersion: 'example.dev/v1',
        kind: 'SymbolValues',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const deployment = Deployment({ id: 'app', name: spec.name, image: 'nginx:1.27' });
        helmRelease({
          id: 'release',
          name: 'example',
          namespace: 'example',
          chart: { repository: 'https://charts.example.test', name: 'example', version: '1.0.0' },
          values: {
            settings: {
              [metadata]: true,
              scaling: mergeValuesExpression(
                { source: deployment.status.readyReplicas },
                { enabled: true }
              ),
            },
          },
        });
        return { ready: true };
      }
    );
    const declarations = await composition
      .factory('direct', { namespace: 'example' })
      .toAlchemyResources({ name: 'example' });
    const source = declarations.find((declaration) => declaration.props.resourceId === 'app');
    const release = declarations.find((declaration) => declaration.props.resourceId === 'release');
    if (!source || !release) throw new Error('Expected the deployment and release declarations');
    expect(release.dependsOn).toEqual([source.id]);
    expect(release.props.resource.spec).toMatchObject({
      values: {
        settings: {
          scaling: { source: expect.stringContaining('status.readyReplicas'), enabled: true },
        },
      },
    });
  });

  it('keeps an artifact output in merged chart values a reference, not literal data', async () => {
    for (const merged of [false, true]) {
      const defaults = { configMap: { data: { 'app.conf': artifactOutput('issued', 'config') } } };
      const composition = kubernetesComposition(
        {
          name: 'marker-values',
          apiVersion: 'example.dev/v1',
          kind: 'MarkerValues',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        () => {
          helmRelease({
            id: 'release',
            name: 'example',
            namespace: 'example',
            chart: { repository: 'https://charts.example.test', name: 'example', version: '1.0.0' },
            values: (merged
              ? mergeValuesExpression(defaults, { replicas: 2 })
              : defaults) as Record<string, unknown>,
          });
          return { ready: true };
        }
      );
      const declarations = await composition
        .factory('direct', { namespace: 'example', plan })
        .toAlchemyResources({ name: 'example' });
      const record = String(
        declarations.find((declaration) => declaration.props.resourceId === 'release')?.props
          .artifactExecutionRecord
      );
      // The reference survives as a plan node; the marker's fields never become literal data.
      expect(record).toContain(
        '{"kind":"artifact-output","output":"config","requirementId":"issued"}'
      );
      expect(record).not.toContain('"value":"artifact-output"');
    }
  });
});
