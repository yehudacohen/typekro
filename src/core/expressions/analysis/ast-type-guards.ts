/**
 * ESTree AST Type Guards
 *
 * Provides safe property access for ESTree AST nodes without requiring
 * `as unknown as T` double casts. Uses Reflect.get to safely extract
 * properties from narrowed node types.
 */

import type { Node as ESTreeNode } from 'estree';

/**
 * Safely extract the `name` property from an ESTree node.
 * Intended for nodes whose `type` has been checked as `'Identifier'`.
 */
export function getIdentifierName(node: ESTreeNode | Record<string, unknown>): string {
  return Reflect.get(node, 'name') as string;
}
