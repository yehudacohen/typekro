import type * as k8s from '@kubernetes/client-node';
import { ResourceApplier } from '../../../core/deployment/resource-applier.js';
import { ResourceGraphFactoryError } from '../../../core/errors.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import type { ArtifactApplyPolicy } from '../../../core/planning/artifacts.js';
import type { AppliedResource, DeploymentContext } from '../../../core/types/deployment.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';

export type YamlDeploymentStrategy = 'replace' | 'skipIfExists' | 'fail' | 'serverSideApply';

interface YamlApplyOptions {
  readonly fieldManager?: string;
  readonly forceConflicts?: boolean;
}

const logger = getComponentLogger('yaml-artifact-applier');

/** Translate compatibility YAML options into the canonical artifact policy vocabulary. */
export function yamlDeploymentApplyPolicy(
  strategy: YamlDeploymentStrategy,
  options: YamlApplyOptions = {}
): ArtifactApplyPolicy {
  switch (strategy) {
    case 'serverSideApply':
      return {
        strategy: 'server-side-apply',
        fieldManager: options.fieldManager ?? 'typekro',
        fieldConflictPolicy: options.forceConflicts ? 'force-owned-fields' : 'fail',
        immutableFieldPolicy: 'fail',
      };
    case 'fail':
      return { strategy: 'create-only' };
    case 'skipIfExists':
      return {
        strategy: 'create-or-patch',
        existingResource: 'warn',
        immutableFieldPolicy: 'fail',
      };
    case 'replace':
      // Historical YAML "replace" behavior patched an existing object in place.
      return {
        strategy: 'create-or-patch',
        existingResource: 'patch',
        immutableFieldPolicy: 'fail',
      };
  }
}

export function yamlAppliedResource(manifest: KubernetesResource): AppliedResource {
  return {
    kind: manifest.kind || 'Unknown',
    name: manifest.metadata?.name || 'unknown',
    namespace: manifest.metadata?.namespace || undefined,
    apiVersion: manifest.apiVersion || 'v1',
  };
}

/** Apply one YAML-sourced manifest through the same artifact applier as direct resources. */
export async function applyYamlArtifact(
  manifest: KubernetesResource,
  strategy: YamlDeploymentStrategy,
  deploymentContext: DeploymentContext,
  factoryName: string,
  options: YamlApplyOptions = {}
): Promise<AppliedResource> {
  const kubernetesApi = deploymentContext.kubernetesApi;
  if (!kubernetesApi) {
    throw new ResourceGraphFactoryError(
      'No Kubernetes API available for YAML deployment',
      factoryName,
      'deployment'
    );
  }

  const resourceLogger = logger.child({
    yamlResource: factoryName,
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    name: manifest.metadata?.name,
    namespace: manifest.metadata?.namespace,
  });
  const applier = new ResourceApplier(
    kubernetesApi as k8s.KubernetesObjectApi,
    undefined,
    resourceLogger
  );
  await applier.applyArtifactResource(
    manifest,
    yamlDeploymentApplyPolicy(strategy, options),
    {
      mode: 'direct',
      waitForReady: false,
      // A closure is already one parent-engine operation. Keep retries owned by
      // that operation instead of adding a second nested retry schedule.
      retryPolicy: {
        maxRetries: 0,
        backoffMultiplier: 1,
        initialDelay: 0,
        maxDelay: 0,
      },
      ...(deploymentContext.abortSignal ? { abortSignal: deploymentContext.abortSignal } : {}),
    },
    resourceLogger
  );
  return yamlAppliedResource(manifest);
}
