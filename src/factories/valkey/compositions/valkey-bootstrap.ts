import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_VALKEY_REPO_NAME,
  DEFAULT_VALKEY_REPO_URL,
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
 * Strips the '-chart' suffix from the verified built-in Hyperspike version.
 * Runtime schema references cannot be normalized synchronously, so explicit
 * version overrides are preserved as supplied.
 */
function stripChartSuffix(version: string): string {
  return version.replace(/-chart$/, '');
}

const DEFAULT_VALKEY_OPERATOR_NAMESPACE = 'valkey-operator-system';

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
 *   namespace: 'typekro-system', // KRO instance/control-plane namespace
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
    const resolvedNamespace = spec.namespace ?? DEFAULT_VALKEY_OPERATOR_NAMESPACE;
    const resolvedVersion = spec.version ?? DEFAULT_VALKEY_VERSION;
    // A schema-proxy string cannot be normalized synchronously. Keep the
    // upstream chart tag for overrides; normalize the verified built-in default.
    const reportedVersion = spec.version ? spec.version : stripChartSuffix(DEFAULT_VALKEY_VERSION);
    const repositoryName = spec.repositoryName ?? DEFAULT_VALKEY_REPO_NAME;
    const repositoryNamespace = spec.repositoryNamespace ?? resolvedNamespace;
    const repositoryUrl = spec.repositoryUrl ?? DEFAULT_VALKEY_REPO_URL;

    const helmValues = mapValkeyConfigToHelmValues({
      ...(spec.customValues !== undefined && { customValues: spec.customValues }),
      ...(spec.values !== undefined && { values: spec.values }),
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
          'app.kubernetes.io/version': reportedVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'valkeyNamespace',
    });

    const _helmRepository = valkeyHelmRepository({
      name: repositoryName,
      namespace: repositoryNamespace,
      url: repositoryUrl,
      id: 'valkeyHelmRepository',
    });

    const _helmRelease = valkeyHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
      id: 'valkeyHelmRelease',
    });
    _helmRelease.dependsOn(_helmRepository);

    // Status derived from the Flux HelmRelease Ready condition.
    return {
      ...helmReleaseConditionSummary(_helmRelease),
      // Static version from deploy-time config, not derived from live HelmRelease
      // status. If the operator is upgraded out-of-band (e.g. Flux automation),
      // this value will not reflect the running version.
      version: reportedVersion,
    };
  }
);

/** Explicit lifecycle name for code that wants to emphasize ownership. */
export const valkeyOperatorInstallation = valkeyBootstrap;
