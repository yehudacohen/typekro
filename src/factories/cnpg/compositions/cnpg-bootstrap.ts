import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/index.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { clusterRoleBinding } from '../../kubernetes/rbac/cluster-role-binding.js';
import { cnpgHelmRelease, cnpgHelmRepository } from '../resources/helm.js';
import {
  type CnpgBootstrapConfig,
  CnpgBootstrapConfigSchema,
  CnpgBootstrapStatusSchema,
} from '../types.js';
import { mapCnpgConfigToHelmValues } from '../utils/helm-values-mapper.js';

/**
 * CloudNativePG Operator Bootstrap Composition
 *
 * Deploys the CloudNativePG operator via HelmRepository and HelmRelease resources.
 * The operator manages PostgreSQL clusters as Kubernetes-native resources.
 *
 * This composition:
 * 1. Creates the target namespace
 * 2. Creates a HelmRepository pointing to the CNPG chart repo
 * 3. Creates a HelmRelease that installs the operator
 *
 * After the operator is running, use the `cluster()`, `backup()`,
 * `scheduledBackup()`, and `pooler()` factories to create database resources.
 *
 * @example
 * ```typescript
 * const cnpgFactory = cnpgBootstrap.factory('kro', {
 *   namespace: 'cnpg-system',
 *   waitForReady: true,
 * });
 *
 * await cnpgFactory.deploy({
 *   name: 'cnpg',
 *   namespace: 'cnpg-system',
 *   version: '0.23.0',
 *   installCRDs: true,
 * });
 * ```
 */
export const cnpgBootstrap = kubernetesComposition(
  {
    name: 'cnpg-bootstrap',
    kind: 'CnpgBootstrap',
    spec: CnpgBootstrapConfigSchema,
    status: CnpgBootstrapStatusSchema,
  },
  (spec: CnpgBootstrapConfig) => {
    const resolvedNamespace = spec.namespace || 'cnpg-system';
    const resolvedVersion = spec.version || '0.23.0';
    // Default to shared-lifecycle: the operator is cluster-scoped
    // infrastructure and should survive individual consumer instance
    // deletions. Users can opt out by passing `shared: false` when
    // they want a dedicated per-instance operator (isolation, version
    // testing, multi-tenancy).
    const isShared = spec.shared !== false;

    // Map config to Helm values
    const helmValues = mapCnpgConfigToHelmValues({
      ...spec,
      namespace: resolvedNamespace,
      version: resolvedVersion,
    });

    // Resources are _-prefixed because they're registered via side effects in the
    // kubernetesComposition callback — the composition captures them automatically.
    // They're referenced in the status return via their `id`.
    const _cnpgNamespace = namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'cloudnative-pg',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': resolvedVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'cnpgNamespace',
    });

    // Create HelmRepository for CNPG charts
    const _helmRepository = cnpgHelmRepository({
      name: 'cnpg-repo',
      namespace: DEFAULT_FLUX_NAMESPACE,
      id: 'cnpgHelmRepository',
    });

    // Create HelmRelease for the CNPG operator
    const _helmRelease = cnpgHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      repositoryName: 'cnpg-repo',
      id: 'cnpgHelmRelease',
    });

    // Repair stale shared installs where the Helm-owned ClusterRoleBinding
    // still points at an older operator namespace. Kubernetes allows multiple
    // bindings to the same ClusterRole, and this supplemental binding keeps the
    // operator service account functional after namespace moves/re-installs.
    const supplementalClusterRoleBinding = clusterRoleBinding({
      metadata: {
        name: `${spec.name}-${resolvedNamespace}-cloudnative-pg-typekro-binding`,
        labels: {
          'app.kubernetes.io/name': 'cloudnative-pg',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: 'cnpg-operator-cloudnative-pg',
      },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: 'cnpg-operator-cloudnative-pg',
          namespace: resolvedNamespace,
        },
      ],
      id: 'cnpgSupplementalClusterRoleBinding',
    });

    // Tag all resources with 'cluster' scope so factory-level
    // deleteInstance leaves the operator install intact for other
    // consumers. Callers can explicitly tear down shared infra with
    // `deleteInstance(name, { scopes: ['cluster'] })`. The
    // HelmRepository in flux-system is ALWAYS shared (per rule #23)
    // because multiple compositions legitimately reference the same
    // chart repo — we tag it here too for clarity.
    if (isShared) {
      setMetadataField(_cnpgNamespace, 'scopes', ['cluster']);
      setMetadataField(_helmRepository, 'scopes', ['cluster']);
      setMetadataField(_helmRelease, 'scopes', ['cluster']);
      setMetadataField(supplementalClusterRoleBinding, 'scopes', ['cluster']);
    }

    // Status derived from HelmRelease conditions.
    // Flux HelmRelease v2 uses conditions with type='Ready' for readiness.
    return {
      ready: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      // Two-state phase: nested ternaries with .exists() require repeating the
      // full resource path in CEL, which Cel.expr(ref, operator) cannot express.
      // The second .exists() lacks a receiver and produces invalid CEL.
      phase: Cel.expr<'Ready' | 'Installing'>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      version: resolvedVersion,
    };
  }
);
