/**
 * Alchemy Type Inference
 *
 * This module provides type-safe inference functions that determine
 * alchemy resource types from TypeKro resources with proper validation.
 */

import type { Enhanced } from '../core/types/kubernetes.js';

/**
 * Reserved resource type names that cannot be used
 */
const RESERVED_RESOURCE_TYPE_NAMES = new Set([
  'Resource',
  'Provider',
  'Context',
  'State',
  'Config',
  'Alchemy',
  'TypeKro',
]);

/**
 * Validation rules for resource type names
 */
const RESOURCE_TYPE_VALIDATION = {
  maxLength: 100,
  allowedCharacters: /^[a-zA-Z][a-zA-Z0-9]*$/,
  reservedNames: RESERVED_RESOURCE_TYPE_NAMES,
};

/**
 * Validate resource type naming patterns
 */
function validateResourceTypeName(kind: string): void {
  if (!kind) {
    throw new Error('Resource kind is required for type inference');
  }

  if (kind.length > RESOURCE_TYPE_VALIDATION.maxLength) {
    throw new Error(
      `Resource kind '${kind}' exceeds maximum length of ${RESOURCE_TYPE_VALIDATION.maxLength} characters`
    );
  }

  if (!RESOURCE_TYPE_VALIDATION.allowedCharacters.test(kind)) {
    throw new Error(
      `Resource kind '${kind}' contains invalid characters. Only alphanumeric characters are allowed, starting with a letter.`
    );
  }

  if (RESOURCE_TYPE_VALIDATION.reservedNames.has(kind)) {
    throw new Error(`Resource kind '${kind}' is a reserved name and cannot be used`);
  }
}

/**
 * Type-safe inference function that determines alchemy type from TypeKro resource
 * Enhanced to handle individual Kubernetes resources with proper validation
 */
export function inferAlchemyTypeFromTypeKroResource<T extends Enhanced<any, any>>(
  resource: T
): string {
  // Validate that the resource has a kind
  if (!resource.kind) {
    throw new Error('Resource must have a kind field for Alchemy type inference');
  }

  // Validate the resource kind naming patterns
  validateResourceTypeName(resource.kind);

  // Handle Kro ResourceGraphDefinitions
  if (resource.apiVersion === 'kro.run/v1alpha1' && resource.kind === 'ResourceGraphDefinition') {
    return 'kro::ResourceGraphDefinition';
  }

  // Handle Kro custom resources
  if (resource.apiVersion?.includes('kro.run')) {
    return `kro::${resource.kind}`;
  }

  // Handle individual Kubernetes resources
  // This ensures proper naming like kubernetes::Deployment, kubernetes::Service, etc.
  return `kubernetes::${resource.kind}`;
}
