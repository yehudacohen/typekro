import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import * as Redacted from 'effect/Redacted';

import {
  enrichKroDeletionOptionsForTest,
  resourceFromKroArtifactBundleForTest,
} from '../../../src/alchemy/resource-registration.js';
import type {
  AlchemyResourceDeclaration,
  TypeKroResource,
  TypeKroResourceProps,
} from '../../../src/alchemy/types.js';
import {
  getMetadataField,
  getReadinessEvaluator,
  getResourceScope,
} from '../../../src/core/metadata/index.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
import { artifactOutput, decodeKroArtifactBundle } from '../../../src/experimental-planning.js';
import {
  createResource,
  kubernetesComposition,
  simple,
  singleton,
  toResourceGraph,
} from '../../../src/index.js';

const specSchema = type({ name: 'string' });
const statusSchema = type({ ready: 'boolean' });

function fixture() {
  return toResourceGraph(
    {
      name: 'alchemy-kro-artifact-rehydration',
      apiVersion: 'testing.typekro.dev/v1alpha1',
      kind: 'AlchemyKroArtifactRehydration',
      spec: specSchema,
      status: statusSchema,
    },
    (schema) => ({
      deployment: simple.Deployment({
        id: 'workload',
        name: schema.spec.name,
        image: 'nginx:latest',
      }),
    }),
    () => ({ ready: true })
  );
}

function outputFor(
  declaration: AlchemyResourceDeclaration
): TypeKroResource<Enhanced<unknown, unknown>> {
  return JSON.parse(
    JSON.stringify({
      ...declaration.props,
      deployedResource: declaration.props.resource,
      ready: true,
      deployedAt: 0,
    })
  ) as TypeKroResource<Enhanced<unknown, unknown>>;
}

async function restoredRootInstance() {
  const factory = await fixture().factory('kro', { namespace: 'apps' });
  const declarations = await factory.toAlchemyResources({ name: 'demo' });
  const byId = new Map(declarations.map((declaration) => [declaration.id, declaration]));
  const instance = declarations.find(
    (declaration) => declaration.props.resource.kind === 'AlchemyKroArtifactRehydration'
  );
  expect(instance).toBeDefined();
  expect(instance?.props.kroArtifactBundle).toBeString();
  expect(instance?.props.kroArtifactOperationId).toBeString();

  const restored = JSON.parse(JSON.stringify(instance!.props)) as TypeKroResourceProps<
    Enhanced<unknown, unknown>
  >;
  restored.dependencies = instance!.dependsOn.map((id) => outputFor(byId.get(id)!));
  return { declarations, instance: instance!, restored };
}

