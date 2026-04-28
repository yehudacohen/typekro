/**
 * CEL Expression Runtime Evaluator
 *
 * This module provides ACTUAL runtime CEL expression evaluation using the cel-js library.
 * This is used for Direct mode deployment where CEL expressions must be evaluated
 * by TypeKro before creating Kubernetes manifests.
 *
 * Purpose:
 * - Evaluate CEL expressions at runtime using live cluster data
 * - Resolve resource references to actual values from deployed resources
 * - Support standard CEL functions and operations
 *
 * When to use:
 * - Direct mode deployment (DeploymentMode.DIRECT)
 * - When CEL expressions need to be resolved to concrete values
 * - For status field evaluation that references live cluster resources
 *
 * NOT used for:
 * - Kro mode deployment (Kro operator handles CEL evaluation)
 * - Compile-time optimization (see cel-optimizer.ts)
 */

import { evaluate, parse } from 'cel-js';
import { escapeCelString } from '../../utils/cel-escape.js';
import { isKubernetesRef } from '../../utils/type-guards.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import { ensureError, TypeKroError } from '../errors.js';
import type { CelEvaluationContext } from '../types/references.js';
import { CelEvaluationError } from '../types/references.js';
import type { CelExpression, KubernetesRef } from '../types.js';

export class CelEvaluator {
  /**
   * Evaluate a CEL expression with the given context
   */
  async evaluate(expression: CelExpression, context: CelEvaluationContext): Promise<unknown> {
    try {
      // Build the evaluation context for cel-js
      const celContext = await this.buildCelContext(expression, context);

      // Use cel-js to evaluate the expression with standard functions
      const functions = {
        // Standard CEL functions
        string: (value: unknown) => String(value),
        int: (value: unknown) => parseInt(String(value), 10),
        double: (value: unknown) => parseFloat(String(value)),
        size: (collection: unknown) => {
          if (Array.isArray(collection)) return collection.length;
          if (typeof collection === 'string') return collection.length;
          if (collection && typeof collection === 'object') return Object.keys(collection).length;
          return 0;
        },
        has: (obj: unknown, field?: string) => {
          if (field) {
            return obj && typeof obj === 'object' && field in obj;
          }
          // For expressions like has(config.debug), the field access is already resolved
          return obj !== undefined && obj !== null;
        },
        concat: (...args: unknown[]) => args.join(''),
        ...context.functions,
      };

      const result = evaluate(expression.expression, celContext, functions);

      return result;
    } catch (error: unknown) {
      throw new CelEvaluationError(expression, ensureError(error));
    }
  }

  /**
   * Parse a CEL expression for validation or reuse
   */
  parse(expression: CelExpression): (context: CelEvaluationContext) => Promise<unknown> {
    try {
      const parseResult = parse(expression.expression);

      if (!parseResult.isSuccess) {
        throw new TypeKroError('Failed to parse CEL expression', 'CEL_PARSE_FAILED', {
          expression: expression.expression,
        });
      }

      return async (context: CelEvaluationContext) => {
        const celContext = await this.buildCelContext(expression, context);
        const functions = {
          // Standard CEL functions
          string: (value: unknown) => String(value),
          int: (value: unknown) => parseInt(String(value), 10),
          double: (value: unknown) => parseFloat(String(value)),
          size: (collection: unknown) => {
            if (Array.isArray(collection)) return collection.length;
            if (typeof collection === 'string') return collection.length;
            if (collection && typeof collection === 'object') return Object.keys(collection).length;
            return 0;
          },
          has: (obj: unknown, field?: string) => {
            if (field) {
              return obj && typeof obj === 'object' && field in obj;
            }
            // For expressions like has(config.debug), the field access is already resolved
            return obj !== undefined && obj !== null;
          },
          concat: (...args: unknown[]) => args.join(''),
          ...context.functions,
        };
        return evaluate(parseResult.cst, celContext, functions);
      };
    } catch (error: unknown) {
      throw new CelEvaluationError(expression, ensureError(error));
    }
  }

