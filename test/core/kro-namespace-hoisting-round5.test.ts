import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import {
  rewriteHoistedNamespaceReferences,
  rewriteHoistedNamespaceRefsInValue,
} from '../../src/core/deployment/kro-instance-safety.js';
import {
  getIncludeWhen,
  getResourceId,
  setIncludeWhen,
  setResourceId,
} from '../../src/core/metadata/index.js';
import { Cel } from '../../src/core/references/cel.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

/**
 * Round-5 rework coverage for PR #113 (v2: namespaces NEVER in the RGD). OFFLINE
 * proofs for the namespace-placement resolver, the generalized reference rewriting,
 * the #6 hoist-weakened status REJECT, and the complete config preservation of the
 * hoisted (sibling) namespace. The create/delete ORDER proof lives under
 * test/integration and is gated on a cluster (WRITTEN but NOT executed here).
 */

type Rec = Record<string, unknown>;

const schema = {
  name: 'round5',
  kind: 'Round5',
  spec: type({ name: 'string', namespace: 'string', 'team?': 'string' }),
  status: type({ ready: 'boolean', 'namespaceName?': 'string' }),
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

const ownsNs = () =>
  kubernetesComposition(schema, (spec) => {
    namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
    return { ready: true };
  });

const cel = (expression: string) =>
  ({ [CEL_EXPRESSION_BRAND]: true, expression }) as unknown as { expression: string };

const kref = (resourceId: string, fieldPath: string) =>
  ({ [KUBERNETES_REF_BRAND]: true, resourceId, fieldPath }) as unknown;

/**
 * The hoisted-namespace map the rewriters consume: resource id → the Namespace's
 * raw `metadata.name` VALUE. Here the namespace is named after `spec.namespace`
 * (the dominant case), so a reference to it rewrites to `schema.spec.namespace`.
 */
const specNamedNs = (id = 'ownedNamespace') =>
  new Map<string, unknown>([[id, kref('__schema__', 'spec.namespace')]]);

describe('finding #2: CR placement defaults to the FACTORY namespace (v0.26.0), not spec.namespace', () => {
  it('resolveInstanceNamespace returns the factory namespace regardless of spec', () => {
    const factory = ownsNs().factory('kro', { namespace: 'factory-ns' });
    const resolve = priv(factory, 'resolveInstanceNamespace');
    // The KEY regression this fixes: a spec whose namespace DIFFERS from the factory
    // namespace must NOT move the CR. Default placement is ALWAYS the factory ns.
    expect(resolve()).toBe('factory-ns');
    expect(resolve({ name: 'x', namespace: 'a-totally-different-ns' })).toBe('factory-ns');
  });

  it('an explicit instanceNamespace override still wins and is spec-independent', () => {
    const factory = ownsNs().factory('kro', { namespace: 'factory-ns', instanceNamespace: 'cr-ns' });
    const resolve = priv(factory, 'resolveInstanceNamespace');
    expect(resolve()).toBe('cr-ns');
    expect(resolve({ name: 'x', namespace: 'whatever' })).toBe('cr-ns');
  });
});

describe('finding #3: create / getInstances / deleteInstance provably target the SAME namespace', () => {
  it('deploy, getInstances, and deleteInstance all resolve the factory namespace (even with a differing spec)', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'factory-ns' });
    const rec = factory as unknown as Rec;

    // deploy() would resolve with the spec — prove it still yields the factory ns.
    const resolve = priv(factory, 'resolveInstanceNamespace');
    expect(resolve({ name: 'demo', namespace: 'spec-ns' })).toBe('factory-ns');

    // getInstances lists the factory namespace (never spec-ns, never cluster-wide).
    rec.discoveredPlural = 'round5s';
    let listedNamespace: string | undefined;
    rec.createCustomObjectsApi = async () => ({
      listNamespacedCustomObject: async (request: Rec) => {
        listedNamespace = request.namespace as string;
        return { items: [] };
      },
    });
    await factory.getInstances();
    expect(listedNamespace).toBe('factory-ns');

    // deleteInstance deletes the CR in the factory namespace — the same one deploy
    // would have created it in — so a wrong-namespace 404 can never orphan the CR.
    let deletedNamespace: string | undefined;
    rec.createKubernetesObjectApi = () => ({
      delete: async (obj: { kind?: string; metadata?: { namespace?: string } }) => {
        if (obj.kind === 'Round5') deletedNamespace = obj.metadata?.namespace;
        return {};
      },
      read: async () => {
        const err = new Error('not found') as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      },
    });
    rec.listInstancesForCleanup = async () => [];
    rec.requireCRDPluralForCleanup = async () => 'round5s';
    await factory.deleteInstance('demo');
    expect(deletedNamespace).toBe('factory-ns');
  });
});

