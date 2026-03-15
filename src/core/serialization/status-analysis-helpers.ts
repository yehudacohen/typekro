/**
 * Shared helpers for status analysis
 *
 * These functions are used by both `core.ts` and `status-analysis-pipeline.ts`.
 * Extracted to break the circular dependency between those two modules.
 *
 * Functions:
 * - detectAndPreserveCelExpressions — detect existing CEL in status mappings
 * - mergePreservedCelExpressions — merge preserved CEL with analyzed mappings
 * - analyzeStatusMappingTypes — categorize status fields by type
 * - analyzeValueType — classify a single value
 * - isLikelyStaticObject — heuristic for static data detection
 */

import { containsKubernetesRefs, isCelExpression } from '../../utils/type-guards.js';

// =============================================================================
// detectAndPreserveCelExpressions
// =============================================================================

/**
 * Detect and preserve existing CEL expressions for backward compatibility
 *
 * This function recursively checks status mappings for existing CEL expressions
 * and preserves them without conversion, ensuring backward compatibility.
 */
export function detectAndPreserveCelExpressions(
  statusMappings: Record<string, unknown>,
  preservedExpressions: Record<string, unknown> = {},
  path: string = ''
): { hasExistingCel: boolean; preservedMappings: Record<string, unknown> } {
  let hasExistingCel = false;
  const preservedMappings = { ...preservedExpressions };

  if (!statusMappings || typeof statusMappings !== 'object') {
    return { hasExistingCel, preservedMappings };
  }

  for (const [key, value] of Object.entries(statusMappings)) {
    const currentPath = path ? `${path}.${key}` : key;

    if (isCelExpression(value)) {
      // Found existing CEL expression - preserve it
      hasExistingCel = true;
      preservedMappings[currentPath] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively check nested objects
      const nestedResult = detectAndPreserveCelExpressions(
        value as Record<string, unknown>,
        preservedMappings,
        currentPath
      );
      hasExistingCel = hasExistingCel || nestedResult.hasExistingCel;
      Object.assign(preservedMappings, nestedResult.preservedMappings);
    }
  }

  return { hasExistingCel, preservedMappings };
}

// =============================================================================
// mergePreservedCelExpressions
// =============================================================================

/**
 * Merge preserved CEL expressions with analyzed mappings
 *
 * This ensures that existing CEL expressions take precedence over
 * newly analyzed JavaScript expressions for backward compatibility.
 */
export function mergePreservedCelExpressions(
  analyzedMappings: Record<string, unknown>,
  preservedMappings: Record<string, unknown>
): Record<string, unknown> {
  const mergedMappings = { ...analyzedMappings };

  // Preserved CEL expressions take precedence
  for (const [path, celExpression] of Object.entries(preservedMappings)) {
    // Handle nested paths by setting the value at the correct location
    const pathParts = path.split('.');
    let current: Record<string, unknown> = mergedMappings;

    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!part) continue;

      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    const finalKey = pathParts[pathParts.length - 1];
    if (finalKey) {
      current[finalKey] = celExpression;
    }
  }

  return mergedMappings;
}

// =============================================================================
// analyzeStatusMappingTypes
// =============================================================================

/**
 * Result type for field analysis detail
 */
export interface FieldAnalysisDetail {
  type: 'kubernetesRef' | 'celExpression' | 'staticValue' | 'complexExpression';
  value: unknown;
  requiresConversion: boolean;
  confidence: number;
}

/**
 * Result type for status mapping analysis
 */
export interface StatusMappingAnalysis {
  kubernetesRefFields: string[];
  celExpressionFields: string[];
  staticValueFields: string[];
  complexExpressionFields: string[];
  analysisDetails: Record<string, FieldAnalysisDetail>;
}

/**
 * Comprehensive analysis of status mappings to categorize different types of expressions
 *
 * This function provides detailed analysis of status mappings to determine:
 * - Which fields contain KubernetesRef objects (need conversion)
 * - Which fields are existing CEL expressions (preserve as-is)
 * - Which fields are static values (no conversion needed)
 * - Which fields are complex expressions that might need analysis
 */
