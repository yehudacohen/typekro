import type * as k8s from '@kubernetes/client-node';

import type {
  DeletionBlocker,
  DeletionResourceIdentity,
  DeletionRetention,
  ResourceDeletionResult,
} from '../types/deployment.js';
import { isNotFoundError } from './k8s-helpers.js';

export interface DeletionResultState {
  readonly mode: 'direct' | 'kro';
  readonly factoryName: string;
  readonly instanceName: string;
  readonly startedAt: Date;
  readonly deleted: DeletionResourceIdentity[];
  readonly retained: DeletionRetention[];
  readonly remaining: DeletionResourceIdentity[];
  readonly blockers: DeletionBlocker[];
}

export interface DeletionReadApi {
  read(resource: k8s.KubernetesObject): Promise<unknown>;
}

export function createDeletionResultState(
  mode: 'direct' | 'kro',
  factoryName: string,
  instanceName: string
): DeletionResultState {
  return {
    mode,
    factoryName,
    instanceName,
    startedAt: new Date(),
    deleted: [],
    retained: [],
    remaining: [],
    blockers: [],
  };
}

export function finishDeletionResult(
  state: DeletionResultState,
  status: ResourceDeletionResult['status'],
  retry: ResourceDeletionResult['retry']
): ResourceDeletionResult {
  const finishedAt = new Date();
  const resourceKey = (resource: DeletionResourceIdentity): string =>
    [resource.apiVersion, resource.kind, resource.namespace ?? '', resource.name].join('|');
  const deleted = [
    ...new Map(state.deleted.map((resource) => [resourceKey(resource), resource])).values(),
  ];
  const remaining = [
    ...new Map(state.remaining.map((resource) => [resourceKey(resource), resource])).values(),
  ];
  const retained = [
    ...new Map(
      state.retained.map((entry) => [
        `${resourceKey(entry.resource)}|${entry.policy}|${entry.reason}`,
        entry,
      ])
    ).values(),
  ];
  const blockers = [
    ...new Map(
      state.blockers.map((blocker) => [
        `${blocker.code}|${blocker.resource ? resourceKey(blocker.resource) : ''}|${blocker.message}`,
        blocker,
      ])
    ).values(),
  ];
  return {
    status,
    mode: state.mode,
    factoryName: state.factoryName,
    instanceName: state.instanceName,
    startedAt: state.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - state.startedAt.getTime()),
    deleted,
    retained,
    remaining,
    blockers,
    retry,
  };
}

export function deletionTarget(
  apiVersion: string,
  kind: string,
  name: string,
  namespace?: string
): DeletionResourceIdentity {
  return { apiVersion, kind, name, ...(namespace ? { namespace } : {}) };
}

/** Read the live blocker shape without weakening the original deletion error. */
export async function readDeletionResourceIdentity(
  api: DeletionReadApi,
  target: DeletionResourceIdentity
): Promise<DeletionResourceIdentity | undefined> {
  try {
    const live = (await api.read({
      apiVersion: target.apiVersion,
      kind: target.kind,
      metadata: {
        name: target.name,
        ...(target.namespace ? { namespace: target.namespace } : {}),
      },
    })) as k8s.KubernetesObject & {
      metadata?: k8s.V1ObjectMeta;
    };
    const metadata = live.metadata;
    return {
      ...target,
      ...(metadata?.uid ? { uid: metadata.uid } : {}),
      ...(metadata?.deletionTimestamp
        ? {
            deletionTimestamp: new Date(
              metadata.deletionTimestamp as unknown as string
            ).toISOString(),
          }
        : {}),
      ...(metadata?.finalizers?.length ? { finalizers: [...metadata.finalizers] } : {}),
      ...(metadata?.ownerReferences?.length
        ? {
            owners: metadata.ownerReferences.map((owner) => ({
              apiVersion: owner.apiVersion,
              kind: owner.kind,
              name: owner.name,
              ...(owner.uid ? { uid: owner.uid } : {}),
              ...(owner.controller !== undefined ? { controller: owner.controller } : {}),
            })),
          }
        : {}),
    };
  } catch (error: unknown) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

export function blockerForRemainingResource(
  resource: DeletionResourceIdentity,
  message?: string
): DeletionBlocker {
  const finalizers = resource.finalizers ?? [];
  return {
    code: finalizers.length > 0 ? 'FINALIZERS_REMAIN' : 'RESOURCE_REMAINS',
    message:
      message ??
      (finalizers.length > 0
        ? `${resource.kind}/${resource.name} is still terminating with finalizers: ${finalizers.join(', ')}`
        : `${resource.kind}/${resource.name} still exists after deletion was requested.`),
    resource,
    retryable: true,
    retryGuidance:
      finalizers.length > 0
        ? 'Retry after the owning controller has cleared the listed finalizers; inspect the listed owners before removing a finalizer manually.'
        : 'Retry deletion after the responsible controller has reconciled the remaining resource.',
  };
}
