/**
 * Tests for advanced JavaScript expression conversion to CEL
 * 
 * This test suite validates the advanced expression support including:
 * - Optional chaining (obj?.prop?.field)
 * - Logical OR fallback (value || default)
 * - Nullish coalescing (value ?? default)
 * - Conditional expressions (condition ? true : false)
 * - Complex nested expressions with proper precedence
 */

import { describe, expect, it } from 'bun:test';
import { JavaScriptToCelAnalyzer, type AnalysisContext } from '../../../src/core/expressions/analyzer.js';
import { SourceMapBuilder } from '../../../src/core/expressions/source-map.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';

describe('Advanced JavaScript Expression Conversion', () => {
  const createAnalyzer = () => new JavaScriptToCelAnalyzer();
  
  const createContext = (): AnalysisContext => ({
    type: 'status',
    availableReferences: {
      deployment: {} as Enhanced<any, any>,
      service: {} as Enhanced<any, any>,
      ingress: {} as Enhanced<any, any>
    },
    factoryType: 'kro',
    dependencies: []
  });

  describe('Optional Chaining Conversion', () => {
    it('should convert simple optional chaining to Kro conditional CEL', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment?.status?.readyReplicas';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toContain('?');
      expect(result.errors).toHaveLength(0);
    });

    it('should convert nested optional chaining', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'service?.status?.loadBalancer?.ingress?.[0]?.ip';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toContain('?');
      expect(result.errors).toHaveLength(0);
    });

    it('should handle optional method calls', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment?.status?.conditions?.find?.(c => c.type === "Available")';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Logical OR Fallback Conversion', () => {
    it('should convert simple OR fallback for resource references', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.status.readyReplicas || 0';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toContain('!= null ?');
      expect(result.celExpression!.expression).toContain(': 0');
      expect(result.errors).toHaveLength(0);
    });

    it('should convert OR fallback with string default', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'service.status.loadBalancer.ingress[0].ip || "pending"';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toContain('"pending"');
      expect(result.errors).toHaveLength(0);
    });

    it('should handle complex OR fallback chains', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.status.readyReplicas || service.spec.replicas || 1';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Nullish Coalescing Conversion', () => {
    it('should convert nullish coalescing to null-only check', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.status.readyReplicas ?? 0';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toContain('!= null ?');
      expect(result.celExpression!.expression).toContain(': 0');
      // Should not check for empty string or false like || does
      expect(result.celExpression!.expression).not.toContain('!= ""');
      expect(result.celExpression!.expression).not.toContain('!= false');
      expect(result.errors).toHaveLength(0);
    });

    it('should handle nullish coalescing with complex expressions', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'service.status?.loadBalancer?.ingress?.[0]?.ip ?? "localhost"';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toContain('"localhost"');
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Conditional Expression Conversion', () => {
    it('should convert simple ternary operator', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.status.readyReplicas > 0 ? "ready" : "pending"';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toContain('?');
      expect(result.celExpression!.expression).toContain(':');
      expect(result.celExpression!.expression).toContain('"ready"');
      expect(result.celExpression!.expression).toContain('"pending"');
      expect(result.errors).toHaveLength(0);
    });

    it('should convert nested ternary operators', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.status.readyReplicas > 0 ? (service.status.ready ? "fully-ready" : "partially-ready") : "not-ready"';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toContain('?');
      expect(result.celExpression!.expression).toContain(':');
      expect(result.errors).toHaveLength(0);
    });

    it('should handle resource reference conditions', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.status?.ready ? deployment.status.readyReplicas : 0';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Complex Nested Expressions with Precedence', () => {
    it('should handle mixed operators with proper precedence', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.status.readyReplicas > 0 && service.status.ready || false';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.errors).toHaveLength(0);
    });

    it('should add parentheses when needed for precedence', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = '(deployment.status.readyReplicas || 0) > (service.spec.replicas || 1)';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.errors).toHaveLength(0);
    });

    it('should handle complex expressions with all advanced features', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = `
        deployment.status?.readyReplicas > 0 && 
        service.status?.loadBalancer?.ingress?.[0]?.ip != null ?
        \`https://\${service.status.loadBalancer.ingress[0].ip}\` :
        (ingress.status?.ready ?? false) ? 
        "ingress-pending" : 
        "not-ready"
      `.replace(/\s+/g, ' ').trim();
      
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.errors).toHaveLength(0);
    });

    it('should handle arithmetic expressions with proper precedence', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.spec.replicas * 2 + service.spec.replicas || 1';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.errors).toHaveLength(0);
    });

    it('should handle comparison chains with proper precedence', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.status.readyReplicas >= service.spec.replicas && deployment.status.readyReplicas <= deployment.spec.replicas';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeTruthy();
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle unsupported expressions gracefully', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'deployment.status.readyReplicas **= 2'; // Unsupported operator
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should provide meaningful error messages', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const expression = 'invalid.syntax.here[';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.celExpression).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.message).toBeTruthy();
    });
  });

  describe('Source Mapping', () => {
    it('should provide source mapping for complex expressions', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      // Add source map builder to context
      context.sourceMap = new SourceMapBuilder();
      const expression = 'deployment.status?.readyReplicas > 0 ? "ready" : "pending"';
      const result = analyzer.analyzeExpression(expression, context);
      
      expect(result.sourceMap).toBeTruthy();
      expect(result.sourceMap.length).toBeGreaterThan(0);
    });
  });
});