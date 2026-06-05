/**
 * Integration Test Bootstrap Composition
 *
 * This composition wraps typeKroRuntimeBootstrap and adds all infrastructure
 * dependencies needed for integration tests:
 * - Cert-Manager (with CRDs) for certificate tests
 * - CloudNativePG (with CRDs) for managed PostgreSQL tests
 * - External-DNS (without real credentials - uses dryRun mode for tests)
 *
 * Note: For integration tests, we don't deploy External-DNS with real credentials.
 * Individual tests that need DNS functionality should use Pebble ACME server.
 */

import { type } from 'arktype';
import { getCurrentCompositionContext } from '../../src/core/composition/context.js';
import { cnpgBootstrap } from '../../src/factories/cnpg/compositions/cnpg-bootstrap.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';
import { certManager, kubernetesComposition, typeKroRuntimeBootstrap } from '../../src/index.js';

const IntegrationTestBootstrapSpec = type({
  namespace: 'string',
  'enableCertManager?': 'boolean',
  'enableCnpg?': 'boolean',
});

const IntegrationTestBootstrapStatus = type({
  ready: 'boolean',
  kroReady: 'boolean',
  fluxReady: 'boolean',
  certManagerReady: 'boolean',
  cnpgReady: 'boolean',
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
      enableCnpg: spec.enableCnpg !== false, // Default true
    };

    // 1. TypeKro Runtime (Flux + Kro) - Required for all tests
    const kroRuntimeComposition = typeKroRuntimeBootstrap({
      namespace: config.namespace,
      fluxVersion: 'v2.7.5',
      kroVersion: '0.9.1',
    });
    const kroRuntime = getCurrentCompositionContext()?.isReExecution
      ? kroRuntimeComposition({ namespace: config.namespace })
      : kroRuntimeComposition;

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

    let cnpgBootstrapInstance: ReturnType<typeof cnpgBootstrap> | null = null;
    if (config.enableCnpg) {
      cnpgBootstrapInstance = cnpgBootstrap({
        name: 'cnpg-operator',
        namespace: 'cnpg-system',
        version: '0.23.0',
        installCRDs: true,
      });
    }

    const kroRuntimeComponents = kroRuntime.status.components ?? {
      kroSystem: false,
      fluxSystem: false,
    };

    // Return status - use cross-composition references where possible
    return {
      ready:
        kroRuntimeComponents.kroSystem &&
        kroRuntimeComponents.fluxSystem &&
        (certManagerBootstrapInstance ? certManagerBootstrapInstance.status.ready || false : true) &&
        (cnpgBootstrapInstance ? cnpgBootstrapInstance.status.ready || false : true),
      kroReady: kroRuntimeComponents.kroSystem,
      fluxReady: kroRuntimeComponents.fluxSystem,
      certManagerReady: certManagerBootstrapInstance
        ? certManagerBootstrapInstance.status.ready || false
        : true,
      cnpgReady: cnpgBootstrapInstance ? cnpgBootstrapInstance.status.ready || false : true,
    };
  }
);
