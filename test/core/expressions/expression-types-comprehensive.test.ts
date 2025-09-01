/**
 * Comprehensive tests for all JavaScript expression types and conversions with KubernetesRef objects
 * 
 * This test suite validates that all supported JavaScript expression patterns work correctly
 * with KubernetesRef objects from the magic proxy system and convert properly to CEL expressions.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { JavaScriptToCelAnalyzer, type AnalysisContext } from '../../../src/core/expressions/analyzer.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';
import { SourceMapBuilder } from '../../../src/core/expressions/source-map.js';

describe('Expression Types - Comprehensive KubernetesRef Integration', () => {
  let analyzer: JavaScriptToCelAnalyzer;
  let mockContext: AnalysisContext;
  let _mockSchemaRef: KubernetesRef<string>;
  let _mockResourceRef: KubernetesRef<number>;
  let _mockBooleanRef: KubernetesRef<boolean>;

  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    
    // Create mock KubernetesRef objects
    _mockSchemaRef = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: '__schema__',
      fieldPath: 'spec.name',
      _type: 'string'
    };

    _mockResourceRef = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'deployment',
      fieldPath: 'status.readyReplicas',
      _type: 0 as number
    };

    _mockBooleanRef = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'service',
      fieldPath: 'status.ready',
      _type: false as boolean
    };

    mockContext = {
      type: 'status',
      availableReferences: {
        deployment: {} as any,
        service: {} as any,
        database: {} as any
      },
      factoryType: 'kro',
      sourceMap: new SourceMapBuilder(),
      dependencies: []
    };
  });

  describe('Binary Expressions with KubernetesRef Objects', () => {
    it('should convert comparison operators with KubernetesRef operands', () => {
      const expressions = [
        'deployment.status.readyReplicas > 0',
        'deployment.status.readyReplicas >= 1',
        'deployment.status.readyReplicas < 10',
        'deployment.status.readyReplicas <= 5',
        'deployment.status.readyReplicas == 3',
        'deployment.status.readyReplicas != 0'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
        
        // Should contain the resource reference
        expect(result.dependencies.some(dep => dep.resourceId === 'deployment')).toBe(true);
      }
    });

    it('should convert logical operators with KubernetesRef operands', () => {
      const expressions = [
        'deployment.status.readyReplicas > 0 && service.status.ready',
        'deployment.status.readyReplicas > 0 || service.status.ready',
        'service.status.ready && deployment.status.readyReplicas == 3'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        
        // Should contain both resource references
        expect(result.dependencies.some(dep => dep.resourceId === 'deployment')).toBe(true);
        expect(result.dependencies.some(dep => dep.resourceId === 'service')).toBe(true);
      }
    });

    it('should handle mixed KubernetesRef and literal operands', () => {
      const expressions = [
        'deployment.status.readyReplicas > 0',
        '"production" == schema.spec.environment',
        'schema.spec.replicas <= 10'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Member Access with KubernetesRef Objects', () => {
    it('should convert simple property access', () => {
      const expressions = [
        'schema.spec.name',
        'deployment.status.readyReplicas',
        'service.status.ready',
        'deployment.metadata.name'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should convert nested property access', () => {
      const expressions = [
        'deployment.status.conditions[0].type',
        'service.status.loadBalancer.ingress[0].ip',
        'deployment.spec.template.spec.containers[0].image'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should convert computed property access', () => {
      const expressions = [
        'deployment.status["readyReplicas"]',
        'service.status["ready"]',
        'deployment.metadata["labels"]["app"]'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Array Access with KubernetesRef Objects', () => {
    it('should convert array index access', () => {
      const expressions = [
        'deployment.status.conditions[0]',
        'service.status.loadBalancer.ingress[0]',
        'deployment.spec.template.spec.containers[1]'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should convert dynamic array access', () => {
      const expressions = [
        'deployment.status.conditions[schema.spec.conditionIndex]',
        'service.status.loadBalancer.ingress[deployment.status.readyReplicas - 1]'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Template Literals with KubernetesRef Objects', () => {
    it('should convert simple template literals', () => {
      const expressions = [
        '`http://${service.status.loadBalancer.ingress[0].ip}`',
        '`${schema.spec.name}-deployment`',
        '`Database URL: postgres://${database.status.podIP}:5432/mydb`'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should convert complex template literals with multiple KubernetesRef objects', () => {
      const expressions = [
        '`${schema.spec.name}:${deployment.status.readyReplicas}/${schema.spec.replicas}`',
        '`http://${service.status.loadBalancer.ingress[0].ip}:${service.spec.ports[0].port}/${schema.spec.path}`'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should handle template literals with mixed content', () => {
      const expressions = [
        '`Static prefix ${schema.spec.name} static suffix`',
        '`Port: ${service.spec.ports[0].port} (${service.spec.type})`'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Optional Chaining with KubernetesRef Objects', () => {
    it('should convert simple optional chaining', () => {
      const expressions = [
        'service.status?.loadBalancer?.ingress?.[0]?.ip',
        'deployment.status?.conditions?.[0]?.type',
        'schema.spec?.database?.host'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
        
        // Should use Kro's ? operator
        const celString = result.celExpression?.expression;
        expect(celString).toContain('?');
      }
    });

    it('should convert optional chaining with method calls', () => {
      const expressions = [
        'deployment.status?.conditions?.find?.(c => c.type === "Available")?.status',
        'service.status?.loadBalancer?.ingress?.length'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Logical Fallback Operators with KubernetesRef Objects', () => {
    it('should convert logical OR fallbacks', () => {
      const expressions = [
        'service.status.loadBalancer.ingress[0].ip || "pending"',
        'deployment.status.readyReplicas || 0',
        'schema.spec.environment || "development"'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should convert nullish coalescing', () => {
      const expressions = [
        'service.status.loadBalancer.ingress[0].ip ?? "not-available"',
        'deployment.status.readyReplicas ?? 0',
        'schema.spec.timeout ?? 30'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should convert chained fallbacks', () => {
      const expressions = [
        'service.status?.loadBalancer?.ingress?.[0]?.ip || service.status?.clusterIP || "localhost"',
        'deployment.status?.readyReplicas ?? deployment.spec?.replicas ?? 1'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        if (!result.valid) {
          console.log(`Failed chained fallback expression: ${expr}`);
          console.log(`Errors:`, result.errors);
        }
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Conditional Expressions with KubernetesRef Objects', () => {
    it('should convert ternary operators', () => {
      const expressions = [
        'deployment.status.readyReplicas > 0 ? "ready" : "not-ready"',
        'service.status.ready ? service.status.loadBalancer.ingress[0].ip : "pending"',
        'schema.spec.environment === "production" ? "prod-db" : "dev-db"'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should convert nested conditional expressions', () => {
      const expressions = [
        'deployment.status.readyReplicas > 0 ? (service.status.ready ? "fully-ready" : "partially-ready") : "not-ready"',
        'schema.spec.environment === "production" ? (schema.spec.replicas > 1 ? "ha-prod" : "single-prod") : "dev"'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Method Calls with KubernetesRef Objects', () => {
    it('should convert array method calls', () => {
      const expressions = [
        'deployment.status.conditions.find(c => c.type === "Available")',
        'service.status.loadBalancer.ingress.filter(i => i.ip)',
        'deployment.spec.template.spec.containers.map(c => c.name)'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should convert string method calls', () => {
      const expressions = [
        'schema.spec.name.includes("test")',
        'deployment.metadata.name.startsWith(schema.spec.prefix)',
        'service.metadata.name.toLowerCase()'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Complex Nested Expressions with KubernetesRef Objects', () => {
    it('should convert deeply nested expressions', () => {
      const expressions = [
        'deployment.status.conditions.find(c => c.type === "Available")?.status === "True" && service.status.ready',
        'schema.spec.replicas > 1 ? deployment.status.readyReplicas / schema.spec.replicas : deployment.status.readyReplicas',
        '`${schema.spec.name}-${deployment.status.conditions.find(c => c.type === "Available")?.status || "unknown"}`'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should handle expressions with multiple resource references', () => {
      const expressions = [
        'deployment.status.readyReplicas === schema.spec.replicas && service.status.ready && ingress.status.loadBalancer.ingress.length > 0',
        '`http://${service.status.loadBalancer.ingress[0].ip}:${service.spec.ports[0].port}/${schema.spec.path}?ready=${deployment.status.readyReplicas > 0}`'
      ];

      // Add ingress to available references
      mockContext.availableReferences.ingress = {} as any;

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.celExpression).toBeDefined();
        expect(result.dependencies.length).toBeGreaterThan(0);
        
        // Should contain multiple resource references
        const resourceIds = new Set(result.dependencies.map(dep => dep.resourceId));
        expect(resourceIds.size).toBeGreaterThan(1);
      }
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle expressions with no KubernetesRef objects', () => {
      const expressions = [
        '"static string"',
        '42',
        'true',
        '1 + 2',
        '"hello" + " world"'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(false);
        expect(result.dependencies).toHaveLength(0);
      }
    });

    it('should handle invalid expressions gracefully', () => {
      const invalidExpressions = [
        'deployment.status.readyReplicas >',  // Incomplete expression
        'schema.spec.name.invalidMethod()',   // Invalid method
        'deployment.status[',                 // Syntax error
      ];

      for (const expr of invalidExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it('should handle references to unavailable resources', () => {
      const expressions = [
        'unknownResource.status.ready',
        'deployment.status.readyReplicas && unknownService.status.ready'
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        // Should still parse but may have warnings about unknown resources
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
      }
    });
  });

  describe('Type Safety and Validation', () => {
    it('should preserve type information in KubernetesRef objects', () => {
      const expressions = [
        'deployment.status.readyReplicas > 0',  // number comparison
        'service.status.ready && true',         // boolean logic
        'schema.spec.name + "-suffix"'          // string concatenation
      ];

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
        
        // Check that type information is preserved
        for (const dep of result.dependencies) {
          expect(dep._type).toBeDefined();
        }
      }
    });

    it('should validate expression compatibility with factory types', () => {
      const expression = 'deployment.status.readyReplicas > 0';

      // Test with Kro factory
      const kroResult = analyzer.analyzeExpression(expression, {
        ...mockContext,
        factoryType: 'kro'
      });
      expect(kroResult.valid).toBe(true);
      expect(kroResult.requiresConversion).toBe(true);

      // Test with direct factory
      const directResult = analyzer.analyzeExpression(expression, {
        ...mockContext,
        factoryType: 'direct'
      });
      expect(directResult.valid).toBe(true);
      expect(directResult.requiresConversion).toBe(true);
    });
  });

  describe('Source Mapping and Debugging', () => {
    it('should provide source mapping information', () => {
      const expression = 'deployment.status.readyReplicas > 0 && service.status.ready';
      
      const result = analyzer.analyzeExpression(expression, mockContext);
      
      expect(result.valid).toBe(true);
      expect(result.sourceMap).toBeDefined();
      expect(result.sourceMap.length).toBeGreaterThan(0);
      
      // Should map back to original expression
      const sourceEntry = result.sourceMap[0];
      expect(sourceEntry?.originalExpression).toBeDefined();
      expect(sourceEntry?.celExpression).toBeDefined();
    });

    it('should provide detailed error information for invalid expressions', () => {
      const invalidExpression = 'deployment.status.readyReplicas >';
      
      const result = analyzer.analyzeExpression(invalidExpression, mockContext);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      
      const error = result.errors[0];
      expect(error?.message).toBeDefined();
      expect(error?.originalExpression).toBe(invalidExpression);
    });
  });
});