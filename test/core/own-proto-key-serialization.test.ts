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
 * direct mode, and the Alchemy declarations of both, with aspects applied and
 * inside a forEach collection, and for the helpers that no end-to-end render
 * reaches without a cluster (the hoisted-namespace paths, canonicalDigest,
 * the reference resolvers).
 */

import { describe, expect, it } from 'bun:test';
import { KubeConfig } from '@kubernetes/client-node';
import { type } from 'arktype';
import { resolveAllReferences } from '../../src/alchemy/resolver.js';
import { aspect, merge, metadata, override } from '../../src/core/aspects/primitives.js';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { KroResourceFactoryImpl } from '../../src/core/deployment/kro-factory.js';
import { rewriteHoistedNamespaceRefsInValue } from '../../src/core/deployment/kro-instance-safety.js';
import { canonicalDigest } from '../../src/core/planning/canonical.js';
import { ReferenceResolver } from '../../src/core/references/resolver.js';
import { helmRelease } from '../../src/factories/helm/helm-release.js';
import { simple } from '../../src/factories/simple/index.js';
import { setOwnProperty } from '../../src/shared/own-property.js';
import { removeUndefinedValues } from '../../src/utils/helpers.js';

/** `{ "__proto__": … }` as an OWN property, the way JSON.parse builds it. */
const ownProto = <T>(value: T): Record<string, T> =>
  JSON.parse(`{"__proto__": ${JSON.stringify(value)}}`);

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

  it('survives aspects applied at render time, in KRO and direct mode', async () => {
    const aspects = [
      aspect.on(simple.ConfigMap, metadata({ labels: merge(ownProto('aspect-label-value')) })),
      aspect.on(
        simple.Deployment,
        override({
          spec: { template: { metadata: { labels: merge(ownProto('aspect-override-value')) } } },
        } as never)
      ),
    ];
    const withDeployment = kubernetesComposition(
      {
        name: 'own-proto-aspects',
        apiVersion: 'example.com/v1',
        kind: 'OwnProtoAspects',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        simple.ConfigMap({ id: 'config', name: spec.name, data: ownProto('config-proto-value') });
        simple.Deployment({ id: 'deployment', name: 'demo', image: 'nginx' });
        return { ready: true };
      }
    );
    const rgd = withDeployment.toYaml({ aspects } as never);
    for (const value of ['config-proto-value', 'aspect-label-value', 'aspect-override-value']) {
      expect(rgd).toContain(`__proto__: ${value}`);
    }
    const direct = await withDeployment.factory('direct', { namespace: 'demo', aspects } as never);
    const yaml = direct.toYaml({ name: 'demo' });
    expect(yaml).toContain('__proto__: aspect-label-value');
    expect(yaml).toContain('__proto__: aspect-override-value');
  });

  it('survives a forEach collection', async () => {
    const looped = kubernetesComposition(
      {
        name: 'own-proto-foreach',
        apiVersion: 'example.com/v1',
        kind: 'OwnProtoForEach',
        spec: type({ name: 'string', regions: 'string[]' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        for (const region of spec.regions) {
          simple.ConfigMap({
            id: 'regional',
            name: `cfg-${region}`,
            data: { ...ownProto('loop-proto-value'), region: `${region}` },
          });
        }
        return { ready: true };
      }
    );
    const rgd = looped.toYaml();
    expect(rgd).toContain('forEach');
    expect(rgd).toContain('__proto__: loop-proto-value');
    const direct = await looped.factory('direct', { namespace: 'demo' });
    const yaml = direct.toYaml({ name: 'demo', regions: ['east', 'west'] });
    expect(yaml.match(/__proto__: loop-proto-value/g)).toHaveLength(2);
  });

  it('survives the hoisted-namespace reference rewrite', () => {
    const value = {
      ...ownProto('rewrite-proto-value'),
      target: '${ownedNamespace.metadata.name}',
    };
    // The hoisted Namespace is literally named, so its references become that name.
    const rewritten = rewriteHoistedNamespaceRefsInValue(
      value,
      new Map<string, unknown>([['ownedNamespace', 'team-a']])
    ) as Record<string, unknown>;
    expect(rewritten).not.toBe(value);
    expect(Object.hasOwn(rewritten, '__proto__')).toBe(true);
    expect(rewritten.target).toBe('${"team-a"}');
    expect(rewritten.__proto__ as unknown).toBe('rewrite-proto-value');
  });

  it("survives the KRO factory's hoisted Namespace metadata", () => {
    const merged = (
      KroResourceFactoryImpl as unknown as {
        mergedHoistedNamespaceMetadata(
          namespace: string,
          original: unknown,
          spec: unknown
        ): { labels: Record<string, string>; annotations: Record<string, string> };
      }
    ).mergedHoistedNamespaceMetadata(
      'demo',
      { metadata: { labels: ownProto('ns-label'), annotations: ownProto('ns-annotation') } },
      {}
    );
    expect(Object.hasOwn(merged.labels, '__proto__')).toBe(true);
    expect(merged.labels.__proto__ as unknown).toBe('ns-label');
    expect(merged.annotations.__proto__ as unknown).toBe('ns-annotation');
  });

  it('counts toward canonicalDigest, removeUndefinedValues and alchemy reference resolution', async () => {
    expect(canonicalDigest(ownProto('a'))).not.toBe(canonicalDigest({}));
    expect(canonicalDigest(ownProto('a'))).toBe(canonicalDigest(ownProto('a')));
    expect(canonicalDigest(ownProto('a'))).not.toBe(canonicalDigest(ownProto('b')));

    const cleaned = removeUndefinedValues({ ...ownProto('kept'), gone: undefined });
    expect(Object.hasOwn(cleaned, '__proto__')).toBe(true);
    expect(Object.keys(cleaned)).toEqual(['__proto__']);

    const resolved = await resolveAllReferences({ nested: ownProto('resolved-value') }, {
      resourceMap: new Map(),
      resources: {},
    } as never);
    expect(Object.hasOwn(resolved.nested, '__proto__')).toBe(true);
  });

  it("survives the reference resolver's clone", () => {
    const resolver = new ReferenceResolver(new KubeConfig(), undefined, {} as never, {} as never);
    const cloned = (
      resolver as unknown as { selectiveClone(value: unknown): Record<string, unknown> }
    ).selectiveClone({ ...ownProto('clone-value'), other: 1 });
    expect(Object.hasOwn(cloned, '__proto__')).toBe(true);
    expect(cloned.__proto__ as unknown).toBe('clone-value');
  });
});
