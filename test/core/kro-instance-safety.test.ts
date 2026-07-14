import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { externalRef } from '../../src/core/references/external-refs.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

const schema = {
  name: 'kro-namespace-safety',
  kind: 'KroNamespaceSafety',
  spec: type({
    name: 'string',
    namespace: 'string',
    'operatorNamespace?': 'string',
    'prefix?': 'string',
    'create?': 'boolean',
  }),
  status: type({ ready: 'boolean' }),
};

describe('KRO instance namespace ownership safety', () => {
  it('hoists a self-owned Namespace out of the graph instead of throwing', () => {
    // The create-namespace-and-put-the-instance-in-it pattern: the composition
    // owns the same namespace the instance lands in. Detection recognizes this and
    // HOISTS the Namespace out of the RGD graph (emitted retained, deps-first)
    // rather than rejecting it — the instance stays in its natural namespace.
    const composition = kubernetesComposition(schema, (spec) => {
      namespace({
        id: 'ownedNamespace',
        metadata: { name: Cel.expr(spec.namespace) as string },
      });
      return { ready: true };
    });
    const factory = composition.factory('kro', { namespace: 'danger' });

    // The RGD no longer OWNS the workload Namespace as a graph child (it is the
    // only resource here, so the graph is left empty).
    const rgd = composition.factory('kro', { namespace: 'danger' }).toYaml();
    expect(rgd).not.toContain('kind: Namespace');

    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'test', namespace: 'danger' });
    }).not.toThrow();
    // The instance CR stays in its natural workload namespace — never relocated.
    expect(yaml).toMatch(/namespace: danger$/m);
    expect(yaml).not.toContain('typekro-system');
    // The owned namespace is hoisted out of the graph and emitted retained.
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
  });

  it('fails closed when an active owned Namespace name cannot be concretized', () => {
    const composition = kubernetesComposition(schema, () => {
      namespace({
        id: 'runtimeNamespace',
        metadata: { name: Cel.expr('resources.config.metadata.name') as string },
      });
      return { ready: true };
    });

    expect(() =>
      composition
        .factory('kro', { namespace: 'control-plane' })
        .toYaml({ name: 'test', namespace: 'workloads' })
    ).toThrow('cannot be evaluated from the concrete spec');
  });

  it('finding #3: an owned Namespace that is NOT the instance namespace is left alone', () => {
    // The composition owns `spec.operatorNamespace`, but the instance lands in
    // `spec.namespace` — they differ, so the namespace is never the instance's own
    // and is left in the graph unchanged (not hoisted, no throw).
    const composition = kubernetesComposition(schema, (spec) => {
      namespace({
        id: 'operatorNamespace',
        metadata: { name: Cel.expr(spec.operatorNamespace) as string },
      });
      return { ready: true };
    });
    const factory = composition.factory('kro', { namespace: 'app' });

    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'test', namespace: 'app', operatorNamespace: 'op-system' });
    }).not.toThrow();
    // Instance stays in its natural namespace.
    expect(yaml).toMatch(/namespace: app$/m);
    // Nothing was hoisted (the owned namespace differs from the instance's).
    expect(yaml).not.toContain('typekro.io/kro-instance-namespace');
    // The owned namespace remains a graph child in the RGD.
    expect(composition.factory('kro', { namespace: 'app' }).toYaml()).toContain('kind: Namespace');
  });

  it('allows an externalRef to the instance Namespace because it is not owned', () => {
    const composition = kubernetesComposition(schema, () => {
      externalRef({
        id: 'observedNamespace',
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'control-plane' },
      });
      return { ready: true };
    });

    expect(() =>
      composition
        .factory('kro', { namespace: 'control-plane' })
        .toYaml({ name: 'test', namespace: 'control-plane' })
    ).not.toThrow();
  });

  it('allows a Namespace disabled by withIncludeWhen(false)', () => {
    const composition = kubernetesComposition(schema, () => {
      namespace({ metadata: { name: 'workloads' } }).withIncludeWhen(false);
      return { ready: true };
    });

    expect(() =>
      composition
        .factory('kro', { namespace: 'workloads' })
        .toYaml({ name: 'test', namespace: 'workloads' })
    ).not.toThrow();
  });

  it('finding #5: the owns-namespace decision is per-spec and order-independent', () => {
    // A conditionally-included namespace (named after the instance namespace) must
    // be decided from THIS spec, never a cached first-call result. Calling
    // false-then-true must match a fresh true-first factory.
    const makeComposition = () =>
      kubernetesComposition(schema, (spec) => {
        namespace({
          id: 'conditionalNamespace',
          metadata: { name: Cel.expr(spec.namespace) as string },
        }).withIncludeWhen(Cel.expr('schema.spec.create == true'));
        return { ready: true };
      });

    const falseThenTrue = makeComposition().factory('kro', { namespace: 'app' });
    const disabled = falseThenTrue.toYaml({ name: 'x', namespace: 'app', create: false });
    // create:false → namespace inactive → nothing hoisted.
    expect(disabled).not.toContain('typekro.io/kro-instance-namespace');

    const enabledAfter = falseThenTrue.toYaml({ name: 'x', namespace: 'app', create: true });
    const trueFirst = makeComposition()
      .factory('kro', { namespace: 'app' })
      .toYaml({ name: 'x', namespace: 'app', create: true });
    // create:true → namespace active + owned → hoisted; and NOT order-dependent.
    expect(enabledAfter).toContain('typekro.io/kro-instance-namespace');
    expect(enabledAfter).toBe(trueFirst);
  });
});

