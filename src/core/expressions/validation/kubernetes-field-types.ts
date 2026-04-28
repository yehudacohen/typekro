/**
 * Kubernetes Field Type Knowledge Base
 *
 * This module provides type inference for Kubernetes resource fields
 * and schema fields. These functions are extracted from CelTypeInferenceEngine
 * as they operate purely on their parameters without needing engine state.
 */

import { getComponentLogger } from '../../logging/index.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import type { TypeInfo } from './type-safety.js';

/**
 * Infer the type of a field on a Kubernetes resource
 */
export function inferResourceFieldType(resource: Enhanced<unknown, unknown>, fieldPath: string): TypeInfo {
  try {
    const parts = fieldPath.split('.');

    // Handle common Kubernetes resource field patterns
    if (parts[0] === 'metadata') {
      return getMetadataFieldType(parts.slice(1));
    }

    if (parts[0] === 'spec') {
      return getSpecFieldType(resource, parts.slice(1));
    }

    if (parts[0] === 'status') {
      return getStatusFieldType(resource, parts.slice(1));
    }

    return { typeName: 'unknown', optional: true, nullable: false };
  } catch (error: unknown) {
    const logger = getComponentLogger('type-inference');
    logger.debug('Failed to infer resource field type, returning unknown', { err: error });
    return { typeName: 'unknown', optional: true, nullable: false };
  }
}

/**
 * Get the type of a metadata field
 */
export function getMetadataFieldType(fieldParts: string[]): TypeInfo {
  const fieldName = fieldParts[0];

  if (!fieldName) {
    return { typeName: 'unknown', optional: true, nullable: false };
  }

  // Common metadata fields
  const metadataTypes: Record<string, TypeInfo> = {
    name: { typeName: 'string', optional: false, nullable: false },
    namespace: { typeName: 'string', optional: true, nullable: false },
    labels: { typeName: 'Record<string, string>', optional: true, nullable: false },
    annotations: { typeName: 'Record<string, string>', optional: true, nullable: false },
    uid: { typeName: 'string', optional: true, nullable: false },
    resourceVersion: { typeName: 'string', optional: true, nullable: false },
    generation: { typeName: 'number', optional: true, nullable: false },
    creationTimestamp: { typeName: 'string', optional: true, nullable: false },
  };

  if (fieldName in metadataTypes) {
    const baseType = metadataTypes[fieldName];
    if (!baseType) {
      return { typeName: 'string', optional: true, nullable: false };
    }

    // Handle nested access (e.g., labels.app)
    if (fieldParts.length > 1) {
      if (baseType.typeName.startsWith('Record<')) {
        return { typeName: 'string', optional: true, nullable: false };
      }
    }

    return baseType;
  }

  return { typeName: 'string', optional: true, nullable: false };
}

/**
 * Get the type of a spec field based on resource kind
 */
export function getSpecFieldType(resource: Enhanced<unknown, unknown>, fieldParts: string[]): TypeInfo {
  const resourceKind = resource.constructor.name;
  const fieldName = fieldParts[0];

  if (!fieldName) {
    return { typeName: 'unknown', optional: true, nullable: false };
  }

  // Common spec fields by resource type
  const specFieldTypes: Record<string, Record<string, TypeInfo>> = {
    Deployment: {
      replicas: { typeName: 'number', optional: true, nullable: false },
      selector: { typeName: 'object', optional: false, nullable: false },
      template: { typeName: 'object', optional: false, nullable: false },
      strategy: { typeName: 'object', optional: true, nullable: false },
    },
    Service: {
      type: { typeName: 'string', optional: true, nullable: false },
      ports: { typeName: 'array', optional: false, nullable: false },
      selector: { typeName: 'Record<string, string>', optional: true, nullable: false },
      clusterIP: { typeName: 'string', optional: true, nullable: false },
    },
    ConfigMap: {
      data: { typeName: 'Record<string, string>', optional: true, nullable: false },
      binaryData: { typeName: 'Record<string, string>', optional: true, nullable: false },
    },
  };

  const resourceFields = specFieldTypes[resourceKind];
  if (resourceFields && fieldName in resourceFields) {
    const baseType = resourceFields[fieldName];

    // Handle nested access
    if (fieldParts.length > 1 && baseType) {
      if (baseType.typeName.startsWith('Record<')) {
        return { typeName: 'string', optional: true, nullable: false };
      }
      if (baseType.typeName === 'array') {
        return { typeName: 'object', optional: true, nullable: false };
      }
      if (baseType.typeName === 'object') {
        return { typeName: 'unknown', optional: true, nullable: false };
      }
    }

    return baseType || { typeName: 'unknown', optional: true, nullable: false };
  }

  return { typeName: 'unknown', optional: true, nullable: false };
}

