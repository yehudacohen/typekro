import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition, simple } from '../../src/index.js';
import type { CallableComposition, NestedCompositionResource } from '../../src/core/types/deployment.js';

interface SingletonHandleLike<TSpec, TStatus> extends NestedCompositionResource<TSpec, TStatus> {
  readonly __singletonId: string;
  readonly __singletonKey: string;
}

interface SingletonApi {
  <TSpec, TStatus>(
    composition: CallableComposition<TSpec, TStatus>,
    input: { id: string; spec: TSpec },
  ): SingletonHandleLike<TSpec, TStatus>;
  use<TSpec, TStatus>(
    composition: CallableComposition<TSpec, TStatus>,
    id: string,
  ): SingletonHandleLike<TSpec, TStatus>;
}

function createOperatorComposition() {
  const OperatorSpec = type({
    name: 'string',
    namespace: 'string',
  });

  const OperatorStatus = type({
    ready: 'boolean',
    serviceName: 'string',
  });

  return kubernetesComposition(
    {
      name: 'operator-bootstrap',
      apiVersion: 'platform.typekro.test/v1alpha1',
      kind: 'OperatorBootstrap',
      spec: OperatorSpec,
      status: OperatorStatus,
    },
    (spec) => {
      const deployment = simple.Deployment({
        name: spec.name,
        image: 'nginx',
        id: 'operatorDeployment',
      });

      return {
        ready: deployment.status.readyReplicas >= 1,
        serviceName: `${spec.name}.${spec.namespace}.svc.cluster.local`,
      };
    },
  );
}

describe('singleton API', () => {
  it('creates a typed singleton handle from a callable composition', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operator = createOperatorComposition();

    const result = singleton(operator, {
      id: 'platform-operator',
      spec: { name: 'cnpg-operator', namespace: 'cnpg-system' },
    });

    expect(result.__singletonId).toBe('platform-operator');
    expect(result.__singletonKey).toContain('platform-operator');
    expect(result.spec).toEqual({ name: 'cnpg-operator', namespace: 'cnpg-system' });
    expect(result.status.ready).toBeDefined();
    expect(result.status.serviceName).toBeDefined();
  });

  it('exposes singleton.use() for cross-composition consumption', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operator = createOperatorComposition();

    const result = singleton.use(operator, 'platform-operator');

    expect(result.__singletonId).toBe('platform-operator');
    expect(result.__singletonKey).toContain('platform-operator');
    expect(result.status.ready).toBeDefined();
    expect(result.status.serviceName).toBeDefined();
  });

  it('uses factory type plus id as singleton identity', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operatorA = createOperatorComposition();

    const OperatorSpec = type({ name: 'string' });
    const OperatorStatus = type({ ready: 'boolean' });
    const operatorB = kubernetesComposition(
      {
        name: 'other-bootstrap',
        apiVersion: 'platform.typekro.test/v1alpha1',
        kind: 'OtherBootstrap',
        spec: OperatorSpec,
        status: OperatorStatus,
      },
      (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: 'nginx',
          id: 'otherDeployment',
        });

        return { ready: deployment.status.readyReplicas >= 1 };
      },
    );

    const a = singleton(operatorA, {
      id: 'platform',
      spec: { name: 'cnpg-operator', namespace: 'cnpg-system' },
    });
    const b = singleton(operatorB, {
      id: 'platform',
      spec: { name: 'other-operator' },
    });

    expect(a.__singletonKey).not.toBe(b.__singletonKey);
  });

  it('rejects config drift for the same singleton identity', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operator = createOperatorComposition();

    singleton(operator, {
      id: 'platform-operator',
      spec: { name: 'cnpg-operator', namespace: 'cnpg-system' },
    });

    expect(() => {
      singleton(operator, {
        id: 'platform-operator',
        spec: { name: 'cnpg-operator-v2', namespace: 'cnpg-system' },
      });
    }).toThrow(/singleton/i);
  });
});
