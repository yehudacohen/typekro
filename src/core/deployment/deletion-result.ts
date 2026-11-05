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

/**
 * Project an existing read into bounded lifecycle metadata. Never copy spec,
 * status, annotations, response bodies, or arbitrary error properties.
 */
export function observedDeletionResourceIdentity(
  target: DeletionResourceIdentity,
  live: unknown
): DeletionResourceIdentity {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
  const metadata = record(record(live).metadata);
  const uid = text(metadata.uid);
  const timestamp = metadata.deletionTimestamp;
  const date =
    (typeof timestamp === 'string' && timestamp.length <= 64) || timestamp instanceof Date
      ? new Date(timestamp)
      : undefined;
  const finalizers = Array.isArray(metadata.finalizers)
    ? metadata.finalizers.slice(0, 64).filter((value): value is string => text(value) !== undefined)
    : [];
  const owners = Array.isArray(metadata.ownerReferences)
    ? metadata.ownerReferences.slice(0, 32).flatMap((value) => {
        const owner = record(value);
        const apiVersion = text(owner.apiVersion);
        const kind = text(owner.kind);
        const name = text(owner.name);
        if (!apiVersion || !kind || !name) return [];
        const ownerUid = text(owner.uid);
        return [
          {
            apiVersion,
            kind,
            name,
            ...(ownerUid ? { uid: ownerUid } : {}),
            ...(typeof owner.controller === 'boolean' ? { controller: owner.controller } : {}),
          },
        ];
      })
    : [];
  return {
    ...deletionTarget(target.apiVersion, target.kind, target.name, target.namespace),
    ...(uid ? { uid } : {}),
    ...(date && Number.isFinite(date.getTime()) ? { deletionTimestamp: date.toISOString() } : {}),
    ...(finalizers.length > 0 ? { finalizers } : {}),
    ...(owners.length > 0 ? { owners } : {}),
  };
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
    return observedDeletionResourceIdentity(target, live);
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
