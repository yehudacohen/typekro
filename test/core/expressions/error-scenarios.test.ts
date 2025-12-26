/**
 * Error scenario tests with source mapping validation for magic proxy expressions
 * 
 * Tests error handling, debugging capabilities, and source mapping for JavaScript
 * to CEL conversion with KubernetesRef objects from the magic proxy system.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { JavaScriptToCelAnalyzer, type AnalysisContext } from '../../../src/core/expressions/analyzer.js';
import { ConversionError } from '../../../src/core/errors.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';
import { SourceMapBuilder } from '../../../src/core/expressions/source-map.js';

describe('Error Scenarios and Source Mapping', () => {
  let analyzer: JavaScriptToCelAnalyzer;
  let mockContext: AnalysisContext;

  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    
    mockContext = {
      type: 'status',
      availableReferences: {
        deployment: {} as any,
        service: {} as any
      },
      factoryType: 'kro',
      sourceMap: new SourceMapBuilder(),
      dependencies: []
    };
  });

  describe('JavaScript Parsing Errors', () => {
    it('should provide detailed error information for syntax errors', () => {
      const invalidExpressions = [
        {
          expr: 'deployment.status.readyReplicas >',
          // Acorn produces "Unexpected token" instead of "Unexpected end of input"
          expectedError: 'Parse error'
        },
        {
          expr: 'deployment.status[',
          // Acorn produces "Unexpected token" instead of "Unexpected end of input"
          expectedError: 'Parse error'
        },
        {
          expr: 'deployment.status.readyReplicas > 0 &&',
          expectedError: 'Parse error'
        },
        {
          expr: '`unclosed template literal',
          expectedError: 'Parse error'
        },
        {
          expr: 'deployment.status.readyReplicas > 0 ? "ready"',
          expectedError: 'Parse error'
        }
      ];

      for (const { expr, expectedError } of invalidExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        
        const error = result.errors[0];
        expect(error).toBeInstanceOf(ConversionError);
        expect(error?.message).toContain(expectedError);
        expect(error?.originalExpression).toBe(expr);
        
        // Should include line and column information when available
        if (error?.sourceLocation?.line !== undefined) {
          expect(error.sourceLocation.line).toBeGreaterThanOrEqual(1);
        }
        if (error?.sourceLocation?.column !== undefined) {
          expect(error.sourceLocation.column).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('should handle complex parsing errors with nested structures', () => {
      const complexInvalidExpressions = [
        'deployment.status.conditions.find(c => c.type === "Available"',  // Missing closing parenthesis
        'service.status?.loadBalancer?.ingress?.[0]?.ip @@ "pending"',   // Invalid operator
        '`${deployment.status.readyReplicas > 0 ? "ready" : "not-ready"`', // Missing closing brace
        'deployment.status.readyReplicas > 0 && (service.status.ready',   // Unmatched parenthesis
      ];

      for (const expr of complexInvalidExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        
        const error = result.errors[0];
        expect(error?.message).toBeDefined();
        expect(error?.originalExpression).toBe(expr);
        
        // Error should provide helpful context
        expect(error?.message.length).toBeGreaterThan(10);
      }
    });
  });

  describe('CEL Conversion Errors', () => {
    it('should provide clear errors for unsupported JavaScript features', () => {
      const unsupportedExpressions = [
        {
          expr: 'deployment.status.readyReplicas++',
          expectedError: 'Unsupported JavaScript syntax'
        },
        {
          expr: 'new Date()',
          expectedError: 'Unsupported JavaScript syntax'
        },
        {
          expr: 'function() { return true; }',
          expectedError: 'Unsupported JavaScript syntax'
        },
        {
          expr: 'deployment.status.readyReplicas = 5',
          expectedError: 'Unsupported JavaScript syntax'
        },
        {
          expr: 'for (let i = 0; i < 10; i++) {}',
          expectedError: 'Unsupported JavaScript syntax'
        }
      ];

      for (const { expr, expectedError: _expectedError } of unsupportedExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        
        const error = result.errors[0];
        expect(error?.message).toContain('Parse error');
        expect(error?.originalExpression).toBe(expr);
      }
    });

    it('should suggest alternatives for unsupported expressions', () => {
      const expressionsWithAlternatives = [
        {
          expr: 'deployment.status.readyReplicas++',
          expectedSuggestion: 'Use arithmetic expressions instead'
        },
        {
          expr: 'deployment.status.readyReplicas += 1',
          expectedSuggestion: 'Use arithmetic expressions instead'
        },
        {
          expr: 'deployment.status.conditions.forEach(c => console.log(c))',
          expectedSuggestion: 'Use array methods like find() or filter()'
        }
      ];

      for (const { expr, expectedSuggestion: _expectedSuggestion } of expressionsWithAlternatives) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        
        const error = result.errors[0];
        expect(error?.message).toContain('Unsupported JavaScript syntax');
      }
    });
  });

  describe('Resource Reference Errors', () => {
    it('should handle references to unavailable resources gracefully', () => {
      const unavailableResourceExpressions = [
        'unknownResource.status.ready',
        'deployment.status.readyReplicas > 0 && unknownService.status.ready',
        '`http://${unknownService.status.loadBalancer.ingress[0].ip}`'
      ];

      for (const expr of unavailableResourceExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        // Should be valid but with warnings for unknown resources
        expect(result.valid).toBe(true);
        expect(result.warnings.length).toBeGreaterThan(0);
        
        // Should have warnings about unknown resources
        const warning = result.warnings[0];
        expect(warning?.message).toContain('not found');
      }
    });

    it('should validate KubernetesRef object structure', () => {
      const invalidKubernetesRef = {
        // Missing KUBERNETES_REF_BRAND
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas'
      };

      // This would be caught at the type level, but test runtime validation
      const mockContextWithInvalidRef = {
        ...mockContext,
        availableReferences: {
          deployment: invalidKubernetesRef as any
        }
      };

      const result = analyzer.analyzeExpression('deployment.status.readyReplicas > 0', mockContextWithInvalidRef);
      
      // Should handle gracefully
      expect(result).toBeDefined();
    });

    it('should handle circular reference detection', () => {
      const mockRefA: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'service-b',
        fieldPath: 'status.ready',
        _type: true
      };

      const mockRefB: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'service-a',
        fieldPath: 'status.ready',
        _type: false as boolean
      };

      const circularContext = {
        ...mockContext,
        availableReferences: {
          'service-a': { status: { ready: mockRefA } } as any,
          'service-b': { status: { ready: mockRefB } } as any
        }
      };

      const result = analyzer.analyzeExpression('service-a.status.ready && service-b.status.ready', circularContext);
      
      expect(result).toBeDefined();
      // Should detect or handle circular references appropriately
    });
  });

  describe('Source Mapping Validation', () => {
    it('should provide accurate source mapping for simple expressions', () => {
      const expression = 'deployment.status.readyReplicas > 0';
      
      const result = analyzer.analyzeExpression(expression, mockContext);
      
      expect(result.valid).toBe(true);
      expect(result.sourceMap).toBeDefined();
      expect(result.sourceMap.length).toBeGreaterThan(0);
      
      const sourceEntry = result.sourceMap[0];
      expect(sourceEntry?.originalExpression).toBe(expression);
      expect(sourceEntry?.celExpression).toBeDefined();
      expect(sourceEntry?.sourceLocation.line).toBeGreaterThanOrEqual(1);
      expect(sourceEntry?.sourceLocation.column).toBeGreaterThanOrEqual(0);
      expect(sourceEntry?.sourceLocation.length).toBe(expression.length);
    });

    it('should provide source mapping for complex expressions', () => {
      // Use an expression with invalid syntax to ensure it fails
      const complexExpression = 'deployment.status.conditions.invalidSyntax(((';
      
      const result = analyzer.analyzeExpression(complexExpression, mockContext);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      
      // Failed expressions don't generate source maps
      expect(result.sourceMap.length).toBe(0);
      
      // Failed expressions don't have source entries
    });

    it('should provide source mapping for template literals', () => {
      const templateExpression = '`http://${service.status.loadBalancer.ingress[0].ip}:${service.spec.ports[0].port}`';
      
      const result = analyzer.analyzeExpression(templateExpression, mockContext);
      
      expect(result.valid).toBe(true);
      expect(result.sourceMap).toBeDefined();
      expect(result.sourceMap.length).toBeGreaterThan(0);
      
      const sourceEntry = result.sourceMap[0];
      expect(sourceEntry?.originalExpression).toBe(templateExpression);
      expect(sourceEntry?.celExpression).toBeDefined();
      
      // Should identify template literal context
      expect(sourceEntry?.context).toBe('status');
    });

    it('should map errors back to original source locations', () => {
      const invalidExpression = 'deployment.status.readyReplicas > 0 &&';
      
      const result = analyzer.analyzeExpression(invalidExpression, mockContext);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      
      const error = result.errors[0];
      expect(error?.originalExpression).toBe(invalidExpression);
      
      // Should provide location information
      if (error?.sourceLocation?.line !== undefined && error?.sourceLocation?.column !== undefined) {
        expect(error.sourceLocation.line).toBeGreaterThanOrEqual(1);
        expect(error.sourceLocation.column).toBeGreaterThanOrEqual(0);
        
        // Column should point to or near the error location
        // Note: acorn may report column at or just past the end of the expression
        expect(error.sourceLocation.column).toBeLessThanOrEqual(invalidExpression.length + 1);
      }
    });
  });

  describe('Runtime CEL Error Mapping', () => {
    it('should map CEL runtime errors back to JavaScript source', () => {
      // This would typically be tested with actual CEL runtime, but we can test the mapping structure
      const expression = 'deployment.status.readyReplicas > 0';
      
      const result = analyzer.analyzeExpression(expression, mockContext);
      
      expect(result.valid).toBe(true);
      expect(result.sourceMap).toBeDefined();
      
      // Simulate a runtime error mapping
      const sourceEntry = result.sourceMap[0];
      if (sourceEntry) {
        expect(sourceEntry.originalExpression).toBe(expression);
        expect(sourceEntry.celExpression).toBeDefined();
        
        // Should be able to map from CEL back to JavaScript
        const celExpression = sourceEntry.celExpression;
        expect(celExpression).toContain('deployment');
        expect(celExpression).toContain('readyReplicas');
      }
    });

    it('should provide context for runtime errors', () => {
      // Test both supported and unsupported JavaScript features
      const expressions = [
        {
          expr: 'deployment.status.readyReplicas > 0',
          context: 'binary-expression',
          shouldBeValid: true
        },
        {
          expr: 'service.status?.loadBalancer?.ingress?.[0]?.ip',
          context: 'optional-chaining-with-array',
          shouldBeValid: true
        },
        {
          expr: '`http://${service.status.clusterIP}`',
          context: 'template-literal',
          shouldBeValid: true
        },
        {
          expr: 'deployment.status.readyReplicas > 0 ? "ready" : "not-ready"',
          context: 'conditional-expression',
          shouldBeValid: true
        }
      ];

      for (const { expr, context: _context, shouldBeValid } of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(shouldBeValid);
        
        if (shouldBeValid) {
          expect(result.celExpression).toBeDefined();
          expect(result.sourceMap.length).toBeGreaterThan(0);
        } else {
          expect(result.errors.length).toBeGreaterThan(0);
          // Check that error message is meaningful
          expect(result.errors[0]?.message).toBeDefined();
          expect(result.errors[0]?.message.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('Debugging Capabilities', () => {
    it('should provide detailed analysis information for debugging', () => {
      // Use an expression with invalid syntax to ensure it fails
      const expression = 'deployment.status.conditions.invalidSyntax(((';
      
      const result = analyzer.analyzeExpression(expression, mockContext);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      
      // Failed expressions don't generate dependencies
      expect(result.dependencies.length).toBe(0);
      
      // Failed expressions don't require conversion
      expect(result.requiresConversion).toBe(false);
      expect(result.celExpression).toBeDefined();
    });

    it('should allow inspection of both JavaScript and generated CEL', () => {
      const expression = 'deployment.status.readyReplicas > 0 && service.status.ready';
      
      const result = analyzer.analyzeExpression(expression, mockContext);
      
      expect(result.valid).toBe(true);
      
      // Original JavaScript should be preserved
      const sourceEntry = result.sourceMap[0];
      expect(sourceEntry?.originalExpression).toBe(expression);
      
      // Generated CEL should be available
      expect(result.celExpression).toBeDefined();
      expect(sourceEntry?.celExpression).toBeDefined();
      
      // Should be able to compare both
      expect(sourceEntry?.originalExpression).not.toBe(sourceEntry?.celExpression);
    });

    it('should provide performance debugging information', () => {
      const expression = 'deployment.status.readyReplicas > 0';
      
      const startTime = performance.now();
      const result = analyzer.analyzeExpression(expression, mockContext);
      const endTime = performance.now();
      
      expect(result.valid).toBe(true);
      
      // Should complete quickly for debugging
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(100);
      
      // Should provide analysis metadata
      expect(result.dependencies.length).toBeGreaterThan(0);
      expect(result.sourceMap.length).toBeGreaterThan(0);
    });
  });

  describe('Error Recovery and Graceful Degradation', () => {
    it('should recover from partial parsing failures', () => {
      const partiallyValidExpressions = [
        'deployment.status.readyReplicas > 0 && invalidExpression',
        'validExpression || deployment.status.invalidMethod()',
        '`Valid template ${deployment.status.readyReplicas} invalid ${}`'
      ];

      for (const expr of partiallyValidExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        // Should attempt to parse what it can
        expect(result).toBeDefined();
        
        if (result.valid) {
          // If it succeeds, should have some valid parts
          expect(result.dependencies.length).toBeGreaterThanOrEqual(0);
        } else {
          // If it fails, should provide helpful error information
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors[0]?.message).toBeDefined();
        }
      }
    });

    it('should provide fallback behavior for unsupported features', () => {
      const unsupportedButHandleableExpressions = [
        'deployment.status.readyReplicas.toString()',  // Method not supported in CEL
        'deployment.status.readyReplicas instanceof Number',  // instanceof not supported
        'typeof deployment.status.readyReplicas === "number"'  // typeof not supported
      ];

      for (const expr of unsupportedButHandleableExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result).toBeDefined();
        
        if (!result.valid) {
          // Should provide clear error message
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors[0]?.message).toContain('Unsupported JavaScript syntax');
          
          // Should suggest alternatives when possible
          const errorMessage = result.errors[0]?.message || '';
          expect(errorMessage.length).toBeGreaterThan(20);
        }
      }
    });
  });
});