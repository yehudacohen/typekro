import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import * as Redacted from 'effect/Redacted';

import {
  cloneResourceForAlchemyStateForTest,
  resourceFromDirectArtifactRecordForTest,
} from '../../../src/alchemy/resource-registration.js';
import type { TypeKroResourceProps } from '../../../src/alchemy/types.js';
import { Cel, createResource, simple, toResourceGraph } from '../../../src/index.js';
import { getMetadataField, getReadinessEvaluator } from '../../../src/core/metadata/index.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
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
      Redacted.isRedacted(
        (derived.props.resource as { data?: { token?: unknown } }).data?.token
      )
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
