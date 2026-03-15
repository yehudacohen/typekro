/**
 * Scope Resolver — Dependency extraction and resource reference resolution
 *
 * Extracted from analyzer.ts. Contains all methods that extract KubernetesRef
 * dependencies from expression strings, resolve resource/schema references,
 * and generate CEL field paths from KubernetesRef objects.
 */

import { escapeRegExp } from '../../../utils/helpers.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../constants/brands.js';
import { ConversionError, ensureError } from '../../errors.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import { inferTypeFromFieldPath as inferTypeFromFieldPathFn } from './operator-utils.js';
import { ParserError, parseExpression } from './parser.js';
import type { AnalysisContext, CelConversionResult } from './shared-types.js';
import type { SourceMapEntry } from './source-map.js';

// Re-export isResourceReference from cel-emitter for convenience
export { isResourceReference } from './cel-emitter.js';

// ── Generate CEL from KubernetesRef ──────────────────────────────────

/**
 * Generate CEL expression from KubernetesRef based on context.
 * Handles the core KubernetesRef to CEL field path conversion (resourceId.fieldPath).
 */
export function generateCelFromKubernetesRef(
  ref: KubernetesRef<unknown>,
  context: AnalysisContext
): string {
  // Validate the KubernetesRef
  if (!ref.resourceId || !ref.fieldPath) {
    throw new ConversionError(
      'Invalid KubernetesRef: missing resourceId or fieldPath',
      `${ref.resourceId || ''}.${ref.fieldPath || ''}`,
      'member-access'
    );
  }

  // Generate appropriate CEL expression based on factory type and resource type
  if (context.factoryType === 'kro') {
    // For Kro factory, generate CEL expressions for runtime evaluation by Kro controller
    if (ref.resourceId === '__schema__') {
      return `schema.${ref.fieldPath}`;
    }
    return `resources.${ref.resourceId}.${ref.fieldPath}`;
  }

  // For direct factory, generate CEL expressions that will be resolved at deployment time
  if (ref.resourceId === '__schema__') {
    return `schema.${ref.fieldPath}`;
  }
  return `resources.${ref.resourceId}.${ref.fieldPath}`;
}

// ── Convert KubernetesRef to CEL ─────────────────────────────────────

/**
 * Convert a KubernetesRef directly to a CEL expression.
 * This is the main method for KubernetesRef to CEL field path conversion.
 */
export function convertKubernetesRefToCel(
  ref: KubernetesRef<unknown>,
  context: AnalysisContext,
  typeValidator?: {
    validateKubernetesRef: (
      ref: KubernetesRef<unknown>,
      availableReferences: Record<string, Enhanced<unknown, unknown>>,
      schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>
    ) => { valid: boolean; errors: { message: string }[] };
  }
): CelExpression {
  try {
    // Validate KubernetesRef types if type checking is enabled
    if (context.strictTypeChecking !== false && context.typeRegistry && typeValidator) {
      const validation = typeValidator.validateKubernetesRef(
        ref,
        context.availableReferences,
        context.schemaProxy
      );

      if (!validation.valid) {
        throw new ConversionError(
          `KubernetesRef type validation failed: ${validation.errors.map((e) => e.message).join(', ')}`,
          `${ref.resourceId}.${ref.fieldPath}`,
          'member-access'
        );
      }
    }

    const expression = generateCelFromKubernetesRef(ref, context);

    // Track this KubernetesRef as a dependency
    if (context.dependencies) {
      context.dependencies.push(ref);
    }

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: ref._type,
    } as CelExpression;
  } catch (error: unknown) {
    throw new ConversionError(
      `Failed to convert KubernetesRef to CEL: ${ensureError(error).message}`,
      `${ref.resourceId}.${ref.fieldPath}`,
      'member-access'
    );
  }
}

// ── Extract resource references from expression string ───────────────

/**
 * Extract resource reference strings from an expression.
 * Returns array of strings like "deployment.status.readyReplicas".
 */
export function extractResourceReferencesFromExpression(expression: string): string[] {
  const refs: string[] = [];

  // Look for patterns like deployment.status.readyReplicas or service?.status?.loadBalancer
  const resourcePattern =
    /([a-zA-Z_][a-zA-Z0-9_]*)\??\.([a-zA-Z_][a-zA-Z0-9_]*(?:\??\.?[a-zA-Z_][a-zA-Z0-9_]*)*)/g;
  let match: RegExpExecArray | null = resourcePattern.exec(expression);

  while (match !== null) {
    refs.push(match[0].replace(/\?/g, '')); // Remove optional chaining operators for reference tracking
    match = resourcePattern.exec(expression);
  }

  return refs;
}

