import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { getReadinessEvaluator, getResourceId } from '../../../src/core/metadata/index.js';
import { resolvePortableReadinessStrategy } from '../../../src/core/readiness/index.js';
import {
  canonicalDigest,
  compileDirectArtifactPlan,
  compileKroArtifactPlan,
  createDirectArtifactExecutionRecord,
  createKroArtifactBundle,
  type DirectApplicationArtifact,
  decodeArtifactPlan,
  decodeDirectArtifactExecutionRecord,
  decodeDirectArtifactPlan,
  decodeKroArtifactBundle,
  decodeKroArtifactPlan,
  directArtifactPlanToResourceGraph,
  encodeArtifactPlan,
  encodeDirectArtifactExecutionRecord,
  encodeKroArtifactBundle,
  type KroGraphChildArtifact,
  kroArtifactPlanToGraphResources,
  kroArtifactPlanToInstanceResource,
  kroArtifactPlanToSupportingResources,
  lowerPlanValue,
  materializeKroArtifactBundleOperation,
  materializePlanValue,
  orderKroArtifactBundleOperations,
  sensitiveValue,
} from '../../../src/experimental-planning.js';
import { createResource, externalRef, kubernetesComposition, simple } from '../../../src/index.js';
import { isKubernetesRef } from '../../../src/utils/type-guards.js';

