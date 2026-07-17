import type { KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';

import { CRDInstanceError, ensureError } from '../core/errors.js';
import { createRollbackManager } from '../core/deployment/rollback-manager.js';
import { createBunCompatibleCustomObjectsApi, createBunCompatibleKubernetesObjectApi } from '../core/kubernetes/bun-api-client.js';
import { getComponentLogger } from '../core/logging/index.js';

export interface KroDeletionOptions {
  apiVersion: string;
  kind: string;
  namespace: string;
  rgdName: string;
  group?: string;
  plural?: string;
  timeout?: number;
}

function getSchemaVersion(apiVersion: string): string {
  return apiVersion.includes('/') ? apiVersion.split('/')[1] || apiVersion : apiVersion;
}

function getSchemaGroup(options: KroDeletionOptions): string {
  if (options.group) return options.group;
  return options.apiVersion.includes('/') ? options.apiVersion.split('/')[0] || 'kro.run' : 'kro.run';
}

function getInstanceApiVersion(options: KroDeletionOptions): string {
  return `${getSchemaGroup(options)}/${getSchemaVersion(options.apiVersion)}`;
}

function getKubernetesErrorCode(error: unknown): number | undefined {
  const k8sError = error as { statusCode?: number; code?: number; body?: { code?: number } };
  return k8sError.statusCode ?? k8sError.code ?? k8sError.body?.code;
}

function shouldPreserveRgd(
  instances: ReadonlyArray<{ metadata?: { name?: unknown; namespace?: unknown } }>,
  targetName: string,
  instanceDeleted: boolean,
  targetNamespace: string
): boolean {
  const remaining = instanceDeleted
    ? instances.filter((instance) => {
        if (instance.metadata?.name !== targetName) return true;
        return instance.metadata?.namespace !== targetNamespace;
      })
    : instances;
  return remaining.length > 0;
}

interface CustomObjectListApi {
  listClusterCustomObject(request: {
    group: string;
    version: string;
    plural: string;
  }): Promise<{ items?: Array<{ metadata?: { name?: unknown; namespace?: unknown } }> }>;
}

export interface KubernetesObjectCleanupApi {
  list(apiVersion: string, kind: string): Promise<unknown>;
  delete(resource: {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace?: string };
  }): Promise<unknown>;
  // `read` is required so the RGD/CRD deletes can GATE on a real 404 (finding #1)
  // through the engine's shared deletion primitive — the same gate the imperative
  // path uses. The default bun object API supplies it; tests inject a mock.
  read(resource: {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace?: string };
  }): Promise<unknown>;
}

export interface KubernetesObjectInstanceApi extends KubernetesObjectCleanupApi {
  read(resource: {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace?: string };
  }): Promise<unknown>;
}

export interface KroInstanceDeletionApis {
  k8sApi: KubernetesObjectInstanceApi;
  customApi?: CustomObjectListApi;
  sleep?: (ms: number) => Promise<void>;
}

async function lookupCRDPlural(
  kubeConfig: KubeConfig,
  options: KroDeletionOptions,
  k8sApi: KubernetesObjectCleanupApi = createBunCompatibleKubernetesObjectApi(kubeConfig) as KubernetesObjectCleanupApi
): Promise<string | undefined> {
  const logger = getComponentLogger('alchemy-kro-delete');
  try {
    const crds = (await k8sApi.list(
      'apiextensions.k8s.io/v1',
      'CustomResourceDefinition'
    )) as unknown as {
      items?: Array<{
        spec?: { group?: string; names?: { kind?: string; plural?: string } };
      }>;
    };
    const match = crds.items?.find(
      (crd) => crd.spec?.group === getSchemaGroup(options) && crd.spec?.names?.kind === options.kind
    );
    return match?.spec?.names?.plural;
  } catch (error: unknown) {
    logger.debug('CRD plural lookup failed during Alchemy KRO delete', {
      kind: options.kind,
      error: ensureError(error).message,
    });
    throw new CRDInstanceError(
      `Cannot list CRDs to determine plural for ${options.kind}; preserving RGD/CRD to avoid deleting shared KRO state`,
      options.apiVersion,
      options.kind,
      '*',
      'deletion',
      ensureError(error)
    );
  }
}

async function listKroInstances(
  kubeConfig: KubeConfig,
  options: KroDeletionOptions,
  customApi: CustomObjectListApi = createBunCompatibleCustomObjectsApi(kubeConfig) as CustomObjectListApi
): Promise<Array<{ metadata?: { name?: unknown; namespace?: unknown } }>> {
  const plural = options.plural ?? await lookupCRDPlural(kubeConfig, options);
  if (!plural) {
    return [];
  }

  const response = await customApi.listClusterCustomObject({
    group: getSchemaGroup(options),
    version: getSchemaVersion(options.apiVersion),
    plural,
  });
  return response.items ?? [];
}

/** Internal test hook for cluster-wide KRO instance listing. */
export const listKroInstancesForTest = listKroInstances;

export async function hasKroInstances(
  kubeConfig: KubeConfig,
  options: KroDeletionOptions
): Promise<boolean> {
  return (await listKroInstances(kubeConfig, options)).length > 0;
}

