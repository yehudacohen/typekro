/**
 * Characterization tests for src/core/errors.ts
 *
 * These tests capture the CURRENT behavior of all error classes,
 * format functions, and utility functions. They serve as a safety net
 * for refactoring.
 *
 * Source: src/core/errors.ts (969 lines)
 */

import { describe, expect, it } from 'bun:test';
import {
  CircularDependencyError,
  CompositionExecutionError,
  ContextRegistrationError,
  ConversionError,
  CRDInstanceError,
  DeploymentTimeoutError,
  ensureError,
  formatArktypeError,
  formatCircularDependencyError,
  formatReferenceError,
  KroSchemaValidationError,
  KubernetesApiOperationError,
  KubernetesClientError,
  ResourceGraphFactoryError,
  StatusHydrationError,
  TypeKroError,
  TypeKroReferenceError,
  ValidationError,
} from '../../src/core/errors.js';

describe('TypeKroError (base class)', () => {
  it('creates error with message, code, and context', () => {
    const error = new TypeKroError('test message', 'TEST_CODE', { key: 'value' });

    expect(error.message).toBe('test message');
    expect(error.code).toBe('TEST_CODE');
    expect(error.context).toEqual({ key: 'value' });
    expect(error.name).toBe('TypeKroError');
  });

  it('extends Error', () => {
    const error = new TypeKroError('msg', 'CODE');
    expect(error).toBeInstanceOf(Error);
  });

  it('context is optional', () => {
    const error = new TypeKroError('msg', 'CODE');
    expect(error.context).toBeUndefined();
  });

  it('supports ErrorOptions (cause)', () => {
    const cause = new Error('root cause');
    const error = new TypeKroError('msg', 'CODE', undefined, { cause });
    expect(error.cause).toBe(cause);
  });

  it('has a stack trace', () => {
    const error = new TypeKroError('msg', 'CODE');
    expect(error.stack).toBeDefined();
  });
});

