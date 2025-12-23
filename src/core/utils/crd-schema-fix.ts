/**
 * CRD Schema Fix Utilities
 *
 * Provides utilities to fix CRD schema validation issues that occur with newer
 * Kubernetes versions (1.33+) which have stricter OpenAPI schema validation.
 *
 * ## Background
 *
 * Kubernetes 1.33 introduced stricter validation for CRD schemas. Specifically,
 * when a field uses `x-kubernetes-preserve-unknown-fields: true`, it now requires
 * a `type` field to be present. Many CRDs (including Flux) don't include this,
 * causing 422 validation errors.
 *
 * ## Usage
 *
 * This utility should be used in bootstrap compositions that install CRDs from
 * external sources (like Flux install.yaml) that may not be compatible with
 * newer Kubernetes versions.
 *
 * @example
 * ```typescript
 * import { fixCRDSchemaForK8s133 } from '../../../core/utils/crd-schema-fix.js';
 *
 * // In a yamlFile transform or custom deployment logic:
 * const fixedManifests = manifests.map(m => fixCRDSchemaForK8s133(m));
 * ```
 *
 * ## Smart Application
 *
 * The `needsCRDSchemaFix` function can be used to check if a CRD actually needs
 * the fix before applying it. This is useful when using 'replace' strategy to
 * avoid overwriting manual patches on existing clusters.
 *
 * @example
 * ```typescript
 * import { needsCRDSchemaFix, fixCRDSchemaForK8s133 } from '../../../core/utils/crd-schema-fix.js';
 *
 * // Only apply fix if needed
 * const transform = (manifest) => {
 *   if (needsCRDSchemaFix(manifest)) {
 *     return fixCRDSchemaForK8s133(manifest);
 *   }
 *   return manifest;
 * };
 * ```
 */

import { getComponentLogger } from '../logging/index.js';
import type { KubernetesResource } from '../types/kubernetes.js';

const logger = getComponentLogger('crd-schema-fix');

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
 * Result of checking if a CRD needs schema fixes
 */
export interface CRDSchemaCheckResult {
  /** Whether the CRD needs any fixes */
  needsFix: boolean;
  /** List of issues found that need fixing */
  issues: string[];
  /** CRD name if available */
  crdName?: string;
}

/**
 * Check if a CRD schema has issues that need fixing for Kubernetes 1.33+
 *
 * This function performs a non-destructive check to determine if a CRD
 * has schema validation issues without modifying the manifest.
 *
 * @param manifest - A Kubernetes resource manifest
 * @returns Check result indicating if fixes are needed and what issues were found
 */
export function needsCRDSchemaFix(manifest: KubernetesResource): CRDSchemaCheckResult {
  if (manifest.kind !== 'CustomResourceDefinition') {
    return { needsFix: false, issues: [] };
  }

  const crd = manifest as any;
  if (!crd.spec?.versions) {
    return { needsFix: false, issues: [], crdName: crd.metadata?.name };
  }

  const issues: string[] = [];
  const crdName = crd.metadata?.name || 'unknown';

  // Recursively check schema properties for issues
  function checkSchemaProperties(obj: any, fieldPath: string, fieldName?: string): void {
    if (!obj || typeof obj !== 'object') {
      return;
    }

    // Check if this object has x-kubernetes-preserve-unknown-fields but no type
    if (obj['x-kubernetes-preserve-unknown-fields'] === true && !obj.type) {
      issues.push(`${fieldPath}: has x-kubernetes-preserve-unknown-fields without type`);
    }

    // Check if this is a known field that needs x-kubernetes-preserve-unknown-fields
    if (fieldName && FIELDS_NEEDING_PRESERVE_UNKNOWN.has(fieldName)) {
      if (!obj.type) {
        issues.push(`${fieldPath}: known field '${fieldName}' missing type`);
      }
      if (!obj['x-kubernetes-preserve-unknown-fields']) {
        issues.push(`${fieldPath}: known field '${fieldName}' missing x-kubernetes-preserve-unknown-fields`);
      }
    }

    // Recursively check all properties
    if (obj.properties) {
      for (const [propName, prop] of Object.entries(obj.properties)) {
        checkSchemaProperties(prop, `${fieldPath}.properties.${propName}`, propName);
      }
    }

    // Check additionalProperties
    if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
      checkSchemaProperties(obj.additionalProperties, `${fieldPath}.additionalProperties`);
    }

    // Check items (for arrays)
    if (obj.items) {
      checkSchemaProperties(obj.items, `${fieldPath}.items`);
    }
  }

  // Check each version's schema
  for (const version of crd.spec.versions) {
    if (version.schema?.openAPIV3Schema) {
      checkSchemaProperties(
        version.schema.openAPIV3Schema,
        `spec.versions[${version.name}].schema.openAPIV3Schema`
      );
    }
  }

  return {
    needsFix: issues.length > 0,
    issues,
    crdName,
  };
}

