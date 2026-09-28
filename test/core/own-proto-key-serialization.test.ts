/**
 * An OWN `__proto__` key in resource data survives every render path.
 *
 * Maps whose keys come from a caller (Helm values, ConfigMap data, setting
 * names) can legitimately contain `__proto__`. Assigning it with
 * `result[key] = value` on an ordinary object runs the inherited prototype
 * setter instead of creating a property, so a helper that rebuilds an object
 * key by key used to drop it without a trace. The helpers on the render paths
 * assign through `setOwnProperty` (src/shared/own-property.ts); these tests
 * pin that for a generic composition, in KRO mode (the RGD and the instance),
 * direct mode, and the Alchemy declarations of both.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { helmRelease } from '../../src/factories/helm/helm-release.js';
import { simple } from '../../src/factories/simple/index.js';
import { setOwnProperty } from '../../src/shared/own-property.js';

/** `{ "__proto__": … }` as an OWN property, the way JSON.parse builds it. */
const ownProto = <T>(value: T): Record<string, T> =>
  JSON.parse(
    JSON.stringify({ ['__proto__marker']: value }).replace('__proto__marker', '__proto__')
  );

const composition = () =>
  kubernetesComposition(
    {
      name: 'own-proto-key',
      apiVersion: 'example.com/v1',
      kind: 'OwnProtoKey',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      simple.ConfigMap({
        id: 'config',
        name: spec.name,
        data: { ...ownProto('config-proto-value'), other: 'kept' },
      });
      helmRelease({
        id: 'release',
        name: 'demo',
        chart: { repository: 'https://charts.example.com', name: 'demo', version: '1.0.0' },
        values: { nested: ownProto({ deep: 'helm-proto-value' }), plain: 1 },
      });
      return { ready: true };
    }
  );

describe('own __proto__ keys in resource data', () => {
  it('setOwnProperty defines an own __proto__ and leaves the prototype alone', () => {
    const target: Record<string, unknown> = {};
    setOwnProperty(target, '__proto__', 'x');
    setOwnProperty(target, 'other', 1);
    expect(Object.hasOwn(target, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(target))).toEqual(JSON.parse('{"__proto__":"x","other":1}'));
  });

  it('survives the KRO RGD render', () => {
    const yaml = composition().toYaml();
    expect(yaml).toContain('__proto__: config-proto-value');
    expect(yaml).toContain('helm-proto-value');
    expect(yaml).toContain('other: kept');
  });

  it('survives the direct render and both Alchemy declaration paths', async () => {
    const direct = await composition().factory('direct', { namespace: 'demo' });
    const yaml = direct.toYaml({ name: 'demo' });
    expect(yaml).toContain('__proto__: config-proto-value');
    expect(yaml).toContain('helm-proto-value');

    const directDecls = JSON.stringify(
      (await direct.toAlchemyResources({ name: 'demo' })).map((decl) => decl.props)
    );
    expect(directDecls).toContain('"__proto__":"config-proto-value"');
    expect(directDecls).toContain('helm-proto-value');

    const kro = await composition().factory('kro', { namespace: 'demo' });
    const kroDecls = JSON.stringify(
      (await kro.toAlchemyResources({ name: 'demo' })).map((decl) => decl.props)
    );
    expect(kroDecls).toContain('"__proto__":"config-proto-value"');
    expect(kroDecls).toContain('helm-proto-value');
  });
});
