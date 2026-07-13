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
    'prefix?': 'string',
    'create?': 'boolean',
  }),
  status: type({ ready: 'boolean' }),
};

describe('KRO instance namespace ownership safety', () => {
  it('auto-relocates a self-owned Namespace (name wrapped in Cel.expr) instead of throwing', () => {
    // The create-namespace-and-put-the-instance-in-it pattern: the composition
    // owns the same namespace the instance would land in. Detection (reused by
    // the guard) recognizes this and relocates the CR to `typekro-system` rather
    // than rejecting it — no flag needed.
    const composition = kubernetesComposition(schema, (spec) => {
      namespace({
        id: 'ownedNamespace',
        metadata: { name: Cel.expr(spec.namespace) as string },
      });
      return { ready: true };
    });
    const factory = composition.factory('kro', { namespace: 'danger' });

    expect(composition.toYaml()).toContain('${schema.spec.namespace}');
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'test', namespace: 'danger' });
    }).not.toThrow();
    expect(yaml).toContain('namespace: typekro-system');
    // The workload namespace is still owned/carried on the instance spec.
    expect(yaml).toMatch(/namespace: danger$/m);
  });

  it('evaluates computed schema-only CEL Namespace names before comparing ownership', () => {
    const composition = kubernetesComposition(schema, () => {
      namespace({
        id: 'computedNamespace',
        metadata: { name: Cel.expr('schema.spec.prefix + "-system"') as string },
      });
      return { ready: true };
    });

    expect(() =>
      composition
        .factory('kro', { namespace: 'foo-system' })
        .toYaml({ name: 'test', namespace: 'workloads', prefix: 'foo' })
    ).toThrow('cannot also be an owned Namespace');
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
        .toYaml({ name: 'test', namespace: 'workloads' })
    ).not.toThrow();
  });

  it('allows a Namespace disabled by withIncludeWhen(false)', () => {
    const composition = kubernetesComposition(schema, () => {
      namespace({ metadata: { name: 'control-plane' } }).withIncludeWhen(false);
      return { ready: true };
    });

    expect(() =>
      composition
        .factory('kro', { namespace: 'control-plane' })
        .toYaml({ name: 'test', namespace: 'workloads' })
    ).not.toThrow();
  });

  it('evaluates computed schema-only CEL includeWhen conditions', () => {
    const composition = kubernetesComposition(schema, () => {
      namespace({ metadata: { name: 'control-plane' } }).withIncludeWhen(
        Cel.expr('schema.spec.create == true')
      );
      return { ready: true };
    });
    const factory = composition.factory('kro', { namespace: 'control-plane' });

    expect(() =>
      factory.toYaml({ name: 'test', namespace: 'workloads', create: false })
    ).not.toThrow();
    expect(() => factory.toYaml({ name: 'test', namespace: 'workloads', create: true })).toThrow(
      'cannot also be an owned Namespace'
    );
  });

  it('uses only the concrete branch resources when conditional creation is false', () => {
    const composition = kubernetesComposition(schema, (spec) => {
      if (spec.create) {
        namespace({ metadata: { name: 'control-plane' } });
      }
      return { ready: true };
    });
    const factory = composition.factory('kro', { namespace: 'control-plane' });

    expect(() =>
      factory.toYaml({ name: 'test', namespace: 'workloads', create: false })
    ).not.toThrow();
    expect(() => factory.toYaml({ name: 'test', namespace: 'workloads', create: true })).toThrow(
      'cannot also be an owned Namespace'
    );
  });
});

describe('KRO instance namespace ownership: auto-relocation (single control-plane namespace)', () => {
  // A composition that creates + owns a Namespace equal to the workload namespace
  // (the create-namespace-and-put-the-instance-in-it pattern, as typekro's own
  // dagster/clickhouse/clickstack/valkey bootstraps do). No flag — the factory
  // AUTO-DETECTS self-ownership and relocates the instance CR.
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

  it('auto-relocates the CR to the single control-plane namespace (no throw, no flag)', () => {
    const factory = ownedNsComposition().factory('kro', { namespace: 'app' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'x', namespace: 'app' });
    }).not.toThrow();
    // The instance CR lands in the single, stable control-plane namespace...
    expect(yaml).toContain('namespace: typekro-system');
    // ...while the workload namespace is still carried on the instance spec.
    expect(yaml).toMatch(/namespace: app$/m);
    // ...and the control-plane namespace is emitted (deps-first, outside the graph).
    expect(yaml).toContain('typekro.io/kro-instance-namespace');

    // The RGD (namespace-less toYaml) still creates and owns the workload namespace.
    expect(ownedNsComposition().toYaml()).toContain('${schema.spec.namespace}');
  });

  it('auto-relocation is safe via toAlchemyResources too', async () => {
    const factory = ownedNsComposition().factory('kro', { namespace: 'app' });
    const decls = await factory.toAlchemyResources({ name: 'x', namespace: 'app' });
    // First declaration is the dedicated control-plane Namespace.
    const nsDecl = decls[0];
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('typekro-system');
    // The instance CR declaration is namespaced to the control-plane namespace.
    expect(decls.at(-1)?.props.namespace).toBe('typekro-system');
  });

  it('every workload namespace relocates to the SAME control-plane namespace (P1-a fixed structurally)', () => {
    // The old per-workload `<ns>-kro` model made a spec-less lifecycle resolve
    // diverge from the deploy-time namespace. A single constant removes that gap:
    // any workload namespace (even from a factory created with none) resolves to
    // the same `typekro-system`, never a stale `default-kro`.
    const factory = ownedNsComposition().factory('kro');
    const dev = factory.toYaml({ name: 'x', namespace: 'dev' });
    const prod = ownedNsComposition().factory('kro').toYaml({ name: 'x', namespace: 'prod' });
    expect(dev).toContain('namespace: typekro-system');
    expect(prod).toContain('namespace: typekro-system');
    expect(dev).not.toContain('namespace: dev-kro');
    expect(prod).not.toContain('namespace: default-kro');
  });

  it('explicit instanceNamespace overrides the auto-relocated default (and ignores spec)', () => {
    const factory = ownedNsComposition().factory('kro', {
      namespace: 'app',
      instanceNamespace: 'custom-control-plane',
    });
    const yaml = factory.toYaml({ name: 'x', namespace: 'app' });
    expect(yaml).toContain('namespace: custom-control-plane');
    expect(yaml).not.toContain('namespace: typekro-system');
    // Even with a different spec namespace, the explicit override still wins.
    const yaml2 = factory.toYaml({ name: 'x', namespace: 'other' });
    expect(yaml2).toContain('namespace: custom-control-plane');
  });

  it('an explicit instanceNamespace pinned to an owned namespace STILL throws (guard intact)', () => {
    // Opting the instance back into the owned namespace is the unsafe case that
    // relocation cannot cover — the guard must still reject it.
    const factory = ownedNsComposition().factory('kro', {
      namespace: 'app',
      instanceNamespace: 'app',
    });
    expect(() => factory.toYaml({ name: 'x', namespace: 'app' })).toThrow(
      'cannot also be an owned Namespace'
    );
  });
});