/**
 * Fix CRD schema validation issues for Kubernetes 1.33+
 *
 * Kubernetes 1.33 requires a `type` field when `x-kubernetes-preserve-unknown-fields` is used.
 * This function patches CRDs to:
 * 1. Add `type: object` to fields that use `x-kubernetes-preserve-unknown-fields` without a type
 * 2. Add `x-kubernetes-preserve-unknown-fields: true` to known Helm values fields that need it
 *
 * @param manifest - A Kubernetes resource manifest
 * @returns The manifest with CRD schema fixes applied (or unchanged if not a CRD)
 */
export function fixCRDSchemaForK8s133(manifest: KubernetesResource): KubernetesResource {
  if (manifest.kind !== 'CustomResourceDefinition') {
    return manifest;
  }

  const crd = manifest as any;
  if (!crd.spec?.versions) {
    return manifest;
  }

  // Deep clone to avoid mutating the original
  const fixedCrd = JSON.parse(JSON.stringify(crd));
  const crdName = crd.metadata?.name || 'unknown';

  // Track what changes were made for logging
  const changes: string[] = [];

  // Recursively fix schema properties
  function fixSchemaProperties(obj: any, fieldPath: string, fieldName?: string): void {
    if (!obj || typeof obj !== 'object') {
      return;
    }

    // If this object has x-kubernetes-preserve-unknown-fields but no type, add type: object
    if (obj['x-kubernetes-preserve-unknown-fields'] === true && !obj.type) {
      obj.type = 'object';
      changes.push(`Added type: object to ${fieldPath} (had x-kubernetes-preserve-unknown-fields without type)`);
    }

    // If this is a known field that needs x-kubernetes-preserve-unknown-fields, add it
    // This is needed for fields like HelmRelease.spec.values which accept arbitrary Helm values
    // The field may or may not have type: object already set
    if (fieldName && FIELDS_NEEDING_PRESERVE_UNKNOWN.has(fieldName)) {
      // Ensure type is set (required by K8s 1.33+)
      if (!obj.type) {
        obj.type = 'object';
        changes.push(`Added type: object to ${fieldPath} (known field needing preserve-unknown-fields)`);
      }
      // Ensure x-kubernetes-preserve-unknown-fields is set
      if (!obj['x-kubernetes-preserve-unknown-fields']) {
        obj['x-kubernetes-preserve-unknown-fields'] = true;
        changes.push(`Added x-kubernetes-preserve-unknown-fields: true to ${fieldPath}`);
      }
    }

    // Recursively process all properties
    if (obj.properties) {
      for (const [propName, prop] of Object.entries(obj.properties)) {
        fixSchemaProperties(prop, `${fieldPath}.properties.${propName}`, propName);
      }
    }

    // Process additionalProperties
    if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
      fixSchemaProperties(obj.additionalProperties, `${fieldPath}.additionalProperties`);
    }

    // Process items (for arrays)
    if (obj.items) {
      fixSchemaProperties(obj.items, `${fieldPath}.items`);
    }
  }

  // Fix each version's schema
  for (const version of fixedCrd.spec.versions) {
    if (version.schema?.openAPIV3Schema) {
      fixSchemaProperties(version.schema.openAPIV3Schema, `spec.versions[${version.name}].schema.openAPIV3Schema`);
    }
  }

  // Log changes if any were made
  if (changes.length > 0) {
    logger.warn('CRD schema modified for Kubernetes 1.33+ compatibility', {
      crdName,
      changesCount: changes.length,
      changes,
      note: 'These changes alter the CRD validation behavior. Review if unexpected validation issues occur.',
    });
  }

  return fixedCrd;
}

/**
 * Apply CRD schema fixes to an array of manifests
 *
 * @param manifests - Array of Kubernetes resource manifests
 * @returns Array with CRD schema fixes applied to any CRDs
 */
export function fixCRDSchemasForK8s133(manifests: KubernetesResource[]): KubernetesResource[] {
  return manifests.map((m) => fixCRDSchemaForK8s133(m));
}

/**
 * Smart CRD schema fix that only applies changes when needed
 *
 * This function checks if a CRD actually needs the fix before applying it.
 * This is useful when using 'replace' strategy to avoid overwriting manual
 * patches on existing clusters.
 *
 * @param manifest - A Kubernetes resource manifest
 * @returns The manifest with CRD schema fixes applied only if needed
 */
export function smartFixCRDSchemaForK8s133(manifest: KubernetesResource): KubernetesResource {
  const checkResult = needsCRDSchemaFix(manifest);

  if (!checkResult.needsFix) {
    return manifest;
  }

  logger.info('CRD needs schema fix for Kubernetes 1.33+ compatibility', {
    crdName: checkResult.crdName,
    issuesCount: checkResult.issues.length,
    issues: checkResult.issues,
  });

  return fixCRDSchemaForK8s133(manifest);
}

/**
 * Apply smart CRD schema fixes to an array of manifests
 *
 * Only applies fixes to CRDs that actually need them.
 *
 * @param manifests - Array of Kubernetes resource manifests
 * @returns Array with CRD schema fixes applied only where needed
 */
export function smartFixCRDSchemasForK8s133(manifests: KubernetesResource[]): KubernetesResource[] {
  return manifests.map((m) => smartFixCRDSchemaForK8s133(m));
}
