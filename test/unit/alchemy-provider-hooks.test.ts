import { describe, expect, it, spyOn } from 'bun:test';
import { type KubernetesObject, KubernetesObjectApi } from '@kubernetes/client-node';
import * as Test from 'alchemy/Test/Core';
import { type } from 'arktype';
import { Effect } from 'effect';
import {
  KroResource,
  type KroResourceEffectHooks,
  kroProviderWithHooks,
  materializeAlchemyResources,
} from '../../src/alchemy/index.js';
import type { AlchemyResourceDeclaration } from '../../src/alchemy/types.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';
import { kubernetesComposition, observedResource, simple } from '../../src/index.js';

// Mock only the inert Kubernetes transport. The real provider, direct engine and admission wrapper
// execute unchanged, with serialized connection parameters that cannot select an ambient cluster.
function inertObjectApi() {
  const live = new Map<string, KubernetesObject>();
  const events: string[] = [];
  const key = (value: {
    kind?: unknown;
    metadata?: { namespace?: unknown; name?: unknown } | undefined;
  }) => `${value.kind}/${value.metadata?.namespace ?? 'default'}/${value.metadata?.name}`;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  let revision = 0;
  let onRead: ((value: KubernetesObject) => void) | undefined;
  let onWrite: ((value: KubernetesObject) => void) | undefined;
  let onCreate: ((value: KubernetesObject) => void) | undefined;
  const read = spyOn(KubernetesObjectApi.prototype, 'read').mockImplementation(async (value) => {
    events.push(`read:${value.metadata?.name}`);
    onRead?.(JSON.parse(JSON.stringify(value)));
    const result = live.get(key(value));
    if (!result) throw Object.assign(new Error('Absent inert resource'), { statusCode: 404 });
    return JSON.parse(JSON.stringify(result));
  });
  const write = <T extends KubernetesObject>(method: string, value: T): T => {
    events.push(`${method}:${value.metadata?.name}`);
    const previous = live.get(key(value));
    const result = copy(value);
    result.metadata = {
      ...result.metadata,
      uid: previous?.metadata?.uid ?? `inert-${++revision}`,
      resourceVersion: `${++revision}`,
    };
    live.set(key(value), result);
    onWrite?.(result);
    return result;
  };
  const create = spyOn(KubernetesObjectApi.prototype, 'create').mockImplementation(
    async (value) => {
      onCreate?.(value);
      if (live.has(key(value))) {
        events.push(`conflict:${value.metadata?.name}`);
        throw Object.assign(new Error('Existing inert resource'), { statusCode: 409 });
      }
      return write('create', value);
    }
  );
  const patch = spyOn(KubernetesObjectApi.prototype, 'patch').mockImplementation(async (value) =>
    write('patch', value)
  );
  const remove = spyOn(KubernetesObjectApi.prototype, 'delete').mockImplementation(
    async (value) => {
      events.push(`delete:${value.metadata?.name}`);
      live.delete(key(value));
      return {};
    }
  );
  return {
    live,
    events,
    key,
    beforeRead(callback: (value: KubernetesObject) => void) {
      onRead = callback;
    },
    beforeCreate(callback: (value: KubernetesObject) => void) {
      onCreate = callback;
    },
    afterWrite(callback: (value: KubernetesObject) => void) {
      onWrite = callback;
    },
    restore() {
      read.mockRestore();
      create.mockRestore();
      patch.mockRestore();
      remove.mockRestore();
    },
  };
}

const inertConnection = {
  loadFromDefault: false,
  cluster: { name: 'inert', server: 'http://127.0.0.1:1' },
  user: { name: 'inert' },
};

