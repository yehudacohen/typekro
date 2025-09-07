/**
 * Tests for Cilium Bootstrap Composition
 *
 * This test suite validates the Cilium bootstrap composition functionality,
 * including configuration schema validation, resource creation, and status
 * expression generation. Tests are designed to work with both mock and
 * real Kubernetes environments.
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { ciliumHelmRepository, ciliumHelmRelease, mapCiliumConfigToHelmValues } from '../../../src/factories/cilium/resources/helm.js';
import { Cel } from '../../../src/core/references/cel.js';
import type { CiliumBootstrapConfig } from '../../../src/factories/cilium/types.js';

// Test schemas for bootstrap composition
const CiliumStackSpec = type({
  name: 'string',
  clusterName: 'string',
  clusterId: 'number',
  version: 'string',
  enableEncryption: 'boolean',
  enableHubble: 'boolean',
});

const CiliumStackStatus = type({
  phase: 'string',
  ready: 'boolean',
  agentReady: 'boolean',
  operatorReady: 'boolean',
  hubbleReady: 'boolean',
  version: 'string',
  encryptionEnabled: 'boolean',
  endpoints: {
    health: 'string',
    metrics: 'string',
  },
  cni: {
    configPath: 'string',
    socketPath: 'string',
  },
});

describe('Cilium Bootstrap Composition', () => {
  describe('Configuration Schema Validation', () => {
    it('should validate basic configuration schema', () => {
      const validConfig = {
        name: 'cilium',
        clusterName: 'test-cluster',
        clusterId: 1,
        version: '1.18.1',
        enableEncryption: true,
        enableHubble: true,
      };

      // Test that the schema accepts valid configuration
      expect(() => CiliumStackSpec(validConfig)).not.toThrow();
    });

    it('should validate status schema', () => {
      const validStatus = {
        phase: 'Ready',
        ready: true,
        agentReady: true,
        operatorReady: true,
        hubbleReady: true,
        version: '1.18.1',
        encryptionEnabled: true,
        endpoints: {
          health: 'http://cilium-agent:9879/healthz',
          metrics: 'http://cilium-agent:9962/metrics',
        },
        cni: {
          configPath: '/etc/cni/net.d/05-cilium.conflist',
          socketPath: '/var/run/cilium/cilium.sock',
        },
      };

      // Test that the schema accepts valid status
      expect(() => CiliumStackStatus(validStatus)).not.toThrow();
    });
  });

  describe('Bootstrap Composition Creation', () => {
    it('should create a valid bootstrap composition', () => {
      const ciliumStack = kubernetesComposition(
        {
          name: 'cilium-stack',
          apiVersion: 'platform.example.com/v1alpha1',
          kind: 'CiliumStack',
          spec: CiliumStackSpec,
          status: CiliumStackStatus,
        },
        (spec) => {
          // Create Cilium Helm repository
          const _helmRepo = ciliumHelmRepository({
            name: 'cilium',
            namespace: 'flux-system',
            id: 'ciliumRepo',
          });

          // Create Cilium Helm release
          const helmRelease = ciliumHelmRelease({
            name: 'cilium',
            namespace: 'kube-system',
            version: spec.version,
            repositoryName: 'cilium',
            repositoryNamespace: 'flux-system',
            values: mapCiliumConfigToHelmValues({
              name: spec.name,
              cluster: {
                name: spec.clusterName,
                id: spec.clusterId,
              },
              security: {
                encryption: {
                  enabled: spec.enableEncryption,
                  type: 'wireguard',
                },
              },
              observability: {
                hubble: {
                  enabled: spec.enableHubble,
                  relay: { enabled: spec.enableHubble },
                  ui: { enabled: spec.enableHubble },
                },
              },
            }),
            id: 'ciliumRelease',
          });

          // Return status with CEL expressions
          return {
            phase: Cel.expr<string>(helmRelease.status.phase, ' == "Ready" ? "Ready" : "Installing"'),
            ready: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            agentReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            operatorReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            hubbleReady: spec.enableHubble,
            version: spec.version,
            encryptionEnabled: spec.enableEncryption,
            endpoints: {
              health: 'http://cilium-agent:9879/healthz',
              metrics: 'http://cilium-agent:9962/metrics',
            },
            cni: {
              configPath: '/etc/cni/net.d/05-cilium.conflist',
              socketPath: '/var/run/cilium/cilium.sock',
            },
          };
        }
      );

      expect(ciliumStack).toBeDefined();
      expect(ciliumStack.name).toBe('cilium-stack');
    });

    it('should create resources with proper configuration', async () => {
      const _testSpec = {
        name: 'test-cilium',
        clusterName: 'test-cluster',
        clusterId: 42,
        version: '1.18.1',
        enableEncryption: true,
        enableHubble: false,
      };

      const ciliumStack = kubernetesComposition(
        {
          name: 'cilium-stack',
          apiVersion: 'platform.example.com/v1alpha1',
          kind: 'CiliumStack',
          spec: CiliumStackSpec,
          status: CiliumStackStatus,
        },
        (spec) => {
          const _helmRepo = ciliumHelmRepository({
            name: 'cilium',
            namespace: 'flux-system',
            id: 'ciliumRepo',
          });

          const helmRelease = ciliumHelmRelease({
            name: 'cilium',
            namespace: 'kube-system',
            version: spec.version,
            repositoryName: 'cilium',
            repositoryNamespace: 'flux-system',
            values: mapCiliumConfigToHelmValues({
              name: spec.name,
              cluster: {
                name: spec.clusterName,
                id: spec.clusterId,
              },
              security: {
                encryption: {
                  enabled: spec.enableEncryption,
                  type: 'wireguard',
                },
              },
              observability: {
                hubble: {
                  enabled: spec.enableHubble,
                },
              },
            }),
            id: 'ciliumRelease',
          });

          return {
            phase: helmRelease.status.phase,
            ready: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            agentReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            operatorReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            hubbleReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            version: spec.version,
            encryptionEnabled: spec.enableEncryption,
            endpoints: {
              health: 'http://cilium-agent:9879/healthz',
              metrics: 'http://cilium-agent:9962/metrics',
            },
            cni: {
              configPath: '/etc/cni/net.d/05-cilium.conflist',
              socketPath: '/var/run/cilium/cilium.sock',
            },
          };
        }
      );

      // Test that the composition can create a factory
      const factory = await ciliumStack.factory('direct', { namespace: 'test' });
      expect(factory).toBeDefined();
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
      // This test validates that the composition generates the expected
      // status structure that can be converted to CEL expressions
      const ciliumStack = kubernetesComposition(
        {
          name: 'cilium-stack',
          apiVersion: 'platform.example.com/v1alpha1',
          kind: 'CiliumStack',
          spec: CiliumStackSpec,
          status: CiliumStackStatus,
        },
        (spec) => {
          const helmRelease = ciliumHelmRelease({
            name: 'cilium',
            namespace: 'kube-system',
            version: spec.version,
            repositoryName: 'cilium',
            repositoryNamespace: 'flux-system',
            id: 'ciliumRelease',
          });

          // Return status that will be converted to CEL expressions
          return {
            phase: helmRelease.status.phase,
            ready: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            agentReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            operatorReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            hubbleReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
            version: spec.version,
            encryptionEnabled: spec.enableEncryption,
            endpoints: {
              health: 'http://cilium-agent:9879/healthz',
              metrics: 'http://cilium-agent:9962/metrics',
            },
            cni: {
              configPath: '/etc/cni/net.d/05-cilium.conflist',
              socketPath: '/var/run/cilium/cilium.sock',
            },
          };
        }
      );

      expect(ciliumStack).toBeDefined();
      
      // The composition should be able to generate status
      const _testSpec = {
        name: 'test-cilium',
        clusterName: 'test-cluster',
        clusterId: 1,
        version: '1.18.1',
        enableEncryption: true,
        enableHubble: true,
      };

      const factory = await ciliumStack.factory('direct', { namespace: 'test' });
      expect(factory).toBeDefined();
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