// ── Extract dependencies from expression string (returns array) ──────

/**
 * Extract dependencies from JavaScript expression string and return them.
 * Looks for resource references and schema references in the expression text.
 */
export function extractDependenciesFromExpressionString(
  expression: string,
  context: AnalysisContext
): KubernetesRef<unknown>[] {
  const dependencies: KubernetesRef<unknown>[] = [];

  // Look for direct resource references (deployment.status.field)
  if (context.availableReferences) {
    for (const [resourceKey, _resource] of Object.entries(context.availableReferences)) {
      const resourcePattern = new RegExp(
        `\\b${escapeRegExp(resourceKey)}\\.([a-zA-Z0-9_.?\\[\\]]+)`,
        'g'
      );
      const matches = expression.match(resourcePattern);
      if (matches) {
        for (const match of matches) {
          const fieldPath = match
            .substring(resourceKey.length + 1)
            .replace(/\?\./g, '.') // Remove optional chaining
            .replace(/\?\[/g, '['); // Remove optional array access

          const ref: KubernetesRef<unknown> = {
            [KUBERNETES_REF_BRAND]: true,
            resourceId: resourceKey,
            fieldPath,
            _type: 'unknown',
          };

          // Only add if not already present
          if (
            !dependencies.some(
              (dep) => dep.resourceId === resourceKey && dep.fieldPath === fieldPath
            )
          ) {
            dependencies.push(ref);
          }
        }
      }
    }
  }

  // Look for schema references (schema.spec.field)
  const schemaPattern = /\bschema\.[a-zA-Z0-9_.?[\]?]+/g;
  const schemaMatches = expression.match(schemaPattern);
  if (schemaMatches) {
    for (const match of schemaMatches) {
      const fieldPath = match
        .replace('schema.', '')
        .replace(/\?\./g, '.') // Remove optional chaining
        .replace(/\?\[/g, '['); // Remove optional array access

      const ref: KubernetesRef<unknown> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '__schema__',
        fieldPath,
        _type: inferTypeFromFieldPathFn(fieldPath),
      };

      // Only add if not already present
      if (
        !dependencies.some((dep) => dep.resourceId === '__schema__' && dep.fieldPath === fieldPath)
      ) {
        dependencies.push(ref);
      }
    }
  }

  return dependencies;
}

// ── Extract dependencies from expression (mutates context) ───────────

/**
 * Extract dependencies from JavaScript expression and add them to context.dependencies.
 * This is the mutation-based variant used by the special case handlers.
 */
export function extractDependenciesFromExpression(
  expression: string,
  context: AnalysisContext
): void {
  if (!context.dependencies) {
    context.dependencies = [];
  }

  // Look for resource references (resources.name.field)
  const resourceMatches = expression.match(/resources\.(\w+)\.([a-zA-Z0-9_.]+)/g);
  if (resourceMatches) {
    for (const match of resourceMatches) {
      const parts = match.split('.');
      const resourceId = parts[1];
      if (parts.length >= 3 && resourceId) {
        const fieldPath = parts.slice(2).join('.');

        const ref: KubernetesRef<unknown> = {
          [KUBERNETES_REF_BRAND]: true,
          resourceId,
          fieldPath,
          _type: 'unknown',
        };

        // Only add if not already present
        if (
          !context.dependencies.some(
            (dep) => dep.resourceId === resourceId && dep.fieldPath === fieldPath
          )
        ) {
          context.dependencies.push(ref);
        }
      }
    }
  }

  // Look for schema references (schema.spec.field)
  const schemaMatches = expression.match(/schema\.([a-zA-Z0-9_.]+)/g);
  if (schemaMatches) {
    for (const match of schemaMatches) {
      const fieldPath = match.replace('schema.', '');

      const ref: KubernetesRef<unknown> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '__schema__',
        fieldPath,
        _type: 'unknown',
      };

      // Only add if not already present
      if (
        !context.dependencies.some(
          (dep) => dep.resourceId === '__schema__' && dep.fieldPath === fieldPath
        )
      ) {
        context.dependencies.push(ref);
      }
    }
  }

  // Look for direct resource references with various patterns
  const directResourcePatterns = [
    // Standard dot notation: deployment.status.readyReplicas
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\.([a-zA-Z0-9_.[\]]+)/g,
    // Computed property access: deployment.status["readyReplicas"]
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\["([^"]+)"\]/g,
    // Computed property access with single quotes: deployment.status['readyReplicas']
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\['([^']+)'\]/g,
    // Optional chaining: deployment.status?.readyReplicas
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\?\?\.([a-zA-Z0-9_.[\]?]+)/g,
    // Mixed patterns: deployment.status.conditions[0].type
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\.([a-zA-Z0-9_.[\]?]+)/g,
  ];

  for (const pattern of directResourcePatterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0; // Reset regex state

    match = pattern.exec(expression);
    while (match !== null) {
      const fullMatch = match[0];
      const resourceId = match[1];
      const baseField = match[2]; // status, spec, or metadata
      const remainingPath = match[3];

      if (!resourceId || !baseField) {
        match = pattern.exec(expression);
        continue;
      }

      let fieldPath = baseField;

      // Handle different patterns
      if (remainingPath) {
        // For computed property access patterns, the remainingPath is the property name
        if (pattern.source.includes('\\["') || pattern.source.includes("\\'")) {
          fieldPath = `${baseField}.${remainingPath}`;
        } else {
          fieldPath = `${baseField}.${remainingPath}`;
        }
      } else {
        // For computed property access, we need to extract the property name differently
        const computedMatch =
          fullMatch.match(/\.(status|spec|metadata)\["([^"]+)"\]/) ||
          fullMatch.match(/\.(status|spec|metadata)\['([^']+)'\]/);
        if (computedMatch) {
          fieldPath = `${computedMatch[1]}.${computedMatch[2]}`;
        }
      }

      // Clean up field path
      fieldPath = fieldPath?.replace(/\?\?/g, '').replace(/\?/g, '') || '';
      fieldPath = fieldPath.replace(/\["([^"]+)"\]/g, '.$1');
      fieldPath = fieldPath.replace(/\['([^']+)'\]/g, '.$1');
      fieldPath = fieldPath.replace(/\[(\d+)\]/g, '[$1]'); // Keep array indices

      // Check if this resource exists in available references or add it anyway
      const shouldAdd =
        !context.availableReferences ||
        (resourceId ? context.availableReferences[resourceId] : null) ||
        true; // Add all for now, let validation handle it later

      if (shouldAdd) {
        const ref: KubernetesRef<unknown> = {
          [KUBERNETES_REF_BRAND]: true,
          resourceId,
          fieldPath,
          _type: 'unknown',
        };

        // Only add if not already present
        if (
          !context.dependencies.some(
            (dep) => dep.resourceId === resourceId && dep.fieldPath === fieldPath
          )
        ) {
          context.dependencies.push(ref);
        }
      }

      // Get next match
      match = pattern.exec(expression);
    }
  }

  // Look for template literal interpolations
  const templateLiteralMatches = expression.match(/\$\{([^}]+)\}/g);
  if (templateLiteralMatches) {
    for (const match of templateLiteralMatches) {
      const innerExpression = match.slice(2, -1); // Remove ${ and }
      // Recursively extract dependencies from the inner expression
      extractDependenciesFromExpression(innerExpression, context);
    }
  }
}

