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

  it('finding #3: an owned Namespace that is NOT the instance namespace is hoisted + RETAINED (shared)', () => {
    // The composition owns `spec.operatorNamespace`, but the instance lands in
    // `spec.namespace` — they differ. In the v2 model EVERY Namespace is hoisted out
    // of the RGD (typekro never emits a Namespace into RGD YAML). Because this one is
    // NOT the instance's own (1:1) namespace, it is emitted as a SHARED, retained
    // sibling — never auto-deleted on this instance's teardown.
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
    // The owned namespace IS hoisted (as a shared, retained sibling).
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
    // The RGD never owns a Namespace as a graph child.
    expect(composition.factory('kro', { namespace: 'app' }).toYaml()).not.toContain(
      'kind: Namespace'
    );
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

  it('hoists via toAlchemyResources too; the 1:1 namespace is NOT retained (teardown after RGD)', async () => {
    const factory = ownedNsComposition().factory('kro', { namespace: 'app' });
    const decls = await factory.toAlchemyResources({ name: 'x', namespace: 'app' });
    // First declaration is the hoisted workload Namespace.
    const nsDecl = decls[0];
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('app');
    // It is the instance's OWN (1:1) namespace (name == instance ns 'app'), so it is
    // NOT retained: reverse-topo teardown deletes it AFTER the RGD + instance.
    expect(nsDecl?.props.retain).toBeUndefined();
    const rgdDecl = decls.find(
      (declaration) => declaration.props.resource.kind === 'ResourceGraphDefinition'
    );
    expect(rgdDecl?.dependsOn).toContain(nsDecl?.id);
    expect(decls.at(-1)?.dependsOn).toContain(rgdDecl?.id);
    // The instance CR declaration stays in the workload namespace.
    expect(decls.at(-1)?.props.namespace).toBe('app');
  });

  it('finding #2: the CR lives in the FACTORY namespace; dev/prod separated by alchemy scope', async () => {
    // Per the maintainer's decision (finding #2), the CR lives in the FACTORY
    // namespace, so dev/prod are distinguished by a DIFFERENT factory namespace (not
    // by spec.namespace). The alchemy id is the LEGACY namespace-agnostic kind+name
    // (round-6 finding #1) — the two are separated by their alchemy SCOPE/STACK (the
    // different factory namespace), not by a per-CR namespace segment in the id.
    const dev = await ownedNsComposition()
      .factory('kro', { namespace: 'dev' })
      .toAlchemyResources({ name: 'x', namespace: 'dev' });
    const prod = await ownedNsComposition()
      .factory('kro', { namespace: 'prod' })
      .toAlchemyResources({ name: 'x', namespace: 'prod' });
    // The CR is placed in the FACTORY namespace in each case.
    expect(dev.at(-1)?.props.namespace).toBe('dev');
    expect(prod.at(-1)?.props.namespace).toBe('prod');
    // Namespace-agnostic id: same instance name → same id (dev/prod live in different
    // alchemy scopes, so this is not a collapse).
    expect(dev.at(-1)?.id).toBe(prod.at(-1)?.id as string);
  });

  it('explicit instanceNamespace overrides the natural placement (and ignores spec)', () => {
    const factory = ownedNsComposition().factory('kro', {
      namespace: 'app',
      instanceNamespace: 'custom-control-plane',
    });
    const yaml = factory.toYaml({ name: 'x', namespace: 'other' });
    expect(yaml).toContain('namespace: custom-control-plane');
    // The owned namespace ('other') is still hoisted — as a shared, retained sibling,
    // since it is not the instance's own namespace ('custom-control-plane').
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
  });

  it('an explicit instanceNamespace pinned to an owned namespace is SAFE (hoisted, not rejected)', () => {
    // In the v2 model the owned namespace is applied as a sibling created before the
    // RGD and deleted after it, so placing the instance inside its own owned namespace
    // no longer risks finalizer stranding — the guard passes (it now only fires for
    // hand-authored graphs that leave a Namespace inside the RGD).
    const factory = ownedNsComposition().factory('kro', {
      namespace: 'app',
      instanceNamespace: 'app',
    });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'x', namespace: 'app' });
    }).not.toThrow();
    // The instance's own (1:1) namespace is hoisted out of the RGD as a sibling, and
    // the instance CR still lands in it.
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
    expect(yaml).toMatch(/namespace: app$/m);
  });
});
