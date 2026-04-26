import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { createCompositionContext, runWithCompositionContext } from '../../src/core/composition/context.js';
import { kubernetesComposition, simple } from '../../src/index.js';
import type {
  CallableComposition,
  SingletonHandle,
  SingletonOwnedHandle,
  SingletonReferenceHandle,
} from '../../src/core/types/deployment.js';
import type { KroCompatibleType } from '../../src/core/types/serialization.js';

interface SingletonApi {
  <TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
    composition: CallableComposition<TSpec, TStatus>,
    input: { id: string; spec: TSpec },
  ): SingletonHandle<TSpec, TStatus>;
  use<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
    composition: CallableComposition<TSpec, TStatus>,
    id: string,
  ): SingletonReferenceHandle<TStatus>;
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
    }) as SingletonOwnedHandle<{ name: string; namespace: string }, { ready: boolean; serviceName: string }>;

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
    expect(result.kind).toBe('singleton-reference');
    expect(result.status.ready).toBeDefined();
    expect(result.status.serviceName).toBeDefined();
  });

  it('singleton.use() does not pretend to expose a real spec surface', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operator = createOperatorComposition();

    const result = singleton.use(operator, 'platform-operator') as unknown as Record<string, unknown>;

    expect('spec' in result).toBe(false);
  });

  it('singleton references do not expose dependsOn()', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operator = createOperatorComposition();

    const result = singleton.use(operator, 'platform-operator') as unknown as Record<string, unknown>;

    expect('dependsOn' in result).toBe(false);
  });

  it('Enhanced.dependsOn() rejects singleton reference handles loudly', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operator = createOperatorComposition();
    const app = simple.Deployment({
      name: 'app',
      image: 'nginx',
      id: 'app',
    });

    const shared = singleton.use(operator, 'platform-operator');

    expect(() => {
      app.dependsOn(shared as unknown as object);
    }).toThrow(/singleton reference/i);
  });

  it('owned singleton handles still behave like nested composition resources in direct execution', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operator = createOperatorComposition();

    const result = singleton(operator, {
      id: 'platform-operator',
      spec: { name: 'cnpg-operator', namespace: 'cnpg-system' },
    });

    expect('spec' in result).toBe(true);
    expect('dependsOn' in result).toBe(false);
  });

  it('returns a reference handle during re-execution without capturing owner resources', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operator = createOperatorComposition();
    const context = createCompositionContext('singleton-reexecution-test', {
      deduplicateIds: true,
      isReExecution: true,
    });

    const result = runWithCompositionContext(context, () =>
      singleton(operator, {
        id: 'platform-operator',
        spec: { name: 'cnpg-operator', namespace: 'cnpg-system' },
      })
    );

    expect('spec' in result).toBe(false);
    expect(Object.keys(context.resources)).not.toContain('operatorDeployment');
  });

  it('nested composition handles expose dependsOn only when called inside a parent composition', () => {
    const operator = createOperatorComposition();

    const outer = kubernetesComposition(
      {
        name: 'outer-singleton-consumer',
        apiVersion: 'platform.typekro.test/v1alpha1',
        kind: 'OuterSingletonConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const nested = operator({ name: `${spec.name}-op`, namespace: 'system' }) as unknown as Record<string, unknown>;
        expect('dependsOn' in nested).toBe(true);
        return { ready: nested.status !== undefined } as { ready: boolean };
      },
    );

    expect(() => outer.toYaml()).not.toThrow();
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

  it('allows the same singleton to be referenced from multiple nested callers without drift', async () => {
    const { singleton } = await import('../../src/index.js') as typeof import('../../src/index.js') & { singleton: SingletonApi };
    const operator = createOperatorComposition();

    const outer = kubernetesComposition(
      {
        name: 'singleton-dedupe',
        apiVersion: 'platform.typekro.test/v1alpha1',
        kind: 'SingletonDedupe',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const sharedA = singleton(operator, {
          id: 'platform-operator',
          spec: { name: 'cnpg-operator', namespace: 'cnpg-system' },
        });
        const sharedB = singleton(operator, {
          id: 'platform-operator',
          spec: { name: 'cnpg-operator', namespace: 'cnpg-system' },
        });

        return {
          ready: sharedA.status.ready && sharedB.status.ready && spec.name.length > 0,
        };
      }
    );

    expect(() => outer.toYaml()).not.toThrow();
  });
});
