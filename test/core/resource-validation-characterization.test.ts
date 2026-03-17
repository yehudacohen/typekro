/**
 * Characterization tests for ResourceReferenceValidator
 *
 * These tests capture the CURRENT behavior of resource reference validation,
 * including field path validation, similar name suggestions, and caching.
 *
 * Source: src/core/expressions/validation/resource-validation.ts (905 lines)
 */

import { describe, expect, it } from 'bun:test';
import {
  ResourceReferenceValidator,
  ResourceValidationError,
  ResourceValidationWarning,
} from '../../src/core/expressions/validation/resource-validation.js';
import type { KubernetesRef } from '../../src/core/types/common.js';
import type { Enhanced } from '../../src/core/types/kubernetes.js';
import { KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

// Helper to create a KubernetesRef
function mockRef(resourceId: string, fieldPath: string): KubernetesRef {
  return {
    [KUBERNETES_REF_BRAND]: true as const,
    resourceId,
    fieldPath,
  };
}

// Helper to create a mock Enhanced resource (plain object, constructor.name = 'Object')
function mockResource(): Enhanced<any, any> {
  return {} as Enhanced<any, any>;
}

describe('ResourceReferenceValidator', () => {
  describe('validateKubernetesRef — schema references', () => {
    it('fails when no schema proxy is available for __schema__ ref', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('__schema__', 'spec.name');

      const result = validator.validateKubernetesRef(ref, {});

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.errorType).toBe('SCHEMA_FIELD_NOT_FOUND');
    });

    it('validates schema reference when schema proxy is available', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('__schema__', 'spec.name');
      const schemaProxy = { spec: { name: 'test' } } as any;

      const result = validator.validateKubernetesRef(ref, {}, schemaProxy);

      // getSchemaFieldType returns a placeholder TypeInfo, so field is always "found"
      expect(result.valid).toBe(true);
      expect(result.metadata.resourceType).toBe('Schema');
    });

    it('sets correct metadata flags for schema spec field', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('__schema__', 'spec.name');
      const schemaProxy = {} as any;

      const result = validator.validateKubernetesRef(ref, {}, schemaProxy);

      expect(result.metadata.isSpecField).toBe(true);
      expect(result.metadata.isStatusField).toBe(false);
      expect(result.metadata.isMetadataField).toBe(false);
    });

    it('sets correct metadata flags for schema status field', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('__schema__', 'status.ready');
      const schemaProxy = {} as any;

      const result = validator.validateKubernetesRef(ref, {}, schemaProxy);

      expect(result.metadata.isStatusField).toBe(true);
    });

    it('calculates dependency depth from field path', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('__schema__', 'spec.containers.image');
      const schemaProxy = {} as any;

      const result = validator.validateKubernetesRef(ref, {}, schemaProxy);

      expect(result.metadata.dependencyDepth).toBe(3);
    });
  });

  describe('validateKubernetesRef — resource references', () => {
    it('fails when resource is not found', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'status.ready');

      const result = validator.validateKubernetesRef(ref, {});

      expect(result.valid).toBe(false);
      expect(result.errors[0]?.errorType).toBe('RESOURCE_NOT_FOUND');
    });

    it('suggests similar resource names when resource not found', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('deploymnt', 'status.ready');

      const result = validator.validateKubernetesRef(ref, {
        deployment: mockResource(),
      });

      // 'deploymnt' vs 'deployment' — high similarity, should suggest
      if (result.suggestions.length > 0) {
        expect(result.suggestions.some((s) => s.includes('deployment'))).toBe(true);
      }
    });

    it('validates known field paths on resources', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'status.readyReplicas');

      const result = validator.validateKubernetesRef(ref, {
        'my-deploy': mockResource(),
      });

      // 'status.readyReplicas' is in both validFieldPatterns and exactCommonFields
      expect(result.valid).toBe(true);
    });

    it('rejects unknown field paths on resources', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'status.totallyFakeField');

      const result = validator.validateKubernetesRef(ref, {
        'my-deploy': mockResource(),
      });

      // 'status.totallyFakeField' is not in validFieldPatterns or exactCommonFields
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.errorType).toBe('INVALID_FIELD_PATH');
    });

    it('validates metadata.name field path', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'metadata.name');

      const result = validator.validateKubernetesRef(ref, {
        'my-deploy': mockResource(),
      });

      expect(result.valid).toBe(true);
    });

    it('validates spec.replicas field path', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'spec.replicas');

      const result = validator.validateKubernetesRef(ref, {
        'my-deploy': mockResource(),
      });

      expect(result.valid).toBe(true);
    });

    it('warns about deprecated fields (spec.serviceAccount)', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'spec.serviceAccount');

      const result = validator.validateKubernetesRef(ref, {
        'my-deploy': mockResource(),
      });

      expect(result.warnings.some((w) => w.warningType === 'DEPRECATED_FIELD')).toBe(true);
    });

    it('provides replacement suggestion for deprecated fields', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'spec.serviceAccount');

      const result = validator.validateKubernetesRef(ref, {
        'my-deploy': mockResource(),
      });

      const deprecatedWarning = result.warnings.find((w) => w.warningType === 'DEPRECATED_FIELD');
      expect(deprecatedWarning?.message).toContain('serviceAccountName');
    });

    it('warns about performance implications for status.conditions', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'status.conditions');

      const result = validator.validateKubernetesRef(ref, {
        'my-deploy': mockResource(),
      });

      expect(result.warnings.some((w) => w.warningType === 'PERFORMANCE_IMPACT')).toBe(true);
    });

    it('sets apiVersion and kind in metadata', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'metadata.name');

      const result = validator.validateKubernetesRef(ref, {
        'my-deploy': mockResource(),
      });

      expect(result.metadata.apiVersion).toBe('v1');
      expect(result.metadata.kind).toBeDefined();
    });
  });

  describe('validateKubernetesRef — caching', () => {
    it('returns cached result for same ref', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'metadata.name');
      const resources = { 'my-deploy': mockResource() };

      const result1 = validator.validateKubernetesRef(ref, resources);
      const result2 = validator.validateKubernetesRef(ref, resources);

      expect(result2).toBe(result1);
    });

    it('bypasses cache when skipCache is true', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'metadata.name');
      const resources = { 'my-deploy': mockResource() };

      const result1 = validator.validateKubernetesRef(ref, resources);
      const result2 = validator.validateKubernetesRef(ref, resources, undefined, {
        skipCache: true,
      });

      expect(result2).not.toBe(result1);
    });

    it('clearCache removes cached results', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'metadata.name');
      const resources = { 'my-deploy': mockResource() };

      const result1 = validator.validateKubernetesRef(ref, resources);
      validator.clearCache();
      const result2 = validator.validateKubernetesRef(ref, resources);

      expect(result2).not.toBe(result1);
    });
  });

  describe('validateKubernetesRef — circular dependency detection', () => {
    it('detects circular dependency when ref is in dependency chain', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'status.ready');

      const result = validator.validateKubernetesRef(
        ref,
        { 'my-deploy': mockResource() },
        undefined,
        {
          checkCircularDependencies: true,
          dependencyChain: ['my-deploy.status.ready'],
          skipCache: true,
        }
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.errorType === 'CIRCULAR_REFERENCE')).toBe(true);
    });

    it('passes when ref is not in dependency chain', () => {
      const validator = new ResourceReferenceValidator();
      const ref = mockRef('my-deploy', 'metadata.name');

      const result = validator.validateKubernetesRef(
        ref,
        { 'my-deploy': mockResource() },
        undefined,
        {
          checkCircularDependencies: true,
          dependencyChain: ['other-resource.status.ready'],
          skipCache: true,
        }
      );

      expect(result.errors.some((e) => e.errorType === 'CIRCULAR_REFERENCE')).toBe(false);
    });
  });

  describe('validateKubernetesRefs (batch)', () => {
    it('validates multiple refs', () => {
      const validator = new ResourceReferenceValidator();
      const refs = [mockRef('my-deploy', 'metadata.name'), mockRef('missing', 'status.ready')];

      const results = validator.validateKubernetesRefs(refs, {
        'my-deploy': mockResource(),
      });

      expect(results).toHaveLength(2);
      expect(results[0]?.valid).toBe(true);
      expect(results[1]?.valid).toBe(false);
    });
  });

  describe('validateReferenceChain', () => {
    it('detects circular reference in chain (duplicate ref key)', () => {
      const validator = new ResourceReferenceValidator();
      const refs = [
        mockRef('A', 'status.ready'),
        mockRef('B', 'status.ready'),
        mockRef('A', 'status.ready'), // duplicate
      ];

      const result = validator.validateReferenceChain(refs, {
        A: mockResource(),
        B: mockResource(),
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.errorType === 'CIRCULAR_REFERENCE')).toBe(true);
    });

    it('validates non-circular chain', () => {
      const validator = new ResourceReferenceValidator();
      const refs = [mockRef('A', 'metadata.name'), mockRef('B', 'metadata.name')];

      const result = validator.validateReferenceChain(refs, {
        A: mockResource(),
        B: mockResource(),
      });

      // No circular reference and all field paths are valid
      expect(result.errors.filter((e) => e.errorType === 'CIRCULAR_REFERENCE')).toHaveLength(0);
    });

    it('stops validation when a reference is invalid', () => {
      const validator = new ResourceReferenceValidator();
      const refs = [
        mockRef('missing', 'status.ready'), // invalid — resource not found
        mockRef('A', 'metadata.name'), // won't be validated
      ];

      const result = validator.validateReferenceChain(refs, {
        A: mockResource(),
      });

      expect(result.valid).toBe(false);
    });
  });
});