  /**
   * Validate that a CEL expression can be parsed
   */
  validate(expression: CelExpression): { valid: boolean; error?: string } {
    try {
      const parseResult = parse(expression.expression);
      if (parseResult.isSuccess) {
        return { valid: true };
      } else {
        return {
          valid: false,
          error: 'Failed to parse CEL expression',
        };
      }
    } catch (error: unknown) {
      return {
        valid: false,
        error: ensureError(error).message,
      };
    }
  }

  /**
   * Build the context object for cel-js evaluation
   */
  private async buildCelContext(
    expression: CelExpression,
    context: CelEvaluationContext
  ): Promise<Record<string, unknown>> {
    const celContext: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    // Add variables to context
    if (context.variables) {
      Object.assign(celContext, context.variables);
    }

    // Resolve resource references and add them to context
    const resourceRefs = this.extractResourceReferences(expression.expression);

    for (const ref of resourceRefs) {
      let resource = context.resources.get(ref.resourceId);

      // If not found, try case-insensitive lookup
      if (!resource) {
        const lowerResourceId = ref.resourceId.toLowerCase();
        for (const [key, value] of context.resources.entries()) {
          if (key.toLowerCase() === lowerResourceId) {
            resource = value;
            break;
          }
        }
      }

      if (!resource) {
        throw new TypeKroError(
          `Resource '${ref.resourceId}' not found in context`,
          'RESOURCE_NOT_FOUND',
          { resourceId: ref.resourceId }
        );
      }

      // Add the entire resource to context using its ID (use the original case from CEL expression)
      if (!celContext[ref.resourceId]) {
        celContext[ref.resourceId] = resource;
      }
    }

    return celContext;
  }

  /**
   * Extract resource references from a CEL expression
   */
  private extractResourceReferences(
    expression: string
  ): Array<{ resourceId: string; fieldPath: string }> {
    const refs: Array<{ resourceId: string; fieldPath: string }> = [];

    // Pattern to match resource references: resourceId.section.field
    const refPattern = /(\w+)\.(\w+)\.(\w+(?:\[\d+\])?(?:\.\w+)*)/g;
    let match: RegExpExecArray | null = refPattern.exec(expression);

    while (match !== null) {
      const [, resourceId, section, fieldPath] = match;
      if (resourceId && section && fieldPath) {
        refs.push({
          resourceId,
          fieldPath: `${section}.${fieldPath}`,
        });
      }
      match = refPattern.exec(expression);
    }

    return refs;
  }

