import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import {
  hoistWeakenedStatusFields,
  resolveConcreteMetadataValue,
} from '../../src/core/deployment/kro-instance-safety.js';
import {
  classifyNamespaceEmptiness,
  deleteNamespaceIfEmpty,
  isAutoProvisionedDefault,
  type NamespaceInventory,
  type NamespacedResourceType,
} from '../../src/core/deployment/kro-namespace-teardown.js';
import { Cel } from '../../src/core/references/cel.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

/**
 * OFFLINE unit coverage for the PR #113 v2 fix round:
 *  - #3 + #4: the emptiness-gated namespace teardown (delete-if-empty / retain-if-occupied,
 *    fail-safe on any uncertainty), replacing marker + name-equality ownership.
 *  - #5: the general concrete-value resolver for namespace metadata (no DNS-label restriction).
 *  - #6: the consistent REJECT of a status field that resolves ONLY to a hoisted Namespace's
 *    name — for BOTH a schema-named and a literally-named Namespace.
 *
 * The create/delete ORDER on a real cluster is proven by the maintainer on OrbStack via
 * test/integration/kro-namespace-sibling-lifecycle.test.ts (WRITTEN + gated, NOT run here).
 */

const cel = (expression: string) =>
  ({ [CEL_EXPRESSION_BRAND]: true, expression }) as unknown as { expression: string };

const kref = (resourceId: string, fieldPath: string) =>
  ({ [KUBERNETES_REF_BRAND]: true, resourceId, fieldPath }) as unknown;

function priv(target: unknown, method: string): (...args: unknown[]) => unknown {
  const fn = (target as Record<string, (...args: unknown[]) => unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`missing private method ${method}`);
  return fn.bind(target);
}

