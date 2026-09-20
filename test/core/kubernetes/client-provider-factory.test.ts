/**
 * `createKubernetesClientProvider` — the optional-config contract (#219).
 *
 * The factory is documented as "create and initialize a provider instance", and callers
 * that omit the config mean "the ambient kubeconfig". It used to initialize only when a
 * config object was passed, so an omitted config produced a provider whose first
 * `getKubeConfig()` threw `KubernetesClientProvider not initialized`. That reached
 * `clickHouseSchema` without a `kubeConfig` and a `KroResource` without `kubeConfigOptions`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createKubernetesClientProvider,
  KubernetesClientProvider,
} from '../../../src/core/kubernetes/client-provider.js';

const AMBIENT_SERVER = 'https://ambient.example.invalid:6443';

const ambientKubeConfigYaml = [
  'apiVersion: v1',
  'kind: Config',
  'clusters:',
  '  - name: ambient',
  '    cluster:',
  `      server: ${AMBIENT_SERVER}`,
  '      insecure-skip-tls-verify: true',
  'users:',
  '  - name: runner',
  '    user: {}',
  'contexts:',
  '  - name: ambient',
  '    context:',
  '      cluster: ambient',
  '      user: runner',
  'current-context: ambient',
  '',
].join('\n');

describe('createKubernetesClientProvider — optional config (#219)', () => {
  let dir: string;
  let previousKubeconfig: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'typekro-client-provider-'));
    const kubeconfigPath = join(dir, 'kubeconfig');
    writeFileSync(kubeconfigPath, ambientKubeConfigYaml);
    previousKubeconfig = process.env.KUBECONFIG;
    process.env.KUBECONFIG = kubeconfigPath;
  });

  afterEach(() => {
    if (previousKubeconfig === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = previousKubeconfig;
    rmSync(dir, { recursive: true, force: true });
  });

  it('initializes from the ambient kubeconfig when called with no config', () => {
    const provider = createKubernetesClientProvider();

    expect(provider.isInitialized()).toBe(true);
    const kubeConfig = provider.getKubeConfig();
    expect(kubeConfig.getCurrentContext()).toBe('ambient');
    expect(kubeConfig.getCurrentCluster()?.server).toBe(AMBIENT_SERVER);
  });

  it('initializes from the ambient kubeconfig when called with an explicit undefined', () => {
    const provider = createKubernetesClientProvider(undefined);

    expect(provider.isInitialized()).toBe(true);
    expect(provider.getKubeConfig().getCurrentCluster()?.server).toBe(AMBIENT_SERVER);
  });

  it('still honours a supplied config', () => {
    const provider = createKubernetesClientProvider({
      cluster: { name: 'explicit', server: 'https://explicit.example.invalid:6443', skipTLSVerify: true },
      user: { name: 'runner', token: 'not-a-real-token' },
      context: 'explicit',
    });

    expect(provider.isInitialized()).toBe(true);
    expect(provider.getKubeConfig().getCurrentCluster()?.server).toBe(
      'https://explicit.example.invalid:6443'
    );
  });

  it('createInstance() remains the way to get a deliberately uninitialized provider', () => {
    const provider = KubernetesClientProvider.createInstance();

    expect(provider.isInitialized()).toBe(false);
    expect(() => provider.getKubeConfig()).toThrow(/not initialized/);
  });
});
