import type * as k8s from '@kubernetes/client-node';
import * as yaml from 'js-yaml';
import { ensureError } from '../../../core/errors.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import type { KubernetesRef } from '../../../core/types/common.js';
import type {
  AppliedResource,
  DeploymentClosure,
  DeploymentContext,
} from '../../../core/types/deployment.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';
import { PathResolver, type ResolvedContent } from '../../../core/yaml/path-resolver.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { registerDeploymentClosure } from '../../shared.js';
import {
  applyYamlArtifact,
  type YamlDeploymentStrategy,
  yamlAppliedResource,
} from './yaml-artifact-applier.js';

const logger = getComponentLogger('yaml-file');

function parseYamlManifests(yamlContent: string): KubernetesResource[] {
  const documents = yaml.loadAll(yamlContent, undefined, { schema: yaml.JSON_SCHEMA });
  const manifests: KubernetesResource[] = [];
  for (const document of documents) {
    if (
      document &&
      typeof document === 'object' &&
      'kind' in document &&
      'apiVersion' in document
    ) {
      manifests.push(document as KubernetesResource);
    }
  }
  return manifests;
}

export interface YamlFileConfig {
  name: string;
  /** Resource graph identifier. Required when `name` is dynamic. */
  id?: string;
  path: string;
  namespace?: string | KubernetesRef<string>;
  /** @default 'replace' */
  deploymentStrategy?: YamlDeploymentStrategy;
  /** Transform each parsed desired manifest before artifact application. */
  manifestTransform?: (manifest: KubernetesResource) => KubernetesResource;
  /** Field manager used by the `serverSideApply` compatibility option. @default 'typekro' */
  fieldManager?: string;
  /** Take ownership of conflicting fields during server-side apply. @default false */
  forceConflicts?: boolean;
  /**
   * @deprecated CRDs now use the canonical artifact SSA operation. Transform
   * the desired manifest with `manifestTransform` before applying it instead.
   */
  crdPatchTimeout?: number;
  /**
   * Called after content fetch failure. Returning true treats the closure as
   * already satisfied by resources observed on the cluster.
   */
  skipIfFetchFails?: (k8sApi: k8s.KubernetesObjectApi) => Promise<boolean>;
}

/**
 * Deploy one YAML document set as a compatibility closure.
 *
 * Fetching, transforms, and closure ordering remain closure responsibilities;
 * Kubernetes write semantics are delegated to the canonical artifact applier.
 */
export function yamlFile(config: YamlFileConfig): DeploymentClosure<AppliedResource[]> {
  return registerDeploymentClosure(() => {
    const closure = async (deploymentContext: DeploymentContext): Promise<AppliedResource[]> => {
      const pathResolver = new PathResolver();
      const resolvedNamespace =
        config.namespace && isKubernetesRef(config.namespace)
          ? await deploymentContext.resolveReference(config.namespace)
          : config.namespace;

      let resolvedContent: ResolvedContent;
      try {
        resolvedContent = await pathResolver.resolveContent(config.path, config.name);
      } catch (fetchError: unknown) {
        if (config.skipIfFetchFails && deploymentContext.kubernetesApi) {
          const alreadyInstalled = await config.skipIfFetchFails(deploymentContext.kubernetesApi);
          if (alreadyInstalled) {
            logger.warn(
              `YAML fetch failed for '${config.name}' but resources are already installed on cluster - skipping`,
              { path: config.path, error: ensureError(fetchError).message }
            );
            return [];
          }
        }
        throw fetchError;
      }

      const rawManifests = parseYamlManifests(resolvedContent.content);
      const manifests = config.manifestTransform
        ? rawManifests.map(config.manifestTransform)
        : rawManifests;
      const results: AppliedResource[] = [];
      const strategy = config.deploymentStrategy ?? 'replace';

      for (const manifest of manifests) {
        if (resolvedNamespace && !manifest.metadata?.namespace) {
          manifest.metadata = { ...manifest.metadata, namespace: resolvedNamespace as string };
        }

        if (deploymentContext.validationOnly) {
          results.push(yamlAppliedResource(manifest));
          continue;
        }

        results.push(
          await applyYamlArtifact(manifest, strategy, deploymentContext, config.name, {
            ...(config.fieldManager ? { fieldManager: config.fieldManager } : {}),
            ...(config.forceConflicts !== undefined
              ? { forceConflicts: config.forceConflicts }
              : {}),
          })
        );
      }

      return results;
    };

    return closure;
  }, config.name);
}