describe('finding #6: references to a hoisted Namespace are rewritten STRUCTURALLY, incl. status', () => {
  it('rewrites string()-wrapped, concatenated, ternary, and marker reference forms', () => {
    const ids = specNamedNs();

    // string()-wrapped inside a CEL interpolation.
    expect(
      (
        rewriteHoistedNamespaceRefsInValue(
          cel('${string(ownedNamespace.metadata.name)}'),
          ids
        ) as { expression: string }
      ).expression
    ).toBe('${string(schema.spec.namespace)}');

    // Concatenated / embedded in a plain string.
    expect(
      rewriteHoistedNamespaceRefsInValue('ns-${string(ownedNamespace.metadata.name)}', ids)
    ).toBe('ns-${string(schema.spec.namespace)}');

    // Ternary branch.
    expect(
      (
        rewriteHoistedNamespaceRefsInValue(
          cel('has(schema.spec.namespace) ? ownedNamespace.metadata.name : "workload-default"'),
          ids
        ) as { expression: string }
      ).expression
    ).toBe('has(schema.spec.namespace) ? schema.spec.namespace : "workload-default"');

    // Raw KubernetesRef marker.
    expect(
      rewriteHoistedNamespaceRefsInValue('__KUBERNETES_REF_ownedNamespace_metadata.name__', ids)
    ).toBe('__KUBERNETES_REF___schema___spec.namespace__');

    // An id that is only a SUFFIX of a longer identifier is NOT matched.
    expect(rewriteHoistedNamespaceRefsInValue('${myOwnedNamespace.metadata.name}', ids)).toBe(
      '${myOwnedNamespace.metadata.name}'
    );
  });

  it('a LITERALLY-named hoisted Namespace rewrites references to the constant name', () => {
    // Generalization beyond spec.namespace: a Namespace named by a plain string
    // literal rewrites a reference to that constant (not to a schema expression).
    const ids = new Map<string, unknown>([['monitoringNs', 'monitoring']]);
    expect(rewriteHoistedNamespaceRefsInValue('${monitoringNs.metadata.name}', ids)).toBe(
      '${"monitoring"}'
    );
    // A raw marker rewrites to the literal text.
    expect(
      rewriteHoistedNamespaceRefsInValue('ns-__KUBERNETES_REF_monitoringNs_metadata.name__', ids)
    ).toBe('ns-monitoring');
    // An exact KubernetesRef rewrites to the constant string.
    expect(rewriteHoistedNamespaceRefsInValue(kref('monitoringNs', 'metadata.name'), ids)).toBe(
      'monitoring'
    );
  });

  it('#6: a status mapping resolving only to the hoisted Namespace is REJECTED (named), not silently dropped', () => {
    const composition = kubernetesComposition(schema, (spec) => {
      const ns = namespace({
        id: 'ownedNamespace',
        metadata: { name: Cel.expr(spec.namespace) as string },
      });
      return {
        ready: true,
        // Status references ONLY the owned Namespace (embedded in a template). After
        // hoisting it becomes `schema.spec.namespace`, which KRO status CEL cannot
        // evaluate — so the composition is rejected for KRO serialization, naming the field.
        namespaceName: Cel.template('ns-%s', ns.metadata.name) as unknown as string,
      };
    });

    expect(() => composition.factory('kro', { namespace: 'app' }).toYaml()).toThrow(
      /status field\(s\) \[namespaceName\]/
    );
  });
});

describe('finding #7: reference rewriting requires EXACT metadata.name (no over-match)', () => {
  const ids = specNamedNs();

  it('rewrites an EXACT metadata.name KubernetesRef to the hoisted Namespace', () => {
    const out = rewriteHoistedNamespaceRefsInValue(kref('ownedNamespace', 'metadata.name'), ids) as {
      expression?: string;
    };
    // Rewritten to a CEL expression referencing schema.spec.namespace.
    expect(out.expression).toBe('schema.spec.namespace');
  });

  it('does NOT rewrite a metadata.namespace KubernetesRef (falls through unchanged)', () => {
    const ref = kref('ownedNamespace', 'metadata.namespace');
    // startsWith('metadata.name') used to (wrongly) match this and silently rewrite
    // it; exact equality lets it fall through unchanged to dangling-ref validation.
    expect(rewriteHoistedNamespaceRefsInValue(ref, ids)).toBe(ref);
  });

  it('does NOT rewrite an arbitrary metadata.name* KubernetesRef (e.g. metadata.nameservers)', () => {
    const ref = kref('ownedNamespace', 'metadata.nameservers');
    expect(rewriteHoistedNamespaceRefsInValue(ref, ids)).toBe(ref);
  });
});