  /**
   * Create a CEL expression from a template string with resource references
   */
  static createExpression(template: string, ...refs: KubernetesRef[]): CelExpression {
    let expression = template;

    // Replace placeholders with actual resource references
    refs.forEach((ref, index) => {
      const placeholder = `$${index}`;
      const refExpression = `${ref.resourceId}.${ref.fieldPath}`;
      expression = expression.replace(placeholder, refExpression);
    });

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
    };
  }

  /** @see {@link escapeCelString} from utils/cel-escape.ts */
  private static escapeCelString = escapeCelString;

  /**
   * Validate a CEL predicate/expression fragment to prevent injection.
   * Rejects expressions containing string literals with unbalanced quotes
   * or suspicious patterns that could indicate injection attempts.
   */
  private static validateCelFragment(fragment: string, paramName: string): void {
    // Check for unbalanced double quotes (ignoring escaped ones)
    const unescapedQuotes = fragment.replace(/\\"/g, '').match(/"/g);
    if (unescapedQuotes && unescapedQuotes.length % 2 !== 0) {
      throw new TypeKroError(
        `Invalid CEL ${paramName}: unbalanced quotes in "${fragment}"`,
        'CEL_INJECTION_PREVENTED',
        { fragment, paramName }
      );
    }
  }

  /**
   * Common CEL expression builders
   */
  static expressions = {
    /**
     * Concatenate strings: concat("prefix", resource.field, "suffix")
     */
    concat: (...parts: Array<string | KubernetesRef>): CelExpression => {
      const args = parts
        .map((part) => {
          if (isKubernetesRef(part)) {
            return `${part.resourceId}.${part.fieldPath}`;
          }
          return `"${CelEvaluator.escapeCelString(part)}"`;
        })
        .join(', ');

      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `concat(${args})`,
      };
    },

    /**
     * Conditional expression: condition ? trueValue : falseValue
     */
    conditional: (
      condition: string | KubernetesRef,
      trueValue: unknown,
      falseValue: unknown
    ): CelExpression => {
      const conditionExpr = isKubernetesRef(condition)
        ? `${condition.resourceId}.${condition.fieldPath}`
        : condition;

      // Validate the condition fragment if it's a raw string
      if (!isKubernetesRef(condition)) {
        CelEvaluator.validateCelFragment(conditionExpr, 'condition');
      }

      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `${conditionExpr} ? ${JSON.stringify(trueValue)} : ${JSON.stringify(falseValue)}`,
      };
    },

    /**
     * Check if a field exists: has(resource.field)
     */
    has: (ref: KubernetesRef): CelExpression => ({
      [CEL_EXPRESSION_BRAND]: true,
      expression: `has(${ref.resourceId}.${ref.fieldPath})`,
    }),

    /**
     * Get size/length: size(resource.field)
     */
    size: (ref: KubernetesRef): CelExpression => ({
      [CEL_EXPRESSION_BRAND]: true,
      expression: `size(${ref.resourceId}.${ref.fieldPath})`,
    }),

    /**
     * String contains check: resource.field.contains("substring")
     */
    contains: (ref: KubernetesRef, substring: string): CelExpression => ({
      [CEL_EXPRESSION_BRAND]: true,
      expression: `${ref.resourceId}.${ref.fieldPath}.contains("${CelEvaluator.escapeCelString(substring)}")`,
    }),

    /**
     * String starts with check: resource.field.startsWith("prefix")
     */
    startsWith: (ref: KubernetesRef, prefix: string): CelExpression => ({
      [CEL_EXPRESSION_BRAND]: true,
      expression: `${ref.resourceId}.${ref.fieldPath}.startsWith("${CelEvaluator.escapeCelString(prefix)}")`,
    }),

    /**
     * String ends with check: resource.field.endsWith("suffix")
     */
    endsWith: (ref: KubernetesRef, suffix: string): CelExpression => ({
      [CEL_EXPRESSION_BRAND]: true,
      expression: `${ref.resourceId}.${ref.fieldPath}.endsWith("${CelEvaluator.escapeCelString(suffix)}")`,
    }),

    /**
     * List/array operations: resource.field.all(x, x > 0)
     */
    all: (ref: KubernetesRef, predicate: string): CelExpression => {
      CelEvaluator.validateCelFragment(predicate, 'predicate');
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `${ref.resourceId}.${ref.fieldPath}.all(x, ${predicate})`,
      };
    },

    /**
     * List/array operations: resource.field.exists(x, x > 0)
     */
    exists: (ref: KubernetesRef, predicate: string): CelExpression => {
      CelEvaluator.validateCelFragment(predicate, 'predicate');
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `${ref.resourceId}.${ref.fieldPath}.exists(x, ${predicate})`,
      };
    },

    /**
     * List/array filter: resource.field.filter(x, x > 0)
     */
    filter: (ref: KubernetesRef, predicate: string): CelExpression => {
      CelEvaluator.validateCelFragment(predicate, 'predicate');
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `${ref.resourceId}.${ref.fieldPath}.filter(x, ${predicate})`,
      };
    },

    /**
     * List/array map: resource.field.map(x, x * 2)
     */
    map: (ref: KubernetesRef, transform: string): CelExpression => {
      CelEvaluator.validateCelFragment(transform, 'transform');
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `${ref.resourceId}.${ref.fieldPath}.map(x, ${transform})`,
      };
    },
  };
}
