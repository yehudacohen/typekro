/**
 * Enhanced error handling for TypeKro
 * Provides detailed, actionable error messages with context
 */

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
 * Simple Levenshtein distance calculation for suggesting similar resource names
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = Array(str2.length + 1)
    .fill(null)
    .map(() => Array(str1.length + 1).fill(0));

  for (let i = 0; i <= str1.length; i++) matrix[0]![i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j]![0] = j;

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j]![i] = Math.min(
        matrix[j]?.[i - 1]! + 1,
        matrix[j - 1]?.[i]! + 1,
        matrix[j - 1]?.[i - 1]! + indicator
      );
    }
  }

  return matrix[str2.length]?.[str1.length]!;
}

/**
 * Utility functions for detecting and reporting unsupported patterns in compositions
 */
/**
 * Debugging utilities for composition execution
 */
export class CompositionDebugger {
  private static debugMode = false;
  private static debugLog: string[] = [];

  /**
   * Enable debug mode for composition execution
   */
  static enableDebugMode(): void {
    CompositionDebugger.debugMode = true;
    CompositionDebugger.debugLog = [];
  }

  /**
   * Disable debug mode
   */
  static disableDebugMode(): void {
    CompositionDebugger.debugMode = false;
    CompositionDebugger.debugLog = [];
  }

  /**
   * Check if debug mode is enabled
   */
  static isDebugEnabled(): boolean {
    return CompositionDebugger.debugMode;
  }

