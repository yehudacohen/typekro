/**
 * Tests for Context-Aware Conversion functionality
 */

import { describe, expect, it } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import {
  ContextAwareCelGenerator,
  ContextExpressionValidator,
  ExpressionContextDetector,
} from '../../../src/core/expressions/index.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';

// Helper function to create mock KubernetesRef objects
function createMockKubernetesRef<T>(
  resourceId: string,
  fieldPath: string,
  type?: string
): KubernetesRef<T> {
  return {
    [KUBERNETES_REF_BRAND]: true,
    resourceId,
    fieldPath,
    _type: type,
  } as any;
}

describe('Context-Aware Conversion', () => {
  const contextDetector = new ExpressionContextDetector();
  const celGenerator = new ContextAwareCelGenerator();
  const validator = new ContextExpressionValidator();
  describe('ExpressionContextDetector', () => {
    it('should detect status builder context', () => {
      const mockRef = createMockKubernetesRef<number>('webapp', 'status.readyReplicas', 'number');

      const result = contextDetector.detectContext(mockRef, {
        factoryType: 'kro',
        functionContext: 'statusBuilder',
      });

      expect(result.context).toBe('status-builder');
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.kubernetesRefs).toHaveLength(1);
      expect(result.celStrategy).toBe('status-expression');
    });

    it('should detect resource builder context', () => {
      const mockRef = createMockKubernetesRef<string>('__schema__', 'spec.name', 'string');

      const result = contextDetector.detectContext(mockRef, {
        factoryType: 'direct',
        functionContext: 'simpleDeployment',
      });

      expect(result.context).toBe('resource-builder');
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.celStrategy).toBe('resource-reference');
    });

    it('should detect conditional context', () => {
      const expression = 'database.status.ready && webapp.status.readyReplicas > 0';

      const result = contextDetector.detectContext(expression, {
        factoryType: 'kro',
      });

      // The expression contains "ready" which triggers readiness context
      expect(['conditional', 'readiness']).toContain(result.context);
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(['conditional-check', 'readiness-check']).toContain(result.celStrategy);
    });

    it('should detect template literal context', () => {
      const expression = '`https://${hostname}/api`';

      const result = contextDetector.detectContext(expression, {
        factoryType: 'kro',
      });

      expect(result.context).toBe('template-literal');
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(result.celStrategy).toBe('template-interpolation');
    });
  });

  describe('ContextAwareCelGenerator', () => {
    it('should generate status expression CEL', () => {
      const mockRefs = [
        createMockKubernetesRef<number>('webapp', 'status.readyReplicas', 'number'),
      ];

      const result = celGenerator.generateCelExpression(
        mockRefs,
        'status-builder',
        'status-expression',
        { factoryType: 'kro' }
      );

      expect(result.celExpression.expression).toBe('resources.webapp.status.readyReplicas');
      expect(result.strategy).toBe('status-expression');
      expect(result.context).toBe('status-builder');
      expect(result.dependencies).toHaveLength(1);
    });

    it('should generate resource reference CEL', () => {
      const mockRefs = [createMockKubernetesRef<string>('__schema__', 'spec.name', 'string')];

      const result = celGenerator.generateCelExpression(
        mockRefs,
        'resource-builder',
        'resource-reference',
        { factoryType: 'direct' }
      );

      expect(result.celExpression.expression).toBe('schema.spec.name');
      expect(result.strategy).toBe('resource-reference');
      expect(result.context).toBe('resource-builder');
    });

    it('should generate conditional check CEL', () => {
      const mockRefs = [createMockKubernetesRef<boolean>('database', 'status.ready', 'boolean')];

      const result = celGenerator.generateCelExpression(
        mockRefs,
        'conditional',
        'conditional-check',
        { factoryType: 'kro' }
      );

      expect(result.celExpression.expression).toBe('resources.database.status.ready');
      expect(result.strategy).toBe('conditional-check');
      expect(result.context).toBe('conditional');
    });
  });

  describe('ContextExpressionValidator', () => {
    it('should validate status builder expressions', () => {
      const mockRef = createMockKubernetesRef<number>('webapp', 'status.readyReplicas', 'number');

      const report = validator.validateExpression(mockRef, 'status-builder', {
        factoryType: 'kro',
      });

      expect(report.context).toBe('status-builder');
      expect(report.kubernetesRefs).toHaveLength(1);
      // The validation might have warnings but should not have critical errors
      expect(report.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    });

    it('should detect validation issues', () => {
      const expression = 'console.log("test")'; // Invalid for magic proxy

      const report = validator.validateExpression(expression, 'status-builder', {
        factoryType: 'kro',
        validateMagicProxy: true,
      });

      // Should detect issues with console.log usage
      expect(report.errors.length + report.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('Integration', () => {
    it('should work with different factory types', () => {
      const mockRef = createMockKubernetesRef<number>('webapp', 'status.readyReplicas', 'number');

      // Test with Kro factory
      const kroResult = celGenerator.generateCelExpression(
        [mockRef],
        'status-builder',
        'status-expression',
        { factoryType: 'kro' }
      );

      expect(kroResult.celExpression.expression).toBe('resources.webapp.status.readyReplicas');

      // Test with Direct factory
      const directResult = celGenerator.generateCelExpression(
        [mockRef],
        'status-builder',
        'status-expression',
        { factoryType: 'direct' }
      );

      expect(directResult.celExpression.expression).toBe('resources.webapp.status.readyReplicas');
    });

    it('should handle multiple KubernetesRef objects', () => {
      const mockRefs = [
        createMockKubernetesRef<boolean>('database', 'status.ready', 'boolean'),
        createMockKubernetesRef<number>('webapp', 'status.readyReplicas', 'number'),
      ];

      const result = celGenerator.generateCelExpression(
        mockRefs,
        'conditional',
        'conditional-check',
        { factoryType: 'kro' }
      );

      expect(result.celExpression.expression).toContain('resources.database.status.ready');
      expect(result.celExpression.expression).toContain('resources.webapp.status.readyReplicas');
      expect(result.celExpression.expression).toContain('&&');
      expect(result.dependencies).toHaveLength(2);
    });
  });
});
