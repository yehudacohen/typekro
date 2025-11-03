/**
 * Imperative Composition Analyzer
 *
 * This module analyzes imperative composition functions to detect JavaScript expressions
 * that contain KubernetesRef objects and converts them to CEL expressions.
 */

import { Parser } from 'acorn';
import * as estraverse from 'estraverse';
import { Cel } from '../references/cel.js';
import { getComponentLogger } from '../logging/index.js';
import type { Enhanced } from '../types/index.js';

const logger = getComponentLogger('imperative-analyzer');

export interface ImperativeAnalysisOptions {
  factoryType: 'direct' | 'kro';
}

export interface ImperativeAnalysisResult {
  statusMappings: Record<string, any>;
  hasJavaScriptExpressions: boolean;
  errors: string[];
}

/**
 * Analyze an imperative composition function to detect JavaScript expressions
 * that should be converted to CEL expressions.
 */
export function analyzeImperativeComposition(
  compositionFn: Function,
  resources: Record<string, Enhanced<any, any>>,
  options: ImperativeAnalysisOptions
): ImperativeAnalysisResult {
  logger.debug('Analyzing imperative composition function', {
    resourceCount: Object.keys(resources).length,
    factoryType: options.factoryType,
    resourceIds: Object.keys(resources),
  });

  try {
    // Parse the composition function source code
    const functionSource = compositionFn.toString();

    logger.debug('Parsing composition function source', {
      sourceLength: functionSource.length,
      functionSource: functionSource.substring(0, 500) + (functionSource.length > 500 ? '...' : ''),
    });

    const ast = Parser.parse(functionSource, {
      ecmaVersion: 2022,
      sourceType: 'script',
      locations: true,
      ranges: true,
    });

    // Find the return statement in the composition function
    const returnStatement = findReturnStatement(ast);

    if (!returnStatement || !returnStatement.argument) {
      logger.debug('No return statement found in composition function');
      return {
        statusMappings: {},
        hasJavaScriptExpressions: false,
        errors: ['No return statement found in composition function'],
      };
    }

    // Check if the return statement returns an object literal
    if (returnStatement.argument.type !== 'ObjectExpression') {
      logger.debug('Return statement does not return an object literal');
      return {
        statusMappings: {},
        hasJavaScriptExpressions: false,
        errors: ['Return statement must return an object literal'],
      };
    }

    // Analyze each property in the returned object
    const statusMappings: Record<string, any> = {};
    const errors: string[] = [];
    let hasJavaScriptExpressions = false;

    // Process properties recursively to handle nested objects
    function processProperties(properties: any[], parentPath: string = ''): void {
      for (const property of properties) {
        if (property.type === 'Property' && property.key.type === 'Identifier') {
          const fieldName = property.key.name;
          const fullFieldName = parentPath ? `${parentPath}.${fieldName}` : fieldName;

          try {
            // Check if this is a nested object
            if (property.value.type === 'ObjectExpression') {
              logger.debug('Found nested object property', { fieldName, fullFieldName });

              // Create nested object in statusMappings
              if (parentPath) {
                // Navigate to the parent object and create the nested structure
                const pathParts = parentPath.split('.');
                let current = statusMappings;
                for (const part of pathParts) {
                  if (!current[part]) current[part] = {};
                  current = current[part];
                }
                if (!current[fieldName]) current[fieldName] = {};
              } else {
                if (!statusMappings[fieldName]) statusMappings[fieldName] = {};
              }

              // Recursively process nested properties
              processProperties(property.value.properties, fullFieldName);
              continue;
            }

            // Convert the property value to source code
            const propertySource = getNodeSource(property.value, functionSource);

            logger.debug('Analyzing property', {
              fieldName,
              fullFieldName,
              propertySource:
                propertySource.substring(0, 100) + (propertySource.length > 100 ? '...' : ''),
            });

            // Check if this expression contains resource references
            if (containsResourceReferences(propertySource)) {
              logger.debug('Found resource references in property', {
                fieldName,
                fullFieldName,
                propertySource,
              });

              // Convert resource references to proper format for CEL
              const convertedSource = convertResourceReferencesToCel(propertySource, resources);

              logger.debug('Converted resource references', {
                fieldName,
                fullFieldName,
                originalSource: propertySource.substring(0, 100),
                convertedSource: convertedSource.substring(0, 100),
              });

              // For imperative compositions, create CEL expressions directly from the converted source
              const celExpression = Cel.expr(convertedSource);

              // Set the CEL expression at the correct nested path
              if (parentPath) {
                const pathParts = parentPath.split('.');
                let current = statusMappings;
                for (const part of pathParts) {
                  if (!current[part]) current[part] = {};
                  current = current[part];
                }
                current[fieldName] = celExpression;
              } else {
                statusMappings[fieldName] = celExpression;
              }

              hasJavaScriptExpressions = true;

              logger.debug('Created direct CEL expression for property', {
                fieldName,
                fullFieldName,
                expression: convertedSource,
              });
            } else {
              // No resource references, keep as static value
              const staticValue = evaluateStaticExpression(property.value);

              // Set the static value at the correct nested path
              if (parentPath) {
                const pathParts = parentPath.split('.');
                let current = statusMappings;
                for (const part of pathParts) {
                  if (!current[part]) current[part] = {};
                  current = current[part];
                }
                current[fieldName] = staticValue;
              } else {
                statusMappings[fieldName] = staticValue;
              }

              logger.debug('Property has no resource references, keeping as static', {
                fieldName,
                fullFieldName,
              });
            }
          } catch (error) {
            const errorMessage = `Failed to analyze property '${fullFieldName}': ${error instanceof Error ? error.message : String(error)}`;
            errors.push(errorMessage);
            logger.debug('Property analysis failed', {
              fieldName,
              fullFieldName,
              error: errorMessage,
            });

            // Fallback to static evaluation
            try {
              const staticValue = evaluateStaticExpression(property.value);
              if (parentPath) {
                const pathParts = parentPath.split('.');
                let current = statusMappings;
                for (const part of pathParts) {
                  if (!current[part]) current[part] = {};
                  current = current[part];
                }
                current[fieldName] = staticValue;
              } else {
                statusMappings[fieldName] = staticValue;
              }
            } catch (_evalError) {
              if (parentPath) {
                const pathParts = parentPath.split('.');
                let current = statusMappings;
                for (const part of pathParts) {
                  if (!current[part]) current[part] = {};
                  current = current[part];
                }
                current[fieldName] = null;
              } else {
                statusMappings[fieldName] = null;
              }
            }
          }
        }
      }
    }

    // Start processing from the top-level properties
    processProperties(returnStatement.argument.properties);

    logger.debug('Imperative composition analysis complete', {
      statusFieldCount: Object.keys(statusMappings).length,
      hasJavaScriptExpressions,
      errorCount: errors.length,
    });

    return {
      statusMappings,
      hasJavaScriptExpressions,
      errors,
    };
  } catch (error) {
    const errorMessage = `Failed to analyze imperative composition: ${error instanceof Error ? error.message : String(error)}`;
    logger.error('Imperative composition analysis failed', error as Error);

    return {
      statusMappings: {},
      hasJavaScriptExpressions: false,
      errors: [errorMessage],
    };
  }
}

