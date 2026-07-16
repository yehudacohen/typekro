import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import {
  decideNamespaceOwnershipCreateFirst,
  HOISTED_NAMESPACES_ANNOTATION,
  type NamespaceCreateFirstApi,
  NAMESPACE_OWNER_ANNOTATION,
  parseHoistedNamespacesAnnotation,
} from '../../src/core/deployment/kro-namespace-teardown.js';
import { Cel } from '../../src/core/references/cel.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

/**
 * DETERMINISTIC, OFFLINE proof of the PR #113 v5 review round:
 *  - #2: deleting a NON-last instance cleans ITS OWN namespace but leaves the RGD/CRD;
 *        deleting the LAST instance also tears down the RGD + CRD.
 *  - #3: create-first ownership — a 201 create means we own it; a 409 conflict means adopt
 *        (owned only if a prior create by THIS rgd already stamped it).
 *  - #4: the instance CR carries the durable `typekro.io/hoisted-namespaces` record at
 *        deploy time, and teardown reads it back EXACTLY — including a name derived from an
 *        ARBITRARY spec field (spec.targetNamespace) that the old approximation missed.
 *
 * The real cluster ORDER end-to-end is validated by the maintainer on OrbStack via
 * test/integration/kro-namespace-sibling-lifecycle.test.ts (WRITTEN, not run here).
 */

type Rec = Record<string, unknown>;

interface Op {
  op: 'read' | 'delete';
  kind: string;
  name: string;
}

/**
 * Mock KubernetesObjectApi recording the ORDER of every read/delete. The CR's first read
 * returns `crBody` (spec + optional recorded annotation); after the CR delete gate it 404s.
 * The Namespace read returns `namespaceAnnotations`. The CRD read 404s (drains promptly).
 */
function makeMockApi(opts: {
  crBody: { spec?: unknown; metadata?: { annotations?: Record<string, string> } };
  namespaceAnnotations?: Record<string, string>;
}) {
  const ops: Op[] = [];
  let crReadCount = 0;
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
      if (kind === 'MultiGate') {
        crReadCount += 1;
        if (crReadCount === 1) return opts.crBody;
        throw notFound();
      }
      if (kind === 'ResourceGraphDefinition') throw notFound();
      if (kind === 'CustomResourceDefinition') throw notFound();
      if (kind === 'Namespace') {
        return { metadata: { name, annotations: opts.namespaceAnnotations ?? {} } };
      }
      throw notFound();
    },
    delete: async (obj: { kind?: string; metadata?: { name?: string } }) => {
      ops.push({ op: 'delete', kind: obj.kind ?? '?', name: obj.metadata?.name ?? '?' });
      return {};
    },
  };
  return { api, ops };
}

const MultiSpec = type({ name: 'string', namespace: 'string' });
const MultiStatus = type({ ready: 'boolean' });

/** A self-owning composition (creates + owns a Namespace named after spec.namespace). */
function makeFactory(factoryName: string, workloadNs: string) {
  const composition = kubernetesComposition(
    {
      name: factoryName,
      kind: 'MultiGate',
      spec: MultiSpec,
      status: MultiStatus,
    },
    (spec) => {
      namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
      return { ready: true };
    }
  );
  return composition.factory('kro', { namespace: workloadNs, timeout: 250 });
}

/**
 * Wire the mock cluster surfaces onto a factory's private methods. `remaining` is the
 * cluster-wide instance list returned by the shared-RGD check.
 */
function wire(
  factory: unknown,
  api: unknown,
  opts: {
    remaining: Array<{ metadata?: { name?: unknown; namespace?: unknown } }>;
    derivedNamespaces?: string[];
  }
): void {
  const rec = factory as Rec;
  rec.createKubernetesObjectApi = () => api;
  rec.discoveredPlural = 'multigates';
  rec.createCustomObjectsApi = async () => ({
    listClusterCustomObject: async () => ({ items: opts.remaining }),
  });
  // Fallback derivation (used only when the CR carries no recorded annotation).
  rec.concreteHoistedNamespaces = () =>
    new Map((opts.derivedNamespaces ?? []).map((n) => [n, { apiVersion: 'v1', kind: 'Namespace' }]));
}

