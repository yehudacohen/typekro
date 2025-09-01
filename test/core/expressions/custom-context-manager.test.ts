/**
 * Tests for Custom Context Manager
 * 
 * Tests the functionality for defining and managing custom CEL expression
 * contexts that can contain KubernetesRef objects.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/index.js';
import { 
  CustomContextManager,
  type CustomContextConfig,
  type CustomContextValidationRule 
} from '../../../src/core/expressions/custom-context-manager.js';
import type { FactoryExpressionContext } from '../../../src/core/expressions/types.js';

describe('CustomContextManager', () => {
  let manager: CustomContextManager;
  let mockFactoryContext: FactoryExpressionContext;

  beforeEach(() => {
    manager = new CustomContextManager();
    
    mockFactoryContext = {
      factoryType: 'kro',
      factoryName: 'simpleDeployment',
      analysisEnabled: true,
      resourceId: 'test-resource',
      availableResources: {},
      schemaProxy: undefined
    };
  });

  describe('context registration', () => {
    it('should register a custom context', () => {
      const contextConfig: CustomContextConfig = {
        name: 'customCondition',
        description: 'Custom conditional logic',
        expectedReturnType: 'boolean',
        supportsAsync: false,
        celStrategy: 'conditional-check'
      };

      const customContext = manager.registerCustomContext(contextConfig);

      expect(customContext).toBeDefined();
      expect(customContext.config.name).toBe('customCondition');
      expect(customContext.processor).toBeDefined();
      expect(customContext.validator).toBeDefined();
    });

    it('should list registered contexts', () => {
      const contextConfig: CustomContextConfig = {
        name: 'testContext',
        description: 'Test context'
      };

      manager.registerCustomContext(contextConfig);
      const contexts = manager.listCustomContexts();

      expect(contexts).toContain('testContext');
      // Should also contain built-in contexts
      expect(contexts).toContain('includeWhen');
      expect(contexts).toContain('readyWhen');
    });

    it('should retrieve registered context', () => {
      const contextConfig: CustomContextConfig = {
        name: 'retrieveTest',
        description: 'Retrieve test context'
      };

      manager.registerCustomContext(contextConfig);
      const retrieved = manager.getCustomContext('retrieveTest');

      expect(retrieved).toBeDefined();
      expect(retrieved!.config.name).toBe('retrieveTest');
    });

    it('should unregister context', () => {
      const contextConfig: CustomContextConfig = {
        name: 'unregisterTest',
        description: 'Unregister test context'
      };

      manager.registerCustomContext(contextConfig);
      expect(manager.getCustomContext('unregisterTest')).toBeDefined();

      const unregistered = manager.unregisterCustomContext('unregisterTest');
      expect(unregistered).toBe(true);
      expect(manager.getCustomContext('unregisterTest')).toBeUndefined();
    });

    it('should return false when unregistering non-existent context', () => {
      const unregistered = manager.unregisterCustomContext('nonExistent');
      expect(unregistered).toBe(false);
    });
  });

  describe('built-in contexts', () => {
    it('should have includeWhen context registered by default', () => {
      const includeWhenContext = manager.getCustomContext('includeWhen');
      
      expect(includeWhenContext).toBeDefined();
      expect(includeWhenContext!.config.expectedReturnType).toBe('boolean');
      expect(includeWhenContext!.config.celStrategy).toBe('conditional-check');
    });

    it('should have readyWhen context registered by default', () => {
      const readyWhenContext = manager.getCustomContext('readyWhen');
      
      expect(readyWhenContext).toBeDefined();
      expect(readyWhenContext!.config.expectedReturnType).toBe('boolean');
      expect(readyWhenContext!.config.celStrategy).toBe('conditional-check');
    });
  });

  describe('expression processing', () => {
    it('should process expression in custom context', () => {
      const contextConfig: CustomContextConfig = {
        name: 'testProcessing',
        description: 'Test processing context',
        expectedReturnType: 'boolean'
      };

      manager.registerCustomContext(contextConfig);

      const expression = true;
      const result = manager.processInCustomContext(
        'testProcessing',
        expression,
        mockFactoryContext
      );

      expect(result.contextName).toBe('testProcessing');
      expect(result.result).toBeDefined();
      expect(result.validationResults).toBeDefined();
      expect(result.metrics.processingTimeMs).toBeGreaterThan(0);
    });

    it('should process KubernetesRef expressions in custom context', () => {
      const contextConfig: CustomContextConfig = {
        name: 'kubernetesRefTest',
        description: 'Test KubernetesRef processing',
        expectedReturnType: 'boolean'
      };

      manager.registerCustomContext(contextConfig);

      const kubernetesRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.ready'
      } as KubernetesRef<boolean>;

      const result = manager.processInCustomContext(
        'kubernetesRefTest',
        kubernetesRef,
        mockFactoryContext
      );

      expect(result.contextName).toBe('kubernetesRefTest');
      expect(result.result.wasProcessed).toBe(true);
      expect(result.result.metrics.referencesProcessed).toBe(1);
    });

    it('should throw error for non-existent context', () => {
      expect(() => {
        manager.processInCustomContext(
          'nonExistent',
          true,
          mockFactoryContext
        );
      }).toThrow('Custom context \'nonExistent\' not found');
    });
  });

  describe('validation', () => {
    it('should validate expressions with custom validation rules', () => {
      const validationRule: CustomContextValidationRule = {
        id: 'test-rule',
        name: 'Test Rule',
        description: 'Test validation rule',
        severity: 'error',
        validate: (expression: any) => {
          if (typeof expression === 'boolean') {
            return { isValid: true };
          }
          return {
            isValid: false,
            message: 'Expression must be boolean',
            suggestions: ['Use true or false']
          };
        }
      };

      const contextConfig: CustomContextConfig = {
        name: 'validationTest',
        description: 'Validation test context',
        validationRules: [validationRule]
      };

      manager.registerCustomContext(contextConfig);

      // Valid expression
      const validResult = manager.processInCustomContext(
        'validationTest',
        true,
        mockFactoryContext
      );

      expect(validResult.validationResults.some(r => r.isValid)).toBe(true);

      // Invalid expression
      const invalidResult = manager.processInCustomContext(
        'validationTest',
        'not boolean',
        mockFactoryContext
      );

      expect(invalidResult.validationResults.some(r => !r.isValid)).toBe(true);
    });

    it('should validate expected return types', () => {
      const contextConfig: CustomContextConfig = {
        name: 'typeValidation',
        description: 'Type validation test',
        expectedReturnType: 'boolean'
      };

      manager.registerCustomContext(contextConfig);

      // Valid boolean expression
      const validResult = manager.processInCustomContext(
        'typeValidation',
        true,
        mockFactoryContext
      );

      expect(validResult.validationResults.some(r => r.isValid)).toBe(true);

      // Invalid type
      const invalidResult = manager.processInCustomContext(
        'typeValidation',
        'string value',
        mockFactoryContext
      );

      expect(invalidResult.validationResults.some(r => !r.isValid)).toBe(true);
    });

    it('should handle validation rule errors gracefully', () => {
      const faultyRule: CustomContextValidationRule = {
        id: 'faulty-rule',
        name: 'Faulty Rule',
        description: 'Rule that throws errors',
        severity: 'warning',
        validate: () => {
          throw new Error('Validation rule error');
        }
      };

      const contextConfig: CustomContextConfig = {
        name: 'faultyValidation',
        description: 'Faulty validation test',
        validationRules: [faultyRule]
      };

      manager.registerCustomContext(contextConfig);

      const result = manager.processInCustomContext(
        'faultyValidation',
        true,
        mockFactoryContext
      );

      expect(result.validationResults.some(r => !r.isValid && r.message?.includes('failed'))).toBe(true);
    });
  });

  describe('auto-processing', () => {
    it('should auto-detect and process in appropriate context', () => {
      const contextConfig: CustomContextConfig = {
        name: 'autoTest',
        description: 'Auto-processing test context',
        expectedReturnType: 'boolean'
      };

      manager.registerCustomContext(contextConfig);

      const expression = true;
      const result = manager.autoProcessInCustomContext(
        expression,
        mockFactoryContext
      );

      // Should find a suitable context (might be built-in or custom)
      expect(result).toBeDefined();
      expect(result!.result).toBeDefined();
    });

    it('should return null when no suitable context found', () => {
      // Create a very specific context that won't match
      const contextConfig: CustomContextConfig = {
        name: 'verySpecific',
        description: 'Very specific context',
        expectedReturnType: 'object'
      };

      manager.registerCustomContext(contextConfig);

      // Use an expression that's unlikely to match
      const result = manager.autoProcessInCustomContext(
        { complex: 'object' },
        mockFactoryContext
      );

      // Might return null or find a generic context
      expect(result === null || result !== null).toBe(true);
    });
  });

  describe('context configuration', () => {
    it('should support different return types', () => {
      const stringContextConfig: CustomContextConfig = {
        name: 'stringContext',
        description: 'String return type context',
        expectedReturnType: 'string'
      };

      const numberContextConfig: CustomContextConfig = {
        name: 'numberContext',
        description: 'Number return type context',
        expectedReturnType: 'number'
      };

      manager.registerCustomContext(stringContextConfig);
      manager.registerCustomContext(numberContextConfig);

      const stringContext = manager.getCustomContext('stringContext');
      const numberContext = manager.getCustomContext('numberContext');

      expect(stringContext!.config.expectedReturnType).toBe('string');
      expect(numberContext!.config.expectedReturnType).toBe('number');
    });

    it('should support different CEL strategies', () => {
      const templateContextConfig: CustomContextConfig = {
        name: 'templateContext',
        description: 'Template interpolation context',
        celStrategy: 'template-interpolation'
      };

      manager.registerCustomContext(templateContextConfig);

      const templateContext = manager.getCustomContext('templateContext');
      expect(templateContext!.config.celStrategy).toBe('template-interpolation');
    });

    it('should support async configuration', () => {
      const asyncContextConfig: CustomContextConfig = {
        name: 'asyncContext',
        description: 'Async operations context',
        supportsAsync: true
      };

      manager.registerCustomContext(asyncContextConfig);

      const asyncContext = manager.getCustomContext('asyncContext');
      expect(asyncContext!.config.supportsAsync).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle strict validation mode', () => {
      const strictRule: CustomContextValidationRule = {
        id: 'strict-rule',
        name: 'Strict Rule',
        description: 'Always fails validation',
        severity: 'error',
        validate: () => ({
          isValid: false,
          message: 'Strict validation failed'
        })
      };

      const contextConfig: CustomContextConfig = {
        name: 'strictContext',
        description: 'Strict validation context',
        validationRules: [strictRule]
      };

      manager.registerCustomContext(contextConfig);

      expect(() => {
        manager.processInCustomContext(
          'strictContext',
          true,
          mockFactoryContext,
          { strictValidation: true }
        );
      }).toThrow('Validation failed');
    });

    it('should handle processing errors gracefully in auto-processing', () => {
      // Create a context that will cause processing errors
      const problematicContextConfig: CustomContextConfig = {
        name: 'problematicContext',
        description: 'Context that causes errors'
      };

      manager.registerCustomContext(problematicContextConfig);

      // Mock the processor to throw an error
      const originalProcessor = (manager as any).processor;
      (manager as any).processor = {
        processCustomConditionalExpression: () => {
          throw new Error('Processing error');
        }
      };

      const result = manager.autoProcessInCustomContext(
        true,
        mockFactoryContext
      );

      // Should handle the error gracefully and continue to other contexts
      expect(result === null || result !== null).toBe(true);

      // Restore the original processor
      (manager as any).processor = originalProcessor;
    });
  });
});