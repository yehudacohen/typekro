/**
 * Unit tests for DirectResourceFactory implementation
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import {
  Cel,
  createResource,
  kubernetesComposition,
  simple,
  singleton,
  toResourceGraph,
} from '../../src/index.js';
import { resourceFromDirectArtifactRecordForTest } from '../../src/alchemy/resource-registration.js';
import { getReadinessEvaluator } from '../../src/core/metadata/index.js';
import { decodeDirectArtifactExecutionRecord } from '../../src/experimental-planning.js';

describe('DirectResourceFactory', () => {
  const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1',
    port: 'number%1',
  });

  const WebAppStatusSchema = type({
    phase: '"pending" | "running" | "failed"',
    url: 'string',
    readyReplicas: 'number%1',
  });

  type WebAppSpec = typeof WebAppSpecSchema.infer;
  // type WebAppStatus = typeof WebAppStatusSchema.infer; // Unused for now

  describe('Factory Creation', () => {
    it('should create DirectResourceFactory with correct properties', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
          service: simple.Service({
            name: Cel.template('%s-service', schema.spec.name),
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: schema.spec.port }],
            id: 'webappService',
          }),
        }),
        (_schema, resources) => ({
          readyReplicas: resources.deployment?.status.readyReplicas,
          url: 'http://webapp-service',
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct', {
        namespace: 'test-namespace',
        timeout: 30000,
        waitForReady: true,
      });

      expect(factory.mode).toBe('direct');
      expect(factory.name).toBe('test-webapp');
      expect(factory.namespace).toBe('test-namespace');
    });

    it('should create factory with default options', async () => {
      const graph = toResourceGraph(
        {
          name: 'simple-app',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'appDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.metadata.name}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct');

      expect(factory.mode).toBe('direct');
      expect(factory.name).toBe('simple-app');
      expect(factory.namespace).toBe('default');
    });
  });

  describe('YAML Generation', () => {
    it('should generate YAML for instance deployment', async () => {
      const graph = toResourceGraph(
        {
          name: 'yaml-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'testDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.metadata.name}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct', { namespace: 'production' });

      const spec: WebAppSpec = {
        name: 'my-app',
        image: 'nginx:latest',
        replicas: 3,
        port: 8080,
      };

      const yaml = factory.toYaml(spec);

      // DirectResourceFactory.toYaml() should generate individual Kubernetes manifests, not RGD
      expect(yaml).toContain('apiVersion: apps/v1');
      expect(yaml).toContain('kind: Deployment');
      expect(yaml).toContain('name: my-app');
      expect(typeof yaml).toBe('string');
      expect(yaml.length).toBeGreaterThan(0);
    });

    it('should generate consistent YAML for same spec', async () => {
      const graph = toResourceGraph(
        {
          name: 'consistency-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'consistentDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.metadata.name}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct');

      const spec: WebAppSpec = {
        name: 'test-app',
        image: 'nginx:latest',
        replicas: 2,
        port: 3000,
      };

      const yaml1 = factory.toYaml(spec);
      const yaml2 = factory.toYaml(spec);

      expect(yaml1).toBe(yaml2);
    });
  });

  describe('Factory Status', () => {
    it('should return factory status', async () => {
      const graph = toResourceGraph(
        {
          name: 'status-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'statusDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.metadata.name}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct', { namespace: 'test' });
      const status = await factory.getStatus();

      expect(status.name).toBe('status-test');
      expect(status.mode).toBe('direct');
      expect(status.namespace).toBe('test');
      expect(status.instanceCount).toBe(0); // No instances deployed yet
      expect(status.health).toBe('healthy');
    });

    it('preserves cancellation across status, rollback, and server dry-run boundaries', async () => {
      const graph = toResourceGraph(
        {
          name: 'cancelled-direct-operations',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'cancelledDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.metadata.name}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );
      const factory = await graph.factory('direct');
      const controller = new AbortController();
      const reason = new DOMException('cancelled direct operation', 'AbortError');
      controller.abort(reason);

      const statusError = await factory
        .getStatus({ abortSignal: controller.signal })
        .catch((error: unknown) => error);
      const rollbackError = await factory
        .rollback({ abortSignal: controller.signal })
        .catch((error: unknown) => error);
      const dryRunError = await factory
        .toDryRun(
          { name: 'demo', image: 'nginx:latest', replicas: 1, port: 8080 },
          { abortSignal: controller.signal }
        )
        .catch((error: unknown) => error);

      expect(statusError).toBe(reason);
      expect(rollbackError).toBe(reason);
      expect(dryRunError).toBe(reason);
    });
  });

  describe('Instance Management', () => {
    it('should return empty instances list initially', async () => {
      const graph = toResourceGraph(
        {
          name: 'instances-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'instancesDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.metadata.name}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct');
      const instances = await factory.getInstances();

      expect(instances).toEqual([]);
    });

    it('treats an already-absent instance as idempotently deleted', async () => {
      const graph = toResourceGraph(
        {
          name: 'delete-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'deleteDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.metadata.name}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct');
      const subject = factory as unknown as {
        getDeploymentEngine(): {
          loadDeploymentByInstance: (...args: unknown[]) => Promise<unknown>;
        };
      };
      const getDeploymentEngine = subject.getDeploymentEngine;
      subject.getDeploymentEngine = () => ({ loadDeploymentByInstance: async () => null });

      let result: Awaited<ReturnType<typeof factory.deleteInstance>>;
      try {
        result = await factory.deleteInstance('test-instance');
      } finally {
        subject.getDeploymentEngine = getDeploymentEngine;
      }

      expect(result.status).toBe('complete');
      expect(result.mode).toBe('direct');
      expect(result.instanceName).toBe('test-instance');
      expect(result.deleted).toEqual([]);
      expect(result.remaining).toEqual([]);
      expect(result.blockers).toEqual([]);
      expect(result.retry.safe).toBe(true);
      expect(result.retry.guidance).toContain('already complete');
    });
  });

  describe('Deterministic Behavior', () => {
    it('should create identical factories from same resource graph', async () => {
      const createGraph = () =>
        toResourceGraph(
          {
            name: 'deterministic-test',
            apiVersion: 'v1alpha1',
            kind: 'WebApp',
            spec: WebAppSpecSchema,
            status: WebAppStatusSchema,
          },
          (schema) => ({
            deployment: simple.Deployment({
              name: schema.spec.name,
              image: schema.spec.image,
              replicas: schema.spec.replicas,
              id: 'deterministicDeployment',
            }),
          }),
          (_schema, resources) => ({
            url: `http://${resources.deployment.metadata.name}`,
            readyReplicas: resources.deployment.status.readyReplicas,
            phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
          })
        );

      const graph1 = createGraph();
      const graph2 = createGraph();

      const factory1 = await graph1.factory('direct', { namespace: 'test' });
      const factory2 = await graph2.factory('direct', { namespace: 'test' });

      expect(factory1.name).toBe(factory2.name);
      expect(factory1.namespace).toBe(factory2.namespace);
      expect(factory1.mode).toBe(factory2.mode);

      // YAML generation should also be identical
      const spec: WebAppSpec = {
        name: 'test-app',
        image: 'nginx:latest',
        replicas: 1,
        port: 8080,
      };

      const yaml1 = factory1.toYaml(spec);
      const yaml2 = factory2.toYaml(spec);

      expect(yaml1).toBe(yaml2);
    });
  });

  describe('toAlchemyResources (alchemy v2)', () => {
    // A ConfigMap whose data references the Deployment's *status* (a runtime-only value, not
    // derivable from the schema) — that's a genuine cross-resource KubernetesRef, so the
    // dependency graph yields a real edge: configMap depends on deployment.
    const makeGraph = () =>
      toResourceGraph(
        {
          name: 'webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => {
          const deployment = simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          });
          return {
            deployment,
            config: simple.ConfigMap({
              name: Cel.template('%s-cfg', schema.spec.name),
              data: {
                // Runtime cross-resource reference → forces config-depends-on-deployment.
                readyReplicas: Cel.template('%s', deployment.status.readyReplicas),
              },
              id: 'webappConfig',
            }),
          };
        },
        (_schema, _resources) => ({
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
          url: 'http://webapp-svc',
          readyReplicas: 1,
        })
      );

    const spec: WebAppSpec = { name: 'web', image: 'nginx:latest', replicas: 2, port: 8080 };

    it('emits one declaration per resource, marked direct, with logical ids', async () => {
      const factory = await makeGraph().factory('direct', { namespace: 'apps' });
      const decls = await factory.toAlchemyResources(spec);

      expect(decls.length).toBe(2);
      for (const d of decls) {
        expect(d.props.deploymentStrategy).toBe('direct');
        expect(d.props.namespace).toBe('apps');
        expect(typeof d.props.resourceId).toBe('string');
        expect(typeof d.props.artifactExecutionRecord).toBe('string');
        expect(d.id.length).toBeGreaterThan(0);
      }
      // Distinct alchemy ids per resource (independent state entries).
      expect(decls[0]!.id).not.toBe(decls[1]!.id);
    });

    it('emits singleton-owner resources when Alchemy is the direct deployment authority', async () => {
      const owner = kubernetesComposition(
        {
          name: 'direct-alchemy-singleton-owner',
          apiVersion: 'testing.typekro.dev/v1alpha1',
          kind: 'DirectAlchemySingletonOwner',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (ownerSpec) => {
          const config = simple.ConfigMap({
            id: 'ownerConfig',
            name: ownerSpec.name,
            namespace: 'typekro-singletons',
            data: { installed: 'true' },
          });
          config.withReadinessEvaluator((resource) => ({
            ready: resource.data?.installed === 'true',
            message: 'runtime-bound singleton readiness',
          }));
          return { ready: true };
        }
      );
      const consumer = kubernetesComposition(
        {
          name: 'direct-alchemy-singleton-consumer',
          apiVersion: 'testing.typekro.dev/v1alpha1',
          kind: 'DirectAlchemySingletonConsumer',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        () => {
          const shared = singleton(owner, {
            id: 'shared-owner',
            spec: { name: 'shared-owner' },
          });
          return { ready: shared.status.ready };
        }
      );

      const declarations = await consumer
        .factory('direct', { namespace: 'apps' })
        .toAlchemyResources({ name: 'consumer' });

      expect(declarations).toHaveLength(1);
      expect(declarations[0]?.props.resource.kind).toBe('ConfigMap');
      expect(declarations[0]?.props.resource.metadata).toMatchObject({
        name: 'shared-owner',
        namespace: 'typekro-singletons',
        annotations: {
          'typekro.io/singleton-spec-fingerprint': expect.stringMatching(
            /^fnv64:[a-f0-9]{16}$/
          ),
        },
      });
      expect(declarations[0]?.props.retain).toBe(true);
      expect(declarations[0]?.props.resourceId).toContain('ownerConfig');
      expect(declarations[0]?.props.artifactExecutionRecord).toBeString();
      const rehydrated = resourceFromDirectArtifactRecordForTest(
        declarations[0]!.props
      );
      expect(rehydrated?.metadata.annotations).toEqual(
        expect.objectContaining({
          'typekro.io/singleton-spec-fingerprint': expect.stringMatching(
            /^fnv64:[a-f0-9]{16}$/
          ),
        })
      );
      expect(getReadinessEvaluator(declarations[0]!.props.resource)).toBeFunction();
      expect(getReadinessEvaluator(rehydrated!)).toBeFunction();
    });

    it('persists an explicitly authored resource namespace instead of the factory default', async () => {
      const crossNamespace = toResourceGraph(
        {
          name: 'cross-namespace',
          apiVersion: 'v1alpha1',
          kind: 'CrossNamespace',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          config: simple.ConfigMap({
            name: Cel.template('%s-config', schema.spec.name),
            namespace: 'workloads',
            data: { contract: 'manifest-namespace-is-the-deployed-identity' },
            id: 'crossNamespaceConfig',
          }),
        }),
        () => ({
          phase: 'running' as const,
          url: 'http://cross-namespace',
          readyReplicas: 1,
        })
      );
      const factory = await crossNamespace.factory('direct', {
        namespace: 'control-plane',
      });
      const [declaration] = await factory.toAlchemyResources(spec);

      expect(declaration?.props.resource.metadata.namespace).toBe('workloads');
      expect(declaration?.props.namespace).toBe('workloads');
      expect(declaration?.id).not.toContain('Identity');
    });

    it('disambiguates only colliding legacy IDs with the authored Kubernetes identity', async () => {
      const crossNamespace = toResourceGraph(
        {
          name: 'cross-namespace-collision',
          apiVersion: 'v1alpha1',
          kind: 'CrossNamespaceCollision',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        () => ({
          first: simple.ConfigMap({
            name: 'shared-name',
            namespace: 'namespace-a',
            data: { identity: 'namespace-a/shared-name' },
            id: 'firstSharedConfig',
          }),
          second: simple.ConfigMap({
            name: 'shared-name',
            namespace: 'namespace-b',
            data: { identity: 'namespace-b/shared-name' },
            id: 'secondSharedConfig',
          }),
        }),
        () => ({
          phase: 'running' as const,
          url: 'http://cross-namespace-collision',
          readyReplicas: 1,
        })
      );
      const factory = await crossNamespace.factory('direct', {
        namespace: 'control-plane',
      });
      const first = await factory.toAlchemyResources(spec);
      const second = await factory.toAlchemyResources(spec);

      expect(first).toHaveLength(2);
      expect(new Set(first.map((declaration) => declaration.id)).size).toBe(2);
      expect(first.map((declaration) => declaration.id)).toEqual(
        second.map((declaration) => declaration.id)
      );
      expect(first.every((declaration) => declaration.id.includes('Identity'))).toBe(true);
      expect(
        first.map((declaration) => declaration.props.resource.metadata.namespace).sort()
      ).toEqual(['namespace-a', 'namespace-b']);
    });

    it('rejects multiple graph nodes that target one canonical Kubernetes identity', async () => {
      const duplicateIdentity = toResourceGraph(
        {
          name: 'duplicate-kubernetes-identity',
          apiVersion: 'v1alpha1',
          kind: 'DuplicateKubernetesIdentity',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        () => ({
          first: simple.ConfigMap({
            name: 'shared-name',
            namespace: 'namespace-a',
            data: { owner: 'first' },
            id: 'firstSharedConfig',
          }),
          second: simple.ConfigMap({
            name: 'shared-name',
            namespace: 'namespace-a',
            data: { owner: 'second' },
            id: 'secondSharedConfig',
          }),
        }),
        () => ({
          phase: 'running' as const,
          url: 'http://duplicate-kubernetes-identity',
          readyReplicas: 1,
        })
      );
      const factory = await duplicateIdentity.factory('direct', {
        namespace: 'control-plane',
      });

      await expect(factory.toAlchemyResources(spec)).rejects.toThrow(
        /same Kubernetes object.*firstSharedConfig.*secondSharedConfig.*exactly one Alchemy owner/
      );
    });

    it('treats served versions in one API group as the same Kubernetes identity', async () => {
      const versionSkew = toResourceGraph(
        {
          name: 'version-skew-kubernetes-identity',
          apiVersion: 'v1alpha1',
          kind: 'VersionSkewKubernetesIdentity',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        () => ({
          alpha: createResource({
            id: 'alphaWidget',
            apiVersion: 'widgets.example.com/v1alpha1',
            kind: 'Widget',
            metadata: { name: 'shared-name', namespace: 'namespace-a' },
            spec: { owner: 'alpha' },
          }).withReadinessEvaluator(() => ({ ready: true })),
          beta: createResource({
            id: 'betaWidget',
            apiVersion: 'widgets.example.com/v1beta1',
            kind: 'Widget',
            metadata: { name: 'shared-name', namespace: 'namespace-a' },
            spec: { owner: 'beta' },
          }).withReadinessEvaluator(() => ({ ready: true })),
        }),
        () => ({
          phase: 'running' as const,
          url: 'http://version-skew-kubernetes-identity',
          readyReplicas: 1,
        })
      );
      const factory = await versionSkew.factory('direct', {
        namespace: 'control-plane',
      });

      await expect(factory.toAlchemyResources(spec)).rejects.toThrow(
        /same Kubernetes object.*alphaWidget.*betaWidget.*exactly one Alchemy owner/
      );
    });

    it('topologically orders declarations and wires dependsOn from the dependency graph', async () => {
      const composition = makeGraph();
      const plan = composition.plan!(spec, { strict: true });
      expect(plan.edges).toContainEqual({
        kind: 'existence',
        prerequisite: 'webappDeployment',
        dependent: 'webappConfig',
      });

      const factory = await composition.factory('direct', { namespace: 'apps' });
      const decls = await factory.toAlchemyResources(spec);

      const byLogicalId = new Map(decls.map((d) => [d.props.resourceId, d]));
      const deployment = byLogicalId.get('webappDeployment')!;
      const config = byLogicalId.get('webappConfig')!;
      expect(deployment).toBeDefined();
      expect(config).toBeDefined();

      const configArtifact = decodeDirectArtifactExecutionRecord(
        config.props.artifactExecutionRecord!
      );
      expect(configArtifact.artifact.sourceNodeId).toBe('webappConfig');
      expect(configArtifact.dependencies).toEqual(['webappDeployment']);
      expect(JSON.stringify(configArtifact.artifact.desired)).toContain('webappDeployment');

      // The configMap references the deployment's status, so it must depend on it…
      expect(config.dependsOn).toContain(deployment.id);
      // …and the deployment (no deps) must come first in the returned order.
      expect(decls.indexOf(deployment)).toBeLessThan(decls.indexOf(config));
      // The independent resource has no dependencies.
      expect(deployment.dependsOn).toEqual([]);
    });
  });
});
