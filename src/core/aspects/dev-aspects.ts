import { aspect, isPlainObject, mergeByName, override, patchEach, replace, workloads } from './primitives.js';
import { workloadOverride } from './workload-aspects.js';

import type {
  AspectDefinition,
  AspectDefinitionFunctionName,
  HotReloadAspectOptions,
  HotReloadAspectSchema,
  LocalWorkspaceAspectOptions,
  OverrideAspectSurface,
  ReplaceOperation,
  WorkloadPodTemplateAspectSchema,
} from './types.js';
import { AspectDefinitionError } from './types.js';
import type { V1Volume, V1VolumeMount } from '@kubernetes/client-node';

function createDefinitionError(
  functionName: AspectDefinitionFunctionName,
  reason: string
): AspectDefinitionError {
  return new AspectDefinitionError(functionName, reason);
}

/** Creates a workload aspect that mounts a local host workspace into every container. */
export function withLocalWorkspace(
  options: LocalWorkspaceAspectOptions
): AspectDefinition<typeof workloads, OverrideAspectSurface<WorkloadPodTemplateAspectSchema>> {
  if (!isPlainObject(options)) {
    throw createDefinitionError('override', 'withLocalWorkspace(...) options must be an object');
  }
  const volumeName = options.volumeName ?? 'workspace';
  const mountPath = options.mountPath ?? '/workspace';
  const volumeMount: V1VolumeMount & { name: string } = { name: volumeName, mountPath };
  const volume: V1Volume & { name: string } = {
    name: volumeName,
    hostPath: { path: options.workspacePath, type: options.hostPathType ?? 'Directory' },
  };

  return workloadOverride({
    spec: {
      template: {
        spec: {
          containers: patchEach({ volumeMounts: mergeByName([volumeMount]) }),
          volumes: mergeByName([volume]),
        },
      },
    },
  });
}

/**
 * Creates a dev-mode hot reload override surface for workload pod templates.
 *
 * The helper intentionally returns only the override surface. Callers still pick
 * the target and selector with `aspect.on(...)`, keeping dev behavior explicit.
 */
export function hotReload(options: HotReloadAspectOptions): OverrideAspectSurface<HotReloadAspectSchema> {
  if (!isPlainObject(options)) {
    throw createDefinitionError('hotReload', 'hotReload(...) options must be an object');
  }
  if (!Array.isArray(options.containers) || options.containers.length === 0) {
    throw createDefinitionError('hotReload', 'hotReload(...) containers must be a non-empty array');
  }
  if (options.volumes !== undefined && !Array.isArray(options.volumes)) {
    throw createDefinitionError('hotReload', 'hotReload(...) volumes must be an array');
  }
  if (options.labels !== undefined && !isPlainObject(options.labels)) {
    throw createDefinitionError('hotReload', 'hotReload(...) labels must be an object');
  }

  const labelPatch: Record<string, ReplaceOperation<string>> = {};
  for (const [key, value] of Object.entries(options.labels ?? {})) {
    labelPatch[key] = replace(value);
  }

  return override<HotReloadAspectSchema>({
    spec: {
      ...(options.replicas !== undefined && { replicas: replace(options.replicas) }),
      template: {
        ...(options.labels !== undefined && { metadata: { labels: labelPatch } }),
        spec: {
          containers: replace(options.containers),
          ...(options.volumes !== undefined && { volumes: replace(options.volumes) }),
        },
      },
    },
  });
}

/** Creates a workload-targeted dev-mode hot reload aspect. */
export function withHotReload(
  options: HotReloadAspectOptions
): AspectDefinition<typeof workloads, OverrideAspectSurface<HotReloadAspectSchema>> {
  return aspect.on(workloads, hotReload(options)) as unknown as AspectDefinition<
    typeof workloads,
    OverrideAspectSurface<HotReloadAspectSchema>
  >;
}