// ---------------------------------------------------------------------------
// #2 — fail-closed PRE-HOIST detection on deploy (detection only, no migration).
// ---------------------------------------------------------------------------
describe('#2: assertNoPreHoistNamespaceConflict fails closed on a KRO-owned namespace', () => {
  const schema = {
    name: 'prehoist2',
    kind: 'PreHoist2',
    spec: type({ name: 'string', namespace: 'string' }),
    status: type({ ready: 'boolean' }),
  };
  const ownsNs = () =>
    kubernetesComposition(schema, (spec) => {
      namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
      return { ready: true };
    });

  const withMockedRead = (
    factory: unknown,
    read: () => Promise<unknown>
  ): ((...a: unknown[]) => unknown) => {
    (factory as Record<string, unknown>).createKubernetesObjectApi = () => ({
      read,
      delete: async () => ({}),
    });
    return priv(factory, 'assertNoPreHoistNamespaceConflict');
  };

  it('THROWS when a to-be-hoisted namespace carries applyset.kubernetes.io/part-of', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const assertFn = withMockedRead(factory, async () => ({
      metadata: { labels: { 'applyset.kubernetes.io/part-of': 'app.kro' } },
    }));
    await expect(assertFn(['app'])).rejects.toThrow(/Pre-hoist deployment detected/);
  });

  it('THROWS when a to-be-hoisted namespace carries a kro.run/* ownership label', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const assertFn = withMockedRead(factory, async () => ({
      metadata: { labels: { 'kro.run/owned': 'true' } },
    }));
    await expect(assertFn(['app'])).rejects.toThrow(/PRE_HOIST_NAMESPACE_CONFLICT|Pre-hoist/);
  });

  it('does NOT throw for a typekro v2 sibling namespace (marker only, no KRO ownership)', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const assertFn = withMockedRead(factory, async () => ({
      metadata: { labels: { 'typekro.io/kro-instance-namespace': 'true' } },
    }));
    await expect(assertFn(['app'])).resolves.toBeUndefined();
  });

  it('does NOT throw when the namespace is fresh (404)', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const assertFn = withMockedRead(factory, async () => {
      const err = new Error('nf') as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    });
    await expect(assertFn(['app'])).resolves.toBeUndefined();
  });

  it('does NOT block the deploy on a transient (non-404) read error', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const assertFn = withMockedRead(factory, async () => {
      const err = new Error('boom') as Error & { statusCode?: number };
      err.statusCode = 500;
      throw err;
    });
    await expect(assertFn(['app'])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #5 — general concrete-value resolver for namespace metadata values.
// ---------------------------------------------------------------------------
describe('#5: resolveConcreteMetadataValue resolves ANY concrete string (no DNS-label restriction)', () => {
  const spec = { name: 'x', namespace: 'app', team: 'data-platform' };

  it('keeps a plain-string label value verbatim, including non-DNS shapes', () => {
    // `Team_A` (uppercase + underscore) and free text with spaces are valid metadata
    // values but NOT DNS labels — the old resolver silently dropped them.
    expect(resolveConcreteMetadataValue('Team_A', spec)).toBe('Team_A');
    expect(resolveConcreteMetadataValue('owned by the data team', spec)).toBe(
      'owned by the data team'
    );
  });

  it('returns a concrete CEL BODY verbatim for non-DNS literals (Team_A, spaces)', () => {
    // A concrete re-execution collapses the value into a CEL whose body is the resolved
    // literal — it must survive, not be fed to the CEL evaluator.
    expect(resolveConcreteMetadataValue(cel('Team_A'), spec)).toBe('Team_A');
    expect(resolveConcreteMetadataValue(cel('some text with spaces'), spec)).toBe(
      'some text with spaces'
    );
  });

  it('does NOT mis-parse a hyphenated literal as CEL subtraction', () => {
    // Regression: `data-platform` must not be evaluated as `data - platform` → NaN.
    expect(resolveConcreteMetadataValue(cel('data-platform'), spec)).toBe('data-platform');
  });

  it('still evaluates a genuine schema expression against the spec', () => {
    expect(resolveConcreteMetadataValue(cel('spec.team'), spec)).toBe('data-platform');
    expect(resolveConcreteMetadataValue(cel('schema.spec.team'), spec)).toBe('data-platform');
    expect(resolveConcreteMetadataValue(kref('__schema__', 'spec.team'), spec)).toBe(
      'data-platform'
    );
  });

  it('stringifies non-string primitives (numbers/booleans), never dropping them', () => {
    expect(resolveConcreteMetadataValue(3, spec)).toBe('3');
    expect(resolveConcreteMetadataValue(true, spec)).toBe('true');
  });
});

describe('#5: metadata values with non-DNS shapes survive into the emitted Namespace', () => {
  const schema = {
    name: 'meta5',
    kind: 'Meta5',
    spec: type({ name: 'string', namespace: 'string', team: 'string' }),
    status: type({ ready: 'boolean' }),
  };

  it('toYaml keeps Team_A + spaced annotation on the hoisted sibling Namespace', () => {
    const composition = kubernetesComposition(schema, (spec) => {
      namespace({
        id: 'ownedNamespace',
        metadata: {
          name: Cel.expr(spec.namespace) as string,
          labels: { team: 'Team_A' },
          annotations: { note: 'owned by the data team' },
        },
      });
      return { ready: true };
    });
    const yaml = composition
      .factory('kro', { namespace: 'app' })
      .toYaml({ name: 'x', namespace: 'app', team: 'data' });
    const nsDoc =
      yaml
        .split(/^---$/m)
        .map((d) => d.trim())
        .find((d) => /^kind: Namespace$/m.test(d)) ?? '';
    expect(nsDoc).toContain('team: Team_A');
    expect(nsDoc).toContain('note: owned by the data team');
  });
});

// ---------------------------------------------------------------------------
// #6 — consistent REJECT of a status field resolving ONLY to a hoisted Namespace.
// ---------------------------------------------------------------------------
describe('#6: hoistWeakenedStatusFields rejects BOTH schema-named and literal-named owned-ns status', () => {
  it('flags a status field that rewrites to a schema-only expression', () => {
    const hoisted = new Map<string, unknown>([['ownedNamespace', kref('__schema__', 'spec.namespace')]]);
    const status = { ready: true, nsName: kref('ownedNamespace', 'metadata.name') };
    expect(hoistWeakenedStatusFields(status, hoisted)).toEqual(['nsName']);
  });

  it('ALSO flags a status field that rewrites to a bare CONSTANT (literally-named ns)', () => {
    // The previously-silent case: a literally-named Namespace rewrites the field to a
    // constant, which KRO rejects (no resource dep) and typekro would drop as static.
    const hoisted = new Map<string, unknown>([['monitoringNs', 'monitoring']]);
    const status = { ready: true, nsName: kref('monitoringNs', 'metadata.name') };
    expect(hoistWeakenedStatusFields(status, hoisted)).toEqual(['nsName']);
  });

  it('does NOT flag a status field that also references a real managed resource', () => {
    // References the hoisted ns AND a managed resource → still has a resource dep, so KRO
    // accepts it (a literal inside the expression is fine); NOT weakened.
    const hoisted = new Map<string, unknown>([['monitoringNs', 'monitoring']]);
    const status = {
      ready: true,
      url: cel('deployment.status.podIP + "." + monitoringNs.metadata.name'),
    };
    expect(hoistWeakenedStatusFields(status, hoisted)).toEqual([]);
  });

  it('does NOT flag a field that never referenced the hoisted namespace', () => {
    const hoisted = new Map<string, unknown>([['ownedNamespace', kref('__schema__', 'spec.namespace')]]);
    const status = { ready: true, host: cel('service.status.loadBalancer') };
    expect(hoistWeakenedStatusFields(status, hoisted)).toEqual([]);
  });
});

// Note on the literal case at the toYaml level: accessing `ns.metadata.name` on a
// LITERALLY-named Namespace via the Enhanced proxy collapses to a build-time CONSTANT
// (not a KubernetesRef), so such a status field is a normal static constant that KRO
// serialization drops as static (the intentional client-hydration behavior), not the
// hoist-ref path. The #6 concern is a REFERENCE to the hoisted Namespace resource that
// `rewriteHoistedNamespaceRefsInValue` turns into a constant — exercised directly by the
// hoistWeakenedStatusFields unit tests above (schema-only AND constant both rejected).

// ---------------------------------------------------------------------------
// #3 + #4 — emptiness-gated namespace teardown.
// ---------------------------------------------------------------------------
const SA: NamespacedResourceType = { apiVersion: 'v1', kind: 'ServiceAccount' };
const CM: NamespacedResourceType = { apiVersion: 'v1', kind: 'ConfigMap' };
const SECRET: NamespacedResourceType = { apiVersion: 'v1', kind: 'Secret' };
const DEPLOY: NamespacedResourceType = { apiVersion: 'apps/v1', kind: 'Deployment' };

/** Inventory backed by a fixed map of type-key → object names. */
function fakeInventory(
  types: NamespacedResourceType[],
  objectsByKind: Record<string, string[]>,
  opts: { discoverThrows?: boolean; listThrowsFor?: string } = {}
): NamespaceInventory {
  return {
    async discoverNamespacedTypes() {
      if (opts.discoverThrows) throw new Error('discovery boom');
      return types;
    },
    async listObjectNames(t) {
      if (opts.listThrowsFor === t.kind) throw new Error(`list ${t.kind} boom`);
      return objectsByKind[t.kind] ?? [];
    },
  };
}

describe('#3+#4: isAutoProvisionedDefault recognizes only the k8s defaults', () => {
  it('treats the default SA, kube-root-ca.crt CM, and default-token secrets as defaults', () => {
    expect(isAutoProvisionedDefault('ServiceAccount', 'default')).toBe(true);
    expect(isAutoProvisionedDefault('ConfigMap', 'kube-root-ca.crt')).toBe(true);
    expect(isAutoProvisionedDefault('Secret', 'default-token-abcde')).toBe(true);
  });

  it('treats a user/stack object as an occupant', () => {
    expect(isAutoProvisionedDefault('ServiceAccount', 'my-sa')).toBe(false);
    expect(isAutoProvisionedDefault('ConfigMap', 'app-config')).toBe(false);
    expect(isAutoProvisionedDefault('Deployment', 'web')).toBe(false);
  });
});

describe('#3+#4: classifyNamespaceEmptiness', () => {
  it('EMPTY when only k8s auto-provisioned defaults are present', async () => {
    const inv = fakeInventory([SA, CM, SECRET, DEPLOY], {
      ServiceAccount: ['default'],
      ConfigMap: ['kube-root-ca.crt'],
      Secret: ['default-token-xyz'],
      Deployment: [],
    });
    expect(await classifyNamespaceEmptiness(inv, 'ns')).toEqual({ empty: true });
  });

  it('OCCUPIED when a non-default resource is present (another stack)', async () => {
    const inv = fakeInventory([SA, CM, DEPLOY], {
      ServiceAccount: ['default'],
      ConfigMap: ['kube-root-ca.crt'],
      Deployment: ['web'],
    });
    const verdict = await classifyNamespaceEmptiness(inv, 'ns');
    expect(verdict.empty).toBe(false);
    if (!verdict.empty) expect(verdict.reason).toMatch(/Deployment "web"/);
  });

  it('FAIL-SAFE (retain) when discovery throws', async () => {
    const inv = fakeInventory([], {}, { discoverThrows: true });
    const verdict = await classifyNamespaceEmptiness(inv, 'ns');
    expect(verdict.empty).toBe(false);
    if (!verdict.empty) expect(verdict.reason).toMatch(/discovery/i);
  });

  it('FAIL-SAFE (retain) when a per-type list throws', async () => {
    const inv = fakeInventory([SA, DEPLOY], { ServiceAccount: ['default'] }, { listThrowsFor: 'Deployment' });
    const verdict = await classifyNamespaceEmptiness(inv, 'ns');
    expect(verdict.empty).toBe(false);
    if (!verdict.empty) expect(verdict.reason).toMatch(/could not list/i);
  });
});

describe('#3+#4: deleteNamespaceIfEmpty gates the actual delete', () => {
  const makeK8sApi = (nsExists: boolean) => {
    const deletes: string[] = [];
    const api = {
      read: async () => {
        if (nsExists) return { metadata: { name: 'ns' } };
        const err = new Error('nf') as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      },
      delete: async (obj: { metadata?: { name?: string } }) => {
        deletes.push(obj.metadata?.name ?? '?');
        return {};
      },
    };
    return { api, deletes };
  };

  it('DELETES an empty namespace', async () => {
    const { api, deletes } = makeK8sApi(true);
    await deleteNamespaceIfEmpty({} as never, 'ns', {
      k8sApi: api as never,
      inventory: fakeInventory([SA, CM], {
        ServiceAccount: ['default'],
        ConfigMap: ['kube-root-ca.crt'],
      }),
    });
    expect(deletes).toEqual(['ns']);
  });

  it('RETAINS an occupied namespace (does not delete)', async () => {
    const { api, deletes } = makeK8sApi(true);
    await deleteNamespaceIfEmpty({} as never, 'ns', {
      k8sApi: api as never,
      inventory: fakeInventory([DEPLOY], { Deployment: ['web'] }),
    });
    expect(deletes).toEqual([]);
  });

  it('is a no-op when the namespace is already gone (404) — no discovery', async () => {
    const { api, deletes } = makeK8sApi(false);
    let discovered = false;
    const inv: NamespaceInventory = {
      async discoverNamespacedTypes() {
        discovered = true;
        return [];
      },
      async listObjectNames() {
        return [];
      },
    };
    await deleteNamespaceIfEmpty({} as never, 'ns', { k8sApi: api as never, inventory: inv });
    expect(deletes).toEqual([]);
    expect(discovered).toBe(false);
  });

  it('RETAINS on discovery failure (fail-safe)', async () => {
    const { api, deletes } = makeK8sApi(true);
    await deleteNamespaceIfEmpty({} as never, 'ns', {
      k8sApi: api as never,
      inventory: fakeInventory([], {}, { discoverThrows: true }),
    });
    expect(deletes).toEqual([]);
  });
});
