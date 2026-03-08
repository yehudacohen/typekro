/**
 * Shared CEL expression utility functions.
 *
 * Provides common helpers for constructing CEL expressions and building
 * resource paths that are used across multiple expression analysis modules.
 */

import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import type { CelExpression } from '../types/common.js';

/**
 * Build a CEL resource path from a KubernetesRef's resourceId and fieldPath.
 *
 * Schema references produce `schema.{fieldPath}`, resource references
 * produce `resources.{resourceId}.{fieldPath}`.
 *
 * @example
 * ```ts
 * buildResourcePath({ resourceId: '__schema__', fieldPath: 'spec.name' })
 * // => 'schema.spec.name'
 *
 * buildResourcePath({ resourceId: 'myDeploy', fieldPath: 'status.ready' })
 * // => 'resources.myDeploy.status.ready'
 * ```
 */
export function buildResourcePath(ref: { resourceId: string; fieldPath: string }): string {
  return ref.resourceId === '__schema__'
    ? `schema.${ref.fieldPath}`
    : `resources.${ref.resourceId}.${ref.fieldPath}`;
}

/**
 * Build a CEL resource path with a custom field path override.
 *
 * Useful when you need the resource prefix but want to use a partial or different field path.
 */
export function buildResourcePathWithField(resourceId: string, fieldPath: string): string {
  return resourceId === '__schema__'
    ? `schema.${fieldPath}`
    : `resources.${resourceId}.${fieldPath}`;
}

/**
 * Create a CelExpression object from an expression string.
 *
 * This eliminates the boilerplate of constructing the branded object literal
 * `{ [CEL_EXPRESSION_BRAND]: true, expression, _type: undefined }` that appears
 * 100+ times across the expression analysis codebase.
 *
 * @example
 * ```ts
 * const expr = createCelExpression('resources.myDeploy.status.readyReplicas > 0');
 * // => { [CEL_EXPRESSION_BRAND]: true, expression: '...', _type: undefined }
 * ```
 */
export function createCelExpression(expression: string, type?: string): CelExpression {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: type,
  } as CelExpression;
}
