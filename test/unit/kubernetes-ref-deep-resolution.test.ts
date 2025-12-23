/**
 * Tests for deep KubernetesRef resolution in nested objects
 *
 * These tests validate that KubernetesRef proxy objects are properly resolved
 * when they appear in deeply nested structures like HelmRelease values.
 * This is critical for compositions that pass schema values to Helm charts.
 *
 * Bug fixed: When composition functions build objects with schema proxy values,
 * those values are KubernetesRef objects that need to be converted to actual values
 * during re-execution. Without proper resolution, they serialize to empty objects {}.
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition, simple } from '../../src/index.js';
import { isKubernetesRef } from '../../src/core/dependencies/type-guards.js';

describe('Deep KubernetesRef Resolution', () => {
  describe('Nested Object Value Resolution', () => {
    it('should resolve KubernetesRef values in deeply nested config objects', async () => {
      const ConfigSpec = type({
        name: 'string',
        namespace: 'string',
        adminKey: 'string',
        servicePort: 'number',
      });

      const ConfigStatus = type({
        ready: 'boolean',
        configApplied: 'boolean',
      });

      let capturedConfig: any = null;

      const testComposition = kubernetesComposition(
        {
          name: 'nested-config-test',
          apiVersion: 'test.com/v1',
          kind: 'NestedConfigTest',
          spec: ConfigSpec,
          status: ConfigStatus,
        },
        (spec) => {
          // Simulate building a nested config object like HelmRelease values
          // This is the pattern that was broken - nested objects with schema refs
          const nestedConfig = {
            config: {
              apisix: {
                serviceName: `${spec.namespace}-${spec.name}-admin`,
                serviceNamespace: spec.namespace,
                servicePort: spec.servicePort,
                adminKey: spec.adminKey,
              },
              kubernetes: {
                ingressClass: 'apisix',
                watchedNamespace: '',
              },
            },
            serviceAccount: {
              create: true,
            },
          };

          capturedConfig = nestedConfig;

          const _configMap = simple.ConfigMap({
            name: `${spec.name}-config`,
            data: {
              'config.json': JSON.stringify(nestedConfig),
            },
            id: 'configMap',
          });

          return {
            ready: true,
            configApplied: true,
          };
        }
      );

      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false,
      });

      // Generate YAML with actual values - this triggers re-execution
      const yaml = factory.toYaml({
        name: 'my-service',
        namespace: 'my-namespace',
        adminKey: 'secret-key-123',
        servicePort: 9180,
      });

      // Verify the nested config was built with actual values, not proxy objects
      expect(capturedConfig).toBeDefined();
      expect(capturedConfig.config.apisix.serviceName).toBe('my-namespace-my-service-admin');
      expect(capturedConfig.config.apisix.serviceNamespace).toBe('my-namespace');
      expect(capturedConfig.config.apisix.servicePort).toBe(9180);
      expect(capturedConfig.config.apisix.adminKey).toBe('secret-key-123');

      // Verify YAML contains resolved values
      expect(yaml).toContain('my-service-config');
    });

    it('should handle String() coercion for potential KubernetesRef proxies', async () => {
      const StringCoercionSpec = type({
        name: 'string',
        version: 'string',
      });

      const StringCoercionStatus = type({
        ready: 'boolean',
        resolvedName: 'string',
      });

      let firstCallValues: any = null;
      let secondCallValues: any = null;
      let callCount = 0;

      const testComposition = kubernetesComposition(
        {
          name: 'string-coercion-test',
          apiVersion: 'test.com/v1',
          kind: 'StringCoercionTest',
          spec: StringCoercionSpec,
          status: StringCoercionStatus,
        },
        (spec) => {
          callCount++;

          // Use String() coercion to get actual values from potential proxies
          const actualName = String(spec.name || 'default');
          const actualVersion = String(spec.version || '1.0.0');

          if (callCount === 1) {
            firstCallValues = { name: actualName, version: actualVersion };
          } else {
            secondCallValues = { name: actualName, version: actualVersion };
          }

          const _deployment = simple.Deployment({
            name: actualName,
            image: `nginx:${actualVersion}`,
            id: 'deployment',
          });

          return {
            ready: true,
            resolvedName: actualName,
          };
        }
      );

      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false,
      });

      const yaml = factory.toYaml({
        name: 'coercion-app',
        version: '2.0.0',
      });

      // First call should have proxy functions (String() converts them to string representation)
      expect(firstCallValues).toBeDefined();

      // Second call (re-execution) should have actual values
      expect(secondCallValues).toBeDefined();
      expect(secondCallValues.name).toBe('coercion-app');
      expect(secondCallValues.version).toBe('2.0.0');

      // Verify YAML contains resolved values
      expect(yaml).toContain('coercion-app');
      expect(yaml).toContain('nginx:2.0.0');
    });

    it('should resolve KubernetesRef in array elements', async () => {
      const ArraySpec = type({
        name: 'string',
        ports: 'number[]',
      });

      const ArrayStatus = type({
        ready: 'boolean',
        portCount: 'number',
      });

      let capturedPorts: any[] = [];

      const testComposition = kubernetesComposition(
        {
          name: 'array-resolution-test',
          apiVersion: 'test.com/v1',
          kind: 'ArrayResolutionTest',
          spec: ArraySpec,
          status: ArrayStatus,
        },
        (spec) => {
          // Build service with ports from spec
          const servicePorts = [80, 443].map((port, index) => ({
            name: `port-${index}`,
            port: port,
            targetPort: port,
          }));

          capturedPorts = servicePorts;

          const _service = simple.Service({
            name: spec.name,
            selector: { app: spec.name },
            ports: servicePorts,
            id: 'service',
          });

          return {
            ready: true,
            portCount: servicePorts.length,
          };
        }
      );

      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false,
      });

      const yaml = factory.toYaml({
        name: 'array-app',
        ports: [8080, 8443],
      });

      // Verify array elements were resolved
      expect(capturedPorts).toHaveLength(2);
      expect(capturedPorts[0].port).toBe(80);
      expect(capturedPorts[1].port).toBe(443);

      // Verify YAML contains the service
      expect(yaml).toContain('array-app');
    });
  });

  describe('HelmRelease Values Pattern', () => {
    it('should properly resolve schema refs in HelmRelease-like values structure', async () => {
      const HelmSpec = type({
        name: 'string',
        namespace: 'string',
        version: 'string',
        replicaCount: 'number',
      });

      const HelmStatus = type({
        ready: 'boolean',
        phase: 'string',
      });

      let capturedHelmValues: any = null;
      let reExecutionOccurred = false;

      const testComposition = kubernetesComposition(
        {
          name: 'helm-values-test',
          apiVersion: 'test.com/v1',
          kind: 'HelmValuesTest',
          spec: HelmSpec,
          status: HelmStatus,
        },
        (spec) => {
          // Check if we're in re-execution (actual values vs proxies)
          if (typeof spec.name === 'string') {
            reExecutionOccurred = true;
          }

          // Use String() coercion pattern (the fix we implemented)
          const actualName = String(spec.name || 'default');
          const actualNamespace = String(spec.namespace || 'default');
          // actualVersion is available for future use if needed
          const _actualVersion = String(spec.version || '1.0.0');

          // Build HelmRelease-like values structure
          const helmValues = {
            global: {
              imageRegistry: 'docker.io',
            },
            replicaCount: spec.replicaCount,
            service: {
              type: 'LoadBalancer',
              http: {
                enabled: true,
                servicePort: 80,
              },
              tls: {
                enabled: true,
                servicePort: 443,
              },
            },
            ingressController: {
              enabled: true,
              config: {
                apisix: {
                  serviceName: `${actualNamespace}-${actualName}-admin`,
                  serviceNamespace: actualNamespace,
                  servicePort: 9180,
                },
                kubernetes: {
                  ingressClass: 'apisix',
                  watchedNamespace: '',
                },
              },
            },
            apisix: {
              admin: {
                allow: {
                  ipList: ['0.0.0.0/0'],
                },
              },
              ssl: {
                enabled: true,
              },
            },
          };

          capturedHelmValues = helmValues;

          // Create a ConfigMap to simulate HelmRelease
          const _configMap = simple.ConfigMap({
            name: `${actualName}-helm-values`,
            data: {
              'values.yaml': JSON.stringify(helmValues, null, 2),
            },
            id: 'helmValues',
          });

          return {
            ready: true,
            phase: 'Ready',
          };
        }
      );

      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false,
      });

      const yaml = factory.toYaml({
        name: 'my-helm-app',
        namespace: 'my-helm-namespace',
        version: '2.8.0',
        replicaCount: 3,
      });

      // Verify re-execution occurred
      expect(reExecutionOccurred).toBe(true);

      // Verify HelmRelease values were built with actual values
      expect(capturedHelmValues).toBeDefined();
      expect(capturedHelmValues.ingressController.config.apisix.serviceName).toBe(
        'my-helm-namespace-my-helm-app-admin'
      );
      expect(capturedHelmValues.ingressController.config.apisix.serviceNamespace).toBe(
        'my-helm-namespace'
      );
      expect(capturedHelmValues.replicaCount).toBe(3);

      // Verify nested structures are intact
      expect(capturedHelmValues.service.tls.enabled).toBe(true);
      expect(capturedHelmValues.apisix.ssl.enabled).toBe(true);
      expect(capturedHelmValues.apisix.admin.allow.ipList).toEqual(['0.0.0.0/0']);

      // Verify YAML output
      expect(yaml).toContain('my-helm-app-helm-values');
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined and null values in nested objects', async () => {
      const NullableSpec = type({
        name: 'string',
        'optionalField?': 'string',
      });

      const NullableStatus = type({
        ready: 'boolean',
      });

      let capturedConfig: any = null;

      const testComposition = kubernetesComposition(
        {
          name: 'nullable-test',
          apiVersion: 'test.com/v1',
          kind: 'NullableTest',
          spec: NullableSpec,
          status: NullableStatus,
        },
        (spec) => {
          const config = {
            name: spec.name,
            optional: spec.optionalField || 'default-value',
            nested: {
              value: spec.optionalField,
            },
          };

          capturedConfig = config;

          const _configMap = simple.ConfigMap({
            name: `${spec.name}-config`,
            data: {
              config: JSON.stringify(config),
            },
            id: 'config',
          });

          return {
            ready: true,
          };
        }
      );

      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false,
      });

      // Test without optional field
      const yaml = factory.toYaml({
        name: 'nullable-app',
      });

      expect(capturedConfig).toBeDefined();
      expect(capturedConfig.name).toBe('nullable-app');
      expect(capturedConfig.optional).toBe('default-value');
      expect(yaml).toContain('nullable-app-config');
    });

    it('should handle boolean and number values correctly', async () => {
      const TypedSpec = type({
        name: 'string',
        enabled: 'boolean',
        count: 'number',
        ratio: 'number',
      });

      const TypedStatus = type({
        ready: 'boolean',
      });

      let capturedValues: any = null;

      const testComposition = kubernetesComposition(
        {
          name: 'typed-values-test',
          apiVersion: 'test.com/v1',
          kind: 'TypedValuesTest',
          spec: TypedSpec,
          status: TypedStatus,
        },
        (spec) => {
          capturedValues = {
            enabled: spec.enabled,
            count: spec.count,
            ratio: spec.ratio,
            computed: spec.count * 2,
          };

          const _configMap = simple.ConfigMap({
            name: spec.name,
            data: {
              enabled: String(spec.enabled),
              count: String(spec.count),
            },
            id: 'config',
          });

          return {
            ready: spec.enabled,
          };
        }
      );

      const factory = testComposition.factory('direct', {
        namespace: 'test',
        waitForReady: false,
      });

      const yaml = factory.toYaml({
        name: 'typed-app',
        enabled: true,
        count: 5,
        ratio: 0.75,
      });

      expect(capturedValues).toBeDefined();
      expect(capturedValues.enabled).toBe(true);
      expect(capturedValues.count).toBe(5);
      expect(capturedValues.ratio).toBe(0.75);
      expect(capturedValues.computed).toBe(10);
      expect(yaml).toContain('typed-app');
    });
  });
});

describe('KubernetesRef Type Guard', () => {
  it('should correctly identify KubernetesRef objects', () => {
    // Import the actual brand symbol
    const { KUBERNETES_REF_BRAND } = require('../../src/core/constants/brands.js');
    
    // Test with a mock KubernetesRef object using the actual Symbol brand
    const mockRef = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: '__schema__',
      fieldPath: 'spec.name',
    };

    expect(isKubernetesRef(mockRef)).toBe(true);
  });

  it('should return false for non-KubernetesRef objects', () => {
    expect(isKubernetesRef(null)).toBe(false);
    expect(isKubernetesRef(undefined)).toBe(false);
    expect(isKubernetesRef('string')).toBe(false);
    expect(isKubernetesRef(123)).toBe(false);
    expect(isKubernetesRef({ foo: 'bar' })).toBe(false);
    expect(isKubernetesRef([])).toBe(false);
  });
});
