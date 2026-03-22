import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_VALKEY_REPO_NAME,
  DEFAULT_VALKEY_VERSION,
  valkeyHelmRelease,
  valkeyHelmRepository,
} from '../resources/helm.js';
import {
  type ValkeyBootstrapConfig,
  ValkeyBootstrapConfigSchema,
  ValkeyBootstrapStatusSchema,
} from '../types.js';
import { mapValkeyConfigToHelmValues } from '../utils/helm-values-mapper.js';

/**
 * Strips the '-chart' suffix from a Hyperspike version tag for labeling.
 * The Helm chart version (e.g. 'v0.0.61-chart') differs from the app version
 * ('v0.0.61'). Labels should use the app version per k8s well-known labels spec.
 */
function stripChartSuffix(version: string): string {
  return version.replace(/-chart$/, '');
}

/**
 * Hyperspike Valkey Operator Bootstrap Composition
 *
 * Deploys the Hyperspike Valkey operator via HelmRepository and HelmRelease.
 * The operator manages Valkey clusters as Kubernetes-native resources.
 *
 * This composition:
 * 1. Creates the target namespace
 * 2. Creates a HelmRepository pointing to the Hyperspike OCI registry
 * 3. Creates a HelmRelease that installs the operator
 *
 * After the operator is running, use the `valkey()` factory to create
 * Valkey cluster resources.
 *
 * @example
 * ```typescript
 * // 'kro' = KRO mode (continuous reconciliation via ResourceGraphDefinition)
 * // 'direct' = Direct mode (immediate apply, no KRO controller needed)
 * const factory = valkeyBootstrap.factory('kro', {
 *   namespace: 'valkey-operator-system',
 *   waitForReady: true,
 * });
 *
 * await factory.deploy({
 *   name: 'valkey-operator',
 *   namespace: 'valkey-operator-system',
 * });
 * ```
 */
export const valkeyBootstrap = kubernetesComposition(
  {
    name: 'valkey-bootstrap',
    kind: 'ValkeyBootstrap',
    spec: ValkeyBootstrapConfigSchema,
    status: ValkeyBootstrapStatusSchema,
  },
  (spec: ValkeyBootstrapConfig) => {
    const resolvedNamespace = spec.namespace || 'valkey-operator-system';
    const resolvedVersion = spec.version || DEFAULT_VALKEY_VERSION;
    const appVersion = stripChartSuffix(resolvedVersion);

    const helmValues = mapValkeyConfigToHelmValues({
      ...spec,
      namespace: resolvedNamespace,
      version: resolvedVersion,
    });

    // Resources are _-prefixed because they're registered via side effects in the
    // kubernetesComposition callback — the composition captures them automatically.
    // They're referenced in the status return via their `id`.
    const _valkeyNamespace = namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'valkey-operator',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': appVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'valkeyNamespace',
    });

    // OCI HelmRepositories don't have status in Flux, which can cause the deploy
    // engine to block waiting for readiness. Create both resources but don't depend
    // on the repository readiness — Flux handles the OCI → chart resolution internally.
    const _helmRepository = valkeyHelmRepository({
      name: DEFAULT_VALKEY_REPO_NAME,
      namespace: DEFAULT_FLUX_NAMESPACE,
      id: 'valkeyHelmRepository',
    });

    const _helmRelease = valkeyHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      repositoryName: DEFAULT_VALKEY_REPO_NAME,
      id: 'valkeyHelmRelease',
    });

    // Status derived from HelmRelease conditions.
    return {
      ready: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      // Phase cannot distinguish Failed from Installing due to a CEL evaluator
      // limitation (#48). Use the `failed` field for failure detection.
      phase: Cel.expr<'Ready' | 'Installing'>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      // Separate failed boolean — workaround for the nested CEL ternary limitation.
      // True when the Ready condition is explicitly False (not just absent/Unknown).
      failed: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "False")'
      ),
      version: appVersion,
    };
  }
);