describe('KRO instance namespace ownership: hoisting keeps the instance in its natural namespace', () => {
  const ownedNsComposition = () =>
    kubernetesComposition(
      {
        name: 'owns-ns',
        kind: 'OwnsNs',
        spec: type({ name: 'string', namespace: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
        return { ready: true };
      }
    );

  it('leaves the CR in the workload namespace and hoists the owned Namespace (no throw)', () => {
    const factory = ownedNsComposition().factory('kro', { namespace: 'app' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'x', namespace: 'app' });
    }).not.toThrow();
    // The instance CR stays in the workload namespace...
    expect(yaml).toMatch(/namespace: app$/m);
    expect(yaml).not.toContain('typekro-system');
    // ...and the owned namespace is emitted (deps-first, outside the graph).
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
    // The RGD no longer owns the workload Namespace as a graph child (graph-level
    // `toYaml()` hoists it too, matching the factory path).
    const rgd = ownedNsComposition().toYaml();
    expect(rgd).not.toContain('kind: Namespace');
  });

  it('hoists + retains via toAlchemyResources too (instance in the workload namespace)', async () => {
    const factory = ownedNsComposition().factory('kro', { namespace: 'app' });
    const decls = await factory.toAlchemyResources({ name: 'x', namespace: 'app' });
    // First declaration is the retained workload Namespace.
    const nsDecl = decls[0];
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('app');
    expect(nsDecl?.props.retain).toBe(true);
    // The instance CR declaration stays in the workload namespace.
    expect(decls.at(-1)?.props.namespace).toBe('app');
  });

  it('finding #2: same name in distinct FACTORY namespaces → distinct instance identities', async () => {
    // Per the maintainer's decision (finding #2), the CR lives in the FACTORY
    // namespace, so dev/prod are distinguished by a DIFFERENT factory namespace (not
    // by spec.namespace). The alchemy id is qualified by the resolved (factory)
    // namespace, so the two never collapse.
    const dev = await ownedNsComposition()
      .factory('kro', { namespace: 'dev' })
      .toAlchemyResources({ name: 'x', namespace: 'dev' });
    const prod = await ownedNsComposition()
      .factory('kro', { namespace: 'prod' })
      .toAlchemyResources({ name: 'x', namespace: 'prod' });
    expect(dev.at(-1)?.props.namespace).toBe('dev');
    expect(prod.at(-1)?.props.namespace).toBe('prod');
    expect(dev.at(-1)?.id).not.toBe(prod.at(-1)?.id as string);
  });

  it('explicit instanceNamespace overrides the natural placement (and ignores spec)', () => {
    const factory = ownedNsComposition().factory('kro', {
      namespace: 'app',
      instanceNamespace: 'custom-control-plane',
    });
    const yaml = factory.toYaml({ name: 'x', namespace: 'other' });
    expect(yaml).toContain('namespace: custom-control-plane');
    // An explicit pin opts out of auto-hoisting; the owned namespace is not the
    // instance's namespace here ('other' != 'custom-control-plane'), so it is safe.
    expect(yaml).not.toContain('typekro.io/kro-instance-namespace');
  });

  it('an explicit instanceNamespace pinned to an owned namespace STILL throws (guard intact)', () => {
    // Opting the instance back into the owned namespace is the unsafe case that
    // hoisting deliberately does NOT cover — the guard must still reject it.
    const factory = ownedNsComposition().factory('kro', {
      namespace: 'app',
      instanceNamespace: 'app',
    });
    expect(() => factory.toYaml({ name: 'x', namespace: 'app' })).toThrow(
      'cannot also be an owned Namespace'
    );
  });
});
