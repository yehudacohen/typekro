/**
 * Enhanced error handling for TypeKro
 * Provides detailed, actionable error messages with context
 */

import { levenshteinDistance } from '../utils/string.js';

export class TypeKroError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TypeKroError';
  }
}

export class ValidationError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceKind: string,
    public readonly resourceName: string,
    public readonly field?: string,
    public readonly suggestions?: string[]
  ) {
    super(message, 'VALIDATION_ERROR', {
      resourceKind,
      resourceName,
      field,
      suggestions,
    });
    this.name = 'ValidationError';
  }
}

export class TypeKroReferenceError extends TypeKroError {
  constructor(
    message: string,
    public readonly fromResource: string,
    public readonly toResource: string,
    public readonly fieldPath: string,
    public readonly suggestions?: string[]
  ) {
    super(message, 'REFERENCE_ERROR', {
      fromResource,
      toResource,
      fieldPath,
      suggestions,
    });
    this.name = 'TypeKroReferenceError';
  }
}

export class CircularDependencyError extends TypeKroError {
  constructor(
    message: string,
    public readonly cycle: string[],
    public readonly suggestions?: string[]
  ) {
    super(message, 'CIRCULAR_DEPENDENCY', {
      cycle,
      suggestions,
    });
    this.name = 'CircularDependencyError';
  }
}

/**
 * Format Arktype validation errors with helpful context and suggestions
 */
export function formatArktypeError(
  error: any,
  resourceKind: string,
  resourceName: string,
  _spec: unknown
): ValidationError {
  const problems = error.problems || [];

  if (problems.length === 0) {
    return new ValidationError(
      `Invalid ${resourceKind} spec: ${error.summary}`,
      resourceKind,
      resourceName,
      undefined,
      ['Check the resource specification against the schema']
    );
  }

  // Get the first problem for detailed error
  const firstProblem = problems[0];
  const fieldPath = firstProblem.path?.join('.') || 'root';
  const expectedType = firstProblem.expected || 'unknown';
  const actualValue = firstProblem.actual;

  let message = `Invalid ${resourceKind} '${resourceName}' at field '${fieldPath}':`;
  message += `\n  Expected: ${expectedType}`;
  message += `\n  Received: ${typeof actualValue} (${JSON.stringify(actualValue)})`;

  const suggestions: string[] = [];

  // Add specific suggestions based on the error type
  if (firstProblem.code === 'missing') {
    suggestions.push(`Add the required field '${fieldPath}' to your ${resourceKind} spec`);
    suggestions.push(`Example: { ${fieldPath}: ${getExampleValue(expectedType)} }`);
  } else if (firstProblem.code === 'type') {
    suggestions.push(`Change '${fieldPath}' to be of type ${expectedType}`);
    if (expectedType.includes('|')) {
      const options = expectedType.split('|').map((s: string) => s.trim());
      suggestions.push(`Valid options: ${options.join(', ')}`);
    }
  } else if (firstProblem.code === 'format') {
    suggestions.push(`Ensure '${fieldPath}' matches the expected format: ${expectedType}`);
  }

  // Add all problems if there are multiple
  if (problems.length > 1) {
    message += `\n\nAdditional validation errors:`;
    problems.slice(1).forEach((problem: any, index: number) => {
      const path = problem.path?.join('.') || 'root';
      message += `\n  ${index + 2}. ${path}: ${problem.message}`;
    });
    suggestions.push(`Fix all ${problems.length} validation errors listed above`);
  }

  return new ValidationError(message, resourceKind, resourceName, fieldPath, suggestions);
}

/**
 * Generate example values for common types
 */
function getExampleValue(expectedType: string): string {
  if (expectedType.includes('string')) return '"example-value"';
  if (expectedType.includes('number')) return '42';
  if (expectedType.includes('boolean')) return 'true';
  if (expectedType.includes('array')) return '[]';
  if (expectedType.includes('object')) return '{}';
  if (expectedType.includes('|')) {
    const options = expectedType.split('|').map((s: string) => s.trim());
    return options[0] || '"value"';
  }
  return '"value"';
}

/**
 * Format reference resolution errors with helpful context
 */