  /**
   * Add a debug log entry
   */
  static log(phase: string, message: string, context?: Record<string, any>): void {
    if (!CompositionDebugger.debugMode) return;

    const timestamp = new Date().toISOString();
    const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
    const logEntry = `[${timestamp}] ${phase}: ${message}${contextStr}`;

    CompositionDebugger.debugLog.push(logEntry);

    // Also log to console if in development
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[TypeKro Composition] ${logEntry}`);
    }
  }

  /**
   * Get all debug logs
   */
  static getDebugLogs(): string[] {
    return [...CompositionDebugger.debugLog];
  }

  /**
   * Clear debug logs
   */
  static clearDebugLogs(): void {
    CompositionDebugger.debugLog = [];
  }

  /**
   * Create a debug summary for composition execution
   */
  static createDebugSummary(
    compositionName: string,
    resourceCount: number,
    executionTimeMs: number,
    statusFields: string[]
  ): string {
    const summary = [
      `=== Composition Debug Summary ===`,
      `Composition: ${compositionName}`,
      `Execution Time: ${executionTimeMs}ms`,
      `Resources Created: ${resourceCount}`,
      `Status Fields: ${statusFields.join(', ')}`,
      ``,
      `=== Debug Log ===`,
      ...CompositionDebugger.debugLog,
      `=== End Debug Summary ===`,
    ];

    return summary.join('\n');
  }

  /**
   * Log resource registration
   */
  static logResourceRegistration(
    resourceId: string,
    resourceKind: string,
    factoryName: string
  ): void {
    CompositionDebugger.log('RESOURCE_REGISTRATION', `Registered resource '${resourceId}'`, {
      resourceKind,
      factoryName,
    });
  }

  /**
   * Log composition execution start
   */
  static logCompositionStart(compositionName: string): void {
    CompositionDebugger.log('COMPOSITION_START', `Starting composition execution`, {
      compositionName,
    });
  }

  /**
   * Log composition execution end
   */
  static logCompositionEnd(
    compositionName: string,
    resourceCount: number,
    statusFields: string[]
  ): void {
    CompositionDebugger.log('COMPOSITION_END', `Completed composition execution`, {
      compositionName,
      resourceCount,
      statusFields,
    });
  }

  /**
   * Log status object validation
   */
  static logStatusValidation(
    compositionName: string,
    statusObject: any,
    validationResult: 'success' | 'failure',
    issues?: string[]
  ): void {
    CompositionDebugger.log('STATUS_VALIDATION', `Status validation ${validationResult}`, {
      compositionName,
      statusObjectKeys: Object.keys(statusObject || {}),
      issues,
    });
  }

  /**
   * Log performance metrics
   */
  static logPerformanceMetrics(
    phase: string,
    startTime: number,
    endTime: number,
    additionalMetrics?: Record<string, any>
  ): void {
    const duration = endTime - startTime;
    CompositionDebugger.log('PERFORMANCE', `${phase} completed in ${duration}ms`, {
      duration,
      ...additionalMetrics,
    });
  }
}

export class UnsupportedPatternDetector {
  /**
   * Detect unsupported JavaScript patterns in status objects
   */
  static detectUnsupportedStatusPatterns(statusObject: any, fieldPath = ''): string[] {
    const issues: string[] = [];

    if (typeof statusObject !== 'object' || statusObject === null) {
      return issues;
    }

    for (const [key, value] of Object.entries(statusObject)) {
      const currentPath = fieldPath ? `${fieldPath}.${key}` : key;

      // Skip CEL expressions and resource references - these are valid
      if (
        UnsupportedPatternDetector.isCelExpression(value) ||
        UnsupportedPatternDetector.isResourceReference(value)
      ) {
        continue;
      }

      // Check for JavaScript-specific patterns that don't work in CEL
      if (typeof value === 'string') {
        // Template literals with JavaScript expressions (but not CEL templates)
        if (value.includes('${') && !value.startsWith('${') && !value.endsWith('}')) {
          issues.push(`Template literal with JavaScript expressions at '${currentPath}': ${value}`);
        }

        // String concatenation patterns
        if (value.includes(' + ') || value.includes('` + `')) {
          issues.push(`String concatenation at '${currentPath}': ${value}`);
        }
      }

      // Check for function calls (but not CEL expressions or resource references)
      if (typeof value === 'function') {
        issues.push(`Function at '${currentPath}': Functions are not supported in status objects`);
      }

      // Check for complex JavaScript expressions
      if (typeof value === 'object' && value !== null) {
        // Recursively check nested objects
        issues.push(
          ...UnsupportedPatternDetector.detectUnsupportedStatusPatterns(value, currentPath)
        );

        // Check for JavaScript-specific object patterns
        if (Array.isArray(value)) {
          // Check for array methods like .map, .filter, etc.
          const stringified = JSON.stringify(value);
          if (
            stringified.includes('.map(') ||
            stringified.includes('.filter(') ||
            stringified.includes('.reduce(')
          ) {
            issues.push(`Array method calls at '${currentPath}': Use CEL expressions instead`);
          }
        }
      }
    }

    return issues;
  }

  /**
   * Check if a value is a CEL expression
   */
  private static isCelExpression(value: any): boolean {
    return value && typeof value === 'object' && value.__brand === 'CelExpression';
  }

  /**
   * Check if a value is a resource reference
   */
  private static isResourceReference(value: any): boolean {
    // Check for KubernetesRef brand
    if (value && typeof value === 'object' && value.__brand === 'KubernetesRef') {
      return true;
    }

    // Check for proxy objects that might be resource references
    if (
      value &&
      typeof value === 'object' &&
      value.constructor &&
      value.constructor.name === 'Object'
    ) {
      // Check if it has resource reference properties
      if (value.resourceId || value.fieldPath || value.__isProxy) {
        return true;
      }
    }

    // Check for function proxies that represent resource references
    if (typeof value === 'function' && value.__isResourceProxy) {
      return true;
    }

    return false;
  }

  /**
   * Generate suggestions for fixing unsupported patterns
   */
  static generatePatternSuggestions(pattern: string): string[] {
    const suggestions: string[] = [];

    if (pattern.includes('template literal')) {
      suggestions.push('Use Cel.template() instead of JavaScript template literals');
      suggestions.push(
        'Example: Cel.template("https://%s", hostname) instead of `https://${hostname}`'
      );
    }

    if (pattern.includes('string concatenation')) {
      suggestions.push('Use Cel.expr() for string concatenation');
      suggestions.push('Example: Cel.expr(prefix, " + ", suffix) instead of prefix + suffix');
    }

    if (pattern.includes('function')) {
      suggestions.push('Functions are not supported in status objects');
      suggestions.push('Use CEL expressions or move logic to the composition function');
    }

    if (pattern.includes('array method')) {
      suggestions.push('Use CEL expressions for array operations');
      suggestions.push('Example: Cel.expr(array, ".size()") instead of array.length');
    }

    if (pattern.includes('JavaScript expressions')) {
      suggestions.push('Replace JavaScript expressions with CEL expressions');
      suggestions.push('Use Cel.expr() for complex logic and Cel.template() for string formatting');
    }

    // General suggestions
    suggestions.push('Refer to the CEL documentation for supported operations');
    suggestions.push('Use literal values for simple cases, CEL expressions for complex logic');

    return suggestions;
  }

  /**
   * Create a comprehensive error for unsupported patterns
   */
  static createUnsupportedPatternError(
    compositionName: string,
    statusObject: any
  ): CompositionExecutionError | null {
    const issues = UnsupportedPatternDetector.detectUnsupportedStatusPatterns(statusObject);

    if (issues.length === 0) {
      return null;
    }

    const allSuggestions = new Set<string>();
    issues.forEach((issue) => {
      UnsupportedPatternDetector.generatePatternSuggestions(issue).forEach((suggestion) => {
        allSuggestions.add(suggestion);
      });
    });

    const message = `Unsupported patterns detected in composition '${compositionName}':\n\n${issues.map((issue, i) => `  ${i + 1}. ${issue}`).join('\n')}`;

    return CompositionExecutionError.forUnsupportedPattern(
      compositionName,
      message,
      Array.from(allSuggestions)
    );
  }
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
export class ConversionError extends TypeKroError {
  constructor(
    message: string,
    public readonly originalExpression: string,
    public readonly expressionType: 'javascript' | 'template-literal' | 'function-call' | 'member-access' | 'binary-operation' | 'conditional' | 'optional-chaining' | 'nullish-coalescing' | 'magic-assignable' | 'magic-assignable-shape' | 'unknown',
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