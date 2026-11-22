import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { mergeValuesExpression } from '../../../src/core/aspects/values-merge.js';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { artifactOutput } from '../../../src/core/planning/values.js';
import { helmRelease } from '../../../src/factories/helm/helm-release.js';

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
