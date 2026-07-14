import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import {
  computeApplySetId,
  type NamespaceConsumer,
  selectNamespaceOwnerAmongConsumers,
} from '../../src/core/deployment/kro-factory.js';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { toResourceGraph } from '../../src/core/serialization/core.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';
import { Deployment } from '../../src/factories/simple/index.js';
import * as yaml from 'js-yaml';

/**
 * Round-11 coverage for PR #113:
 *  - #1 the RESIDUAL re-stamp race is NARROWED, not eliminated: the post-RGD re-verify
 *    catches a Namespace that an async in-flight reconcile re-adopted AFTER the strip's
 *    confirmation window, or that got pruned — failing loud instead of silently losing it.
 *  - #6 resource-derived SIBLING status fields survive hoisting (only the
 *    namespace-name field becomes client-hydrated).
 *  - #7 shared-workload-Namespace owner selection is ORDER-INDEPENDENT.
 */

const PART_OF = 'applyset.kubernetes.io/part-of';
const INSTANCE_ID = 'kro.run/instance-id';
const RETENTION = 'typekro.io/kro-instance-namespace';

function priv(target: unknown, method: string): (...args: unknown[]) => unknown {
  const fn = (target as Record<string, (...args: unknown[]) => unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`missing private method ${method}`);
  return fn.bind(target);
}

const schema = {
  name: 'round11',
  kind: 'Round11',
  spec: type({ name: 'string', namespace: 'string' }),
  status: type({ ready: 'boolean', 'namespaceName?': 'string' }),
};
const ownsNs = () =>
  kubernetesComposition(schema, (spec) => {
    namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
    return { ready: true };
  });

// -----------------------------------------------------------------------------
// #1 — post-RGD re-verify: the residual race is DETECTED (never silently lost).
// -----------------------------------------------------------------------------
describe('#1: verifyHoistedNamespacesSurvived detects a re-stamp/prune AFTER the new RGD (residual race)', () => {
  const applySetId = computeApplySetId('analytics', 'app', 'Round11', 'test.typekro.dev');
  const target = {
    nsName: 'analytics',
    instanceRef: 'app/analytics',
    expectedApplySetId: applySetId,
    instanceUid: 'uid-1',
  };
  const handle = { resumeTargets: [], strippedNamespaces: ['analytics'] };

  it(
    'a namespace that stayed unowned passes re-verify (no throw)',
    async () => {
      const factory = ownsNs().factory('kro', { namespace: 'app' });
      const api = {
        read: async () => ({ metadata: { labels: { [RETENTION]: 'true' }, resourceVersion: '9' } }),
      };
      const verify = priv(factory, 'verifyHoistedNamespacesSurvived');
      // The re-verify watches the namespace across its full bounded window before
      // concluding it survived, so allow more than the default 5s test timeout.
      await expect(verify(handle, api) as Promise<void>).resolves.toBeUndefined();
    },
    20000
  );

  it('a namespace RE-ADOPTED into the ApplySet after the RGD is applied fails LOUD', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const api = {
      // An in-flight reconcile re-stamped `part-of` after our strip window.
      read: async () => ({ metadata: { labels: { [PART_OF]: applySetId }, resourceVersion: '9' } }),
    };
    const verify = priv(factory, 'verifyHoistedNamespacesSurvived');
    let caught: unknown;
    await (verify(handle, api) as Promise<void>).catch((e) => {
      caught = e;
    });
    expect((caught as Error | undefined)?.message).toMatch(/RE-ADOPTED/);
  });

  it('a namespace that DISAPPEARED (pruned) after the RGD is applied fails LOUD', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const api = {
      read: async () => {
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      },
    };
    const verify = priv(factory, 'verifyHoistedNamespacesSurvived');
    let caught: unknown;
    await (verify(handle, api) as Promise<void>).catch((e) => {
      caught = e;
    });
    expect((caught as Error | undefined)?.message).toMatch(/DISAPPEARED/);
  });

  it('models the REAL race: strip confirms held, then an ASYNC reconcile re-stamps AFTER the confirmation read — post-RGD re-verify catches it', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    // One stateful fake shared across strip + verify. The strip validates (read #1,
    // owned), patches (strips ownership), then the settle window reads it unowned and
    // ACCEPTS the strip. Only AFTER that window (the post-RGD verify reads) does an
    // in-flight reconcile re-adopt it — exactly the residual race the client cannot
    // prevent, only DETECT.
    let rv = 1;
    let reads = 0;
    const labels: Record<string, string> = { [PART_OF]: applySetId, 'kro.run/owned': 'true' };
    // strip does 1 validate read + up to 4 settle reads = 5; the verify window starts after.
    const RESTAMP_AFTER_READ = 5;
    const api = {
      read: async () => {
        reads += 1;
        // An async reconcile re-adopts the namespace only after the strip's window.
        if (reads > RESTAMP_AFTER_READ && labels[PART_OF] === undefined) {
          labels[PART_OF] = applySetId;
          rv += 1;
        }
        return { metadata: { labels: { ...labels }, resourceVersion: String(rv) } };
      },
      patch: async (obj: {
        metadata: { labels?: Record<string, string | null> };
      }) => {
        for (const [k, v] of Object.entries(obj.metadata.labels ?? {})) {
          if (v === null) delete labels[k];
          else labels[k] = v;
        }
        rv += 1;
        return {};
      },
    };
    // 1. Strip SUCCEEDS: it held unowned across the confirmation/settle window.
    const strip = priv(factory, 'stripKroOwnershipFromNamespace');
    await expect(strip(api, target) as Promise<void>).resolves.toBeUndefined();
    expect(labels[PART_OF]).toBeUndefined(); // stripped + stayed stripped through the window

    // 2. Post-RGD re-verify CATCHES the async re-stamp that landed after the window.
    const verify = priv(factory, 'verifyHoistedNamespacesSurvived');
    let caught: unknown;
    await (verify(handle, api) as Promise<void>).catch((e) => {
      caught = e;
    });
    expect((caught as Error | undefined)?.message).toMatch(/RE-ADOPTED/);
  });
});