export function analyzeStatusMappingTypes(
  statusMappings: Record<string, unknown>,
  path: string = ''
): StatusMappingAnalysis {
  const kubernetesRefFields: string[] = [];
  const celExpressionFields: string[] = [];
  const staticValueFields: string[] = [];
  const complexExpressionFields: string[] = [];
  const analysisDetails: Record<string, FieldAnalysisDetail> = {};

  if (!statusMappings || typeof statusMappings !== 'object') {
    return {
      kubernetesRefFields,
      celExpressionFields,
      staticValueFields,
      complexExpressionFields,
      analysisDetails,
    };
  }

  for (const [key, value] of Object.entries(statusMappings)) {
    const currentPath = path ? `${path}.${key}` : key;

    // Analyze the value type and requirements
    const analysis = analyzeValueType(value);
    analysisDetails[currentPath] = analysis;

    switch (analysis.type) {
      case 'kubernetesRef':
        kubernetesRefFields.push(currentPath);
        break;
      case 'celExpression':
        celExpressionFields.push(currentPath);
        break;
      case 'staticValue':
        staticValueFields.push(currentPath);
        break;
      case 'complexExpression':
        complexExpressionFields.push(currentPath);
        break;
    }

    // Recursively analyze nested objects
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !isCelExpression(value) &&
      !containsKubernetesRefs(value)
    ) {
      const nestedAnalysis = analyzeStatusMappingTypes(
        value as Record<string, unknown>,
        currentPath
      );
      kubernetesRefFields.push(...nestedAnalysis.kubernetesRefFields);
      celExpressionFields.push(...nestedAnalysis.celExpressionFields);
      staticValueFields.push(...nestedAnalysis.staticValueFields);
      complexExpressionFields.push(...nestedAnalysis.complexExpressionFields);
      Object.assign(analysisDetails, nestedAnalysis.analysisDetails);
    }
  }

  return {
    kubernetesRefFields,
    celExpressionFields,
    staticValueFields,
    complexExpressionFields,
    analysisDetails,
  };
}

// =============================================================================
// analyzeValueType
// =============================================================================

/**
 * Analyze a single value to determine its type and conversion requirements
 */
export function analyzeValueType(value: unknown): FieldAnalysisDetail {
  // Check for existing CEL expressions first (highest priority)
  if (isCelExpression(value)) {
    return {
      type: 'celExpression',
      value,
      requiresConversion: false,
      confidence: 1.0,
    };
  }

  // Check for KubernetesRef objects (need conversion)
  if (containsKubernetesRefs(value)) {
    return {
      type: 'kubernetesRef',
      value,
      requiresConversion: true,
      confidence: 1.0,
    };
  }

  // Check for primitive static values
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return {
      type: 'staticValue',
      value,
      requiresConversion: false,
      confidence: 1.0,
    };
  }

  // Check for arrays of static values
  if (Array.isArray(value)) {
    const hasKubernetesRefs = value.some((item) => containsKubernetesRefs(item));
    const hasCelExpressions = value.some((item) => isCelExpression(item));

    if (hasKubernetesRefs) {
      return {
        type: 'kubernetesRef',
        value,
        requiresConversion: true,
        confidence: 0.9,
      };
    } else if (hasCelExpressions) {
      return {
        type: 'celExpression',
        value,
        requiresConversion: false,
        confidence: 0.9,
      };
    } else {
      return {
        type: 'staticValue',
        value,
        requiresConversion: false,
        confidence: 0.8,
      };
    }
  }

  // Check for plain objects (might be complex expressions or static data)
  if (value && typeof value === 'object') {
    const hasKubernetesRefs = containsKubernetesRefs(value);
    const hasCelExpressions = Object.values(value).some((v) => isCelExpression(v));

    if (hasKubernetesRefs) {
      return {
        type: 'kubernetesRef',
        value,
        requiresConversion: true,
        confidence: 0.8,
      };
    } else if (hasCelExpressions) {
      return {
        type: 'celExpression',
        value,
        requiresConversion: false,
        confidence: 0.8,
      };
    } else {
      // Could be static data or complex expression - analyze further
      const isStatic = isLikelyStaticObject(value);
      if (isStatic) {
        return {
          type: 'staticValue',
          value,
          requiresConversion: false,
          confidence: 0.7,
        };
      } else {
        return {
          type: 'complexExpression',
          value,
          requiresConversion: false, // Conservative - don't convert unless we're sure
          confidence: 0.5,
        };
      }
    }
  }

  // Unknown type - treat as complex expression
  return {
    type: 'complexExpression',
    value,
    requiresConversion: false,
    confidence: 0.3,
  };
}

// =============================================================================
// isLikelyStaticObject
// =============================================================================

/**
 * Determine if an object is likely to be static data rather than an expression
 */
export function isLikelyStaticObject(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }

  // Check if all values are primitive types
  const values = Object.values(obj);
  const allPrimitive = values.every(
    (value) =>
      value === null ||
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
  );

  if (allPrimitive) {
    return true;
  }

  // Check for common static object patterns
  const keys = Object.keys(obj);
  const hasCommonStaticKeys = keys.some((key) =>
    ['name', 'id', 'type', 'kind', 'version', 'label', 'tag'].includes(key.toLowerCase())
  );

  return hasCommonStaticKeys && values.length <= 10; // Reasonable size for static config
}