describe('KRO Alchemy artifact-bundle rehydration', () => {
  it('repairs pre-upgrade RGD deletion state from the persisted artifact bundle', async () => {
    const { declarations } = await restoredRootInstance();
    const rgd = declarations.find(
      (declaration) => declaration.props.resource.kind === 'ResourceGraphDefinition'
    );
    expect(rgd).toBeDefined();

    const legacyProps = JSON.parse(JSON.stringify(rgd!.props)) as TypeKroResourceProps<
      Enhanced<unknown, unknown>
    >;
    expect(legacyProps.kroDeletion).toBeDefined();
    delete legacyProps.kroDeletion!.instanceName;

    expect(
      enrichKroDeletionOptionsForTest(legacyProps, legacyProps.kroDeletion)
    ).toMatchObject({
      instanceName: 'demo',
      namespace: 'apps',
      rgdName: 'alchemy-kro-artifact-rehydration',
    });
  });

  it('materializes provider outputs after a KRO bundle state round trip', async () => {
    const composition = toResourceGraph(
      {
        name: 'alchemy-kro-provider-artifact',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'AlchemyKroProviderArtifact',
        revision: '1',
        spec: specSchema,
        status: statusSchema,
      },
      (schema) => ({
        workload: createResource({
          id: 'workload',
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: schema.spec.name },
          spec: {
            selector: { matchLabels: { app: schema.spec.name } },
            template: {
              metadata: { labels: { app: schema.spec.name } },
              spec: {
                containers: [{ name: 'app', image: artifactOutput('build', 'image') }],
              },
            },
          },
        }),
      }),
      () => ({ ready: true })
    );
    const factory = await composition.factory('kro', {
      namespace: 'apps',
      plan: {
        inputs: {
          build: {
            kind: 'artifact',
            requirement: {
              id: 'build',
              kind: 'container-image',
              descriptor: { kind: 'literal', value: 'demo' },
              outputs: ['image'],
            },
          },
        },
      },
    });
    const declarations = await factory.toAlchemyResources({ name: 'demo' });
    const target = declarations.find((declaration) => declaration.artifactOutputUses?.length)!;
    expect(target).toBeDefined();
    expect(target.props.resource.kind).toBe('AlchemyKroProviderArtifact');
    const rgd = declarations.find(
      (declaration) => declaration.props.resource.kind === 'ResourceGraphDefinition'
    );
    expect(rgd).toBeDefined();
    expect(rgd?.artifactOutputUses).toBeUndefined();
    expect(JSON.stringify(rgd?.props.resource)).toContain('typekroArtifactBindings');
    expect(JSON.stringify(rgd?.props.resource)).not.toContain('registry.example/demo@sha256:abc');
    const rgdSpec = Reflect.get(rgd?.props.resource ?? {}, 'spec');
    const rgdSchema = Reflect.get(Reflect.get(rgdSpec, 'schema'), 'spec');
    expect(Reflect.get(rgdSchema, 'typekroArtifactBindings')).toBe(
      'map[string]map[string]string'
    );
    const byId = new Map(declarations.map((declaration) => [declaration.id, declaration]));
    const restored = JSON.parse(JSON.stringify(target.props)) as TypeKroResourceProps<
      Enhanced<unknown, unknown>
    >;
    restored.dependencies = target.dependsOn.map((id) => outputFor(byId.get(id)!));
    restored.artifactOutputs = { build: { image: 'registry.example/demo@sha256:abc' } };
    const resource = resourceFromKroArtifactBundleForTest(restored)!;
    expect(JSON.stringify(resource)).toContain('registry.example/demo@sha256:abc');
  });

  it('redacts sensitive provider outputs while rehydrating KRO bundle operations', async () => {
    const plaintext = 'kro-provider-secret-output';
    const composition = toResourceGraph(
      {
        name: 'alchemy-kro-sensitive-provider-artifact',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'AlchemyKroSensitiveProviderArtifact',
        revision: '1',
        spec: specSchema,
        status: statusSchema,
      },
      (schema) => ({
        credentials: createResource(
          {
            id: 'credentials',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: schema.spec.name },
            stringData: { token: artifactOutput('secret-provider', 'token') },
          },
          { factoryName: 'secret' }
        ),
      }),
      () => ({ ready: true })
    );
    const factory = await composition.factory('kro', {
      namespace: 'apps',
      plan: {
        inputs: {
          secret: {
            kind: 'artifact',
            requirement: {
              id: 'secret-provider',
              kind: 'credential',
              descriptor: { kind: 'literal', value: 'demo' },
              outputs: ['token'],
            },
          },
        },
      },
    });
    const declarations = await factory.toAlchemyResources({ name: 'demo' });
    const target = declarations.find((declaration) => declaration.artifactOutputUses?.length)!;
    expect(target.artifactOutputUses?.[0]?.sensitive).toBe(true);
    const byId = new Map(declarations.map((declaration) => [declaration.id, declaration]));
    const props = {
      ...target.props,
      dependencies: target.dependsOn.map((id) => outputFor(byId.get(id)!)),
      artifactOutputs: { 'secret-provider': { token: Redacted.make(plaintext) } },
    };
    expect(JSON.stringify(props)).not.toContain(plaintext);
    expect(JSON.stringify(resourceFromKroArtifactBundleForTest(props))).toContain(plaintext);
    expect(JSON.stringify(resourceFromKroArtifactBundleForTest(props, true))).not.toContain(
      plaintext
    );
  });

  it('restores the exact compiled operation after an Alchemy JSON state round trip', async () => {
    const { instance, restored } = await restoredRootInstance();
    const bundle = decodeKroArtifactBundle(restored.kroArtifactBundle!);
    const operation = bundle.operations.find(
      (candidate) => candidate.id === restored.kroArtifactOperationId
    )!;

    const resource = resourceFromKroArtifactBundleForTest(restored)!;
    const expectedScope = operation.artifact.identity?.scope;
    if (!expectedScope) throw new Error(`Operation ${operation.id} has no compiled scope`);
    expect(resource).toEqual(instance.props.resource);
    expect(getResourceScope(resource)).toBe(expectedScope);
    expect(getMetadataField(resource, 'applyPolicy')).toEqual(operation.artifact.apply);
    if (operation.artifact.readiness.strategy?.kind === 'registered') {
      expect(getReadinessEvaluator(resource)).toBeFunction();
    }
  });

  it('fails closed when Alchemy dependency wiring disagrees with the bundle', async () => {
    const { restored } = await restoredRootInstance();
    restored.dependencies = [];

    expect(() => resourceFromKroArtifactBundleForTest(restored)).toThrow(
      'KRO artifact dependency mismatch'
    );
  });

  it('fails closed when only half of the persisted bundle identity is present', async () => {
    const { restored } = await restoredRootInstance();
    delete restored.kroArtifactOperationId;

    expect(() => resourceFromKroArtifactBundleForTest(restored)).toThrow(
      'KRO artifact state is incomplete'
    );
  });

  it('keeps KRO instance secrets outside the canonical bundle and unwraps only for apply', async () => {
    const plaintext = 'kro-alchemy-runtime-secret';
    const composition = toResourceGraph(
      {
        name: 'alchemy-kro-sensitive-artifact',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'AlchemyKroSensitiveArtifact',
        revision: '1',
        spec: type({ name: 'string', token: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => ({
        credentials: createResource(
          {
            id: 'credentials',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: schema.spec.name },
            stringData: { token: schema.spec.token },
          },
          { factoryName: 'secret' }
        ),
      }),
      () => ({ ready: true })
    );
    const factory = await composition.factory('kro', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources({
      name: 'credentials',
      token: plaintext,
    });
    const instance = declarations.find(
      (declaration) => declaration.props.resource.kind === 'AlchemyKroSensitiveArtifact'
    )!;
    const declarationsById = new Map(
      declarations.map((declaration) => [declaration.id, declaration])
    );
    const props = {
      ...instance.props,
      dependencies: instance.dependsOn.map((id) => outputFor(declarationsById.get(id)!)),
    };

    expect(JSON.stringify(declarations)).not.toContain(plaintext);
    expect(instance.props.kroArtifactBundle).not.toContain(plaintext);
    expect(Object.keys(instance.props.sensitiveBindings ?? {})).toHaveLength(1);
    const redactedToken = (instance.props.resource as { spec?: { token?: unknown } }).spec?.token;
    expect(Redacted.isRedacted(redactedToken)).toBe(true);

    const materialized = resourceFromKroArtifactBundleForTest(props)!;
    expect((materialized as { spec?: { token?: unknown } }).spec?.token).toBe(plaintext);
    const stateResource = resourceFromKroArtifactBundleForTest(props, true)!;
    expect(Redacted.isRedacted((stateResource as { spec?: { token?: unknown } }).spec?.token)).toBe(
      true
    );

    const binding = Object.keys(instance.props.sensitiveBindings ?? {})[0]!;
    expect(() =>
      resourceFromKroArtifactBundleForTest({
        ...props,
        sensitiveBindings: { [binding]: plaintext },
      })
    ).toThrow('must be supplied as an Alchemy Redacted input');
  });

  it('namespaces generated bindings across recursive singleton members', async () => {
    const ownerPlaintext = 'singleton-owner-secret';
    const consumerPlaintext = 'singleton-consumer-secret';
    const sensitiveSpec = type({ name: 'string', token: 'string' });
    const owner = kubernetesComposition(
      {
        name: 'sensitive-singleton-owner',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'SensitiveSingletonOwner',
        revision: '1',
        spec: sensitiveSpec,
        status: statusSchema,
      },
      (spec) => {
        createResource(
          {
            id: 'ownerCredentials',
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
    const consumer = kubernetesComposition(
      {
        name: 'sensitive-singleton-consumer',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'SensitiveSingletonConsumer',
        revision: '1',
        spec: sensitiveSpec,
        status: statusSchema,
      },
      (spec) => {
        singleton(owner, {
          id: 'owner',
          spec: { name: 'owner-credentials', token: ownerPlaintext },
        });
        createResource(
          {
            id: 'consumerCredentials',
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

    const factory = await consumer.factory('kro', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources({
      name: 'consumer-credentials',
      token: consumerPlaintext,
    });
    expect(JSON.stringify(declarations)).not.toContain(ownerPlaintext);
    expect(JSON.stringify(declarations)).not.toContain(consumerPlaintext);
    expect(declarations[0]!.props.kroArtifactBundle).not.toContain(ownerPlaintext);
    expect(declarations[0]!.props.kroArtifactBundle).not.toContain(consumerPlaintext);

    const ownerInstance = declarations.find(
      (declaration) => declaration.props.resource.kind === 'SensitiveSingletonOwner'
    )!;
    const consumerInstance = declarations.find(
      (declaration) => declaration.props.resource.kind === 'SensitiveSingletonConsumer'
    )!;
    const ownerToken = (ownerInstance.props.resource as { spec?: { token?: unknown } }).spec?.token;
    const consumerToken = (consumerInstance.props.resource as { spec?: { token?: unknown } }).spec
      ?.token;
    expect(Redacted.isRedacted(ownerToken)).toBe(true);
    expect(Redacted.isRedacted(consumerToken)).toBe(true);
    expect(Redacted.value(ownerToken as Redacted.Redacted<unknown>)).toBe(ownerPlaintext);
    expect(Redacted.value(consumerToken as Redacted.Redacted<unknown>)).toBe(consumerPlaintext);

    const ownerBindings = Object.keys(ownerInstance.props.sensitiveBindings ?? {});
    const consumerBindings = Object.keys(consumerInstance.props.sensitiveBindings ?? {});
    expect(ownerBindings).toHaveLength(1);
    expect(consumerBindings).toHaveLength(1);
    expect(ownerBindings[0]).not.toBe(consumerBindings[0]);
  });

  it('rejects runtime-only readiness instead of emitting unrecoverable Alchemy state', async () => {
    const prerequisite = simple
      .ConfigMap({
        id: 'runtimeReadyPrerequisite',
        name: 'runtime-ready-prerequisite',
        namespace: 'apps',
        data: { installed: 'true' },
      })
      .withReadinessEvaluator(() => ({ ready: true, message: 'ready' }));
    const factory = await fixture().factory('kro', {
      namespace: 'apps',
      kroPrerequisites: { resources: [prerequisite] },
    });

    await expect(factory.toAlchemyResources({ name: 'demo' })).rejects.toThrow(
      'cannot persist runtime-only readiness functions'
    );
  });

  it('preserves direct-owner edges across a recursively compiled singleton bundle', async () => {
    const deeper = kubernetesComposition(
      {
        name: 'bundle-deeper-owner',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'BundleDeeperOwner',
        spec: type({ name: 'string' }),
        status: statusSchema,
      },
      (spec) => {
        simple.ConfigMap({ id: 'deeperConfig', name: spec.name, data: { ready: 'true' } });
        return { ready: true };
      }
    );
    const middle = kubernetesComposition(
      {
        name: 'bundle-middle-owner',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'BundleMiddleOwner',
        spec: type({ name: 'string' }),
        status: statusSchema,
      },
      (spec) => {
        singleton(deeper, { id: 'deeper', spec: { name: 'deeper' } });
        simple.ConfigMap({ id: 'middleConfig', name: spec.name, data: { ready: 'true' } });
        return { ready: true };
      }
    );
    const consumer = kubernetesComposition(
      {
        name: 'bundle-consumer',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'BundleConsumer',
        spec: specSchema,
        status: statusSchema,
      },
      (spec) => {
        const owner = singleton(middle, { id: 'middle', spec: { name: 'middle' } });
        simple.ConfigMap({ id: 'consumerConfig', name: spec.name, data: { ready: 'true' } });
        return { ready: owner.status.ready };
      }
    );

    const factory = await consumer.factory('kro', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources({ name: 'demo' });
    expect(declarations.every((declaration) => declaration.props.kroArtifactBundle)).toBe(true);
    expect(declarations.every((declaration) => declaration.props.kroArtifactOperationId)).toBe(
      true
    );

    const bundle = decodeKroArtifactBundle(declarations[0]!.props.kroArtifactBundle!);
    expect(
      declarations.every(
        (declaration) =>
          declaration.props.kroArtifactBundle === declarations[0]!.props.kroArtifactBundle
      )
    ).toBe(true);
    const declarationByOperation = new Map(
      declarations.map((declaration) => [declaration.props.kroArtifactOperationId!, declaration])
    );
    for (const operation of bundle.operations) {
      const declaration = declarationByOperation.get(operation.id);
      expect(declaration).toBeDefined();
      expect([...declaration!.dependsOn].sort()).toEqual(
        operation.dependencies
          .map((dependency) => declarationByOperation.get(dependency)!.id)
          .sort()
      );
    }

    const byKind = (kind: string) =>
      declarations.find((declaration) => declaration.props.resource.kind === kind)!;
    const deeperInstance = byKind('BundleDeeperOwner');
    const middleInstance = byKind('BundleMiddleOwner');
    const consumerInstance = byKind('BundleConsumer');
    expect(middleInstance.dependsOn).toContain(deeperInstance.id);
    expect(consumerInstance.dependsOn).toContain(middleInstance.id);
    expect(consumerInstance.dependsOn).not.toContain(deeperInstance.id);

    const definitionKinds = factory
      .toYaml()
      .split(/^---$/m)
      .map((document) => document.match(/^kind: (.+)$/m)?.[1])
      .filter(Boolean);
    expect(definitionKinds).toEqual([
      'ResourceGraphDefinition',
      'ResourceGraphDefinition',
      'ResourceGraphDefinition',
    ]);
    const instanceKinds = factory
      .toYaml({ name: 'demo' })
      .split(/^---$/m)
      .map((document) => document.match(/^kind: (.+)$/m)?.[1])
      .filter(Boolean);
    expect(instanceKinds).toEqual(['BundleDeeperOwner', 'BundleMiddleOwner', 'BundleConsumer']);
  });
});
