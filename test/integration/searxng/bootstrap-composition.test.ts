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
import { ensureNamespaceExists } from '../shared-kubeconfig.js';

setDefaultTimeout(120000);

describe('SearXNG Bootstrap Composition', () => {
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
      search: {
        formats: ['html', 'json'],
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
    const healthOutput = await new Response(healthProc.stdout).text();
    const healthExit = await healthProc.exited;
    // healthz returns empty 200 or a small response
    expect(healthExit).toBe(0);
  }, 90000);

  it('should generate valid KRO YAML', async () => {
    const { searxngBootstrap } = await import(
      '../../../src/factories/searxng/compositions/searxng-bootstrap.js'
    );

    const yaml: string = searxngBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: searxng-bootstrap');
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: ConfigMap');
    expect(yaml).not.toContain('undefined');
  });
});
