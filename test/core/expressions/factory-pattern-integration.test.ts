/**
 * Tests for Factory Pattern Integration with JavaScriptToCelAnalyzer
 * 
 * This test suite validates the integration between the factory pattern handler
 * and the main JavaScript to CEL analyzer.
 */

import { describe, expect, it } from 'bun:test';
import { JavaScriptToCelAnalyzer, type AnalysisContext } from '../../../src/core/expressions/analyzer.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';

describe('Factory Pattern Integration', () => {
  
  const createAnalyzer = () => new JavaScriptToCelAnalyzer();
  
  const createContext = (factoryType: 'direct' | 'kro'): AnalysisContext => ({
    type: 'status',
    availableReferences: {
      deployment: {} as Enhanced<any, any>,
      service: {} as Enhanced<any, any>
    },
    factoryType,
    dependencies: []
  });

  describe('analyzeExpressionWithFactoryPattern', () => {
    
    it('should handle KubernetesRef objects with direct factory pattern', () => {
      const analyzer = createAnalyzer();
      const context = createContext('direct');
      
      const kubernetesRef = {
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        _type: 'number'
      };
      
      const result = analyzer.analyzeExpressionWithFactoryPattern(kubernetesRef, context);
      
      expect(result.valid).toBe(true);
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toBe('resources.deployment.status.readyReplicas');
      expect(result.dependencies).toHaveLength(1);
      expect(result.requiresConversion).toBe(true);
    });
    
    it('should handle KubernetesRef objects with kro factory pattern', () => {
      const analyzer = createAnalyzer();
      const context = createContext('kro');
      
      const kubernetesRef = {
        resourceId: 'service',
        fieldPath: 'status.loadBalancer.ingress[0].ip',
        _type: 'string'
      };
      
      const result = analyzer.analyzeExpressionWithFactoryPattern(kubernetesRef, context);
      
      expect(result.valid).toBe(true);
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toBe('resources.service.status.loadBalancer.ingress[0].ip');
      expect(result.dependencies).toHaveLength(1);
      expect(result.requiresConversion).toBe(true);
    });
    
    it('should handle schema references with both factory patterns', () => {
      const analyzer = createAnalyzer();
      const directContext = createContext('direct');
      const kroContext = createContext('kro');
      
      const schemaRef = {
        resourceId: '__schema__',
        fieldPath: 'spec.name',
        _type: 'string'
      };
      
      const directResult = analyzer.analyzeExpressionWithFactoryPattern(schemaRef, directContext);
      const kroResult = analyzer.analyzeExpressionWithFactoryPattern(schemaRef, kroContext);
      
      expect(directResult.valid).toBe(true);
      expect(kroResult.valid).toBe(true);
      
      // Both should generate the same CEL expression for schema references
      expect(directResult.celExpression!.expression).toBe('schema.spec.name');
      expect(kroResult.celExpression!.expression).toBe('schema.spec.name');
    });
    
    it('should handle static values without conversion', () => {
      const analyzer = createAnalyzer();
      const context = createContext('direct');
      
      const staticObject = { name: 'test', value: 42 };
      const result = analyzer.analyzeExpressionWithFactoryPattern(staticObject, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
      expect(result.dependencies).toHaveLength(0);
      expect(result.celExpression).toBeNull();
    });
    
    it('should fall back to main analyzer for string expressions', () => {
      const analyzer = createAnalyzer();
      const context = createContext('direct');
      
      const stringExpression = 'deployment.status.readyReplicas > 0';
      const result = analyzer.analyzeExpressionWithFactoryPattern(stringExpression, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true);
      // The result should come from the main analyzer
      expect(result.celExpression).toBeTruthy();
    });
    
    it('should handle complex objects with nested KubernetesRef objects', () => {
      const analyzer = createAnalyzer();
      const context = createContext('kro');
      
      const complexObject = {
        ready: {
          resourceId: 'deployment',
          fieldPath: 'status.readyReplicas',
          _type: 'number'
        },
        total: {
          resourceId: 'deployment',
          fieldPath: 'spec.replicas',
          _type: 'number'
        }
      };
      
      const result = analyzer.analyzeExpressionWithFactoryPattern(complexObject, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies).toHaveLength(2);
    });
    
    it('should handle errors gracefully', () => {
      const analyzer = createAnalyzer();
      const context = createContext('direct');
      
      // Create a problematic object that might cause errors
      const problematicObject = {
        get badProperty() {
          throw new Error('Test error');
        }
      };
      
      const result = analyzer.analyzeExpressionWithFactoryPattern(problematicObject, context);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toContain('Direct factory expression handling failed');
    });
    
  });

  describe('Integration with existing analyzer methods', () => {
    
    it('should work alongside existing analyzeExpression method', () => {
      const analyzer = createAnalyzer();
      const context = createContext('direct');
      
      const stringExpression = 'deployment.status.readyReplicas || 0';
      
      // Both methods should work
      const standardResult = analyzer.analyzeExpression(stringExpression, context);
      const factoryResult = analyzer.analyzeExpressionWithFactoryPattern(stringExpression, context);
      
      expect(standardResult.valid).toBe(true);
      expect(factoryResult.valid).toBe(true);
      
      // The factory pattern method should fall back to the standard method for strings
      expect(factoryResult.celExpression).toBeTruthy();
    });
    
    it('should work alongside existing analyzeExpressionWithRefs method', () => {
      const analyzer = createAnalyzer();
      const context = createContext('kro');
      
      const kubernetesRef = {
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        _type: 'number'
      };
      
      // Both methods should work
      const refsResult = analyzer.analyzeExpressionWithRefs(kubernetesRef, context);
      const factoryResult = analyzer.analyzeExpressionWithFactoryPattern(kubernetesRef, context);
      
      expect(refsResult.valid).toBe(true);
      expect(factoryResult.valid).toBe(true);
      
      // The factory result should produce a CEL expression
      expect(factoryResult.celExpression).toBeTruthy();
      
      // The refs result might be null if it determines no conversion is needed
      // but both should be valid
      expect(refsResult.valid).toBe(true);
      expect(factoryResult.valid).toBe(true);
    });
    
  });

});