export function formatReferenceError(
  fromResourceId: string,
  toResourceId: string,
  fieldPath: string,
  availableResources: string[]
): TypeKroReferenceError {
  const message = `Resource reference failed: '${fromResourceId}' tried to reference '${toResourceId}.${fieldPath}' but resource '${toResourceId}' was not found in the resource graph.`;

  const suggestions: string[] = [];

  // Suggest similar resource names
  const similarResources = availableResources.filter(
    (id) =>
      id.includes(toResourceId) ||
      toResourceId.includes(id) ||
      levenshteinDistance(id, toResourceId) <= 2
  );

  if (similarResources.length > 0) {
    suggestions.push(`Did you mean one of these resources? ${similarResources.join(', ')}`);
  }

  suggestions.push(`Available resources: ${availableResources.join(', ')}`);
  suggestions.push(`Make sure the referenced resource is included in your toResourceGraph() call`);
  suggestions.push(`Check that the resource name and namespace are correct`);

  return new TypeKroReferenceError(message, fromResourceId, toResourceId, fieldPath, suggestions);
}

/**
 * Format circular dependency errors with helpful context
 */
export function formatCircularDependencyError(cycle: string[]): CircularDependencyError {
  const cycleStr = `${cycle.join(' → ')} → ${cycle[0]}`;
  const message = `Circular dependency detected in resource graph: ${cycleStr}`;

  const suggestions = [
    'Remove one of the dependencies to break the cycle',
    "Consider using a different approach that doesn't require circular references",
    'Use external configuration or environment variables instead of cross-resource references',
    "Split the resources into separate resource graphs if they don't need to be deployed together",
  ];

  return new CircularDependencyError(message, cycle, suggestions);
}

/**

 * Error thrown when ResourceGraphDefinition deployment fails
 */
export class ResourceGraphFactoryError extends TypeKroError {
  constructor(
    message: string,
    public readonly factoryName: string,
    public readonly operation: 'deployment' | 'getInstance' | 'cleanup',
    public readonly cause?: Error
  ) {
    super(message, 'RESOURCE_GRAPH_FACTORY_ERROR', {
      factoryName,
      operation,
      cause: cause?.message,
    });
    this.name = 'ResourceGraphFactoryError';
  }
}

/**
 * Error thrown when CRD instance operations fail
 */
export class CRDInstanceError extends TypeKroError {
  constructor(
    message: string,
    public readonly apiVersion: string,
    public readonly kind: string,
    public readonly instanceName: string,
    public readonly operation: 'creation' | 'deletion' | 'statusResolution',
    public readonly cause?: Error
  ) {
    super(message, 'CRD_INSTANCE_ERROR', {
      apiVersion,
      kind,
      instanceName,
      operation,
      cause: cause?.message,
    });
    this.name = 'CRDInstanceError';
  }
}

/**
 * Error thrown when schema validation fails for Kro compatibility
 */
export class KroSchemaValidationError extends TypeKroError {
  constructor(
    message: string,
    public readonly schemaType: 'spec' | 'status',
    public readonly fieldPath: string,
    public readonly expectedType: string,
    public readonly actualType: string,
    public readonly suggestions?: string[]
  ) {
    super(message, 'KRO_SCHEMA_VALIDATION_ERROR', {
      schemaType,
      fieldPath,
      expectedType,
      actualType,
      suggestions,
    });
    this.name = 'KroSchemaValidationError';
  }
}

/**
 * Error thrown when imperative composition execution fails
 * Provides detailed context about which resource or phase caused the failure
 */
export class CompositionExecutionError extends TypeKroError {
  constructor(
    message: string,
    public readonly compositionName: string,
    public readonly phase: 'resource-creation' | 'status-building' | 'validation' | 'context-setup',
    public readonly resourceContext?: {
      resourceId?: string;
      resourceKind?: string;
      factoryName?: string;
    },
    public readonly cause?: Error
  ) {
    super(message, 'COMPOSITION_EXECUTION_ERROR', {
      compositionName,
      phase,
      resourceContext,
      cause: cause?.message,
      stack: cause?.stack,
    });
    this.name = 'CompositionExecutionError';
  }

  /**
   * Create a composition error with resource context
   */
  static withResourceContext(
    message: string,
    compositionName: string,
    phase: 'resource-creation' | 'status-building' | 'validation' | 'context-setup',
    resourceId: string,
    resourceKind: string,
    factoryName: string,
    cause?: Error
  ): CompositionExecutionError {
    const contextualMessage = `${message}\n  Resource: ${resourceId} (${resourceKind})\n  Factory: ${factoryName}`;
    return new CompositionExecutionError(
      contextualMessage,
      compositionName,
      phase,
      { resourceId, resourceKind, factoryName },
      cause
    );
  }

