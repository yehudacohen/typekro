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
  it('rejects a self-owned Namespace whose name is wrapped in Cel.expr', () => {
    const composition = kubernetesComposition(schema, (spec) => {
      namespace({
        id: 'ownedNamespace',
        metadata: { name: Cel.expr(spec.namespace) as string },
      });
      return { ready: true };
    });
    const factory = composition.factory('kro', { namespace: 'danger' });

    expect(composition.toYaml()).toContain('${schema.spec.namespace}');
    expect(() => factory.toYaml({ name: 'test', namespace: 'danger' })).toThrow(
      'cannot also be an owned Namespace'
    );
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

describe('KRO instance namespace ownership: safe-by-construction mitigation', () => {
  // A composition that creates + owns a Namespace equal to the workload namespace
  // (the create-namespace-and-put-the-instance-in-it pattern, as typekro's own
  // dagster/clickhouse/clickstack/valkey bootstraps do).
  const ownedNsComposition = (extra?: { ownsInstanceNamespace?: boolean }) =>
    kubernetesComposition(
      {
        name: 'owns-ns',
        kind: 'OwnsNs',
        spec: type({ name: 'string', namespace: 'string' }),
        status: type({ ready: 'boolean' }),
        ...(extra ?? {}),
      },
      (spec) => {
        namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
        return { ready: true };
      }
    );

  it('still THROWS for a self-owned instance namespace with no mitigation', () => {
    const factory = ownedNsComposition().factory('kro', { namespace: 'app' });
    expect(() => factory.toYaml({ name: 'x', namespace: 'app' })).toThrow(
      'cannot also be an owned Namespace'
    );
  });

  it('ownsInstanceNamespace places the CR in a derived control-plane namespace (no throw)', () => {
    const factory = ownedNsComposition({ ownsInstanceNamespace: true }).factory('kro', {
      namespace: 'app',
    });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'x', namespace: 'app' });
    }).not.toThrow();
    // The instance CR lands in the derived control-plane namespace...
    expect(yaml).toContain('namespace: app-kro');
    // ...while the workload namespace is still carried on the instance spec.
    expect(yaml).toMatch(/namespace: app$/m);
    // ...and the control-plane namespace is emitted (deps-first, outside the graph).
    expect(yaml).toContain('typekro.io/kro-instance-namespace');

    // The RGD (namespace-less toYaml) still creates and owns the workload namespace.
    const rgdYaml = ownedNsComposition({ ownsInstanceNamespace: true }).toYaml();
    expect(rgdYaml).toContain('${schema.spec.namespace}');
  });

  it('ownsInstanceNamespace is safe via toAlchemyResources too', async () => {
    const factory = ownedNsComposition({ ownsInstanceNamespace: true }).factory('kro', {
      namespace: 'app',
    });
    const decls = await factory.toAlchemyResources({ name: 'x', namespace: 'app' });
    // First declaration is the dedicated control-plane Namespace.
    const nsDecl = decls[0];
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('app-kro');
    // The instance CR declaration is namespaced to the control-plane namespace.
    const instanceDecl = decls.at(-1);
    expect(instanceDecl?.props.namespace).toBe('app-kro');
  });

  it('explicit instanceNamespace overrides the derived default', () => {
    const factory = ownedNsComposition({ ownsInstanceNamespace: true }).factory('kro', {
      namespace: 'app',
      instanceNamespace: 'typekro-system',
    });
    const yaml = factory.toYaml({ name: 'x', namespace: 'app' });
    expect(yaml).toContain('namespace: typekro-system');
  });

  it('an explicit instanceNamespace equal to an owned namespace STILL throws', () => {
    // Opting the instance back into the owned namespace is the unsafe case.
    const factory = ownedNsComposition({ ownsInstanceNamespace: true }).factory('kro', {
      namespace: 'app',
      instanceNamespace: 'app',
    });
    expect(() => factory.toYaml({ name: 'x', namespace: 'app' })).toThrow(
      'cannot also be an owned Namespace'
    );
  });
});
