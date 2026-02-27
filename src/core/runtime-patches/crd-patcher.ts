/**
 * CRD Patcher Utilities
 *
 * Provides utilities to patch existing CRDs in a Kubernetes cluster to fix
 * schema validation issues that occur with newer Kubernetes versions (1.33+).
 *
 * This is useful when CRDs were installed before the schema fix was available,
 * and you need to update them without deleting and recreating.
 */

import type * as k8s from '@kubernetes/client-node';
import { createBunCompatibleApiextensionsV1Api } from '../kubernetes/bun-api-client.js';
import { getErrorStatusCode } from '../kubernetes/errors.js';
import { getComponentLogger } from '../logging/index.js';
import { generateSchemaFixPatches, schemaFieldNeedsFix } from './crd-schema-fix.js';

const logger = getComponentLogger('crd-patcher');

/**
 * Check if a CRD needs the schema fix
 */
export function crdNeedsSchemaFix(crd: unknown): boolean {
  if (!crd || typeof crd !== 'object') {
    return false;
  }

  const spec = (crd as Record<string, unknown>).spec;
  if (!spec || typeof spec !== 'object') {
    return false;
  }

  const versions = (spec as Record<string, unknown>).versions;
  if (!Array.isArray(versions)) {
    return false;
  }

  for (const version of versions) {
    if (
      version &&
      typeof version === 'object' &&
      (version as Record<string, unknown>).schema &&
      typeof (version as Record<string, unknown>).schema === 'object'
    ) {
      const schema = (version as Record<string, unknown>).schema as Record<string, unknown>;
      if (
        schema.openAPIV3Schema &&
        schemaFieldNeedsFix(schema.openAPIV3Schema as Record<string, unknown>)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Patch a CRD in the cluster to fix schema validation issues
 *
 * @param kubeConfig - Kubernetes configuration
 * @param crdName - Name of the CRD to patch (e.g., 'helmreleases.helm.toolkit.fluxcd.io')
 * @returns true if the CRD was patched, false if no patch was needed
 */
export async function patchCRDSchema(
  kubeConfig: k8s.KubeConfig,
  crdName: string
): Promise<boolean> {
  const apiextensionsApi = createBunCompatibleApiextensionsV1Api(kubeConfig);

  try {
    // Read the current CRD
    const crd = await apiextensionsApi.readCustomResourceDefinition({ name: crdName });

    if (!crdNeedsSchemaFix(crd)) {
      logger.debug(`CRD ${crdName} does not need schema fix`);
      return false;
    }

    // Generate patches for each version
    const patches: { op: string; path: string; value: unknown }[] = [];
    const crdObj = crd as unknown as Record<string, unknown>;
    const crdSpec = crdObj.spec as Record<string, unknown> | undefined;
    const versions = (Array.isArray(crdSpec?.versions) ? crdSpec.versions : []) as Record<
      string,
      unknown
    >[];

    for (let i = 0; i < versions.length; i++) {
      const version = versions[i] as Record<string, unknown> | undefined;
      const schema = version?.schema as Record<string, unknown> | undefined;
      if (schema?.openAPIV3Schema) {
        const basePath = `/spec/versions/${i}/schema/openAPIV3Schema`;
        patches.push(
          ...generateSchemaFixPatches(schema.openAPIV3Schema as Record<string, unknown>, basePath)
        );
      }
    }

    if (patches.length === 0) {
      logger.debug(`No patches needed for CRD ${crdName}`);
      return false;
    }

    logger.warn(
      `Patching CRD ${crdName} schema with ${patches.length} patches for K8s 1.33+ compatibility`
    );

    // Apply the patches using JSON Patch
    await apiextensionsApi.patchCustomResourceDefinition({
      name: crdName,
      body: patches,
    });

    logger.warn(`CRD ${crdName} schema patched successfully`);
    return true;
  } catch (error: unknown) {
    // If CRD doesn't exist, that's fine
    if (getErrorStatusCode(error) === 404) {
      logger.debug(`CRD ${crdName} does not exist, skipping patch`);
      return false;
    }
    throw error;
  }
}

/**
 * Patch all Flux CRDs that need the schema fix
 *
 * @param kubeConfig - Kubernetes configuration
 * @returns Number of CRDs that were patched
 */
export async function patchFluxCRDSchemas(kubeConfig: k8s.KubeConfig): Promise<number> {
  const fluxCRDs = [
    'helmreleases.helm.toolkit.fluxcd.io',
    'helmrepositories.source.toolkit.fluxcd.io',
    'helmcharts.source.toolkit.fluxcd.io',
    'kustomizations.kustomize.toolkit.fluxcd.io',
    'gitrepositories.source.toolkit.fluxcd.io',
    'ocirepositories.source.toolkit.fluxcd.io',
    'buckets.source.toolkit.fluxcd.io',
  ];

  let patchedCount = 0;

  for (const crdName of fluxCRDs) {
    try {
      const patched = await patchCRDSchema(kubeConfig, crdName);
      if (patched) {
        patchedCount++;
      }
    } catch (error: unknown) {
      logger.warn(
        `Failed to patch CRD ${crdName}: ${error instanceof Error ? error.message : String(error)}, continuing...`
      );
    }
  }

  return patchedCount;
}