  /**
   * Create a composition error for status building failures
   */
  static forStatusBuilding(
    compositionName: string,
    fieldPath: string,
    expectedType: string,
    actualValue: unknown,
    cause?: Error
  ): CompositionExecutionError {
    const message = `Status object validation failed in composition '${compositionName}' at field '${fieldPath}':\n  Expected: ${expectedType}\n  Received: ${typeof actualValue} (${JSON.stringify(actualValue)})`;
    return new CompositionExecutionError(
      message,
      compositionName,
      'status-building',
      undefined,
      cause
    );
  }

  /**
   * Create a composition error for unsupported patterns
   */
  static forUnsupportedPattern(
    compositionName: string,
    pattern: string,
    suggestions: string[]
  ): CompositionExecutionError {
    const message = `Unsupported pattern in composition '${compositionName}': ${pattern}\n\nSuggestions:\n${suggestions.map((s) => `  - ${s}`).join('\n')}`;
    return new CompositionExecutionError(message, compositionName, 'validation');
  }
}

/**
 * Error thrown when resource registration with composition context fails
 * Provides detailed context about the registration failure and suggestions for resolution
 */
export class ContextRegistrationError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceId: string,
    public readonly resourceKind: string,
    public readonly factoryName: string,
    public readonly registrationPhase:
      | 'id-generation'
      | 'context-storage'
      | 'duplicate-detection'
      | 'validation',
    public readonly suggestions?: string[],
    public readonly cause?: Error
  ) {
    super(message, 'CONTEXT_REGISTRATION_ERROR', {
      resourceId,
      resourceKind,
      factoryName,
      registrationPhase,
      suggestions,
      cause: cause?.message,
      stack: cause?.stack,
    });
    this.name = 'ContextRegistrationError';
  }

  /**
   * Create an error for duplicate resource registration
   */
  static forDuplicateResource(
    resourceId: string,
    resourceKind: string,
    factoryName: string,
    existingFactoryName: string
  ): ContextRegistrationError {
    const message = `Duplicate resource registration: Resource '${resourceId}' (${resourceKind}) is already registered.\n  Original factory: ${existingFactoryName}\n  Attempted factory: ${factoryName}`;

    const suggestions = [
      `Use a unique name for the ${resourceKind} resource`,
      `Check if you're calling the same factory function multiple times`,
      `Consider using different resource names or namespaces`,
      `Use conditional logic to avoid creating duplicate resources`,
    ];

    return new ContextRegistrationError(
      message,
      resourceId,
      resourceKind,
      factoryName,
      'duplicate-detection',
      suggestions
    );
  }

  /**
   * Create an error for context not available
   */
  static forMissingContext(
    resourceId: string,
    resourceKind: string,
    factoryName: string
  ): ContextRegistrationError {
    const message = `Resource registration failed: No composition context available for resource '${resourceId}' (${resourceKind}).\n  Factory: ${factoryName}`;

    const suggestions = [
      `Ensure the factory function is called within a kubernetesComposition() function`,
      `Check that AsyncLocalStorage is properly configured`,
      `Verify that the composition context is not being lost across async boundaries`,
      `Consider using the factory function outside of composition if context is not needed`,
    ];

    return new ContextRegistrationError(
      message,
      resourceId,
      resourceKind,
      factoryName,
      'context-storage',
      suggestions
    );
  }

  /**
   * Create an error for invalid resource ID generation
   */
  static forInvalidResourceId(
    resourceId: string,
    resourceKind: string,
    factoryName: string,
    reason: string
  ): ContextRegistrationError {
    const message = `Invalid resource ID generated: '${resourceId}' for ${resourceKind} resource.\n  Factory: ${factoryName}\n  Reason: ${reason}`;

    const suggestions = [
      `Provide a valid 'name' property in the factory function config`,
      `Ensure resource names follow Kubernetes naming conventions`,
      `Check that the name doesn't contain invalid characters`,
      `Use alphanumeric characters and hyphens only`,
    ];

    return new ContextRegistrationError(
      message,
      resourceId,
      resourceKind,
      factoryName,
      'id-generation',
      suggestions
    );
  }
}
/**
 * Error thrown when JavaScript to CEL expression conversion fails
 * Provides detailed context about the conversion failure with source mapping
 */