describe('operation-scoped Alchemy Kubernetes gates', () => {
  it('runs a reconcile gate at the provider effect and a delete gate before teardown', async () => {
    const events: string[] = [];
    const resource = simple.ConfigMap({
      id: 'configuration',
      name: 'gated-config',
      namespace: 'default',
      data: { mode: 'safe' },
    });
    const deployer = {
      async deploy() {
        events.push('kubernetes-create');
        return resource;
      },
      async delete() {
        events.push('kubernetes-delete');
      },
    };
    const options = {
      providers: kroProviderWithHooks({
        async beforeReconcile() {
          events.push('authorize-create');
          return { operation: 'create' as const };
        },
        async beforeDelete() {
          events.push('authorize-delete');
        },
      }),
    };
    const declaration = Effect.gen(function* () {
      return yield* KroResource('gatedConfig', {
        resource,
        namespace: 'default',
        deploymentStrategy: 'direct',
        retain: true,
        deployer,
      });
    });
    const scratch = Test.scratchStack(options, 'tk-alchemy-operation-gates');
    const run = <A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> =>
      Test.run(effect as never, options as never) as Promise<A>;

    await run(scratch.deploy(declaration));
    expect(events).toEqual(['authorize-create', 'kubernetes-create']);
    await run(scratch.destroy());
    expect(events).toEqual(['authorize-create', 'kubernetes-create', 'authorize-delete']);
  });

  it('refuses effect-time admission when an injected deployer bypasses the Kubernetes client', async () => {
    const resource = simple.ConfigMap({
      id: 'configuration',
      name: 'bypassed-config',
      namespace: 'default',
      data: { mode: 'safe' },
    });
    const options = {
      providers: kroProviderWithHooks({
        async beforeKubernetesEffect() {
          return { operation: 'create' as const };
        },
      }),
    };
    const scratch = Test.scratchStack(options, 'tk-alchemy-no-bypass');
    const declaration = Effect.gen(function* () {
      return yield* KroResource('bypassedConfig', {
        resource,
        namespace: 'default',
        deploymentStrategy: 'direct',
        deployer: {
          async deploy() {
            return resource;
          },
          async delete() {},
        },
      });
    });
    await expect(Test.run(scratch.deploy(declaration), options)).rejects.toThrow(
      'cannot use an injected deployer'
    );
  });

  for (const mode of ['observation-only', 'dynamic', 'ordinary'] as const) {
    it(`preserves undefined authority for the ${mode} direct lifecycle`, async () => {
      const api = inertObjectApi();
      const options = {
        providers: kroProviderWithHooks({
          ...(mode === 'dynamic' ? {} : { guardsResource: () => false }),
          observesResource: () => mode === 'observation-only',
          async beforeKubernetesEffect(_props, { method }, context) {
            api.events.push(`observe-${method}:${context?.id}`);
            return undefined;
          },
        }),
      };
      const scratch = Test.scratchStack(options, `tk-undefined-authority-${mode}`);
      const declaration = (value: string) =>
        Effect.gen(function* () {
          return yield* KroResource('observedConfig', {
            resource: simple.ConfigMap({
              id: 'configuration',
              name: `observed-${mode}`,
              namespace: 'default',
              data: { value },
            }),
            namespace: 'default',
            deploymentStrategy: 'direct',
            kubeConfigOptions: inertConnection,
            options: { timeout: 1000, conflictStrategy: 'patch' },
          });
        });
      try {
        await Test.run(scratch.deploy(declaration('original')), options);
        await Test.run(scratch.deploy(declaration('updated')), options);
        expect(api.live.get(`ConfigMap/default/observed-${mode}`)).toMatchObject({
          data: { value: 'updated' },
        });
        await Test.run(scratch.destroy(), options);
        expect(api.live.size).toBe(0);
        for (const method of ['create', 'patch', 'delete']) {
          expect(api.events).toContain(`${method}:observed-${mode}`);
          if (mode === 'ordinary')
            expect(api.events).not.toContain(`observe-${method}:observedConfig`);
          else expect(api.events).toContain(`observe-${method}:observedConfig`);
        }
      } finally {
        api.restore();
      }
    });
  }

  for (const denied of ['create', 'patch', 'delete', 'namespace', 'missing-hook'] as const) {
    it(`rejects explicitly guarded ${denied} without effect authority`, async () => {
      const api = inertObjectApi();
      let reject = denied !== 'patch' && denied !== 'delete';
      const beforeKubernetesEffect: NonNullable<
        KroResourceEffectHooks['beforeKubernetesEffect']
      > = async (_props, { method, resource }) => {
        api.events.push(`admit-${method}:${resource.metadata?.name}`);
        if (reject) return undefined;
        const live = api.live.get(api.key(resource));
        if (method === 'delete' && !live) return { skip: 'already-absent' };
        if (method === 'create' || !live) return { operation: 'create' };
        if (!live.metadata?.uid || !live.metadata.resourceVersion)
          throw new Error('Missing inert update identity');
        return {
          operation: 'update',
          uid: live.metadata.uid,
          resourceVersion: live.metadata.resourceVersion,
        };
      };
      const options = {
        providers: kroProviderWithHooks({
          guardsResource: () => true,
          observesResource: () => false,
          ...(denied === 'missing-hook' ? {} : { beforeKubernetesEffect }),
        }),
      };
      if (denied === 'namespace')
        api.afterWrite((value) => {
          Object.assign(value, { status: { phase: 'Active' } });
        });
      const scratch = Test.scratchStack(options, `tk-missing-authority-${denied}`);
      const declaration = (value: string) =>
        Effect.gen(function* () {
          return yield* KroResource('guardedResource', {
            resource:
              denied === 'namespace'
                ? namespace({
                    metadata: {
                      name: 'guarded-namespace',
                      annotations: { 'typekro.io/created-by-rgd': 'guarded-rgd' },
                    },
                  })
                : simple.ConfigMap({
                    id: 'configuration',
                    name: `guarded-${denied}`,
                    namespace: 'default',
                    data: { value },
                  }),
            ...(denied === 'namespace'
              ? { namespaceEmptyGate: true, namespaceOwnerRgd: 'guarded-rgd', retain: true }
              : {}),
            namespace: 'default',
            deploymentStrategy: 'direct',
            kubeConfigOptions: inertConnection,
            options: {
              timeout: 1000,
              conflictStrategy: 'patch',
              retryPolicy: { maxRetries: 0, initialDelay: 0, maxDelay: 0, backoffMultiplier: 1 },
            },
          });
        });
      try {
        if (!reject) await Test.run(scratch.deploy(declaration('original')), options);
        const before = JSON.stringify([...api.live]);
        api.events.length = 0;
        reject = true;
        const effect =
          denied === 'delete' ? scratch.destroy() : scratch.deploy(declaration('updated'));
        await expect(Test.run(effect, options)).rejects.toThrow(
          "Guarded resource 'guardedResource' received no Kubernetes effect authority."
        );
        expect(JSON.stringify([...api.live])).toBe(before);
        expect(api.events.filter((event) => /^(create|patch|delete):/.test(event))).toEqual([]);
        if (denied !== 'missing-hook') {
          expect(api.events.some((event) => event.startsWith('admit-'))).toBe(true);
          reject = false;
          await Test.run(scratch.destroy(), options);
        }
      } finally {
        api.restore();
      }
    });
  }

  it('cannot suppress a guarded direct effect with observesResource false', async () => {
    const resource = simple.ConfigMap({
      id: 'configuration',
      name: 'guarded-config',
      namespace: 'default',
      data: {},
    });
    const options = {
      providers: kroProviderWithHooks({
        guardsResource: () => true,
        observesResource: () => false,
        async beforeKubernetesEffect() {
          return undefined;
        },
      }),
    };
    const scratch = Test.scratchStack(options, 'tk-alchemy-guard-dominates-observer');
    const declaration = Effect.gen(function* () {
      return yield* KroResource('guardedConfig', {
        resource,
        namespace: 'default',
        deploymentStrategy: 'direct',
        deployer: {
          async deploy() {
            return resource;
          },
          async delete() {},
        },
      });
    });
    await expect(Test.run(scratch.deploy(declaration), options)).rejects.toThrow(
      'cannot use an injected deployer'
    );
  });

  for (const invalid of ['preflight-precondition', 'injected-deployer'] as const) {
    it(`preserves a persisted identity when its gated replacement has an invalid ${invalid}`, async () => {
      const writes: string[] = [];
      const incumbent = simple.ConfigMap({
        id: 'configuration',
        name: 'retained-config',
        namespace: 'default',
        data: { mode: 'old' },
      });
      const replacement = simple.ConfigMap({
        id: 'configuration',
        name: 'replacement-config',
        namespace: 'default',
        data: { mode: 'new' },
      });
      const deployer = {
        async deploy() {
          writes.push('create');
          return incumbent;
        },
        async delete() {
          writes.push('delete');
        },
      };
      const options = {
        providers: kroProviderWithHooks({
          async beforeKubernetesEffect() {
            return { operation: 'create' as const };
          },
        }),
      };
      const scratch = Test.scratchStack(options, `tk-gated-replacement-${invalid}`);
      const run = <A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> =>
        Test.run(effect as never, options as never) as Promise<A>;
      const oldDeclaration = Effect.gen(function* () {
        return yield* KroResource('retainedConfig', {
          resource: incumbent,
          namespace: 'default',
          deploymentStrategy: 'kro',
          deployer,
        });
      });
      const newDeclaration = Effect.gen(function* () {
        return yield* KroResource('retainedConfig', {
          resource: replacement,
          namespace: 'default',
          deploymentStrategy: 'direct',
          ...(invalid === 'preflight-precondition'
            ? { mutationPrecondition: { operation: 'create' as const } }
            : { deployer }),
        });
      });
      await run(scratch.deploy(oldDeclaration));
      expect(writes).toEqual(['create']);
      await expect(run(scratch.deploy(newDeclaration))).rejects.toThrow(
        invalid === 'preflight-precondition'
          ? 'preflight mutation precondition'
          : 'injected deployer'
      );
      expect(writes).toEqual(['create']);
      // The scratch provider writes only to this in-memory deployer. Do not
      // destroy after a failed update: Alchemy may retain the failed news as
      // its teardown props, which is a different recovery contract.
    });
  }

  for (const rejection of ['new-create', 'old-delete'] as const) {
    it(`preserves the incumbent and converges after effect admission rejects ${rejection}`, async () => {
      const api = inertObjectApi();
      let reject = false;
      const options = {
        providers: kroProviderWithHooks({
          async beforeDelete(props) {
            api.events.push(`before-delete:${props.resource.metadata?.name}`);
          },
          async beforeKubernetesEffect(_props, { method, resource }) {
            api.events.push(`admit-${method}:${resource.metadata?.name}`);
            const live = api.live.get(api.key(resource));
            const creation = method === 'create' || (method === 'patch' && !live);
            if (
              reject &&
              ((rejection === 'new-create' &&
                creation &&
                resource.metadata?.name === 'new-config') ||
                (rejection === 'old-delete' &&
                  method === 'delete' &&
                  resource.metadata?.name === 'old-config'))
            ) {
              throw new Error(`deny-${rejection}`);
            }
            if (creation) return { operation: 'create' as const };
            if (!live?.metadata?.uid || !live.metadata.resourceVersion)
              throw new Error('Missing inert update identity');
            return {
              operation: 'update' as const,
              uid: live.metadata.uid,
              resourceVersion: live.metadata.resourceVersion,
            };
          },
        }),
      };
      const scratch = Test.scratchStack(options, `tk-effect-replacement-${rejection}`);
      const declaration = (name: string) =>
        Effect.gen(function* () {
          return yield* KroResource('configuration', {
            resource: simple.ConfigMap({
              id: 'configuration',
              name,
              namespace: 'default',
              data: { mode: name },
            }),
            namespace: 'default',
            deploymentStrategy: 'direct',
            kubeConfigOptions: inertConnection,
            options: {
              timeout: 1000,
              retryPolicy: { maxRetries: 0, initialDelay: 0, maxDelay: 0, backoffMultiplier: 1 },
            },
          });
        });
      const run = <A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> =>
        Test.run(effect as never, options as never) as Promise<A>;
      try {
        await run(scratch.deploy(declaration('old-config')));
        const incumbent = JSON.stringify(api.live.get('ConfigMap/default/old-config'));
        api.events.length = 0;
        reject = true;
        await expect(run(scratch.deploy(declaration('new-config')))).rejects.toThrow(
          `deny-${rejection}`
        );
        expect(JSON.stringify(api.live.get('ConfigMap/default/old-config'))).toBe(incumbent);
        expect(api.events).not.toContain('delete:old-config');
        if (rejection === 'new-create') {
          expect(api.live.has('ConfigMap/default/new-config')).toBe(false);
          expect(api.events).not.toContain('before-delete:old-config');
        } else {
          expect(api.live.has('ConfigMap/default/new-config')).toBe(true);
          expect(api.events.indexOf('create:new-config')).toBeLessThan(
            api.events.indexOf('before-delete:old-config')
          );
        }
        reject = false;
        await run(scratch.deploy(declaration('new-config')));
        expect(api.live.has('ConfigMap/default/old-config')).toBe(false);
        expect(api.live.has('ConfigMap/default/new-config')).toBe(true);
        expect(api.events.filter((event) => event === 'create:new-config')).toHaveLength(1);
        expect(api.events.filter((event) => event === 'delete:old-config')).toHaveLength(1);
        await run(scratch.destroy());
      } finally {
        api.restore();
      }
    });
  }

  for (const initial of ['denied', 'owned', 'adopted', 'conflict'] as const) {
    it(`admits hoisted Namespace ownership and preserves ${initial} recovery`, async () => {
      const api = inertObjectApi();
      const name = `hoisted-${initial}`;
      const owner = 'neutral-rgd';
      const identity = `Namespace/default/${name}`;
      const existing = {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name,
          uid: 'external-uid',
          resourceVersion: '7',
          annotations: initial === 'owned' ? { 'typekro.io/created-by-rgd': owner } : {},
        },
        status: { phase: 'Active' },
      };
      if (initial === 'owned' || initial === 'adopted') api.live.set(identity, existing);
      if (initial === 'conflict')
        api.beforeCreate(() => {
          api.live.set(identity, existing);
        });
      api.afterWrite((value) => {
        Object.assign(value, { status: { phase: 'Active' } });
      });
      let deny = initial === 'denied';
      const options = {
        providers: kroProviderWithHooks({
          async beforeKubernetesEffect(_props, { method, resource }) {
            api.events.push(`admit-${method}:${resource.metadata?.name}`);
            if (deny) throw new Error('namespace-creation-denied');
            const live = api.live.get(api.key(resource));
            if (method === 'create' || (method === 'patch' && !live)) {
              return { operation: 'create' as const };
            }
            if (!live?.metadata?.uid || !live.metadata.resourceVersion)
              throw new Error('Missing namespace authority');
            return {
              operation: 'update' as const,
              uid: live.metadata.uid,
              resourceVersion: live.metadata.resourceVersion,
            };
          },
        }),
      };
      const scratch = Test.scratchStack(options, `tk-hoisted-namespace-${initial}`);
      const declaration = Effect.gen(function* () {
        return yield* KroResource('hoistedNamespace', {
          resource: namespace({
            metadata: {
              name,
              labels: { 'testing.typekro.dev/configuration': 'declared' },
              annotations: { 'typekro.io/created-by-rgd': owner },
            },
          }),
          namespace: name,
          deploymentStrategy: 'direct',
          namespaceEmptyGate: true,
          namespaceOwnerRgd: owner,
          kubeConfigOptions: inertConnection,
          retain: true,
          options: {
            conflictStrategy: 'patch',
            timeout: 1000,
            retryPolicy: { maxRetries: 0, initialDelay: 0, maxDelay: 0, backoffMultiplier: 1 },
          },
        });
      });
      try {
        if (deny) {
          await expect(Test.run(scratch.deploy(declaration), options)).rejects.toThrow(
            'namespace-creation-denied'
          );
          expect(
            api.events.filter((event) => event.startsWith('create:') || event.startsWith('patch:'))
          ).toEqual([]);
          expect(api.live.has(identity)).toBe(false);
          deny = false;
        }
        await Test.run(scratch.deploy(declaration), options);
        const live = api.live.get(identity);
        expect(live?.metadata?.namespace).toBeUndefined();
        expect([...api.live.keys()]).toEqual([identity]);
        const ownerStamp = live?.metadata?.annotations?.['typekro.io/created-by-rgd'];
        if (initial === 'owned' || initial === 'denied') expect(ownerStamp).toBe(owner);
        else expect(ownerStamp).toBeUndefined();
        if (initial === 'denied') {
          expect(api.events.filter((event) => event === `create:${name}`)).toHaveLength(1);
          expect(api.events.indexOf(`admit-create:${name}`)).toBeLessThan(
            api.events.indexOf(`create:${name}`)
          );
        } else {
          expect(api.events).not.toContain(`create:${name}`);
          if (initial === 'conflict') {
            expect(api.events.indexOf(`admit-create:${name}`)).toBeLessThan(
              api.events.indexOf(`conflict:${name}`)
            );
          } else {
            // Existing objects need update authority only; an ownership probe cannot demand an
            // impossible create-only permit for an object already observed to exist.
            expect(api.events).not.toContain(`admit-create:${name}`);
            expect(api.events).not.toContain(`conflict:${name}`);
          }
        }
        if (initial !== 'denied') expect(api.events).toContain(`admit-patch:${name}`);
        expect(live?.metadata?.labels?.['testing.typekro.dev/configuration']).toBe('declared');
        await Test.run(scratch.destroy(), options);
      } finally {
        api.restore();
      }
    });
  }

  it('rehydrates an observed Secret only after its generated prerequisite is ready', async () => {
    const api = inertObjectApi();
    let controllerReady = false;
    api.afterWrite((value) => {
      if (value.kind !== 'Deployment') return;
      Object.assign(value, {
        status: {
          readyReplicas: 1,
          availableReplicas: 1,
          updatedReplicas: 1,
          replicas: 1,
          observedGeneration: 1,
        },
      });
      value.metadata = { ...value.metadata, generation: 1 };
      const generatedSecret = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'generated-credentials', namespace: 'default' },
        data: { KEY: 'bmV1dHJhbA==' },
      };
      api.live.set('Secret/default/generated-credentials', generatedSecret);
    });
    api.beforeRead((value) => {
      if (value.kind === 'Deployment' && api.live.has(api.key(value))) controllerReady = true;
      if (value.metadata?.name === 'generated-credentials') expect(controllerReady).toBe(true);
    });
    const composition = kubernetesComposition(
      {
        name: 'durable-observation-order',
        kind: 'DurableObservationOrder',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (input) => {
        const controller = simple.Deployment({
          id: 'controller',
          name: input.name,
          image: 'controller:1',
        });
        const source = observedResource<Record<string, never>, Record<string, never>>({
          id: 'credentials',
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'generated-credentials', namespace: 'default' },
        }).dependsOn(controller);
        const data = source.data;
        if (!data) throw new Error('Missing deferred data');
        simple.ConfigMap({ id: 'consumer', name: 'consumer', data: { key: data.KEY } });
        return { ready: true };
      }
    );
    const options = { providers: kroProviderWithHooks() };
    const scratch = Test.scratchStack(options, 'tk-durable-observation-order');
    try {
      const declarations: AlchemyResourceDeclaration[] = JSON.parse(
        JSON.stringify(
          await composition
            .factory('direct', { namespace: 'default' })
            .toAlchemyResources({ name: 'controller' })
        )
      );
      for (const declaration of declarations) {
        declaration.props.kubeConfigOptions = inertConnection;
        declaration.props.options = {
          ...declaration.props.options,
          timeout: 1000,
          waitForReady: true,
        };
      }
      await Test.run(
        scratch.deploy(materializeAlchemyResources(KroResource, declarations)),
        options
      );
      expect(api.events).toContain('read:generated-credentials');
      expect(api.events.indexOf('create:controller')).toBeLessThan(
        api.events.indexOf('read:generated-credentials')
      );
      expect(api.live.get('ConfigMap/default/consumer')).toMatchObject({
        data: { key: 'bmV1dHJhbA==' },
      });
      await Test.run(scratch.destroy(), options);
    } finally {
      api.restore();
    }
  });

  it('keeps Alchemy replacement planning for KRO declarations outside the direct effect gate', async () => {
    const writes: string[] = [];
    const oldResource = simple.ConfigMap({
      id: 'configuration',
      name: 'old-kro-config',
      namespace: 'default',
      data: {},
    });
    const newResource = simple.ConfigMap({
      id: 'configuration',
      name: 'new-kro-config',
      namespace: 'default',
      data: {},
    });
    const deployer = {
      async deploy(resource: typeof oldResource) {
        writes.push(`create:${resource.metadata?.name}`);
        return resource;
      },
      async delete(resource: typeof oldResource) {
        writes.push(`delete:${resource.metadata?.name}`);
      },
    };
    const options = {
      providers: kroProviderWithHooks({
        async beforeKubernetesEffect() {
          throw new Error('KRO must not enter the direct gate.');
        },
      }),
    };
    const scratch = Test.scratchStack(options, 'tk-ungated-kro-replacement');
    const run = <A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> =>
      Test.run(effect as never, options as never) as Promise<A>;
    const declaration = (resource: typeof oldResource) =>
      Effect.gen(function* () {
        return yield* KroResource('kroConfig', {
          resource,
          namespace: 'default',
          deploymentStrategy: 'kro',
          deployer,
        });
      });
    await run(scratch.deploy(declaration(oldResource)));
    // Injected test deployers are not durable Alchemy state. Inspect the
    // replacement plan without replaying a serialized callback on teardown.
    const plan = await run(scratch.plan(declaration(newResource)));
    expect(Object.values(plan.resources).map(({ action }) => action)).toContain('replace');
    expect(writes).toEqual(['create:old-kro-config']);
  });

  it('keeps an explicitly unguarded direct resource on ordinary replacement planning', async () => {
    const writes: string[] = [];
    const oldResource = simple.ConfigMap({
      id: 'configuration',
      name: 'old-direct-config',
      namespace: 'default',
      data: {},
    });
    const newResource = simple.ConfigMap({
      id: 'configuration',
      name: 'new-direct-config',
      namespace: 'default',
      data: {},
    });
    const deployer = {
      async deploy(resource: typeof oldResource) {
        writes.push(`create:${resource.metadata?.name}`);
        return resource;
      },
      async delete(resource: typeof oldResource) {
        writes.push(`delete:${resource.metadata?.name}`);
      },
    };
    const options = {
      providers: kroProviderWithHooks({
        guardsResource: (id) => id !== 'ordinaryConfig',
        async beforeKubernetesEffect() {
          throw new Error('Out-of-scope direct resource entered the gate.');
        },
      }),
    };
    const scratch = Test.scratchStack(options, 'tk-unguarded-direct-replacement');
    const run = <A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> =>
      Test.run(effect as never, options as never) as Promise<A>;
    const declaration = (resource: typeof oldResource) =>
      Effect.gen(function* () {
        return yield* KroResource('ordinaryConfig', {
          resource,
          namespace: 'default',
          deploymentStrategy: 'direct',
          deployer,
        });
      });
    await run(scratch.deploy(declaration(oldResource)));
    const plan = await run(scratch.plan(declaration(newResource)));
    expect(Object.values(plan.resources).map(({ action }) => action)).toContain('replace');
    expect(writes).toEqual(['create:old-direct-config']);
  });
});