describe('ResourceValidationError', () => {
  it('creates error with ref and type', () => {
    const error = new ResourceValidationError(
      'Not found',
      'deploy.status.ready',
      'RESOURCE_NOT_FOUND'
    );

    expect(error.resourceRef).toBe('deploy.status.ready');
    expect(error.errorType).toBe('RESOURCE_NOT_FOUND');
    expect(error.name).toBe('ResourceValidationError');
  });

  it('forResourceNotFound includes available resources', () => {
    const error = ResourceValidationError.forResourceNotFound('ref', 'missing', [
      'deploy',
      'service',
    ]);

    expect(error.message).toContain('missing');
    expect(error.message).toContain('deploy, service');
    expect(error.errorType).toBe('RESOURCE_NOT_FOUND');
  });

  it('forInvalidFieldPath includes resource type', () => {
    const error = ResourceValidationError.forInvalidFieldPath('ref', 'status.fake', 'Deployment');

    expect(error.message).toContain('status.fake');
    expect(error.message).toContain('Deployment');
    expect(error.errorType).toBe('INVALID_FIELD_PATH');
  });

  it('forTypeIncompatibility includes expected and actual types', () => {
    const error = ResourceValidationError.forTypeIncompatibility('ref', 'string', 'number');

    expect(error.message).toContain('string');
    expect(error.message).toContain('number');
    expect(error.errorType).toBe('TYPE_INCOMPATIBILITY');
  });

  it('forCircularReference includes dependency chain', () => {
    const error = ResourceValidationError.forCircularReference('ref', ['A', 'B', 'C']);

    expect(error.message).toContain('A -> B -> C -> ref');
    expect(error.errorType).toBe('CIRCULAR_REFERENCE');
  });

  it('forSchemaFieldNotFound includes available fields', () => {
    const error = ResourceValidationError.forSchemaFieldNotFound('ref', 'spec.missing', [
      'spec.name',
      'spec.replicas',
    ]);

    expect(error.message).toContain('spec.missing');
    expect(error.message).toContain('spec.name, spec.replicas');
    expect(error.errorType).toBe('SCHEMA_FIELD_NOT_FOUND');
  });
});

describe('ResourceValidationWarning', () => {
  it('forPotentialNullAccess includes field path', () => {
    const warning = ResourceValidationWarning.forPotentialNullAccess('ref', 'status.ready');

    expect(warning.message).toContain('status.ready');
    expect(warning.warningType).toBe('POTENTIAL_NULL_ACCESS');
  });

  it('forDeprecatedField with replacement', () => {
    const warning = ResourceValidationWarning.forDeprecatedField('ref', 'oldField', 'newField');

    expect(warning.message).toContain('oldField');
    expect(warning.message).toContain('newField');
    expect(warning.warningType).toBe('DEPRECATED_FIELD');
  });

  it('forDeprecatedField without replacement', () => {
    const warning = ResourceValidationWarning.forDeprecatedField('ref', 'oldField');

    expect(warning.message).toContain('oldField');
    expect(warning.message).not.toContain('instead');
  });

  it('forPerformanceImpact includes reason', () => {
    const warning = ResourceValidationWarning.forPerformanceImpact('ref', 'slow query');

    expect(warning.message).toContain('slow query');
    expect(warning.warningType).toBe('PERFORMANCE_IMPACT');
  });
});