/**
 * Get the type of a status field based on resource kind
 */
export function getStatusFieldType(resource: Enhanced<unknown, unknown>, fieldParts: string[]): TypeInfo {
  const resourceKind = resource.constructor.name;
  const fieldName = fieldParts[0];

  if (!fieldName) {
    return { typeName: 'unknown', optional: true, nullable: false };
  }

  // Common status fields by resource type
  const statusFieldTypes: Record<string, Record<string, TypeInfo>> = {
    Deployment: {
      replicas: { typeName: 'number', optional: true, nullable: false },
      readyReplicas: { typeName: 'number', optional: true, nullable: false },
      availableReplicas: { typeName: 'number', optional: true, nullable: false },
      unavailableReplicas: { typeName: 'number', optional: true, nullable: false },
      updatedReplicas: { typeName: 'number', optional: true, nullable: false },
      conditions: { typeName: 'array', optional: true, nullable: false },
      observedGeneration: { typeName: 'number', optional: true, nullable: false },
    },
    Service: {
      loadBalancer: { typeName: 'object', optional: true, nullable: false },
      conditions: { typeName: 'array', optional: true, nullable: false },
    },
    Pod: {
      phase: { typeName: 'string', optional: true, nullable: false },
      conditions: { typeName: 'array', optional: true, nullable: false },
      hostIP: { typeName: 'string', optional: true, nullable: false },
      podIP: { typeName: 'string', optional: true, nullable: false },
      startTime: { typeName: 'string', optional: true, nullable: false },
      containerStatuses: { typeName: 'array', optional: true, nullable: false },
    },
  };

  const resourceFields = statusFieldTypes[resourceKind];
  if (resourceFields && fieldName in resourceFields) {
    const baseType = resourceFields[fieldName];

    // Handle nested access
    if (fieldParts.length > 1 && baseType) {
      if (baseType.typeName === 'object') {
        // Handle specific nested objects
        if (fieldName === 'loadBalancer' && fieldParts[1] === 'ingress') {
          return { typeName: 'array', optional: true, nullable: false };
        }
        return { typeName: 'unknown', optional: true, nullable: false };
      }
      if (baseType.typeName === 'array') {
        // Array access like conditions[0] or length
        if (fieldParts[1] === 'length') {
          return { typeName: 'number', optional: false, nullable: false };
        }
        return { typeName: 'object', optional: true, nullable: false };
      }
    }

    return baseType || { typeName: 'unknown', optional: true, nullable: true };
  }

  // Status fields are generally optional and may be null during resource creation
  return { typeName: 'unknown', optional: true, nullable: true };
}

/**
 * Infer the type of a schema field from the schema proxy
 */
export function inferSchemaFieldType(
  schemaProxy: SchemaProxy<Record<string, unknown>, Record<string, unknown>> | undefined,
  fieldPath: string
): TypeInfo {
  if (!schemaProxy) {
    return { typeName: 'unknown', optional: false, nullable: false };
  }

  try {
    // Extract the field from the schema proxy
    const parts = fieldPath.split('.');
    let current: unknown = schemaProxy;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return { typeName: 'unknown', optional: true, nullable: false };
      }
    }

    // Infer type from the schema field
    if (current !== undefined) {
      return inferTypeFromValue(current);
    }

    return { typeName: 'unknown', optional: true, nullable: false };
  } catch (error: unknown) {
    const logger = getComponentLogger('type-inference');
    logger.debug('Failed to infer schema field type, returning unknown', { err: error });
    return { typeName: 'unknown', optional: true, nullable: false };
  }
}

/**
 * Infer type information from a runtime value
 */
export function inferTypeFromValue(value: unknown): TypeInfo {
  if (value === null) {
    return { typeName: 'null', optional: false, nullable: true };
  }

  if (value === undefined) {
    return { typeName: 'undefined', optional: true, nullable: false };
  }

  const type = typeof value;

  switch (type) {
    case 'string':
      return { typeName: 'string', optional: false, nullable: false };
    case 'number':
      return { typeName: 'number', optional: false, nullable: false };
    case 'boolean':
      return { typeName: 'boolean', optional: false, nullable: false };
    case 'object':
      if (Array.isArray(value)) {
        return { typeName: 'array', optional: false, nullable: false };
      }
      return { typeName: 'object', optional: false, nullable: false };
    default:
      return { typeName: 'unknown', optional: false, nullable: false };
  }
}