// -----------------------------------------------------------------------------
// #7 — shared-Namespace owner selection is ORDER-INDEPENDENT.
// -----------------------------------------------------------------------------
describe('#7: selectNamespaceOwnerAmongConsumers is order-independent for a shared Namespace', () => {
  const ownerId = computeApplySetId('owner', 'shared', 'Round11', 'test.typekro.dev');
  const owner: NamespaceConsumer = {
    ref: { name: 'owner', namespace: 'shared' },
    expectedApplySetId: ownerId,
    uid: 'owner-uid',
  };
  const other: NamespaceConsumer = {
    ref: { name: 'other', namespace: 'shared' },
    expectedApplySetId: computeApplySetId('other', 'shared', 'Round11', 'test.typekro.dev'),
    uid: 'other-uid',
  };
  // The live Namespace carries the OWNER's ApplySet identity.
  const nsLabels = { [PART_OF]: ownerId, [INSTANCE_ID]: 'owner-uid', 'kro.run/owned': 'true' };

  it('finds the real owner regardless of enumeration order (owner first)', () => {
    const r = selectNamespaceOwnerAmongConsumers({
      nsName: 'shared',
      nsLabels,
      rgdName: 'rgd',
      consumers: [owner, other],
    });
    expect(r.action).toBe('transfer');
    expect((r as { owner: NamespaceConsumer }).owner.ref.name).toBe('owner');
  });

  it('finds the real owner regardless of enumeration order (non-owner first)', () => {
    // The pre-fix bug: a non-matching consumer enumerated first aborted the migration.
    const r = selectNamespaceOwnerAmongConsumers({
      nsName: 'shared',
      nsLabels,
      rgdName: 'rgd',
      consumers: [other, owner],
    });
    expect(r.action).toBe('transfer');
    expect((r as { owner: NamespaceConsumer }).owner.ref.name).toBe('owner');
  });

  it('aborts when the Namespace is KRO-owned by NONE of the consumers (foreign ApplySet)', () => {
    expect(() =>
      selectNamespaceOwnerAmongConsumers({
        nsName: 'shared',
        nsLabels: { [PART_OF]: 'applyset-someone-else-v1', 'kro.run/owned': 'true' },
        rgdName: 'rgd',
        consumers: [owner, other],
      })
    ).toThrow(/Ownership conflict/);
  });

  it('already-transferred (retention marker, not KRO-owned) → no strip', () => {
    const r = selectNamespaceOwnerAmongConsumers({
      nsName: 'shared',
      nsLabels: { [RETENTION]: 'true', 'app.kubernetes.io/managed-by': 'typekro' },
      rgdName: 'rgd',
      consumers: [owner, other],
    });
    expect(r.action).toBe('already-transferred');
  });

  it('fresh/user-managed (no KRO labels, no marker) → skip', () => {
    const r = selectNamespaceOwnerAmongConsumers({
      nsName: 'shared',
      nsLabels: {},
      rgdName: 'rgd',
      consumers: [owner, other],
    });
    expect(r.action).toBe('skip');
  });
});

