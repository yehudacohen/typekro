import { helmRelease } from '../../../factories/helm/helm-release.js';
import { helmRepository } from '../../../factories/helm/helm-repository.js';
import { namespace } from '../../../factories/kubernetes/core/namespace.js';
import { yamlFile } from '../../../factories/kubernetes/yaml/yaml-file.js';
import { clusterRoleBinding } from '../../../factories/kubernetes/rbac/index.js';
import { fixCRDSchemaForK8s133 } from '../../utils/crd-schema-fix.js';
import { kubernetesComposition } from '../index.js';
import { type TypeKroRuntimeConfig, TypeKroRuntimeSpec, TypeKroRuntimeStatus } from './types.js';

/**
 * Bootstrap TypeKro runtime with essential components
 *
 * Deploys Flux CD controllers and Kro using HelmRelease.
 * This replaces kubectl commands in bootstrap scripts with TypeKro-native deployments.
 *
 * @param config - Configuration for the runtime bootstrap
 *
 * @example
 * Basic usage:
 * ```typescript
 * const bootstrap = typeKroRuntimeBootstrap({
 *   namespace: 'flux-system',
 *   fluxVersion: 'v2.4.0',
 *   kroVersion: '0.3.0'
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
  const kroVersion = config.kroVersion || '0.3.0';
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

      // Kro system namespace
      const _kroNamespace = namespace({
        metadata: {
          name: 'kro',
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
      yamlFile({
        name: 'flux-system-install',
        path:
          fluxVersion === 'latest'
            ? 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml'
            : `https://github.com/fluxcd/flux2/releases/download/${fluxVersion}/install.yaml`,
        deploymentStrategy: 'serverSideApply',
        fieldManager: 'typekro-bootstrap',
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
        url: 'oci://ghcr.io/kro-run/kro',
        interval: '5m',
        type: 'oci',
        id: 'kroHelmRepo',
      });

      // Kro using HelmRelease with OCI chart - Flux will manage the lifecycle
      const kroHelmRelease = helmRelease({
        name: 'kro',
        namespace: 'kro',
        chart: {
          name: 'kro',
          repository: `oci://ghcr.io/kro-run/kro`,
          version: kroVersion,
        },
        interval: '5m',
        id: 'kroHelmRelease',
      });

      // ✨ JavaScript expressions - automatically converted to CEL
      return {
        phase: (kroHelmRelease.status.phase === 'Ready' ? 'Ready' : 'Installing') as
          | 'Pending'
          | 'Installing'
          | 'Ready'
          | 'Failed'
          | 'Upgrading',
        components: {
          fluxSystem: true,
          // Kro system readiness based on HelmRelease status
          kroSystem: kroHelmRelease.status.phase === 'Ready',
        },
      };
    }
  );
}
