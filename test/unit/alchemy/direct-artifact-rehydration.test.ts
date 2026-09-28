import { describe, expect, it, spyOn } from 'bun:test';
import { KubeConfig, type KubernetesObject, KubernetesObjectApi } from '@kubernetes/client-node';
import * as Test from 'alchemy/Test/Core';
import { type } from 'arktype';
import { Effect } from 'effect';
import * as Redacted from 'effect/Redacted';
import { DirectTypeKroDeployer } from '../../../src/alchemy/deployers.js';
import { KroResource, kroProviderWithHooks } from '../../../src/alchemy/index.js';
import {
  cloneResourceForAlchemyStateForTest,
  propsForRetainedDeleteForTest,
  resourceFromDirectArtifactRecordForTest,
} from '../../../src/alchemy/resource-registration.js';
import type { TypeKroResourceProps } from '../../../src/alchemy/types.js';
import { DirectDeploymentEngine } from '../../../src/core/deployment/engine.js';
import {
  getMetadataField,
  getReadinessEvaluator,
  getResourceScope,
} from '../../../src/core/metadata/index.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
import { artifactOutput } from '../../../src/experimental-planning.js';
import { secret } from '../../../src/factories/kubernetes/config/secret.js';
import { namespace } from '../../../src/factories/kubernetes/core/namespace.js';
import {
  Cel,
  createResource,
  observedResource,
  simple,
  toResourceGraph,
} from '../../../src/index.js';
import { isCelExpression } from '../../../src/utils/type-guards.js';

const specSchema = type({ name: 'string' });
const statusSchema = type({ ready: 'boolean' });

function fixture() {
  return toResourceGraph(
    {
      name: 'alchemy-artifact-rehydration',
      apiVersion: 'testing.typekro.dev/v1alpha1',
      kind: 'AlchemyArtifactRehydration',
      spec: specSchema,
      status: statusSchema,
    },
    (schema) => {
      const source = simple.Deployment({
        id: 'sourceDeployment',
        name: schema.spec.name,
        image: 'nginx:latest',
      });
      return {
        source,
        config: simple.ConfigMap({
          id: 'dependentConfig',
          name: Cel.template('%s-config', schema.spec.name),
          data: {
            readyReplicas: Cel.template('%s', source.status.readyReplicas),
          },
        }),
      };
    },
    () => ({ ready: true })
  );
}