// -----------------------------------------------------------------------------
// #6 — resource-derived SIBLING status fields survive hoisting.
// -----------------------------------------------------------------------------
describe('#6: sibling (resource-derived) status fields survive hoisting; only the namespace-name field becomes client-hydrated', () => {
  const compSchema = {
    name: 'round11-status',
    apiVersion: 'test.typekro.dev/v1alpha1',
    kind: 'Round11Status',
    spec: type({ name: 'string', namespace: 'string' }),
    status: type({ ready: 'boolean', nsName: 'string', phase: 'string' }),
  };

  function statusOf(rgdYaml: string): Record<string, unknown> {
    const rgd = yaml.load(rgdYaml) as { spec?: { schema?: { status?: Record<string, unknown> } } };
    return rgd.spec?.schema?.status ?? {};
  }

  it('FACTORY path: a resource-derived `phase` stays in the KRO status schema; the namespace-name `nsName` is dropped (client-hydrated)', () => {
    const comp = kubernetesComposition(compSchema, (spec) => {
      const ns = namespace({
        id: 'ownedNamespace',
        metadata: { name: Cel.expr(spec.namespace) as string },
      });
      const dep = Deployment({
        id: 'app',
        name: spec.name,
        image: 'nginx',
        namespace: Cel.expr(spec.namespace) as string,
      });
      return {
        ready: true,
        nsName: ns.metadata.name as unknown as string, // only refs the hoisted ns → client-hydrated
        phase: Cel.template('r-%s', dep.status.readyReplicas) as unknown as string, // resource-derived → survives
      };
    });
    const rgd = comp.factory('kro', { namespace: 'app' }).toYaml();
    expect(rgd).not.toContain('kind: Namespace'); // hoisted out
    const status = statusOf(rgd);
    // The SIBLING resource-derived field survived hoisting into the KRO status schema.
    expect(status.phase).toBeDefined();
    expect(String(status.phase)).toContain('app.status.readyReplicas');
    // The namespace-name field became a client-hydrated field (not in the KRO schema),
    // so it is NOT silently emitted as a broken/dangling KRO status expression.
    expect(status.nsName).toBeUndefined();
  });

  it('GRAPH path: same — `phase` survives, no dangling reference', () => {
    const graph = toResourceGraph(
      compSchema,
      (s: { spec: { namespace: unknown; name: unknown } }) => ({
        ownedNamespace: namespace({
          id: 'ownedNamespace',
          metadata: { name: Cel.expr(s.spec.namespace) as string },
        }),
        app: Deployment({
          id: 'app',
          name: s.spec.name as unknown as string,
          image: 'nginx',
          namespace: Cel.expr(s.spec.namespace) as string,
        }),
      }),
      (_s, r) => ({
        ready: true,
        nsName: r.ownedNamespace.metadata.name as unknown as string,
        phase: Cel.template('r-%s', r.app.status.readyReplicas) as unknown as string,
      })
    );
    const rgd = graph.toYaml();
    expect(rgd).not.toContain('kind: Namespace');
    const status = statusOf(rgd);
    expect(status.phase).toBeDefined();
    expect(String(status.phase)).toContain('app.status.readyReplicas');
  });
});