describe('finding #7: rewriting a resource preserves its TypeKro metadata', () => {
  it('non-enumerable includeWhen + __resourceId survive a reference rewrite', () => {
    const cfg = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'cfg', namespace: 'kube-system' },
      data: { targetNamespace: '${ownedNamespace.metadata.name}' },
    } as Rec;
    setIncludeWhen(cfg, [cel('${schema.spec.enabled}')]);
    setResourceId(cfg, 'cfg');

    const out = rewriteHoistedNamespaceReferences({ cfg: cfg as never }, specNamedNs());
    // The resource WAS reconstructed (its reference changed)...
    expect(out.cfg).not.toBe(cfg as never);
    expect((out.cfg as Rec).data).toEqual({ targetNamespace: '${schema.spec.namespace}' });
    // ...and its non-enumerable metadata came across to the new object.
    expect(getIncludeWhen(out.cfg as object)).toHaveLength(1);
    expect(getResourceId(out.cfg as object)).toBe('cfg');
  });

  it('a resource WITHOUT a hoisted reference is passed through by identity', () => {
    const cfg = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'cfg' },
      data: { unrelated: 'value' },
    } as Rec;
    const out = rewriteHoistedNamespaceReferences({ cfg: cfg as never }, specNamedNs());
    expect(out.cfg).toBe(cfg as never);
  });
});

describe('finding #8: the hoisted (sibling) Namespace preserves the COMPLETE declared config', () => {
  const richComposition = () =>
    kubernetesComposition(schema, (spec) => {
      namespace({
        id: 'ownedNamespace',
        metadata: {
          name: Cel.expr(spec.namespace) as string,
          labels: {
            'pod-security.kubernetes.io/enforce': 'restricted',
            team: Cel.expr(spec.team) as string, // schema-derived (non-literal) label
            replicas: 3 as unknown as string, // non-string label value
          },
          annotations: { owner: Cel.expr(spec.team) as string },
        },
        // Namespace spec must survive (e.g. finalizers).
        spec: { finalizers: ['kubernetes'] } as never,
      });
      return { ready: true };
    });

  it('toYaml retains schema-derived + non-string labels AND the Namespace spec', () => {
    const yaml = richComposition()
      .factory('kro', { namespace: 'app' })
      .toYaml({ name: 'x', namespace: 'app', team: 'data-platform' });
    const nsDoc = splitDocs(yaml).find((doc) => /^kind: Namespace$/m.test(doc)) ?? '';
    // Literal label preserved.
    expect(nsDoc).toContain('pod-security.kubernetes.io/enforce: restricted');
    // Schema-derived label resolved to its concrete value.
    expect(nsDoc).toContain('team: data-platform');
    // Non-string label stringified (not dropped).
    expect(nsDoc).toContain("replicas: '3'");
    // Schema-derived annotation resolved.
    expect(nsDoc).toContain('owner: data-platform');
    // Namespace spec survived.
    expect(nsDoc).toContain('finalizers:');
    expect(nsDoc).toContain('kubernetes');
    // Retention markers merged on top.
    expect(nsDoc).toContain("typekro.io/kro-instance-namespace: 'true'");
  });

  it('toAlchemyResources retains schema-derived + non-string labels AND the spec', async () => {
    const decls = await richComposition()
      .factory('kro', { namespace: 'app' })
      .toAlchemyResources({ name: 'x', namespace: 'app', team: 'data-platform' });
    const ns = decls[0]?.props.resource;
    const labels = ns?.metadata?.labels as Record<string, string>;
    expect(labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
    expect(labels.team).toBe('data-platform');
    expect(labels.replicas).toBe('3');
    expect((ns as { spec?: { finalizers?: string[] } })?.spec?.finalizers).toEqual(['kubernetes']);
  });
});

describe('finding #6 (round-6): the hoisted Namespace preserves metadata.finalizers + ownerReferences', () => {
  const ownerRef = {
    apiVersion: 'example.com/v1',
    kind: 'Owner',
    name: 'parent',
    uid: 'parent-uid-123',
  };
  const richComposition = () =>
    kubernetesComposition(schema, (spec) => {
      namespace({
        id: 'ownedNamespace',
        metadata: {
          name: Cel.expr(spec.namespace) as string,
          // Declarative ObjectMeta that the "complete preservation" guarantee covers.
          finalizers: ['example.com/protect'],
          ownerReferences: [ownerRef] as never,
        },
      });
      return { ready: true };
    });

  it('toYaml retains metadata.finalizers and metadata.ownerReferences', () => {
    const yaml = richComposition()
      .factory('kro', { namespace: 'app' })
      .toYaml({ name: 'x', namespace: 'app' });
    const nsDoc = splitDocs(yaml).find((doc) => /^kind: Namespace$/m.test(doc)) ?? '';
    expect(nsDoc).toContain('example.com/protect');
    expect(nsDoc).toContain('parent-uid-123');
  });

  it('toAlchemyResources retains metadata.finalizers and metadata.ownerReferences', async () => {
    const decls = await richComposition()
      .factory('kro', { namespace: 'app' })
      .toAlchemyResources({ name: 'x', namespace: 'app' });
    const meta = decls[0]?.props.resource?.metadata as {
      finalizers?: string[];
      ownerReferences?: Array<{ uid?: string }>;
    };
    expect(meta.finalizers).toEqual(['example.com/protect']);
    expect(meta.ownerReferences?.[0]?.uid).toBe('parent-uid-123');
  });
});
