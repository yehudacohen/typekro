/** Synthetic file-backed public provider regressions; no API requests or credentials. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKubernetesClientProvider,
  type KubernetesClientConfig,
  type KubernetesClientProvider,
} from '../../../src/core/kubernetes/client-provider.js';

const DEFAULT_SERVER = 'https://default.example.invalid:6443';
const TARGET_SERVER = 'https://target.example.invalid:6443';
const OVERRIDE_SERVER = 'https://override.example.invalid:6443';

const fixture = {
  apiVersion: 'v1',
  kind: 'Config',
  clusters: [
    {
      name: 'default-cluster',
      cluster: { server: DEFAULT_SERVER, 'insecure-skip-tls-verify': false },
    },
    {
      name: 'target-cluster',
      cluster: { server: TARGET_SERVER, 'insecure-skip-tls-verify': true },
    },
  ],
  users: [
    { name: 'default-user', user: {} },
    { name: 'target-user', user: {} },
  ],
  contexts: [
    { name: 'default', context: { cluster: 'default-cluster', user: 'default-user' } },
    { name: 'target', context: { cluster: 'target-cluster', user: 'target-user' } },
  ],
  'current-context': 'default',
};

describe('Kubernetes client context and cluster overrides', () => {
  let dir: string;
  let kubeconfigPath: string;
  const providers: KubernetesClientProvider[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'typekro-config-overrides-'));
    kubeconfigPath = join(dir, 'kubeconfig.json');
    writeFileSync(kubeconfigPath, JSON.stringify(fixture));
  });

  afterEach(() => {
    for (const provider of providers.splice(0)) provider.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  function createProvider(options: KubernetesClientConfig) {
    const provider = createKubernetesClientProvider({
      kubeconfigPath,
      loadFromDefault: true,
      ...options,
    });
    providers.push(provider);
    return provider.getKubeConfig();
  }

  it.each([false, true])(
    'applies skipTLSVerify=%s to the requested context only',
    (skipTLSVerify) => {
      const kc = createProvider({ context: 'target', skipTLSVerify });

      expect(kc.getCurrentContext()).toBe('target');
      expect(kc.getCurrentUser()?.name).toBe('target-user');
      expect(kc.getCurrentCluster()).toMatchObject({ server: TARGET_SERVER, skipTLSVerify });
      expect(kc.getCluster('default-cluster')).toMatchObject({
        server: DEFAULT_SERVER,
        skipTLSVerify: false,
      });
    }
  );

  it.each([
    { context: 'default', skipTLSVerify: false },
    { context: 'default', skipTLSVerify: true },
    { context: 'target', skipTLSVerify: false },
    { context: 'target', skipTLSVerify: true },
  ])('combines server and TLS overrides for $context with TLS skip=$skipTLSVerify', (options) => {
    const kc = createProvider({ ...options, server: OVERRIDE_SERVER });
    const otherName = options.context === 'target' ? 'default-cluster' : 'target-cluster';

    expect(kc.getCurrentContext()).toBe(options.context);
    expect(kc.getCurrentCluster()).toMatchObject({
      server: OVERRIDE_SERVER,
      skipTLSVerify: options.skipTLSVerify,
    });
    expect(kc.getCluster(otherName)).toMatchObject({
      server: options.context === 'target' ? DEFAULT_SERVER : TARGET_SERVER,
      skipTLSVerify: options.context !== 'target',
    });
  });

  it('preserves selected TLS settings when only the server is overridden', () => {
    const kc = createProvider({ context: 'target', server: OVERRIDE_SERVER });

    expect(kc.getCurrentCluster()).toMatchObject({ server: OVERRIDE_SERVER, skipTLSVerify: true });
    expect(kc.getCluster('default-cluster')?.server).toBe(DEFAULT_SERVER);
  });

  it('preserves both loaded clusters when only a context is selected', () => {
    const kc = createProvider({ context: 'target' });

    expect(kc.getCurrentContext()).toBe('target');
    expect(kc.getCurrentCluster()).toMatchObject({ server: TARGET_SERVER, skipTLSVerify: true });
    expect(kc.getCluster('default-cluster')).toMatchObject({
      server: DEFAULT_SERVER,
      skipTLSVerify: false,
    });
  });

  it('combines both overrides on the current context when context is omitted', () => {
    const kc = createProvider({ skipTLSVerify: true, server: OVERRIDE_SERVER });

    expect(kc.getCurrentContext()).toBe('default');
    expect(kc.getCurrentCluster()).toMatchObject({ server: OVERRIDE_SERVER, skipTLSVerify: true });
    expect(kc.getCluster('target-cluster')?.server).toBe(TARGET_SERVER);
  });

  it('preserves the loaded current context and settings when no overrides are supplied', () => {
    const kc = createProvider({});

    expect(kc.getCurrentContext()).toBe('default');
    expect(kc.getCurrentCluster()).toMatchObject({ server: DEFAULT_SERVER, skipTLSVerify: false });
    expect(kc.getCluster('target-cluster')).toMatchObject({
      server: TARGET_SERVER,
      skipTLSVerify: true,
    });
  });
});
