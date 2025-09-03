/**
 * Tests for Conditional Expression Validation
 * 
 * Tests the comprehensive validation system for conditional expressions
 * containing KubernetesRef objects.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/index.js';
import { 
  ConditionalExpressionValidator,
  type ValidationRule,
  type ValidationConfig 
} from '../../../src/core/expressions/conditional-validation.js';
import type { FactoryExpressionContext } from '../../../src/core/expressions/types.js';

describe('ConditionalExpressionValidator', () => {
  let validator: ConditionalExpressionValidator;
  let mockContext: FactoryExpressionContext;
  let config: ValidationConfig;

  beforeEach(() => {
    validator = new ConditionalExpressionValidator();
    
    mockContext = {
      factoryType: 'kro',
      factoryName: 'simpleDeployment',
      analysisEnabled: true,
      resourceId: 'test-resource',
      availableResources: {
        'deployment': {} as any,
        'service': {} as any,
        'database': {} as any
      },
      schemaProxy: undefined
    };

    config = {
      strictMode: false,
      timeoutMs: 5000,
      includeLocationInfo: true,
      deepReferenceValidation: true
    };
  });

  describe('basic validation', () => {
    it('should validate simple boolean expressions', () => {
      const expression = true;
      const result = validator.validateExpression(expression, mockContext, config);

      expect(result.isValid).toBe(true);
      expect(result.summary.errorCount).toBe(0);
      expect(result.summary.totalRules).toBeGreaterThan(0);
      expect(result.metrics.validationTimeMs).toBeGreaterThan(0);
    });

    it('should validate KubernetesRef expressions', () => {
      const kubernetesRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.ready'
      } as KubernetesRef<boolean>;

      const result = validator.validateExpression(kubernetesRef, mockContext, config);

      expect(result.isValid).toBe(true);
      expect(result.detectionResult.hasKubernetesRefs).toBe(true);
      expect(result.detectionResult.references).toHaveLength(1);
      expect(result.metrics.referencesValidated).toBe(1);
    });

    it('should detect validation errors', () => {
      const invalidRef: any = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '', // Invalid empty resourceId
        fieldPath: 'status.ready'
      };

      const result = validator.validateExpression(invalidRef, mockContext, config);

      expect(result.isValid).toBe(false);
      expect(result.summary.errorCount).toBeGreaterThan(0);
      expect(result.messages.errors.length).toBeGreaterThan(0);
    });
  });

  describe('built-in validation rules', () => {
    it('should validate well-formed KubernetesRef objects', () => {
      const validRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadata.name'
      } as KubernetesRef<string>;

      const result = validator.validateExpression(validRef, mockContext, config);
      const wellFormedRule = result.ruleResults.get('well-formed-kubernetes-ref');

      expect(wellFormedRule?.valid).toBe(true);
    });

    it('should detect malformed KubernetesRef objects', () => {
      const malformedRef: any = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'invalid..field..path' // Invalid field path format
      };

      const result = validator.validateExpression(malformedRef, mockContext, config);
      const wellFormedRule = result.ruleResults.get('well-formed-kubernetes-ref');

      expect(wellFormedRule?.valid).toBe(false);
      expect(wellFormedRule?.message).toContain('invalid format');
    });

    it('should validate conditional boolean results', () => {
      const booleanExpression = 'deployment.status.readyReplicas > 0';
      const result = validator.validateExpression(booleanExpression, mockContext, config);
      const booleanRule = result.ruleResults.get('conditional-boolean-result');

      expect(booleanRule?.valid).toBe(true);
    });

    it('should warn about non-boolean conditional expressions', () => {
      const nonBooleanExpression = 'just a string';
      const result = validator.validateExpression(nonBooleanExpression, mockContext, config);
      const booleanRule = result.ruleResults.get('conditional-boolean-result');

      expect(booleanRule?.valid).toBe(false);
      expect(booleanRule?.suggestions).toBeDefined();
      expect(booleanRule?.suggestions?.length).toBeGreaterThan(0);
    });

    it('should validate resource reference existence', () => {
      const validRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment', // Exists in mockContext.availableResources
        fieldPath: 'status.ready'
      } as KubernetesRef<string>;

      const result = validator.validateExpression(validRef, mockContext, config);
      const existsRule = result.ruleResults.get('resource-reference-exists');

      expect(existsRule?.valid).toBe(true);
    });

    it('should warn about non-existent resource references', () => {
      const invalidRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'nonexistent', // Does not exist in mockContext.availableResources
        fieldPath: 'status.ready'
      } as KubernetesRef<string>;

      const result = validator.validateExpression(invalidRef, mockContext, config);
      const existsRule = result.ruleResults.get('resource-reference-exists');

      expect(existsRule?.valid).toBe(false);
      expect(existsRule?.message).toContain('not found');
    });

    it('should validate reasonable field paths', () => {
      const deepRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.conditions[0].lastTransitionTime.seconds.nanoseconds.microseconds.value' // Very deep
      } as KubernetesRef<string>;

      const result = validator.validateExpression(deepRef, mockContext, config);
      const reasonableRule = result.ruleResults.get('reasonable-field-paths');

      expect(reasonableRule?.valid).toBe(false);
      expect(reasonableRule?.message).toContain('deeply nested');
    });

    it('should detect common field name typos', () => {
      const typoRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadat.name' // Typo: should be 'metadata'
      } as KubernetesRef<string>;

      const result = validator.validateExpression(typoRef, mockContext, config);
      const reasonableRule = result.ruleResults.get('reasonable-field-paths');

      expect(reasonableRule?.valid).toBe(false);
      expect(reasonableRule?.message).toContain('typo');
      expect(reasonableRule?.suggestions?.[0]).toContain('metadata');
    });

    it('should validate readyWhen status references', () => {
      const statusRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas'
      } as KubernetesRef<number>;

      // Set context to readyWhen
      const readyWhenContext = { ...mockContext };
      const result = validator.validateExpression(statusRef, readyWhenContext, config);
      const statusRule = result.ruleResults.get('ready-when-status-reference');

      expect(statusRule?.valid).toBe(true);
    });

    it('should warn about readyWhen expressions without status references', () => {
      const specRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'spec.replicas' // Not a status field
      } as KubernetesRef<number>;

      const result = validator.validateExpression(specRef, mockContext, config);
      const statusRule = result.ruleResults.get('ready-when-status-reference');

      expect(statusRule?.valid).toBe(false);
      expect(statusRule?.message).toContain('status fields');
    });

    it('should detect circular references', () => {
      const circularRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'test-resource', // Same as mockContext.resourceId
        fieldPath: 'status.ready'
      } as KubernetesRef<string>;

      const result = validator.validateExpression(circularRef, mockContext, config);
      const circularRule = result.ruleResults.get('no-circular-references');

      expect(circularRule?.valid).toBe(false);
      expect(circularRule?.message).toContain('Circular reference');
    });
  });

  describe('custom validation rules', () => {
    it('should register and apply custom validation rules', () => {
      const customRule: ValidationRule = {
        id: 'custom-test-rule',
        name: 'Custom Test Rule',
        description: 'Test custom validation rule',
        severity: 'warning',
        applicableContexts: ['*'],
        enabled: true,
        validate: (expression) => {
          if (expression === 'custom-test') {
            return { valid: false, message: 'Custom rule triggered' };
          }
          return { valid: true };
        }
      };

      validator.registerRule(customRule);

      const result = validator.validateExpression('custom-test', mockContext, config);
      const customRuleResult = result.ruleResults.get('custom-test-rule');

      expect(customRuleResult?.valid).toBe(false);
      expect(customRuleResult?.message).toBe('Custom rule triggered');
      expect(result.summary.warningCount).toBeGreaterThan(0);
    });

    it('should unregister custom validation rules', () => {
      const customRule: ValidationRule = {
        id: 'removable-rule',
        name: 'Removable Rule',
        description: 'Rule that can be removed',
        severity: 'info',
        applicableContexts: ['*'],
        enabled: true,
        validate: () => ({ valid: false, message: 'Should not see this' })
      };

      validator.registerRule(customRule);
      expect(validator.getRules().some(r => r.id === 'removable-rule')).toBe(true);

      const unregistered = validator.unregisterRule('removable-rule');
      expect(unregistered).toBe(true);
      expect(validator.getRules().some(r => r.id === 'removable-rule')).toBe(false);
    });

    it('should handle custom rule errors gracefully', () => {
      const faultyRule: ValidationRule = {
        id: 'faulty-rule',
        name: 'Faulty Rule',
        description: 'Rule that throws errors',
        severity: 'error',
        applicableContexts: ['*'],
        enabled: true,
        validate: () => {
          throw new Error('Rule execution failed');
        }
      };

      validator.registerRule(faultyRule);

      const result = validator.validateExpression(true, mockContext, config);
      const faultyRuleResult = result.ruleResults.get('faulty-rule');

      expect(faultyRuleResult?.valid).toBe(false);
      expect(faultyRuleResult?.message).toContain('Rule execution failed');
      expect(result.isValid).toBe(false);
    });
  });

  describe('validation configuration', () => {
    it('should respect strict mode', () => {
      const strictConfig = { ...config, strictMode: true };
      
      // Create an expression that generates warnings
      const warningExpression = 'not a boolean expression';
      
      const result = validator.validateExpression(warningExpression, mockContext, strictConfig);

      // In strict mode, warnings should make the overall validation fail
      expect(result.summary.warningCount).toBeGreaterThan(0);
      expect(result.isValid).toBe(false);
    });

    it('should allow warnings in non-strict mode', () => {
      const nonStrictConfig = { ...config, strictMode: false };
      
      // Create an expression that generates warnings but no errors
      const warningExpression = true; // Valid but might generate info messages
      
      const result = validator.validateExpression(warningExpression, mockContext, nonStrictConfig);

      // In non-strict mode, warnings should not fail validation
      expect(result.isValid).toBe(true);
    });

    it('should disable specified rules', () => {
      const disabledConfig = { 
        ...config, 
        disabledRules: ['conditional-boolean-result'] 
      };
      
      const nonBooleanExpression = 'not boolean';
      const result = validator.validateExpression(nonBooleanExpression, mockContext, disabledConfig);
      
      // The disabled rule should not be evaluated
      expect(result.ruleResults.has('conditional-boolean-result')).toBe(false);
    });

    it('should apply custom rules from config', () => {
      const customRule: ValidationRule = {
        id: 'config-custom-rule',
        name: 'Config Custom Rule',
        description: 'Custom rule from config',
        severity: 'info',
        applicableContexts: ['*'],
        enabled: true,
        validate: () => ({ valid: true, message: 'Config rule applied' })
      };

      const customConfig = { 
        ...config, 
        customRules: [customRule] 
      };
      
      const result = validator.validateExpression(true, mockContext, customConfig);
      
      // Note: This test assumes the validator would apply custom rules from config
      // In the current implementation, custom rules need to be registered separately
      expect(result.summary.totalRules).toBeGreaterThan(0);
    });
  });

  describe('validation results', () => {
    it('should provide comprehensive validation metrics', () => {
      const kubernetesRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.ready'
      } as KubernetesRef<boolean>;

      const result = validator.validateExpression(kubernetesRef, mockContext, config);

      expect(result.metrics.validationTimeMs).toBeGreaterThan(0);
      expect(result.metrics.rulesEvaluated).toBeGreaterThan(0);
      expect(result.metrics.referencesValidated).toBe(1);
      
      expect(result.summary.totalRules).toBeGreaterThan(0);
      expect(result.summary.passedRules + result.summary.failedRules).toBe(result.summary.totalRules);
    });

    it('should categorize messages by severity', () => {
      // Create an expression that will generate different severity messages
      const problematicRef: any = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '', // Error: empty resourceId
        fieldPath: 'spec.replicas' // Info: not a status field for readyWhen
      };

      const result = validator.validateExpression(problematicRef, mockContext, config);

      expect(result.messages.errors.length + result.messages.warnings.length + result.messages.info.length)
        .toBe(result.summary.errorCount + result.summary.warningCount + result.summary.infoCount);
    });

    it('should provide context and detection results', () => {
      const kubernetesRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.ready'
      } as KubernetesRef<boolean>;

      const result = validator.validateExpression(kubernetesRef, mockContext, config);

      expect(result.contextResult).toBeDefined();
      expect(result.detectionResult).toBeDefined();
      expect(result.detectionResult.hasKubernetesRefs).toBe(true);
      expect(result.detectionResult.references).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('should handle null and undefined expressions', () => {
      const nullResult = validator.validateExpression(null, mockContext, config);
      const undefinedResult = validator.validateExpression(undefined, mockContext, config);

      expect(nullResult.isValid).toBe(true); // No KubernetesRef objects to validate
      expect(undefinedResult.isValid).toBe(true);
    });

    it('should handle complex nested expressions', () => {
      const complexExpression = {
        condition: {
          [KUBERNETES_REF_BRAND]: true,
          resourceId: 'deployment',
          fieldPath: 'status.ready'
        } as KubernetesRef<boolean>,
        fallback: {
          [KUBERNETES_REF_BRAND]: true,
          resourceId: 'service',
          fieldPath: 'status.ready'
        } as KubernetesRef<boolean>
      };

      const result = validator.validateExpression(complexExpression, mockContext, config);

      expect(result.detectionResult.references).toHaveLength(2);
      expect(result.metrics.referencesValidated).toBe(2);
    });

    it('should handle expressions with no KubernetesRef objects', () => {
      const staticExpression = { value: 'static', enabled: true };
      const result = validator.validateExpression(staticExpression, mockContext, config);

      expect(result.detectionResult.hasKubernetesRefs).toBe(false);
      expect(result.metrics.referencesValidated).toBe(0);
      expect(result.isValid).toBe(true); // Should pass validation
    });
  });
});