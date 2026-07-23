import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import {
  decideNamespaceOwnershipCreateFirst,
  HOISTED_NAMESPACES_ANNOTATION,
  type NamespaceCreateFirstApi,
  NAMESPACE_OWNER_ANNOTATION,
} from '../../src/core/deployment/kro-namespace-teardown.js';
import { Cel } from '../../src/core/references/cel.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';
import { createMockKubeConfig } from '../utils/mock-factories.js';

/**
 * DETERMINISTIC, OFFLINE proof of the PR #113 v6 review round (transition/retry safety):
 *  - #1: the PRE-HOIST guard FAILS CLOSED (throws) when an existing instance's namespaces
 *        cannot be resolved from a DURABLE source — no CR `typekro.io/hoisted-namespaces`
 *        record AND no Namespace carrying `typekro.io/created-by-rgd`; it PASSES when
 *        resolvable via EITHER annotation.
 *  - #2: teardown with the CR ALREADY ABSENT still finds the owned namespace via the durable
 *        `typekro.io/created-by-rgd` annotation and cleans it; and does NOT delete the
 *        RGD/CRD while an owned namespace still exists (definitions preserved until cleanup
 *        is confirmed).
 *  - #3: the create-first ownership helper recognizes a 409 shaped as
 *        `response.statusCode === 409` (via the centralized `isConflictError`) → adopt.
 *
 * The real cluster ORDER end-to-end is validated by the maintainer on OrbStack via
 * test/integration/kro-namespace-sibling-lifecycle.test.ts (WRITTEN, not run here).
 */

type Rec = Record<string, unknown>;

const MultiSpec = type({ name: 'string', namespace: 'string' });
const MultiStatus = type({ ready: 'boolean' });

/** A self-owning composition (creates + owns a Namespace named after spec.namespace). */
function makeFactory(factoryName: string, workloadNs: string) {
  const composition = kubernetesComposition(
    { name: factoryName, kind: 'MultiGate', spec: MultiSpec, status: MultiStatus },
    (spec) => {
      namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
      return { ready: true };
    }
  );
  return composition.factory('kro', {
    namespace: workloadNs,
    timeout: 250,
    kubeConfig: createMockKubeConfig(),
  });
}

function priv(target: unknown, method: string): (...args: unknown[]) => unknown {
  const fn = (target as Record<string, (...args: unknown[]) => unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`missing private method ${method}`);
  return fn.bind(target);
}

