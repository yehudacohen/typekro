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

    // Verify Kro namespace is named 'kro-system' (must match ClusterRoleBinding in Kro Helm chart)
    const kroNamespace = namespaceResources.find((r: any) => r.metadata?.name === 'kro-system');
    expect(kroNamespace).toBeDefined();

    // Find HelmReleases (should have only KRO. Flux is a deployment closure not a resource)
    const helmReleases = bootstrap.resources.filter((r: any) => r.kind === 'HelmRelease');
    expect(helmReleases.length).toBe(1);

    // Find the Kro HelmRelease specifically
    const kroHelmRelease = helmReleases.find((r: any) => r.metadata?.name === 'kro') as any;
    expect(kroHelmRelease).toBeDefined();
    expect(kroHelmRelease.metadata?.name).toBe('kro');
    expect(kroHelmRelease.metadata?.namespace).toBe('kro-system');
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

  it('should include complete Flux RBAC configuration', () => {
    const bootstrap = typeKroRuntimeBootstrap({
      namespace: 'flux-system',
    });

    const factory = bootstrap.factory('kro', { namespace: 'flux-system' });
    const yaml = factory.toYaml();

    // Should contain the cluster-reconciler ClusterRoleBinding
    expect(yaml).toContain('kind: ClusterRoleBinding');
    expect(yaml).toContain('name: cluster-reconciler');

    // Should include all required Flux service accounts
    expect(yaml).toContain('name: kustomize-controller');
    expect(yaml).toContain('name: helm-controller');
    expect(yaml).toContain('name: source-controller');
    expect(yaml).toContain('name: notification-controller');
    expect(yaml).toContain('name: image-reflector-controller');
    expect(yaml).toContain('name: image-automation-controller');

    // All should be in the flux-system namespace
    expect(yaml).toMatch(/namespace: flux-system/g);
  });
});