// ── Special case expression handlers ─────────────────────────────────

/**
 * Handle optional chaining expressions.
 */
export function handleOptionalChainingExpression(
  expression: string,
  context: AnalysisContext
): CelConversionResult {
  try {
    // Validate that the expression is syntactically valid JavaScript
    try {
      parseExpression(expression);
    } catch (syntaxError: unknown) {
      const errorMessage =
        syntaxError instanceof ParserError
          ? syntaxError.message
          : syntaxError instanceof Error
            ? syntaxError.message
            : String(syntaxError);
      throw new ConversionError(
        `Invalid JavaScript syntax in optional chaining expression: ${errorMessage}`,
        expression,
        'optional-chaining'
      );
    }

    // Convert optional chaining to CEL-compatible syntax
    const celExpression: CelExpression = {
      [CEL_EXPRESSION_BRAND]: true,
      expression: expression, // Keep the ?. syntax as CEL supports it
      _type: undefined,
    };

    const sourceLocation = { line: 1, column: 1, length: expression.length };
    const sourceMapEntries: SourceMapEntry[] = [];

    // Extract dependencies from the optional chaining expression
    const dependencies = extractDependenciesFromExpressionString(expression, context);

    if (context.sourceMap) {
      context.sourceMap.addMapping(expression, expression, sourceLocation, context.type, {
        expressionType: 'optional-chaining',
        kubernetesRefs: extractResourceReferencesFromExpression(expression),
        dependencies: dependencies.map((dep) => `${dep.resourceId}.${dep.fieldPath}`),
        conversionNotes: ['Optional chaining expression'],
      });
      sourceMapEntries.push(...context.sourceMap.getEntries());
    }

    return {
      valid: true,
      celExpression,
      dependencies,
      sourceMap: sourceMapEntries,
      errors: [],
      warnings: [],
      requiresConversion: true,
    };
  } catch (error: unknown) {
    return {
      valid: false,
      celExpression: null,
      dependencies: [],
      sourceMap: [],
      errors: [
        new ConversionError(
          `Failed to handle optional chaining: ${ensureError(error).message}`,
          expression,
          'optional-chaining'
        ),
      ],
      warnings: [],
      requiresConversion: true,
    };
  }
}