// ---------------------------------------------------------------------------
// #1 — pre-hoist guard fails closed for a genuinely-legacy instance.
// ---------------------------------------------------------------------------
describe('#1: existingInstancesHoistedNamespaceNames resolves EXACTLY or FAILS CLOSED', () => {
  /**
   * Wire the CRD-present discovery + the cluster-wide instance list + the Namespace list
   * (the durable created-by-rgd source) onto a factory's private surfaces.
   */
  function wire(
    factory: unknown,
    opts: {
      instances: Array<{ metadata?: { annotations?: Record<string, string> }; spec?: unknown }>;
      ownedNamespaces?: Array<{
        metadata?: { name?: string; annotations?: Record<string, string> };
      }>;
    }
  ): void {
    const rec = factory as Rec;
    rec.discoverGeneratedCrdPlural = async () => ({ present: true, plural: 'multigates' });
    rec.createCustomObjectsApi = async () => ({
      listClusterCustomObject: async () => ({ items: opts.instances }),
    });
    rec.createKubernetesObjectApi = () => ({
      list: async (_apiVersion: string, kind: string) =>
        kind === 'Namespace'
          ? { items: opts.ownedNamespaces ?? [], metadata: {} }
          : { items: [], metadata: {} },
    });
  }

  it('FAILS CLOSED: an existing instance with NO CR record AND NO created-by-rgd namespace', async () => {
    const factory = makeFactory('v6-legacy', 'app-ns');
    // One instance, no hoisted-namespaces annotation; and the cluster has NO namespace
    // stamped for this RGD → nothing durable resolves it.
    wire(factory, {
      instances: [{ spec: { name: 'inst', namespace: 'app-ns' } }],
      ownedNamespaces: [],
    });
    const fn = priv(factory, 'existingInstancesHoistedNamespaceNames');
    await expect(fn()).rejects.toThrow(
      /PRE_HOIST_LEGACY_INSTANCE_UNRESOLVABLE|no per-instance namespace record/
    );
  });

  it('PASSES via the CR hoisted-namespaces record (arbitrary-field name round-trips)', async () => {
    const factory = makeFactory('v6-cr-record', 'app-ns');
    wire(factory, {
      instances: [
        { metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["team-a-custom"]' } } },
      ],
      ownedNamespaces: [],
    });
    const fn = priv(factory, 'existingInstancesHoistedNamespaceNames') as () => Promise<
      Set<string>
    >;
    const result = await fn();
    expect(result.has('team-a-custom')).toBe(true);
  });

  it('FAILS CLOSED for an unannotated instance EVEN WHEN a created-by-rgd namespace exists (v7 tightening)', async () => {
    // v7 correction (finding #1): the RGD-wide created-by-rgd set is NOT per-instance proof.
    // An unannotated instance must FAIL CLOSED even when a stamped namespace exists, because
    // that namespace could belong to a DIFFERENT instance — the v6 "resolve from the RGD-wide
    // set" fallback masked exactly this. (The stamped namespace IS still unioned into the
    // protected set as a superset, but it never SATISFIES the per-instance check.)
    const factory = makeFactory('v6-owned-ns', 'app-ns');
    const rgdName = (factory as unknown as Rec).rgdName as string;
    wire(factory, {
      // Instance carries NO CR record...
      instances: [{ spec: { name: 'inst', namespace: 'app-ns' } }],
      // ...and a Namespace stamped by THIS RGD exists — but it is NOT per-instance proof.
      ownedNamespaces: [
        {
          metadata: {
            name: 'owned-by-rgd',
            annotations: { [NAMESPACE_OWNER_ANNOTATION]: rgdName },
          },
        },
      ],
    });
    const fn = priv(factory, 'existingInstancesHoistedNamespaceNames');
    await expect(fn()).rejects.toThrow(
      /PRE_HOIST_LEGACY_INSTANCE_UNRESOLVABLE|no per-instance namespace record/
    );
  });
});

// ---------------------------------------------------------------------------
// #2 — teardown is retry-safe: find owned namespaces via created-by-rgd even
// when the CR is already gone; preserve the RGD/CRD until cleanup is confirmed.
// ---------------------------------------------------------------------------
describe('#2: teardown with the CR ALREADY ABSENT finds + gates on the created-by-rgd namespace', () => {
  interface Op {
    op: 'read' | 'delete' | 'list';
    kind: string;
    name: string;
  }

  /**
   * A mock cluster where the instance CR is ALREADY GONE (read/delete 404). The Namespace
   * cluster-wide LIST is what the durable created-by-rgd sweep reads; `nsListByCall` returns
   * a (possibly different) list per successive list call so we can simulate "still present"
   * vs "cleaned up by the confirm step".
   */
  function makeMock(opts: {
    rgdName: string;
    nsListByCall: Array<
      Array<{ metadata?: { name?: string; annotations?: Record<string, string> } }>
    >;
  }) {
    const ops: Op[] = [];
    let listCall = 0;
    const notFound = () => {
      const err = new Error('not found') as Error & { statusCode?: number };
      err.statusCode = 404;
      return err;
    };
    const api = {
      read: async (obj: { kind?: string; metadata?: { name?: string } }) => {
        const kind = obj.kind ?? '?';
        const name = obj.metadata?.name ?? '?';
        ops.push({ op: 'read', kind, name });
        // The owned namespace's per-object read returns NO ownership stamp, so
        // deleteNamespaceIfEmpty RETAINS it here (never reaching real cluster discovery) —
        // this test isolates the SWEEP-finds-it + confirm-gate logic, not the empty-delete.
        if (kind === 'Namespace') return { metadata: { name, annotations: {} } };
        throw notFound(); // MultiGate / RGD / CRD all 404 (CR already absent)
      },
      delete: async (obj: { kind?: string; metadata?: { name?: string } }) => {
        ops.push({ op: 'delete', kind: obj.kind ?? '?', name: obj.metadata?.name ?? '?' });
        return {};
      },
      list: async (_apiVersion: string, kind: string) => {
        ops.push({ op: 'list', kind, name: '*' });
        if (kind === 'Namespace') {
          const items = opts.nsListByCall[Math.min(listCall, opts.nsListByCall.length - 1)] ?? [];
          listCall += 1;
          return { items, metadata: {} };
        }
        return { items: [], metadata: {} };
      },
    };
    return { api, ops };
  }

  function wireTeardown(factory: unknown, api: unknown): void {
    const rec = factory as Rec;
    rec.createKubernetesObjectApi = () => api;
    rec.discoveredPlural = 'multigates';
    rec.createCustomObjectsApi = async () => ({
      listClusterCustomObject: async () => ({ items: [] }), // last instance
    });
  }

  const has = (ops: Op[], op: Op['op'], kind: string): boolean =>
    ops.some((o) => o.op === op && o.kind === kind);
  const readName = (ops: Op[], name: string): boolean =>
    ops.some((o) => o.op === 'read' && o.kind === 'Namespace' && o.name === name);

  it('finds the owned namespace via created-by-rgd and PRESERVES the RGD/CRD while it remains', async () => {
    const factory = makeFactory('v6-retry-remains', 'app-ns');
    const rgdName = (factory as unknown as Rec).rgdName as string;
    const owned = [
      { metadata: { name: 'leaked-ns', annotations: { [NAMESPACE_OWNER_ANNOTATION]: rgdName } } },
    ];
    // Both the sweep list AND the confirm list still report the owned namespace present.
    const { api, ops } = makeMock({ rgdName, nsListByCall: [owned, owned] });
    wireTeardown(factory, api);

    await factory.deleteInstance('inst');

    // The sweep FOUND the owned namespace via created-by-rgd (CR was 404) and processed it.
    expect(readName(ops, 'leaked-ns')).toBe(true);
    // ...and because an owned namespace still exists, the definitions are PRESERVED.
    expect(has(ops, 'delete', 'ResourceGraphDefinition')).toBe(false);
    expect(has(ops, 'delete', 'CustomResourceDefinition')).toBe(false);
  });

  it('deletes the RGD but retains the CRD once owned namespaces are confirmed clean', async () => {
    const factory = makeFactory('v6-retry-clean', 'app-ns');
    const rgdName = (factory as unknown as Rec).rgdName as string;
    const owned = [
      { metadata: { name: 'leaked-ns', annotations: { [NAMESPACE_OWNER_ANNOTATION]: rgdName } } },
    ];
    // Sweep sees it; the confirm list sees it GONE → cleanup confirmed → tear definitions down.
    const { api, ops } = makeMock({ rgdName, nsListByCall: [owned, []] });
    wireTeardown(factory, api);

    await factory.deleteInstance('inst');

    expect(readName(ops, 'leaked-ns')).toBe(true);
    expect(has(ops, 'delete', 'ResourceGraphDefinition')).toBe(true);
    expect(has(ops, 'delete', 'CustomResourceDefinition')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #3 — create-first ownership uses the centralized isConflictError (all 409 shapes).
// ---------------------------------------------------------------------------
describe('#3: decideNamespaceOwnershipCreateFirst recognizes response.statusCode === 409', () => {
  const manifest = (annotations: Record<string, string>) =>
    ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'ns', annotations } }) as never;

  it('a 409 shaped as response.statusCode adopts (owned via our prior stamp)', async () => {
    // The OLD hand-rolled check (statusCode ?? code ?? body.code) MISSED this shape and would
    // have RETHROWN; isConflictError catches it → 409 → read-and-adopt path.
    const api: NamespaceCreateFirstApi = {
      create: async () => {
        const err = new Error('already exists') as Error & { response?: { statusCode?: number } };
        err.response = { statusCode: 409 };
        throw err;
      },
      read: async () => ({ metadata: { annotations: { [NAMESPACE_OWNER_ANNOTATION]: 'my-rgd' } } }),
    };
    const decision = await decideNamespaceOwnershipCreateFirst(
      api,
      manifest({ [NAMESPACE_OWNER_ANNOTATION]: 'my-rgd' }),
      'my-rgd'
    );
    expect(decision).toEqual({ created: false, owned: true });
  });

  it('a 409 shaped as response.statusCode with NO stamp → adopt (owned:false)', async () => {
    const api: NamespaceCreateFirstApi = {
      create: async () => {
        const err = new Error('already exists') as Error & { response?: { statusCode?: number } };
        err.response = { statusCode: 409 };
        throw err;
      },
      read: async () => ({ metadata: { annotations: {} } }),
    };
    const decision = await decideNamespaceOwnershipCreateFirst(
      api,
      manifest({ [NAMESPACE_OWNER_ANNOTATION]: 'my-rgd' }),
      'my-rgd'
    );
    expect(decision).toEqual({ created: false, owned: false });
  });
});