/**
 * Find the return statement in an AST
 */
function findReturnStatement(ast: any): any {
  let returnStatement = null;

  estraverse.traverse(ast, {
    enter: (node) => {
      if (node.type === 'ReturnStatement') {
        returnStatement = node;
        return estraverse.VisitorOption.Break;
      }
      // Continue normal traversal
      return undefined;
    },
  });

  return returnStatement;
}

/**
 * Extract source code for a specific AST node
 */
function getNodeSource(node: any, fullSource: string): string {
  if (node.range) {
    return fullSource.substring(node.range[0], node.range[1]);
  }

  // Fallback: try to reconstruct the source
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? `"${node.value}"` : String(node.value);
    case 'Identifier':
      return node.name;
    case 'BinaryExpression':
      return `${getNodeSource(node.left, fullSource)} ${node.operator} ${getNodeSource(node.right, fullSource)}`;
    case 'ConditionalExpression':
      return `${getNodeSource(node.test, fullSource)} ? ${getNodeSource(node.consequent, fullSource)} : ${getNodeSource(node.alternate, fullSource)}`;
    case 'LogicalExpression':
      return `${getNodeSource(node.left, fullSource)} ${node.operator} ${getNodeSource(node.right, fullSource)}`;
    case 'MemberExpression': {
      const object = getNodeSource(node.object, fullSource);
      const property = node.computed
        ? `[${getNodeSource(node.property, fullSource)}]`
        : `.${node.property.name}`;
      return object + property;
    }
    case 'ObjectExpression': {
      const properties = node.properties
        .map((prop: any) => {
          const key = prop.key.name || prop.key.value;
          const value = getNodeSource(prop.value, fullSource);
          return `${key}: ${value}`;
        })
        .join(', ');
      return `{ ${properties} }`;
    }
    default:
      return '<unknown>';
  }
}

