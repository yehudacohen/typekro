import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { KRO_INSTANCE_CONTROL_PLANE_NAMESPACE } from '../../src/core/config/defaults.js';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

// Built-ins that create and own their workload Namespace but were NEVER marked
// with the (now-removed) ownsInstanceNamespace flag — round-2 P2. Auto-detection
// must now handle them uniformly.
import { apisixBootstrap } from '../../src/factories/apisix/index.js';
import { caddyIngress } from '../../src/factories/caddy/index.js';
import { certManagerBootstrap } from '../../src/factories/cert-manager/index.js';
import { cnpgBootstrap } from '../../src/factories/cnpg/index.js';
import { externalDnsBootstrap } from '../../src/factories/external-dns/index.js';
import { inngestBootstrap } from '../../src/factories/inngest/index.js';
import { searxngBootstrap } from '../../src/factories/searxng/index.js';

const CP = KRO_INSTANCE_CONTROL_PLANE_NAMESPACE;

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

describe('lifecycle resolves the control-plane namespace WITHOUT a spec (P1 root cause)', () => {
  it('a self-owning factory resolves the instance namespace to the constant even spec-less', () => {
    const factory = ownsNsFactory('lifecycle-selfowns', { namespace: 'app' });
    const resolve = priv(factory, 'resolveInstanceNamespace');
    // Prime the composition-level self-ownership detection with a spec (as a
    // deploy/serialize would). The old per-<ns>-kro model derived a DIFFERENT
    // namespace here than a spec-less lifecycle call, orphaning instances.
    expect(resolve({ name: 'x', namespace: 'app' })).toBe(CP);
    // The fix: a spec-less lifecycle resolve (getInstances/deleteInstance) yields
    // the SAME stable control-plane namespace, not a stale `default-kro`.
    expect(resolve()).toBe(CP);
    expect(resolve()).not.toBe('default-kro');
  });
});

describe('getInstances discovers by RGD label cluster-wide (P1: no more empty result)', () => {
  it('finds the instance in the relocated control-plane namespace', async () => {
    const factory = ownsNsFactory('lifecycle-getinstances', { namespace: 'app' });
    const rec = factory as unknown as Rec;
    rec.discoveredPlural = 'ownsnslifecycles';
    let listedWith: Rec | undefined;
    rec.createCustomObjectsApi = async () => ({
      listClusterCustomObject: async (request: Rec) => {
        listedWith = request;
        return {
          items: [
            {
              // The CR lives in the control-plane namespace, NOT the workload one.
              spec: { name: 'demo', namespace: 'app' },
              metadata: { name: 'demo-instance', namespace: CP },
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
    // It listed cluster-wide, filtered by the RGD label.
    expect(listedWith?.labelSelector).toBe('typekro.io/rgd=lifecycle-getinstances');
  });
});

describe('deleteInstance discovers the CR namespace by label + rejects ambiguity (P1: no orphan)', () => {
  function withDiscovery(items: Array<{ metadata?: { name?: string; namespace?: string } }>) {
    const factory = ownsNsFactory('lifecycle-delete', { namespace: 'app' });
    const rec = factory as unknown as Rec;
    rec.discoveredPlural = 'ownsnslifecycles';
    rec.createCustomObjectsApi = async () => ({
      listClusterCustomObject: async () => ({ items }),
    });
    return factory;
  }

  it('targets the CR at its ACTUAL (relocated) namespace, not a derived one', async () => {
    const factory = withDiscovery([
      { metadata: { name: 'demo-instance', namespace: CP } },
      { metadata: { name: 'other', namespace: 'somewhere' } },
    ]);
    const discover = priv(factory, 'discoverInstanceNamespaceForDeletion');
    await expect(discover('demo-instance')).resolves.toBe(CP);
  });

  it('returns undefined when no instance with that name exists (404 = genuinely gone)', async () => {
    const factory = withDiscovery([{ metadata: { name: 'other', namespace: 'x' } }]);
    const discover = priv(factory, 'discoverInstanceNamespaceForDeletion');
    await expect(discover('demo-instance')).resolves.toBeUndefined();
  });

  it('THROWS on an ambiguous same-name match across namespaces (never guesses)', async () => {
    const factory = withDiscovery([
      { metadata: { name: 'demo-instance', namespace: 'ns-a' } },
      { metadata: { name: 'demo-instance', namespace: 'ns-b' } },
    ]);
    const discover = priv(factory, 'discoverInstanceNamespaceForDeletion');
    await expect(discover('demo-instance')).rejects.toThrow('Ambiguous delete');
  });
});

describe('newly-covered built-ins auto-relocate without the removed flag (round-2 P2)', () => {
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
    it(`${name}: serializes without throwing and relocates the CR to ${CP}`, () => {
      let yaml = '';
      expect(() => {
        yaml = factory().toYaml(spec as never);
      }).not.toThrow();
      expect(yaml).toContain(`namespace: ${CP}`);
      // Retention for BOTH GitOps reconcilers travels with the namespace.
      expect(yaml).toContain('kustomize.toolkit.fluxcd.io/prune: disabled');
      expect(yaml).toContain('argocd.argoproj.io/sync-options: Prune=false');
    });
  }
});