/**
 * Error thrown when status hydration fails
 * Provides detailed context about deployment state and resource failures
 */
export class StatusHydrationError extends TypeKroError {
  constructor(
    message: string,
    public readonly instanceName: string,
    public readonly deploymentStatus: 'failed' | 'partial' | 'success',
    public readonly failedResources?: Array<{
      id: string;
      kind: string;
      name: string;
      error: string;
    }>,
    public readonly celError?: string,
    public readonly suggestions?: string[]
  ) {
    super(message, 'STATUS_HYDRATION_ERROR', {
      instanceName,
      deploymentStatus,
      failedResources,
      celError,
      suggestions,
    });
    this.name = 'StatusHydrationError';
  }

  /**
   * Create error for failed deployment
   */
  static forFailedDeployment(
    instanceName: string,
    failedResources: Array<{ id: string; kind: string; name: string; error: string }>
  ): StatusHydrationError {
    const message =
      `Cannot hydrate status for '${instanceName}': deployment failed.\n\n` +
      `Failed resources (${failedResources.length}):\n` +
      failedResources
        .map((r, i) => `  ${i + 1}. ${r.kind}/${r.name} (${r.id})\n     Error: ${r.error}`)
        .join('\n');

    const suggestions = [
      'Check the deployment errors above to identify the root cause',
      'Ensure all required resources can be deployed successfully',
      'Verify that dependencies (like webhooks) are ready before deploying dependent resources',
      'Use waitForReady: true to ensure resources are fully deployed before status hydration',
    ];

    return new StatusHydrationError(
      message,
      instanceName,
      'failed',
      failedResources,
      undefined,
      suggestions
    );
  }

  /**
   * Create error for partial deployment
   */
  static forPartialDeployment(
    instanceName: string,
    failedResources: Array<{ id: string; kind: string; name: string; error: string }>,
    successCount: number
  ): StatusHydrationError {
    const message =
      `Cannot hydrate status for '${instanceName}': partial deployment.\n\n` +
      `${successCount} resources succeeded, ${failedResources.length} failed:\n` +
      failedResources
        .map((r, i) => `  ${i + 1}. ${r.kind}/${r.name} (${r.id})\n     Error: ${r.error}`)
        .join('\n');

    const suggestions = [
      'Fix the failed resources listed above',
      'All resources must deploy successfully for status hydration',
      'Check deployment logs for detailed error information',
    ];

    return new StatusHydrationError(
      message,
      instanceName,
      'partial',
      failedResources,
      undefined,
      suggestions
    );
  }

  /**
   * Create error for CEL evaluation failure
   */
  static forCelEvaluationFailure(
    instanceName: string,
    celExpression: string,
    celError: string,
    resourceContext?: string
  ): StatusHydrationError {
    let message =
      `Status hydration failed for '${instanceName}': CEL expression evaluation error.\n\n` +
      `Expression: ${celExpression}\n` +
      `Error: ${celError}`;

    if (resourceContext) {
      message += `\nResource context: ${resourceContext}`;
    }

    const suggestions = [
      'Check if the referenced resource field exists and is populated',
      'Ensure all resources have completed deployment and have status fields',
      'Verify that waitForReady: true is set to ensure resources are ready',
      'Use optional chaining (?.) in CEL expressions for fields that might not exist',
    ];

    return new StatusHydrationError(
      message,
      instanceName,
      'success',
      undefined,
      celError,
      suggestions
    );
  }
}

/**
 * Error thrown when a Kubernetes API operation fails
 * Wraps HTTP-level failures from the K8s API server
 */
export class KubernetesApiOperationError extends TypeKroError {
  constructor(
    message: string,
    public readonly operation: 'apply' | 'get' | 'delete' | 'list' | 'patch' | 'watch',
    public readonly resourceKind?: string,
    public readonly resourceName?: string,
    public readonly statusCode?: number,
    public readonly cause?: Error
  ) {
    super(message, 'KUBERNETES_API_OPERATION_ERROR', {
      operation,
      resourceKind,
      resourceName,
      statusCode,
      cause: cause?.message,
    });
    this.name = 'KubernetesApiOperationError';
  }
}

/**
 * Error thrown when the Kubernetes client provider fails to initialize or configure
 */
