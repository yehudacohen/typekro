/**
 * Regression tests for nested composition behavior in direct mode.
 *
 * These tests cover bugs found during CollectorBills dogfooding where
 * nested compositions produced CEL expressions, proxy artifacts, or
 * missing kind fields instead of resolved values.
 *
 * Bug #1: CEL expressions leaked into resource metadata.name when an
 *         inner composition used a ternary on an optional spec field.
 * Bug #2: Cross-composition status references returned KubernetesRef
 *         proxy objects instead of real strings (e.g., connection URLs).
 * Bug #3: K8s list responses omit kind/apiVersion on individual items,
 *         causing discovery to produce resources with kind='Unknown'.
 * Bug #4: APISIX composition threw at module load time when
 *         APISIX_ADMIN_KEY wasn't set, even for unrelated consumers.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import {
  createCompositionContext,
  runWithCompositionContext,
  getCurrentCompositionContext,
} from '../../src/core/composition/context.js';
import { simple } from '../../src/factories/simple/index.js';
import { secret } from '../../src/factories/kubernetes/config/secret.js';
import { discoverDeployedResourcesByInstance } from '../../src/core/deployment/deployment-state-discovery.js';
import type { GvkTarget } from '../../src/core/deployment/deployment-state-discovery.js';
import {
  FACTORY_NAME_ANNOTATION,
  FACTORY_NAME_LABEL,
  INSTANCE_NAME_ANNOTATION,
  INSTANCE_NAME_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  RESOURCE_ID_ANNOTATION,
  DEPLOYMENT_ID_ANNOTATION,
  FACTORY_NAMESPACE_ANNOTATION,
} from '../../src/core/deployment/resource-tagging.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a minimal inner composition that has a conditional pattern
 * (ternary on an optional field) — the exact pattern that triggered
 * the CEL leak in direct mode.
 */
const innerComposition = kubernetesComposition(
  {
    name: 'inner-service',
    kind: 'InnerService',
    spec: type({
      name: 'string',
      'namespace?': 'string',
      /** Optional external secret ref — triggers the ternary pattern. */
      'externalSecretRef?': { name: 'string', key: 'string' },
      'secretValue?': 'string',
    }),
    status: type({
      ready: 'boolean',
      serviceUrl: 'string',
      secretName: 'string',
    }),
  },
  (spec) => {
    const ns = spec.namespace ?? 'default';
    const autoSecretName = `${spec.name}-secret`;

    // This conditional is the pattern that caused CEL leak:
    // In KRO mode it should generate has(schema.spec.externalSecretRef)
    // In direct mode it should just evaluate the JS ternary normally
    if (!spec.externalSecretRef) {
      secret({
        metadata: { name: autoSecretName, namespace: ns },
        stringData: { key: spec.secretValue ?? 'default-secret' },
        id: 'innerSecret',
      });
    }

    const deployment = simple.Deployment({
      name: spec.name,
      namespace: ns,
      image: 'nginx:alpine',
      env: {
        SECRET_REF_NAME: spec.externalSecretRef
          ? spec.externalSecretRef.name
          : autoSecretName,
      },
      id: 'innerDeployment',
    });

    simple.Service({
      name: spec.name,
      namespace: ns,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }],
      id: 'innerService',
    });

    return {
      ready: deployment.status.readyReplicas >= 1,
      serviceUrl: `http://${spec.name}.${ns}:80`,
      secretName: autoSecretName,
    };
  }
);

/**
 * Build an outer composition that nests the inner one and reads
 * its status values — the pattern that triggered the proxy leak.
 */
