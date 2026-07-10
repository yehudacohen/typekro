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
