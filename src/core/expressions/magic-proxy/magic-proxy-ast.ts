/**
 * AST Parsing and Member Expression Analysis for Magic Proxy Detection
 *
 * This module provides standalone functions for parsing JavaScript expressions
 * into ASTs and analyzing them for magic proxy access patterns (schema.* and
 * resources.*). These functions are extracted from the MagicProxyAnalyzer class
 * to keep file sizes manageable.
 */

import * as estraverse from 'estraverse';
import type { Node as ESTreeNode, Identifier, MemberExpression } from 'estree';
import { KUBERNETES_REF_BRAND } from '../../constants/brands.js';
import { ConversionError, ensureError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';
import type { KubernetesRef } from '../../types/common.js';
import { ParserError, parseScript } from '../analysis/parser.js';
import type { MagicProxyAnalysisContext } from './magic-proxy-types.js';

const logger = getComponentLogger('magic-proxy-ast');

/**
 * Parse JavaScript expression string into AST using unified acorn parser
 */
export function parseExpression(expressionSource: string): ESTreeNode {
  try {
    // Use unified acorn parser with ES2022 support
    const ast = parseScript(expressionSource);

    return ast;
  } catch (error: unknown) {
    // Convert ParserError to ConversionError for consistent error handling
    if (error instanceof ParserError) {
      throw new ConversionError(
        `Failed to parse JavaScript expression at line ${error.line}, column ${error.column}: ${error.message}`,
        expressionSource,
        'javascript'
      );
    }
    throw new ConversionError(
      `Failed to parse JavaScript expression: ${ensureError(error).message}`,
      expressionSource,
      'javascript'
    );
  }
}

/**
 * Analyze AST for magic proxy access patterns
 */
export function analyzeASTForMagicProxyPatterns(
  ast: ESTreeNode,
  _expressionSource: string,
  context: MagicProxyAnalysisContext
): {
  refs: KubernetesRef<any>[];
  analysisDepth: number;
  hasProxyObjects: boolean;
} {
  const refs: KubernetesRef<any>[] = [];
  let analysisDepth = 0;
  let hasProxyObjects = false;

  // Traverse the AST to find member expressions that could be magic proxy accesses
  estraverse.traverse(ast, {
    enter: (node, _parent) => {
      analysisDepth++;

      if (node.type === 'MemberExpression') {
        const memberExpr = node as MemberExpression;
        const kubernetesRef = extractKubernetesRefFromMemberExpression(memberExpr, context);

        if (kubernetesRef) {
          refs.push(kubernetesRef);
          hasProxyObjects = true;
        }
      }

      // Check for other proxy patterns
      if (isProxyAccessPattern(node, context)) {
        hasProxyObjects = true;
      }
    },
  });

  return {
    refs,
    analysisDepth,
    hasProxyObjects,
  };
}

/**
 * Extract KubernetesRef from member expression AST node
 */
export function extractKubernetesRefFromMemberExpression(
  memberExpr: MemberExpression,
  context: MagicProxyAnalysisContext
): KubernetesRef<any> | null {
  try {
    // Build the field path from the member expression chain
    const fieldPath = buildFieldPathFromMemberExpression(memberExpr);
    const resourceId = extractResourceIdFromMemberExpression(memberExpr);

    if (resourceId && fieldPath) {
      // Check if this matches known proxy patterns
      if (isValidProxyAccess(resourceId, fieldPath, context)) {
        return {
          [KUBERNETES_REF_BRAND]: true,
          resourceId,
          fieldPath,
          _type: undefined, // Will be inferred from context
        };
      }
    }

    return null;
  } catch (error: unknown) {
    logger.debug('Failed to extract KubernetesRef from member expression', { error });
    return null;
  }
}

/**
 * Build field path from member expression chain
 */
export function buildFieldPathFromMemberExpression(memberExpr: MemberExpression): string | null {
  const parts: string[] = [];
  let current: ESTreeNode = memberExpr;

  while (current && current.type === 'MemberExpression') {
    const member = current as MemberExpression;

    if (member.property.type === 'Identifier') {
      parts.unshift(member.property.name);
    } else {
      // Skip computed properties for now
      break;
    }

    current = member.object;
  }

  return parts.length > 0 ? parts.join('.') : null;
}

/**
 * Extract resource ID from member expression
 */
export function extractResourceIdFromMemberExpression(memberExpr: MemberExpression): string | null {
  let current: ESTreeNode = memberExpr;

  // Traverse to the root of the member expression chain
  while (current && current.type === 'MemberExpression') {
    current = (current as MemberExpression).object;
  }

  if (current && current.type === 'Identifier') {
    const identifier = current as Identifier;

    // Check for known proxy patterns
    if (identifier.name === 'schema') {
      return '__schema__';
    } else if (identifier.name === 'resources') {
      // For resources.resourceName.field, we need to get the next level
      let resourceCurrent: ESTreeNode = memberExpr;
      while (resourceCurrent && resourceCurrent.type === 'MemberExpression') {
        const member = resourceCurrent as MemberExpression;
        if (member.object.type === 'Identifier' && member.object.name === 'resources') {
          if (member.property.type === 'Identifier') {
            return member.property.name;
          }
          break;
        }
        resourceCurrent = member.object;
      }
    } else {
      // Direct resource access
      return identifier.name;
    }
  }

  return null;
}

/**
 * Check if a node represents a proxy access pattern
 */
export function isProxyAccessPattern(
  node: ESTreeNode,
  context: MagicProxyAnalysisContext
): boolean {
  if (node.type === 'MemberExpression') {
    const memberExpr = node as MemberExpression;
    const resourceId = extractResourceIdFromMemberExpression(memberExpr);

    if (resourceId) {
      return isValidProxyAccess(resourceId, '', context);
    }
  }

  return false;
}

/**
 * Check if a resource ID and field path represent valid proxy access
 */
export function isValidProxyAccess(
  resourceId: string,
  _fieldPath: string,
  context: MagicProxyAnalysisContext
): boolean {
  // Schema references are always valid
  if (resourceId === '__schema__') {
    return true;
  }

  // Check if resource exists in available references
  if (context.availableReferences?.[resourceId]) {
    return true;
  }

  // Check if resource exists in resource proxies
  if (context.resourceProxies?.[resourceId]) {
    return true;
  }

  return false;
}
