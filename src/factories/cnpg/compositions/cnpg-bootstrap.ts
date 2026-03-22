import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
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

    // Map config to Helm values
    const helmValues = mapCnpgConfigToHelmValues({
      ...spec,
      namespace: resolvedNamespace,
      version: resolvedVersion,
    });

    // Create namespace for the CNPG operator
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

    // Status derived from HelmRelease conditions.
    // Flux HelmRelease v2 uses conditions with type='Ready' for readiness.
    return {
      ready: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      phase: Cel.expr<'Ready' | 'Pending' | 'Installing' | 'Failed' | 'Upgrading'>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      version: resolvedVersion,
    };
  }
);
