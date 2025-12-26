/**
 * Tests for Cilium Helm Integration
 *
 * This test suite validates the Cilium Helm wrapper functions and ensures
 * they properly integrate with the generic Helm factories while providing
 * Cilium-specific configuration and validation.
 */

import { describe, it, expect } from 'bun:test';
import { ciliumHelmRepository, ciliumHelmRelease, mapCiliumConfigToHelmValues, validateCiliumHelmValues } from '../../../src/factories/cilium/resources/helm.js';
import type { CiliumBootstrapConfig } from '../../../src/factories/cilium/types.js';

describe('Cilium Helm Integration', () => {
  describe('ciliumHelmRepository', () => {
    it('should create a HelmRepository with Cilium-specific configuration', () => {
      const repo = ciliumHelmRepository({
        name: 'cilium',
        namespace: 'flux-system',
      });

      expect(repo).toBeDefined();
      expect(repo.metadata.name).toBe('cilium');
      expect(repo.spec.url).toBe('https://helm.cilium.io/');
      expect(repo.spec.interval).toBe('5m');
    });

    it('should allow custom configuration overrides', () => {
      const repo = ciliumHelmRepository({
        name: 'custom-cilium',
        namespace: 'custom-namespace',
        interval: '10m',
        timeout: '2m',
        labels: { environment: 'production' },
      });

      expect(repo.metadata.name).toBe('custom-cilium');
      expect(repo.spec.interval).toBe('10m');
      expect(repo.spec.url).toBe('https://helm.cilium.io/'); // Always uses Cilium repo
    });
  });

  describe('ciliumHelmRelease', () => {
    it('should create a HelmRelease with Cilium-specific configuration', () => {
      const release = ciliumHelmRelease({
        name: 'cilium',
        namespace: 'kube-system',
        version: '1.18.1',
        repositoryName: 'cilium',
        repositoryNamespace: 'flux-system',
      });

      expect(release).toBeDefined();
      expect(release.metadata.name).toBe('cilium');
      expect(release.metadata.namespace).toBe('kube-system');
      expect(release.spec.chart.spec.chart).toBe('cilium');
      expect(release.spec.chart.spec.version).toBe('1.18.1');
    });

    it('should include custom Helm values when provided', () => {
      const values = {
        cluster: { name: 'test', id: 1 },
        kubeProxyReplacement: 'strict' as const,
      };

      const release = ciliumHelmRelease({
        name: 'cilium',
        namespace: 'kube-system',
        version: '1.18.1',
        repositoryName: 'cilium',
        repositoryNamespace: 'flux-system',
        values,
      });

      expect(release.spec.values).toEqual(values);
    });
  });

  describe('mapCiliumConfigToHelmValues', () => {
    it('should map basic cluster configuration', () => {
      const config: CiliumBootstrapConfig = {
        name: 'cilium',
        cluster: {
          name: 'production',
          id: 1,
        },
      };

      const values = mapCiliumConfigToHelmValues(config);

      expect(values.cluster).toEqual({
        name: 'production',
        id: 1,
      });
    });

    it('should map networking configuration', () => {
      const config: CiliumBootstrapConfig = {
        name: 'cilium',
        cluster: { name: 'test', id: 1 },
        networking: {
          kubeProxyReplacement: 'strict',
          routingMode: 'native',
          tunnelProtocol: 'vxlan',
          autoDirectNodeRoutes: true,
          ipam: {
            mode: 'cluster-pool',
            operator: {
              clusterPoolIPv4PodCIDRList: ['10.0.0.0/8'],
            },
          },
        },
      };

      const values = mapCiliumConfigToHelmValues(config);

      expect(values.kubeProxyReplacement).toBe(true);
      expect(values.routingMode).toBe('native');
      expect(values.tunnelProtocol).toBe('vxlan');
      expect(values.autoDirectNodeRoutes).toBe(true);
      expect(values.ipam).toEqual({
        mode: 'cluster-pool',
        operator: {
          clusterPoolIPv4PodCIDRList: ['10.0.0.0/8'],
        },
      });
    });

    it('should map security configuration', () => {
      const config: CiliumBootstrapConfig = {
        name: 'cilium',
        cluster: { name: 'test', id: 1 },
        security: {
          encryption: {
            enabled: true,
            type: 'wireguard',
            nodeEncryption: true,
          },
          policyEnforcement: 'always',
          policyAuditMode: true,
        },
      };

      const values = mapCiliumConfigToHelmValues(config);

      expect(values.encryption).toEqual({
        enabled: true,
        type: 'wireguard',
        nodeEncryption: true,
      });
      expect(values.policyEnforcement).toBe('always');
      expect(values.policyAuditMode).toBe(true);
    });

    it('should merge custom values', () => {
      const config: CiliumBootstrapConfig = {
        name: 'cilium',
        cluster: { name: 'test', id: 1 },
        customValues: {
          debug: {
            enabled: true,
          },
          customField: 'customValue',
        },
      };

      const values = mapCiliumConfigToHelmValues(config);

      expect(values.cluster).toEqual({ name: 'test', id: 1 });
      expect((values as any).debug).toEqual({ enabled: true });
      expect((values as any).customField).toBe('customValue');
    });
  });

  describe('validateCiliumHelmValues', () => {
    it('should validate required cluster configuration', () => {
      const values = {
        cluster: {
          name: 'test',
          id: 1,
        },
      };

      const result = validateCiliumHelmValues(values);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject missing cluster configuration', () => {
      const values = {} as any;

      const result = validateCiliumHelmValues(values);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('cluster configuration is required');
    });

    it('should validate cluster ID range', () => {
      const values = {
        cluster: {
          name: 'test',
          id: 256, // Invalid: too high
        },
      };

      const result = validateCiliumHelmValues(values);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('cluster.id must be a number between 0 and 255');
    });

    it('should validate IPAM mode', () => {
      const values = {
        cluster: { name: 'test', id: 1 },
        ipam: {
          mode: 'invalid-mode' as any,
        },
      };

      const result = validateCiliumHelmValues(values);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('ipam.mode must be one of: kubernetes, cluster-pool, azure, aws-eni, crd');
    });

    it('should validate kube-proxy replacement mode', () => {
      const values = {
        cluster: { name: 'test', id: 1 },
        kubeProxyReplacement: 'invalid-mode' as any,
      };

      const result = validateCiliumHelmValues(values);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('kubeProxyReplacement must be one of: true, false, \'partial\'');
    });

    it('should validate encryption type', () => {
      const values = {
        cluster: { name: 'test', id: 1 },
        encryption: {
          enabled: true,
          type: 'invalid-type' as any,
        },
      };

      const result = validateCiliumHelmValues(values);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('encryption.type must be one of: wireguard, ipsec');
    });
  });
});

// TODO: Add integration tests that:
// - Test with real Kubernetes clusters
// - Validate actual Helm deployments
// - Test readiness evaluation with live resources
// - Test end-to-end Cilium installation