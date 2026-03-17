import { kubernetesComposition } from '../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../core/config/defaults.js';
import { Cel } from '../../core/references/cel.js';
import { fixCRDSchemaForK8s133 } from '../../core/runtime-patches/crd-schema-fix.js';
import { helmRelease } from '../../factories/helm/helm-release.js';
import { helmRepository } from '../../factories/helm/helm-repository.js';
import { namespace } from '../../factories/kubernetes/core/namespace.js';
import { clusterRole, clusterRoleBinding } from '../../factories/kubernetes/rbac/index.js';
import { yamlFile } from '../../factories/kubernetes/yaml/yaml-file.js';
import {
  type RbacMode,
  type TypeKroRuntimeConfig,
  TypeKroRuntimeSpec,
  TypeKroRuntimeStatus,
} from './types.js';

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
  const targetNamespace = config.namespace || DEFAULT_FLUX_NAMESPACE;
  const rbacMode: RbacMode = config.rbac || 'cluster-admin';

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
        // Idempotent bootstrap: if the Flux install YAML can't be downloaded (e.g., DNS
        // failure, air-gapped environment) but Flux is already running on the cluster,
        // skip the download and proceed. This prevents bootstrap from failing when
        // re-running against a cluster that already has Flux installed.
        skipIfFetchFails: async (k8sApi) => {
          try {
            await k8sApi.read({
              apiVersion: 'apiextensions.k8s.io/v1',
              kind: 'CustomResourceDefinition',
              metadata: { name: 'helmreleases.helm.toolkit.fluxcd.io' },
            });
            return true; // Flux CRDs exist — already installed
          } catch {
            return false; // CRDs not found — need the download
          }
        },
      });

      // RBAC for Flux controllers.
      // Configurable via config.rbac: 'cluster-admin' (default), 'scoped', or { clusterRoleRef }.
      createFluxRbac(rbacMode, targetNamespace);

      // Helm Repository for Kro OCI charts
      helmRepository({
        name: 'kro-helm-repo',
        namespace: DEFAULT_FLUX_NAMESPACE,
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

// ---------------------------------------------------------------------------
// RBAC helpers
// ---------------------------------------------------------------------------

/** The six Flux CD controller service accounts that need cluster-level permissions. */
const FLUX_SERVICE_ACCOUNTS = [
  'kustomize-controller',
  'helm-controller',
  'source-controller',
  'notification-controller',
  'image-reflector-controller',
  'image-automation-controller',
] as const;

/**
 * Create RBAC resources for Flux controllers based on the chosen mode.
 *
 * - `cluster-admin`: Single ClusterRoleBinding → built-in `cluster-admin`.
 * - `scoped`: Creates a dedicated ClusterRole with Flux-minimum permissions,
 *   then binds all controllers to it.
 * - `{ clusterRoleRef }`: Single ClusterRoleBinding → user-provided ClusterRole.
 */
function createFluxRbac(mode: RbacMode, targetNamespace: string): void {
  const roleName = resolveClusterRoleName(mode);

  if (mode === 'scoped') {
    createScopedFluxClusterRole();
  }

  clusterRoleBinding({
    metadata: {
      name: 'cluster-reconciler',
      labels: {
        // Flux's own label value — not the namespace; do not replace with DEFAULT_FLUX_NAMESPACE
        'app.kubernetes.io/instance': 'flux-system',
        'app.kubernetes.io/part-of': 'flux',
      },
    },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: roleName,
    },
    subjects: FLUX_SERVICE_ACCOUNTS.map((sa) => ({
      kind: 'ServiceAccount' as const,
      name: sa,
      namespace: targetNamespace,
    })),
  });
}

/** Determine which ClusterRole to bind to based on the RBAC mode. */
function resolveClusterRoleName(mode: RbacMode): string {
  if (mode === 'cluster-admin') return 'cluster-admin';
  if (mode === 'scoped') return 'typekro-flux-controllers';
  return mode.clusterRoleRef;
}

/**
 * Create a scoped ClusterRole with the minimum permissions required for Flux
 * controllers to manage HelmReleases, Kustomizations, GitRepositories,
 * HelmRepositories, and their target resources.
 *
 * This covers the core Flux reconciliation loop but may NOT cover every
 * possible resource type that a Helm chart could create. Users deploying
 * charts that create CRDs or other cluster-scoped resources may need to
 * use `cluster-admin` or a custom ClusterRole with additional permissions.
 */
function createScopedFluxClusterRole(): void {
  clusterRole({
    metadata: {
      name: 'typekro-flux-controllers',
      labels: {
        // Flux's own label value — not the namespace; do not replace with DEFAULT_FLUX_NAMESPACE
        'app.kubernetes.io/instance': 'flux-system',
        'app.kubernetes.io/part-of': 'flux',
        'app.kubernetes.io/managed-by': 'typekro',
      },
    },
    rules: [
      // Core Kubernetes resources that Helm charts commonly create
      {
        apiGroups: [''],
        resources: [
          'namespaces',
          'pods',
          'services',
          'configmaps',
          'secrets',
          'serviceaccounts',
          'persistentvolumeclaims',
          'events',
        ],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Apps API (Deployments, StatefulSets, DaemonSets, ReplicaSets)
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'statefulsets', 'daemonsets', 'replicasets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Batch API (Jobs, CronJobs)
      {
        apiGroups: ['batch'],
        resources: ['jobs', 'cronjobs'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // RBAC resources
      {
        apiGroups: ['rbac.authorization.k8s.io'],
        resources: ['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Networking
      {
        apiGroups: ['networking.k8s.io'],
        resources: ['ingresses', 'networkpolicies'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Autoscaling
      {
        apiGroups: ['autoscaling'],
        resources: ['horizontalpodautoscalers'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Policy
      {
        apiGroups: ['policy'],
        resources: ['poddisruptionbudgets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Flux source-controller CRDs
      {
        apiGroups: ['source.toolkit.fluxcd.io'],
        resources: [
          'gitrepositories',
          'helmrepositories',
          'helmcharts',
          'ocirepositories',
          'buckets',
        ],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Flux source-controller status and finalizers
      {
        apiGroups: ['source.toolkit.fluxcd.io'],
        resources: [
          'gitrepositories/status',
          'helmrepositories/status',
          'helmcharts/status',
          'ocirepositories/status',
          'buckets/status',
          'gitrepositories/finalizers',
          'helmrepositories/finalizers',
          'helmcharts/finalizers',
          'ocirepositories/finalizers',
          'buckets/finalizers',
        ],
        verbs: ['get', 'update', 'patch'],
      },
      // Flux helm-controller CRDs
      {
        apiGroups: ['helm.toolkit.fluxcd.io'],
        resources: ['helmreleases'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Flux helm-controller status and finalizers
      {
        apiGroups: ['helm.toolkit.fluxcd.io'],
        resources: ['helmreleases/status', 'helmreleases/finalizers'],
        verbs: ['get', 'update', 'patch'],
      },
      // Flux kustomize-controller CRDs
      {
        apiGroups: ['kustomize.toolkit.fluxcd.io'],
        resources: ['kustomizations'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Flux kustomize-controller status and finalizers
      {
        apiGroups: ['kustomize.toolkit.fluxcd.io'],
        resources: ['kustomizations/status', 'kustomizations/finalizers'],
        verbs: ['get', 'update', 'patch'],
      },
      // Flux notification-controller CRDs
      {
        apiGroups: ['notification.toolkit.fluxcd.io'],
        resources: ['providers', 'alerts', 'receivers'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Flux notification-controller status and finalizers
      {
        apiGroups: ['notification.toolkit.fluxcd.io'],
        resources: [
          'providers/status',
          'alerts/status',
          'receivers/status',
          'providers/finalizers',
          'alerts/finalizers',
          'receivers/finalizers',
        ],
        verbs: ['get', 'update', 'patch'],
      },
      // Flux image-reflector-controller CRDs
      {
        apiGroups: ['image.toolkit.fluxcd.io'],
        resources: ['imagepolicies', 'imagerepositories'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Flux image-automation-controller CRDs
      {
        apiGroups: ['image.toolkit.fluxcd.io'],
        resources: ['imageupdateautomations'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Flux image CRDs status and finalizers
      {
        apiGroups: ['image.toolkit.fluxcd.io'],
        resources: [
          'imagepolicies/status',
          'imagerepositories/status',
          'imageupdateautomations/status',
          'imagepolicies/finalizers',
          'imagerepositories/finalizers',
          'imageupdateautomations/finalizers',
        ],
        verbs: ['get', 'update', 'patch'],
      },
      // Kro CRDs (needed for kro-system management)
      {
        apiGroups: ['kro.run'],
        resources: ['resourcegraphdefinitions', 'resourcegraphdefinitions/status'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // CRD management (needed for Helm charts that install CRDs)
      {
        apiGroups: ['apiextensions.k8s.io'],
        resources: ['customresourcedefinitions'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Events (for controllers to post events)
      {
        apiGroups: ['events.k8s.io'],
        resources: ['events'],
        verbs: ['create', 'patch'],
      },
      // Coordination (leader election)
      {
        apiGroups: ['coordination.k8s.io'],
        resources: ['leases'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
    ],
  });
}