/**
 * Check if a source string contains resource references or schema references
 */
function containsResourceReferences(source: string): boolean {
  // Look for patterns like:
  // - kroHelmRelease.status.phase (resource references)
  // - fluxHelmRelease.status.phase (resource references)
  // - variableName.status.something (resource references)
  // - variableName.metadata.something (resource references)
  // - spec.hostname (schema references)
  // - spec.name (schema references)

  const referencePatterns = [
    /\w+\.status\./,
    /\w+\.metadata\./,
    /\w+\.spec\./,
    /\w+\.data\./,
    /\bspec\./, // Schema references
  ];

  return referencePatterns.some((pattern) => pattern.test(source));
}

/**
 * Convert resource references and schema references in source code to proper CEL format
 *
 * This function handles template literals and converts them to proper CEL string concatenation.
 * For example: `https://${spec.hostname}/api` becomes: "https://" + schema.spec.hostname + "/api"
 * For example: `Deployment ${deployment.metadata.name} has ${deployment.status.readyReplicas} replicas`
 * becomes: "Deployment " + deployment.metadata.name + " has " + deployment.status.readyReplicas + " replicas"
 */
function convertResourceReferencesToCel(
  source: string,
  resources: Record<string, Enhanced<any, any>>
): string {
  // Check if this is a template literal
  if (source.startsWith('`') && source.endsWith('`')) {
    return convertTemplateLiteralToCel(source, resources);
  }

  // Check if this is a string literal that contains KubernetesRef placeholders
  if (source.includes('__KUBERNETES_REF_')) {
    return convertStringWithKubernetesRefs(source);
  }

  // For non-template literals, return as-is (other expressions should already be valid CEL)
  return source;
}

/**
 * Convert a JavaScript template literal to CEL string concatenation
 */
function convertTemplateLiteralToCel(
  templateLiteral: string,
  resources: Record<string, Enhanced<any, any>>
): string {
  // Remove the backticks
  let content = templateLiteral.slice(1, -1);

  // First, convert any special KubernetesRef strings in the content
  content = convertTemplateLiteralContent(content);

  // Parse template literal parts
  const parts: string[] = [];
  let currentPart = '';
  let i = 0;

  while (i < content.length) {
    if (content[i] === '$' && content[i + 1] === '{') {
      // Found interpolation start
      if (currentPart) {
        // Add the literal string part (quoted for CEL)
        parts.push(`"${currentPart.replace(/"/g, '\\"')}"`);
        currentPart = '';
      }

      // Find the matching closing brace
      let braceCount = 1;
      let j = i + 2;
      let expression = '';

      while (j < content.length && braceCount > 0) {
        if (content[j] === '{') braceCount++;
        if (content[j] === '}') braceCount--;
        if (braceCount > 0) expression += content[j];
        j++;
      }

      // Convert the expression part
      if (expression.trim()) {
        const convertedExpression = convertExpressionToCel(expression.trim());
        parts.push(convertedExpression);
      }

      i = j;
    } else {
      currentPart += content[i];
      i++;
    }
  }

  // Add any remaining literal part
  if (currentPart) {
    parts.push(`"${currentPart.replace(/"/g, '\\"')}"`);
  }

  // Join parts with + for CEL string concatenation
  return parts.join(' + ');
}

