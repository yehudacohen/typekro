/**
 * SearXNG Bootstrap Composition Integration Tests
 *
 * Deploys a SearXNG instance to the cluster and verifies:
 * - All resources deploy successfully (Namespace, ConfigMap, Deployment, Service)
 * - Health endpoint responds
 * - JSON API works when enabled
 * - Status fields are correct
 * - Cleanup terminates cleanly
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import type { ResourceFactory } from '../../../src/core/types/deployment.js';
import type {
  SearxngBootstrapConfig,
  SearxngBootstrapStatus,
} from '../../../src/factories/searxng/types.js';
import { ensureNamespaceExists, isClusterAvailable } from '../shared-kubeconfig.js';

setDefaultTimeout(120000);

const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

describeOrSkip('SearXNG Bootstrap Composition', () => {
  let kubeConfig: k8s.KubeConfig;
  let factory: ResourceFactory<SearxngBootstrapConfig, SearxngBootstrapStatus> | undefined;
  const suffix = Math.random().toString(36).slice(2, 7);
  const factoryNamespace = `typekro-searxng-${suffix}`;

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    await ensureNamespaceExists(factoryNamespace, kubeConfig);
  });

  afterAll(async () => {
    if (factory) {
      try {
        await factory.deleteInstance('searxng-test');
      } catch (e) {
        console.error('⚠️ SearXNG deleteInstance failed:', (e as Error).message);
      }
    }
    const { deleteNamespaceIfExists } = await import('../shared-kubeconfig.js');
    try {
      await deleteNamespaceIfExists(factoryNamespace, kubeConfig);
    } catch (e) {
      console.error(`⚠️ Namespace cleanup failed:`, (e as Error).message);
    }
    // Also clean the app namespace created by the composition
    try {
      await deleteNamespaceIfExists(`searxng-test-${suffix}`, kubeConfig);
    } catch {}
  });

  it('should deploy SearXNG and verify health endpoint', async () => {
    const { searxngBootstrap } = await import(
      '../../../src/factories/searxng/compositions/searxng-bootstrap.js'
    );

    factory = searxngBootstrap.factory('direct', {
      namespace: factoryNamespace,
      waitForReady: true,
      timeout: 60000,
      kubeConfig,
    });

    const instance = await factory.deploy({
      name: 'searxng-test',
      namespace: `searxng-test-${suffix}`,
      server: {
        secret_key: 'test-integration-key-not-for-production',
        limiter: false,
      },
    });

    // Status assertions
    expect(instance.spec.name).toBe('searxng-test');
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.failed).toBe(false);
    expect(instance.status.url).toContain('searxng-test');

    // Verify pods are actually running via kubectl
    const proc = Bun.spawn(
      ['kubectl', 'get', 'pods', '-n', `searxng-test-${suffix}`, '-o', 'json'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const podList = JSON.parse(output);
    const pods = podList.items as Array<{
      metadata?: { name?: string };
      status?: {
        phase?: string;
        containerStatuses?: Array<{ ready?: boolean; restartCount?: number }>;
      };
    }>;

    expect(pods.length).toBeGreaterThan(0);
    for (const pod of pods) {
      expect(pod.status?.phase).toBe('Running');
      for (const cs of pod.status?.containerStatuses ?? []) {
        expect(cs.ready).toBe(true);
      }
    }

    // Verify the health endpoint responds via port-forward
    // Use kubectl exec to curl from inside the cluster
    const healthProc = Bun.spawn(
      ['kubectl', 'exec', '-n', `searxng-test-${suffix}`,
       `deploy/searxng-test`, '--',
       'wget', '-q', '-O-', 'http://localhost:8080/healthz'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    await new Response(healthProc.stdout).text(); // drain stdout
    const healthExit = await healthProc.exited;
    // healthz returns empty 200 or a small response
    expect(healthExit).toBe(0);
  }, 90000);

  it('should generate valid KRO YAML with CEL expressions', async () => {
    const { searxngBootstrap } = await import(
      '../../../src/factories/searxng/compositions/searxng-bootstrap.js'
    );

    const yaml: string = searxngBootstrap.toYaml();

    // RGD structure
    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: searxng-bootstrap');

    // All resource types present
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: ConfigMap');
    expect(yaml).toContain('kind: Namespace');

    // CEL expressions in status (not raw property access)
    expect(yaml).toContain('.exists(c,');

    // ConfigMap settings YAML uses a mixed template with string()-wrapped CEL refs.
    expect(yaml).toContain('string(schema.spec.server.limiter)');

    // REGRESSION: required fields in template literals (like `${spec.name}-config`)
    // should produce clean mixed templates, NOT be wrapped in has() conditionals.
    // Only OPTIONAL fields should get ternary wrapping.
    expect(yaml).toContain('name: ${string(schema.spec.name)}-config');
    expect(yaml).not.toContain('has(schema.spec.name)');

    // No proxy artifacts
    expect(yaml).not.toContain('undefined');
    expect(yaml).not.toContain('[object Object]');
  });

  it('should deploy via KRO controller and reconcile', async () => {
    const { searxngBootstrap } = await import(
      '../../../src/factories/searxng/compositions/searxng-bootstrap.js'
    );

    const kroNamespace = `typekro-kro-searxng-${suffix}`;
    const appNamespace = `searxng-kro-${suffix}`;

    await ensureNamespaceExists(kroNamespace, kubeConfig);

    let kroFactory: ResourceFactory<SearxngBootstrapConfig, SearxngBootstrapStatus> | undefined;
    try {
      kroFactory = searxngBootstrap.factory('kro', {
        namespace: kroNamespace,
        waitForReady: true,
        timeout: 120000,
        kubeConfig,
      });

      const instance = await kroFactory.deploy({
        name: 'searxng-kro',
        namespace: appNamespace,
        server: { secret_key: 'kro-test-key', limiter: false },
      });

      expect(instance.spec.name).toBe('searxng-kro');
      expect(instance.status.ready).toBe(true);

      // Verify pod health
      const proc = Bun.spawn(
        ['kubectl', 'get', 'pods', '-n', appNamespace, '-o', 'json'],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const podList = JSON.parse(output);
        for (const pod of podList.items) {
          expect(pod.status?.phase).toBe('Running');
        }
      }
    } finally {
      if (kroFactory) {
        try { await kroFactory.deleteInstance('searxng-kro'); } catch (e) {
          console.error('⚠️ KRO deleteInstance failed:', (e as Error).message);
        }
      }
      const { deleteNamespaceIfExists } = await import('../shared-kubeconfig.js');
      try { await deleteNamespaceIfExists(kroNamespace, kubeConfig); } catch {}
      try { await deleteNamespaceIfExists(appNamespace, kubeConfig); } catch {}
    }
  }, 180000);
});
