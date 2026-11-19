// The Flux install composition: a pinned release's manifests as ordinary TypeKro
// declarations, which direct, KRO and Alchemy mode can all apply. It replaces the
// deploy-time `yamlFile` closure, which `toAlchemyResources` cannot lower.
//
// Resources are applied in phases, each waiting for the one before: the namespace
// (through TypeKro's implicit namespace dependency), then the CRDs (with the Kubernetes 1.33 schema fix), then RBAC, services, quotas
// and network policies, then the controller Deployments. Placement inputs replace
// every controller's tolerations and node selector.

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { TypeKroError } from '../../../core/errors.js';
import { Cel } from '../../../core/references/cel.js';
import { fixCRDSchemaForK8s133 } from '../../../core/runtime-patches/crd-schema-fix.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { customResourceDefinition } from '../../kubernetes/extensions/custom-resource-definition.js';
import { networkPolicy } from '../../kubernetes/networking/network-policy.js';
import { service } from '../../kubernetes/networking/service.js';
import { resourceQuota } from '../../kubernetes/policy/resource-quota.js';
import { clusterRole } from '../../kubernetes/rbac/cluster-role.js';
import { clusterRoleBinding } from '../../kubernetes/rbac/cluster-role-binding.js';
import { role } from '../../kubernetes/rbac/role.js';
import { roleBinding } from '../../kubernetes/rbac/role-binding.js';
import { serviceAccount } from '../../kubernetes/rbac/service-account.js';
import { deployment } from '../../kubernetes/workloads/deployment.js';
import { loadFluxRelease } from './releases/index.js';
import {
  type FluxInstallBuildOptions,
  type FluxInstallConfig,
  type FluxInstallStatus,
  fluxInstallConfigSchemaFor,
  FluxInstallStatusSchema,
  type FluxManifestObject,
  type FluxRelease,
  type FluxToleration,
} from './types.js';
import { assertPinnedFluxVersion, fluxVersionConstraint } from './version.js';