describe('direct Alchemy artifact rehydration', () => {
  for (const present of [true, false]) {
    it(`preserves serialized external Secret identity through the real direct engine (present=${present})`, async () => {
      const composition = toResourceGraph(
        {
          name: 'observed-secret-fanout',
          kind: 'ObservedSecretFanout',
          spec: specSchema,
          status: statusSchema,
        },
        (schema) => {
          const source = observedResource<Record<string, never>, Record<string, never>>({
            id: 'source',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: schema.spec.name, namespace: 'source-system' },
          });
          const sourceData = source.data;
          if (!sourceData) throw new Error('Observed Secret data must expose deferred references');
          const disabled = observedResource<Record<string, never>, Record<string, never>>({
            id: 'disabled', apiVersion: 'v1', kind: 'Secret',
            metadata: { name: 'disabled-absent', namespace: 'source-system' },
          }).withIncludeWhen(false);
          return {
            source,
            disabled,
            target: secret({
              id: 'target',
              metadata: { name: 'target', namespace: 'target-system' },
              data: { projected: Cel.expr<string>('string(', sourceData.providerKey, ')') },
            }),
          };
        },
        () => ({ ready: true })
      );
      const declarations = await composition
        .factory('direct', { namespace: 'target-system' })
        .toAlchemyResources({ name: 'provider-credentials' });
      expect(declarations).toHaveLength(1);
      const declaration = declarations[0]!;
      const restored = JSON.parse(JSON.stringify(declaration.props));
      const resource = resourceFromDirectArtifactRecordForTest(restored)!;
      const encoded = 'bmV1dHJhbC1jcmVkZW50aWFs';
      const source = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'provider-credentials', namespace: 'source-system' },
        data: { providerKey: encoded },
      };
      const config = new KubeConfig();
      config.loadFromClusterAndUser(
        { name: 'inert', server: 'http://127.0.0.1:1', skipTLSVerify: false },
        { name: 'inert' }
      );
      const api = KubernetesObjectApi.makeApiClient(config);
      const reads: KubernetesObject[] = [];
      let target: KubernetesObject | undefined;
      spyOn(api, 'read').mockImplementation(async (identity) => {
        reads.push(JSON.parse(JSON.stringify(identity)));
        if (identity.metadata.namespace === 'source-system'
          && identity.metadata.name === 'provider-credentials' && present)
          return JSON.parse(JSON.stringify(source));
        if (target && identity.metadata.name === 'target')
          return JSON.parse(JSON.stringify(target));
        throw Object.assign(new Error('Absent inert resource'), { statusCode: 404 });
      });
      const create = spyOn(api, 'create').mockImplementation(async (value) => {
        target = value;
        return value;
      });
      const patch = spyOn(api, 'patch').mockImplementation(async (value) => {
        target = value;
        return value;
      });
      const remove = spyOn(api, 'delete').mockImplementation(async () => ({}));
      const engine = new DirectDeploymentEngine(config, api);
      const deployer = new DirectTypeKroDeployer(engine);
      try {
        if (present) {
          await deployer.deploy(resource, {
            mode: 'direct',
            namespace: 'target-system',
            timeout: 1000,
          });
          expect(target).toMatchObject({
            kind: 'Secret',
            metadata: { name: 'target', namespace: 'target-system' },
            data: { projected: encoded },
          });
          expect(create).toHaveBeenCalledTimes(1);
          expect(patch).not.toHaveBeenCalled();
        } else {
          await expect(
            deployer.deploy(resource, { mode: 'direct', namespace: 'target-system', timeout: 1000 })
          ).rejects.toThrow('Required external resource Secret/provider-credentials');
          expect(create).not.toHaveBeenCalled();
          expect(patch).not.toHaveBeenCalled();
        }
        expect(reads[0]).toEqual({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'provider-credentials', namespace: 'source-system' },
        });
        expect(remove).not.toHaveBeenCalled();
        expect(reads.some(identity => identity.metadata?.name === 'disabled-absent')).toBe(false);
        expect(restored.artifactExecutionRecord).not.toContain('disabled-absent');
        expect(JSON.stringify(declaration)).not.toContain(encoded);
        expect(JSON.stringify(cloneResourceForAlchemyStateForTest(resource))).not.toContain(
          encoded
        );
        expect(getMetadataField(resource, 'directExternalReferences')).toHaveLength(1);
      } finally {
        await deployer.dispose();
      }
    });
  }

  it('recovers the retained base-format declaration scope at the state-driven delete gate', async () => {
    const composition = toResourceGraph(
      { name: 'retained-direct-namespace', apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'RetainedDirectNamespace', spec: specSchema, status: statusSchema },
      (schema) => ({ ns: namespace({ id: 'ns', metadata: { name: schema.spec.name } }) }),
      () => ({ ready: true })
    );
    const factory = await composition.factory('direct', { namespace: 'default' });
    const declaration = (await factory.toAlchemyResources({ name: 'retained-scope-test' }))[0]!;
    const oldProps = JSON.parse(JSON.stringify(declaration.props));
    delete oldProps.resource.scope;
    expect(getResourceScope(oldProps.resource)).toBeUndefined();
    const outputResource = resourceFromDirectArtifactRecordForTest(oldProps)!;
    expect(getResourceScope(outputResource)).toBe('cluster');
    const persistedOutput = { resource: outputResource, deployedResource: outputResource,
      namespace: 'default', deploymentStrategy: 'direct' } as never;
    expect(() => propsForRetainedDeleteForTest({ ...oldProps,
      resource: { ...oldProps.resource, metadata: { ...oldProps.resource.metadata, name: 'other' } },
    }, persistedOutput)).toThrow(/conflicting persisted Kubernetes identity/u);
    const admitted: unknown[] = [];
    const deleteTargets: { namespace: string }[] = [];
    const options = { providers: kroProviderWithHooks({
      async beforeDelete(props) {
        admitted.push(props.resource);
        const deployer = new DirectTypeKroDeployer({
          async deleteResource(target: { namespace: string }) { deleteTargets.push(target); },
        } as never);
        await deployer.delete(props.resource, { mode: 'direct', namespace: props.namespace });
        throw new Error('stop before physical delete');
      },
    }) };
    const scratch = Test.scratchStack(options, 'tk-retained-direct-scope-delete');
    const resource = Effect.gen(function* () {
      return yield* KroResource(declaration.id, { ...oldProps,
        deployer: {
          async deploy() { return outputResource; },
          async delete() {},
        },
      });
    });
    await Test.run(scratch.deploy(resource), options);
    await expect(Test.run(scratch.destroy(), options)).rejects.toThrow('stop before physical delete');
    expect(admitted).toHaveLength(1);
    expect(getResourceScope(admitted[0] as typeof outputResource)).toBe('cluster');
    expect((admitted[0] as typeof outputResource).metadata.namespace).toBeUndefined();
    expect(deleteTargets).toHaveLength(1);
    expect(deleteTargets[0]?.namespace).toBe('');
  });

  it('retains factory cluster scope in the persisted direct artifact used for delete', async () => {
    const composition = toResourceGraph(
      {
        name: 'alchemy-direct-namespace-artifact',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'AlchemyDirectNamespaceArtifact',
        spec: specSchema,
        status: statusSchema,
      },
      (schema) => ({
        ns: namespace({ id: 'ns', metadata: { name: schema.spec.name } }),
      }),
      () => ({ ready: true })
    );
    const factory = await composition.factory('direct', { namespace: 'default' });
    const declaration = (await factory.toAlchemyResources({ name: 'artifact-scope-test' }))[0]!;
    expect(getResourceScope(declaration.props.resource)).toBe('cluster');
    expect((declaration.props.resource as { scope?: string }).scope).toBe('cluster');
    const restoredInput = JSON.parse(JSON.stringify(declaration.props.resource));
    expect(getResourceScope(restoredInput)).toBe('cluster');
    expect(restoredInput.metadata.namespace).toBeUndefined();

    const materialized = resourceFromDirectArtifactRecordForTest(declaration.props)!;
    const persisted = cloneResourceForAlchemyStateForTest(materialized);
    expect(persisted.scope).toBe('cluster');
    expect(persisted.metadata.namespace).toBeUndefined();
  });

  it('keeps provider outputs symbolic until Alchemy supplies them', async () => {
    const composition = toResourceGraph(
      {
        name: 'alchemy-direct-provider-artifact',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'AlchemyDirectProviderArtifact',
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
    const factory = await composition.factory('direct', {
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
    const declaration = (await factory.toAlchemyResources({ name: 'demo' }))[0]!;
    expect(declaration.artifactOutputUses).toEqual([
      { requirementId: 'build', output: 'image', sensitive: false },
    ]);
    const restored = JSON.parse(JSON.stringify(declaration.props)) as TypeKroResourceProps<
      Enhanced<unknown, unknown>
    >;
    restored.artifactOutputs = { build: { image: 'registry.example/demo@sha256:abc' } };
    const resource = resourceFromDirectArtifactRecordForTest(restored)! as {
      spec?: { template?: { spec?: { containers?: Array<{ image?: string }> } } };
    };
    expect(resource.spec?.template?.spec?.containers?.[0]?.image).toBe(
      'registry.example/demo@sha256:abc'
    );
  });

  it('requires sensitive provider outputs to remain redacted until apply', async () => {
    const plaintext = 'provider-secret-output';
    const composition = toResourceGraph(
      {
        name: 'alchemy-direct-sensitive-provider-artifact',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'AlchemyDirectSensitiveProviderArtifact',
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
    const factory = await composition.factory('direct', {
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
    const declaration = (await factory.toAlchemyResources({ name: 'demo' }))[0]!;
    expect(declaration.artifactOutputUses?.[0]?.sensitive).toBe(true);
    const props = {
      ...declaration.props,
      artifactOutputs: { 'secret-provider': { token: Redacted.make(plaintext) } },
    };
    expect(JSON.stringify(props)).not.toContain(plaintext);
    const applyResource = resourceFromDirectArtifactRecordForTest(props)! as {
      stringData?: { token?: unknown };
    };
    expect(applyResource.stringData?.token).toBe(plaintext);
    const stateResource = resourceFromDirectArtifactRecordForTest(props, true)! as {
      stringData?: { token?: unknown };
    };
    expect(Redacted.isRedacted(stateResource.stringData?.token)).toBe(true);
    expect(() =>
      resourceFromDirectArtifactRecordForTest({
        ...declaration.props,
        artifactOutputs: { 'secret-provider': { token: plaintext } },
      })
    ).toThrow('must be supplied as an Alchemy Redacted input');
  });

  it('restores structured runtime semantics from the canonical execution record', async () => {
    const factory = await fixture().factory('direct', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources({ name: 'demo' });
    const source = declarations.find(
      (declaration) => declaration.props.resourceId === 'sourceDeployment'
    )!;
    const dependent = declarations.find(
      (declaration) => declaration.props.resourceId === 'dependentConfig'
    )!;

    const restored = JSON.parse(JSON.stringify(dependent.props)) as TypeKroResourceProps<
      Enhanced<unknown, unknown>
    >;
    restored.dependencies = [
      {
        resource: source.props.resource,
        resourceId: 'sourceDeployment',
        namespace: 'apps',
        deploymentStrategy: 'direct',
        deployedResource: {
          ...source.props.resource,
          status: { readyReplicas: 1 },
        },
        ready: true,
        deployedAt: 0,
      },
    ];

    const resource = resourceFromDirectArtifactRecordForTest(restored)!;
    expect(resource.kind).toBe('ConfigMap');
    const readyReplicas = (resource as { data?: { readyReplicas?: unknown } }).data?.readyReplicas;
    expect(isCelExpression(readyReplicas)).toBe(true);
    expect(readyReplicas).toEqual(
      expect.objectContaining({
        expression: '${sourceDeployment.status.readyReplicas}',
        __isTemplate: true,
      })
    );
    expect(getMetadataField(resource, 'applyPolicy')).toEqual(
      expect.objectContaining({ strategy: 'create-or-patch' })
    );
    expect(getReadinessEvaluator(resource)).toBeFunction();
  });

  it('fails closed when Alchemy dependency wiring disagrees with the artifact record', async () => {
    const factory = await fixture().factory('direct', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources({ name: 'demo' });
    const dependent = declarations.find(
      (declaration) => declaration.props.resourceId === 'dependentConfig'
    )!;
    const restored = JSON.parse(JSON.stringify(dependent.props)) as TypeKroResourceProps<
      Enhanced<unknown, unknown>
    >;

    expect(() => resourceFromDirectArtifactRecordForTest(restored)).toThrow(
      'Direct artifact dependency mismatch'
    );
  });

  it('keeps secret-derived declaration state redacted and unwraps only for apply', async () => {
    const plaintext = 'alchemy-runtime-secret';
    const composition = toResourceGraph(
      {
        name: 'alchemy-sensitive-artifact',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'AlchemySensitiveArtifact',
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
        derivedConfig: simple.ConfigMap({
          id: 'derivedConfig',
          name: `${schema.spec.name}-config`,
          data: { token: schema.spec.token },
        }),
      }),
      () => ({ ready: true })
    );
    const factory = await composition.factory('direct', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources({
      name: 'credentials',
      token: plaintext,
    });

    expect(JSON.stringify(declarations)).not.toContain(plaintext);
    const credentials = declarations.find(
      (declaration) => declaration.props.resourceId === 'credentials'
    )!;
    const derived = declarations.find(
      (declaration) => declaration.props.resourceId === 'derivedConfig'
    )!;
    expect(credentials.props.artifactExecutionRecord).not.toContain(plaintext);
    expect(derived.props.artifactExecutionRecord).not.toContain(plaintext);
    expect(
      Redacted.isRedacted(
        (credentials.props.resource as { stringData?: { token?: unknown } }).stringData?.token
      )
    ).toBe(true);
    expect(
      Redacted.isRedacted((derived.props.resource as { data?: { token?: unknown } }).data?.token)
    ).toBe(true);

    const stateClone = cloneResourceForAlchemyStateForTest(credentials.props.resource);
    expect(
      Redacted.isRedacted((stateClone as { stringData?: { token?: unknown } }).stringData?.token)
    ).toBe(true);
    expect(JSON.stringify(stateClone)).not.toContain(plaintext);

    const materialized = resourceFromDirectArtifactRecordForTest(credentials.props)!;
    expect((materialized as { stringData?: { token?: unknown } }).stringData?.token).toBe(
      plaintext
    );
  });
});
