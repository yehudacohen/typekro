import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { existingInstanceNamespacesAlchemyForTest } from '../../src/alchemy/resource-registration.js';
import type { TypeKroResourceProps } from '../../src/alchemy/types.js';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import {
  HOISTED_NAMESPACES_ANNOTATION,
  listNamespacesOwnedByRgd,
  NAMESPACE_OWNER_ANNOTATION,
} from '../../src/core/deployment/kro-namespace-teardown.js';
import { getComponentLogger } from '../../src/core/logging/index.js';
import { Cel } from '../../src/core/references/cel.js';
import type { Enhanced } from '../../src/core/types/kubernetes.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';
import { job } from '../../src/factories/kubernetes/workloads/job.js';
import { createMockKubeConfig } from '../utils/mock-factories.js';

/**
 * DETERMINISTIC, OFFLINE proof of the PR #113 v7 review round — the two multi-instance P1s
 * whose ROOT CAUSE is that the RGD-wide `typekro.io/created-by-rgd` set is NOT a per-instance
 * record and so cannot prove a SPECIFIC instance's namespaces:
 *
 *  - #1 [P1] The pre-hoist guard resolves EACH instance from its OWN exact record (the CR
 *        `typekro.io/hoisted-namespaces` annotation) and FAILS CLOSED for any instance that
 *        lacks it — instead of "resolving" a legacy instance against the RGD-wide set that a
 *        DIFFERENT (modern) instance happened to stamp. The reviewer's exact repro: a legacy
 *        (unannotated) instance ALONGSIDE a modern (stamped) one. Both the imperative and the
 *        alchemy guards.
 *  - #2 [P1] `deleteInstance` LISTS REMAINING INSTANCES FIRST, then excludes every namespace
 *        a remaining instance still records from this instance's deletable set — so deleting
 *        one instance never removes a namespace a remaining instance shares. Deleting the LAST
 *        instance cleans it. A remaining-instance list that can't be read FAILS CLOSED.
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

function makeJobFactory(factoryName: string, workloadNs: string) {
  const composition = kubernetesComposition(
    { name: factoryName, kind: 'MultiGate', spec: MultiSpec, status: MultiStatus },
    () => {
      job({
        id: 'migration',
        metadata: { name: 'migration', namespace: workloadNs },
        spec: {
          template: {
            spec: {
              restartPolicy: 'Never',
              containers: [{ name: 'migration', image: 'busybox:1.36.1' }],
            },
          },
        },
      });
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

describe('durable owned Namespace pagination', () => {
  it('follows client-node metadata._continue and finds an owner beyond page one', async () => {
    const rgdName = 'page-two-owner';
    const tokens: Array<string | undefined> = [];
    const result = await listNamespacesOwnedByRgd({} as never, rgdName, {
      k8sApi: {
        list: async (
          _apiVersion,
          _kind,
          _namespace,
          _pretty,
          _exact,
          _export,
          _fieldSelector,
          _labelSelector,
          _limit,
          continueToken
        ) => {
          tokens.push(continueToken);
          return continueToken === undefined
            ? {
                items: [{ metadata: { name: 'unrelated' } }],
                metadata: { _continue: 'second-page' },
              }
            : {
                items: [
                  {
                    metadata: {
                      name: 'durably-owned',
                      annotations: { [NAMESPACE_OWNER_ANNOTATION]: rgdName },
                    },
                  },
                ],
                metadata: {},
              };
        },
      },
    });

    expect(tokens).toEqual([undefined, 'second-page']);
    expect(result).toEqual(['durably-owned']);
  });
});

// ===========================================================================
// #1 [P1] — pre-hoist guard: per-instance EXACT record or FAIL CLOSED.
//   The reviewer's repro: a legacy (unannotated) instance NEXT TO a modern
//   (stamped) instance. The modern instance makes the RGD-wide created-by-rgd
//   set non-empty; the OLD code used that to satisfy the legacy instance's
//   check and returned only the modern namespace — leaving the legacy one
//   exposed to the ApplySet prune. v7 must THROW.
// ===========================================================================
describe('#1 [P1] imperative pre-hoist guard: legacy + modern → FAILS CLOSED', () => {
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

  it("THROWS: a legacy (unannotated) instance is NOT masked by a modern instance's stamped namespace", async () => {
    const factory = makeFactory('v7-legacy-plus-modern', 'app-ns');
    const rgdName = (factory as unknown as Rec).rgdName as string;
    wire(factory, {
      instances: [
        // MODERN instance — carries its exact per-instance record.
        { metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["modern-ns"]' } } },
        // LEGACY instance — NO CR record. Its own namespace is invisible.
        { spec: { name: 'legacy', namespace: 'legacy-ns' } },
      ],
      // The modern instance stamped THIS RGD's created-by-rgd on its namespace, making the
      // RGD-wide set NON-EMPTY — the exact condition the old code used to (wrongly) pass.
      ownedNamespaces: [
        { metadata: { name: 'modern-ns', annotations: { [NAMESPACE_OWNER_ANNOTATION]: rgdName } } },
      ],
    });
    const fn = priv(factory, 'existingInstancesHoistedNamespaceNames');
    await expect(fn()).rejects.toThrow(
      /PRE_HOIST_LEGACY_INSTANCE_UNRESOLVABLE|no per-instance namespace record/
    );
  });

  it('PASSES (union of exact records) when EVERY instance carries its own CR record', async () => {
    const factory = makeFactory('v7-all-modern', 'app-ns');
    wire(factory, {
      instances: [
        { metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["ns-a"]' } } },
        { metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["ns-b"]' } } },
      ],
      ownedNamespaces: [],
    });
    const fn = priv(factory, 'existingInstancesHoistedNamespaceNames') as () => Promise<
      Set<string>
    >;
    const result = await fn();
    expect(result.has('ns-a')).toBe(true);
    expect(result.has('ns-b')).toBe(true);
  });
});

describe('#1 [P1] alchemy pre-hoist guard: legacy + modern → FAILS CLOSED', () => {
  const logger = getComponentLogger('kro-pr113-v7-test');

  const props = (ownerRgd: string): TypeKroResourceProps<Enhanced<unknown, unknown>> =>
    ({
      resource: {} as Enhanced<unknown, unknown>,
      namespace: 'app-ns',
      deploymentStrategy: 'kro',
      namespaceEmptyGate: true,
      namespaceOwnerRgd: ownerRgd,
      namespacePreHoistQuery: { group: 'kro.run', version: 'v1alpha1', kind: 'MultiGate' },
    }) as TypeKroResourceProps<Enhanced<unknown, unknown>>;

  /** CRD-discovery objectApi that reports the query's CRD present. */
  const crdPresentObjectApi = {
    list: async (_apiVersion: string, _kind: string) => ({
      items: [{ spec: { group: 'kro.run', names: { kind: 'MultiGate', plural: 'multigates' } } }],
    }),
  };

  it('THROWS: an unannotated instance alongside a stamped one (RGD-wide set is not per-instance proof)', async () => {
    const ownerRgd = 'v7-alchemy-rgd';
    await expect(
      existingInstanceNamespacesAlchemyForTest(props(ownerRgd), {} as never, logger, {
        objectApi: crdPresentObjectApi,
        customApi: {
          listClusterCustomObject: async () => ({
            items: [
              // modern (exact record)
              { metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["modern-ns"]' } } },
              // legacy (no record)
              { metadata: {}, spec: { name: 'legacy', namespace: 'legacy-ns' } },
            ],
          }),
        },
        // A stamped namespace exists (RGD-wide set non-empty) — must NOT satisfy the legacy check.
        ownedNamespaceListApi: {
          list: async () => ({
            items: [
              {
                metadata: {
                  name: 'modern-ns',
                  annotations: { [NAMESPACE_OWNER_ANNOTATION]: ownerRgd },
                },
              },
            ],
            metadata: {},
          }),
        },
      })
    ).rejects.toThrow(/no per-instance namespace record/);
  });

  it('PASSES (union of exact records) when EVERY instance carries its own CR record', async () => {
    const ownerRgd = 'v7-alchemy-rgd-ok';
    const result = await existingInstanceNamespacesAlchemyForTest(
      props(ownerRgd),
      {} as never,
      logger,
      {
        objectApi: crdPresentObjectApi,
        customApi: {
          listClusterCustomObject: async () => ({
            items: [
              { metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["ns-a"]' } } },
              { metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["ns-b"]' } } },
            ],
          }),
        },
        ownedNamespaceListApi: { list: async () => ({ items: [], metadata: {} }) },
      }
    );
    expect(result.has('ns-a')).toBe(true);
    expect(result.has('ns-b')).toBe(true);
  });
});

// ===========================================================================
// #2 [P1] — deleteInstance excludes remaining instances' shared namespaces.
// ===========================================================================
describe('#2 [P1] deleteInstance preserves a namespace a REMAINING instance shares', () => {
  interface Op {
    op: 'read' | 'delete';
    kind: string;
    name: string;
  }

  /**
   * A mock cluster for a deleteInstance run. The CR's first read returns `crBody` (carrying
   * the recorded hoisted-namespaces annotation); after the CR delete gate it 404s. Namespace
   * reads return `namespaceAnnotations`. RGD/CRD reads 404 (drain promptly).
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
        if (kind === 'ResourceGraphDefinition' || kind === 'CustomResourceDefinition') {
          throw notFound();
        }
        if (kind === 'Namespace') {
          return { metadata: { name, annotations: opts.namespaceAnnotations ?? {} } };
        }
        throw notFound();
      },
      delete: async (obj: { kind?: string; metadata?: { name?: string } }) => {
        ops.push({ op: 'delete', kind: obj.kind ?? '?', name: obj.metadata?.name ?? '?' });
        return {};
      },
      // Cluster-wide Namespace list for the retry-safe created-by-rgd sweep (last instance only).
      list: async (_apiVersion: string, _kind: string) => ({ items: [], metadata: {} }),
    };
    return { api, ops };
  }

  /**
   * Wire the factory's cluster surfaces. `remaining` is the cluster-wide instance list; set
   * `listThrows` to simulate an unreadable instance list.
   */
  function wire(
    factory: unknown,
    api: unknown,
    opts: {
      remaining?: Array<{
        metadata?: { name?: unknown; namespace?: unknown; annotations?: Record<string, string> };
      }>;
      listThrows?: boolean;
    }
  ): void {
    const rec = factory as Rec;
    rec.createKubernetesObjectApi = () => api;
    rec.discoveredPlural = 'multigates';
    rec.createCustomObjectsApi = async () => ({
      listClusterCustomObject: async () => {
        if (opts.listThrows) throw new Error('list unavailable (RBAC/connectivity)');
        return { items: opts.remaining ?? [] };
      },
    });
  }

  const nsRead = (ops: Op[], name: string): boolean =>
    ops.some((o) => o.op === 'read' && o.kind === 'Namespace' && o.name === name);
  const has = (ops: Op[], op: Op['op'], kind: string): boolean =>
    ops.some((o) => o.op === op && o.kind === kind);

  it('deleting instance A PRESERVES the shared namespace (remaining instance B records it)', async () => {
    const factory = makeFactory('v7-share-nonlast', 'app-ns');
    const rgdName = (factory as unknown as Rec).rgdName as string;
    // A hoists "shared-ns"; the owned+matching annotation would make it deletable IF reached.
    const { api, ops } = makeMockApi({
      crBody: {
        spec: { name: 'a', namespace: 'shared-ns' },
        metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["shared-ns"]' } },
      },
      namespaceAnnotations: { [NAMESPACE_OWNER_ANNOTATION]: rgdName },
    });
    // Remaining instance B ALSO records "shared-ns" → it must be excluded from A's cleanup.
    wire(factory, api, {
      remaining: [
        {
          metadata: {
            name: 'b',
            namespace: 'app-ns',
            annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["shared-ns"]' },
          },
        },
      ],
    });

    const result = await factory.deleteInstance('a');

    // The shared namespace was EXCLUDED — never even read for deletion...
    expect(nsRead(ops, 'shared-ns')).toBe(false);
    expect(has(ops, 'delete', 'Namespace')).toBe(false);
    // ...and the shared RGD/CRD are preserved for the remaining instance B.
    expect(has(ops, 'delete', 'ResourceGraphDefinition')).toBe(false);
    expect(has(ops, 'delete', 'CustomResourceDefinition')).toBe(false);
    expect(result.status).toBe('complete');
    expect(result.blockers).toEqual([]);
    expect(result.retained).toEqual(
      expect.arrayContaining([expect.objectContaining({ policy: 'shared-instance' })])
    );
  });

  it('treats an already-absent Job reported by client-node 1.x as drained', async () => {
    const factory = makeJobFactory('v7-missing-job', 'app-ns');
    const { api, ops } = makeMockApi({
      crBody: {
        spec: { name: 'a', namespace: 'app-ns' },
        metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '[]' } },
      },
    });
    const objectApi = api as typeof api & {
      read: (obj: { kind?: string; metadata?: { name?: string } }) => Promise<unknown>;
    };
    const baseRead = objectApi.read;
    objectApi.read = async (obj) => {
      if (obj.kind === 'Job') {
        const error = new Error(
          'HTTP-Code: 404\nMessage: Unsuccessful HTTP Request'
        ) as Error & { body?: string };
        error.body = JSON.stringify({
          kind: 'Status',
          status: 'Failure',
          reason: 'NotFound',
          code: 404,
        });
        throw error;
      }
      return baseRead(obj);
    };
    wire(factory, objectApi, { remaining: [] });

    const result = await factory.deleteInstance('a');

    expect(ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'delete', kind: 'MultiGate', name: 'a' }),
      ])
    );
    expect(result.status).toBe('complete');
    expect(result.blockers).toEqual([]);
  });

  it('deleting the LAST instance CLEANS the shared namespace (no remaining instance records it)', async () => {
    const factory = makeFactory('v7-share-last', 'app-ns');
    const { api, ops } = makeMockApi({
      crBody: {
        spec: { name: 'a', namespace: 'shared-ns' },
        metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["shared-ns"]' } },
      },
      // Non-owned annotation → the ownership gate RETAINS after reading (so the empty-gate's
      // real-cluster emptiness inventory is never reached offline). The Namespace READ is the
      // proof the cleanup step was REACHED for this now-exclusive namespace; the owned+empty
      // DELETE itself is covered by the deleteNamespaceIfEmpty unit tests.
      namespaceAnnotations: {},
    });
    // No remaining instances → the exclusion set is empty → the namespace cleanup is reached.
    wire(factory, api, { remaining: [] });

    const result = await factory.deleteInstance('a');

    // The cleanup step WAS reached for the (now-exclusive) namespace...
    expect(nsRead(ops, 'shared-ns')).toBe(true);
    // ...and, being the last instance, the RGD is torn down while the reusable CRD stays Active.
    expect(has(ops, 'delete', 'ResourceGraphDefinition')).toBe(true);
    expect(has(ops, 'delete', 'CustomResourceDefinition')).toBe(false);
    expect(result.status).toBe('complete');
    expect(result.retained).toEqual(
      expect.arrayContaining([expect.objectContaining({ policy: 'adopted-resource' })])
    );
  });

  it('FAILS CLOSED: an unreadable remaining-instance list preserves ALL namespaces + the RGD/CRD', async () => {
    const factory = makeFactory('v7-share-listfail', 'app-ns');
    const rgdName = (factory as unknown as Rec).rgdName as string;
    const { api, ops } = makeMockApi({
      crBody: {
        spec: { name: 'a', namespace: 'shared-ns' },
        metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["shared-ns"]' } },
      },
      namespaceAnnotations: { [NAMESPACE_OWNER_ANNOTATION]: rgdName },
    });
    // The instance list can't be read → we can compute NEITHER the exclusion nor the share
    // decision → delete NOTHING and preserve the definitions.
    wire(factory, api, { listThrows: true });

    const result = await factory.deleteInstance('a');

    expect(nsRead(ops, 'shared-ns')).toBe(false);
    expect(has(ops, 'delete', 'Namespace')).toBe(false);
    expect(has(ops, 'delete', 'ResourceGraphDefinition')).toBe(false);
    expect(has(ops, 'delete', 'CustomResourceDefinition')).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DISCOVERY_FAILED', retryable: true }),
      ])
    );
    expect(result.retry.safe).toBe(true);
  });

  it('FAILS CLOSED: a remaining instance with NO resolvable record preserves the namespace', async () => {
    const factory = makeFactory('v7-share-unresolvable', 'app-ns');
    const rgdName = (factory as unknown as Rec).rgdName as string;
    const { api, ops } = makeMockApi({
      crBody: {
        spec: { name: 'a', namespace: 'shared-ns' },
        metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '["shared-ns"]' } },
      },
      namespaceAnnotations: { [NAMESPACE_OWNER_ANNOTATION]: rgdName },
    });
    // Remaining instance B has NO hoisted-namespaces annotation → its namespaces are unknown →
    // the exclusion is uncomputable → preserve ALL of A's namespaces (delete none).
    wire(factory, api, {
      remaining: [{ metadata: { name: 'b', namespace: 'app-ns' } }],
    });

    const result = await factory.deleteInstance('a');

    expect(nsRead(ops, 'shared-ns')).toBe(false);
    expect(has(ops, 'delete', 'Namespace')).toBe(false);
    // RGD/CRD preserved for the remaining instance B.
    expect(has(ops, 'delete', 'ResourceGraphDefinition')).toBe(false);
    expect(has(ops, 'delete', 'CustomResourceDefinition')).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OWNERSHIP_UNPROVEN', retryable: true }),
      ])
    );
  });
});