const compilerFixture = kubernetesComposition(
  {
    name: 'artifact-compiler-fixture',
    apiVersion: 'testing.typekro.dev/v1alpha1',
    kind: 'ArtifactCompilerFixture',
    revision: '1',
    spec: type({ name: 'string', namespace: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const observed = externalRef<Record<string, never>, { endpoint: string }>({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'platform-input', namespace: spec.namespace },
      id: 'platformInput',
    });
    const config = simple.ConfigMap({
      id: 'applicationConfig',
      name: spec.name,
      namespace: spec.namespace,
      data: { source: observed.status.endpoint },
    });
    return { ready: config.metadata.name === spec.name };
  }
);

describe('semantic artifact compilers', () => {
  it('expands canonical iteration dimensions and pairs dependencies by coordinate', () => {
    const composition = kubernetesComposition(
      {
        name: 'artifact-iteration-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'ArtifactIterationFixture',
        revision: '1',
        spec: type({ name: 'string', image: 'string', regions: 'string[]' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        for (const region of spec.regions) {
          const config = simple.ConfigMap({
            id: 'regionConfig',
            name: `${spec.name}-${region}-config`,
            data: { region },
          });
          const consumer = simple.ConfigMap({
            id: 'regionConsumer',
            name: `${spec.name}-${region}-consumer`,
            data: { image: spec.image },
          });
          consumer.dependsOn(config);
        }
        return { ready: true };
      }
    );
    const spec = { name: 'demo', image: 'nginx:1.27', regions: ['east', 'west'] };
    const plan = composition.plan!(spec, { strict: true });
    const artifacts = decodeDirectArtifactPlan(encodeArtifactPlan(compileDirectArtifactPlan(plan)));
    const invalidArtifact = JSON.parse(encodeArtifactPlan(artifacts)) as {
      resources: Array<{ iteration?: Array<{ itemPath: string }> }>;
    };
    const invalidDimension = invalidArtifact.resources.find((resource) => resource.iteration)
      ?.iteration?.[0];
    expect(invalidDimension).toBeDefined();
    invalidDimension!.itemPath = 'regions';
    expect(() => decodeDirectArtifactPlan(JSON.stringify(invalidArtifact))).toThrow(
      'Iteration itemPath must contain a $item segment'
    );
    const graph = directArtifactPlanToResourceGraph(artifacts, {
      instanceName: 'demo',
      spec,
      resolveReadinessStrategy: resolvePortableReadinessStrategy,
    });

    expect(plan.nodes.every((node) => node.iteration?.[0]?.itemPath === 'regions.$item')).toBe(
      true
    );
    expect(graph.resources.map(({ manifest }) => manifest.metadata.name).sort()).toEqual([
      'demo-east-config',
      'demo-east-consumer',
      'demo-west-config',
      'demo-west-consumer',
    ]);
    const graphIdByName = new Map(
      graph.resources.map(({ id, manifest }) => [manifest.metadata.name, id] as const)
    );
    for (const region of spec.regions) {
      const consumerId = graphIdByName.get(`demo-${region}-consumer`);
      const configId = graphIdByName.get(`demo-${region}-config`);
      expect(consumerId).toBeDefined();
      expect(configId).toBeDefined();
      expect(graph.dependencyGraph.getDependencies(consumerId!)).toEqual([configId!]);
    }
  });

  it('captures compound conditional branches as real symbolic manifests', () => {
    const composition = kubernetesComposition(
      {
        name: 'artifact-conditional-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'ArtifactConditionalFixture',
        revision: '1',
        spec: type({
          name: 'string',
          environment: '"production" | "staging"',
          ingress: type({ enabled: 'boolean' }),
        }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        if (spec.ingress.enabled && spec.environment === 'production') {
          simple.ConfigMap({
            id: 'publicService',
            name: `${spec.name}-public`,
            data: { app: spec.name, port: '443' },
          });
        }
        return { ready: true };
      }
    );
    const productionSpec = {
      name: 'demo',
      environment: 'production' as const,
      ingress: { enabled: true },
    };
    const plan = composition.plan!(productionSpec, { strict: true });
    const service = plan.nodes.find((node) => node.id === 'publicService');
    const serializedDesired = JSON.stringify(service?.desired);

    expect(service?.activation).toEqual([
      expect.objectContaining({
        kind: 'expression',
        expression: expect.objectContaining({
          expression: 'schema.spec.ingress.enabled && schema.spec.environment == "production"',
        }),
      }),
    ]);
    expect(serializedDesired).toContain('port');
    expect(serializedDesired).toContain('fieldPath":"name"');
    expect(serializedDesired).not.toContain('"value":"publicService"');

    const direct = compileDirectArtifactPlan(plan);
    expect(
      directArtifactPlanToResourceGraph(direct, {
        instanceName: 'demo',
        spec: productionSpec,
        resolveReadinessStrategy: resolvePortableReadinessStrategy,
      }).resources[0]?.manifest.metadata.name
    ).toBe('demo-public');
    expect(
      directArtifactPlanToResourceGraph(direct, {
        instanceName: 'demo',
        spec: { ...productionSpec, environment: 'staging' },
        resolveReadinessStrategy: resolvePortableReadinessStrategy,
      }).resources
    ).toEqual([]);
    expect(
      compileKroArtifactPlan(plan).resources.find((resource) => resource.role === 'kro-graph-child')
    ).toEqual(
      expect.objectContaining({
        desired: service?.desired,
        readiness: expect.objectContaining({ activation: service?.activation }),
      })
    );
  });

  it('keeps apply policy out of semantic nodes and attaches it to direct operations', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    expect(plan.nodes.every((node) => !('apply' in node))).toBe(true);
    expect(plan.spec).toEqual(
      expect.objectContaining({
        kind: 'object',
      })
    );
    expect(plan.schemas.spec.digest).toBe(plan.schemas.specDigest);

    const artifacts = compileDirectArtifactPlan(plan);
    const application = artifacts.resources.find(
      (resource): resource is DirectApplicationArtifact => resource.role === 'application-resource'
    );
    const observed = artifacts.resources.find((resource) => resource.role === 'external-reference');

    expect(application?.apply).toEqual({
      strategy: 'create-or-patch',
      existingResource: 'patch',
      immutableFieldPolicy: 'fail',
    });
    expect(application?.identity?.scope).toBe('namespaced');
    expect(observed).not.toHaveProperty('apply');
  });

  it('adapts direct artifacts into the established deployment graph without losing references', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const artifacts = compileDirectArtifactPlan(plan);
    const graph = directArtifactPlanToResourceGraph(artifacts, {
      instanceName: 'demo',
      spec: { name: 'demo', namespace: 'apps' },
      resolveReadinessStrategy: resolvePortableReadinessStrategy,
    });

    expect(graph.resources).toHaveLength(1);
    expect(graph.externalReferences).toHaveLength(1);
    expect(graph.externalReferences?.[0]).toEqual(
      expect.objectContaining({
        id: 'platformInput',
        manifest: expect.objectContaining({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: expect.objectContaining({ name: 'platform-input', namespace: 'apps' }),
        }),
      })
    );
    const manifest = graph.resources[0]!.manifest;
    expect(getResourceId(manifest)).toBe('applicationConfig');
    expect(manifest.metadata.namespace).toBe('apps');
    const source = (manifest as { data?: { source?: unknown } }).data?.source;
    expect(isKubernetesRef(source)).toBe(true);
    expect(source).toEqual(
      expect.objectContaining({ resourceId: 'platformInput', fieldPath: 'status.endpoint' })
    );
    expect(graph.dependencyGraph.getNodes().size).toBe(1);
    expect(getReadinessEvaluator(manifest)?.(manifest)).toEqual({
      ready: true,
      message: 'ConfigMap is ready (configuration resource)',
    });
  });

  it('filters inactive direct artifacts before materializing Kubernetes identity', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const artifacts = compileDirectArtifactPlan(plan);
    const application = artifacts.resources.find(
      (resource): resource is DirectApplicationArtifact => resource.role === 'application-resource'
    );
    expect(application).toBeDefined();
    if (!application) return;
    const conditional: DirectApplicationArtifact = {
      ...application,
      desired: lowerPlanValue({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { namespace: 'apps' },
      }).value,
      readiness: {
        ...application.readiness,
        activation: [
          {
            kind: 'reference',
            source: 'spec',
            fieldPath: 'enabled',
            optional: true,
          },
        ],
      },
    };
    const conditionalPlan = { ...artifacts, resources: [conditional], edges: [] };

    expect(
      directArtifactPlanToResourceGraph(conditionalPlan, {
        instanceName: 'demo',
        spec: { name: 'demo', namespace: 'apps' },
      }).resources
    ).toEqual([]);
    expect(() =>
      directArtifactPlanToResourceGraph(conditionalPlan, {
        instanceName: 'demo',
        spec: { name: 'demo', namespace: 'apps', enabled: true },
      })
    ).toThrow('missing Kubernetes identity fields');
  });

  it('rehydrates portable built-in readiness from canonical artifact JSON', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    expect(plan.nodes.find((node) => node.id === 'applicationConfig')?.readinessStrategy).toEqual(
      expect.objectContaining({
        kind: 'registered',
        id: 'typekro.readiness.always',
        revision: '1',
      })
    );
    const artifacts = decodeDirectArtifactPlan(encodeArtifactPlan(compileDirectArtifactPlan(plan)));
    const graph = directArtifactPlanToResourceGraph(artifacts, {
      instanceName: 'demo',
      spec: { name: 'demo', namespace: 'apps' },
      resolveReadinessStrategy: resolvePortableReadinessStrategy,
    });
    const manifest = graph.resources[0]!.manifest;

    expect(getReadinessEvaluator(manifest)?.(manifest)).toEqual({
      ready: true,
      message: 'ConfigMap is ready (configuration resource)',
    });
  });

  it('round-trips a concrete per-resource execution record and rejects drift', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const artifacts = compileDirectArtifactPlan(plan);
    const record = createDirectArtifactExecutionRecord(artifacts, 'applicationConfig', {
      spec: { name: 'demo', namespace: 'apps' },
    });
    const encoded = encodeDirectArtifactExecutionRecord(record);

    expect(decodeDirectArtifactExecutionRecord(encoded)).toEqual(record);
    expect(JSON.stringify(record.artifact.desired)).toContain('platformInput');

    const corrupted = JSON.parse(encoded) as {
      artifact: { id: string };
    };
    corrupted.artifact.id = 'changed-after-fan-out';
    expect(() => decodeDirectArtifactExecutionRecord(JSON.stringify(corrupted))).toThrow(
      'digest does not match'
    );
  });

  it('requires explicit values for sensitive materialization bindings', () => {
    const value = sensitiveValue('database-password', '2');
    expect(() => materializePlanValue(value)).toThrow(
      'Sensitive binding database-password was not supplied'
    );
    expect(materializePlanValue(value, { sensitive: { 'database-password': 'resolved' } })).toBe(
      'resolved'
    );
  });

  it('materializes tainted symbolic Secret values without serializing their bound bytes', () => {
    const plaintext = 'direct-runtime-secret';
    const composition = kubernetesComposition(
      {
        name: 'direct-sensitive-source-fixture',
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'DirectSensitiveSourceFixture',
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
    const spec = { name: 'credentials', token: plaintext };
    const plan = composition.plan!(spec);
    expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const artifacts = decodeDirectArtifactPlan(encodeArtifactPlan(compileDirectArtifactPlan(plan)));
    const encodedArtifact = encodeArtifactPlan(artifacts);
    const graph = directArtifactPlanToResourceGraph(artifacts, {
      instanceName: 'credentials',
      spec,
    });

    expect(encodedArtifact).not.toContain(plaintext);
    expect(graph.resources[0]?.manifest.stringData).toEqual({ token: plaintext });

    const record = createDirectArtifactExecutionRecord(artifacts, 'credentials', { spec });
    expect(encodeDirectArtifactExecutionRecord(record)).not.toContain(plaintext);
    expect(record.artifact.desired).toEqual(expect.objectContaining({ kind: 'object' }));
  });

  it('keeps apply selection out of semantic identity but includes it in artifact identity', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const legacy = compileDirectArtifactPlan(plan);
    const ssa = compileDirectArtifactPlan(plan, {
      applyPolicy: {
        strategy: 'server-side-apply',
        fieldManager: 'typekro-test',
        fieldConflictPolicy: 'fail',
        immutableFieldPolicy: 'fail',
      },
    });

    expect(legacy.planIdentityDigest).toBe(plan.planIdentityDigest);
    expect(ssa.planIdentityDigest).toBe(plan.planIdentityDigest);
    expect(ssa.compiledArtifactDigest).not.toBe(legacy.compiledArtifactDigest);
  });

  it('encodes KRO graph children without TypeKro apply policy and outer artifacts with it', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const artifacts = compileKroArtifactPlan(plan);
    const child = artifacts.resources.find(
      (resource): resource is KroGraphChildArtifact => resource.role === 'kro-graph-child'
    );
    const rgd = artifacts.resources.find(
      (resource) => resource.role === 'resource-graph-definition'
    );
    const instance = artifacts.resources.find((resource) => resource.role === 'instance');

    expect(child).not.toHaveProperty('apply');
    expect(child?.identity?.scope).toBe('namespaced');
    expect(rgd).toEqual(
      expect.objectContaining({
        apply: expect.objectContaining({ strategy: 'create-or-patch' }),
        graph: expect.objectContaining({
          root: expect.objectContaining({
            apiVersion: 'testing.typekro.dev/v1alpha1',
            kind: 'ArtifactCompilerFixture',
          }),
        }),
      })
    );
    expect(instance).toEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ scope: 'namespaced' }),
        desired: expect.objectContaining({ kind: 'object' }),
      })
    );
    expect(JSON.parse(JSON.stringify(artifacts))).toEqual(artifacts);
    expect(decodeKroArtifactPlan(encodeArtifactPlan(artifacts))).toEqual(artifacts);
  });

  it('round-trips and topologically orders a complete KRO outer artifact bundle', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const artifacts = compileKroArtifactPlan(plan, {
      rgdName: 'artifact-compiler-fixture',
      instance: {
        name: lowerPlanValue('demo').value,
        namespace: lowerPlanValue('apps').value,
        spec: lowerPlanValue({ name: 'demo', namespace: 'apps' }).value,
      },
    });
    const rgd = artifacts.resources.find(
      (resource) => resource.role === 'resource-graph-definition'
    );
    const instance = artifacts.resources.find((resource) => resource.role === 'instance');
    expect(rgd?.role).toBe('resource-graph-definition');
    expect(instance?.role).toBe('instance');
    if (
      !rgd ||
      rgd.role !== 'resource-graph-definition' ||
      !instance ||
      instance.role !== 'instance'
    ) {
      throw new Error('fixture did not compile KRO outer artifacts');
    }

    const bundle = createKroArtifactBundle({
      root: {
        memberId: 'root',
        rgdOperationId: 'rgd',
        instanceOperationId: 'instance',
      },
      operations: [
        {
          id: 'instance',
          role: 'instance',
          sources: [
            {
              memberId: 'root',
              planIdentityDigest: artifacts.planIdentityDigest,
              compiledArtifactDigest: artifacts.compiledArtifactDigest,
            },
          ],
          artifact: instance,
          manifest: instance.desired,
          dependencies: ['rgd'],
        },
        {
          id: 'rgd',
          role: 'resource-graph-definition',
          sources: [
            {
              memberId: 'root',
              planIdentityDigest: artifacts.planIdentityDigest,
              compiledArtifactDigest: artifacts.compiledArtifactDigest,
            },
          ],
          artifact: rgd,
          manifest: lowerPlanValue({
            apiVersion: 'kro.run/v1alpha1',
            kind: 'ResourceGraphDefinition',
            metadata: { name: 'artifact-compiler-fixture' },
            spec: {},
          }).value,
          dependencies: [],
        },
      ],
      requiredCapabilities: [
        {
          id: 'typekro.runtime-closure',
          version: 1,
          host: 'standalone',
          output: 'live',
        },
      ],
    });
    const decoded = decodeKroArtifactBundle(encodeKroArtifactBundle(bundle));

    expect(decoded).toEqual(bundle);
    expect(decoded.requiredCapabilities).toEqual(bundle.requiredCapabilities);
    expect(orderKroArtifactBundleOperations(decoded).map((operation) => operation.id)).toEqual([
      'rgd',
      'instance',
    ]);
    const decodedRgd = decoded.operations.find((operation) => operation.id === 'rgd');
    expect(decodedRgd).toBeDefined();
    expect(materializeKroArtifactBundleOperation(decodedRgd!)).toEqual(
      expect.objectContaining({ apiVersion: 'kro.run/v1alpha1' })
    );

    const previousBundle = JSON.parse(encodeKroArtifactBundle(bundle)) as Record<string, unknown>;
    delete previousBundle.artifactRequirements;
    previousBundle.bundleDigest = canonicalDigest({
      version: previousBundle.version,
      target: previousBundle.target,
      root: previousBundle.root,
      requiredCapabilities: previousBundle.requiredCapabilities,
      operations: previousBundle.operations,
    });
    expect(decodeKroArtifactBundle(JSON.stringify(previousBundle))).toEqual({
      ...bundle,
      artifactRequirements: [],
      bundleDigest: expect.any(String),
    });

    const corrupted = JSON.parse(encodeKroArtifactBundle(bundle)) as {
      operations: Array<{ dependencies: string[] }>;
    };
    corrupted.operations[0]!.dependencies.push('missing');
    expect(() => decodeKroArtifactBundle(JSON.stringify(corrupted))).toThrow(
      /missing dependency|digest does not match/
    );
  });

  it('keeps physical KRO instance placement and lifecycle metadata in canonical artifacts', () => {
    const spec = { name: 'demo', namespace: 'workloads' };
    const plan = compilerFixture.plan!(spec, { strict: true });
    const artifacts = compileKroArtifactPlan(plan, {
      rgdName: 'shared-artifact-rgd',
      instance: {
        name: lowerPlanValue('physical-instance').value,
        namespace: lowerPlanValue('control-plane').value,
        labels: lowerPlanValue({
          'typekro.io/factory': 'artifact-compiler-fixture',
          'typekro.io/rgd': 'shared-artifact-rgd',
        }).value,
        annotations: lowerPlanValue({
          'typekro.io/hoisted-namespaces': '["workloads"]',
        }).value,
      },
    });
    const decoded = decodeKroArtifactPlan(encodeArtifactPlan(artifacts));
    const rgd = decoded.resources.find((resource) => resource.role === 'resource-graph-definition');
    const instance = kroArtifactPlanToInstanceResource(decoded, { spec });

    expect(rgd?.graph.name).toBe('shared-artifact-rgd');
    expect(instance).toEqual(
      expect.objectContaining({
        apiVersion: 'testing.typekro.dev/v1alpha1',
        kind: 'ArtifactCompilerFixture',
        metadata: {
          name: 'physical-instance',
          namespace: 'control-plane',
          labels: {
            'typekro.io/factory': 'artifact-compiler-fixture',
            'typekro.io/rgd': 'shared-artifact-rgd',
          },
          annotations: {
            'typekro.io/hoisted-namespaces': '["workloads"]',
          },
        },
        spec,
      })
    );
    expect(instance.metadata.namespace).not.toBe(spec.namespace);
  });

  it('round-trips KRO supporting artifacts and explicit outer ordering', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const artifacts = compileKroArtifactPlan(plan, {
      supportingArtifacts: [
        {
          id: 'prerequisite-crd',
          role: 'kro-prerequisite',
          desired: lowerPlanValue({
            apiVersion: 'apiextensions.k8s.io/v1',
            kind: 'CustomResourceDefinition',
            metadata: { name: 'examples.testing.typekro.dev' },
            spec: {},
          }).value,
          identity: {
            apiVersion: 'apiextensions.k8s.io/v1',
            kind: 'CustomResourceDefinition',
            name: lowerPlanValue('examples.testing.typekro.dev').value,
            scope: 'cluster',
          },
          lifecycle: {
            creation: 'adopt',
            management: 'authoritative',
            deletion: 'delete',
            instancing: { kind: 'per-cluster' },
            sharing: 'exclusive',
          },
        },
      ],
      outerEdges: [
        {
          kind: 'existence',
          prerequisite: 'prerequisite-crd',
          dependent: '__typekro_rgd__',
        },
      ],
    });
    const decoded = decodeKroArtifactPlan(encodeArtifactPlan(artifacts));
    const supporting = kroArtifactPlanToSupportingResources(decoded);

    expect(supporting).toHaveLength(1);
    expect(supporting[0]?.artifact.role).toBe('kro-prerequisite');
    expect(supporting[0]?.resource).toEqual(
      expect.objectContaining({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'examples.testing.typekro.dev' },
      })
    );
    expect(decoded.edges).toContainEqual({
      kind: 'existence',
      prerequisite: 'prerequisite-crd',
      dependent: '__typekro_rgd__',
    });
  });

  it('rejects duplicate and dangling KRO outer artifact identities', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const duplicate = compileKroArtifactPlan(plan, {
      strict: false,
      supportingArtifacts: [
        {
          id: '__typekro_rgd__',
          role: 'kro-prerequisite',
          desired: lowerPlanValue({
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: { name: 'collision' },
          }).value,
          lifecycle: {
            creation: 'create',
            management: 'authoritative',
            deletion: 'delete',
            instancing: { kind: 'per-cluster' },
            sharing: 'exclusive',
          },
        },
      ],
      outerEdges: [
        {
          kind: 'existence',
          prerequisite: 'missing-prerequisite',
          dependent: '__typekro_rgd__',
        },
      ],
    });

    expect(duplicate.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['ARTIFACT_ID_DUPLICATE', 'ARTIFACT_EDGE_ENDPOINT_MISSING'])
    );
    expect(() =>
      compileKroArtifactPlan(plan, {
        supportingArtifacts: duplicate.resources
          .filter((resource) => resource.role === 'kro-prerequisite')
          .map((resource) => ({
            id: resource.id,
            role: 'kro-prerequisite' as const,
            desired: resource.desired!,
            lifecycle: resource.lifecycle,
          })),
      })
    ).toThrow('Cannot compile semantic plan for kro');
  });

  it('diagnoses cyclic KRO outer ordering before materialization', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const lifecycle = {
      creation: 'create' as const,
      management: 'authoritative' as const,
      deletion: 'delete' as const,
      instancing: { kind: 'per-cluster' as const },
      sharing: 'exclusive' as const,
    };
    const artifacts = compileKroArtifactPlan(plan, {
      strict: false,
      supportingArtifacts: ['first', 'second'].map((name) => ({
        id: name,
        role: 'kro-prerequisite' as const,
        desired: lowerPlanValue({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name, namespace: 'apps' },
        }).value,
        lifecycle,
      })),
      outerEdges: [
        { kind: 'ready', prerequisite: 'first', dependent: 'second' },
        { kind: 'existence', prerequisite: 'second', dependent: 'first' },
      ],
    });

    expect(artifacts.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'ARTIFACT_EDGE_CYCLE',
        details: { artifactIds: 'first,second' },
      })
    );
    expect(() => kroArtifactPlanToSupportingResources(artifacts)).toThrow(
      'dependency graph contains a cycle'
    );
  });

  it('keeps shared KRO graph content symbolic across concrete instance specs', () => {
    const first = compileKroArtifactPlan(
      compilerFixture.plan!({ name: 'first', namespace: 'apps-a' }, { strict: true })
    );
    const second = compileKroArtifactPlan(
      compilerFixture.plan!({ name: 'second', namespace: 'apps-b' }, { strict: true })
    );
    const firstRgd = first.resources.find(
      (resource) => resource.role === 'resource-graph-definition'
    );
    const secondRgd = second.resources.find(
      (resource) => resource.role === 'resource-graph-definition'
    );
    const firstInstance = first.resources.find((resource) => resource.role === 'instance');
    const secondInstance = second.resources.find((resource) => resource.role === 'instance');

    if (
      !firstRgd ||
      firstRgd.role !== 'resource-graph-definition' ||
      !secondRgd ||
      secondRgd.role !== 'resource-graph-definition'
    ) {
      throw new Error('Expected both compiled plans to contain an RGD artifact');
    }

    expect(firstRgd.graph).toEqual(secondRgd.graph);
    expect(firstInstance?.desired).not.toEqual(secondInstance?.desired);
    expect(JSON.stringify(firstRgd)).toContain('"source":"spec"');
    expect(JSON.stringify(firstRgd)).not.toContain('apps-a');
    expect(JSON.stringify(firstRgd)).not.toContain('first');
  });

  it('rehydrates compiled KRO children without private resource metadata', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const resources = kroArtifactPlanToGraphResources(compileKroArtifactPlan(plan));
    const application = resources.applicationConfig!;
    const observed = resources.platformInput!;

    expect(getResourceId(application)).toBe('applicationConfig');
    expect(application.metadata.name).toEqual(
      expect.objectContaining({ resourceId: '__schema__', fieldPath: 'spec.name' })
    );
    expect((application as { data?: { source?: unknown } }).data?.source).toEqual(
      expect.objectContaining({ resourceId: 'platformInput', fieldPath: 'status.endpoint' })
    );
    expect(Object.getOwnPropertyDescriptor(observed, '__externalRef')?.value).toBe(true);
    expect(JSON.stringify(resources)).not.toContain('__externalRef');
  });

  it('decodes canonical artifact plans and rejects target, ownership, and digest corruption', () => {
    const plan = compilerFixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const direct = compileDirectArtifactPlan(plan);
    const encoded = encodeArtifactPlan(direct);

    expect(decodeArtifactPlan(encoded)).toEqual(direct);
    expect(decodeDirectArtifactPlan(encoded)).toEqual(direct);
    expect(() => decodeKroArtifactPlan(encoded)).toThrow('Expected kro plan');

    const digestCorruption = JSON.parse(encoded) as { resources: Array<{ id: string }> };
    digestCorruption.resources[0]!.id = 'changed-after-compilation';
    expect(() => decodeArtifactPlan(JSON.stringify(digestCorruption))).toThrow(
      'digest does not match'
    );

    const kro = compileKroArtifactPlan(plan);
    const ownershipCorruption = JSON.parse(encodeArtifactPlan(kro)) as {
      resources: Array<{ role: string; apply?: unknown }>;
    };
    const child = ownershipCorruption.resources.find(
      (resource) => resource.role === 'kro-graph-child'
    );
    child!.apply = { strategy: 'create-only' };
    expect(() => decodeArtifactPlan(JSON.stringify(ownershipCorruption))).toThrow(
      'must not carry a TypeKro apply policy'
    );
  });
});
