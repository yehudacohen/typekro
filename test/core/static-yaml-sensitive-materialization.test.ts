import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { createResource, toResourceGraph } from '../../src/index.js';

function sensitiveComposition() {
  return toResourceGraph(
    {
      name: 'static-yaml-sensitive-materialization',
      apiVersion: 'testing.typekro.dev/v1alpha1',
      kind: 'StaticYamlSensitiveMaterialization',
      revision: '1',
      spec: type({ name: 'string', token: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (schema) => ({
      credentials: createResource(
        {
          id: 'credentials',
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: schema.spec.name },
          stringData: { token: schema.spec.token },
        },
        { factoryName: 'secret' }
      ),
    }),
    () => ({ ready: true })
  );
}

describe('static YAML sensitive materialization', () => {
  for (const mode of ['direct', 'kro'] as const) {
    it(`${mode} fails closed unless plaintext sensitive materialization is explicit`, async () => {
      const plaintext = `${mode}-static-plaintext`;
      const factory = await sensitiveComposition().factory(mode, { namespace: 'apps' });
      const spec = { name: 'credentials', token: plaintext };

      expect(() => factory.toYaml(spec)).toThrow('requires explicit plaintext materialization');

      const rendered = factory.toYaml(spec, { allowSensitiveMaterialization: true });
      expect(rendered).toContain(plaintext);
    });
  }
});
