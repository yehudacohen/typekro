/**
 * Tests for the integration test bootstrap composition
 *
 * Validates that the shared bootstrap composition correctly uses
 * cross-composition status references.
 */

import { describe, it, expect } from 'bun:test';
import { integrationTestBootstrap } from '../integration/shared-bootstrap.js';
import { KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';

describe('Integration Test Bootstrap', () => {
  it('should create bootstrap composition with proper structure', () => {
    expect(integrationTestBootstrap).toBeDefined();
    expect(typeof integrationTestBootstrap).toBe('function');
    expect(typeof integrationTestBootstrap.toYaml).toBe('function');
    expect(typeof integrationTestBootstrap.factory).toBe('function');
  });

  it('should have status property for cross-composition references', () => {
    expect(integrationTestBootstrap.status).toBeDefined();
    expect(typeof integrationTestBootstrap.status).toBe('object');
  });

  it('should provide status fields as KubernetesRef objects', () => {
    const readyRef = integrationTestBootstrap.status.ready;
    const kroReadyRef = integrationTestBootstrap.status.kroReady;
    const fluxReadyRef = integrationTestBootstrap.status.fluxReady;

    // Verify these are KubernetesRef objects
    expect((readyRef as any)[KUBERNETES_REF_BRAND]).toBe(true);
    expect((kroReadyRef as any)[KUBERNETES_REF_BRAND]).toBe(true);
    expect((fluxReadyRef as any)[KUBERNETES_REF_BRAND]).toBe(true);

    // Verify resource ID is correct
    expect((readyRef as any).resourceId).toBe('integration-test-bootstrap');
    expect((kroReadyRef as any).resourceId).toBe('integration-test-bootstrap');

    // Verify field paths
    expect((readyRef as any).fieldPath).toBe('status.ready');
    expect((kroReadyRef as any).fieldPath).toBe('status.kroReady');
    expect((fluxReadyRef as any).fieldPath).toBe('status.fluxReady');
  });

  it('should generate valid YAML', () => {
    const yaml = integrationTestBootstrap.toYaml();

    // When using Kro mode, the YAML contains a ResourceGraphDefinition wrapper
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('kind: IntegrationTestBootstrap');
    expect(yaml).toContain('integration-test-bootstrap');

    // Verify cross-composition references are serialized as CEL
    expect(yaml).toContain('kroSystem');
    expect(yaml).toContain('fluxSystem');
  });

  it('should support both kro and direct factory modes', () => {
    // Test factory creation without actually deploying
    expect(() => {
      integrationTestBootstrap.factory('kro', {
        namespace: 'test-namespace',
      });
    }).not.toThrow();

    expect(() => {
      integrationTestBootstrap.factory('direct', {
        namespace: 'test-namespace',
      });
    }).not.toThrow();
  });

  it('should handle optional components correctly', () => {
    const certManagerReadyRef = integrationTestBootstrap.status.certManagerReady;

    expect((certManagerReadyRef as any)[KUBERNETES_REF_BRAND]).toBe(true);
    expect((certManagerReadyRef as any).fieldPath).toBe('status.certManagerReady');
  });
});
