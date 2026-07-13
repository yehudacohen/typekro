import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

// Built-ins that create and own their workload Namespace but were NEVER marked
// with the (now-removed) ownsInstanceNamespace flag — round-2 P2. Auto-detection
// must now handle them uniformly (hoisting the owned namespace out of the graph).
import { apisixBootstrap } from '../../src/factories/apisix/index.js';
import { caddyIngress } from '../../src/factories/caddy/index.js';
import { certManagerBootstrap } from '../../src/factories/cert-manager/index.js';
import { cnpgBootstrap } from '../../src/factories/cnpg/index.js';
import { externalDnsBootstrap } from '../../src/factories/external-dns/index.js';
import { inngestBootstrap } from '../../src/factories/inngest/index.js';
import { searxngBootstrap } from '../../src/factories/searxng/index.js';

type Rec = Record<string, unknown>;

/** A self-owning composition (creates + owns a Namespace named after spec.namespace). */
function ownsNsFactory(factoryName: string, options: Rec = {}) {
  const composition = kubernetesComposition(
    {
      name: factoryName,
      kind: 'OwnsNsLifecycle',
      spec: type({ name: 'string', namespace: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
      return { ready: true };
    }
  );
  return composition.factory('kro', options);
}

function priv(factory: unknown, method: string): (...args: unknown[]) => unknown {
  const fn = (factory as Record<string, (...args: unknown[]) => unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`missing private method ${method}`);
  return fn.bind(factory);
}

describe('instance stays in its NATURAL namespace (no relocation)', () => {
  it('resolveInstanceNamespace returns the workload namespace, spec-ful and spec-less', () => {
    const factory = ownsNsFactory('lifecycle-selfowns', { namespace: 'app' });
    const resolve = priv(factory, 'resolveInstanceNamespace');
    // A per-call spec.namespace wins...
    expect(resolve({ name: 'x', namespace: 'dev' })).toBe('dev');
    // ...and a spec-less lifecycle resolve falls back to the factory namespace,
    // exactly as the pre-guard lifecycle did (never a control-plane constant).
    expect(resolve()).toBe('app');
    expect(resolve()).not.toBe('typekro-system');
  });

  it('an explicit instanceNamespace override wins', () => {
    const factory = ownsNsFactory('lifecycle-explicit', {
      namespace: 'app',
      instanceNamespace: 'ctrl',
    });
    const resolve = priv(factory, 'resolveInstanceNamespace');
    expect(resolve({ name: 'x', namespace: 'dev' })).toBe('ctrl');
    expect(resolve()).toBe('ctrl');
  });
});

describe('getInstances lists the factory namespace (restored pre-guard lookup)', () => {
  it('lists namespaced (not cluster-wide) — the instance is never relocated', async () => {
    const factory = ownsNsFactory('lifecycle-getinstances', { namespace: 'app' });
    const rec = factory as unknown as Rec;
    rec.discoveredPlural = 'ownsnslifecycles';
    let namespacedCall: Rec | undefined;
    rec.createCustomObjectsApi = async () => ({
      listNamespacedCustomObject: async (request: Rec) => {
        namespacedCall = request;
        return {
          items: [
            {
              spec: { name: 'demo', namespace: 'app' },
              metadata: { name: 'demo-instance', namespace: 'app' },
            },
          ],
        };
      },
    });
    rec.createEnhancedProxy = async (spec: unknown, instanceName: string) => ({
      metadata: { name: instanceName },
      spec,
      status: { ready: true },
    });

    const instances = await factory.getInstances();
    expect(instances).toHaveLength(1);
    // It listed the factory namespace, not cluster-wide.
    expect(namespacedCall?.namespace).toBe('app');
  });
});

describe('newly-covered built-ins hoist the owned namespace without the removed flag (round-2 P2)', () => {
  const cases: Array<{ name: string; factory: () => { toYaml: (spec: never) => string }; spec: Rec }> =
    [
      {
        name: 'certManagerBootstrap',
        factory: () => certManagerBootstrap.factory('kro', { namespace: 'cert-manager' }),
        spec: { name: 'cert-manager', namespace: 'cert-manager' },
      },
      {
        name: 'cnpgBootstrap',
        factory: () => cnpgBootstrap.factory('kro', { namespace: 'cnpg-system' }),
        spec: { name: 'cnpg', namespace: 'cnpg-system' },
      },
      {
        name: 'apisixBootstrap',
        factory: () => apisixBootstrap.factory('kro', { namespace: 'apisix' }),
        spec: { name: 'apisix', namespace: 'apisix' },
      },
      {
        name: 'externalDnsBootstrap',
        factory: () => externalDnsBootstrap.factory('kro', { namespace: 'external-dns' }),
        spec: { name: 'external-dns', namespace: 'external-dns', provider: 'aws' },
      },
      {
        name: 'inngestBootstrap',
        factory: () => inngestBootstrap.factory('kro', { namespace: 'inngest' }),
        spec: {
          name: 'inngest',
          namespace: 'inngest',
          inngest: { eventKey: 'deadbeef', signingKey: 'signkey000' },
        },
      },
      {
        name: 'searxngBootstrap',
        factory: () => searxngBootstrap.factory('kro', { namespace: 'searxng' }),
        spec: {
          name: 'searxng',
          namespace: 'searxng',
          secretKeyRef: { name: 'searxng-secret', key: 'secret_key' },
        },
      },
      {
        name: 'caddyIngress',
        factory: () => caddyIngress.factory('kro', { namespace: 'caddy' }),
        spec: { name: 'caddy', namespace: 'caddy', caddyfile: ':80 {\n  respond "ok"\n}\n' },
      },
    ];

  for (const { name, factory, spec } of cases) {
    it(`${name}: serializes without throwing; instance stays in ${spec.namespace as string}, ns hoisted+retained`, () => {
      let yaml = '';
      expect(() => {
        yaml = factory().toYaml(spec as never);
      }).not.toThrow();
      // Instance CR stays in its natural workload namespace — never relocated.
      expect(yaml).toMatch(new RegExp(`namespace: ${spec.namespace}$`, 'm'));
      expect(yaml).not.toContain('typekro-system');
      // The owned workload namespace is hoisted out of the graph and retained for
      // BOTH GitOps reconcilers (Argo option survives Application deletion).
      expect(yaml).toContain('typekro.io/kro-instance-namespace');
      expect(yaml).toContain('kustomize.toolkit.fluxcd.io/prune: disabled');
      expect(yaml).toContain('argocd.argoproj.io/sync-options: Prune=false,Delete=false');
    });
  }
});
