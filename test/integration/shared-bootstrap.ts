/**
 * Integration Test Bootstrap Composition
 *
 * This composition wraps typeKroRuntimeBootstrap and adds all infrastructure
 * dependencies needed for integration tests:
 * - Cert-Manager (with CRDs) for certificate tests
 * - External-DNS (without real credentials - uses dryRun mode for tests)
 *
 * Note: For integration tests, we don't deploy External-DNS with real credentials.
 * Individual tests that need DNS functionality should use Pebble ACME server.
 */

import { type } from 'arktype';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';
import { certManager, kubernetesComposition, typeKroRuntimeBootstrap } from '../../src/index.js';

const IntegrationTestBootstrapSpec = type({
  namespace: 'string',
  'enableCertManager?': 'boolean',
});

const IntegrationTestBootstrapStatus = type({
  ready: 'boolean',
  kroReady: 'boolean',
  fluxReady: 'boolean',
  certManagerReady: 'boolean',
});

export const integrationTestBootstrap = kubernetesComposition(
  {
    name: 'integration-test-bootstrap',
    apiVersion: 'test.typekro.dev/v1alpha1',
    kind: 'IntegrationTestBootstrap',
    spec: IntegrationTestBootstrapSpec,
    status: IntegrationTestBootstrapStatus,
  },
  (spec) => {
    // Apply defaults
    const config = {
      namespace: spec.namespace || 'flux-system',
      enableCertManager: spec.enableCertManager !== false, // Default true
    };

    // 1. TypeKro Runtime (Flux + Kro) - Required for all tests
    const kroRuntime = typeKroRuntimeBootstrap({
      namespace: config.namespace,
      fluxVersion: 'v2.7.5',
      kroVersion: '0.3.0',
    });

    // 2. Cert-Manager (with CRDs) - Needed for certificate tests
    // Call resources directly (not nested in objects) to ensure proper registration
    let certManagerBootstrapInstance: ReturnType<typeof certManager.certManagerBootstrap> | null =
      null;
    if (config.enableCertManager) {
      namespace({
        metadata: { name: 'cert-manager' },
        id: 'certManagerNamespace',
      });

      certManagerBootstrapInstance = certManager.certManagerBootstrap({
        name: 'cert-manager',
        namespace: 'cert-manager',
        version: '1.19.3',
        installCRDs: true,
        // Disable startupapicheck to avoid post-install hook timeouts.
        // The startupapicheck job validates the webhook API, but it often times out
        // in CI/test environments due to slow pod scheduling. Instead, we rely on
        // the HelmRelease readiness check which validates cert-manager is operational.
        startupapicheck: { enabled: false },
      });
    }

    // Return status - use cross-composition references where possible
    return {
      ready:
        kroRuntime.status.components.kroSystem &&
        kroRuntime.status.components.fluxSystem &&
        (certManagerBootstrapInstance ? certManagerBootstrapInstance.status.ready || false : true),
      kroReady: kroRuntime.status.components.kroSystem,
      fluxReady: kroRuntime.status.components.fluxSystem,
      certManagerReady: certManagerBootstrapInstance
        ? certManagerBootstrapInstance.status.ready || false
        : true,
    };
  }
);
