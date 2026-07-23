import { afterEach, describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { DirectDeploymentEngine } from '../../src/core/deployment/engine.js';
import { KroResourceFactoryImpl } from '../../src/core/deployment/kro-factory.js';
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';
import {
  createResource,
  kubernetesComposition,
  namespace,
  simple,
  singleton,
} from '../../src/index.js';

const factoryPrototype = KroResourceFactoryImpl.prototype as unknown as Record<string, unknown>;
const enginePrototype = DirectDeploymentEngine.prototype as unknown as Record<string, unknown>;
const restored: Array<{ target: Record<string, unknown>; key: string; value: unknown }> = [];

function replace(target: Record<string, unknown>, key: string, value: unknown): void {
  restored.push({ target, key, value: target[key] });
  target[key] = value;
}

afterEach(() => {
  for (const entry of restored.reverse()) entry.target[entry.key] = entry.value;
  restored.length = 0;
});

describe('standalone KRO artifact-bundle execution', () => {
  it('forwards Effect interruption through the decoded bundle executor', async () => {
    const controller = new AbortController();
    const reason = new DOMException('stop KRO deployment', 'AbortError');
    let receivedSignal: AbortSignal | undefined;
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    replace(factoryPrototype, 'getKubeConfig', () => ({
      getCurrentCluster: () => ({ server: 'https://example.invalid' }),
    }));
    replace(factoryPrototype, 'ensureTargetNamespace', async () => {});
    replace(factoryPrototype, 'assertNoPreHoistNamespaceConflict', async () => {});
    replace(factoryPrototype, 'executeClosuresBeforeRGD', async () => []);
    replace(factoryPrototype, 'addRgdSchemaStatusPruneMarkers', async () => {});
    replace(factoryPrototype, 'dispose', async () => {});
    replace(
      enginePrototype,
      'deployResource',
      async (_resource: KubernetesResource, options: { abortSignal?: AbortSignal }) => {
        receivedSignal = options.abortSignal;
        started();
        return new Promise<never>((_, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(options.abortSignal?.reason),
            { once: true }
          );
        });
      }
    );
    replace(enginePrototype, 'dispose', async () => {});

    const composition = kubernetesComposition(
      {
        name: 'standalone-effect-kro',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'StandaloneEffectKro',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        simple.ConfigMap({ id: 'config', name: spec.name, data: { ready: 'true' } });
        return { ready: true };
      }
    );
    const factory = await composition.factory('kro', { namespace: 'apps' });
    const deployment = factory
      .deploy({ name: 'demo' }, { abortSignal: controller.signal })
      .catch((error: unknown) => error);

    await operationStarted;
    controller.abort(reason);

    expect(await deployment).toBe(reason);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('executes nested singleton owners and the root from one topologically ordered bundle', async () => {
    const applied: Array<{ kind: string; name: string; mode: string }> = [];
    replace(factoryPrototype, 'getKubeConfig', () => ({
      getCurrentCluster: () => ({ server: 'https://example.invalid' }),
    }));
    replace(factoryPrototype, 'ensureTargetNamespace', async () => {});
    replace(factoryPrototype, 'assertNoPreHoistNamespaceConflict', async () => {});
    replace(factoryPrototype, 'getSingletonOwnerInstancesForDriftCheck', async () => []);
    replace(factoryPrototype, 'executeClosuresBeforeRGD', async () => []);
    replace(factoryPrototype, 'addRgdSchemaStatusPruneMarkers', async () => {});
    replace(factoryPrototype, 'waitForCRDReadyWithEngine', async () => {});
    replace(factoryPrototype, 'waitForKroInstanceReady', async () => {});
    replace(factoryPrototype, 'createEnhancedProxy', async (spec: unknown, name: string) => ({
      metadata: { name },
      spec,
      status: { ready: true },
    }));
    replace(factoryPrototype, 'dispose', async () => {});
    replace(factoryPrototype, 'ensureSingletonOwners', async () => {
      throw new Error('legacy singleton deployment must not run');
    });
    replace(factoryPrototype, 'deployDirect', async () => {
      throw new Error('legacy direct KRO deployment must not run');
    });
    replace(
      enginePrototype,
      'deployResource',
      async (resource: KubernetesResource, options: { mode: string }) => {
        applied.push({
          kind: resource.kind,
          name: String(resource.metadata.name),
          mode: options.mode,
        });
        return {
          id: String(Reflect.get(resource, 'id') ?? resource.metadata.name),
          kind: resource.kind,
          name: String(resource.metadata.name),
          namespace: resource.metadata.namespace ?? 'default',
          manifest: resource,
          status: 'deployed',
          applied: true,
          deployedAt: new Date(0),
        };
      }
    );
    replace(enginePrototype, 'dispose', async () => {});

    const status = type({ ready: 'boolean' });
    const deeper = kubernetesComposition(
      {
        name: 'standalone-deeper',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'StandaloneDeeper',
        spec: type({ name: 'string' }),
        status,
      },
      (spec) => {
        simple.ConfigMap({ id: 'deeperConfig', name: spec.name, data: { ready: 'true' } });
        return { ready: true };
      }
    );
    const middle = kubernetesComposition(
      {
        name: 'standalone-middle',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'StandaloneMiddle',
        spec: type({ name: 'string' }),
        status,
      },
      (spec) => {
        singleton(deeper, { id: 'deeper', spec: { name: 'deeper' } });
        simple.ConfigMap({ id: 'middleConfig', name: spec.name, data: { ready: 'true' } });
        return { ready: true };
      }
    );
    const consumer = kubernetesComposition(
      {
        name: 'standalone-consumer',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'StandaloneConsumer',
        spec: type({ name: 'string' }),
        status,
      },
      (spec) => {
        const owner = singleton(middle, { id: 'middle', spec: { name: 'middle' } });
        simple.ConfigMap({ id: 'consumerConfig', name: spec.name, data: { ready: 'true' } });
        return { ready: owner.status.ready };
      }
    );

    const factory = await consumer.factory('kro', { namespace: 'apps' });
    const result = await factory.deploy({ name: 'demo' });

    expect(applied).toEqual([
      { kind: 'ResourceGraphDefinition', name: 'standalone-deeper', mode: 'direct' },
      { kind: 'StandaloneDeeper', name: 'deeper', mode: 'kro' },
      { kind: 'ResourceGraphDefinition', name: 'standalone-middle', mode: 'direct' },
      { kind: 'StandaloneMiddle', name: 'middle', mode: 'kro' },
      { kind: 'ResourceGraphDefinition', name: 'standalone-consumer', mode: 'direct' },
      { kind: 'StandaloneConsumer', name: 'demo', mode: 'kro' },
    ]);
    expect(result).toEqual(
      expect.objectContaining({ metadata: { name: 'demo' }, status: { ready: true } })
    );
  });

  it('materializes sensitive instance bindings only at standalone apply time', async () => {
    const plaintext = 'standalone-kro-runtime-secret';
    let appliedToken: unknown;
    replace(factoryPrototype, 'getKubeConfig', () => ({
      getCurrentCluster: () => ({ server: 'https://example.invalid' }),
    }));
    replace(factoryPrototype, 'ensureTargetNamespace', async () => {});
    replace(factoryPrototype, 'assertNoPreHoistNamespaceConflict', async () => {});
    replace(factoryPrototype, 'executeClosuresBeforeRGD', async () => []);
    replace(factoryPrototype, 'addRgdSchemaStatusPruneMarkers', async () => {});
    replace(factoryPrototype, 'waitForCRDReadyWithEngine', async () => {});
    replace(factoryPrototype, 'waitForKroInstanceReady', async () => {});
    replace(factoryPrototype, 'createEnhancedProxy', async (spec: unknown, name: string) => ({
      metadata: { name },
      spec,
      status: { ready: true },
    }));
    replace(factoryPrototype, 'dispose', async () => {});
    replace(enginePrototype, 'deployResource', async (resource: KubernetesResource) => {
      if (resource.kind === 'StandaloneSensitiveKro') {
        appliedToken = (resource as { spec?: { token?: unknown } }).spec?.token;
      }
      return {
        id: String(Reflect.get(resource, 'id') ?? resource.metadata.name),
        kind: resource.kind,
        name: String(resource.metadata.name),
        namespace: resource.metadata.namespace ?? 'default',
        manifest: resource,
        status: 'deployed',
        applied: true,
        deployedAt: new Date(0),
      };
    });
    replace(enginePrototype, 'dispose', async () => {});

    const composition = kubernetesComposition(
      {
        name: 'standalone-sensitive-kro',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'StandaloneSensitiveKro',
        revision: '1',
        spec: type({ name: 'string', token: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        createResource(
          {
            id: 'credentials',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: spec.name },
            stringData: { token: spec.token },
          },
          { factoryName: 'secret' }
        );
        return { ready: true };
      }
    );
    const factory = await composition.factory('kro', { namespace: 'apps' });

    await factory.deploy({ name: 'credentials', token: plaintext });

    expect(appliedToken).toBe(plaintext);
  });

  it('preserves prerequisite, hook, and hoisted-namespace operational gates', async () => {
    const events: string[] = [];
    replace(factoryPrototype, 'getKubeConfig', () => ({
      getCurrentCluster: () => ({ server: 'https://example.invalid' }),
    }));
    replace(factoryPrototype, 'ensureTargetNamespace', async (name: string) => {
      events.push(`ensure-namespace:${name}`);
    });
    replace(factoryPrototype, 'assertNoPreHoistNamespaceConflict', async () => {});
    replace(factoryPrototype, 'executeClosuresBeforeRGD', async () => []);
    replace(factoryPrototype, 'addRgdSchemaStatusPruneMarkers', async () => {});
    replace(factoryPrototype, 'waitForCRDReadyWithEngine', async () => {});
    replace(factoryPrototype, 'waitForKroInstanceReady', async () => {});
    replace(
      factoryPrototype,
      'applyRetainedHoistedNamespace',
      async (resource: KubernetesResource) => {
        events.push(`hoisted:${String(resource.metadata.name)}`);
      }
    );
    replace(factoryPrototype, 'createEnhancedProxy', async (spec: unknown, name: string) => ({
      metadata: { name },
      spec,
      status: { ready: true },
    }));
    replace(factoryPrototype, 'deployDirect', async () => {
      throw new Error('legacy direct KRO deployment must not run');
    });
    replace(
      enginePrototype,
      'deployResource',
      async (resource: KubernetesResource, options: { mode: string }) => {
        events.push(`apply:${resource.kind}:${String(resource.metadata.name)}:${options.mode}`);
        return {
          id: String(Reflect.get(resource, 'id') ?? resource.metadata.name),
          kind: resource.kind,
          name: String(resource.metadata.name),
          namespace: resource.metadata.namespace ?? 'default',
          manifest: resource,
          status: 'deployed',
          applied: true,
          deployedAt: new Date(0),
        };
      }
    );
    replace(enginePrototype, 'dispose', async () => {});

    const composition = kubernetesComposition(
      {
        name: 'standalone-supporting-roles',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'StandaloneSupportingRoles',
        spec: type({ name: 'string', namespace: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        namespace({ id: 'workloadNamespace', metadata: { name: spec.namespace } });
        simple.ConfigMap({
          id: 'workloadConfig',
          name: spec.name,
          namespace: spec.namespace,
          data: { ready: 'true' },
        });
        return { ready: true };
      }
    );
    const prerequisite = simple.ConfigMap({
      id: 'bootstrapConfig',
      name: 'bootstrap',
      namespace: 'apps',
      data: { installed: 'true' },
    });
    const factory = await composition.factory('kro', {
      namespace: 'apps',
      kroPrerequisites: {
        resources: [prerequisite],
        beforeResourceGraphDefinition: async () => {
          events.push('hook');
        },
      },
    });

    await factory.deploy({ name: 'demo', namespace: 'workloads' });

    const index = (event: string) => {
      const result = events.indexOf(event);
      expect(result).toBeGreaterThanOrEqual(0);
      return result;
    };
    const prerequisiteIndex = index('apply:ConfigMap:bootstrap:direct');
    const hookIndex = index('hook');
    const rgdIndex = index('apply:ResourceGraphDefinition:standalone-supporting-roles:direct');
    const namespaceIndex = index('hoisted:workloads');
    const instanceIndex = index('apply:StandaloneSupportingRoles:demo:kro');
    expect(prerequisiteIndex).toBeLessThan(hookIndex);
    expect(hookIndex).toBeLessThan(rgdIndex);
    expect(namespaceIndex).toBeLessThan(instanceIndex);
  });
});