export async function deleteKroDefinition(
  kubeConfig: KubeConfig,
  options: KroDeletionOptions,
  k8sApi: KubernetesObjectCleanupApi = createBunCompatibleKubernetesObjectApi(kubeConfig) as KubernetesObjectCleanupApi
): Promise<void> {
  const logger = getComponentLogger('alchemy-kro-delete');
  // ONE gating mechanism: the engine's rollback manager deletes then polls to a REAL 404
  // and THROWS on timeout — the SAME primitive the imperative KRO teardown uses. A
  // pre-existing 404 is treated as already-gone.
  const rollback = createRollbackManager(k8sApi as unknown as KubernetesObjectApi);
  const timeout = options.timeout ?? 300000;

  // The RGD delete is a HARD gate (throws on timeout).
  try {
    await rollback.deleteResourceAndWait(
      { apiVersion: 'kro.run/v1alpha1', kind: 'ResourceGraphDefinition', name: options.rgdName },
      { timeout }
    );
  } catch (error: unknown) {
    logger.error('Alchemy KRO RGD cleanup failed', ensureError(error), {
      rgdName: options.rgdName,
      error: ensureError(error).message,
    });
    throw error;
  }

  // FINDING #1 — DO NOT delete the generated CRD here (leave it for out-of-band GC).
  //
  // Under alchemy's reverse-topo teardown the hoisted workload Namespace is a SEPARATE
  // resource deleted AFTER the RGD/instance (both `dependsOn` it): the order is
  // instance → RGD → namespace. `deleteKroDefinition` runs during the instance/RGD
  // delete, which is BEFORE the namespace resource's own delete step. If we deleted the
  // CRD here, it would be Terminating while the namespace later drains — and a namespace
  // controller stalls indefinitely enumerating a *Terminating* CRD's type (the
  // apiextensions `customresourcecleanup` finalizer is slow/fragile even with zero
  // instances, upstream kro #1171). That is the EXACT hang the imperative path avoids by
  // deleting the CRD strictly AFTER the namespace.
  //
  // Alchemy cannot cheaply reorder the CRD delete to run after the (separate, later,
  // possibly SHARED/deduped) namespace resource, so we choose the other invariant-safe
  // option: NEVER delete the CRD in the alchemy path. It is never Terminating during
  // namespace teardown, so a namespace can never hang against it. A leftover Active CRD
  // with zero instances is harmless (KRO's default allowCRDDeletion=false already leaves
  // it), cluster-scoped, and can be GC'd out-of-band. This is the accepted residual of the
  // alchemy #1 fix — documented, not silent.
  logger.debug('Alchemy KRO teardown: leaving the generated CRD for out-of-band GC (finding #1)', {
    kind: options.kind,
    rgdName: options.rgdName,
  });
}

export async function deleteKroInstanceFinalizerSafe(
  kubeConfig: KubeConfig,
  name: string,
  options: KroDeletionOptions
): Promise<void> {
  return deleteKroInstanceFinalizerSafeWithApis(kubeConfig, name, options, {
    k8sApi: createBunCompatibleKubernetesObjectApi(kubeConfig) as KubernetesObjectInstanceApi,
  });
}

async function deleteKroInstanceFinalizerSafeWithApis(
  kubeConfig: KubeConfig,
  name: string,
  options: KroDeletionOptions,
  apis: KroInstanceDeletionApis
): Promise<void> {
  const logger = getComponentLogger('alchemy-kro-delete');
  const { customApi, k8sApi, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) } = apis;
  const apiVersion = getInstanceApiVersion(options);
  const timeout = options.timeout ?? 300000;
  let instanceDeleted = false;
  let deletionTimedOut = false;

  try {
    await k8sApi.delete({
      apiVersion,
      kind: options.kind,
      metadata: { name, namespace: options.namespace },
    });

    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        await k8sApi.read({
          apiVersion,
          kind: options.kind,
          metadata: { name, namespace: options.namespace },
        });
        await sleep(2000);
      } catch (pollError: unknown) {
        if (getKubernetesErrorCode(pollError) === 404) {
          instanceDeleted = true;
          break;
        }
        logger.debug('Alchemy KRO deletion poll error; retrying', {
          name,
          errorCode: getKubernetesErrorCode(pollError),
        });
        await sleep(2000);
      }
    }
    if (!instanceDeleted) {
      deletionTimedOut = true;
      logger.warn('Alchemy KRO instance deletion still in progress after timeout', {
        name,
        timeout,
        hint: 'KRO finalizer processing continues in the background. The RGD will be preserved.',
      });
    }
  } catch (error: unknown) {
    if (getKubernetesErrorCode(error) === 404) {
      instanceDeleted = true;
    } else {
      throw new CRDInstanceError(
        `Failed to delete instance ${name}: ${ensureError(error).message}`,
        apiVersion,
        options.kind,
        name,
        'deletion',
        ensureError(error)
      );
    }
  }

  if (deletionTimedOut) {
    throw new CRDInstanceError(
      `KRO instance ${name} deletion did not complete within ${timeout}ms`,
      apiVersion,
      options.kind,
      name,
      'deletion'
    );
  }

  let hasRemainingInstances = false;
  try {
    const instances = await listKroInstances(kubeConfig, options, customApi);
    hasRemainingInstances = shouldPreserveRgd(instances, name, instanceDeleted, options.namespace);
  } catch (error: unknown) {
    logger.warn('Cannot list Alchemy KRO instances to check for shared RGD; preserving RGD', {
      rgdName: options.rgdName,
      error: ensureError(error).message,
    });
    hasRemainingInstances = true;
  }

  if (!hasRemainingInstances) {
    await deleteKroDefinition(kubeConfig, options, k8sApi);
  }

}

/** Internal test hook for finalizer-safe KRO instance deletion decisions. */
export const deleteKroInstanceFinalizerSafeForTest = deleteKroInstanceFinalizerSafeWithApis;