const outerComposition = kubernetesComposition(
  {
    name: 'outer-stack',
    kind: 'OuterStack',
    spec: type({
      name: 'string',
      'namespace?': 'string',
      innerImage: 'string',
    }),
    status: type({
      ready: 'boolean',
      innerUrl: 'string',
      workerDbUrl: 'string',
    }),
  },
  (spec) => {
    const ns = spec.namespace ?? 'default';

    // Nest the inner composition
    const inner = innerComposition({
      name: `${spec.name}-inner`,
      namespace: ns,
      secretValue: 'my-secret',
    });

    // Create a worker deployment that reads the inner composition's
    // status — this is the pattern that returned KubernetesRef proxies
    // instead of real strings.
    const worker = simple.Deployment({
      name: `${spec.name}-worker`,
      namespace: ns,
      image: spec.innerImage,
      env: {
        SERVICE_URL: inner.status.serviceUrl,
        SECRET_NAME: inner.status.secretName,
      },
      id: 'worker',
    });

    return {
      ready: inner.status.ready && worker.status.readyReplicas >= 1,
      innerUrl: inner.status.serviceUrl,
      workerDbUrl: `http://${spec.name}-worker:8080`,
    };
  }
);

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Nested Composition Direct Mode', () => {
  describe('Bug #1: CEL expressions must not leak into resource names', () => {
    it('produces real string names, not CEL has() expressions', () => {
      const factory = outerComposition.factory('direct', { namespace: 'test-ns' });
      const graph = factory.createResourceGraphForInstance({
        name: 'myapp',
        namespace: 'test-ns',
        innerImage: 'worker:latest',
      });

      expect(graph.resources.length).toBeGreaterThan(0);

      for (const r of graph.resources) {
        const name = String(r.manifest?.metadata?.name ?? '');
        const ns = String(r.manifest?.metadata?.namespace ?? '');

        // No CEL expressions in resource names
        expect(name).not.toContain('${');
        expect(name).not.toContain('has(');
        expect(name).not.toContain('schema.spec');

        // No CEL expressions in namespaces
        expect(ns).not.toContain('${');
        expect(ns).not.toContain('has(');
        expect(ns).not.toContain('schema.spec');
      }
    });

    it('resolves conditional resource names to their else-branch values', () => {
      const factory = outerComposition.factory('direct', { namespace: 'test-ns' });
      const graph = factory.createResourceGraphForInstance({
        name: 'myapp',
        namespace: 'test-ns',
        innerImage: 'worker:latest',
      });

      // The inner secret should be named "myapp-inner-secret" (the autoSecretName)
      const secretResource = graph.resources.find(
        (r) => r.manifest?.kind === 'Secret'
      );
      expect(secretResource).toBeDefined();
      expect(secretResource!.manifest?.metadata?.name).toBe('myapp-inner-secret');
    });
  });

  describe('Bug #2: cross-composition status must resolve to real values', () => {
    it('worker env vars contain real strings, not KubernetesRef proxies', () => {
      const factory = outerComposition.factory('direct', { namespace: 'test-ns' });
      const graph = factory.createResourceGraphForInstance({
        name: 'myapp',
        namespace: 'test-ns',
        innerImage: 'worker:latest',
      });

      // Find the worker deployment
      const workerDeploy = graph.resources.find((r) => {
        const name = String(r.manifest?.metadata?.name ?? '');
        return name.includes('worker');
      });
      expect(workerDeploy).toBeDefined();

      // Check env vars on the worker container
      const containers = (workerDeploy!.manifest as any)?.spec?.template?.spec?.containers;
      expect(containers).toBeDefined();
      expect(containers.length).toBeGreaterThan(0);

      const env = containers[0].env as Array<{ name: string; value: string }>;
      expect(env).toBeDefined();

      const serviceUrlEnv = env.find((e) => e.name === 'SERVICE_URL');
      const secretNameEnv = env.find((e) => e.name === 'SECRET_NAME');

      expect(serviceUrlEnv).toBeDefined();
      expect(secretNameEnv).toBeDefined();

      // Must be real strings, not proxy artifacts
      expect(serviceUrlEnv!.value).toBe('http://myapp-inner.test-ns:80');
      expect(secretNameEnv!.value).toBe('myapp-inner-secret');

      // Must NOT contain proxy markers
      expect(serviceUrlEnv!.value).not.toContain('__KUBERNETES_REF');
      expect(secretNameEnv!.value).not.toContain('__KUBERNETES_REF');
    });

    it('status values are real strings during re-execution', () => {
      const factory = outerComposition.factory('direct', { namespace: 'test-ns' });
      const compositionFn = (factory as any).factoryOptions?.compositionFn;
      expect(compositionFn).toBeDefined();

      const reCtx = createCompositionContext('re-exec-test', {
        deduplicateIds: true,
        isReExecution: true,
      });

      let status: any;
      runWithCompositionContext(reCtx, () => {
        status = compositionFn({
          name: 'myapp',
          namespace: 'test-ns',
          innerImage: 'worker:latest',
        });
      });

      expect(status).toBeDefined();

      // innerUrl should be a real string
      expect(typeof status.innerUrl).toBe('string');
      expect(status.innerUrl).toBe('http://myapp-inner.test-ns:80');

      // Should NOT be a KubernetesRef proxy object
      expect(typeof status.innerUrl).not.toBe('object');
    });
  });

  describe('Bug #3: discovery stamps kind/apiVersion on list items', () => {
    it('stamps kind and apiVersion from the GVK target when missing on items', async () => {
      // Mock K8s API that returns items WITHOUT kind/apiVersion
      // (simulating real K8s list behavior)
      const mockItem = {
        metadata: {
          name: 'test-deploy',
          namespace: 'default',
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
            [FACTORY_NAME_LABEL]: 'test-factory',
            [INSTANCE_NAME_LABEL]: 'test-instance',
          },
          annotations: {
            [FACTORY_NAME_ANNOTATION]: 'test-factory',
            [INSTANCE_NAME_ANNOTATION]: 'test-instance',
            [DEPLOYMENT_ID_ANNOTATION]: 'dep-1',
            [RESOURCE_ID_ANNOTATION]: 'testDeploy',
            [FACTORY_NAMESPACE_ANNOTATION]: 'default',
          },
          creationTimestamp: new Date(),
        },
        // NOTE: no kind or apiVersion — this is what real K8s list returns
      };

      const api = {
        list: async (
          apiVersion: string,
          kind: string,
          _ns?: string,
          _p?: string,
          _e?: boolean,
          _x?: boolean,
          _f?: string,
          labelSelector?: string
        ) => {
          if (
            apiVersion === 'apps/v1' &&
            kind === 'Deployment' &&
            labelSelector?.includes('test-factory')
          ) {
            return { items: [mockItem] };
          }
          return { items: [] };
        },
      } as any;

      const knownGvks: GvkTarget[] = [
        { apiVersion: 'apps/v1', kind: 'Deployment', namespaced: true },
      ];

      const record = await discoverDeployedResourcesByInstance(api, {
        factoryName: 'test-factory',
        instanceName: 'test-instance',
        knownGvks,
      });

      expect(record).toBeDefined();
      expect(record!.resources).toHaveLength(1);

      // The discovery module should have stamped kind and apiVersion
      const resource = record!.resources[0]!;
      expect(resource.kind).toBe('Deployment');
      expect(resource.manifest.apiVersion).toBe('apps/v1');
      expect(resource.manifest.kind).toBe('Deployment');
    });
  });

  describe('Bug #4: composition definition pass tolerates env checks', () => {
    it('does not throw when a composition function checks getCurrentCompositionContext', () => {
      // Simulate the APISIX pattern: a function that throws unless
      // it detects it's running inside a composition definition pass
      function resolveCredential(): string {
        const ctx = getCurrentCompositionContext();
        if (!ctx) {
          throw new Error('Credential not configured');
        }
        return 'default-credential';
      }

      // This should NOT throw — the composition definition pass
      // runs inside a composition context
      expect(() => {
        kubernetesComposition(
          {
            name: 'cred-test',
            kind: 'CredTest',
            spec: type({ name: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const _cred = resolveCredential();
            const _deploy = simple.Deployment({
              name: spec.name,
              image: 'nginx',
              id: 'app',
            });
            return { ready: true };
          }
        );
      }).not.toThrow();
    });
  });

  describe('Bug #5: resources referencing inner service names must deploy after them', () => {
    it('worker deployment depends on inner service via implicit service-name detection', () => {
      const factory = outerComposition.factory('direct', { namespace: 'test-ns' });
      const graph = factory.createResourceGraphForInstance({
        name: 'myapp',
        namespace: 'test-ns',
        innerImage: 'worker:latest',
      });

      // Find the worker deployment
      const workerResource = graph.resources.find((r) => {
        const name = String(r.manifest?.metadata?.name ?? '');
        return name.includes('worker');
      });
      expect(workerResource).toBeDefined();

      // Find the inner Service (named "myapp-inner")
      const innerService = graph.resources.find((r) => {
        return r.manifest?.kind === 'Service' &&
          String(r.manifest?.metadata?.name ?? '') === 'myapp-inner';
      });
      expect(innerService).toBeDefined();

      // The worker should depend on the inner service because its
      // SERVICE_URL env var contains "myapp-inner" (the service name).
      const workerDeps = graph.dependencyGraph.getDependencies(workerResource!.id);
      const dependsOnInnerService = workerDeps.includes(innerService!.id);
      expect(dependsOnInnerService).toBe(true);
    });

    it('does not create false-positive deps from substring matches', () => {
      // Create a composition where one Deployment is named "app" and another
      // has an image like "myapp:latest". The "app" substring in "myapp"
      // should NOT create a dependency edge.
      const shortNameComp = kubernetesComposition(
        {
          name: 'short-name-test',
          kind: 'ShortNameTest',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          simple.Deployment({
            name: 'app',
            image: 'nginx',
            id: 'appDeploy',
          });
          simple.Deployment({
            name: 'worker',
            image: 'myapp:latest',
            env: { SOME_VAR: 'happy-path' },
            id: 'workerDeploy',
          });
          return { ready: true };
        }
      );

      const factory = shortNameComp.factory('direct', { namespace: 'test-ns' });
      const graph = factory.createResourceGraphForInstance({ name: 'test' });

      const worker = graph.resources.find((r) =>
        String(r.manifest?.metadata?.name ?? '').includes('worker')
      );
      expect(worker).toBeDefined();

      // "worker" should NOT depend on "app" — "myapp" and "happy" are
      // substrings, not hostname references.
      const workerDeps = graph.dependencyGraph.getDependencies(worker!.id);
      const appResource = graph.resources.find((r) =>
        r.manifest?.kind === 'Deployment' &&
        String(r.manifest?.metadata?.name ?? '') === 'app'
      );
      if (appResource) {
        expect(workerDeps.includes(appResource.id)).toBe(false);
      }
    });

    it('resources without service-name references have no spurious dependencies', () => {
      const factory = outerComposition.factory('direct', { namespace: 'test-ns' });
      const graph = factory.createResourceGraphForInstance({
        name: 'myapp',
        namespace: 'test-ns',
        innerImage: 'worker:latest',
      });

      // Find the inner Deployment
      const innerDeploy = graph.resources.find((r) => {
        return r.manifest?.kind === 'Deployment' &&
          String(r.manifest?.metadata?.name ?? '') === 'myapp-inner';
      });
      expect(innerDeploy).toBeDefined();

      // The inner deployment should NOT depend on the worker (no circular dep)
      const innerDeps = graph.dependencyGraph.getDependencies(innerDeploy!.id);
      const workerResource = graph.resources.find((r) =>
        String(r.manifest?.metadata?.name ?? '').includes('worker')
      );
      expect(innerDeps.includes(workerResource!.id)).toBe(false);
    });
  });
});
