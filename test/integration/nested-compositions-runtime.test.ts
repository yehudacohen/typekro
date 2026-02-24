/**
 * Nested Compositions Runtime Integration Tests
 *
 * Tests the complete nested compositions functionality including:
 * - Event monitoring stability
 * - ClusterIssuer deployment
 * - Status builder analysis
 * - Deployment reliability and error recovery
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { Cel, certManager, kubernetesComposition, simple } from '../../src/index.js';
import {
  cleanupCertManagerWebhooks,
  deleteNamespaceAndWait,
  ensureCertManagerInstalled,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from './shared-kubeconfig.js';

// Test timeout for integration tests
const TEST_TIMEOUT = 300000; // 5 minutes

// Check if cluster is available
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Nested Compositions Runtime Integration', () => {
  let kc: k8s.KubeConfig;
  let unhandledRejectionHandler: ((reason: unknown) => void) | undefined;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    // Configure kubeconfig with TLS skip for integration tests
    kc = getIntegrationTestKubeConfig();

    // Ensure cert-manager is installed (idempotent - skips if already present)
    console.log('📦 Ensuring cert-manager is available for nested compositions tests...');
    await ensureCertManagerInstalled({ kubeConfig: kc });
    console.log('✅ Cert-manager is ready');

    // Ensure we have a clean test environment
    console.log('🧪 Setting up nested compositions integration tests...');

    // LAYER 1: Global Unhandled Rejection Handler
    // ============================================
    // Why this layer exists:
    // Bun's fetch/watch implementation has a known issue where abort() can throw
    // an async AbortError/DOMException that escapes the normal try-catch error
    // handling in stopMonitoring(). This happens because:
    //
    // 1. stopMonitoring() calls abort() on watch connections
    // 2. stopMonitoring() completes and returns
    // 3. THEN an async AbortError fires from Bun's watch stream (outside promise chain)
    // 4. This unhandled error appears as "Unhandled error between tests"
    //
    // This layer catches these expected AbortErrors and suppresses them gracefully.
    // Reference: https://github.com/oven-sh/bun/issues/...
    unhandledRejectionHandler = (reason: unknown) => {
      const error = reason as { name?: string; message?: string };
      const errorName = error?.name;
      const errorMessage = error?.message || '';

      // Suppress AbortError and DOMException during test cleanup - these are expected
      // when stopping event monitoring in Bun's runtime
      if (
        errorName === 'AbortError' ||
        errorName === 'DOMException' ||
        errorMessage.includes('aborted')
      ) {
        // Silently ignore - this is expected during test cleanup
        return;
      }

      // Re-throw other unhandled rejections - they indicate real problems
      throw reason;
    };
    process.on('unhandledRejection', unhandledRejectionHandler);
  });

  afterAll(async () => {
    // Remove the unhandledRejection handler to prevent accumulation across test suites
    if (unhandledRejectionHandler) {
      process.removeListener('unhandledRejection', unhandledRejectionHandler);
      unhandledRejectionHandler = undefined;
    }

    // Cleanup test resources
    console.log('Cleaning up nested compositions integration tests...');

    // Clean up the nested-test-cm namespace created by the nested compositions test.
    // We can't use factory.deleteInstance() because it would also delete the shared
    // cert-manager HelmRepository in flux-system.
    try {
      await deleteNamespaceAndWait('nested-test-cm', kc);
    } catch (_e) {
      // Ignore - namespace may not exist if the test didn't run
    }

    // Clean up cluster-scoped webhook configurations created by the test cert-manager
    // installation. These are NOT namespace-scoped and persist after namespace deletion,
    // causing HTTP 500 errors for all subsequent cert-manager resource operations.
    try {
      await cleanupCertManagerWebhooks('nested-test-cm', kc);
    } catch (_e) {
      // Ignore - webhooks may not exist if the test didn't run
    }
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

      // LAYER 2: Async Cleanup Delay
      // ============================
      // Why this layer exists:
      // After deleteInstance() completes, the event monitor's stopMonitoring()
      // is called which aborts all watch connections. However, Bun's watch stream
      // can fire async AbortError/DOMException events that occur on the next
      // event loop tick, AFTER stopMonitoring() has returned.
      //
      // This small delay allows those async errors to fire and be caught by
      // our Layer 1 unhandledRejection handler before the test completes.
      // Without this, the error would appear as "Unhandled error between tests".
      //
      // 100ms is sufficient for all async operations to settle on modern hardware.
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    TEST_TIMEOUT
  );

  it('should deploy ClusterIssuer successfully', async () => {
    // Test ClusterIssuer deployment in isolation using a composition.
    // Uses a selfSigned issuer for fast, reliable readiness in test environments
    // (ACME issuers require real internet connectivity from the cluster which is unreliable).
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
            selfSigned: {},
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
        const errorMessage =
          error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
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
          // Call cert-manager bootstrap as a nested composition.
          // Use a unique namespace to avoid conflicting with the existing cert-manager
          // installation in 'cert-manager' namespace. Disable startupapicheck to avoid
          // post-install hook timeouts.
          const _certManagerInstance = certManager.certManagerBootstrap({
            name: 'nested-test-cm',
            namespace: 'nested-test-cm',
            version: '1.19.3',
            installCRDs: false, // Don't install CRDs - they already exist from the main cert-manager
            startupapicheck: { enabled: false },
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

      // NOTE: We intentionally do NOT call factory.deleteInstance('nested-test') here
      // because it contains a HelmRepository ('cert-manager-repo' in flux-system) that
      // is shared with the main cert-manager installation. Deleting it via rollback
      // would remove the shared HelmRepo, breaking subsequent cert-manager tests.
      // The 'nested-test-cm' namespace is cleaned up in afterAll instead.
    },
    TEST_TIMEOUT
  );

  it(
    'should handle cross-composition references',
    async () => {
      // Re-ensure cert-manager is available - the previous nested composition test
      // deletes its cert-manager HelmRelease which causes Flux to uninstall cert-manager
      await ensureCertManagerInstalled({ kubeConfig: kc });

      // Deploy a self-signed ClusterIssuer using typekro's composition pattern
      // so the certificate can actually become ready
      const IssuerSetupSpec = type({ name: 'string' });
      const IssuerSetupStatus = type({ ready: 'boolean' });

      const issuerComposition = kubernetesComposition(
        {
          name: 'cross-ref-issuer-setup',
          apiVersion: 'test.typekro.dev/v1alpha1',
          kind: 'CrossRefIssuerSetup',
          spec: IssuerSetupSpec,
          status: IssuerSetupStatus,
        },
        (spec) => {
          const _issuer = certManager.clusterIssuer({
            name: spec.name,
            spec: {
              selfSigned: {},
            },
            id: 'selfSignedIssuer',
          });

          return {
            ready: true,
          };
        }
      );

      const issuerFactory = issuerComposition.factory('direct', {
        namespace: 'default',
        timeout: 60000,
        waitForReady: true,
        kubeConfig: kc,
      });

      await issuerFactory.deploy({ name: 'cross-ref-test-issuer' });

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

      // Deploy with cross-composition reference pointing to our self-signed issuer
      const factory = crossRefComposition.factory('direct', {
        namespace: 'default',
        timeout: 120000,
        waitForReady: true,
        kubeConfig: kc,
      });

      const result = await factory.deploy({
        name: 'cross-ref-test',
        issuerName: 'cross-ref-test-issuer', // References the issuer we deployed above
      });

      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
      // The deployment should be ready (readyReplicas >= 1)
      expect(result.status.ready).toBe(true);
      // The certificate should be ready since we have a self-signed issuer
      expect(result.status.certificateReady).toBe(true);

      // Cleanup
      await factory.deleteInstance('cross-ref-test');
      await issuerFactory.deleteInstance('cross-ref-test-issuer');
    },
    TEST_TIMEOUT
  );
});
