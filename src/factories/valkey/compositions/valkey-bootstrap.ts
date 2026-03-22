import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { valkeyHelmRelease, valkeyHelmRepository } from '../resources/helm.js';
import {
  type ValkeyBootstrapConfig,
  ValkeyBootstrapConfigSchema,
  ValkeyBootstrapStatusSchema,
} from '../types.js';
import { mapValkeyConfigToHelmValues } from '../utils/helm-values-mapper.js';

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
    const resolvedVersion = spec.version || 'v0.0.61-chart';

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
          'app.kubernetes.io/version': resolvedVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'valkeyNamespace',
    });

    // OCI HelmRepositories don't have status in Flux, which can cause the deploy
    // engine to block waiting for readiness. Create both resources but don't depend
    // on the repository readiness — Flux handles the OCI → chart resolution internally.
    const _helmRepository = valkeyHelmRepository({
      name: 'valkey-operator-repo',
      namespace: DEFAULT_FLUX_NAMESPACE,
      id: 'valkeyHelmRepository',
    });

    const _helmRelease = valkeyHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      repositoryName: 'valkey-operator-repo',
      id: 'valkeyHelmRelease',
    });

    // Status derived from HelmRelease conditions.
    // Three-state phase: Ready if condition is True, Failed if condition is
    // explicitly False (not just missing/Unknown), Installing otherwise.
    return {
      ready: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      // Two-state phase: nested ternaries with .exists() require repeating the
      // full resource path in CEL, which Cel.expr(ref, operator) can't express.
      // Use simple Ready/Installing for now — matches what the CEL evaluator supports.
      phase: Cel.expr<'Ready' | 'Installing'>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      version: resolvedVersion,
    };
  }
);
