import { helmRelease } from '../../../factories/helm/helm-release.js';
import { helmRepository } from '../../../factories/helm/helm-repository.js';
import { namespace } from '../../../factories/kubernetes/core/namespace.js';
import { clusterRoleBinding } from '../../../factories/kubernetes/rbac/index.js';
import { yamlFile } from '../../../factories/kubernetes/yaml/yaml-file.js';
import { Cel } from '../../references/cel.js';
import { fixCRDSchemaForK8s133 } from '../../runtime-patches/crd-schema-fix.js';
import { kubernetesComposition } from '../imperative.js';
import { type TypeKroRuntimeConfig, TypeKroRuntimeSpec, TypeKroRuntimeStatus } from './types.js';

/**
 * Bootstrap TypeKro runtime with essential components
 *
 * Deploys Flux CD controllers and Kro using HelmRelease.
 * This replaces kubectl commands in bootstrap scripts with TypeKro-native deployments.
 *
 * @security This function creates a ClusterRoleBinding with `cluster-admin` privileges for
 * Flux controllers (kustomize-controller, helm-controller, source-controller, etc.).
 * This grants unrestricted cluster access to those service accounts. Ensure the target
 * namespace is trusted and review RBAC policies before deploying to production.
 *
 * @param config - Configuration for the runtime bootstrap
 *
 * @example
 * Basic usage:
 * ```typescript
 * const bootstrap = typeKroRuntimeBootstrap({
 *   namespace: 'flux-system',
 *   fluxVersion: 'v2.4.0',
 *   kroVersion: '0.8.5'
 * });
 *
 * const factory = await bootstrap.factory('direct', {
 *   namespace: 'flux-system',
 *   waitForReady: true,
 *   timeout: 300000
 * });
 *
 * const instance = await factory.deploy({
 *   namespace: 'flux-system'
 * });
 * ```
 */
export function typeKroRuntimeBootstrap(config: TypeKroRuntimeConfig = {}) {
  // Use a specific stable Flux version by default to avoid schema validation issues
  // that can occur with 'latest' (e.g., 422 errors on CRD validation)
  // v2.7.5 is the latest stable version with fixes for schema validation issues
  const fluxVersion = config.fluxVersion || 'v2.7.5';
  const kroVersion = config.kroVersion || '0.8.5';
  const targetNamespace = config.namespace || 'flux-system';

  return kubernetesComposition(
    {
      name: 'typekro-runtime-bootstrap',
      apiVersion: 'typekro.dev/v1alpha1',
      kind: 'TypeKroRuntime',
      spec: TypeKroRuntimeSpec,
      status: TypeKroRuntimeStatus,
    },
    (_spec) => {
      // System namespace for Flux
      const _systemNamespace = namespace({
        metadata: {
          name: targetNamespace,
        },
        id: 'systemNamespace',
      });

      // Kro system namespace - must be 'kro-system' to match the ClusterRoleBinding
      // that the Kro Helm chart creates (it references namespace: kro-system)
      const _kroNamespace = namespace({
        metadata: {
          name: 'kro-system',
        },
        id: 'kroNamespace',
      });

      // Flux CD system using yamlFile (matches integration test pattern)
      // Apply CRD schema fix for Kubernetes 1.33+ compatibility
      // (Flux CRDs use x-kubernetes-preserve-unknown-fields without type, which K8s 1.33 rejects)
      //
      // IMPORTANT: Using 'serverSideApply' strategy to merge CRD schema fixes with existing CRDs.
      // This is necessary because:
      // 1. Kubernetes 1.33+ requires the x-kubernetes-preserve-unknown-fields annotation
      // 2. CRDs may have stored versions that can't be removed until data is migrated
      // 3. Server-side apply merges changes without requiring full replacement
      //
      // forceConflicts: true is needed to take ownership of fields that may have been
      // modified by other field managers (e.g., kubectl-patch for manual CRD fixes)
      yamlFile({
        name: 'flux-system-install',
        path:
          fluxVersion === 'latest'
            ? 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml'
            : `https://github.com/fluxcd/flux2/releases/download/${fluxVersion}/install.yaml`,
        deploymentStrategy: 'serverSideApply',
        fieldManager: 'typekro-bootstrap',
        forceConflicts: true,
        manifestTransform: fixCRDSchemaForK8s133,
      });

      // Fix incomplete RBAC from standard Flux install - add missing service accounts to cluster-reconciler
      clusterRoleBinding({
        metadata: {
          name: 'cluster-reconciler',
          labels: {
            'app.kubernetes.io/instance': 'flux-system',
            'app.kubernetes.io/part-of': 'flux',
          },
        },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: 'cluster-admin',
        },
        subjects: [
          {
            kind: 'ServiceAccount',
            name: 'kustomize-controller',
            namespace: targetNamespace,
          },
          {
            kind: 'ServiceAccount',
            name: 'helm-controller',
            namespace: targetNamespace,
          },
          {
            kind: 'ServiceAccount',
            name: 'source-controller',
            namespace: targetNamespace,
          },
          {
            kind: 'ServiceAccount',
            name: 'notification-controller',
            namespace: targetNamespace,
          },
          {
            kind: 'ServiceAccount',
            name: 'image-reflector-controller',
            namespace: targetNamespace,
          },
          {
            kind: 'ServiceAccount',
            name: 'image-automation-controller',
            namespace: targetNamespace,
          },
        ],
      });

      // Helm Repository for Kro OCI charts
      helmRepository({
        name: 'kro-helm-repo',
        namespace: 'flux-system',
        url: 'oci://registry.k8s.io/kro/charts',
        interval: '5m',
        type: 'oci',
        id: 'kroHelmRepo',
      });

      // Kro using HelmRelease with OCI chart - Flux will manage the lifecycle
      // IMPORTANT: Must deploy to 'kro-system' namespace to match the ClusterRoleBinding
      // that the Kro Helm chart creates (it references namespace: kro-system for the service account)
      const kroHelmRelease = helmRelease({
        name: 'kro',
        namespace: 'kro-system',
        chart: {
          name: 'kro',
          repository: `oci://registry.k8s.io/kro/charts`,
          version: kroVersion,
        },
        interval: '5m',
        id: 'kroHelmRelease',
      });

      // Use CEL expressions with actual HelmRelease conditions (Flux v2 pattern).
      // HelmReleaseStatus has a conditions array, not a phase field.
      // We use CEL .exists() to check for the Ready condition, matching the
      // cert-manager-bootstrap and cilium-bootstrap patterns.
      return {
        phase: Cel.expr<'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading'>(
          kroHelmRelease.status.conditions,
          '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
        ),
        components: {
          fluxSystem: true,
          // Kro system readiness based on HelmRelease conditions
          kroSystem: Cel.expr<boolean>(
            kroHelmRelease.status.conditions,
            '.exists(c, c.type == "Ready" && c.status == "True")'
          ),
        },
      };
    }
  );
}
