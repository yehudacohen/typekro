import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/index.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_VALKEY_REPO_NAME,
  DEFAULT_VALKEY_REPO_URL,
  DEFAULT_VALKEY_VERSION,
  valkeyHelmRelease,
} from '../resources/helm.js';
import {
  type ValkeyBootstrapConfig,
  ValkeyBootstrapConfigSchema,
  ValkeyBootstrapStatusSchema,
} from '../types.js';
import { mapValkeyConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { valkeyHelmRepositoryBootstrap } from './valkey-helm-repository.js';

/**
 * Strips the '-chart' suffix from the verified built-in Hyperspike version.
 * Runtime schema references cannot be normalized synchronously, so explicit
 * version overrides are preserved as supplied.
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
    const resolvedNamespace = spec.namespace ?? 'valkey-operator-system';
    const resolvedVersion = spec.version ?? DEFAULT_VALKEY_VERSION;
    // A schema-proxy string cannot be normalized synchronously. Keep the
    // upstream chart tag for overrides; normalize the verified built-in default.
    const reportedVersion = spec.version ? spec.version : stripChartSuffix(DEFAULT_VALKEY_VERSION);
    // Default to shared-lifecycle so multiple consumers (e.g., many
    // `webAppWithProcessing` deployments) converge on a single operator
    // install. Users can opt out by passing `shared: false`.
    const isShared = spec.shared !== false;

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

    // The OCI source is cluster-wide and shared by every operator consumer.
    // Its singleton owner uses metadata.generation for readiness because Flux
    // OCI HelmRepositories do not consistently publish Ready conditions.
    const _helmRepository = singleton(valkeyHelmRepositoryBootstrap, {
      id: 'valkey-helm-repository',
      spec: {
        name: DEFAULT_VALKEY_REPO_NAME,
        namespace: DEFAULT_FLUX_NAMESPACE,
        url: DEFAULT_VALKEY_REPO_URL,
      },
    });

    const _helmRelease = valkeyHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      repositoryName: DEFAULT_VALKEY_REPO_NAME,
      id: 'valkeyHelmRelease',
    });

    // Tag all resources with 'cluster' scope so factory-level
    // deleteInstance leaves the operator install intact. Callers can
    // opt in to tearing down shared infra with
    // `deleteInstance(name, { scopes: ['cluster'] })`.
    if (isShared) {
      setMetadataField(_valkeyNamespace, 'scopes', ['cluster']);
      setMetadataField(_helmRelease, 'scopes', ['cluster']);
    }

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
      // Static version from deploy-time config, not derived from live HelmRelease
      // status. If the operator is upgraded out-of-band (e.g. Flux automation),
      // this value will not reflect the running version.
      version: reportedVersion,
    };
  }
);
