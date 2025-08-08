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
  suggestions.push(
    `Make sure the referenced resource is included in your toResourceGraph() call`
  );
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
