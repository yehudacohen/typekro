import { append, aspect, mergeByName, override, patchEach, replace, workloads } from './primitives.js';

import type {
  AspectDefinition,
  AspectOverridePatch,
  EnvVarMap,
  ImagePullPolicy,
  OverrideAspectSurface,
  WorkloadPodTemplateAspectSchema,
} from './types.js';
import type { V1EnvFromSource, V1EnvVar, V1ResourceRequirements } from '@kubernetes/client-node';

export function workloadOverride(
  patch: AspectOverridePatch<WorkloadPodTemplateAspectSchema>
): AspectDefinition<typeof workloads, OverrideAspectSurface<WorkloadPodTemplateAspectSchema>> {
  return aspect.on(workloads, override<WorkloadPodTemplateAspectSchema>(patch)) as unknown as AspectDefinition<
    typeof workloads,
    OverrideAspectSurface<WorkloadPodTemplateAspectSchema>
  >;
}

/** Creates a workload aspect that sets replica count. */
export function withReplicas(
  count: number
): AspectDefinition<typeof workloads, OverrideAspectSurface<WorkloadPodTemplateAspectSchema>> {
  return workloadOverride({ spec: { replicas: replace(count) } });
}

/** Creates a workload aspect that adds or updates env vars on every container. */
export function withEnvVars(
  vars: EnvVarMap
): AspectDefinition<typeof workloads, OverrideAspectSurface<WorkloadPodTemplateAspectSchema>> {
  const env: V1EnvVar[] = Object.entries(vars).map(([name, value]) => ({ name, value }));
  return workloadOverride({
    spec: { template: { spec: { containers: patchEach({ env: mergeByName(env) }) } } },
  });
}

/** Creates a workload aspect that appends envFrom sources to every container. */
export function withEnvFrom(
  envFrom: readonly V1EnvFromSource[]
): AspectDefinition<typeof workloads, OverrideAspectSurface<WorkloadPodTemplateAspectSchema>> {
  return workloadOverride({
    spec: { template: { spec: { containers: patchEach({ envFrom: append(envFrom) }) } } },
  });
}

/** Creates a workload aspect that sets resource requirements on every container. */
export function withResourceDefaults(
  resources: V1ResourceRequirements
): AspectDefinition<typeof workloads, OverrideAspectSurface<WorkloadPodTemplateAspectSchema>> {
  return workloadOverride({
    spec: { template: { spec: { containers: patchEach({ resources: replace(resources) }) } } },
  });
}

/** Creates a workload aspect that sets imagePullPolicy on every container. */
export function withImagePullPolicy(
  policy: ImagePullPolicy
): AspectDefinition<typeof workloads, OverrideAspectSurface<WorkloadPodTemplateAspectSchema>> {
  return workloadOverride({
    spec: { template: { spec: { containers: patchEach({ imagePullPolicy: replace(policy) }) } } },
  });
}

/** Creates a workload aspect that sets serviceAccountName on pod templates. */
export function withServiceAccount(
  serviceAccountName: string
): AspectDefinition<typeof workloads, OverrideAspectSurface<WorkloadPodTemplateAspectSchema>> {
  return workloadOverride({
    spec: { template: { spec: { serviceAccountName: replace(serviceAccountName) } } },
  });
}
