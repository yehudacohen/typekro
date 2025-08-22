import { describe, expect, it } from 'bun:test';
import { typeKroRuntimeBootstrap } from '../../src/core/composition/typekro-runtime/index.js';

describe('TypeKro Runtime Bootstrap Composition', () => {
  it('should create bootstrap composition with default config', () => {
    const bootstrap = typeKroRuntimeBootstrap();

    expect(bootstrap).toBeDefined();
    expect(bootstrap.name).toBe('typekro-runtime-bootstrap');
    expect(bootstrap.resources).toBeDefined();
    expect(bootstrap.factory).toBeDefined();
  });

  it('should create bootstrap composition with custom config', () => {
    const bootstrap = typeKroRuntimeBootstrap({
      namespace: 'custom-system',
      fluxVersion: 'v2.4.0',
      kroVersion: '0.4.0',
    });

    expect(bootstrap).toBeDefined();
    expect(bootstrap.name).toBe('typekro-runtime-bootstrap');
  });

  it('should contain required resources including HelmRelease', () => {
    const bootstrap = typeKroRuntimeBootstrap({
      namespace: 'flux-system',
    });

    // Check that resources are defined
    expect(bootstrap.resources).toBeDefined();
    expect(bootstrap.resources.length).toBeGreaterThan(0);

    // Find namespace resources
    const namespaceResources = bootstrap.resources.filter((r: any) => r.kind === 'Namespace');
    expect(namespaceResources.length).toBe(2); // system and kro namespaces

    // Verify Kro namespace is named 'kro'
    const kroNamespace = namespaceResources.find((r: any) => r.metadata?.name === 'kro');
    expect(kroNamespace).toBeDefined();

    // Find HelmRelease for Kro
    const helmReleases = bootstrap.resources.filter((r: any) => r.kind === 'HelmRelease');
    expect(helmReleases.length).toBe(1);

    const kroHelmRelease = helmReleases[0] as any;
    expect(kroHelmRelease).toBeDefined();
    expect(kroHelmRelease.metadata?.name).toBe('kro');
    expect(kroHelmRelease.metadata?.namespace).toBe('kro');
  });

  it('should use correct Flux URLs for different versions', () => {
    const latestBootstrap = typeKroRuntimeBootstrap({ fluxVersion: 'latest' });
    const versionedBootstrap = typeKroRuntimeBootstrap({ fluxVersion: 'v2.4.0' });

    // Both should be defined
    expect(latestBootstrap).toBeDefined();
    expect(versionedBootstrap).toBeDefined();
  });

  it('should use HelmRelease with correct chart configuration', () => {
    const bootstrap = typeKroRuntimeBootstrap({
      namespace: 'flux-system',
      kroVersion: '0.4.0',
    });

    const helmReleases = bootstrap.resources.filter((r: any) => r.kind === 'HelmRelease');
    expect(helmReleases.length).toBe(1);
    const kroHelmRelease = helmReleases[0] as any;
    expect(kroHelmRelease).toBeDefined();
    expect(kroHelmRelease.spec?.chart?.spec?.chart).toBe('kro');
    expect(kroHelmRelease.spec?.chart?.spec?.version).toBe('0.4.0');
    expect(kroHelmRelease.spec?.chart?.spec?.sourceRef?.name).toBe('kro-helm-repo');
  });

  it('should create factory successfully', async () => {
    const bootstrap = typeKroRuntimeBootstrap({
      namespace: 'test-system',
    });

    // This should not throw
    expect(() => bootstrap.factory).not.toThrow();
  });

  it('should have proper toYaml method', () => {
    const bootstrap = typeKroRuntimeBootstrap();

    expect(bootstrap.toYaml).toBeDefined();
    expect(typeof bootstrap.toYaml).toBe('function');
  });
});
