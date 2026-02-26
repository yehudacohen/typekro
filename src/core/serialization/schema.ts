/**
 * Schema generation functionality for Kro ResourceGraphDefinitions
 *
 * This module converts Arktype schema definitions into Kro-compatible
 * simple schemas, and provides utility functions for generating schemas
 * from resource maps.
 */

import type { Type } from 'arktype';
import { pascalCase } from '../../utils/string.js';
import type { SchemaDefinition } from '../types/serialization.js';
import type { KroCompatibleType, KroSimpleSchema, KubernetesResource } from '../types.js';
import { separateStatusFields } from '../validation/cel-validator.js';
import { serializeStatusMappingsToCel } from './cel-references.js';

// ---------------------------------------------------------------------------
// Arktype JSON AST → Kro type helpers (private)
// ---------------------------------------------------------------------------

/**
 * Converts an Arktype JSON AST node into a Kro-compatible type string.
 *
 * Handles single-quoted literals, arrays, booleans, integer divisors,
 * and literal unions (→ Kro enum format).
 */
function getKroTypeFromJson(node: unknown): string {
  // Case 1: Object describing a type
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    const nodeObj = node as Record<string, unknown>;
    if (nodeObj.proto === 'Array' && nodeObj.sequence) {
      return `[]${getKroTypeFromJson(nodeObj.sequence)}`;
    }
    if (nodeObj.domain === 'number' && nodeObj.divisor === 1) {
      return 'integer';
    }
  }

  // Case 2: Array → union of literals
  if (Array.isArray(node)) {
    if (
      node.length === 2 &&
      node.some((branch) => branch.unit === true) &&
      node.some((branch) => branch.unit === false)
    ) {
      return 'boolean';
    }
    const enumValues = node.map((branch) => {
      if (typeof branch.unit === 'string') {
        return branch.unit;
      }
      return String(branch.unit);
    });
    return `string | enum="${enumValues.join(',')}"`;
  }

  // Case 3: Simple string primitive
  if (typeof node === 'string') {
    if (node.includes('%')) {
      const [domain] = node.split('%');
      if (domain === 'number') return 'integer';
    }
    switch (node) {
      case 'number':
        return 'integer';
      case 'string':
      case 'boolean':
        return node;
    }
  }

  return 'string';
}

/**
 * Recursively flatten an Arktype JSON AST into a flat `Record<camelCaseKey, kroType>`.
 */
function arktypeJsonToKroFields(node: unknown, prefix = ''): Record<string, string> {
  let fields: Record<string, string> = {};

  if (!node || typeof node !== 'object') {
    return fields;
  }

  const nodeObj = node as Record<string, unknown>;
  if (!nodeObj.required && !nodeObj.optional) {
    return fields;
  }

  const required = Array.isArray(nodeObj.required) ? nodeObj.required : [];
  const optional = Array.isArray(nodeObj.optional) ? nodeObj.optional : [];
  const props = [...required, ...optional];

  for (const prop of props) {
    const newKey = prefix
      ? `${prefix}${prop.key.charAt(0).toUpperCase() + prop.key.slice(1)}`
      : prop.key;

    const childNode = prop.value;

    if (
      typeof childNode === 'object' &&
      childNode !== null &&
      (childNode.required || childNode.optional)
    ) {
      const nestedFields = arktypeJsonToKroFields(childNode, newKey);
      fields = { ...fields, ...nestedFields };
    } else {
      fields[newKey] = getKroTypeFromJson(childNode);
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts an Arktype schema to a Kro-compatible schema definition.
 *
 * Status fields use user-defined mappings from the StatusBuilder function
 * instead of auto-generated CEL expressions.
 */
export function arktypeToKroSchema(
  name: string,
  schemaDefinition: {
    apiVersion: string;
    kind: string;
    spec: Type;
    status: Type;
  },
  _resources?: Record<string, KubernetesResource>,
  statusMappings?: Record<string, unknown>
): KroSimpleSchema {
  const specFields = arktypeJsonToKroFields(schemaDefinition.spec.json);

  if (!specFields.name) {
    specFields.name = `string | default="${name}"`;
  }

  // Separate static and dynamic status fields
  const { dynamicFields } = statusMappings
    ? separateStatusFields(statusMappings)
    : { dynamicFields: {} };

  // Only serialize dynamic fields that need Kro resolution
  const statusCelExpressions =
    Object.keys(dynamicFields).length > 0 ? serializeStatusMappingsToCel(dynamicFields) : {};

  // Extract just the version part for the schema (Kro expects v1alpha1, not kro.run/v1alpha1)
  const schemaApiVersion = schemaDefinition.apiVersion.includes('/')
    ? schemaDefinition.apiVersion.split('/')[1] || schemaDefinition.apiVersion
    : schemaDefinition.apiVersion;

  return {
    apiVersion: schemaApiVersion,
    kind: schemaDefinition.kind,
    spec: specFields,
    status: {
      ...statusCelExpressions,
    },
  };
}

/**
 * Generate Kro schema from resources (simple, without Arktype)
 */
export function generateKroSchema(
  name: string,
  _resources: Record<string, KubernetesResource>
): KroSimpleSchema {
  const pascalName = pascalCase(name);

  const spec: Record<string, string> = {
    name: `string | default="${name}"`,
  };

  return {
    apiVersion: `v1alpha1`,
    kind: pascalName,
    spec,
    status: {},
  };
}

/**
 * Generate Kro schema from Arktype definition
 */
export function generateKroSchemaFromArktype<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  name: string,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  resources?: Record<string, KubernetesResource>,
  statusMappings?: Record<string, unknown>
): KroSimpleSchema {
  return arktypeToKroSchema(name, schemaDefinition, resources, statusMappings);
}
