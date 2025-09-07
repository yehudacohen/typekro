/**
 * Tests for Cilium Bootstrap Composition
 *
 * This test suite validates the Cilium bootstrap composition functionality,
 * including configuration schema validation, resource creation, and status
 * expression generation. Tests are designed to work with both mock and
 * real Kubernetes environments.
 */

import { describe, it, expect } from 'bun:test';
import { kubernetesComposition } from '../../../src/index.js';
import { ciliumBootstrap, CiliumBootstrapSpecSchema, CiliumBootstrapStatusSchema } from '../../../src/factories/cilium/compositions/cilium-bootstrap.js';
import { mapCiliumConfigToHelmValues, validateCiliumHelmValues } from '../../../src/factories/cilium/resources/helm.js';
import type { CiliumBootstrapConfig } from '../../../src/factories/cilium/types.js';

// Use the actual bootstrap schemas

describe('Cilium Bootstrap Composition', () => {
  describe('Configuration Schema Validation', () => {
    it('should validate basic configuration schema', () => {
      const validConfig = {
        name: 'cilium',
        cluster: {
          name: 'test-cluster',
          id: 1,
        },
        version: '1.18.1',
        security: {
          encryption: {
            enabled: true,
            type: 'wireguard' as const,
          },
        },
        observability: {
          hubble: {
            enabled: true,
          },
        },
      };

      // Test that the schema accepts valid configuration
      const result = CiliumBootstrapSpecSchema(validConfig);
      expect(result instanceof Error).toBe(false);
    });

    it('should validate status schema', () => {
      const validStatus = {
        phase: 'Ready' as const,
        ready: true,
        agentReady: true,
        operatorReady: true,
        hubbleReady: true,
        version: '1.18.1',
        encryptionEnabled: true,
        bgpEnabled: false,
        gatewayAPIEnabled: false,
        clusterMeshReady: true,
        endpoints: {
          health: 'http://cilium-agent:9879/healthz',
          metrics: 'http://cilium-agent:9962/metrics',
        },
        cni: {
          configPath: '/etc/cni/net.d/05-cilium.conflist',
          socketPath: '/var/run/cilium/cilium.sock',
          binPath: '/opt/cni/bin',
        },
        networking: {
          ipamMode: 'kubernetes',
          kubeProxyReplacement: 'strict',
          routingMode: 'native',
        },
        security: {
          policyEnforcement: 'default',
          encryptionStatus: 'wireguard',
          authenticationEnabled: false,
        },
        resources: {
          totalNodes: 3,
          readyNodes: 3,
          totalEndpoints: 10,
          totalIdentities: 5,
        },
      };

      // Test that the schema accepts valid status
      const result = CiliumBootstrapStatusSchema(validStatus);
      expect(result instanceof Error).toBe(false);
    });
  });

  describe('Bootstrap Composition Creation', () => {
    it('should create a valid bootstrap composition', () => {
      expect(ciliumBootstrap).toBeDefined();
      expect(ciliumBootstrap.name).toBe('cilium-bootstrap');
    });

    it('should create resources with proper configuration', () => {
      // Test that the composition can generate YAML
      const yaml = ciliumBootstrap.toYaml();
      expect(yaml).toBeDefined();
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: cilium-bootstrap');
    });
  });

  describe('Configuration Mapping Integration', () => {
    it('should properly map configuration to Helm values', () => {
      const config: CiliumBootstrapConfig = {
        name: 'cilium',
        cluster: {
          name: 'production',
          id: 1,
        },
        networking: {
          kubeProxyReplacement: 'strict',
          routingMode: 'native',
          ipam: {
            mode: 'cluster-pool',
            operator: {
              clusterPoolIPv4PodCIDRList: ['10.0.0.0/8'],
            },
          },
        },
        security: {
          encryption: {
            enabled: true,
            type: 'wireguard',
            nodeEncryption: true,
          },
          policyEnforcement: 'always',
        },
        observability: {
          hubble: {
            enabled: true,
            relay: { enabled: true },
            ui: { enabled: true },
          },
          prometheus: {
            enabled: true,
            serviceMonitor: { enabled: true },
          },
        },
      };

      const helmValues = mapCiliumConfigToHelmValues(config);

      expect(helmValues.cluster).toEqual({
        name: 'production',
        id: 1,
      });
      expect(helmValues.kubeProxyReplacement).toBe(true);
      expect(helmValues.routingMode).toBe('native');
      expect(helmValues.ipam?.mode).toBe('cluster-pool');
      expect(helmValues.encryption?.enabled).toBe(true);
      expect(helmValues.encryption?.type).toBe('wireguard');
      expect(helmValues.policyEnforcement).toBe('always');
      expect(helmValues.hubble?.enabled).toBe(true);
      expect(helmValues.prometheus?.enabled).toBe(true);
    });

    it('should handle minimal configuration', () => {
      const minimalConfig: CiliumBootstrapConfig = {
        name: 'cilium',
        cluster: {
          name: 'minimal',
          id: 1,
        },
      };

      const helmValues = mapCiliumConfigToHelmValues(minimalConfig);

      expect(helmValues.cluster).toEqual({
        name: 'minimal',
        id: 1,
      });
      // Other fields should be undefined when not specified
      expect(helmValues.kubeProxyReplacement).toBeUndefined();
      expect(helmValues.encryption).toBeUndefined();
      expect(helmValues.hubble).toBeUndefined();
    });

    it('should merge custom values correctly', () => {
      const config: CiliumBootstrapConfig = {
        name: 'cilium',
        cluster: {
          name: 'test',
          id: 1,
        },
        customValues: {
          debug: {
            enabled: true,
            verbose: 'datapath',
          },
          resources: {
            limits: {
              memory: '1Gi',
            },
          },
        },
      };

      const helmValues = mapCiliumConfigToHelmValues(config);

      expect(helmValues.cluster).toEqual({
        name: 'test',
        id: 1,
      });
      expect((helmValues as any).debug).toEqual({
        enabled: true,
        verbose: 'datapath',
      });
      expect((helmValues as any).resources).toEqual({
        limits: {
          memory: '1Gi',
        },
      });
    });
  });

  describe('Status Expression Generation', () => {
    it('should generate proper status expressions', async () => {
      // This test validates that the ciliumBootstrap composition generates the expected
      // status structure that can be converted to CEL expressions
      expect(ciliumBootstrap).toBeDefined();
      
      // The composition should be able to create factories
      const factory = await ciliumBootstrap.factory('direct', { namespace: 'test' });
      expect(factory).toBeDefined();

      // Test that we can generate YAML output
      const yaml = await factory.toYaml();
      expect(yaml).toBeDefined();
      expect(typeof yaml).toBe('string');
      expect(yaml.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid configuration gracefully', () => {
      expect(() => {
        const config: CiliumBootstrapConfig = {
          name: 'cilium',
          cluster: {
            name: 'test',
            id: 256, // Invalid: too high
          },
        };

        mapCiliumConfigToHelmValues(config);
      }).not.toThrow(); // The mapping should not throw, validation happens separately
    });

    it('should validate Helm values after mapping', () => {
      const config: CiliumBootstrapConfig = {
        name: 'cilium',
        cluster: {
          name: 'test',
          id: 256, // Invalid: too high
        },
      };

      const helmValues = mapCiliumConfigToHelmValues(config);
      
      // Import validation function
      const { validateCiliumHelmValues } = require('../../../src/factories/cilium/resources/helm.js');
      const validation = validateCiliumHelmValues(helmValues);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('cluster.id must be a number between 0 and 255');
    });
  });
});

// TODO: Add integration tests that:
// - Test with real Kubernetes clusters
// - Deploy actual Cilium installations
// - Validate network functionality
// - Test status reporting with live resources
// - Test composition readiness evaluation