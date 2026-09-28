import type { KubernetesObject, V1DeleteOptions } from '@kubernetes/client-node';
import type { TypeKroMutationPrecondition } from './types.js';

export interface KubernetesEffectMutation {
  readonly method: 'create' | 'patch' | 'replace' | 'delete';
  readonly resource: KubernetesObject;
}

/** The host may hold an operation-scoped lock through the Kubernetes write. */
export interface KubernetesEffectPermit {
  readonly precondition: TypeKroMutationPrecondition;
  readonly release?: () => void | Promise<void>;
}

/** A proven absent delete target needs no Kubernetes mutation. */
export interface KubernetesEffectSkip {
  readonly skip: 'already-absent';
  readonly release?: () => void | Promise<void>;
}

export type KubernetesEffectDecision =
  | TypeKroMutationPrecondition
  | KubernetesEffectPermit
  | KubernetesEffectSkip
  | undefined;

/**
 * Call the host's admission gate at the last TypeKro-owned boundary before each
 * direct Kubernetes write. The wrapper is per resource operation, so retry and
 * rollback writes cannot reuse an earlier receipt.
 */
export function guardKubernetesObjectApi<T extends object>(
  api: T,
  beforeEffect: (mutation: KubernetesEffectMutation) => Promise<KubernetesEffectDecision>
): T {
  return new Proxy(api, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (
        property !== 'create' &&
        property !== 'patch' &&
        property !== 'replace' &&
        property !== 'delete'
      ) {
        return value.bind(target);
      }
      return async (...args: unknown[]) => {
        const resource = args[0] as KubernetesObject | undefined;
        if (!resource?.apiVersion || !resource.kind || !resource.metadata?.name) {
          throw new Error('A gated Kubernetes effect requires an exact resource identity.');
        }
        const method = property;
        const decision = await beforeEffect({ method, resource });
        if (!decision) return Reflect.apply(value, target, args);
        if ('skip' in decision) {
          try {
            if (method !== 'delete') {
              throw new Error('Only a Kubernetes delete may skip an already absent target.');
            }
            return { status: 'Success' };
          } finally {
            await decision.release?.();
          }
        }
        const permit = 'precondition' in decision ? decision : { precondition: decision };
        const precondition = permit.precondition;
        try {
          if (method === 'create' || (method === 'patch' && precondition.operation === 'create')) {
            if (precondition.operation !== 'create') {
              throw new Error('Kubernetes create requires fresh create-only authority.');
            }
            if (resource.metadata.uid || resource.metadata.resourceVersion) {
              throw new Error('A create-only Kubernetes effect cannot carry incumbent metadata.');
            }
            if (method === 'patch') {
              if (args[5] !== 'application/apply-patch+yaml') {
                throw new Error(
                  'Only server-side apply may become an authorized Kubernetes create.'
                );
              }
              const create = Reflect.get(target, 'create', target);
              if (typeof create !== 'function') {
                throw new Error('The Kubernetes object API cannot perform an authorized create.');
              }
              return await Reflect.apply(create, target, [
                resource,
                args[1],
                args[2],
                args[3],
                args[6],
              ]);
            }
          } else {
            if (
              precondition.operation !== 'update' ||
              !precondition.uid?.trim() ||
              !precondition.resourceVersion?.trim()
            ) {
              throw new Error(
                `Kubernetes ${method} requires a fresh UID/resourceVersion precondition.`
              );
            }
            if (
              (resource.metadata.uid && resource.metadata.uid !== precondition.uid) ||
              (resource.metadata.resourceVersion &&
                resource.metadata.resourceVersion !== precondition.resourceVersion)
            ) {
              throw new Error(`Kubernetes ${method} has conflicting incumbent metadata.`);
            }
            if (method === 'delete') {
              const body = (args[6] ?? {}) as V1DeleteOptions;
              if (
                (body.preconditions?.uid && body.preconditions.uid !== precondition.uid) ||
                (body.preconditions?.resourceVersion &&
                  body.preconditions.resourceVersion !== precondition.resourceVersion)
              ) {
                throw new Error('Kubernetes delete has conflicting preconditions.');
              }
              args[6] = {
                ...body,
                preconditions: {
                  ...body.preconditions,
                  uid: precondition.uid,
                  resourceVersion: precondition.resourceVersion,
                },
              } satisfies V1DeleteOptions;
            } else {
              args[0] = {
                ...resource,
                metadata: {
                  ...resource.metadata,
                  uid: precondition.uid,
                  resourceVersion: precondition.resourceVersion,
                },
              } satisfies KubernetesObject;
            }
          }
          return await Reflect.apply(value, target, args);
        } finally {
          await permit.release?.();
        }
      };
    },
  });
}
