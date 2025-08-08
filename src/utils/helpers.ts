/**
 * General utility functions for TypeKro
 *
 * This module contains helper functions that are used across the codebase
 * for common operations like string manipulation, ID generation, and
 * data processing.
 */

import type { Type } from 'arktype';
import type {
  CelExpression,
  KroSimpleSchema,
  KubernetesRef,
  KubernetesResource,
  SerializationContext,
} from '../core/types.js';

/**
 * Generate deterministic resource ID based on resource metadata
 * This ensures stable IDs across multiple applications for GitOps workflows
 */
export function generateDeterministicResourceId(
  kind: string,
  name: string | KubernetesRef<unknown> | CelExpression<unknown>,
  _namespace?: string
): string {
  const cleanKind = kind.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');

  // Handle case where name is a KubernetesRef (schema reference)
  if (isKubernetesRef(name)) {
    // For schema references, we can't generate a deterministic ID without evaluation
    // Throw an error suggesting the user provide an explicit ID
    throw new Error(
      `Cannot generate deterministic resource ID for ${kind} with KubernetesRef name. ` +
        `Please provide an explicit 'id' field in the resource config, e.g.: ` +
        `simpleDeployment({ name: schema.spec.name, image: 'nginx', id: 'my-deployment' })`
    );
  }

  // Handle case where name is a CEL expression
  if (isCelExpression(name)) {
    // For CEL expressions, we can't generate a deterministic ID without evaluation
    // Throw an error suggesting the user provide an explicit ID
    throw new Error(
      `Cannot generate deterministic resource ID for ${kind} with CEL expression name. ` +
        `Please provide an explicit 'id' field in the resource config, e.g.: ` +
        `simpleDeployment({ name: Cel.expr('my-', schema.spec.name), image: 'nginx', id: 'my-deployment' })`
    );
  }

  // Handle normal string names - these are safe for deterministic ID generation
  const nameStr = name as string;

  // Check if the name contains template expressions (legacy string templates)
  if (nameStr.includes('${') || nameStr.includes('{{')) {
    throw new Error(
      `Cannot generate deterministic resource ID for ${kind} with template expression in name: "${nameStr}". ` +
        `Please either use static names or provide an explicit 'id' in the resource factory options.`
    );
  }

  // For static names, generate a clean, deterministic ID
  // If the name already contains the kind, just use the name
  if (nameStr.toLowerCase().includes(cleanKind)) {
    return toCamelCase(nameStr);
  }

  // Otherwise, prefix with kind for clarity
  return toCamelCase(`${cleanKind}-${nameStr}`);
}

/**
 * Converts a kebab-case or snake_case string to camelCase
 */
function toCamelCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((word, index) => {
      if (index === 0) {
        return word.toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * Generates a unique resource ID (legacy random version for development)
 */
export function generateResourceId(name?: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return name
    ? `${name.replace(/[^a-zA-Z0-9-]/g, '')}-${timestamp}-${random}`
    : `resource-${timestamp}-${random}`;
}

/**
 * Converts a string to PascalCase.
 */
export function pascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

/**
 * Generate CEL expression with configurable context.
 * This now uses the shared helper function from cel.ts.
 */
function generateCelExpression(
  ref: KubernetesRef<unknown>,
  _context?: SerializationContext
): string {
  // Use the single, authoritative function to get the correct path.
  const expression = getInnerCelPath(ref);
  return `\${${expression}}`;
}

/**
 * Generate inner CEL reference without ${} wrapper for building expressions
 */
export function generateCelReference(ref: KubernetesRef<unknown>): string {
  const resourceId = ref.resourceId === '__schema__' ? 'schema' : ref.resourceId;
  return `${resourceId}.${ref.fieldPath}`;
}

/**
 * Gets the inner CEL path for a KubernetesRef, handling special cases like schema refs.
 * This is the new, authoritative function.
 */
export function getInnerCelPath(ref: KubernetesRef<unknown>): string {
  const resourceId = ref.resourceId === '__schema__' ? 'schema' : ref.resourceId;
  return `${resourceId}.${ref.fieldPath}`;
}

/**
 * Recursively replaces all KubernetesRef objects with CEL expressions for Kro.
 * This is the ONLY function that should perform this transformation.
 */
export function processResourceReferences(obj: unknown, context?: SerializationContext): unknown {
  if (isKubernetesRef(obj)) {
    // Use configurable CEL expression format instead of hardcoded "resources."
    return generateCelExpression(obj, context);
  }

  if (isCelExpression(obj)) {
    // CEL expressions need to be wrapped with ${} for Kro
    return `\${${obj.expression}}`;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => processResourceReferences(item, context));
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    // We must use Object.entries to preserve the object structure.
    for (const [key, value] of Object.entries(obj)) {
      // Exclude the hidden resourceId property and id field from the final template
      if (key === '__resourceId' || key === 'id') continue;
      result[key] = processResourceReferences(value, context);
    }
    return result;
  }

  return obj;
}

/**
 * Converts an Arktype JSON AST node into a Kro-compatible type string.
 * This is the final version, corrected to handle single-quoted literals.
 * @param node The Arktype JSON AST node.
 * @returns A string representing the Kro type.
 */
function getKroTypeFromJson(node: unknown): string {
  // Case 1: The node is an object describing a type.
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    const nodeObj = node as Record<string, unknown>;
    if (nodeObj.proto === 'Array' && nodeObj.sequence) {
      return `[]${getKroTypeFromJson(nodeObj.sequence)}`;
    }
    if (nodeObj.domain === 'number' && nodeObj.divisor === 1) {
      return 'integer';
    }
  }

  // Case 2: The node is an array, representing a union of literals.
  if (Array.isArray(node)) {
    if (
      node.length === 2 &&
      node.some((branch) => branch.unit === true) &&
      node.some((branch) => branch.unit === false)
    ) {
      return 'boolean';
    }
    // Handle literal unions - use Kro Simple Schema enum format
    const enumValues = node
      .map((branch) => {
        if (typeof branch.unit === 'string') {
          return branch.unit;
        }
        return String(branch.unit);
      });
    
    // Return as Kro Simple Schema enum format: string | enum="value1,value2,value3"
    return `string | enum="${enumValues.join(',')}"`;
  }

  // Case 3: The node is a simple string representing a primitive type.
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

  // Fallback for safety.
  return 'string';
}

function arktypeJsonToKroFields(node: unknown, prefix = ''): Record<string, string> {
  let fields: Record<string, string> = {};

  // Handle case where node doesn't have required/optional structure
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
    // THIS IS THE CORRECTED LOGIC FOR CREATING THE KEY
    // It correctly joins camelCased keys like "connection" and "poolSize".
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

/**
 * Serialize user-defined status mappings to CEL expressions for Kro schema
 * Only processes dynamic fields that require Kro resolution
 */
function serializeStatusMappingsToCel(statusMappings: any): Record<string, string> {
  const celExpressions: Record<string, string> = {};
  
  function serializeValue(value: any): string {
    // Handle KubernetesRef objects (can be functions due to proxy)
    if (value && (typeof value === 'object' || typeof value === 'function') && value.__brand === 'KubernetesRef') {
      return `\${${value.resourceId}.${value.fieldPath}}`;
    }
    
    // Handle CelExpression objects
    if (value && typeof value === 'object' && value.__brand === 'CelExpression') {
      return `\${${value.expression}}`;
    }
    
    // Handle nested objects recursively
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nestedExpressions: Record<string, any> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        nestedExpressions[key] = serializeValue(nestedValue);
      }
      return nestedExpressions as any; // Return as any for nested objects
    }
    
    // Handle primitive values
    if (typeof value === 'string') {
      return `\${"${value}"}`;
    }
    if (typeof value === 'number') {
      return `\${${value}}`;
    }
    if (typeof value === 'boolean') {
      return `\${${value}}`;
    }
    
    // Fallback for unknown types
    return `\${""}`;
  }
  
  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    celExpressions[fieldName] = serializeValue(fieldValue);
  }
  
  return celExpressions;
}

/**
 * Determines if a status field value requires Kro resolution (contains Kubernetes references or CEL expressions)
 */
function _requiresKroResolution(value: any): boolean {
  if (value && (typeof value === 'object' || typeof value === 'function') && value.__brand === 'KubernetesRef') {
    return true;
  }
  
  if (value && typeof value === 'object' && value.__brand === 'CelExpression') {
    // Check if the CEL expression contains resource references
    const expression = value.expression;
    const resourceRefPattern = /([a-zA-Z][a-zA-Z0-9]*)\.(status|spec|metadata)\./;
    return resourceRefPattern.test(expression);
  }
  
  if (value && typeof value === 'object' && !Array.isArray(value) && value.__brand !== 'CelExpression') {
    // Recursively check nested objects
    return Object.values(value).some(_requiresKroResolution);
  }
  
  return false;
}



/**
 * Converts an Arktype schema to a Kro-compatible schema definition
 * 
 * IMPORTANT: Status fields in Kro now use user-defined mappings from the StatusBuilder function
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
  statusMappings?: any
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
  const statusCelExpressions = Object.keys(dynamicFields).length > 0
    ? serializeStatusMappingsToCel(dynamicFields)
    : {};

  // Extract just the version part for the schema (Kro expects v1alpha1, not kro.run/v1alpha1)
  const schemaApiVersion = schemaDefinition.apiVersion.includes('/') 
    ? schemaDefinition.apiVersion.split('/')[1] || schemaDefinition.apiVersion
    : schemaDefinition.apiVersion;

  return {
    apiVersion: schemaApiVersion,
    kind: schemaDefinition.kind,
    spec: specFields,
    status: {
      // Only dynamic status field mappings as CEL expressions
      // Static fields will be hydrated directly by TypeKro
      // Kro automatically injects default fields (phase, message, observedGeneration, conditions, state)
      ...statusCelExpressions,
    },
  };
}

// Function removed - status mappings are now user-defined via StatusBuilder

// Import type guards from the type-guards module
import { isCelExpression, isKubernetesRef } from './type-guards.js';
import { separateStatusFields } from '../core/validation/cel-validator.js';
