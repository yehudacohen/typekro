import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import {
  HOISTED_NAMESPACES_ANNOTATION,
  readHoistedNamespacesRecord,
} from '../../src/core/deployment/kro-namespace-teardown.js';
import { Cel } from '../../src/core/references/cel.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';
import { createMockKubeConfig } from '../utils/mock-factories.js';

/**
 * DETERMINISTIC, OFFLINE proof of the PR #113 "empty-record" P1: the v7 tightened pre-hoist
 * guard must NOT mistake an ordinary composition for a genuinely-legacy instance. Root cause:
 * CR creation OMITTED the `typekro.io/hoisted-namespaces` annotation when the resolved set was
 * empty, and the guard treated every missing/parsed-empty record as unsafe → a 2nd deploy of a
 * namespace-less (or includeWhen:false) composition threw PRE_HOIST_LEGACY_INSTANCE_UNRESOLVABLE.
 *
 * Fix: (a) ALWAYS record the array — including [] — so valid-empty is distinguishable from
 * missing/malformed; (b) the guard distinguishes present (incl. []) from missing/malformed; and
 * (c) the guard SHORT-CIRCUITS when the RGD structurally hoists no namespace.
 */

type Rec = Record<string, unknown>;
const Spec = type({ name: 'string', namespace: 'string' });
const Status = type({ ready: 'boolean' });

function priv(target: unknown, method: string): (...args: unknown[]) => unknown {
  const fn = (target as Record<string, (...args: unknown[]) => unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`missing private method ${method}`);
  return fn.bind(target);
}

/** A namespace-less composition — declares NO Namespace resource, so it hoists nothing. */
function makeNoNsFactory(name: string) {
  const composition = kubernetesComposition(
    { name, kind: 'NoNsGate', spec: Spec, status: Status },
    (_spec) => ({ ready: true })
  );
  return composition.factory('kro', {
    namespace: 'app-ns',
    timeout: 250,
    kubeConfig: createMockKubeConfig(),
  });
}

/** A self-owning composition (creates + owns a Namespace named after spec.namespace). */
function makeNsFactory(name: string, workloadNs: string) {
  const composition = kubernetesComposition(
    { name, kind: 'NsGate', spec: Spec, status: Status },
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

describe('readHoistedNamespacesRecord distinguishes present / missing / malformed', () => {
  it('a valid empty [] is PRESENT (not missing); undefined/blank is MISSING; non-array is MALFORMED', () => {
    expect(readHoistedNamespacesRecord('[]')).toEqual({ status: 'present', names: [] });
    expect(readHoistedNamespacesRecord('["a","b"]')).toEqual({
      status: 'present',
      names: ['a', 'b'],
    });
    expect(readHoistedNamespacesRecord(undefined)).toEqual({ status: 'missing' });
    expect(readHoistedNamespacesRecord('   ')).toEqual({ status: 'missing' });
    expect(readHoistedNamespacesRecord('not-json')).toEqual({ status: 'malformed' });
    expect(readHoistedNamespacesRecord('{"a":1}')).toEqual({ status: 'malformed' });
  });

  it('rejects the WHOLE array as malformed if ANY element is not a non-empty string (no silent junk-filtering)', () => {
    // These must NOT masquerade as a valid empty record — they would let the guard proceed
    // without protecting the intended namespace.
    expect(readHoistedNamespacesRecord('[42]')).toEqual({ status: 'malformed' });
    expect(readHoistedNamespacesRecord('[""]')).toEqual({ status: 'malformed' });
    expect(readHoistedNamespacesRecord('["ok", 42]')).toEqual({ status: 'malformed' });
    expect(readHoistedNamespacesRecord('["ok", ""]')).toEqual({ status: 'malformed' });
  });
});

describe('CR creation ALWAYS records the hoisted-namespaces array (including [])', () => {
  it('a namespace-less composition stamps hoisted-namespaces = "[]" (not omitted)', () => {
    const factory = makeNoNsFactory('v8-record-empty');
    const cr = priv(factory, 'createCustomResourceInstance')('inst', {
      name: 'inst',
      namespace: 'app-ns',
    }) as { metadata?: { annotations?: Record<string, string> } };
    expect(cr.metadata?.annotations?.[HOISTED_NAMESPACES_ANNOTATION]).toBe('[]');
  });
});

describe('pre-hoist guard does NOT mistake an ordinary/empty-record composition for legacy', () => {
  it('SHORT-CIRCUITS when the RGD structurally hoists no namespace (no throw even with an unannotated instance)', async () => {
    const factory = makeNoNsFactory('v8-shortcircuit');
    // Stub discovery/list to a state that WOULD fail closed (an unannotated instance) — proving
    // the structural short-circuit returns BEFORE the guard ever reaches that path.
    const rec = factory as unknown as Rec;
    rec.discoverGeneratedCrdPlural = async () => ({ present: true, plural: 'nonsgates' });
    rec.createCustomObjectsApi = async () => ({
      listClusterCustomObject: async () => ({ items: [{ spec: { name: 'x', namespace: 'x-ns' } }] }),
    });
    const fn = priv(factory, 'existingInstancesHoistedNamespaceNames') as () => Promise<Set<string>>;
    const result = await fn();
    expect(result.size).toBe(0); // short-circuited; did not throw
  });

  it('a valid EMPTY [] record resolves as PRESENT (safe) — the includeWhen:false / no-hoist case does not fail closed', async () => {
    const factory = makeNsFactory('v8-empty-record', 'app-ns');
    const rec = factory as unknown as Rec;
    rec.discoverGeneratedCrdPlural = async () => ({ present: true, plural: 'nsgates' });
    rec.createCustomObjectsApi = async () => ({
      listClusterCustomObject: async () => ({
        items: [{ metadata: { annotations: { [HOISTED_NAMESPACES_ANNOTATION]: '[]' } } }],
      }),
    });
    rec.createKubernetesObjectApi = () => ({
      list: async () => ({ items: [], metadata: {} }),
    });
    const fn = priv(factory, 'existingInstancesHoistedNamespaceNames') as () => Promise<Set<string>>;
    const result = await fn(); // must NOT throw
    expect(result.size).toBe(0);
  });

  it('STILL fails closed for a genuinely-legacy (missing-annotation) instance of a hoisting RGD', async () => {
    const factory = makeNsFactory('v8-legacy-still-closed', 'app-ns');
    const rec = factory as unknown as Rec;
    rec.discoverGeneratedCrdPlural = async () => ({ present: true, plural: 'nsgates' });
    rec.createCustomObjectsApi = async () => ({
      listClusterCustomObject: async () => ({
        items: [{ spec: { name: 'legacy', namespace: 'legacy-ns' } }], // no annotation → missing
      }),
    });
    rec.createKubernetesObjectApi = () => ({
      list: async () => ({ items: [], metadata: {} }),
    });
    const fn = priv(factory, 'existingInstancesHoistedNamespaceNames');
    await expect(fn()).rejects.toThrow(
      /PRE_HOIST_LEGACY_INSTANCE_UNRESOLVABLE|no per-instance namespace record/
    );
  });
});
