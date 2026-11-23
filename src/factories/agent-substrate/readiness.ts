import { registerPortableReadinessEvaluator } from '../../core/readiness/index.js';
import type { KubernetesResource, ResourceStatus } from '../../core/types/index.js';

interface Condition {
  readonly type: string;
  readonly status: string;
  readonly observedGeneration?: number;
}

interface RolloutStatus {
  readonly observedGeneration?: number;
  readonly readyReplicas?: number;
  readonly availableReplicas?: number;
  readonly updatedReplicas?: number;
  readonly desiredNumberScheduled?: number;
  readonly updatedNumberScheduled?: number;
  readonly numberReady?: number;
  readonly numberAvailable?: number;
}

interface PoolClass {
  readonly name: string;
  readonly configRef?: { readonly name: string };
  readonly pendingConfigRef?: { readonly name: string };
  readonly conditions?: readonly Condition[];
}

interface PoolSpec {
  readonly replicas?: number;
  readonly podTemplate?: { readonly spec?: { readonly nodeSelector?: Readonly<Record<string, string>> } };
  readonly sandboxClasses?: readonly PoolClass[];
}

interface PoolStatus {
  readonly replicas?: number;
  readonly readyReplicas?: number;
  readonly selector?: string;
  readonly sandboxClasses?: readonly PoolClass[];
}

interface SandboxConfigSpec {
  readonly sandboxClass?: string;
  readonly defaultVersion?: string;
  readonly versions?: readonly {
    readonly name: string;
    readonly state: string;
    readonly assets?: Readonly<Record<string, Readonly<Record<string, { readonly url: string; readonly sha256: string }>>>>;
  }[];
}

function status(ready: boolean, reason: string): ResourceStatus {
  return ready ? { ready } : { ready, reason };
}

export const substrateDeploymentReadiness = registerPortableReadinessEvaluator(
  'typekro.readiness.agent-substrate.deployment', '1',
  (resource: KubernetesResource<{ replicas?: number }, RolloutStatus>): ResourceStatus => {
    const replicas = resource.spec?.replicas ?? 1;
    const generation = resource.metadata.generation;
    const live = resource.status;
    return status(!resource.metadata.deletionTimestamp && generation !== undefined
      && live?.observedGeneration === generation && replicas > 0 && live.readyReplicas === replicas
      && live.availableReplicas === replicas && live.updatedReplicas === replicas, 'RolloutPending');
  }
);

export const substrateDaemonSetReadiness = registerPortableReadinessEvaluator(
  'typekro.readiness.agent-substrate.daemon-set', '1',
  (resource: KubernetesResource<unknown, RolloutStatus>): ResourceStatus => {
    const generation = resource.metadata.generation;
    const live = resource.status;
    const desired = live?.desiredNumberScheduled ?? 0;
    return status(!resource.metadata.deletionTimestamp && generation !== undefined
      && live?.observedGeneration === generation && desired > 0 && live.numberReady === desired
      && live.updatedNumberScheduled === desired && live.numberAvailable === desired, 'NodeRolloutPending');
  }
);

/** Kubernetes v1.0.0 reports resolution per class and readiness as pod counts. */
export const substrateWorkerPoolReadiness = registerPortableReadinessEvaluator(
  'typekro.readiness.agent-substrate.worker-pool', '1',
  (resource: KubernetesResource<PoolSpec, PoolStatus>): ResourceStatus => {
    const wanted = resource.spec?.sandboxClasses?.[0];
    const actual = resource.status?.sandboxClasses?.find(item => item.name === wanted?.name);
    const replicas = resource.spec?.replicas ?? 0;
    return status(!resource.metadata.deletionTimestamp && replicas > 0 && !!wanted?.configRef
      && !!resource.status?.selector && resource.status.replicas === replicas
      && resource.status.readyReplicas === replicas && actual?.configRef?.name === wanted.configRef.name
      && !actual?.pendingConfigRef && actual?.conditions?.some(condition => condition.type === 'Resolved'
        && condition.status === 'True' && condition.observedGeneration === resource.metadata.generation) === true,
    'WorkerPoolNotReady');
  }
);

/** Checks the live immutable asset pins. The worker runtime verifies the downloaded bytes. */
export const substrateSandboxConfigReadiness = registerPortableReadinessEvaluator(
  'typekro.readiness.agent-substrate.sandbox-config', '1',
  (resource: KubernetesResource<SandboxConfigSpec>): ResourceStatus => {
    const version = resource.spec?.versions?.find(item => item.name === resource.spec?.defaultVersion);
    const perArchitecture = Object.values(version?.assets ?? {});
    return status(!resource.metadata.deletionTimestamp && !!resource.spec?.sandboxClass
      && version?.state === 'Enabled' && perArchitecture.length > 0 && perArchitecture.every(assets => {
        const files = Object.values(assets);
        return files.length > 0 && files.every(asset => /^(gs|s3|https):\/\//u.test(asset.url) && /^[0-9a-f]{64}$/u.test(asset.sha256));
      }), 'SandboxAssetsNotPinned');
  }
);
