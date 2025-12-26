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
import { getComponentLogger } from '../logging/index.js';

const logger = getComponentLogger('crd-patcher');

/**
 * Known field paths that need x-kubernetes-preserve-unknown-fields: true
 * These are fields that accept arbitrary user-defined values (like Helm values)
 */
const FIELDS_NEEDING_PRESERVE_UNKNOWN = new Set([
  'values', // HelmRelease spec.values
  'valuesFrom', // HelmRelease spec.valuesFrom items
  'postRenderers', // HelmRelease spec.postRenderers
]);

/**
 * Recursively check if a schema needs the preserve-unknown-fields fix
 */
function schemaFieldNeedsFix(obj: any, fieldName?: string): boolean {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  // Check if this field needs the fix
  if (
    fieldName &&
    FIELDS_NEEDING_PRESERVE_UNKNOWN.has(fieldName) &&
    obj.type === 'object' &&
    !obj['x-kubernetes-preserve-unknown-fields']
  ) {
    return true;
  }

  // Check if x-kubernetes-preserve-unknown-fields is used without type
  if (obj['x-kubernetes-preserve-unknown-fields'] === true && !obj.type) {
    return true;
  }

  // Recursively check properties
  if (obj.properties) {
    for (const [propName, prop] of Object.entries(obj.properties)) {
      if (schemaFieldNeedsFix(prop, propName)) {
        return true;
      }
    }
  }

  // Check additionalProperties
  if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
    if (schemaFieldNeedsFix(obj.additionalProperties)) {
      return true;
    }
  }

  // Check items (for arrays)
  if (obj.items && schemaFieldNeedsFix(obj.items)) {
    return true;
  }

  return false;
}

/**
 * Check if a CRD needs the schema fix
 */
export function crdNeedsSchemaFix(crd: any): boolean {
  if (!crd?.spec?.versions) {
    return false;
  }

  for (const version of crd.spec.versions) {
    if (version.schema?.openAPIV3Schema) {
      if (schemaFieldNeedsFix(version.schema.openAPIV3Schema)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Generate JSON patch operations to fix a CRD schema
 */
function generateSchemaFixPatches(obj: any, basePath: string, fieldName?: string): any[] {
  const patches: any[] = [];

  if (!obj || typeof obj !== 'object') {
    return patches;
  }

  // Fix: Add x-kubernetes-preserve-unknown-fields to known fields that need it
  if (
    fieldName &&
    FIELDS_NEEDING_PRESERVE_UNKNOWN.has(fieldName) &&
    obj.type === 'object' &&
    !obj['x-kubernetes-preserve-unknown-fields']
  ) {
    patches.push({
      op: 'add',
      path: `${basePath}/x-kubernetes-preserve-unknown-fields`,
      value: true,
    });
  }

  // Fix: Add type: object when x-kubernetes-preserve-unknown-fields is used without type
  if (obj['x-kubernetes-preserve-unknown-fields'] === true && !obj.type) {
    patches.push({
      op: 'add',
      path: `${basePath}/type`,
      value: 'object',
    });
  }

  // Recursively process properties
  if (obj.properties) {
    for (const [propName, prop] of Object.entries(obj.properties)) {
      const propPath = `${basePath}/properties/${propName}`;
      patches.push(...generateSchemaFixPatches(prop, propPath, propName));
    }
  }

  // Process additionalProperties
  if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
    patches.push(
      ...generateSchemaFixPatches(obj.additionalProperties, `${basePath}/additionalProperties`)
    );
  }

  // Process items (for arrays)
  if (obj.items) {
    patches.push(...generateSchemaFixPatches(obj.items, `${basePath}/items`));
  }

  return patches;
}

/**
 * Patch a CRD in the cluster to fix schema validation issues
 *
 * @param kubeConfig - Kubernetes configuration
 * @param crdName - Name of the CRD to patch (e.g., 'helmreleases.helm.toolkit.fluxcd.io')
 * @returns true if the CRD was patched, false if no patch was needed
 */
export async function patchCRDSchema(kubeConfig: k8s.KubeConfig, crdName: string): Promise<boolean> {
  const apiextensionsApi = createBunCompatibleApiextensionsV1Api(kubeConfig);

  try {
    // Read the current CRD
    const crd = await apiextensionsApi.readCustomResourceDefinition({ name: crdName });

    if (!crdNeedsSchemaFix(crd)) {
      logger.debug(`CRD ${crdName} does not need schema fix`);
      return false;
    }

    // Generate patches for each version
    const patches: any[] = [];
    const versions = (crd as any).spec?.versions || [];

    for (let i = 0; i < versions.length; i++) {
      const version = versions[i];
      if (version.schema?.openAPIV3Schema) {
        const basePath = `/spec/versions/${i}/schema/openAPIV3Schema`;
        patches.push(...generateSchemaFixPatches(version.schema.openAPIV3Schema, basePath));
      }
    }

    if (patches.length === 0) {
      logger.debug(`No patches needed for CRD ${crdName}`);
      return false;
    }

    logger.info(`Patching CRD ${crdName} schema with ${patches.length} patches`);

    // Apply the patches using JSON Patch
    await apiextensionsApi.patchCustomResourceDefinition({
      name: crdName,
      body: patches,
    });

    logger.info(`CRD ${crdName} schema patched successfully`);
    return true;
  } catch (error: any) {
    // If CRD doesn't exist, that's fine
    if (error.statusCode === 404) {
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
    } catch (error: any) {
      logger.warn(`Failed to patch CRD ${crdName}: ${error.message}, continuing...`);
    }
  }

  return patchedCount;
}
