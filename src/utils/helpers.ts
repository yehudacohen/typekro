/**
 * General utility functions for TypeKro
 *
 * This module contains helper functions that are used across the codebase
 * for common operations like string manipulation, ID generation, and
 * data processing.
 */

import type { Type } from 'arktype';
import { ReadinessEvaluatorRegistry } from '../core/readiness/index.js';
import type { CelExpression, KubernetesRef } from '../core/types/common.js';
import type { Enhanced, KubernetesResource } from '../core/types/kubernetes.js';
import type { KroSimpleSchema, SerializationContext } from '../core/types/serialization.js';
import { isCelExpression, isKubernetesRef } from './type-guards.js';

/**
 * Convert a template string with ${...} placeholders to a CEL concatenation expression
 * 
 * Examples:
 * - "https://${schema.spec.hostname}" -> "https://" + schema.spec.hostname
 * - "prefix-${name}-suffix" -> "prefix-" + name + "-suffix"
 */
function convertTemplateToCelConcat(templateStr: string): string {
  // Split the template string into parts
  const parts: string[] = [];
  let currentPos = 0;
  
  // Find all ${...} expressions
  const regex = /\$\{([^}]+)\}/g;
  let match: RegExpExecArray | null = regex.exec(templateStr);
  
  while (match !== null) {
    // Add the literal string before the expression
    if (match.index > currentPos) {
      const literalPart = templateStr.slice(currentPos, match.index);
      if (literalPart) {
        parts.push(`"${literalPart}"`);
      }
    }
    
    // Add the CEL expression (without ${})
    parts.push(match[1] || '');
    currentPos = match.index + match[0].length;
    
    // Get next match
    match = regex.exec(templateStr);
  }
  
  // Add any remaining literal string
  if (currentPos < templateStr.length) {
    const literalPart = templateStr.slice(currentPos);
    if (literalPart) {
      parts.push(`"${literalPart}"`);
    }
  }
  
  // Join with + operator
  return parts.join(' + ');
}

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
        `simple.Deployment({ name: schema.spec.name, image: 'nginx', id: 'my-deployment' })`
    );
  }

  // Handle case where name is a CEL expression
  if (isCelExpression(name)) {
    // For CEL expressions, we can't generate a deterministic ID without evaluation
    // Throw an error suggesting the user provide an explicit ID
    throw new Error(
      `Cannot generate deterministic resource ID for ${kind} with CEL expression name. ` +
        `Please provide an explicit 'id' field in the resource config, e.g.: ` +
        `simple.Deployment({ name: Cel.expr('my-', schema.spec.name), image: 'nginx', id: 'my-deployment' })`
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
export function toCamelCase(str: string): string {
  // Return early for empty strings to avoid errors.
  if (!str) {
    return '';
  }

  return str
    .split(/[-_]/)
    .map((word, index) => {
      // If it's the first word, just lowercase the first letter and keep the rest.
      if (index === 0) {
        return word.charAt(0).toLowerCase() + word.slice(1);
      }
      // For all subsequent words, capitalize the first letter and lowercase the rest.
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
    // Check if this is a template expression (mixed string with embedded CEL)
    if ((obj as any).__isTemplate) {
      // Convert template expressions to proper CEL concatenation
      // Transform "https://${schema.spec.hostname}" to ${"https://" + schema.spec.hostname}
      const templateExpr = obj.expression;
      
      // Parse template string and convert to CEL concatenation
      const celExpression = convertTemplateToCelConcat(templateExpr);
      return `\${${celExpression}}`;
    }
    // Regular CEL expressions need to be wrapped with ${} for Kro
    return `\${${obj.expression}}`;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => processResourceReferences(item, context));
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};

    // Use Object.entries to get enumerable properties
    for (const [key, value] of Object.entries(obj)) {
      // Exclude the hidden resourceId property and id field from the final template
      if (key === '__resourceId' || key === 'id') continue;
      result[key] = processResourceReferences(value, context);
    }

    // Preserve the readinessEvaluator function if it exists (it's non-enumerable)
    const originalObj = obj as any;
    if (originalObj.readinessEvaluator && typeof originalObj.readinessEvaluator === 'function') {
      Object.defineProperty(result, 'readinessEvaluator', {
        value: originalObj.readinessEvaluator,
        enumerable: false,
        configurable: true,
        writable: false,
      });
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
    const enumValues = node.map((branch) => {
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
    if (isKubernetesRef(value)) {
      return `\${${value.resourceId}.${value.fieldPath}}`;
    }

    // Handle CelExpression objects
    if (isCelExpression(value)) {
      // Check if this is a template expression (mixed string with embedded CEL)
      if ((value as any).__isTemplate) {
        // Convert template expressions to proper CEL concatenation
        // Transform "https://${schema.spec.hostname}" to ${"https://" + schema.spec.hostname}
        const templateExpr = value.expression;
        
        // Parse template string and convert to CEL concatenation
        const celExpression = convertTemplateToCelConcat(templateExpr);
        return `\${${celExpression}}`;
      }
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
  if (isKubernetesRef(value)) {
    return true;
  }

  if (isCelExpression(value)) {
    // Check if the CEL expression contains resource references
    const expression = value.expression;
    const resourceRefPattern = /([a-zA-Z][a-zA-Z0-9]*)\.(status|spec|metadata)\./;
    return resourceRefPattern.test(expression);
  }

  if (value && typeof value === 'object' && !Array.isArray(value) && !isCelExpression(value)) {
    // Recursively check nested objects
    return Object.values(value).some(_requiresKroResolution);
  }

  return false;
}

/**
 * Convert kebab-case or snake_case to camelCase and ensure a readiness evaluator by using the appropriate factory function
 * This leverages existing factory functions that already have readiness evaluators defined
 */
export function ensureReadinessEvaluator<T extends Enhanced<any, any>>(resource: T): T {
  // First: Check if resource already has attached evaluator
  if (typeof resource.readinessEvaluator === 'function') {
    return resource;
  }

  // Second: Look up in registry by KIND
  const registry = ReadinessEvaluatorRegistry.getInstance();
  const evaluator = registry.getEvaluatorForKind(resource.kind);

  if (evaluator) {
    // Attach the registry evaluator to this resource instance
    Object.defineProperty(resource, 'readinessEvaluator', {
      value: evaluator,
      enumerable: false,
      configurable: true,
      writable: false,
    });
    return resource;
  }

  // Third: No evaluator found anywhere
  throw new Error(
    `No readiness evaluator found for ${resource.kind}/${resource.metadata?.name}. ` +
      `Use a factory function like deployment(), configMap(), etc., or call .withReadinessEvaluator().`
  );
}

/**
 * Recursively converts an Enhanced resource proxy into a plain JavaScript object.
 * This is a safe way to serialize the object for the Kubernetes client, preserving
 * all nested properties and stripping any remaining proxy logic.
 * @param obj The object to convert.
 * @param visited A set to track circular references.
 * @returns A plain JavaScript object.
 */
export function toPlainObject<T>(obj: T, visited = new Set<any>()): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (visited.has(obj)) {
    return obj; // Avoid circular loops
  }
  visited.add(obj);

  // Handle arrays by converting each item
  if (Array.isArray(obj)) {
    const plainArray = obj.map((item) => toPlainObject(item, visited)) as any;
    visited.delete(obj);
    return plainArray;
  }

  // Use getOwnPropertyNames and getOwnPropertySymbols to capture all keys,
  // including non-enumerable ones (like our brand symbols) if needed.
  const plainObj: Record<string | symbol, any> = {};
  const keys = Reflect.ownKeys(obj);

  for (const key of keys) {
    const value = (obj as any)[key];

    // Preserve readinessEvaluator function as-is
    if (key === 'readinessEvaluator') {
      plainObj[key] = value;
    }
    // Skip other functions like 'withReadinessEvaluator'
    else if (typeof value !== 'function') {
      plainObj[key] = toPlainObject(value, visited);
    }
  }

  visited.delete(obj);
  return plainObj as T;
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
      // Only dynamic status field mappings as CEL expressions
      // Static fields will be hydrated directly by TypeKro
      // Kro automatically injects default fields (phase, message, observedGeneration, conditions, state)
      ...statusCelExpressions,
    },
  };
}

// Function removed - status mappings are now user-defined via StatusBuilder

// Import type guards from the type-guards module (removed duplicate import)
import { separateStatusFields } from '../core/validation/cel-validator.js';
