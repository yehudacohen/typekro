/**
 * Unit tests for `materializeAlchemyResources` — the helper that instantiates
 * `AlchemyResourceDeclaration`s as `KroResource`s, wiring `dependsOn` into alchemy `Output`
 * dependencies. Uses a fake `KroResource` constructor so the logic is covered without a cluster or
 * a full alchemy runtime. (End-to-end ordering + reference resolution is covered separately by
 * `test/integration/alchemy/direct-fan-out-e2e.test.ts`.)
 */
import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { materializeAlchemyResources, type KroResource } from '../../../src/alchemy/index.js';
import type { AlchemyResourceDeclaration } from '../../../src/alchemy/types.js';

// A fake KroResource constructor: records call order, returns a minimal handle (an FQN is enough
// for `Output.of` to wrap it). Typed loosely — the real constructor's type is alchemy-internal.
const makeFakeKroResource = () => {
  const calls: Array<{ id: string; props: Record<string, unknown> }> = [];
  const fake = (id: string, props: Record<string, unknown>) => {
    calls.push({ id, props });
    return Effect.succeed({ FQN: id, __handle: id });
  };
  return { fake: fake as unknown as typeof KroResource, calls };
};

const decl = (
  id: string,
  dependsOn: string[] = []
): AlchemyResourceDeclaration => ({
  id,
  dependsOn,
  props: {
    // Minimal valid props; content is irrelevant to materialize's wiring logic.
    resource: { kind: 'ConfigMap', metadata: { name: id } } as never,
    namespace: 'ns',
    deploymentStrategy: 'direct',
  },
});

describe('materializeAlchemyResources', () => {
  it('instantiates every declaration, in order, returning a handle per id', async () => {
    const { fake, calls } = makeFakeKroResource();
    const handles = await Effect.runPromise(
      materializeAlchemyResources(fake, [decl('a'), decl('b'), decl('c')]) as Effect.Effect<
        Record<string, unknown>
      >
    );

    expect(calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(Object.keys(handles).sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not add a `dependencies` prop for declarations with no dependsOn', async () => {
    const { fake, calls } = makeFakeKroResource();
    await Effect.runPromise(materializeAlchemyResources(fake, [decl('solo')]) as Effect.Effect<unknown>);
    expect('dependencies' in calls[0]!.props).toBe(false);
  });

  it('wires a `dependencies` prop (alchemy Output) for declarations with dependsOn', async () => {
    const { fake, calls } = makeFakeKroResource();
    // 'b' depends on 'a'; 'a' is declared first so its handle exists when 'b' is instantiated.
    await Effect.runPromise(
      materializeAlchemyResources(fake, [decl('a'), decl('b', ['a'])]) as Effect.Effect<unknown>
    );
    const bCall = calls.find((c) => c.id === 'b');
    expect(bCall).toBeDefined();
    expect(bCall?.props.dependencies).toBeDefined();
  });

  it('throws loudly when a dependsOn id is not (yet) instantiated (out-of-order/unknown)', async () => {
    const { fake } = makeFakeKroResource();
    // 'b' lists 'a' but 'a' comes AFTER it → 'a' handle not present when 'b' is materialized.
    const promise = Effect.runPromise(
      materializeAlchemyResources(fake, [decl('b', ['a']), decl('a')]) as Effect.Effect<unknown>
    );
    await expect(promise).rejects.toThrow(/dependsOn 'a'.*not \(yet\) instantiated|topologically ordered/);
  });
});
