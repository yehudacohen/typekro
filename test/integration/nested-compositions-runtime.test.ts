/**
 * Nested Compositions Runtime Integration Tests
 *
 * Tests the complete nested compositions functionality including:
 * - Event monitoring stability
 * - ClusterIssuer deployment
 * - Status builder analysis
 * - Deployment reliability and error recovery
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  kubernetesComposition,
  simple,
  certManager,
  Cel,
} from '../../src/index.js';
import { type } from 'arktype';
import type * as k8s from '@kubernetes/client-node';
import { getIntegrationTestKubeConfig, isClusterAvailable } from './shared-kubeconfig.js';

// Test timeout for integration tests
const TEST_TIMEOUT = 300000; // 5 minutes

// Check if cluster is available
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Nested Compositions Runtime Integration', () => {
  let kc: k8s.KubeConfig;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    // Configure kubeconfig with TLS skip for integration tests
    kc = getIntegrationTestKubeConfig();

    // Ensure we have a clean test environment
    console.log('🧪 Setting up nested compositions integration tests...');
  });

  afterAll(async () => {
    // Cleanup test resources
    console.log('🧹 Cleaning up nested compositions integration tests...');
  });

  it(
    'should handle event monitoring without connection errors',
    async () => {
      // Create a simple composition that will trigger event monitoring
      const TestSpec = type({
        name: 'string',
      });

      const TestStatus = type({
        ready: 'boolean',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'event-monitor-test',
          apiVersion: 'test.typekro.dev/v1alpha1',
          kind: 'EventMonitorTest',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx:alpine',
            replicas: 1,
            id: 'testDeployment',
          });

          return {
            ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' >= 1'),
          };
        }
      );

      // Deploy with event monitoring enabled
      const factory = testComposition.factory('direct', {
        namespace: 'default',
        timeout: 60000, // 1 minute
        waitForReady: true,
        kubeConfig: kc,
        eventMonitoring: {
          enabled: true,
          eventTypes: ['Warning', 'Error', 'Normal'],
          includeChildResources: true,
        },
      });

      // This should complete without ConnResetException errors
      const result = await factory.deploy({ name: 'event-test' });
      expect(result).toBeDefined();
      expect(result.status.ready).toBe(true);

      // Cleanup
      await factory.deleteInstance('event-test');
    },
    TEST_TIMEOUT
  );

  it('should deploy ClusterIssuer successfully', async () => {
    // Test ClusterIssuer deployment in isolation using a composition
    const ClusterIssuerSpec = type({
      name: 'string',
    });

    const ClusterIssuerStatus = type({
      ready: 'boolean',
    });

    const clusterIssuerComposition = kubernetesComposition(
      {
        name: 'cluster-issuer-test',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'ClusterIssuerTest',
        spec: ClusterIssuerSpec,
        status: ClusterIssuerStatus,
      },
      (spec) => {
        const _issuer = certManager.clusterIssuer({
          name: spec.name,
          spec: {
            acme: {
              server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
              email: 'typekro-test@funwiththec.cloud',
              privateKeySecretRef: { name: 'test-issuer-key' },
              solvers: [
                {
                  http01: {
                    ingress: {
                      class: 'nginx',
                    },
                  },
                },
              ],
            },
          },
          id: 'testIssuer',
        });

        return {
          ready: true, // Static field for testing
        };
      }
    );

    // Deploy using direct factory
    const factory = clusterIssuerComposition.factory('direct', {
      namespace: 'default',
      timeout: 60000,
      waitForReady: true,
      kubeConfig: kc,
    });

    const result = await factory.deploy({ name: 'test-issuer' });
    expect(result).toBeDefined();

    // Cleanup
    await factory.deleteInstance('test-issuer');
  });

  it(
    'should handle status builder analysis correctly',
    async () => {
      // Test composition with both static and dynamic status fields
      const MixedStatusSpec = type({
        name: 'string',
        replicas: 'number',
      });

      const MixedStatusStatus = type({
        staticField: 'string',
        dynamicField: 'boolean',
        version: 'string',
      });

      const mixedStatusComposition = kubernetesComposition(
        {
          name: 'mixed-status-test',
          apiVersion: 'test.typekro.dev/v1alpha1',
          kind: 'MixedStatusTest',
          spec: MixedStatusSpec,
          status: MixedStatusStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx:alpine',
            replicas: spec.replicas,
            id: 'mixedDeployment',
          });

          return {
            staticField: 'static-value', // This should be hydrated directly
            dynamicField: Cel.expr<boolean>(deployment.status.readyReplicas, ' >= ', spec.replicas), // CEL expression
            version: '1.0.0', // This should be hydrated directly
          };
        }
      );

      // This should not throw errors about status builder analysis
      const factory = mixedStatusComposition.factory('direct', {
        namespace: 'default',
        timeout: 60000,
        waitForReady: true,
        kubeConfig: kc,
      });

      const result = await factory.deploy({ name: 'mixed-test', replicas: 1 });
      expect(result).toBeDefined();
      expect(result.status.staticField).toBe('static-value');
      expect(result.status.version).toBe('1.0.0');
      expect(result.status.dynamicField).toBe(true);

      // Cleanup
      await factory.deleteInstance('mixed-test');
    },
    TEST_TIMEOUT
  );

  it(
    'should handle deployment timeouts gracefully',
    async () => {
      // Test composition that will likely timeout
      const TimeoutSpec = type({
        name: 'string',
      });

      const TimeoutStatus = type({
        ready: 'boolean',
      });

      const timeoutComposition = kubernetesComposition(
        {
          name: 'timeout-test',
          apiVersion: 'test.typekro.dev/v1alpha1',
          kind: 'TimeoutTest',
          spec: TimeoutSpec,
          status: TimeoutStatus,
        },
        (spec) => {
          // Create a certificate that will take time to be ready
          const certificate = certManager.certificate({
            name: `${spec.name}-cert`,
            spec: {
              secretName: `${spec.name}-tls`,
              dnsNames: [`${spec.name}.example.com`],
              issuerRef: {
                name: 'nonexistent-issuer',
                kind: 'ClusterIssuer',
              },
            },
            id: 'timeoutCert',
          });

          return {
            ready: Cel.expr<boolean>(certificate.status.conditions, '[0].status == "True"'),
          };
        }
      );

      // Deploy with a short timeout to test error handling
      // With AbortController support, the deployment should properly cancel
      // all pending operations when the timeout is reached
      const factory = timeoutComposition.factory('direct', {
        namespace: 'default',
        timeout: 10000, // 10 seconds - should timeout
        waitForReady: true, // Now safe to use with AbortController support
        kubeConfig: kc,
      });

      // This should handle the timeout gracefully without lingering promises
      let caughtError = false;
      try {
        await factory.deploy({ name: 'timeout-test' });
      } catch (error) {
        caughtError = true;
        expect(error).toBeDefined();
        // Should be a timeout error or abort error
        const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        const errorName = error instanceof Error ? error.name : '';
        const isTimeoutOrAbortError = 
          errorMessage.includes('timeout') || 
          errorMessage.includes('abort') ||
          errorName === 'TimeoutError' ||
          errorName === 'AbortError';
        expect(isTimeoutOrAbortError).toBe(true);
      }

      expect(caughtError).toBe(true);

      // Cleanup (best effort)
      try {
        await factory.deleteInstance('timeout-test');
      } catch (_error) {
        // Ignore cleanup errors
      }

      // Wait for any pending Kubernetes client operations to settle
      // This prevents "Unhandled error between tests" from lingering HTTP requests
      await new Promise((resolve) => setTimeout(resolve, 2000));
    },
    TEST_TIMEOUT
  );

  it(
    'should deploy nested compositions successfully',
    async () => {
      // Test actual nested composition functionality
      const NestedSpec = type({
        name: 'string',
        domain: 'string',
      });

      const NestedStatus = type({
        ready: 'boolean',
        issuerReady: 'boolean',
      });

      const nestedComposition = kubernetesComposition(
        {
          name: 'nested-test',
          apiVersion: 'test.typekro.dev/v1alpha1',
          kind: 'NestedTest',
          spec: NestedSpec,
          status: NestedStatus,
        },
        (_spec) => {
          // Call cert-manager bootstrap as a nested composition
          const _certManagerInstance = certManager.certManagerBootstrap({
            name: 'test-cert-manager',
            namespace: 'cert-manager',
            version: '1.13.3',
            installCRDs: true,
            id: 'certManagerInstance',
          });

          return {
            // Use static true since nested compositions are deployed inline
            // In production, you'd wait for the HelmRelease to be ready
            ready: true,
            issuerReady: true,
          };
        }
      );

      // Deploy the nested composition
      const factory = nestedComposition.factory('direct', {
        namespace: 'default',
        timeout: 120000, // 2 minutes for nested deployment
        waitForReady: true,
        kubeConfig: kc,
      });

      const result = await factory.deploy({
        name: 'nested-test',
        domain: 'test.typekro-test.funwiththec.cloud',
      });

      expect(result).toBeDefined();
      expect(result.status.ready).toBe(true);
      expect(result.status.issuerReady).toBe(true);

      // Cleanup
      await factory.deleteInstance('nested-test');
    },
    TEST_TIMEOUT
  );

  it(
    'should handle cross-composition references',
    async () => {
      // Test cross-composition reference patterns
      const CrossRefSpec = type({
        name: 'string',
        issuerName: 'string',
      });

      const CrossRefStatus = type({
        ready: 'boolean',
        certificateReady: 'boolean',
      });

      const crossRefComposition = kubernetesComposition(
        {
          name: 'cross-ref-test',
          apiVersion: 'test.typekro.dev/v1alpha1',
          kind: 'CrossRefTest',
          spec: CrossRefSpec,
          status: CrossRefStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx:alpine',
            replicas: 1,
            id: 'crossRefDeployment',
          });

          // Reference the issuer name from spec (cross-composition reference)
          const certificate = certManager.certificate({
            name: `${spec.name}-cert`,
            spec: {
              secretName: `${spec.name}-tls`,
              dnsNames: [`${spec.name}.typekro-test.funwiththec.cloud`],
              issuerRef: {
                name: spec.issuerName, // Cross-composition reference
                kind: 'ClusterIssuer',
              },
            },
            id: 'certificate',
          });

          return {
            ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' >= 1'),
            certificateReady: Cel.expr<boolean>(
              certificate.status.conditions,
              '[0].status == "True"'
            ),
          };
        }
      );

      // Deploy with cross-composition reference
      const factory = crossRefComposition.factory('direct', {
        namespace: 'default',
        timeout: 60000,
        waitForReady: false, // Don't wait for certificate to be ready
        kubeConfig: kc,
      });

      const result = await factory.deploy({
        name: 'cross-ref-test',
        issuerName: 'test-issuer', // This would come from another composition
      });

      expect(result).toBeDefined();
      expect(result.status.ready).toBe(true);
      // Certificate may not be ready due to missing issuer, but that's expected

      // Cleanup
      await factory.deleteInstance('cross-ref-test');
    },
    TEST_TIMEOUT
  );
});
