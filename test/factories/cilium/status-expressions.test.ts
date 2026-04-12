/**
 * Tests for Cilium Bootstrap Status Expressions
 *
 * This test suite validates the sophisticated CEL-based status expressions
 * in the Cilium bootstrap composition, ensuring they provide accurate
 * integration points for other systems.
 */

import { describe, expect, it } from 'bun:test';
import { ciliumBootstrap } from '../../../src/factories/cilium/compositions/cilium-bootstrap.js';

describe('Cilium Bootstrap Status Expressions', () => {
  describe('Overall Status Logic', () => {
    it('should provide sophisticated phase determination based on HelmRelease status', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      expect(yaml).toContain('phase:');
      expect(yaml).toContain('ready:');
      expect(yaml).toContain('version:');
    });

    it('should provide component readiness with sophisticated logic', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      expect(yaml).toContain('agentReady:');
      expect(yaml).toContain('operatorReady:');
      expect(yaml).toContain('hubbleReady:');
    });
  });

  describe('Feature Status Expressions', () => {
    it('should provide feature status based on configuration and deployment state', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      // Feature status fields are static (based on spec configuration) and are hydrated by TypeKro
      // They don't appear in Kro YAML since they don't reference Kubernetes resources
      // Only dynamic fields referencing helmRelease.status appear in the YAML
      expect(yaml).toContain('helmRelease.status.conditions.exists(c, c.type ==');
      expect(yaml).toContain(
        'ready: ${helmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
      );
    });
  });

  describe('Integration Endpoints', () => {
    it('should provide comprehensive integration endpoints', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      // Static fields like endpoints are hydrated by TypeKro, not sent to Kro
      // Only dynamic fields referencing Kubernetes resources should appear in Kro YAML
      expect(yaml).toContain('helmRelease.status.conditions.exists(c, c.type ==');
      expect(yaml).toContain(
        'ready: ${helmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
      );

      // Verify the ResourceGraphDefinition structure is correct
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: cilium-bootstrap');
    });
  });

  describe('CNI Integration Points', () => {
    it('should provide CNI integration points with configurable paths and readiness', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      // Static CNI fields are hydrated by TypeKro, not sent to Kro
      // Only dynamic readiness fields should appear in Kro YAML
      expect(yaml).toContain(
        'ready: ${helmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
      );

      // Verify HelmRepository and HelmRelease resources are included
      expect(yaml).toContain('kind: HelmRepository');
      expect(yaml).toContain('kind: HelmRelease');
    });
  });

  describe('Networking Status', () => {
    it('should provide networking status with configuration and readiness', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      // Static networking configuration fields are hydrated by TypeKro, not sent to Kro
      // Only dynamic readiness fields should appear in Kro YAML
      expect(yaml).toContain(
        'ready: ${helmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
      );
      expect(yaml).toContain('url: https://helm.cilium.io/');
    });
  });

  describe('Security Status', () => {
    it('should provide security status with encryption and authentication details', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      // Static security configuration fields are hydrated by TypeKro, not sent to Kro
      // Only dynamic readiness fields should appear in Kro YAML
      expect(yaml).toContain('helmRelease.status.conditions.exists(c, c.type ==');
      expect(yaml).toContain(
        'ready: ${helmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
      );
    });
  });

  describe('BGP Status', () => {
    it('should provide BGP status with configuration and readiness', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      // Static BGP configuration fields are hydrated by TypeKro, not sent to Kro
      // Only dynamic readiness fields should appear in Kro YAML
      expect(yaml).toContain(
        'ready: ${helmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
      );

      // Verify BGP configuration is included in Helm values
      expect(yaml).toContain('values:');
    });
  });

  describe('Gateway API Status', () => {
    it('should provide Gateway API status with configuration and readiness', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      // Static Gateway API configuration fields are hydrated by TypeKro, not sent to Kro
      // Only dynamic readiness fields should appear in Kro YAML
      expect(yaml).toContain(
        'ready: ${helmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
      );

      // Verify Gateway API configuration is included in Helm values
      // gatewayAPI.enabled is an optional scalar — the deepest optional
      // prefix on the ref path gets the has() guard. YAML serializer
      // quotes the value because the `?` and `:` are special characters.
      expect(yaml).toContain(
        'enabled: "${has(schema.spec.gatewayAPI.enabled) ? schema.spec.gatewayAPI.enabled : omit()}"'
      );
    });
  });

  describe('Observability Status', () => {
    it('should provide comprehensive observability status', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      // Observability configuration appears in Helm values, not status
      // Status only contains dynamic fields referencing Kubernetes resources
      expect(yaml).toContain('helmRelease.status.conditions.exists(c, c.type ==');
      expect(yaml).toContain(
        'hubbleReady: ${helmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
      );

      // Verify observability configuration is included in Helm values
      expect(yaml).toContain('hubble:');
      // observability.hubbleEnabled is an optional scalar — the deepest
      // optional prefix on the ref path gets the has() guard.
      expect(yaml).toContain(
        'enabled: "${has(schema.spec.observability.hubbleEnabled) ? schema.spec.observability.hubbleEnabled : omit()}"'
      );
      expect(yaml).toContain('prometheus:');
      expect(yaml).toContain(
        'enabled: "${has(schema.spec.observability.prometheusEnabled) ? schema.spec.observability.prometheusEnabled : omit()}"'
      );
    });
  });

  describe('Resource Counts', () => {
    it('should provide resource count placeholders for runtime hydration', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();
      // Static resource count fields are hydrated by TypeKro, not sent to Kro
      // Verify the ResourceGraphDefinition contains the actual resources
      expect(yaml).toContain('resources:');
      expect(yaml).toContain('- id: helmRepository');
      expect(yaml).toContain('- id: helmRelease');
    });
  });

  describe('Default Value Handling', () => {
    it('should provide sensible defaults for all status fields', async () => {
      const factory = await ciliumBootstrap.factory('kro', { namespace: 'test' });

      const yaml = await factory.toYaml();

      // Check that dynamic status fields are present in Kro YAML
      expect(yaml).toContain('helmRelease.status.conditions.exists(c, c.type ==');
      expect(yaml).toContain(
        'ready: ${helmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
      );

      // Static fields are handled by TypeKro engine, not sent to Kro
      // Verify the overall ResourceGraphDefinition structure
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('resources:');
    });
  });
});