const has = (ops: Op[], op: Op['op'], kind: string): boolean =>
  ops.some((o) => o.op === op && o.kind === kind);
const firstReadName = (ops: Op[], kind: string): string | undefined =>
  ops.find((o) => o.op === 'read' && o.kind === kind)?.name;

// ---------------------------------------------------------------------------
// #2 — per-instance namespace cleanup runs regardless of remaining instances.
// ---------------------------------------------------------------------------
describe('#2: deleting a NON-last instance cleans ITS namespace but NOT the RGD/CRD', () => {
  it('a non-last instance: namespace step runs; RGD + CRD are preserved', async () => {
    const factory = makeFactory('multi-nonlast', 'app-ns');
    const { api, ops } = makeMockApi({
      crBody: { spec: { name: 'inst', namespace: 'app-ns' } },
      namespaceAnnotations: {}, // not owned → retained after the ownership read
    });
    // Another instance of the same shared RGD still exists.
    wire(factory, api, {
      remaining: [{ metadata: { name: 'other', namespace: 'app-ns' } }],
      derivedNamespaces: ['app-ns'],
    });

    await factory.deleteInstance('inst');

    // THIS instance's namespace WAS processed (cleanup step reached) — the old code
    // early-returned on the remaining-instance check BEFORE ever cleaning it.
    expect(has(ops, 'read', 'Namespace')).toBe(true);
    // ...but the shared RGD + CRD are preserved for the remaining instance.
    expect(has(ops, 'delete', 'ResourceGraphDefinition')).toBe(false);
    expect(has(ops, 'delete', 'CustomResourceDefinition')).toBe(false);
  });

  it('the LAST instance: namespace step runs AND the RGD + CRD are torn down', async () => {
    const factory = makeFactory('multi-last', 'app-ns');
    const { api, ops } = makeMockApi({
      crBody: { spec: { name: 'inst', namespace: 'app-ns' } },
      namespaceAnnotations: {},
    });
    wire(factory, api, { remaining: [], derivedNamespaces: ['app-ns'] });

    await factory.deleteInstance('inst');

    expect(has(ops, 'read', 'Namespace')).toBe(true);
    expect(has(ops, 'delete', 'ResourceGraphDefinition')).toBe(true);
    expect(has(ops, 'delete', 'CustomResourceDefinition')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #3 — create-first ownership (POST-201 = owned; POST-409 = adopt unless our stamp).
// ---------------------------------------------------------------------------
describe('#3: decideNamespaceOwnershipCreateFirst is atomic (owned IFF we created it)', () => {
  const conflict = () => {
    const err = new Error('already exists') as Error & { statusCode?: number };
    err.statusCode = 409;
    return err;
  };
  const manifest = (annotations: Record<string, string>) =>
    ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'ns', annotations } }) as never;

  it('POST-201 → created + owned (we created it)', async () => {
    const created: unknown[] = [];
    const api: NamespaceCreateFirstApi = {
      create: async (r) => {
        created.push(r);
        return {};
      },
      read: async () => {
        throw new Error('read must not be called on a 201 create');
      },
    };
    const decision = await decideNamespaceOwnershipCreateFirst(
      api,
      manifest({ [NAMESPACE_OWNER_ANNOTATION]: 'my-rgd' }),
      'my-rgd'
    );
    expect(decision).toEqual({ created: true, owned: true });
    expect(created).toHaveLength(1);
  });

  it('POST-409 + existing has NO stamp → adopt (created:false, owned:false)', async () => {
    const api: NamespaceCreateFirstApi = {
      create: async () => {
        throw conflict();
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

  it('POST-409 + existing carries OUR stamp → owned (re-deploy of a namespace we own)', async () => {
    const api: NamespaceCreateFirstApi = {
      create: async () => {
        throw conflict();
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

  it('POST-409 + existing owned by a DIFFERENT rgd → adopt (owned:false)', async () => {
    const api: NamespaceCreateFirstApi = {
      create: async () => {
        throw conflict();
      },
      read: async () => ({ metadata: { annotations: { [NAMESPACE_OWNER_ANNOTATION]: 'other-rgd' } } }),
    };
    const decision = await decideNamespaceOwnershipCreateFirst(
      api,
      manifest({ [NAMESPACE_OWNER_ANNOTATION]: 'my-rgd' }),
      'my-rgd'
    );
    expect(decision).toEqual({ created: false, owned: false });
  });

  it('a non-409 create error propagates (fail loud)', async () => {
    const api: NamespaceCreateFirstApi = {
      create: async () => {
        const err = new Error('forbidden') as Error & { statusCode?: number };
        err.statusCode = 403;
        throw err;
      },
      read: async () => ({}),
    };
    await expect(
      decideNamespaceOwnershipCreateFirst(api, manifest({}), 'my-rgd')
    ).rejects.toThrow(/forbidden/);
  });
});

// ---------------------------------------------------------------------------
// #4 — the durable hoisted-namespace RECORD on the instance CR (deploy + read-back).
// ---------------------------------------------------------------------------
describe('#4: the instance CR records its hoisted namespaces (arbitrary spec field round-trips)', () => {
  it('DEPLOY: toYaml stamps typekro.io/hoisted-namespaces with a name from spec.targetNamespace', () => {
    const schema = {
      name: 'rec4',
      kind: 'Rec4',
      spec: type({ name: 'string', targetNamespace: 'string' }),
      status: type({ ready: 'boolean' }),
    };
    // The owned namespace name derives from an ARBITRARY field (spec.targetNamespace), NOT
    // spec.namespace / metadata.namespace — the exact case the old approximation missed.
    const composition = kubernetesComposition(schema, (spec) => {
      namespace({
        id: 'ownedNamespace',
        metadata: { name: Cel.expr(spec.targetNamespace) as string },
      });
      return { ready: true };
    });
    const yaml = composition
      .factory('kro', { namespace: 'ctrl' })
      .toYaml({ name: 'x', targetNamespace: 'team-a-custom' });

    // The CR instance doc carries the recorded annotation with the arbitrary-field name.
    const crDoc =
      yaml
        .split(/^---$/m)
        .map((d) => d.trim())
        .find((d) => /^kind: Rec4$/m.test(d)) ?? '';
    expect(crDoc).toContain(HOISTED_NAMESPACES_ANNOTATION);
    expect(crDoc).toContain('team-a-custom');
    // Round-trip check: the annotation value parses back to exactly the recorded name.
    const match = crDoc.match(/typekro\.io\/hoisted-namespaces:\s*'?(\[.*?\])'?/);
    expect(match).not.toBeNull();
    if (match?.[1]) {
      expect(parseHoistedNamespacesAnnotation(match[1])).toEqual(['team-a-custom']);
    }
  });

  it('TEARDOWN: the recorded annotation is read back EXACTLY (wins over re-derivation)', async () => {
    const factory = makeFactory('rec4-teardown', 'app-ns');
    // The CR carries a RECORDED name that differs from what re-derivation would produce —
    // proving teardown uses the durable record, not the approximation.
    const { api, ops } = makeMockApi({
      crBody: {
        spec: { name: 'inst', namespace: 'app-ns' },
        metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["recorded-target-ns"]' } },
      },
      namespaceAnnotations: {},
    });
    // Fallback derivation would (wrongly) point at 'derived-ns' — must NOT be used.
    wire(factory, api, { remaining: [], derivedNamespaces: ['derived-ns'] });

    await factory.deleteInstance('inst');

    // The namespace processed at teardown is the RECORDED one, not the derived fallback.
    expect(firstReadName(ops, 'Namespace')).toBe('recorded-target-ns');
    expect(ops.some((o) => o.kind === 'Namespace' && o.name === 'derived-ns')).toBe(false);
  });
});