export class KubernetesClientError extends TypeKroError {
  constructor(
    message: string,
    public readonly operation:
      | 'initialization'
      | 'configuration'
      | 'client-creation'
      | 'cluster-availability',
    public readonly cause?: Error
  ) {
    super(message, 'KUBERNETES_CLIENT_ERROR', {
      operation,
      cause: cause?.message,
    });
    this.name = 'KubernetesClientError';
  }
}

/**
 * Error thrown when a deployment operation times out
 */
export class DeploymentTimeoutError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceKind: string,
    public readonly resourceName: string,
    public readonly timeoutMs: number,
    public readonly operation: 'readiness' | 'deletion' | 'crd-establishment' | 'instance-readiness'
  ) {
    super(message, 'DEPLOYMENT_TIMEOUT', {
      resourceKind,
      resourceName,
      timeoutMs,
      operation,
    });
    this.name = 'DeploymentTimeoutError';
  }
}

export class ConversionError extends TypeKroError {
  constructor(
    message: string,
    public readonly originalExpression: string,
    public readonly expressionType:
      | 'javascript'
      | 'template-literal'
      | 'function-call'
      | 'member-access'
      | 'binary-operation'
      | 'conditional'
      | 'optional-chaining'
      | 'nullish-coalescing'
      | 'magic-assignable'
      | 'magic-assignable-shape'
      | 'unknown',
    public readonly sourceLocation?: {
      line: number;
      column: number;
      length: number;
    },
    public readonly context?: {
      analysisContext: 'status' | 'resource' | 'condition' | 'readiness';
      availableReferences?: string[];
      schemaFields?: string[];
    },
    public readonly suggestions?: string[],
    public readonly cause?: Error
  ) {
    super(message, 'CONVERSION_ERROR', {
      originalExpression,
      expressionType,
      sourceLocation,
      context,
      suggestions,
      cause: cause?.message,
      stack: cause?.stack,
    });
    this.name = 'ConversionError';
  }

  /**
   * Alias for originalExpression to maintain compatibility with tests
   */
  get expression(): string {
    return this.originalExpression;
  }

  /**
   * Create a conversion error for unsupported JavaScript syntax
   */
  static forUnsupportedSyntax(
    originalExpression: string,
    syntaxType: string,
    sourceLocation?: { line: number; column: number; length: number },
    suggestions?: string[]
  ): ConversionError {
    const message = `Unsupported JavaScript syntax in expression: ${syntaxType}\n  Expression: ${originalExpression}`;

    const defaultSuggestions = [
      'Use supported JavaScript patterns (binary operators, member access, conditionals)',
      'Consider using CEL expressions directly with Cel.expr() or Cel.template()',
      'Check the documentation for supported expression patterns',
    ];

    return new ConversionError(
      message,
      originalExpression,
      'javascript',
      sourceLocation,
      undefined,
      suggestions || defaultSuggestions
    );
  }

  /**
   * Create a conversion error for KubernetesRef resolution failures
   */
  static forKubernetesRefResolution(
    originalExpression: string,
    kubernetesRefPath: string,
    availableReferences: string[],
    sourceLocation?: { line: number; column: number; length: number }
  ): ConversionError {
    const message = `Failed to resolve KubernetesRef in expression: ${kubernetesRefPath}\n  Expression: ${originalExpression}\n  Available references: ${availableReferences.join(', ')}`;

    const suggestions = [
      `Check that the referenced resource '${kubernetesRefPath.split('.')[0]}' exists in your resource graph`,
      'Verify the field path is correct for the referenced resource type',
      'Ensure the resource is available in the current context (status builder, resource builder, etc.)',
      'Use optional chaining (?.) if the field might not be available',
    ];

    return new ConversionError(
      message,
      originalExpression,
      'member-access',
      sourceLocation,
      { analysisContext: 'status', availableReferences },
      suggestions
    );
  }

