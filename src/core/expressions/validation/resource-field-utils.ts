/**
 * Resource Field Utilities
 *
 * Kubernetes field knowledge utilities for resource reference validation.
 * These functions handle field type resolution, field availability checking,
 * similarity matching, and deprecation detection.
 */

import { calculateSimilarity } from '../../../utils/string.js';
import type { KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import type { ResourceValidationMetadata } from './resource-validation-types.js';
import type { TypeInfo } from './type-safety.js';

/**
 * Get field type from schema proxy
 */
export function getSchemaFieldType(
  _schemaProxy: SchemaProxy<Record<string, unknown>, Record<string, unknown>>,
  _fieldPath: string
): TypeInfo | undefined {
  // This would integrate with the actual schema type system
  // For now, return a placeholder
  return { typeName: 'unknown', optional: false, nullable: false };
}

/**
 * Get field type from a resource
 */
export function getResourceFieldType(
  _resource: Enhanced<unknown, unknown>,
  fieldPath: string
): TypeInfo | undefined {
  // This would integrate with the Enhanced type system
  // For now, return a placeholder based on common Kubernetes field patterns

  // Define known valid field patterns - be very specific
  const validFieldPatterns = [
    'metadata.name',
    'metadata.namespace',
    'metadata.labels',
    'spec.replicas',
    'spec.selector',
    'spec.template',
    'spec.ports',
    'status.ready',
    'status.readyReplicas', // Note: 'status.readyReplica' (without 's') is NOT valid
    'status.availableReplicas',
    'status.conditions',
    'status.phase',
    'status.podIP',
    'status.clusterIP',
    'status.loadBalancer',
  ];

  // Check if the field path exactly matches a known pattern
  const isExactMatch = validFieldPatterns.includes(fieldPath);

  // Check if it starts with a valid prefix and has additional nested fields
  const hasValidPrefix = validFieldPatterns.some((pattern) => {
    if (fieldPath.startsWith(`${pattern}.`)) return true;

    // Handle array indexing like loadBalancer.ingress[0].ip
    const fieldWithArrayPattern = fieldPath.replace(/\[\d+\]/g, '');
    if (fieldWithArrayPattern.startsWith(`${pattern}.`)) return true;

    return false;
  });

  const isValidField = isExactMatch || hasValidPrefix;

  // Return type info only for valid fields
  if (fieldPath.startsWith('metadata.') && isValidField) {
    return { typeName: 'string', optional: true, nullable: false };
  }

  if (fieldPath.startsWith('spec.') && isValidField) {
    return { typeName: 'unknown', optional: false, nullable: false };
  }

  if (fieldPath.startsWith('status.') && isValidField) {
    return { typeName: 'unknown', optional: true, nullable: true };
  }

  // Return undefined for invalid fields (including typos like 'status.readyReplica')
  return undefined;
}

/**
 * Get available fields from a schema proxy
 */
export function getAvailableSchemaFields(_schemaProxy: SchemaProxy<Record<string, unknown>, Record<string, unknown>>): string[] {
  // This would extract available fields from the schema
  return ['spec.name', 'spec.replicas', 'status.ready', 'metadata.name'];
}

/**
 * Get available fields from a resource
 */
export function getAvailableResourceFields(resource: Enhanced<unknown, unknown>): string[] {
  const resourceKind = resource.constructor.name;

  // Common fields for different resource types
  const fieldsByKind: Record<string, string[]> = {
    Deployment: [
      'metadata.name',
      'metadata.namespace',
      'metadata.labels',
      'metadata.annotations',
      'spec.replicas',
      'spec.selector',
      'spec.template',
      'spec.strategy',
      'status.replicas',
      'status.readyReplicas',
      'status.availableReplicas',
      'status.unavailableReplicas',
      'status.conditions',
    ],
    Service: [
      'metadata.name',
      'metadata.namespace',
      'metadata.labels',
      'metadata.annotations',
      'spec.type',
      'spec.ports',
      'spec.selector',
      'spec.clusterIP',
      'status.loadBalancer',
      'status.conditions',
    ],
    Pod: [
      'metadata.name',
      'metadata.namespace',
      'metadata.labels',
      'metadata.annotations',
      'spec.containers',
      'spec.volumes',
      'spec.nodeSelector',
      'status.phase',
      'status.conditions',
      'status.hostIP',
      'status.podIP',
      'status.containerStatuses',
    ],
    ConfigMap: [
      'metadata.name',
      'metadata.namespace',
      'metadata.labels',
      'metadata.annotations',
      'data',
      'binaryData',
    ],
    Secret: [
      'metadata.name',
      'metadata.namespace',
      'metadata.labels',
      'metadata.annotations',
      'type',
      'data',
      'stringData',
    ],
  };

  return (
    fieldsByKind[resourceKind] || [
      'metadata.name',
      'metadata.namespace',
      'metadata.labels',
      'metadata.annotations',
      'spec',
      'status',
    ]
  );
}

/**
 * Check if a field path is a common Kubernetes field
 */
export function isCommonKubernetesField(fieldPath: string): boolean {
  // Only consider very specific common fields as valid
  // This is more strict to catch typos like 'status.readyReplica'
  const exactCommonFields = [
    'metadata.name',
    'metadata.namespace',
    'metadata.labels',
    'metadata.annotations',
    'spec.replicas',
    'spec.selector',
    'spec.template',
    'spec.ports',
    'status.ready',
    'status.readyReplicas', // Note: 'status.readyReplica' is NOT in this list
    'status.availableReplicas',
    'status.conditions',
    'status.phase',
    'status.podIP',
    'status.clusterIP',
    'status.loadBalancer',
    'status.loadBalancer.ingress',
    'data',
    'stringData',
    'binaryData',
  ];

  // Check for exact matches or valid nested paths
  return exactCommonFields.some((field) => {
    if (fieldPath === field) return true;
    if (fieldPath.startsWith(`${field}.`)) return true;

    // Handle array indexing like loadBalancer.ingress[0].ip
    const fieldWithArrayPattern = fieldPath.replace(/\[\d+\]/g, '');
    if (fieldWithArrayPattern === field || fieldWithArrayPattern.startsWith(`${field}.`))
      return true;

    return false;
  });
}

/**
 * Find similar field names using string similarity
 */
export function findSimilarFieldNames(target: string, available: string[]): string[] {
  // Simple similarity matching - could be improved with better algorithms
  return available
    .filter((field) => {
      const similarity = calculateSimilarity(target, field);
      return similarity > 0.6;
    })
    .slice(0, 3);
}

/**
 * Find similar resource names using string similarity
 */
export function findSimilarResourceNames(target: string, available: string[]): string[] {
  return available
    .filter((resource) => {
      const similarity = calculateSimilarity(target, resource);
      return similarity > 0.6;
    })
    .slice(0, 3);
}

/**
 * Check if a field is deprecated
 */
export function isDeprecatedField(_resource: Enhanced<unknown, unknown>, fieldPath: string): boolean {
  // This would check against a registry of deprecated fields
  const deprecatedFields = ['spec.serviceAccount', 'spec.securityContext.runAsUser'];
  return deprecatedFields.some((deprecated) => fieldPath.startsWith(deprecated));
}

/**
 * Get replacement for a deprecated field
 */
export function getFieldReplacement(
  _resource: Enhanced<unknown, unknown>,
  fieldPath: string
): string | undefined {
  // This would provide replacement suggestions for deprecated fields
  const replacements: Record<string, string> = {
    'spec.serviceAccount': 'spec.serviceAccountName',
    'spec.securityContext.runAsUser': 'spec.securityContext.runAsNonRoot',
  };

  return replacements[fieldPath];
}

/**
 * Check if accessing a field has performance implications
 */
export function hasPerformanceImplications(
  _resource: Enhanced<unknown, unknown>,
  fieldPath: string
): boolean {
  // This would identify fields that might have performance implications
  const performanceFields = ['status.conditions', 'status.events'];
  return performanceFields.some((field) => fieldPath.startsWith(field));
}

/**
 * Extract API version from a resource
 */
export function getResourceApiVersion(_resource: Enhanced<unknown, unknown>): string | undefined {
  // Extract API version from resource
  return 'v1'; // Placeholder
}

/**
 * Extract kind from a resource
 */
export function getResourceKind(resource: Enhanced<unknown, unknown>): string | undefined {
  // Extract kind from resource
  return resource.constructor.name;
}

/**
 * Get the result type from a reference chain
 */
export function getChainResultType(refs: KubernetesRef<unknown>[]): TypeInfo | undefined {
  // Get the type of the final reference in the chain
  if (refs.length === 0) return undefined;

  const lastRef = refs[refs.length - 1];
  return lastRef?._type
    ? { typeName: String(lastRef._type), optional: false, nullable: false }
    : undefined;
}

/**
 * Create default validation metadata
 */
export function createDefaultMetadata(): ResourceValidationMetadata {
  return {
    resourceType: 'unknown',
    fieldOptional: false,
    fieldNullable: false,
    dependencyDepth: 0,
    isStatusField: false,
    isSpecField: false,
    isMetadataField: false,
  };
}
