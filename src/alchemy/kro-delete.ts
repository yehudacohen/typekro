import type { KubeConfig } from '@kubernetes/client-node';

import { CRDInstanceError, ensureError } from '../core/errors.js';
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

async function lookupCRDPlural(kubeConfig: KubeConfig, options: KroDeletionOptions): Promise<string | undefined> {
  const logger = getComponentLogger('alchemy-kro-delete');
  try {
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
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
    return undefined;
  }
}

async function listKroInstances(
  kubeConfig: KubeConfig,
  options: KroDeletionOptions,
  customApi: CustomObjectListApi = createBunCompatibleCustomObjectsApi(kubeConfig) as CustomObjectListApi
): Promise<Array<{ metadata?: { name?: unknown; namespace?: unknown } }>> {
  const plural = options.plural ?? await lookupCRDPlural(kubeConfig, options);
  if (!plural) {
    throw new CRDInstanceError(
      `Cannot determine CRD plural for ${options.kind}; preserving RGD/CRD to avoid deleting shared KRO state`,
      options.apiVersion,
      options.kind,
      '*',
      'deletion'
    );
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
  options: KroDeletionOptions
): Promise<void> {
  const logger = getComponentLogger('alchemy-kro-delete');
  const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
  const crdPlural = options.plural ?? await lookupCRDPlural(kubeConfig, options);
  if (!crdPlural) {
    throw new CRDInstanceError(
      `Cannot determine CRD plural for ${options.kind}; preserving RGD/CRD to avoid deleting shared KRO state`,
      options.apiVersion,
      options.kind,
      '*',
      'deletion'
    );
  }

  try {
    await k8sApi.delete({
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: options.rgdName },
    });
  } catch (error: unknown) {
    if (getKubernetesErrorCode(error) !== 404) {
      logger.error('Alchemy KRO RGD cleanup failed', ensureError(error), {
        rgdName: options.rgdName,
        error: ensureError(error).message,
      });
      throw error;
    }
  }

  const crdName = `${crdPlural}.${getSchemaGroup(options)}`;
  try {
    await k8sApi.delete({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: crdName },
    });
  } catch (error: unknown) {
    if (getKubernetesErrorCode(error) !== 404) {
      logger.error('Alchemy KRO CRD cleanup failed', ensureError(error), {
        crdName,
        error: ensureError(error).message,
      });
      throw error;
    }
  }
}

export async function deleteKroInstanceFinalizerSafe(
  kubeConfig: KubeConfig,
  name: string,
  options: KroDeletionOptions
): Promise<void> {
  const logger = getComponentLogger('alchemy-kro-delete');
  const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
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
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (pollError: unknown) {
        if (getKubernetesErrorCode(pollError) === 404) {
          instanceDeleted = true;
          break;
        }
        logger.debug('Alchemy KRO deletion poll error; retrying', {
          name,
          errorCode: getKubernetesErrorCode(pollError),
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
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
    const instances = await listKroInstances(kubeConfig, options);
    hasRemainingInstances = shouldPreserveRgd(instances, name, instanceDeleted, options.namespace);
  } catch (error: unknown) {
    logger.warn('Cannot list Alchemy KRO instances to check for shared RGD; preserving RGD', {
      rgdName: options.rgdName,
      error: ensureError(error).message,
    });
    hasRemainingInstances = true;
  }

  if (!hasRemainingInstances) {
    await deleteKroDefinition(kubeConfig, options);
  }

}
