import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { simple } from '../../src/factories/simple/index.js';

describe('ArkType numeric constraints in KRO SimpleSchema', () => {
  it('preserves integer min/max admission markers', () => {
    const constrained = kubernetesComposition(
      {
        name: 'numeric-constraints',
        kind: 'NumericConstraints',
        spec: type({
          name: 'string',
          instances: 'number.integer >= 1',
          port: '1 <= number.integer <= 65535',
          values: 'Record<string, unknown>',
        }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        simple.ConfigMap({
          name: spec.name,
          data: { instances: `${spec.instances}`, port: `${spec.port}` },
          id: 'config',
        });
        return { ready: true };
      }
    );

    const yaml = constrained.toYaml();
    expect(yaml).toContain('instances: integer | min=1');
    expect(yaml).toContain('port: integer | min=1 max=65535');
    expect(yaml).toContain('values: object');
    expect(yaml).not.toContain('values: map[string]string');
  });
});
