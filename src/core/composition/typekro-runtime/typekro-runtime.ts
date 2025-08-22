import { helmRelease } from '../../../factories/helm/helm-release.js';
import { helmRepository } from '../../../factories/helm/helm-repository.js';
import { namespace } from '../../../factories/kubernetes/core/namespace.js';
import { yamlFile } from '../../../factories/kubernetes/yaml/yaml-file.js';
import { Cel } from '../../references/index.js';
import { toResourceGraph } from '../../serialization/index.js';
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
  const fluxVersion = config.fluxVersion || 'latest';
  const kroVersion = config.kroVersion || '0.3.0';

  return toResourceGraph(
    {
      name: 'typekro-runtime-bootstrap',
      apiVersion: 'typekro.dev/v1alpha1',
      kind: 'TypeKroRuntime',
      spec: TypeKroRuntimeSpec,
      status: TypeKroRuntimeStatus,
    },
    (schema) => ({
      // System namespace for Flux
      systemNamespace: namespace({
        metadata: {
          name: schema.spec.namespace,
        },
        id: 'systemNamespace',
      }),

      // Kro system namespace
      kroNamespace: namespace({
        metadata: {
          name: 'kro',
        },
        id: 'kroNamespace',
      }),

      // Flux CD system using yamlFile (matches integration test pattern)
      fluxSystem: yamlFile({
        name: 'flux-system-install',
        path:
          fluxVersion === 'latest'
            ? 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml'
            : `https://github.com/fluxcd/flux2/releases/download/${fluxVersion}/install.yaml`,
        deploymentStrategy: 'skipIfExists',
      }),

      // Helm Repository for Kro OCI charts
      kroHelmRepo: helmRepository({
        name: 'kro-helm-repo',
        namespace: 'flux-system',
        url: 'oci://ghcr.io/kro-run/kro',
        interval: '5m',
        type: 'oci',
        id: 'kroHelmRepo',
      }),
      // Kro using HelmRelease with OCI chart - Flux will manage the lifecycle
      kroHelmRelease: helmRelease({
        name: 'kro',
        namespace: 'kro',
        chart: {
          name: 'kro',
          repository: `oci://ghcr.io/kro-run/kro`,
          version: kroVersion,
        },
        interval: '5m',
        id: 'kroHelmRelease',
      }),
    }),
    (_schema, resources) => ({
      // Phase based on HelmRelease status
      phase: Cel.expr<'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading'>(
        resources.kroHelmRelease.status.phase,
        ' == "Ready" ? "Ready" : "Installing"'
      ),
      components: {
        // Flux system is deployed via yamlFile - assume ready for now
        fluxSystem: true,
        // Kro system readiness based on HelmRelease status
        kroSystem: Cel.expr<boolean>(resources.kroHelmRelease.status.phase, ' == "Ready"'),
      },
    })
  );
}
