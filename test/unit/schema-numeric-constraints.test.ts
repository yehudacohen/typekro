import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { simple } from '../../src/factories/simple/index.js';

describe('ArkType numeric constraints in KRO SimpleSchema', () => {
  it('emits KRO integer/float types and minimum/maximum admission markers', () => {
    const constrained = kubernetesComposition(
      {
        name: 'numeric-constraints',
        kind: 'NumericConstraints',
        spec: type({
          name: 'string',
          instances: 'number.integer >= 1',
          port: '1 <= number.integer <= 65535',
          ratio: '0 <= number <= 1',
          decimalRatio: '0.1 <= number <= 1.5',
          values: 'Record<string, unknown>',
        }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        simple.ConfigMap({
          name: spec.name,
          data: {
            instances: `${spec.instances}`,
            port: `${spec.port}`,
            ratio: `${spec.ratio}`,
          },
          id: 'config',
        });
        return { ready: true };
      }
    );

    const yaml = constrained.toYaml();
    expect(yaml).toContain('instances: integer | minimum=1');
    expect(yaml).toContain('port: integer | minimum=1 maximum=65535');
    expect(yaml).toContain('ratio: float | minimum=0 maximum=1');
    expect(yaml).toContain('decimalRatio: float | minimum=0.1 maximum=1.5');
    expect(yaml).not.toContain('number |');
    expect(yaml).toContain('values: object');
    expect(yaml).not.toContain('values: map[string]string');
  });
});