/**
 * Convert individual expressions within template literals to CEL format
 */
function convertExpressionToCel(expression: string): string {
  // Convert schema references: spec.hostname -> schema.spec.hostname
  if (expression.startsWith('spec.')) {
    expression = `schema.${expression}`;
  }

  // Convert JavaScript operators to CEL operators
  expression = expression.replace(/===/g, '=='); // Convert strict equality to CEL equality
  expression = expression.replace(/!==/g, '!='); // Convert strict inequality to CEL inequality

  // Wrap expressions containing || or && operators in parentheses to preserve precedence
  // when they're part of string concatenation in template literals
  if (expression.includes('||') || expression.includes('&&')) {
    expression = `(${expression})`;
  }

  // Resource references are already in correct format
  return expression;
}

/**
 * Convert template literal content that may contain special KubernetesRef strings
 */
function convertTemplateLiteralContent(content: string): string {
  // Replace special KubernetesRef strings with proper CEL expressions
  return content.replace(/__KUBERNETES_REF_([^_]+)_([^_]+)__/g, (match, resourceId, fieldPath) => {
    if (resourceId === '__schema__') {
      return `schema.${fieldPath}`;
    } else {
      return `${resourceId}.${fieldPath}`;
    }
  });
}

/**
 * Convert a string literal that contains KubernetesRef placeholders to CEL string concatenation
 */
function convertStringWithKubernetesRefs(source: string): string {
  // Remove quotes if present
  let content = source;
  if (
    (content.startsWith('"') && content.endsWith('"')) ||
    (content.startsWith("'") && content.endsWith("'"))
  ) {
    content = content.slice(1, -1);
  }

  // Split the string by KubernetesRef placeholders
  const parts: string[] = [];
  const refPattern = /__KUBERNETES_REF_([^_]+)_([^_]+)__/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = refPattern.exec(content);

  while (match !== null) {
    // Add the literal part before the reference
    if (match.index > lastIndex) {
      const literalPart = content.slice(lastIndex, match.index);
      if (literalPart) {
        parts.push(`"${literalPart.replace(/"/g, '\\"')}"`);
      }
    }

    // Add the reference part
    const [, resourceId, fieldPath] = match;
    if (resourceId === '__schema__') {
      parts.push(`schema.${fieldPath}`);
    } else {
      parts.push(`${resourceId}.${fieldPath}`);
    }

    lastIndex = match.index + match[0].length;
    match = refPattern.exec(content);
  }

  // Add any remaining literal part
  if (lastIndex < content.length) {
    const literalPart = content.slice(lastIndex);
    if (literalPart) {
      parts.push(`"${literalPart.replace(/"/g, '\\"')}"`);
    }
  }

  // Join parts with + for CEL string concatenation
  return parts.join(' + ');
}

/**
 * Evaluate a static expression (no resource references)
 */
function evaluateStaticExpression(node: any): any {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      // For identifiers, we can't evaluate them statically
      return node.name;
    case 'BinaryExpression':
      // For binary expressions with literals, we could evaluate them
      // But for safety, just return a placeholder
      return null;
    case 'ConditionalExpression':
      return null;
    case 'LogicalExpression':
      return null;
    case 'ObjectExpression': {
      const obj: Record<string, any> = {};
      for (const prop of node.properties) {
        if (prop.type === 'Property' && prop.key.type === 'Identifier') {
          obj[prop.key.name] = evaluateStaticExpression(prop.value);
        }
      }
      return obj;
    }
    default:
      return null;
  }
}
