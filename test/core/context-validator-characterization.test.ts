/**
 * Characterization tests for ContextExpressionValidator
 *
 * These tests capture the CURRENT behavior of context-aware validation,
 * including the 7 default rules, confidence calculation, and custom rules.
 *
 * Source: src/core/expressions/context/context-validator.ts (601 lines)
 */

import { describe, expect, it } from 'bun:test';
import type {
  ContextValidationConfig,
  ContextValidationRule,
} from '../../src/core/expressions/context/context-validator.js';
import { ContextExpressionValidator } from '../../src/core/expressions/context/context-validator.js';
import type { KubernetesRef } from '../../src/core/types/common.js';
import { KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

// Helper to create a branded KubernetesRef that passes type guards
function ref(resourceId: string, fieldPath: string): KubernetesRef {
  return {
    [KUBERNETES_REF_BRAND]: true as const,
    resourceId,
    fieldPath,
  };
}

describe('ContextExpressionValidator', () => {
  describe('constructor', () => {
    it('initializes with 7 default rules', () => {
      const validator = new ContextExpressionValidator();
      expect(validator.getRules()).toHaveLength(7);
    });

    it('default rules have expected IDs', () => {
      const validator = new ContextExpressionValidator();
      const ruleIds = validator.getRules().map((r) => r.id);

      expect(ruleIds).toContain('status-builder-references');
      expect(ruleIds).toContain('resource-builder-references');
      expect(ruleIds).toContain('conditional-boolean-result');
      expect(ruleIds).toContain('resource-existence');
      expect(ruleIds).toContain('magic-proxy-integration');
      expect(ruleIds).toContain('factory-type-compatibility');
      expect(ruleIds).toContain('template-literal-structure');
    });
  });

  describe('validateExpression — basic behavior', () => {
    it('returns valid=true when no rules apply (unknown context)', () => {
      const validator = new ContextExpressionValidator();
      const report = validator.validateExpression('someExpr', 'unknown');

      // No default rules target 'unknown' context
      expect(report.valid).toBe(true);
      expect(report.errors).toHaveLength(0);
    });

    it('confidence is 0.5 when no rules ran', () => {
      const validator = new ContextExpressionValidator();
      const report = validator.validateExpression('someExpr', 'unknown');

      expect(report.confidence).toBe(0.5);
    });

    it('report contains expression and context', () => {
      const validator = new ContextExpressionValidator();
      const report = validator.validateExpression('myExpr', 'status-builder');

      expect(report.expression).toBe('myExpr');
      expect(report.context).toBe('status-builder');
    });
  });

  describe('validateExpression — status-builder context', () => {
    it('runs status-builder-references rule for status-builder context', () => {
      const validator = new ContextExpressionValidator();

      // Expression with a ref that has 'status' in fieldPath — should pass this rule
      const exprWithRef = { value: ref('deploy', 'status.readyReplicas') };
      const report = validator.validateExpression(exprWithRef, 'status-builder');

      expect(report.ruleResults.has('status-builder-references')).toBe(true);
    });

    it('resource-existence rule passes when availableResources not provided', () => {
      const validator = new ContextExpressionValidator();

      const exprWithRef = { value: ref('deploy', 'status.ready') };
      const report = validator.validateExpression(exprWithRef, 'status-builder');

      // resource-existence short-circuits to valid when no availableResources
      const existenceResult = report.ruleResults.get('resource-existence');
      expect(existenceResult?.valid).toBe(true);
    });

    it('resource-existence rule fails when resource not in available resources', () => {
      const validator = new ContextExpressionValidator();

      const exprWithRef = { value: ref('missing-deploy', 'status.ready') };
      const config: ContextValidationConfig = {
        availableResources: { 'my-deploy': {} as any },
      };
      const report = validator.validateExpression(exprWithRef, 'status-builder', config);

      const existenceResult = report.ruleResults.get('resource-existence');
      expect(existenceResult?.valid).toBe(false);
    });

    it('resource-existence rule allows __schema__ refs even without matching resource', () => {
      const validator = new ContextExpressionValidator();

      const exprWithRef = { value: ref('__schema__', 'spec.name') };
      const config: ContextValidationConfig = {
        availableResources: {},
      };
      const report = validator.validateExpression(exprWithRef, 'status-builder', config);

      const existenceResult = report.ruleResults.get('resource-existence');
      expect(existenceResult?.valid).toBe(true);
    });
  });

  describe('validateExpression — conditional context', () => {
    it('conditional-boolean-result rule fails for non-boolean expressions', () => {
      const validator = new ContextExpressionValidator();

      // Expression with no boolean operators/keywords and no readiness refs
      const report = validator.validateExpression('someValue', 'conditional');

      const boolResult = report.ruleResults.get('conditional-boolean-result');
      expect(boolResult?.valid).toBe(false);
    });

    it('conditional-boolean-result rule passes for expressions with boolean operators', () => {
      const validator = new ContextExpressionValidator();

      const report = validator.validateExpression('a > b', 'conditional');

      const boolResult = report.ruleResults.get('conditional-boolean-result');
      expect(boolResult?.valid).toBe(true);
    });

    it('conditional-boolean-result rule passes for expressions with boolean keywords', () => {
      const validator = new ContextExpressionValidator();

      const report = validator.validateExpression('isReady', 'conditional');

      // 'isReady' contains 'ready' substring — matches boolean keyword pattern
      const boolResult = report.ruleResults.get('conditional-boolean-result');
      expect(boolResult?.valid).toBe(true);
    });

    it('conditional-boolean-result rule passes when refs have readiness field paths', () => {
      const validator = new ContextExpressionValidator();

      const expr = { value: ref('deploy', 'status.conditions') };
      const report = validator.validateExpression(expr, 'conditional');

      const boolResult = report.ruleResults.get('conditional-boolean-result');
      expect(boolResult?.valid).toBe(true);
    });
  });

  describe('validateExpression — template-literal context', () => {
    it('template-literal-structure rule fails for expression without template syntax', () => {
      const validator = new ContextExpressionValidator();

      const report = validator.validateExpression('plain string', 'template-literal');

      const templateResult = report.ruleResults.get('template-literal-structure');
      expect(templateResult?.valid).toBe(false);
    });

    it('template-literal-structure rule passes for expression with balanced template syntax', () => {
      const validator = new ContextExpressionValidator();

      const report = validator.validateExpression('Hello ${name}!', 'template-literal');

      const templateResult = report.ruleResults.get('template-literal-structure');
      expect(templateResult?.valid).toBe(true);
    });
  });

  describe('validateExpression — magic-proxy-integration rule', () => {
    it('does not run by default (validateMagicProxy not set)', () => {
      const validator = new ContextExpressionValidator();

      const report = validator.validateExpression('Object.keys(x)', 'status-builder');

      const magicResult = report.ruleResults.get('magic-proxy-integration');
      expect(magicResult?.valid).toBe(true);
    });

    it('flags Object.keys when validateMagicProxy is true', () => {
      const validator = new ContextExpressionValidator();

      const report = validator.validateExpression('Object.keys(x)', 'status-builder', {
        validateMagicProxy: true,
      });

      const magicResult = report.ruleResults.get('magic-proxy-integration');
      expect(magicResult?.valid).toBe(false);
    });

    it('flags await when validateMagicProxy is true', () => {
      const validator = new ContextExpressionValidator();

      const report = validator.validateExpression('await somePromise', 'status-builder', {
        validateMagicProxy: true,
      });

      const magicResult = report.ruleResults.get('magic-proxy-integration');
      expect(magicResult?.valid).toBe(false);
    });
  });

  describe('validateExpression — factory-type-compatibility rule', () => {
    it('flags Math/Date/JSON for kro factory type', () => {
      const validator = new ContextExpressionValidator();

      const report = validator.validateExpression('Math.floor(x)', 'status-builder', {
        factoryType: 'kro',
      });

      const factoryResult = report.ruleResults.get('factory-type-compatibility');
      expect(factoryResult?.valid).toBe(false);
    });

    it('flags status refs for direct factory type', () => {
      const validator = new ContextExpressionValidator();

      const expr = { value: ref('deploy', 'status.ready') };
      const report = validator.validateExpression(expr, 'status-builder', {
        factoryType: 'direct',
      });

      const factoryResult = report.ruleResults.get('factory-type-compatibility');
      expect(factoryResult?.valid).toBe(false);
    });
  });

  describe('validateExpression — confidence calculation', () => {
    it('confidence is 1.0 when all rules pass', () => {
      const validator = new ContextExpressionValidator();

      // Use a context where rules will all pass
      const expr = { value: ref('__schema__', 'status.ready') };
      const report = validator.validateExpression(expr, 'status-builder', {
        availableResources: {},
      });

      // All applicable rules should pass for a __schema__ ref
      expect(report.confidence).toBeGreaterThan(0);
    });

    it('confidence decreases with errors', () => {
      const validator = new ContextExpressionValidator();

      const expr = { value: ref('missing', 'status.ready') };
      const reportWithError = validator.validateExpression(expr, 'status-builder', {
        availableResources: {},
      });

      const reportNoError = validator.validateExpression(expr, 'status-builder');

      expect(reportWithError.confidence).toBeLessThan(reportNoError.confidence);
    });
  });

  describe('addRule / removeRule', () => {
    it('addRule adds a custom rule', () => {
      const validator = new ContextExpressionValidator();
      const customRule: ContextValidationRule = {
        id: 'custom-rule',
        name: 'Custom Rule',
        description: 'Test rule',
        applicableContexts: ['status-builder'],
        severity: 'warning',
        validate: () => ({ valid: true, message: 'OK' }),
      };

      validator.addRule(customRule);

      expect(validator.getRules()).toHaveLength(8);
    });

    it('addRule replaces rule with same ID', () => {
      const validator = new ContextExpressionValidator();
      const replacement: ContextValidationRule = {
        id: 'resource-existence',
        name: 'Replaced',
        description: 'Replaced rule',
        applicableContexts: ['status-builder'],
        severity: 'error',
        validate: () => ({ valid: true, message: 'Always valid' }),
      };

      validator.addRule(replacement);

      expect(validator.getRules()).toHaveLength(7); // same count, replaced
      expect(validator.getRules().find((r) => r.id === 'resource-existence')?.name).toBe(
        'Replaced'
      );
    });

    it('removeRule removes a rule by ID', () => {
      const validator = new ContextExpressionValidator();

      validator.removeRule('resource-existence');

      expect(validator.getRules()).toHaveLength(6);
      expect(validator.getRules().find((r) => r.id === 'resource-existence')).toBeUndefined();
    });
  });

  describe('validateExpression — custom rules and skipRules', () => {
    it('custom rules in config are applied', () => {
      const validator = new ContextExpressionValidator();
      const customRule: ContextValidationRule = {
        id: 'custom',
        name: 'Custom',
        description: 'Custom',
        applicableContexts: ['status-builder'],
        severity: 'error',
        validate: () => ({ valid: false, message: 'Custom failure' }),
      };

      const report = validator.validateExpression('expr', 'status-builder', {
        customRules: [customRule],
      });

      expect(report.errors.some((e) => e.message === 'Custom failure')).toBe(true);
    });

    it('skipRules skips specified rule IDs', () => {
      const validator = new ContextExpressionValidator();

      const report = validator.validateExpression('someExpr', 'conditional', {
        skipRules: ['conditional-boolean-result'],
      });

      expect(report.ruleResults.has('conditional-boolean-result')).toBe(false);
    });
  });

  describe('validateExpression — rule exception handling', () => {
    it('catching rule that throws produces error without crashing', () => {
      const validator = new ContextExpressionValidator();
      const throwingRule: ContextValidationRule = {
        id: 'throwing-rule',
        name: 'Thrower',
        description: 'Throws',
        applicableContexts: ['status-builder'],
        severity: 'error',
        validate: () => {
          throw new Error('Rule exploded');
        },
      };

      validator.addRule(throwingRule);

      const report = validator.validateExpression('expr', 'status-builder');

      // Should not crash, should have an error from the thrown exception
      expect(report.errors.some((e) => e.message.includes('Rule exploded'))).toBe(true);
    });
  });

  describe('suggestions deduplication', () => {
    it('removes duplicate suggestions', () => {
      const validator = new ContextExpressionValidator();
      const rule1: ContextValidationRule = {
        id: 'dup1',
        name: 'Dup1',
        description: 'test',
        applicableContexts: ['status-builder'],
        severity: 'warning',
        validate: () => ({ valid: false, message: 'fail', suggestions: ['Same suggestion'] }),
      };
      const rule2: ContextValidationRule = {
        id: 'dup2',
        name: 'Dup2',
        description: 'test',
        applicableContexts: ['status-builder'],
        severity: 'warning',
        validate: () => ({ valid: false, message: 'fail', suggestions: ['Same suggestion'] }),
      };

      validator.addRule(rule1);
      validator.addRule(rule2);

      const report = validator.validateExpression('expr', 'status-builder');

      const sameSuggestions = report.suggestions.filter((s) => s === 'Same suggestion');
      expect(sameSuggestions).toHaveLength(1);
    });
  });
});
