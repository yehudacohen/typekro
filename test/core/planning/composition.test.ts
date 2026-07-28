import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import {
  getMetadataField,
  getTemplateOverrides,
  setIncludeWhen,
  setMetadataField,
  setReadyWhen,
  setTemplateOverrides,
} from '../../../src/core/metadata/index.js';
import { registerFactory } from '../../../src/core/resources/factory-registry.js';
import {
  adapterCapabilityDiagnostics,
  artifactOutput,
  compileDirectArtifactPlan,
  compileKroArtifactPlan,
  decodeDesiredStatePlan,
  encodeDesiredStatePlan,
  expressionIR,
  kroArtifactPlanToGraphResources,
  planExpression,
  type SchemaNodeIR,
  SEMANTIC_PLAN_VERSION,
} from '../../../src/experimental-planning.js';
import {
  Cel,
  createResource,
  externalRef,
  kubernetesComposition,
  simple,
  singleton,
  toResourceGraph,
  withLabels,
} from '../../../src/index.js';

function objectFields(schema: SchemaNodeIR): string[] {
  return schema.kind === 'object' ? schema.properties.map((property) => property.name) : [];
}

describe('captured composition planning prototype', () => {
  const definition = {
    name: 'planning-fixture',
    apiVersion: 'testing.typekro.dev/v1alpha1',
    kind: 'PlanningFixture',
    revision: 'fixture-v1',
    spec: type({ name: 'string', image: 'string', replicas: 'number' }),
    status: type({ readyReplicas: 'number', summary: 'string' }),
  };

  it('plans declarative resources, identities, references, status, and three digest layers', () => {
    const composition = toResourceGraph(
      definition,
      (schema) => ({
        deployment: simple.Deployment({
          id: 'deployment',
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
        }),
      }),
      (schema, resources) => ({
        readyReplicas: resources.deployment.status.readyReplicas,
        summary: schema.spec.name,
      })
    );

    const inspection = composition.inspect!();
    const plan = composition.plan!(
      { name: 'demo', image: 'nginx:1.27', replicas: 2 },
      {
        strict: true,
        inputs: {
          environment: { kind: 'ordinary', value: 'test' },
          registry: { kind: 'sensitive', binding: 'registry-token', version: '2' },
        },
      }
    );

    expect(Object.keys(composition)).not.toContain('inspect');
    expect(Object.keys(composition)).not.toContain('plan');
    expect(inspection.composition).toEqual(
      expect.objectContaining({ name: definition.name, stability: 'stable' })
    );
    expect(plan.nodes.map((node) => node.id)).toEqual(['deployment']);
    expect(plan.nodes[0]?.identity).toEqual(
      expect.objectContaining({ apiVersion: 'apps/v1', kind: 'Deployment' })
    );
    expect(plan.inputs).toEqual([
      { name: 'environment', kind: 'ordinary', value: { kind: 'literal', value: 'test' } },
      { name: 'registry', kind: 'sensitive', binding: 'registry-token', version: '2' },
    ]);
    expect(plan.inputDigest).toHaveLength(64);
    expect(plan.aspectDigest).toHaveLength(64);
    expect(plan.semanticContentDigest).toHaveLength(64);
    expect(plan.planIdentityDigest).toHaveLength(64);
    expect(plan.planIdentityDigest).not.toBe(plan.semanticContentDigest);
    expect(JSON.stringify(plan)).not.toContain('nginx:1.27-registry-secret');
    expect(objectFields(plan.status.persistedSchema.root)).toEqual(['readyReplicas']);
    expect(objectFields(plan.status.hydratedSchema.root)).toEqual(['readyReplicas', 'summary']);
    expect(plan.status.projections).toEqual([
      expect.objectContaining({ path: 'readyReplicas', mode: 'native' }),
      expect.objectContaining({ path: 'summary', mode: 'client-only' }),
    ]);
    expect(plan.durability).toEqual(
      expect.objectContaining({ cacheEligible: true, provenanceEligible: true })
    );
  });

  it('plans explicit CEL over a canonical resource id and kind-specific top-level field', () => {
    const composition = toResourceGraph(
      {
        name: 'planning-config-data-status',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'PlanningConfigDataStatus',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ version: 'string' }),
      },
      (schema) => ({
        contractResource: simple.ConfigMap({
          id: 'installationContract',
          name: schema.spec.name,
          data: { version: '1.2.3' },
        }),
      }),
      () => ({
        version: Cel.expr<string>('installationContract.data.version'),
      })
    );

    const plan = composition.plan!({ name: 'demo' }, { strict: true });

    expect(objectFields(plan.status.persistedSchema.root)).toEqual(['version']);
    expect(plan.status.projections).toContainEqual(
      expect.objectContaining({
        path: 'version',
        source: 'live-resource',
        mode: 'native',
      })
    );
    expect(plan.outputs.version).toEqual(
      expect.objectContaining({
        kind: 'expression',
        expression: expect.objectContaining({
          expression: 'installationContract.data.version',
          references: [
            {
              source: 'resource',
              resourceId: 'installationContract',
              fieldPath: 'data.version',
            },
          ],
        }),
      })
    );
  });

  it('canonicalizes callback-key resource aliases in status projections', () => {
    const composition = toResourceGraph(
      {
        name: 'planning-config-alias-status',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'PlanningConfigAliasStatus',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ version: 'string' }),
      },
      (schema) => ({
        contractResource: simple.ConfigMap({
          id: 'installationContract',
          name: schema.spec.name,
          data: { version: '1.2.3' },
        }),
      }),
      () => ({
        version: Cel.expr<string>('contractResource.data.version'),
      })
    );

    const plan = composition.plan!({ name: 'demo' }, { strict: true });

    expect(plan.outputs.version).toEqual(
      expect.objectContaining({
        kind: 'expression',
        expression: expect.objectContaining({
          expression: 'installationContract.data.version',
          references: [
            {
              source: 'resource',
              resourceId: 'installationContract',
              fieldPath: 'data.version',
            },
          ],
        }),
      })
    );
    const artifact = compileKroArtifactPlan(plan);
    expect(JSON.stringify(artifact)).toContain('installationContract.data.version');
    expect(JSON.stringify(artifact)).not.toContain('contractResource.data.version');
  });

  it('rejects status projections derived through sensitive Secret resource fields', () => {
    const composition = toResourceGraph(
      {
        name: 'planning-secret-resource-status',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'PlanningSecretResourceStatus',
        revision: '1',
        spec: type({ name: 'string', token: 'string' }),
        status: type({ token: 'string' }),
      },
      (schema) => ({
        credentials: createResource(
          {
            id: 'credentials',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: schema.spec.name },
            data: { token: schema.spec.token },
          },
          { factoryName: 'secret' }
        ),
      }),
      () => ({
        token: Cel.expr<string>('credentials.data.token'),
      })
    );

    const plan = composition.plan!({ name: 'demo', token: 'plaintext' });

    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PLAN_STATUS_SENSITIVE',
        severity: 'error',
        path: '$.status.token',
      })
    );
    expect(() => composition.plan!({ name: 'demo', token: 'plaintext' }, { strict: true })).toThrow(
      'Strict semantic planning rejected the composition'
    );
  });

  it('preserves analyzer-owned references and source locations in expression IR', () => {
    const composition = toResourceGraph(
      {
        ...definition,
        name: 'planning-analyzer-metadata',
        kind: 'PlanningAnalyzerMetadata',
        status: type({ ready: 'boolean' }),
      },
      (schema) => ({
        deployment: simple.Deployment({
          id: 'deployment',
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
        }),
      }),
      (schema, resources) => ({
        ready: resources.deployment.status.readyReplicas >= schema.spec.replicas,
      })
    );

    const ready = composition.plan!({ name: 'demo', image: 'nginx:1.27', replicas: 2 }).outputs
      .ready;
    expect(ready).toEqual(
      expect.objectContaining({
        kind: 'expression',
        expression: expect.objectContaining({
          references: expect.arrayContaining([
            { source: 'resource', resourceId: 'deployment', fieldPath: 'status.readyReplicas' },
            { source: 'spec', fieldPath: 'replicas' },
          ]),
          sourceLocation: expect.objectContaining({ line: expect.any(Number) }),
        }),
      })
    );
  });

  it('gives imperative compositions the same public inspection and planning surface', () => {
    const composition = kubernetesComposition(definition, (spec) => {
      const deployment = simple.Deployment({
        id: 'deployment',
        name: spec.name,
        image: spec.image,
        replicas: spec.replicas,
      });
      return {
        readyReplicas: deployment.status.readyReplicas,
        summary: spec.name,
      };
    });

    expect(composition.inspect!().composition).toEqual(
      expect.objectContaining({ name: definition.name, stability: 'stable' })
    );
    expect(
      composition.plan!({ name: 'demo', image: 'nginx:1.27', replicas: 2 }).nodes.map(
        (node) => node.id
      )
    ).toEqual(['deployment']);
  });

  it('marks source-only composition identity as preview-unstable and changes semantic digests with inputs', () => {
    const { revision: _revision, ...previewDefinition } = definition;
    const composition = toResourceGraph(
      previewDefinition,
      (schema) => ({
        deployment: simple.Deployment({
          id: 'deployment',
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
        }),
      }),
      (schema, resources) => ({
        readyReplicas: resources.deployment.status.readyReplicas,
        summary: schema.spec.name,
      })
    );
    const spec = { name: 'demo', image: 'nginx:1.27', replicas: 2 };
    const left = composition.plan!(spec, {
      inputs: { environment: { kind: 'ordinary', value: 'test' } },
    });
    const right = composition.plan!(spec, {
      inputs: { environment: { kind: 'ordinary', value: 'production' } },
    });

    expect(left.composition.stability).toBe('preview-unstable');
    expect(left.version).toBe(SEMANTIC_PLAN_VERSION);
    expect(left.durability.cacheEligible).toBe(false);
    expect(left.inputDigest).not.toBe(right.inputDigest);
    expect(left.semanticContentDigest).not.toBe(right.semanticContentDigest);
    expect(left.planIdentityDigest).not.toBe(right.planIdentityDigest);
  });

  it('defers KRO-owned root status validation to the KRO compiler', () => {
    const composition = toResourceGraph(
      { ...definition, status: type({ conditions: 'string' }) },
      (schema) => ({
        deployment: simple.Deployment({
          id: 'deployment',
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
        }),
      }),
      () => ({ conditions: 'ready' })
    );

    const plan = composition.plan!(
      { name: 'demo', image: 'nginx:1.27', replicas: 2 },
      { strict: true }
    );

    expect(() => compileDirectArtifactPlan(plan)).not.toThrow();
    expect(() => compileKroArtifactPlan(plan)).toThrow('Cannot compile semantic plan for kro');
    expect(compileKroArtifactPlan(plan, { strict: false }).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'KRO_STATUS_FIELD_RESERVED', severity: 'error' })
    );
  });

  it('captures ordered aspects and normalizes factory plan options', () => {
    const composition = toResourceGraph(
      definition,
      (schema) => ({
        deployment: simple.Deployment({
          id: 'deployment',
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
        }),
      }),
      (schema, resources) => ({
        readyReplicas: resources.deployment.status.readyReplicas,
        summary: schema.spec.name,
      })
    );
    const aspects = [withLabels({ team: 'platform' }), withLabels({ environment: 'test' })];
    const plain = composition.plan!(
      { name: 'demo', image: 'nginx:1.27', replicas: 2 },
      { aspects }
    );
    const reversed = composition.plan!(
      { name: 'demo', image: 'nginx:1.27', replicas: 2 },
      { aspects: [...aspects].reverse() }
    );
    const factoryGraph = composition
      .factory('direct', { plan: { aspects } })
      .createResourceGraphForInstance({ name: 'demo', image: 'nginx:1.27', replicas: 2 });

    expect(plain.aspects.map((entry) => entry.order)).toEqual([0, 1]);
    expect(plain.aspectDigest).not.toBe(reversed.aspectDigest);
    expect(plain.semanticContentDigest).not.toBe(reversed.semanticContentDigest);
    expect(factoryGraph.resources[0]?.manifest.metadata?.labels).toEqual(
      expect.objectContaining({ environment: 'test', team: 'platform' })
    );
  });

  it('projects activation, readiness, dependency edges, and external lifecycle policies', () => {
    const composition = toResourceGraph(
      definition,
      (schema) => {
        const dependency = externalRef({
          id: 'platformConfig',
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'platform-config', namespace: 'default' },
        });
        const deployment = simple.Deployment({
          id: 'deployment',
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
        });
        const managedConfig = simple.ConfigMap({
          id: 'managedConfig',
          name: 'managed-config',
          data: { environment: 'test' },
        });
        deployment.dependsOn(managedConfig);
        setIncludeWhen(deployment, [schema.spec.replicas]);
        setReadyWhen(deployment, [deployment.status.readyReplicas]);
        return { dependency, deployment, managedConfig };
      },
      (schema, resources) => ({
        readyReplicas: resources.deployment.status.readyReplicas,
        summary: schema.spec.name,
      })
    );

    const plan = composition.plan!({ name: 'demo', image: 'nginx:1.27', replicas: 2 });
    const dependency = plan.nodes.find((node) => node.id === 'platformConfig');
    const deployment = plan.nodes.find((node) => node.id === 'deployment');

    expect(dependency?.lifecycle).toEqual(
      expect.objectContaining({
        creation: 'require-existing',
        management: 'reference-only',
        deletion: 'retain',
        sharing: 'shareable',
      })
    );
    expect(deployment?.activation).toHaveLength(1);
    expect(deployment?.readiness).toHaveLength(1);
    expect(plan.edges).toContainEqual({
      kind: 'ready',
      prerequisite: 'managedConfig',
      dependent: 'deployment',
    });
  });

  it('preserves imperative dependsOn and template overrides through KRO adaptation', () => {
    const composition = kubernetesComposition(definition, (spec) => {
      const dependency = simple.ConfigMap({
        id: 'managedConfig',
        name: 'managed-config',
        data: { environment: 'test' },
      });
      const deployment = simple.Deployment({
        id: 'deployment',
        name: spec.name,
        image: spec.image,
        replicas: spec.replicas,
      });
      deployment.dependsOn(dependency);
      setTemplateOverrides(deployment, [
        { propertyPath: 'spec.replicas', celExpression: '${schema.spec.replicas}' },
      ]);
      return { readyReplicas: deployment.status.readyReplicas, summary: spec.name };
    });

    const plan = composition.plan!({ name: 'demo', image: 'nginx:1.27', replicas: 2 });
    expect(plan.edges).toContainEqual({
      kind: 'ready',
      prerequisite: 'managedConfig',
      dependent: 'deployment',
    });

    const resources = kroArtifactPlanToGraphResources(compileKroArtifactPlan(plan));
    expect(getMetadataField(resources.deployment!, 'dependsOn')).toEqual([
      { resourceId: 'managedConfig' },
    ]);
    expect(getTemplateOverrides(resources.deployment!)).toEqual([
      { propertyPath: 'spec.replicas', celExpression: 'schema.spec.replicas' },
    ]);
  });

  it('preserves iteration and template overrides as explicit target-neutral semantics', () => {
    const composition = kubernetesComposition(
      {
        ...definition,
        name: 'planning-iteration',
        kind: 'PlanningIteration',
        spec: type({
          name: 'string',
          image: 'string',
          replicas: 'number',
          regions: 'string[]',
        }),
      },
      (spec) => {
        for (const region of spec.regions) {
          const deployment = simple.Deployment({
            id: 'deployment',
            name: `${spec.name}-${region}`,
            image: spec.image,
            replicas: spec.replicas,
          });
          setTemplateOverrides(deployment, [
            { propertyPath: 'spec.replicas', celExpression: '${schema.spec.replicas}' },
          ]);
        }
        return { readyReplicas: 0, summary: 'template' };
      }
    );
    const plan = composition.plan!({
      name: 'demo',
      image: 'nginx:1.27',
      replicas: 2,
      regions: ['east', 'west'],
    });
    const node = plan.nodes.find((candidate) => candidate.id === 'deployment');

    expect(node?.iteration).toEqual([
      {
        variable: 'region',
        collection: {
          kind: 'expression',
          expression: expect.objectContaining({ expression: 'schema.spec.regions' }),
        },
        itemPath: 'regions.$item',
      },
    ]);
    expect(node?.templateOverrides).toEqual([
      {
        propertyPath: 'spec.replicas',
        value: {
          kind: 'expression',
          expression: expect.objectContaining({ expression: 'schema.spec.replicas' }),
        },
      },
    ]);
    expect(decodeDesiredStatePlan(encodeDesiredStatePlan(plan))).toEqual(plan);
    const invalidIteration = JSON.parse(JSON.stringify(plan)) as {
      nodes: Array<{ id: string; iteration?: Array<{ itemPath: string }> }>;
    };
    invalidIteration.nodes.find((candidate) => candidate.id === 'deployment')!
      .iteration![0]!.itemPath = 'regions';
    expect(() => decodeDesiredStatePlan(JSON.stringify(invalidIteration))).toThrow(
      'Iteration itemPath must contain a $item segment'
    );
    expect(compileDirectArtifactPlan(plan).resources).toContainEqual(
      expect.objectContaining({
        iteration: node?.iteration,
        templateOverrides: node?.templateOverrides,
      })
    );
    expect(
      compileKroArtifactPlan(plan).resources.find((resource) => resource.role === 'kro-graph-child')
    ).toEqual(
      expect.objectContaining({
        iteration: node?.iteration,
        templateOverrides: node?.templateOverrides,
      })
    );
  });

  it('represents runtime closures as standalone-live capabilities independent of target', () => {
    const composition = toResourceGraph(
      definition,
      (schema) => ({
        deployment: simple.Deployment({
          id: 'deployment',
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
        }),
        providerCompatibility: async () => [],
      }),
      (schema, resources) => ({
        readyReplicas: resources.deployment.status.readyReplicas,
        summary: schema.spec.name,
      })
    );
    expect(composition.inspect!().potentialCapabilities).toContainEqual({
      id: 'typekro.runtime-closure',
      version: 1,
      host: 'standalone',
      output: 'live',
    });
    const plan = composition.plan!({ name: 'demo', image: 'nginx:1.27', replicas: 2 });
    expect(plan.nodes).toContainEqual(
      expect.objectContaining({ id: 'providerCompatibility', type: 'compatibility-closure' })
    );
    expect(plan.requiredCapabilities).toContainEqual(
      expect.objectContaining({
        id: 'typekro.runtime-closure',
        host: 'standalone',
        output: 'live',
      })
    );
    expect(() => compileDirectArtifactPlan(plan)).not.toThrow();
    expect(() => compileKroArtifactPlan(plan)).not.toThrow();
    expect(
      adapterCapabilityDiagnostics(plan.requiredCapabilities, {
        target: 'kro',
        host: 'standalone',
        output: 'live',
      })
    ).toEqual([]);
    expect(
      adapterCapabilityDiagnostics(plan.requiredCapabilities, {
        target: 'kro',
        host: null,
        output: 'static',
      })
    ).toEqual([expect.objectContaining({ code: 'ARTIFACT_CAPABILITY_UNSUPPORTED' })]);
    expect(
      adapterCapabilityDiagnostics(plan.requiredCapabilities, {
        target: 'direct',
        host: 'alchemy',
        output: 'live',
      })
    ).toEqual([expect.objectContaining({ code: 'ARTIFACT_CAPABILITY_UNSUPPORTED' })]);
  });

  it('projects singleton owner construction as explicit versioned requirements', () => {
    const operator = kubernetesComposition(
      {
        name: 'planning-operator',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'PlanningOperator',
        revision: '1',
        spec: type({ channel: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        simple.ConfigMap({
          id: 'operatorConfig',
          name: 'planning-operator',
          data: { channel: spec.channel },
        });
        return { ready: true };
      }
    );
    const consumer = kubernetesComposition(
      {
        name: 'planning-singleton-consumer',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'PlanningSingletonConsumer',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const shared = singleton(operator, {
          id: 'shared-operator',
          spec: { channel: 'stable' },
        });
        simple.ConfigMap({ id: 'consumerConfig', name: spec.name, data: { enabled: 'true' } });
        return { ready: shared.status.ready };
      }
    );

    const plan = consumer.plan!({ name: 'consumer' }, { strict: true });
    const singletonRequirements = plan.representationRequirements.filter(
      (requirement) => requirement.kind === 'singleton-owner'
    );

    expect(singletonRequirements.map((requirement) => requirement.target)).toEqual([
      'direct',
      'kro',
    ]);
    expect(singletonRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extension: 'typekro.singleton-owner',
          version: 1,
        }),
      ])
    );
    expect(JSON.stringify(singletonRequirements)).toContain('delete-when-unused');
    expect(JSON.stringify(singletonRequirements)).toContain('typekro.singleton-consumer-registry');
    const kroArtifacts = compileKroArtifactPlan(plan);
    const singletonArtifact = kroArtifacts.resources.find(
      (resource) => resource.role === 'singleton-owner'
    );
    expect(singletonArtifact?.lifecycle).toEqual(
      expect.objectContaining({
        creation: 'create',
        deletion: 'delete-when-unused',
        unusedEvidence: expect.objectContaining({
          provider: 'typekro.singleton-consumer-registry',
          inputs: expect.objectContaining({ kind: 'object' }),
        }),
      })
    );
    expect(JSON.stringify(singletonArtifact?.lifecycle.unusedEvidence?.inputs)).toContain(
      'typekro-singletons'
    );
    expect(kroArtifacts.edges).toContainEqual({
      kind: 'existence',
      prerequisite: singletonArtifact?.id,
      dependent: '__typekro_instance__',
    });
    expect(kroArtifacts.edges).toContainEqual({
      kind: 'existence',
      prerequisite: singletonArtifact?.id,
      dependent: '__typekro_rgd__',
    });
    expect(plan.requiredCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'typekro.singleton-owner', target: 'direct' }),
        expect.objectContaining({ id: 'typekro.singleton-owner', target: 'kro' }),
      ])
    );
  });

  it('compiles no-spec singleton bundles without concretizing forwarded instance values', () => {
    const operator = kubernetesComposition(
      {
        name: 'planning-symbolic-operator',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'PlanningSymbolicOperator',
        revision: '1',
        spec: type({ channel: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        simple.ConfigMap({
          id: 'operatorConfig',
          name: 'planning-symbolic-operator',
          data: { channel: spec.channel },
        });
        return { ready: true };
      }
    );
    const consumer = kubernetesComposition(
      {
        name: 'planning-symbolic-consumer',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'PlanningSymbolicConsumer',
        revision: '1',
        spec: type({ name: 'string', 'operator?': { 'channel?': 'string' } }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const shared = singleton(operator, {
          id: 'shared-operator',
          spec: { channel: spec.operator?.channel ?? 'stable' },
        });
        simple.ConfigMap({ id: 'consumerConfig', name: spec.name, data: { enabled: 'true' } });
        return { ready: shared.status.ready };
      }
    );

    const yaml = consumer.toYaml();

    expect(yaml.match(/kind: ResourceGraphDefinition/g)).toHaveLength(2);
    expect(yaml).toContain('planning-symbolic-operator');
    expect(yaml).toContain('planning-symbolic-consumer');
  });

  it('reports only realized raw-expression, sensitive, and artifact capabilities', () => {
    const composition = toResourceGraph(
      definition,
      (schema) => ({
        deployment: simple.Deployment({
          id: 'deployment',
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
        }),
      }),
      (schema, resources) => ({
        readyReplicas: resources.deployment.status.readyReplicas,
        summary: schema.spec.name,
      })
    );
    const plan = composition.plan!(
      { name: 'demo', image: 'nginx:1.27', replicas: 2 },
      {
        inputs: {
          condition: {
            kind: 'ordinary',
            value: planExpression(expressionIR('has(schema.spec.name)', { language: 'raw-cel' })),
          },
          token: { kind: 'sensitive', binding: 'registry-token' },
          imageBundle: {
            kind: 'artifact',
            requirement: {
              kind: 'container-image',
              id: 'web-image',
              descriptor: { kind: 'literal', value: 'web' },
              outputs: ['digest'],
            },
          },
        },
      }
    );

    expect(plan.requiredCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'typekro.raw-cel', target: 'kro' }),
        expect.objectContaining({ id: 'typekro.sensitive-materialization' }),
        expect.objectContaining({
          id: 'typekro.artifact-input',
          host: 'alchemy',
          output: 'live',
        }),
      ])
    );
  });

  it('rejects artifact outputs that are not declared by the input manifest', () => {
    const composition = kubernetesComposition(
      {
        name: 'artifact-output-validation',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'ArtifactOutputValidation',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        createResource({
          id: 'workload',
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: spec.name },
          spec: {
            selector: { matchLabels: { app: spec.name } },
            template: {
              metadata: { labels: { app: spec.name } },
              spec: {
                containers: [{ name: 'app', image: artifactOutput('build', 'image') }],
              },
            },
          },
        });
        return { ready: true };
      }
    );

    const undeclaredRequirement = composition.plan!({ name: 'demo' }, { strict: false });
    expect(undeclaredRequirement.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'PLAN_ARTIFACT_OUTPUT_REQUIREMENT_UNDECLARED' })
    );
    const undeclaredOutput = composition.plan!(
      { name: 'demo' },
      {
        strict: false,
        inputs: {
          image: {
            kind: 'artifact',
            requirement: {
              kind: 'container-image',
              id: 'build',
              descriptor: { kind: 'literal', value: 'demo' },
              outputs: ['digest'],
            },
          },
        },
      }
    );
    expect(undeclaredOutput.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'PLAN_ARTIFACT_OUTPUT_UNDECLARED' })
    );
  });

  it('diagnoses ambient composition effects before strict execution', () => {
    const composition = kubernetesComposition(
      {
        name: 'ambient-effect-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'AmbientEffectFixture',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        simple.ConfigMap({
          id: 'config',
          name: spec.name,
          data: { nonce: String(Math.random()) },
        });
        return { ready: true };
      }
    );

    expect(composition.plan!({ name: 'demo' }).diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PLAN_AMBIENT_EFFECT_UNSUPPORTED',
        severity: 'error',
      })
    );
    expect(() => composition.plan!({ name: 'demo' }, { strict: true })).toThrow();
  });

  it('rejects sensitive expression derivations from status', () => {
    const composition = toResourceGraph(
      {
        name: 'sensitive-status-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'SensitiveStatusFixture',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ leaked: 'unknown' }),
      },
      (schema) => ({
        config: simple.ConfigMap({ id: 'config', name: schema.spec.name, data: {} }),
      }),
      () => ({
        leaked: planExpression(expressionIR('sensitive.value', { sensitivity: 'sensitive' })),
      })
    );

    expect(composition.plan!({ name: 'demo' }).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'PLAN_STATUS_SENSITIVE', severity: 'error' })
    );
    expect(() => composition.plan!({ name: 'demo' }, { strict: true })).toThrow(
      'Strict semantic planning rejected the composition'
    );
  });

  it('runs identified desired canonicalizers and detects ambient nondeterminism', () => {
    registerFactory({
      factoryName: 'CanonicalWidget',
      kind: 'CanonicalWidget',
      apiVersion: 'testing.typekro.dev/v1',
      desiredCanonicalizer: {
        id: 'testing.canonical-widget',
        revision: '1',
        canonicalize: (resource) => ({ ...resource, spec: { normalized: true } }),
      },
    });
    const composition = toResourceGraph(
      {
        name: 'canonicalizer-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'CanonicalizerFixture',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => ({
        widget: createResource({
          id: 'widget',
          apiVersion: 'testing.typekro.dev/v1',
          kind: 'CanonicalWidget',
          metadata: { name: schema.spec.name },
          spec: { normalized: false },
        }),
      }),
      () => ({ ready: true })
    );
    const plan = composition.plan!({ name: 'demo' }, { strict: true });

    expect(plan.provenance.canonicalizers).toEqual([
      {
        id: 'testing.canonical-widget',
        revision: '1',
        stage: 'desired',
        factoryName: 'CanonicalWidget',
      },
    ]);
    expect(JSON.stringify(plan.nodes[0]?.desired)).toContain('normalized');

    const sameKindOtherGroup = toResourceGraph(
      {
        name: 'other-group-canonicalizer-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'OtherGroupCanonicalizerFixture',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => ({
        widget: createResource({
          id: 'widget',
          apiVersion: 'other.typekro.dev/v1',
          kind: 'CanonicalWidget',
          metadata: { name: schema.spec.name },
          spec: { normalized: false },
        }),
      }),
      () => ({ ready: true })
    );
    const otherPlan = sameKindOtherGroup.plan!({ name: 'demo' }, { strict: true });
    expect(otherPlan.provenance.canonicalizers).toEqual([]);
    expect(JSON.stringify(otherPlan.nodes[0]?.desired)).toContain('false');

    let invocation = 0;
    registerFactory({
      factoryName: 'NondeterministicWidget',
      kind: 'NondeterministicWidget',
      apiVersion: 'testing.typekro.dev/v1',
      desiredCanonicalizer: {
        id: 'testing.nondeterministic-widget',
        revision: '1',
        canonicalize: (resource) => ({ ...resource, spec: { invocation: invocation++ } }),
      },
    });
    const nondeterministic = toResourceGraph(
      {
        name: 'nondeterministic-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'NondeterministicFixture',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => ({
        widget: createResource({
          id: 'widget',
          apiVersion: 'testing.typekro.dev/v1',
          kind: 'NondeterministicWidget',
          metadata: { name: schema.spec.name },
          spec: {},
        }),
      }),
      () => ({ ready: true })
    );

    expect(() => nondeterministic.plan!({ name: 'demo' }, { strict: true })).toThrow(
      'Planning produced nondeterministic semantic content'
    );
  });

  it('uses exact factory provenance when multiple factories share a GVK', () => {
    registerFactory({
      factoryName: 'ProvenanceWidgetA',
      kind: 'ProvenanceWidget',
      apiVersion: 'testing.typekro.dev/v1',
      desiredCanonicalizer: {
        id: 'testing.provenance-widget',
        revision: '1',
        canonicalize: (resource) => ({ ...resource, spec: { selected: 'a' } }),
      },
    });
    registerFactory({
      factoryName: 'ProvenanceWidgetB',
      kind: 'ProvenanceWidget',
      apiVersion: 'testing.typekro.dev/v1',
      desiredCanonicalizer: {
        id: 'testing.provenance-widget',
        revision: '1',
        canonicalize: (resource) => ({ ...resource, spec: { selected: 'b' } }),
      },
    });
    const makeComposition = (factoryName?: string) =>
      toResourceGraph(
        {
          name: `factory-provenance-${factoryName ?? 'ambiguous'}`,
          apiVersion: 'testing.typekro.dev/v1alpha1',
          kind: 'FactoryProvenanceFixture',
          revision: '1',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (schema) => ({
          widget: createResource(
            {
              id: 'widget',
              apiVersion: 'testing.typekro.dev/v1',
              kind: 'ProvenanceWidget',
              metadata: { name: schema.spec.name },
              spec: {},
            },
            factoryName ? { factoryName } : undefined
          ),
        }),
        () => ({ ready: true })
      );

    const exact = makeComposition('ProvenanceWidgetB').plan!({ name: 'demo' }, { strict: true });
    expect(exact.provenance.canonicalizers).toEqual([
      {
        id: 'testing.provenance-widget',
        revision: '1',
        stage: 'desired',
        factoryName: 'ProvenanceWidgetB',
      },
    ]);
    expect(JSON.stringify(exact.nodes[0]?.desired)).toContain('"b"');

    const ambiguous = makeComposition().plan!({ name: 'demo' });
    expect(ambiguous.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PLAN_FACTORY_PROVENANCE_AMBIGUOUS',
        severity: 'error',
      })
    );
    expect(() => makeComposition().plan!({ name: 'demo' }, { strict: true })).toThrow(
      'Strict semantic planning rejected the composition'
    );
  });

  it('captures deterministic requirements from the factory that created a resource', () => {
    registerFactory({
      factoryName: 'RepresentedWidget',
      kind: 'RepresentedWidget',
      apiVersion: 'testing.typekro.dev/v1',
      representationRequirements: {
        id: 'testing.represented-widget.requirements',
        revision: '1',
        produce: (resource) => [
          {
            target: 'kro',
            kind: 'widget-prerequisite',
            extension: 'testing.represented-widget',
            version: 1,
            inputs: { name: resource.metadata.name },
          },
        ],
      },
    });
    const composition = toResourceGraph(
      {
        name: 'factory-requirement-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'FactoryRequirementFixture',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => ({
        widget: createResource(
          {
            id: 'widget',
            apiVersion: 'testing.typekro.dev/v1',
            kind: 'RepresentedWidget',
            metadata: { name: schema.spec.name },
            spec: {},
          },
          { factoryName: 'RepresentedWidget' }
        ),
      }),
      () => ({ ready: true })
    );

    const plan = composition.plan!({ name: 'demo' }, { strict: true });
    expect(plan.representationRequirements).toEqual([
      expect.objectContaining({
        target: 'kro',
        kind: 'widget-prerequisite',
        extension: 'testing.represented-widget',
        version: 1,
        sourceNodeId: 'widget',
        factoryName: 'RepresentedWidget',
      }),
    ]);
    expect(plan.representationRequirements[0]?.inputs).toEqual(
      expect.objectContaining({
        kind: 'object',
        entries: expect.arrayContaining([
          {
            key: 'name',
            value: { kind: 'reference', source: 'spec', fieldPath: 'name' },
          },
        ]),
      })
    );
    expect(plan.requiredCapabilities).toContainEqual(
      expect.objectContaining({
        id: 'testing.represented-widget',
        version: 1,
        target: 'kro',
      })
    );
  });

  it('redacts inline Secret bytes from serializable plans and requires named bindings', () => {
    const plaintext = 'semantic-secret-value';
    const composition = toResourceGraph(
      {
        name: 'secret-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'SecretFixture',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => ({
        secret: simple.Secret({
          id: 'secret',
          name: schema.spec.name,
          stringData: { password: plaintext },
        }),
      }),
      () => ({ ready: true })
    );
    const plan = composition.plan!({ name: 'demo-secret' });
    const serialized = JSON.stringify(plan);

    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain(Buffer.from(plaintext).toString('base64'));
    expect(serialized).toContain('inline-secret/secret/data/password');
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PLAN_INLINE_SECRET_REQUIRES_BINDING',
        severity: 'error',
      })
    );
    expect(() => composition.plan!({ name: 'demo-secret' }, { strict: true })).toThrow(
      'Strict semantic planning rejected the composition'
    );
  });

  it('preserves explicitly public Secret placeholders while diagnosing the declassification', () => {
    const placeholder = 'documented-local-placeholder';
    const composition = toResourceGraph(
      {
        name: 'public-secret-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'PublicSecretFixture',
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => {
        const publicSecret = createResource(
          {
            id: 'publicSecret',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: schema.spec.name },
            stringData: { password: placeholder },
          },
          { factoryName: 'secret' }
        );
        setMetadataField(publicSecret, 'secretMaterial', 'public-placeholder');
        return { publicSecret };
      },
      () => ({ ready: true })
    );

    const plan = composition.plan!({ name: 'demo-public-secret' }, { strict: true });

    expect(JSON.stringify(plan)).toContain(placeholder);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PLAN_PUBLIC_SECRET_PLACEHOLDER',
        severity: 'warning',
      })
    );
    expect(plan.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'PLAN_INLINE_SECRET_REQUIRES_BINDING' })
    );
  });

  it('preserves symbolic Secret sources, redacts bound spec bytes, and propagates status taint', () => {
    const plaintext = 'instance-secret-token';
    const composition = toResourceGraph(
      {
        name: 'symbolic-secret-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'SymbolicSecretFixture',
        revision: '1',
        spec: type({ name: 'string', token: 'string' }),
        status: type({ token: 'string' }),
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
      (schema) => ({ token: schema.spec.token })
    );

    const plan = composition.plan!({ name: 'demo-secret', token: plaintext });
    const inspection = composition.inspect!();
    const encoded = encodeDesiredStatePlan(plan);
    const decoded = decodeDesiredStatePlan(encoded);
    const kroResources = kroArtifactPlanToGraphResources(compileKroArtifactPlan(plan));

    expect(encoded).not.toContain(plaintext);
    expect(plan.spec).toEqual(
      expect.objectContaining({
        kind: 'object',
        entries: expect.arrayContaining([
          {
            key: 'token',
            value: { kind: 'sensitive-binding', binding: 'spec/token' },
          },
        ]),
      })
    );
    expect(decoded.nodes[0]?.desired).toEqual(
      expect.objectContaining({
        kind: 'object',
        entries: expect.arrayContaining([
          expect.objectContaining({
            key: 'stringData',
            value: expect.objectContaining({
              entries: [
                {
                  key: 'token',
                  value: {
                    kind: 'sensitive-value',
                    value: { kind: 'reference', source: 'spec', fieldPath: 'token' },
                  },
                },
              ],
            }),
          }),
        ]),
      })
    );
    expect(
      (kroResources.credentials as { stringData?: { token?: unknown } }).stringData?.token
    ).toEqual(expect.objectContaining({ resourceId: '__schema__', fieldPath: 'spec.token' }));
    expect(JSON.stringify(kroResources)).not.toContain(plaintext);
    expect(plan.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'PLAN_INLINE_SECRET_REQUIRES_BINDING' })
    );
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'PLAN_STATUS_SENSITIVE', severity: 'error' })
    );
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'PLAN_STATUS_SENSITIVE', path: '$.status.token' })
    );
    expect(inspection.potentialCapabilities).toContainEqual(
      expect.objectContaining({ id: 'typekro.sensitive-materialization', version: 1 })
    );
    expect(() =>
      composition.plan!({ name: 'demo-secret', token: plaintext }, { strict: true })
    ).toThrow('Strict semantic planning rejected the composition');
  });

  it('rejects sensitive spec data used as Kubernetes identity', () => {
    const composition = toResourceGraph(
      {
        name: 'sensitive-identity-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'SensitiveIdentityFixture',
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
        leakedIdentity: simple.ConfigMap({
          id: 'leakedIdentity',
          name: schema.spec.token,
          data: { safe: 'value' },
        }),
      }),
      () => ({ ready: true })
    );

    const plan = composition.plan!({ name: 'credentials', token: 'must-not-be-a-name' });
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PLAN_SENSITIVE_IDENTITY',
        path: '$.nodes.leakedIdentity.identity.name',
      })
    );
    expect(() =>
      composition.plan!({ name: 'credentials', token: 'must-not-be-a-name' }, { strict: true })
    ).toThrow('Strict semantic planning rejected the composition');
  });

  it('rejects sensitive spec data used for activation or readiness control flow', () => {
    const composition = toResourceGraph(
      {
        name: 'sensitive-control-flow-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'SensitiveControlFlowFixture',
        revision: '1',
        spec: type({ name: 'string', enabled: 'boolean' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => {
        const credentials = createResource(
          {
            id: 'credentials',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: schema.spec.name },
            stringData: { enabled: schema.spec.enabled as unknown as string },
          },
          { factoryName: 'secret' }
        );
        const controlled = simple.Deployment({
          id: 'controlled',
          name: 'controlled',
          image: 'nginx:1.27',
          replicas: 1,
        });
        setIncludeWhen(controlled, [schema.spec.enabled]);
        setReadyWhen(controlled, [
          planExpression(
            expressionIR('schema.spec.enabled', {
              sensitivity: 'sensitive',
              references: [{ source: 'spec', fieldPath: 'enabled' }],
            })
          ),
        ]);
        return { credentials, controlled };
      },
      () => ({ ready: true })
    );

    const plan = composition.plan!({ name: 'credentials', enabled: true });
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PLAN_SENSITIVE_CONTROL_FLOW',
          path: '$.nodes.controlled.activation[0]',
          details: expect.objectContaining({ controlFlow: 'activation', sensitivePath: 'enabled' }),
        }),
        expect.objectContaining({
          code: 'PLAN_SENSITIVE_CONTROL_FLOW',
          path: '$.nodes.controlled.readiness[0]',
          details: expect.objectContaining({ controlFlow: 'readiness', sensitivePath: 'enabled' }),
        }),
      ])
    );
    expect(() =>
      composition.plan!({ name: 'credentials', enabled: true }, { strict: true })
    ).toThrow('Strict semantic planning rejected the composition');
  });

  it('rejects sensitive spec collections used for iteration cardinality', () => {
    const composition = kubernetesComposition(
      {
        name: 'sensitive-iteration-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'SensitiveIterationFixture',
        revision: '1',
        spec: type({ name: 'string', tokens: 'string[]' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        createResource(
          {
            id: 'credentials',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: spec.name },
            stringData: { tokens: spec.tokens as unknown as string },
          },
          { factoryName: 'secret' }
        );
        for (const token of spec.tokens) {
          simple.ConfigMap({
            id: 'perToken',
            name: `${spec.name}-${token}`,
            data: { safe: 'value' },
          });
        }
        return { ready: true };
      }
    );

    const plan = composition.plan!({ name: 'credentials', tokens: ['first', 'second'] });
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PLAN_SENSITIVE_CONTROL_FLOW',
        path: '$.nodes.perToken.iteration[0].collection',
        details: expect.objectContaining({ controlFlow: 'iteration', sensitivePath: 'tokens' }),
      })
    );
  });
});
