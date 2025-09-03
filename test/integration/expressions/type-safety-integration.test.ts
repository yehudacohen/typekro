/**
 * Type Safety Integration Tests
 * 
 * Tests for the comprehensive type safety integration in JavaScript to CEL
 * expression conversion, including compile-time validation, type inference,
 * and resource reference validation.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { 
  JavaScriptToCelAnalyzer,
  ExpressionTypeValidator,
  TypeRegistry,
  CelTypeInferenceEngine,
  ResourceReferenceValidator,
  CompileTimeTypeChecker
} from '../../../src/core/expressions/index.js';
import type { 
  AnalysisContext,
  TypeInfo,
  CompileTimeValidationContext 
} from '../../../src/core/expressions/index.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';

describe('Type Safety Integration', () => {
  let analyzer: JavaScriptToCelAnalyzer;
  let typeValidator: ExpressionTypeValidator;
  let _typeRegistry: TypeRegistry;
  let typeInferenceEngine: CelTypeInferenceEngine;
  let resourceValidator: ResourceReferenceValidator;
  let compileTimeChecker: CompileTimeTypeChecker;
  
  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    typeValidator = new ExpressionTypeValidator();
    _typeRegistry = new TypeRegistry();
    typeInferenceEngine = new CelTypeInferenceEngine();
    resourceValidator = new ResourceReferenceValidator();
    compileTimeChecker = new CompileTimeTypeChecker();
  });

  describe('TypeScript Type System Integration', () => {
    it('should validate expression types against TypeScript types', () => {
      const availableTypes: Record<string, TypeInfo> = {
        'name': { typeName: 'string', optional: false, nullable: false },
        'replicas': { typeName: 'number', optional: false, nullable: false },
        'ready': { typeName: 'boolean', optional: false, nullable: false }
      };
      
      // Valid string expression
      const stringResult = typeValidator.validateExpression(
        '"hello world"',
        availableTypes,
        { typeName: 'string', optional: false, nullable: false }
      );
      
      expect(stringResult.valid).toBe(true);
      expect(stringResult.resultType?.typeName).toBe('string');
      
      // Valid number expression
      const numberResult = typeValidator.validateExpression(
        '42',
        availableTypes,
        { typeName: 'number', optional: false, nullable: false }
      );
      
      expect(numberResult.valid).toBe(true);
      expect(numberResult.resultType?.typeName).toBe('number');
      
      // Type mismatch
      const mismatchResult = typeValidator.validateExpression(
        '"hello"',
        availableTypes,
        { typeName: 'number', optional: false, nullable: false }
      );
      
      expect(mismatchResult.valid).toBe(false);
      expect(mismatchResult.errors.length).toBeGreaterThan(0);
    });

    it('should handle optional and nullable types', () => {
      const availableTypes: Record<string, TypeInfo> = {
        'optionalField': { typeName: 'string', optional: true, nullable: false },
        'nullableField': { typeName: 'string', optional: false, nullable: true }
      };
      
      const result = typeValidator.validateExpression(
        'optionalField',
        availableTypes
      );
      
      expect(result.valid).toBe(true);
      expect(result.resultType?.optional).toBe(true);
      
      // Should warn about potential null access
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should validate union types', () => {
      const unionType: TypeInfo = {
        typeName: 'string | number',
        optional: false,
        nullable: false,
        unionTypes: [
          { typeName: 'string', optional: false, nullable: false },
          { typeName: 'number', optional: false, nullable: false }
        ]
      };
      
      const availableTypes: Record<string, TypeInfo> = {
        'unionField': unionType
      };
      
      const stringResult = typeValidator.validateExpression(
        '"test"',
        availableTypes,
        unionType
      );
      
      expect(stringResult.valid).toBe(true);
      
      const numberResult = typeValidator.validateExpression(
        '123',
        availableTypes,
        unionType
      );
      
      expect(numberResult.valid).toBe(true);
    });
  });

  describe('CEL Expression Type Inference', () => {
    it('should infer types for simple CEL expressions', () => {
      const mockResource = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const context = {
        availableResources: { 'webapp': mockResource },
        factoryType: 'kro' as const
      };
      
      const celExpression = {
        expression: 'resources.webapp.status.readyReplicas > 0',
        _type: 'boolean'
      } as any;
      
      const result = typeInferenceEngine.inferType(celExpression, context);
      
      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('boolean');
      expect(result.metadata.resourceReferences).toContain('resources.webapp.status.readyReplicas');
    });

    it('should handle binary operations', () => {
      const mockResource = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const context = {
        availableResources: { 'webapp': mockResource },
        factoryType: 'kro' as const
      };
      
      const celExpression = {
        expression: 'resources.webapp.spec.replicas + 1',
        _type: 'number'
      } as any;
      
      const result = typeInferenceEngine.inferType(celExpression, context);
      
      expect(result.success).toBe(true);
      expect(result.resultType.typeName).toBe('number');
    });

    it('should detect function calls', () => {
      const context = {
        availableResources: {},
        factoryType: 'kro' as const
      };
      
      const celExpression = {
        expression: 'size(resources.webapp.status.conditions)',
        _type: 'number'
      } as any;
      
      const result = typeInferenceEngine.inferType(celExpression, context);
      
      expect(result.success).toBe(true);
      expect(result.metadata.functionsUsed).toContain('size');
    });

    it('should validate type compatibility', () => {
      const sourceType: TypeInfo = { typeName: 'string', optional: false, nullable: false };
      const targetType: TypeInfo = { typeName: 'number', optional: false, nullable: false };
      
      const result = typeInferenceEngine.validateTypeCompatibility(sourceType, targetType);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('Resource Reference Validation', () => {
    it('should validate resource existence', () => {
      const mockResource = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const availableResources = { 'webapp': mockResource };
      
      const validRef: KubernetesRef<string> = {
        resourceId: 'webapp',
        fieldPath: 'status.readyReplicas',
        _type: 'number'
      } as any;
      
      const result = resourceValidator.validateKubernetesRef(validRef, availableResources);
      
      expect(result.valid).toBe(true);
      expect(result.metadata.resourceType).toBe('Deployment');
      expect(result.metadata.isStatusField).toBe(true);
    });

    it('should detect missing resources', () => {
      const availableResources = {};
      
      const invalidRef: KubernetesRef<string> = {
        resourceId: 'nonexistent',
        fieldPath: 'status.readyReplicas',
        _type: 'number'
      } as any;
      
      const result = resourceValidator.validateKubernetesRef(invalidRef, availableResources);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.errorType).toBe('RESOURCE_NOT_FOUND');
    });

    it('should validate schema references', () => {
      const schemaRef: KubernetesRef<string> = {
        resourceId: '__schema__',
        fieldPath: 'spec.name',
        _type: 'string'
      } as any;
      
      const mockSchemaProxy = {} as any;
      const result = resourceValidator.validateKubernetesRef(schemaRef, {}, mockSchemaProxy);
      
      expect(result.metadata.resourceType).toBe('Schema');
      expect(result.metadata.isSpecField).toBe(true);
    });

    it('should detect circular dependencies', () => {
      const mockResource = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const availableResources = { 'webapp': mockResource };
      
      const refs: KubernetesRef<any>[] = [
        { resourceId: 'webapp', fieldPath: 'status.readyReplicas', _type: 'number' } as any,
        { resourceId: 'webapp', fieldPath: 'spec.replicas', _type: 'number' } as any,
        { resourceId: 'webapp', fieldPath: 'status.readyReplicas', _type: 'number' } as any // Circular
      ];
      
      const result = resourceValidator.validateReferenceChain(refs, availableResources);
      
      // Should detect the circular reference
      expect(result.errors.some(e => e.errorType === 'CIRCULAR_REFERENCE')).toBe(true);
    });

    it('should provide field suggestions for typos', () => {
      const mockResource = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const availableResources = { 'webapp': mockResource };
      
      const typoRef: KubernetesRef<string> = {
        resourceId: 'webapp',
        fieldPath: 'status.readyReplica', // Missing 's'
        _type: 'number'
      } as any;
      
      const result = resourceValidator.validateKubernetesRef(typoRef, availableResources);
      
      expect(result.valid).toBe(false);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('Compile-Time Type Checking', () => {
    it('should validate expression compatibility at compile time', () => {
      const context: CompileTimeValidationContext = {
        strictMode: true,
        strictNullChecks: true,
        expectedType: {
          typeName: 'boolean',
          isUnion: false,
          isGeneric: false,
          optional: false,
          nullable: false,
          undefinable: false
        }
      };
      
      const result = compileTimeChecker.validateExpressionCompatibility(
        'true && false',
        context
      );
      
      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('boolean');
    });

    it('should detect type incompatibilities', () => {
      const context: CompileTimeValidationContext = {
        strictMode: true,
        expectedType: {
          typeName: 'number',
          isUnion: false,
          isGeneric: false,
          optional: false,
          nullable: false,
          undefinable: false
        }
      };
      
      const result = compileTimeChecker.validateExpressionCompatibility(
        '"hello world"',
        context
      );
      
      expect(result.valid).toBe(false);
      expect(result.compatibilityIssues.length).toBeGreaterThan(0);
      expect(result.compatibilityIssues[0]?.type).toBe('TYPE_MISMATCH');
    });

    it('should validate KubernetesRef usage', () => {
      const mockResource = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const ref: KubernetesRef<number> = {
        resourceId: 'webapp',
        fieldPath: 'spec.replicas',
        _type: 'number'
      } as any;
      
      const usageContext = {
        availableResources: { 'webapp': mockResource },
        usageType: 'property-access' as const
      };
      
      const validationContext: CompileTimeValidationContext = {
        strictMode: true
      };
      
      const result = compileTimeChecker.validateKubernetesRefCompatibility(
        ref,
        usageContext,
        validationContext
      );
      
      expect(result.valid).toBe(true);
      expect(result.compileTimeType?.typeName).toBe('KubernetesRef<number>');
    });

    it('should detect unsupported syntax', () => {
      const context: CompileTimeValidationContext = {
        strictMode: true
      };
      
      const result = compileTimeChecker.validateExpressionCompatibility(
        'async function test() { return await Promise.resolve(42); }',
        context
      );
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.errorType === 'UNSUPPORTED_SYNTAX')).toBe(true);
    });

    it('should warn about potential runtime issues', () => {
      const context: CompileTimeValidationContext = {
        strictMode: true,
        strictNullChecks: true
      };
      
      const result = compileTimeChecker.validateExpressionCompatibility(
        'obj.prop.nested', // Potential null access without optional chaining
        context
      );
      
      expect(result.warnings.some(w => w.warningType === 'POTENTIAL_RUNTIME_ERROR')).toBe(true);
    });
  });

  describe('Comprehensive Analysis Integration', () => {
    it('should perform complete type safety analysis', () => {
      const mockResource = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const typeRegistry = new TypeRegistry();
      typeRegistry.registerResourceType('webapp', {
        typeName: 'Deployment',
        optional: false,
        nullable: false,
        properties: {
          'spec.replicas': { typeName: 'number', optional: false, nullable: false },
          'status.readyReplicas': { typeName: 'number', optional: true, nullable: false }
        }
      });
      
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { 'webapp': mockResource },
        factoryType: 'kro',
        strictTypeChecking: true,
        validateResourceReferences: true,
        compileTimeTypeChecking: true,
        typeRegistry,
        expectedType: { typeName: 'boolean', optional: false, nullable: false },
        compileTimeContext: {
          strictMode: true,
          strictNullChecks: true,
          expectedType: {
            typeName: 'boolean',
            isUnion: false,
            isGeneric: false,
            optional: false,
            nullable: false,
            undefinable: false
          }
        }
      };
      
      const result = analyzer.analyzeExpression(
        'resources.webapp.status.readyReplicas > 0',
        context
      );
      
      expect(result.requiresConversion).toBe(true);
      expect(result.celExpression).not.toBeNull();
      expect(result.typeValidation).toBeDefined();
      expect(result.resourceValidation).toBeDefined();
      expect(result.compileTimeValidation).toBeDefined();
      expect(result.inferredType).toBeDefined();
    });

    it('should generate comprehensive validation report', () => {
      const mockResource = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { 'webapp': mockResource },
        factoryType: 'kro',
        strictTypeChecking: true,
        validateResourceReferences: true,
        compileTimeTypeChecking: true
      };
      
      const report = analyzer.getValidationReport(
        'resources.webapp.status.readyReplicas > resources.webapp.spec.replicas',
        context
      );
      
      expect(report.expression).toBe('resources.webapp.status.readyReplicas > resources.webapp.spec.replicas');
      expect(report.conversionResult).toBeDefined();
      expect(report.summary).toBeDefined();
      expect(report.summary.totalErrors).toBeGreaterThanOrEqual(0);
      expect(report.summary.totalWarnings).toBeGreaterThanOrEqual(0);
      expect(typeof report.summary.confidence).toBe('number');
      expect(report.summary.confidence).toBeGreaterThanOrEqual(0);
      expect(report.summary.confidence).toBeLessThanOrEqual(1);
    });

    it('should handle complex expressions with multiple validation layers', () => {
      const mockDeployment = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const mockService = { constructor: { name: 'Service' } } as Enhanced<any, any>;
      
      const context: AnalysisContext = {
        type: 'condition',
        availableReferences: { 
          'webapp': mockDeployment,
          'webservice': mockService
        },
        factoryType: 'kro',
        strictTypeChecking: true,
        validateResourceReferences: true,
        compileTimeTypeChecking: true,
        dependencies: []
      };
      
      const complexExpression = `
        resources.webapp.status.readyReplicas > 0 && 
        resources.webservice.status.loadBalancer.ingress.length > 0 &&
        resources.webapp.spec.replicas == resources.webapp.status.readyReplicas
      `.trim();
      
      const result = analyzer.analyzeExpression(complexExpression, context);
      
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies.length).toBeGreaterThan(0);
      
      // Should have detected multiple resource references
      const resourceRefs = result.dependencies.filter(dep => dep.resourceId !== '__schema__');
      expect(resourceRefs.length).toBeGreaterThan(1);
      
      // Should have validated all references
      if (result.resourceValidation) {
        expect(result.resourceValidation.length).toBeGreaterThan(0);
      }
    });

    it('should provide actionable error messages and suggestions', () => {
      // Provide some available resources so suggestions can be generated
      const mockResource = { constructor: { name: 'Deployment' } } as any;
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { 
          'webapp': mockResource,
          'database': mockResource,
          'nonexisting': mockResource  // Similar to 'nonexistent' to test suggestions
        },
        factoryType: 'kro',
        strictTypeChecking: true,
        validateResourceReferences: true,
        compileTimeTypeChecking: true
      };
      
      const result = analyzer.analyzeExpression(
        'resources.nonexistent.status.ready',
        context
      );
      
      // Resource validation errors are now treated as warnings, not critical errors
      expect(result.warnings.length).toBeGreaterThan(0);
      
      if (result.resourceValidation) {
        const resourceErrors = result.resourceValidation.flatMap(rv => rv.errors);
        expect(resourceErrors.length).toBeGreaterThan(0);
        
        const suggestions = result.resourceValidation.flatMap(rv => rv.suggestions);
        expect(suggestions.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Performance and Caching', () => {
    it('should cache validation results for repeated expressions', () => {
      const _context: AnalysisContext = {
        type: 'status',
        availableReferences: {},
        factoryType: 'kro'
      };
      
      const _expression = '"hello world"';
      
      // First call - measure time with a more complex expression to ensure measurable difference
      const complexExpression = 'resources.webapp.status.readyReplicas > 0 && resources.webapp.spec.replicas > 0';
      const complexContext: AnalysisContext = {
        type: 'status',
        availableReferences: { webapp: { constructor: { name: 'Deployment' } } as any },
        factoryType: 'kro'
      };
      
      const start1 = performance.now();
      const result1 = analyzer.analyzeExpression(complexExpression, complexContext);
      const time1 = performance.now() - start1;
      
      // Second call (should be cached)
      const start2 = performance.now();
      const result2 = analyzer.analyzeExpression(complexExpression, complexContext);
      const time2 = performance.now() - start2;
      
      expect(result1.celExpression).toEqual(result2.celExpression);
      // For caching to be effective, second call should be at least 50% faster or take less than 1ms
      expect(time2 < time1 * 0.5 || time2 < 1).toBe(true);
    });

    it('should handle large numbers of validations efficiently', () => {
      const mockResource = { constructor: { name: 'Deployment' } } as Enhanced<any, any>;
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { 'webapp': mockResource },
        factoryType: 'kro',
        strictTypeChecking: true
      };
      
      const expressions = Array.from({ length: 100 }, (_, i) => 
        `resources.webapp.status.readyReplicas > ${i}`
      );
      
      const start = Date.now();
      const results = expressions.map(expr => analyzer.analyzeExpression(expr, context));
      const totalTime = Date.now() - start;
      
      expect(results.length).toBe(100);
      expect(results.every(r => r.celExpression !== null)).toBe(true);
      expect(totalTime).toBeLessThan(5000); // Should complete within 5 seconds
    });
  });
});