  /**
   * Create a conversion error for template literal conversion failures
   */
  static forTemplateLiteral(
    originalExpression: string,
    templateParts: string[],
    failedExpressionIndex: number,
    sourceLocation?: { line: number; column: number; length: number },
    cause?: Error
  ): ConversionError {
    const failedPart = templateParts[failedExpressionIndex] || 'unknown';
    const message = `Failed to convert template literal expression\n  Template: ${originalExpression}\n  Failed part: ${failedPart}`;

    const suggestions = [
      'Ensure all template expressions contain valid JavaScript syntax',
      'Use simple expressions in template literals (avoid complex nested expressions)',
      'Consider breaking complex templates into multiple CEL expressions',
      'Use Cel.template() directly for complex string formatting',
    ];

    return new ConversionError(
      message,
      originalExpression,
      'template-literal',
      sourceLocation,
      undefined,
      suggestions,
      cause
    );
  }

  /**
   * Create a conversion error for function call conversion failures
   */
  static forFunctionCall(
    originalExpression: string,
    functionName: string,
    supportedMethods: string[],
    sourceLocation?: { line: number; column: number; length: number }
  ): ConversionError {
    const message = `Unsupported function call in expression: ${functionName}\n  Expression: ${originalExpression}\n  Supported methods: ${supportedMethods.join(', ')}`;

    const suggestions = [
      `Use one of the supported methods: ${supportedMethods.join(', ')}`,
      'Consider using CEL expressions for complex operations',
      'Check if the operation can be simplified to basic JavaScript patterns',
      'Use Cel.expr() for custom CEL expressions if needed',
    ];

    return new ConversionError(
      message,
      originalExpression,
      'function-call',
      sourceLocation,
      undefined,
      suggestions
    );
  }

  /**
   * Create a conversion error for parsing failures
   */
  static forParsingFailure(
    originalExpression: string,
    parsingError: string,
    sourceLocation?: { line: number; column: number; length: number },
    cause?: Error
  ): ConversionError {
    const message = `Failed to parse JavaScript expression\n  Expression: ${originalExpression}\n  Parse error: ${parsingError}`;

    const suggestions = [
      'Check for syntax errors in the JavaScript expression',
      'Ensure proper bracket and parenthesis matching',
      'Verify that all string literals are properly quoted',
      'Use simpler expressions if the syntax is too complex',
    ];

    return new ConversionError(
      message,
      originalExpression,
      'javascript',
      sourceLocation,
      undefined,
      suggestions,
      cause
    );
  }

  /**
   * Create a conversion error for context-specific failures
   */
  static forContextMismatch(
    originalExpression: string,
    currentContext: 'status' | 'resource' | 'condition' | 'readiness',
    requiredContext: 'status' | 'resource' | 'condition' | 'readiness',
    sourceLocation?: { line: number; column: number; length: number }
  ): ConversionError {
    const message = `Expression not valid in current context\n  Expression: ${originalExpression}\n  Current context: ${currentContext}\n  Required context: ${requiredContext}`;

    const suggestions = [
      `Move this expression to a ${requiredContext} context`,
      'Check that you are using the correct type of references for this context',
      'Verify that the expression is in the right part of your resource graph definition',
    ];

    return new ConversionError(
      message,
      originalExpression,
      'javascript',
      sourceLocation,
      { analysisContext: currentContext },
      suggestions
    );
  }

  /**
   * Get a formatted error message with source location and suggestions
   */
  getFormattedMessage(): string {
    let formatted = this.message;

    if (this.sourceLocation) {
      formatted += `\n  Location: Line ${this.sourceLocation.line}, Column ${this.sourceLocation.column}`;
    }

    if (this.context) {
      formatted += `\n  Context: ${this.context.analysisContext}`;
      if (this.context.availableReferences?.length) {
        formatted += `\n  Available references: ${this.context.availableReferences.join(', ')}`;
      }
    }

    if (this.suggestions?.length) {
      formatted += `\n\nSuggestions:`;
      this.suggestions.forEach((suggestion, index) => {
        formatted += `\n  ${index + 1}. ${suggestion}`;
      });
    }

    return formatted;
  }
}

/**
 * Safely coerce an unknown caught value into an {@link Error} instance.
 *
 * In TypeScript, `catch` clauses type the caught value as `unknown`.
 * Using `error as Error` is an unsafe cast — the thrown value might
 * be a string, number, `null`, or any other non-Error type.
 *
 * This utility eliminates all `as Error` casts by returning the
 * original value when it is already an `Error`, or wrapping it in
 * a new `Error` otherwise.
 *
 * @example
 * ```ts
 * try { ... } catch (error: unknown) {
 *   logger.error('Failed', ensureError(error));
 * }
 * ```
 */
export function ensureError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  return new Error(String(value));
}