describe('ValidationError', () => {
  it('creates with resource kind, name, field, and suggestions', () => {
    const error = new ValidationError('Invalid spec', 'Deployment', 'my-deploy', 'spec.replicas', [
      'Set replicas to a positive integer',
    ]);

    expect(error.message).toBe('Invalid spec');
    expect(error.resourceKind).toBe('Deployment');
    expect(error.resourceName).toBe('my-deploy');
    expect(error.field).toBe('spec.replicas');
    expect(error.suggestions).toEqual(['Set replicas to a positive integer']);
    expect(error.name).toBe('ValidationError');
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('extends TypeKroError', () => {
    const error = new ValidationError('msg', 'Svc', 'svc1');
    expect(error).toBeInstanceOf(TypeKroError);
    expect(error).toBeInstanceOf(Error);
  });

  it('field and suggestions are optional', () => {
    const error = new ValidationError('msg', 'Pod', 'pod1');
    expect(error.field).toBeUndefined();
    expect(error.suggestions).toBeUndefined();
  });
});

describe('TypeKroReferenceError', () => {
  it('creates with from/to resource and field path', () => {
    const error = new TypeKroReferenceError(
      'Reference failed',
      'resourceA',
      'resourceB',
      'status.ready',
      ['Check resource name']
    );

    expect(error.fromResource).toBe('resourceA');
    expect(error.toResource).toBe('resourceB');
    expect(error.fieldPath).toBe('status.ready');
    expect(error.suggestions).toEqual(['Check resource name']);
    expect(error.name).toBe('TypeKroReferenceError');
    expect(error.code).toBe('REFERENCE_ERROR');
  });
});

describe('CircularDependencyError', () => {
  it('creates with cycle and suggestions', () => {
    const error = new CircularDependencyError(
      'Circular detected',
      ['A', 'B', 'C'],
      ['Break the cycle']
    );

    expect(error.cycle).toEqual(['A', 'B', 'C']);
    expect(error.suggestions).toEqual(['Break the cycle']);
    expect(error.name).toBe('CircularDependencyError');
    expect(error.code).toBe('CIRCULAR_DEPENDENCY');
  });
});

describe('formatArktypeError', () => {
  it('formats error with problems array', () => {
    const arkError = {
      summary: 'Validation failed',
      problems: [
        {
          path: ['spec', 'replicas'] as const,
          expected: 'number',
          actual: 'hello',
          code: 'type',
        },
      ],
    };

    const result = formatArktypeError(arkError, 'Deployment', 'my-deploy', {});

    expect(result).toBeInstanceOf(ValidationError);
    expect(result.message).toContain('spec.replicas');
    expect(result.message).toContain('number');
    expect(result.message).toContain('"hello"');
    expect(result.field).toBe('spec.replicas');
    expect(result.suggestions).toBeDefined();
  });

  it('returns generic error when problems array is empty', () => {
    const arkError = {
      summary: 'Something wrong',
      problems: [],
    };

    const result = formatArktypeError(arkError, 'Service', 'svc1', {});

    expect(result.message).toContain('Invalid Service spec');
    expect(result.message).toContain('Something wrong');
    expect(result.suggestions).toContain('Check the resource specification against the schema');
  });

  it('generates suggestions for missing field code', () => {
    const arkError = {
      summary: 'missing field',
      problems: [
        {
          path: ['spec', 'name'] as const,
          expected: 'string',
          actual: undefined,
          code: 'missing',
        },
      ],
    };

    const result = formatArktypeError(arkError, 'ConfigMap', 'cm1', {});

    expect(result.suggestions?.some((s) => s.includes("required field 'spec.name'"))).toBe(true);
    expect(result.suggestions?.some((s) => s.includes('Example:'))).toBe(true);
  });

  it('generates suggestions for type mismatch code', () => {
    const arkError = {
      summary: 'type error',
      problems: [
        {
          path: ['spec', 'type'] as const,
          expected: 'ClusterIP | NodePort | LoadBalancer',
          actual: 'invalid',
          code: 'type',
        },
      ],
    };

    const result = formatArktypeError(arkError, 'Service', 'svc1', {});

    expect(result.suggestions?.some((s) => s.includes('Valid options'))).toBe(true);
  });

  it('lists additional errors when multiple problems exist', () => {
    const arkError = {
      summary: 'multiple errors',
      problems: [
        { path: ['field1'] as const, expected: 'string', actual: 42, code: 'type' },
        {
          path: ['field2'] as const,
          expected: 'number',
          actual: 'x',
          code: 'type',
          message: 'wrong type at field2',
        },
      ],
    };

    const result = formatArktypeError(arkError, 'Pod', 'pod1', {});

    expect(result.message).toContain('Additional validation errors');
    expect(result.message).toContain('wrong type at field2');
    expect(result.suggestions?.some((s) => s.includes('Fix all 2 validation errors'))).toBe(true);
  });

  it('works with iterable ArkErrors (no .problems property)', () => {
    const arkError = {
      summary: 'iterable errors',
      [Symbol.iterator]: function* () {
        yield { path: ['field'] as const, expected: 'string', actual: 42, code: 'type' };
      },
    };

    const result = formatArktypeError(arkError, 'Deployment', 'dep1', {});

    expect(result.field).toBe('field');
  });

  it('handles problems with no path — defaults to root', () => {
    const arkError = {
      summary: 'root error',
      problems: [{ expected: 'object', actual: null, code: 'type' }],
    };

    const result = formatArktypeError(arkError, 'ConfigMap', 'cm1', {});

    expect(result.field).toBe('root');
  });
});

describe('formatReferenceError', () => {
  it('creates reference error with suggestions', () => {
    const result = formatReferenceError('resourceA', 'resourceB', 'status.ready', [
      'resourceA',
      'resourceB',
      'resourceC',
    ]);

    expect(result).toBeInstanceOf(TypeKroReferenceError);
    expect(result.message).toContain('resourceA');
    expect(result.message).toContain('resourceB');
    expect(result.message).toContain('status.ready');
    expect(result.suggestions?.some((s) => s.includes('Available resources'))).toBe(true);
  });

  it('suggests similar resource names via Levenshtein distance', () => {
    const result = formatReferenceError(
      'source',
      'deploymnt', // typo — Levenshtein distance to 'deployment' is 1
      'status.ready',
      ['deployment', 'service', 'configmap']
    );

    expect(result.suggestions?.some((s) => s.includes('Did you mean'))).toBe(true);
  });

  it('suggests resources that contain the target as substring', () => {
    const result = formatReferenceError('source', 'deploy', 'status.ready', [
      'my-deployment',
      'service',
    ]);

    // 'my-deployment' includes 'deploy' → suggested
    expect(result.suggestions?.some((s) => s.includes('my-deployment'))).toBe(true);
  });

  it('includes generic suggestions even when no similar names found', () => {
    const result = formatReferenceError('source', 'xyz', 'status', ['abc', 'def']);

    expect(result.suggestions?.some((s) => s.includes('toResourceGraph'))).toBe(true);
  });
});

describe('formatCircularDependencyError', () => {
  it('formats cycle with arrow notation', () => {
    const result = formatCircularDependencyError(['A', 'B', 'C']);

    expect(result).toBeInstanceOf(CircularDependencyError);
    expect(result.message).toContain('A → B → C → A');
    expect(result.cycle).toEqual(['A', 'B', 'C']);
  });

  it('provides 4 suggestions', () => {
    const result = formatCircularDependencyError(['X', 'Y']);

    expect(result.suggestions).toHaveLength(4);
    expect(result.suggestions?.some((s) => s.includes('Remove one of the dependencies'))).toBe(
      true
    );
  });
});

describe('ResourceGraphFactoryError', () => {
  it('creates with factory name, operation, and cause', () => {
    const cause = new Error('original');
    const error = new ResourceGraphFactoryError(
      'Deployment failed',
      'myFactory',
      'deployment',
      cause
    );

    expect(error.factoryName).toBe('myFactory');
    expect(error.operation).toBe('deployment');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('ResourceGraphFactoryError');
    expect(error.code).toBe('RESOURCE_GRAPH_FACTORY_ERROR');
  });

  it('cause is optional', () => {
    const error = new ResourceGraphFactoryError('msg', 'factory', 'cleanup');
    expect(error.cause).toBeUndefined();
  });
});

describe('CRDInstanceError', () => {
  it('creates with all fields', () => {
    const cause = new Error('api failed');
    const error = new CRDInstanceError(
      'CRD creation failed',
      'example.com/v1alpha1',
      'MyResource',
      'my-instance',
      'creation',
      cause
    );

    expect(error.apiVersion).toBe('example.com/v1alpha1');
    expect(error.kind).toBe('MyResource');
    expect(error.instanceName).toBe('my-instance');
    expect(error.operation).toBe('creation');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('CRDInstanceError');
  });
});

describe('KroSchemaValidationError', () => {
  it('creates with schema type, field path, and type info', () => {
    const error = new KroSchemaValidationError(
      'Invalid schema',
      'spec',
      'spec.replicas',
      'integer',
      'string',
      ['Use a number for replicas']
    );

    expect(error.schemaType).toBe('spec');
    expect(error.fieldPath).toBe('spec.replicas');
    expect(error.expectedType).toBe('integer');
    expect(error.actualType).toBe('string');
    expect(error.suggestions).toEqual(['Use a number for replicas']);
    expect(error.name).toBe('KroSchemaValidationError');
  });
});

describe('CompositionExecutionError', () => {
  it('creates with composition name and phase', () => {
    const error = new CompositionExecutionError(
      'Execution failed',
      'myComposition',
      'resource-creation'
    );

    expect(error.compositionName).toBe('myComposition');
    expect(error.phase).toBe('resource-creation');
    expect(error.name).toBe('CompositionExecutionError');
    expect(error.code).toBe('COMPOSITION_EXECUTION_ERROR');
  });

  it('includes resource context when provided', () => {
    const error = new CompositionExecutionError('Failed', 'comp', 'resource-creation', {
      resourceId: 'deploy1',
      resourceKind: 'Deployment',
      factoryName: 'deployment',
    });

    expect(error.resourceContext?.resourceId).toBe('deploy1');
  });

  describe('static factory: withResourceContext', () => {
    it('creates error with contextual message including resource details', () => {
      const error = CompositionExecutionError.withResourceContext(
        'Resource creation failed',
        'myComp',
        'resource-creation',
        'my-deploy',
        'Deployment',
        'deployment'
      );

      expect(error.message).toContain('Resource: my-deploy (Deployment)');
      expect(error.message).toContain('Factory: deployment');
      expect(error.resourceContext?.resourceId).toBe('my-deploy');
    });
  });

  describe('static factory: forStatusBuilding', () => {
    it('creates error with field path and type info', () => {
      const error = CompositionExecutionError.forStatusBuilding(
        'myComp',
        'status.ready',
        'boolean',
        'not-a-boolean'
      );

      expect(error.phase).toBe('status-building');
      expect(error.message).toContain('status.ready');
      expect(error.message).toContain('boolean');
      expect(error.message).toContain('"not-a-boolean"');
    });
  });

  describe('static factory: forUnsupportedPattern', () => {
    it('creates error with pattern and suggestions', () => {
      const error = CompositionExecutionError.forUnsupportedPattern('myComp', 'arrow function', [
        'Use a regular function',
        'Use Cel.expr()',
      ]);

      expect(error.phase).toBe('validation');
      expect(error.message).toContain('arrow function');
      expect(error.message).toContain('Use a regular function');
    });
  });
});

describe('ContextRegistrationError', () => {
  it('creates with all fields', () => {
    const error = new ContextRegistrationError(
      'Registration failed',
      'res1',
      'Deployment',
      'deployment',
      'duplicate-detection',
      ['Use unique names']
    );

    expect(error.resourceId).toBe('res1');
    expect(error.resourceKind).toBe('Deployment');
    expect(error.factoryName).toBe('deployment');
    expect(error.registrationPhase).toBe('duplicate-detection');
    expect(error.name).toBe('ContextRegistrationError');
  });

  describe('static factory: forDuplicateResource', () => {
    it('creates error with duplicate resource details', () => {
      const error = ContextRegistrationError.forDuplicateResource(
        'my-deploy',
        'Deployment',
        'deployment',
        'existingFactory'
      );

      expect(error.message).toContain('Duplicate resource registration');
      expect(error.message).toContain('my-deploy');
      expect(error.message).toContain('existingFactory');
      expect(error.registrationPhase).toBe('duplicate-detection');
      expect(error.suggestions).toHaveLength(4);
    });
  });

  describe('static factory: forMissingContext', () => {
    it('creates error with context suggestions', () => {
      const error = ContextRegistrationError.forMissingContext('res1', 'Service', 'service');

      expect(error.message).toContain('No composition context available');
      expect(error.registrationPhase).toBe('context-storage');
      expect(error.suggestions?.some((s) => s.includes('kubernetesComposition'))).toBe(true);
    });
  });

  describe('static factory: forInvalidResourceId', () => {
    it('creates error with reason and naming suggestions', () => {
      const error = ContextRegistrationError.forInvalidResourceId(
        'INVALID_ID!',
        'ConfigMap',
        'configMap',
        'Contains invalid characters'
      );

      expect(error.message).toContain('Invalid resource ID');
      expect(error.message).toContain('Contains invalid characters');
      expect(error.registrationPhase).toBe('id-generation');
      expect(error.suggestions?.some((s) => s.includes('Kubernetes naming conventions'))).toBe(
        true
      );
    });
  });
});

describe('StatusHydrationError', () => {
  it('creates with basic fields', () => {
    const error = new StatusHydrationError('Hydration failed', 'instance1', 'failed');

    expect(error.instanceName).toBe('instance1');
    expect(error.deploymentStatus).toBe('failed');
    expect(error.name).toBe('StatusHydrationError');
    expect(error.code).toBe('STATUS_HYDRATION_ERROR');
  });

  describe('static factory: forFailedDeployment', () => {
    it('creates error listing failed resources', () => {
      const failed = [
        { id: 'dep1', kind: 'Deployment', name: 'my-deploy', error: 'timeout' },
        { id: 'svc1', kind: 'Service', name: 'my-svc', error: 'port conflict' },
      ];

      const error = StatusHydrationError.forFailedDeployment('instance1', failed);

      expect(error.deploymentStatus).toBe('failed');
      expect(error.failedResources).toHaveLength(2);
      expect(error.message).toContain('my-deploy');
      expect(error.message).toContain('timeout');
      expect(error.message).toContain('Failed resources (2)');
      expect(error.suggestions?.some((s) => s.includes('root cause'))).toBe(true);
    });
  });

  describe('static factory: forPartialDeployment', () => {
    it('creates error with success and failure counts', () => {
      const failed = [{ id: 'dep1', kind: 'Deployment', name: 'my-deploy', error: 'timeout' }];

      const error = StatusHydrationError.forPartialDeployment('instance1', failed, 3);

      expect(error.deploymentStatus).toBe('partial');
      expect(error.message).toContain('3 resources succeeded');
      expect(error.message).toContain('1 failed');
    });
  });

  describe('static factory: forCelEvaluationFailure', () => {
    it('creates error with CEL expression details', () => {
      const error = StatusHydrationError.forCelEvaluationFailure(
        'instance1',
        'resources.deploy.status.ready > 0',
        'undefined variable: deploy',
        'Deployment/my-deploy'
      );

      expect(error.deploymentStatus).toBe('success');
      expect(error.celError).toBe('undefined variable: deploy');
      expect(error.message).toContain('resources.deploy.status.ready > 0');
      expect(error.message).toContain('Deployment/my-deploy');
    });

    it('omits resource context when not provided', () => {
      const error = StatusHydrationError.forCelEvaluationFailure('instance1', 'expr', 'error');

      expect(error.message).not.toContain('Resource context');
    });
  });
});

describe('KubernetesApiOperationError', () => {
  it('creates with operation type and optional resource details', () => {
    const cause = new Error('404 not found');
    const error = new KubernetesApiOperationError(
      'Get failed',
      'get',
      'Deployment',
      'my-deploy',
      404,
      cause
    );

    expect(error.operation).toBe('get');
    expect(error.resourceKind).toBe('Deployment');
    expect(error.resourceName).toBe('my-deploy');
    expect(error.statusCode).toBe(404);
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('KubernetesApiOperationError');
  });
});

describe('KubernetesClientError', () => {
  it('creates with operation type', () => {
    const error = new KubernetesClientError('Cannot connect', 'cluster-availability');

    expect(error.operation).toBe('cluster-availability');
    expect(error.name).toBe('KubernetesClientError');
    expect(error.code).toBe('KUBERNETES_CLIENT_ERROR');
  });
});

describe('DeploymentTimeoutError', () => {
  it('creates with resource kind, name, timeout, and operation', () => {
    const error = new DeploymentTimeoutError(
      'Timed out waiting for readiness',
      'Deployment',
      'my-deploy',
      30000,
      'readiness'
    );

    expect(error.resourceKind).toBe('Deployment');
    expect(error.resourceName).toBe('my-deploy');
    expect(error.timeoutMs).toBe(30000);
    expect(error.operation).toBe('readiness');
    expect(error.name).toBe('DeploymentTimeoutError');
    expect(error.code).toBe('DEPLOYMENT_TIMEOUT');
  });
});

describe('ConversionError', () => {
  it('creates with all fields', () => {
    const error = new ConversionError(
      'Conversion failed',
      'a === b',
      'binary-operation',
      { line: 1, column: 0, length: 7 },
      { analysisContext: 'status', availableReferences: ['deploy'] },
      ['Use == instead'],
      new Error('parse error')
    );

    expect(error.originalExpression).toBe('a === b');
    expect(error.expressionType).toBe('binary-operation');
    expect(error.sourceLocation).toEqual({ line: 1, column: 0, length: 7 });
    expect(error.name).toBe('ConversionError');
    expect(error.code).toBe('CONVERSION_ERROR');
  });

  it('expression getter returns originalExpression', () => {
    const error = new ConversionError('msg', 'a + b', 'javascript');
    expect(error.expression).toBe('a + b');
  });

  describe('static factory: forUnsupportedSyntax', () => {
    it('creates error with syntax type and default suggestions', () => {
      const error = ConversionError.forUnsupportedSyntax('a?.b', 'optional chaining');

      expect(error.message).toContain('optional chaining');
      expect(error.message).toContain('a?.b');
      expect(error.expressionType).toBe('javascript');
      expect(error.suggestions).toHaveLength(3);
    });

    it('uses custom suggestions when provided', () => {
      const error = ConversionError.forUnsupportedSyntax('expr', 'type', undefined, ['custom']);
      expect(error.suggestions).toEqual(['custom']);
    });
  });

  describe('static factory: forKubernetesRefResolution', () => {
    it('creates error with available references', () => {
      const error = ConversionError.forKubernetesRefResolution(
        'resources.missing.status',
        'missing',
        ['deploy', 'service']
      );

      expect(error.expressionType).toBe('member-access');
      expect(error.message).toContain('deploy, service');
      expect(error.context?.analysisContext).toBe('status');
      expect(error.context?.availableReferences).toEqual(['deploy', 'service']);
    });
  });

  describe('static factory: forTemplateLiteral', () => {
    it('creates error with template parts and failed index', () => {
      const error = ConversionError.forTemplateLiteral('`hello ${name}`', ['name'], 0);

      expect(error.expressionType).toBe('template-literal');
      expect(error.message).toContain('name');
    });

    it('handles out-of-bounds index gracefully', () => {
      const error = ConversionError.forTemplateLiteral('`test`', ['a'], 5);
      expect(error.message).toContain('unknown');
    });
  });

  describe('static factory: forFunctionCall', () => {
    it('creates error with function name and supported methods', () => {
      const error = ConversionError.forFunctionCall('arr.map(x => x)', 'map', [
        'includes',
        'startsWith',
        'endsWith',
      ]);

      expect(error.expressionType).toBe('function-call');
      expect(error.message).toContain('map');
      expect(error.message).toContain('includes, startsWith, endsWith');
    });
  });

  describe('static factory: forParsingFailure', () => {
    it('creates error with parsing details', () => {
      const cause = new Error('SyntaxError');
      const error = ConversionError.forParsingFailure(
        'invalid{{expr',
        'Unexpected token',
        undefined,
        cause
      );

      expect(error.expressionType).toBe('javascript');
      expect(error.message).toContain('Unexpected token');
      expect(error.cause).toBe(cause);
    });
  });

  describe('static factory: forContextMismatch', () => {
    it('creates error with current and required context', () => {
      const error = ConversionError.forContextMismatch(
        'resources.deploy.status.ready',
        'resource',
        'status'
      );

      expect(error.message).toContain('Current context: resource');
      expect(error.message).toContain('Required context: status');
      expect(error.context?.analysisContext).toBe('resource');
    });
  });

  describe('getFormattedMessage', () => {
    it('includes source location when present', () => {
      const error = new ConversionError('Error occurred', 'expr', 'javascript', {
        line: 10,
        column: 5,
        length: 3,
      });

      const formatted = error.getFormattedMessage();
      expect(formatted).toContain('Line 10, Column 5');
    });

    it('includes context when present', () => {
      const error = new ConversionError('Error', 'expr', 'javascript', undefined, {
        analysisContext: 'status',
        availableReferences: ['deploy', 'service'],
      });

      const formatted = error.getFormattedMessage();
      expect(formatted).toContain('Context: status');
      expect(formatted).toContain('deploy, service');
    });

    it('includes numbered suggestions', () => {
      const error = new ConversionError('Error', 'expr', 'javascript', undefined, undefined, [
        'First suggestion',
        'Second suggestion',
      ]);

      const formatted = error.getFormattedMessage();
      expect(formatted).toContain('1. First suggestion');
      expect(formatted).toContain('2. Second suggestion');
    });

    it('returns just the message when no extra context', () => {
      const error = new ConversionError('Simple error', 'expr', 'javascript');

      const formatted = error.getFormattedMessage();
      expect(formatted).toBe('Simple error');
    });
  });
});

describe('ensureError', () => {
  it('returns Error instances as-is', () => {
    const error = new Error('test');
    expect(ensureError(error)).toBe(error);
  });

  it('returns TypeKroError instances as-is', () => {
    const error = new TypeKroError('test', 'CODE');
    expect(ensureError(error)).toBe(error);
  });

  it('wraps string values in Error', () => {
    const result = ensureError('string error');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('string error');
  });

  it('wraps null in Error via String()', () => {
    const result = ensureError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('null');
  });

  it('wraps undefined in Error via String()', () => {
    const result = ensureError(undefined);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('undefined');
  });

  it('wraps numbers in Error via String()', () => {
    const result = ensureError(42);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('42');
  });

  it('wraps objects in Error via String()', () => {
    const result = ensureError({ key: 'value' });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('[object Object]');
  });

  it('wraps boolean in Error via String()', () => {
    const result = ensureError(false);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('false');
  });
});

describe('error hierarchy', () => {
  it('all custom errors extend TypeKroError', () => {
    expect(new ValidationError('m', 'k', 'n')).toBeInstanceOf(TypeKroError);
    expect(new TypeKroReferenceError('m', 'f', 't', 'p')).toBeInstanceOf(TypeKroError);
    expect(new CircularDependencyError('m', [])).toBeInstanceOf(TypeKroError);
    expect(new ResourceGraphFactoryError('m', 'f', 'deployment')).toBeInstanceOf(TypeKroError);
    expect(new CRDInstanceError('m', 'v', 'k', 'n', 'creation')).toBeInstanceOf(TypeKroError);
    expect(new KroSchemaValidationError('m', 'spec', 'p', 'e', 'a')).toBeInstanceOf(TypeKroError);
    expect(new CompositionExecutionError('m', 'c', 'validation')).toBeInstanceOf(TypeKroError);
    expect(new ContextRegistrationError('m', 'r', 'k', 'f', 'validation')).toBeInstanceOf(
      TypeKroError
    );
    expect(new StatusHydrationError('m', 'i', 'failed')).toBeInstanceOf(TypeKroError);
    expect(new KubernetesApiOperationError('m', 'get')).toBeInstanceOf(TypeKroError);
    expect(new KubernetesClientError('m', 'initialization')).toBeInstanceOf(TypeKroError);
    expect(new DeploymentTimeoutError('m', 'k', 'n', 1000, 'readiness')).toBeInstanceOf(
      TypeKroError
    );
    expect(new ConversionError('m', 'e', 'javascript')).toBeInstanceOf(TypeKroError);
  });

  it('all custom errors are instanceof Error', () => {
    expect(new ValidationError('m', 'k', 'n')).toBeInstanceOf(Error);
    expect(new ConversionError('m', 'e', 'javascript')).toBeInstanceOf(Error);
    expect(new StatusHydrationError('m', 'i', 'failed')).toBeInstanceOf(Error);
  });
});
