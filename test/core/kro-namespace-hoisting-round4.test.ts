import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { configMap } from '../../src/factories/kubernetes/config/index.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

/**
 * Round-4 rework coverage for PR #113: the ownership-transfer migration design.
 * These are the OFFLINE proofs for findings #2, #3, #4, #5, #7 (the live upgrade
 * test for finding #1 lives under test/integration and is gated on a cluster).
 */

type Rec = Record<string, unknown>;

const schema = {
  name: 'round4',
  kind: 'Round4',
  spec: type({ name: 'string', namespace: 'string', 'create?': 'boolean' }),
  status: type({ ready: 'boolean' }),
};

function priv(target: unknown, method: string): (...args: unknown[]) => unknown {
  const fn = (target as Record<string, (...args: unknown[]) => unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`missing private method ${method}`);
  return fn.bind(target);
}

function splitDocs(yaml: string): string[] {
  return yaml
    .split(/^---$/m)
    .map((doc) => doc.trim())
    .filter(Boolean);
}

// A composition that owns its instance Namespace (named after spec.namespace).
const ownsNs = () =>
  kubernetesComposition(schema, (spec) => {
    namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
    return { ready: true };
  });

describe('finding #2: create / getInstances / deleteInstance resolve ONE namespace', () => {
  it('the shared resolver returns the SAME namespace with and without a spec', () => {
    const factory = ownsNs().factory('kro', { namespace: 'factory-ns' });
    const resolve = priv(factory, 'resolveInstanceNamespace');
    // No explicit override: the default is the factory namespace, spec-ful or not.
    expect(resolve()).toBe('factory-ns');
    expect(resolve({ name: 'x', namespace: 'factory-ns' })).toBe('factory-ns');
  });

  it('an explicit instanceNamespace flows identically through all three paths', async () => {
    // Reproduces the OLD mismatch: create used `spec.namespace ?? factory.namespace`
    // while getInstances/deleteInstance used only `factory.namespace`. With a single
    // resolver, an explicit `instanceNamespace` override is honored everywhere.
    const factory = ownsNs().factory('kro', {
      namespace: 'factory-ns',
      instanceNamespace: 'cr-ns',
    });
    const resolve = priv(factory, 'resolveInstanceNamespace');
    expect(resolve()).toBe('cr-ns');
    expect(resolve({ name: 'x', namespace: 'factory-ns' })).toBe('cr-ns');

    // getInstances lists the RESOLVED namespace (cr-ns), not the factory namespace.
    const rec = factory as unknown as Rec;
    rec.discoveredPlural = 'round4s';
    let listedNamespace: string | undefined;
    rec.createCustomObjectsApi = async () => ({
      listNamespacedCustomObject: async (request: Rec) => {
        listedNamespace = request.namespace as string;
        return { items: [] };
      },
    });
    await factory.getInstances();
    expect(listedNamespace).toBe('cr-ns');

    // deleteInstance deletes the CR in the RESOLVED namespace (cr-ns).
    let deletedNamespace: string | undefined;
    rec.createKubernetesObjectApi = () => ({
      delete: async (obj: { kind?: string; metadata?: { namespace?: string } }) => {
        if (obj.kind === 'Round4') deletedNamespace = obj.metadata?.namespace;
        return {};
      },
      read: async () => {
        const err = new Error('not found') as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      },
    });
    rec.listInstancesForCleanup = async () => [];
    rec.requireCRDPluralForCleanup = async () => 'round4s';
    await factory.deleteInstance('demo');
    expect(deletedNamespace).toBe('cr-ns');
  });
});

describe('finding #3: references to a hoisted Namespace are rewritten (no dangling ref)', () => {
  it('a ConfigMap using ${ownedNamespace.metadata.name} is rewritten to the schema namespace', () => {
    const composition = kubernetesComposition(schema, (spec) => {
      const ns = namespace({
        id: 'ownedNamespace',
        metadata: { name: Cel.expr(spec.namespace) as string },
      });
      configMap({
        id: 'cfg',
        metadata: { name: 'cfg', namespace: 'kube-system' },
        data: { targetNamespace: ns.metadata?.name as unknown as string },
      });
      return { ready: true };
    });

    const rgd = composition.factory('kro', { namespace: 'app' }).toYaml();
    // The owned Namespace is hoisted out of the graph...
    expect(rgd).not.toContain('kind: Namespace');
    // ...and the ConfigMap's reference no longer dangles at the removed resource;
    // it points at the schema namespace instead.
    expect(rgd).not.toContain('ownedNamespace.metadata.name');
    expect(rgd).toContain('kind: ConfigMap');
    expect(rgd).toContain('schema.spec.namespace');
  });
});