interface Applied {
  dependsOn(other: unknown): unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: each factory takes its own upstream object type.
type KindFactory = (resource: any) => Applied;

/** The TypeKro factory for every kind Flux's install manifests contain. */
export const FLUX_INSTALL_KIND_FACTORIES: Readonly<Record<string, KindFactory>> = {
  Namespace: namespace,
  CustomResourceDefinition: customResourceDefinition,
  ServiceAccount: serviceAccount,
  ClusterRole: clusterRole,
  ClusterRoleBinding: clusterRoleBinding,
  Role: role,
  RoleBinding: roleBinding,
  ResourceQuota: resourceQuota,
  NetworkPolicy: networkPolicy,
  Service: service,
  Deployment: deployment,
};

/** Apply order; each phase waits for the phase before it. */
export const FLUX_INSTALL_PHASES: readonly (readonly string[])[] = [
  ['Namespace'],
  ['CustomResourceDefinition'],
  [
    'ServiceAccount',
    'ClusterRole',
    'ClusterRoleBinding',
    'Role',
    'RoleBinding',
    'ResourceQuota',
    'NetworkPolicy',
    'Service',
  ],
  ['Deployment'],
];

/** A resource id from a kind and name: `deploymentHelmController`, `customResourceDefinitionHelmreleases...`. */
export function fluxResourceId(kind: string, name: string): string {
  return `${kind}-${name}`
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part, index) =>
      index === 0
        ? `${part[0]?.toLowerCase() ?? ''}${part.slice(1)}`
        : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`
    )
    .join('');
}

/**
 * Checks a release before it is rendered: a pinned version, a factory for every kind, one
 * namespace, and unique ids. Throws on the first problem.
 */
export function validateFluxRelease(release: FluxRelease): void {
  assertPinnedFluxVersion(release.version);
  const namespaces = new Set<string>();
  const ids = new Set<string>();
  for (const document of release.documents) {
    const where = `Flux ${release.version} manifest ${document.kind}/${document.metadata.name}`;
    if (!FLUX_INSTALL_KIND_FACTORIES[document.kind]) {
      throw new TypeKroError(
        `${where} has a kind with no factory.`,
        'FLUX_INSTALL_UNSUPPORTED_KIND',
        {
          kind: document.kind,
        }
      );
    }
    if (document.metadata.namespace !== undefined) namespaces.add(document.metadata.namespace);
    const id = fluxResourceId(document.kind, document.metadata.name);
    if (ids.has(id)) {
      throw new TypeKroError(`${where} repeats resource id ${id}.`, 'FLUX_INSTALL_DUPLICATE_ID', {
        id,
      });
    }
    ids.add(id);
  }
  if (namespaces.size > 1) {
    throw new TypeKroError(
      `Flux ${release.version} manifests span namespaces ${[...namespaces].join(', ')}; expected one.`,
      'FLUX_INSTALL_MULTIPLE_NAMESPACES'
    );
  }
  if (!release.documents.some((document) => document.kind === 'Deployment')) {
    throw new TypeKroError(
      `Flux ${release.version} manifests have no controller Deployment.`,
      'FLUX_INSTALL_NO_CONTROLLERS'
    );
  }
}

interface PodSpec {
  tolerations?: FluxToleration[];
  nodeSelector?: Record<string, string>;
  [field: string]: unknown;
}

/** The Deployment with the caller's placement in place of the manifest's own. */
function withPlacement(document: FluxManifestObject, spec: FluxInstallConfig): FluxManifestObject {
  const deploymentSpec = document.spec as { template?: { spec?: PodSpec } } & Record<
    string,
    unknown
  >;
  const pod: PodSpec = deploymentSpec.template?.spec ?? {};
  return {
    ...document,
    spec: {
      ...deploymentSpec,
      template: {
        ...deploymentSpec.template,
        spec: {
          ...pod,
          tolerations: Cel.default(spec.tolerations, pod.tolerations ?? []),
          nodeSelector: Cel.default(spec.nodeSelector, pod.nodeSelector ?? {}),
        },
      },
    },
  };
}

/**
 * Build the install composition for one pinned release.
 *
 * The spec's `version` must equal the release's version. The instance schema carries it as an
 * enum and `required=true`, so the API server refuses a KRO instance that asks for another
 * version or none, and the composition refuses one in direct mode. Composed inside another
 * composition, it takes the version itself or a reference to a required spec field declared
 * with `fluxVersionConstraint(release.version).type`, and refuses anything else at build time.
 *
 * @example
 * ```typescript
 * import { fluxV2_10_0 } from 'typekro/flux/releases/v2.10.0';
 *
 * const fluxInstall = makeFluxInstall({ release: fluxV2_10_0 });
 * const factory = fluxInstall.factory('direct', { namespace: 'flux-system' });
 * await factory.deploy({
 *   version: 'v2.10.0',
 *   tolerations: [{ key: 'example.com/capacity-class', operator: 'Exists', effect: 'NoSchedule' }],
 *   nodeSelector: { 'kubernetes.io/os': 'linux', 'example.com/capacity-class': 'stable' },
 * });
 * ```
 */
export function makeFluxInstall(
  options: FluxInstallBuildOptions
): CallableComposition<FluxInstallConfig, FluxInstallStatus> {
  const { release } = options;
  validateFluxRelease(release);
  const version = fluxVersionConstraint(release.version);

  return kubernetesComposition(
    {
      name: options.name ?? 'flux-install',
      kind: options.kind ?? 'FluxInstall',
      spec: fluxInstallConfigSchemaFor(version),
      status: FluxInstallStatusSchema,
    },
    (spec) => {
      version.enforce(spec.version);

      const controllers: Array<{
        status: { readyReplicas?: number };
        spec: { replicas?: number };
      }> = [];
      let previous: Applied[] = [];
      for (const kinds of FLUX_INSTALL_PHASES) {
        const current = release.documents
          .filter((document) => kinds.includes(document.kind))
          .map((document) => {
            const id = fluxResourceId(document.kind, document.metadata.name);
            const object =
              document.kind === 'CustomResourceDefinition'
                ? (fixCRDSchemaForK8s133(
                    document as unknown as KubernetesResource
                  ) as unknown as FluxManifestObject)
                : document.kind === 'Deployment'
                  ? withPlacement(document, spec)
                  : document;
            const factory = FLUX_INSTALL_KIND_FACTORIES[document.kind] as KindFactory;
            let resource = factory({ ...object, id });
            if (document.kind === 'Deployment') {
              resource = (
                resource as Applied & { withReadyWhen(condition: unknown): Applied }
              ).withReadyWhen(
                (self: { status: { readyReplicas: number }; spec: { replicas: number } }) =>
                  self.status.readyReplicas === self.spec.replicas
              );
              controllers.push(resource as unknown as (typeof controllers)[number]);
            }
            for (const upstream of previous) resource.dependsOn(upstream);
            return resource;
          });
        // Namespaced resources already wait for their Namespace (TypeKro's implicit namespace
        // dependency, and KRO creates a hoisted Namespace first), so the Namespace is never an
        // explicit dependsOn target: KRO hoists it out of the graph.
        if (current.length > 0 && !kinds.includes('Namespace')) previous = current;
      }

      const parts: unknown[] = [];
      controllers.forEach((controller, index) => {
        if (index > 0) parts.push(' && ');
        parts.push(controller.status.readyReplicas, ' == ', controller.spec.replicas);
      });
      return { ready: Cel.expr<boolean>(...(parts as Parameters<typeof Cel.expr>)) };
    }
  );
}

/**
 * The install composition for a pinned release in {@link FLUX_RELEASE_VERSIONS}, loading its
 * manifests on demand.
 */
export async function fluxInstallForVersion(
  version: string
): Promise<CallableComposition<FluxInstallConfig, FluxInstallStatus>> {
  return makeFluxInstall({ release: await loadFluxRelease(version) });
}
