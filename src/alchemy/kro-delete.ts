import type { KubeConfig } from '@kubernetes/client-node';

import { CRDInstanceError, ensureError } from '../core/errors.js';
import { createBunCompatibleCustomObjectsApi, createBunCompatibleKubernetesObjectApi } from '../core/kubernetes/bun-api-client.js';
import { getComponentLogger } from '../core/logging/index.js';
import { pluralizeKind } from '../core/deployment/shared-utilities.js';

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
  instances: ReadonlyArray<{ metadata?: { name?: unknown } }>,
  targetName: string,
  instanceDeleted: boolean
): boolean {
  const remaining = instanceDeleted
    ? instances.filter((instance) => instance.metadata?.name !== targetName)
    : instances;
  return remaining.length > 0;
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
  options: KroDeletionOptions
): Promise<Array<{ metadata?: { name?: unknown } }>> {
  const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
  const plural = options.plural ?? await lookupCRDPlural(kubeConfig, options) ?? pluralizeKind(options.kind);

  try {
    const response = await customApi.listNamespacedCustomObject({
      group: getSchemaGroup(options),
      version: getSchemaVersion(options.apiVersion),
      namespace: options.namespace,
      plural,
    }) as { items?: Array<{ metadata?: { name?: unknown } }> };
    return response.items ?? [];
  } catch (error: unknown) {
    if (getKubernetesErrorCode(error) === 404) return [];
    throw error;
  }
}

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

  try {
    await k8sApi.delete({
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: options.rgdName },
    });
  } catch (error: unknown) {
    if (getKubernetesErrorCode(error) !== 404) {
      logger.warn('Alchemy KRO RGD cleanup failed', {
        rgdName: options.rgdName,
        error: ensureError(error).message,
      });
    }
  }

  const crdPlural = options.plural ?? await lookupCRDPlural(kubeConfig, options) ?? pluralizeKind(options.kind);
  const crdName = `${crdPlural}.${getSchemaGroup(options)}`;
  try {
    await k8sApi.delete({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: crdName },
    });
  } catch (error: unknown) {
    if (getKubernetesErrorCode(error) !== 404) {
      logger.debug('Alchemy KRO CRD cleanup failed (non-critical)', {
        crdName,
        error: ensureError(error).message,
      });
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

  let hasRemainingInstances = false;
  try {
    const instances = await listKroInstances(kubeConfig, options);
    hasRemainingInstances = shouldPreserveRgd(instances, name, instanceDeleted);
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

  if (deletionTimedOut) {
    throw new CRDInstanceError(
      `KRO instance ${name} deletion did not complete within ${timeout}ms`,
      apiVersion,
      options.kind,
      name,
      'deletion'
    );
  }
}