/**
 * Handle expressions with both optional chaining and nullish coalescing.
 */
export function handleMixedOptionalAndNullishExpression(
  expression: string,
  context: AnalysisContext
): CelConversionResult {
  try {
    // Split by nullish coalescing operator
    const parts = expression.split('??').map((part) => part.trim());

    if (parts.length < 2) {
      throw new ConversionError('Invalid mixed expression', expression, 'nullish-coalescing');
    }

    // Build nested conditional expression from right to left
    let celExpressionStr = parts[parts.length - 1] || ''; // Start with the last part (fallback)

    for (let i = parts.length - 2; i >= 0; i--) {
      const part = parts[i];
      celExpressionStr = `${part} != null ? ${part} : ${celExpressionStr}`;
    }

    const result: CelExpression = {
      [CEL_EXPRESSION_BRAND]: true,
      expression: celExpressionStr,
      _type: undefined,
    };

    // Extract dependencies from the mixed expression
    const dependencies = extractDependenciesFromExpressionString(expression, context);

    const sourceLocation = { line: 1, column: 1, length: expression.length };
    const sourceMapEntries: SourceMapEntry[] = [];

    if (context.sourceMap) {
      context.sourceMap.addMapping(expression, result.expression, sourceLocation, context.type, {
        expressionType: 'optional-chaining',
        kubernetesRefs: extractResourceReferencesFromExpression(expression),
        dependencies: dependencies.map((dep) => `${dep.resourceId}.${dep.fieldPath}`),
        conversionNotes: [
          'Mixed optional chaining and nullish coalescing converted to nested conditionals',
        ],
      });
      sourceMapEntries.push(...context.sourceMap.getEntries());
    }

    return {
      valid: true,
      celExpression: result,
      dependencies,
      sourceMap: sourceMapEntries,
      errors: [],
      warnings: [],
      requiresConversion: true,
    };
  } catch (error: unknown) {
    return {
      valid: false,
      celExpression: null,
      dependencies: [],
      sourceMap: [],
      errors: [
        new ConversionError(
          `Failed to handle mixed optional chaining and nullish coalescing: ${ensureError(error).message}`,
          expression,
          'optional-chaining'
        ),
      ],
      warnings: [],
      requiresConversion: true,
    };
  }
}

/**
 * Handle nullish coalescing expressions.
 */
export function handleNullishCoalescingExpression(
  expression: string,
  context: AnalysisContext
): CelConversionResult {
  try {
    // Convert nullish coalescing to CEL-compatible syntax
    const parts = expression.split('??').map((part) => part.trim());
    if (parts.length !== 2) {
      throw new ConversionError(
        'Invalid nullish coalescing expression',
        expression,
        'nullish-coalescing'
      );
    }

    const [left, right] = parts;
    const celExpression: CelExpression = {
      [CEL_EXPRESSION_BRAND]: true,
      expression: `${left} != null ? ${left} : ${right}`,
      _type: undefined,
    };

    const sourceLocation = { line: 1, column: 1, length: expression.length };
    const sourceMapEntries: SourceMapEntry[] = [];

    if (context.sourceMap) {
      context.sourceMap.addMapping(
        expression,
        celExpression.expression,
        sourceLocation,
        context.type,
        {
          expressionType: 'nullish-coalescing',
          kubernetesRefs: extractResourceReferencesFromExpression(expression),
          dependencies: extractResourceReferencesFromExpression(expression),
          conversionNotes: ['Nullish coalescing converted to conditional'],
        }
      );
      sourceMapEntries.push(...context.sourceMap.getEntries());
    }

    // Extract dependencies from the nullish coalescing expression
    const dependencies = extractDependenciesFromExpressionString(expression, context);

    return {
      valid: true,
      celExpression,
      dependencies,
      sourceMap: sourceMapEntries,
      errors: [],
      warnings: [],
      requiresConversion: true,
    };
  } catch (error: unknown) {
    return {
      valid: false,
      celExpression: null,
      dependencies: [],
      sourceMap: [],
      errors: [
        new ConversionError(
          `Failed to handle nullish coalescing: ${ensureError(error).message}`,
          expression,
          'nullish-coalescing'
        ),
      ],
      warnings: [],
      requiresConversion: true,
    };
  }
}
