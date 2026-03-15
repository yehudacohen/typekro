/**
 * Tests for the integration test bootstrap composition
 *
 * Validates that the shared bootstrap composition correctly uses
 * cross-composition status references.
 */

import { describe, expect, it } from 'bun:test';
import { integrationTestBootstrap } from '../integration/shared-bootstrap.js';
import { expectKubernetesRef } from '../utils/mock-factories.js';

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

    // Verify these are KubernetesRef objects with correct properties
    expectKubernetesRef(readyRef, {
      resourceId: 'integration-test-bootstrap',
      fieldPath: 'status.ready',
    });
    expectKubernetesRef(kroReadyRef, {
      resourceId: 'integration-test-bootstrap',
      fieldPath: 'status.kroReady',
    });
    expectKubernetesRef(fluxReadyRef, {
      fieldPath: 'status.fluxReady',
    });
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

    expectKubernetesRef(certManagerReadyRef, {
      fieldPath: 'status.certManagerReady',
    });
  });
});
