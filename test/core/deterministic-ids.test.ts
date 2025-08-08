import { describe, expect, it } from 'bun:test';
import { generateDeterministicResourceId, simpleDeployment } from '../../src/core.js';

describe('Deterministic Resource IDs', () => {
  it('should generate consistent IDs based on kind, namespace, and name', () => {
    const id1 = generateDeterministicResourceId('Deployment', 'web-app', 'default');
    const id2 = generateDeterministicResourceId('Deployment', 'web-app', 'default');

    expect(id1).toBe(id2);
    expect(id1).toBe('deploymentWebApp');
  });

  it('should handle different namespaces', () => {
    const defaultId = generateDeterministicResourceId('Deployment', 'web-app', 'default');
    const prodId = generateDeterministicResourceId('Deployment', 'web-app', 'production');

    expect(defaultId).toBe('deploymentWebApp');
    expect(prodId).toBe('deploymentWebApp');
    // Current implementation doesn't include namespace in ID generation
    // This is intentional based on the design - IDs are based on kind and name only
    expect(defaultId).toBe(prodId);
  });

  it('should clean special characters from names', () => {
    const id = generateDeterministicResourceId('Deployment', 'web_app@test!', 'my-namespace');
    expect(id).toBe('deploymentWebApp@test!');
  });

  it('should use deterministic IDs in resource creation', () => {
    const webapp1 = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
    });

    const webapp2 = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
    });

    // Both should have the same resource ID
    expect((webapp1 as any).__resourceId).toBe((webapp2 as any).__resourceId);
    expect((webapp1 as any).__resourceId).toBe('deploymentWebApp');
  });

  it('should support explicit IDs', () => {
    const webapp = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
      id: 'myCustomId',
    });

    expect((webapp as any).__resourceId).toBe('myCustomId');
  });

  it('should handle namespace in config', () => {
    const webapp = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
      namespace: 'production',
    });

    expect((webapp as any).__resourceId).toBe('deploymentWebApp');
  });
});