describe('finding #4: the shared RGD shape is spec-INDEPENDENT', () => {
  it('buildRgdYaml is identical across specs and hoists only the spec.namespace-named Namespace', () => {
    // Owns TWO namespaces: one named after spec.namespace (hoistable), one a literal
    // (never provably the instance namespace → stays a graph child for EVERY spec).
    const composition = () =>
      kubernetesComposition(schema, (spec) => {
        namespace({
          id: 'ownedInstanceNs',
          metadata: { name: Cel.expr(spec.namespace) as string },
        });
        namespace({ id: 'sharedLiteralNs', metadata: { name: 'shared-literal-ns' } });
        return { ready: true };
      });

    const build = (spec?: Rec) =>
      priv(composition().factory('kro', { namespace: 'cp' }), 'buildRgdYaml')(spec) as string;

    const rgdA = build({ name: 'x', namespace: 'alpha' });
    const rgdB = build({ name: 'x', namespace: 'beta' });
    const rgdNoSpec = build();

    // Deploying a different instance never mutates the shared RGD's shape.
    expect(rgdA).toBe(rgdB);
    expect(rgdA).toBe(rgdNoSpec);
    // The literal namespace stays a graph child; the spec.namespace one is hoisted.
    expect(rgdA).toContain('shared-literal-ns');
    expect(rgdA).toContain('kind: Namespace');
    // Only ONE Namespace remains (the literal), not the hoisted instance namespace.
    expect(rgdA.match(/kind: Namespace/g)?.length).toBe(1);
  });
});

describe('finding #5: the hoisted Namespace PRESERVES its original configuration', () => {
  const preservedComposition = () =>
    kubernetesComposition(schema, (spec) => {
      namespace({
        id: 'ownedNamespace',
        metadata: {
          name: Cel.expr(spec.namespace) as string,
          labels: {
            'pod-security.kubernetes.io/enforce': 'restricted',
            'team': 'data-platform',
          },
          annotations: { 'owner': 'platform-team' },
        },
      });
      return { ready: true };
    });

  it('toYaml preserves Pod Security labels + user annotations and adds retention', () => {
    const yaml = preservedComposition()
      .factory('kro', { namespace: 'app' })
      .toYaml({ name: 'x', namespace: 'app' });
    const nsDoc = splitDocs(yaml).find((doc) => /^kind: Namespace$/m.test(doc)) ?? '';
    // Preserved original configuration.
    expect(nsDoc).toContain('pod-security.kubernetes.io/enforce: restricted');
    expect(nsDoc).toContain('team: data-platform');
    expect(nsDoc).toContain('owner: platform-team');
    // Merged retention markers.
    expect(nsDoc).toContain("typekro.io/kro-instance-namespace: 'true'");
    expect(nsDoc).toContain('kustomize.toolkit.fluxcd.io/prune: disabled');
  });

  it('toAlchemyResources preserves the original configuration on the retained Namespace', async () => {
    const decls = await preservedComposition()
      .factory('kro', { namespace: 'app' })
      .toAlchemyResources({ name: 'x', namespace: 'app' });
    const nsLabels = decls[0]?.props.resource.metadata?.labels as Record<string, string>;
    expect(nsLabels['pod-security.kubernetes.io/enforce']).toBe('restricted');
    expect(nsLabels.team).toBe('data-platform');
    expect(nsLabels['typekro.io/kro-instance-namespace']).toBe('true');
    const nsAnnotations = decls[0]?.props.resource.metadata?.annotations as Record<string, string>;
    expect(nsAnnotations.owner).toBe('platform-team');
    expect(nsAnnotations['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
  });
});

describe('finding #1 (round-6): the instance alchemy id is the legacy namespace-agnostic kind+name', () => {
  it('two genuinely-distinct instances (different names) get distinct ids', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'apps' });
    const a = await factory.toAlchemyResources({ name: 'alpha', namespace: 'apps' });
    const b = await factory.toAlchemyResources({ name: 'beta', namespace: 'apps' });
    // Distinct by NAME within one factory (one alchemy scope).
    expect(a.at(-1)?.id).not.toBe(b.at(-1)?.id as string);
  });

  it('the id carries NO namespace hash suffix (reverted to legacy) so existing alchemy state is stable', async () => {
    const decls = await ownsNs()
      .factory('kro', { namespace: 'apps' })
      .toAlchemyResources({ name: 'inst', namespace: 'apps' });
    const instanceId = decls.at(-1)?.id as string;
    // Legacy form: kind+name only. The removed hash suffix looked like `...Ns<hash>`.
    expect(instanceId).not.toMatch(/Ns[0-9a-z]+$/);
    // A dev-vs-prod factory in a DIFFERENT namespace yields the SAME namespace-agnostic
    // id for the same instance name — distinctness comes from the alchemy scope/stack,
    // not from a per-CR namespace segment.
    const prod = await ownsNs()
      .factory('kro', { namespace: 'prod' })
      .toAlchemyResources({ name: 'inst', namespace: 'prod' });
    expect(prod.at(-1)?.id).toBe(instanceId);
  });
});
