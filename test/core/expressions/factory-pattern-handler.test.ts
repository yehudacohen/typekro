/**
 * Tests for Factory Pattern Handler
 * 
 * This test suite validates the factory pattern integration for JavaScript
 * to CEL expression conversion, including both direct and Kro deployment patterns.
 */

import { describe, expect, it } from 'bun:test';
import { 
  DirectFactoryExpressionHandler,
  KroFactoryExpressionHandler,
  FactoryPatternHandlerFactory,
  handleExpressionWithFactoryPattern,
  type FactoryPatternType 
} from '../../../src/core/expressions/factory-pattern-handler.js';
import type { AnalysisContext } from '../../../src/core/expressions/analyzer.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';

describe('Factory Pattern Handler', () => {
  
  const createContext = (factoryType: FactoryPatternType): AnalysisContext => ({
    type: 'status',
    availableReferences: {
      deployment: {} as Enhanced<any, any>,
      service: {} as Enhanced<any, any>
    },
    factoryType,
    dependencies: []
  });

  describe('DirectFactoryExpressionHandler', () => {
    
    it('should return correct pattern type', () => {
      const handler = new DirectFactoryExpressionHandler();
      expect(handler.getPatternType()).toBe('direct');
    });
    
    it('should handle KubernetesRef objects', () => {
      const handler = new DirectFactoryExpressionHandler();
      const context = createContext('direct');
      
      const kubernetesRef = {
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        _type: 'number'
      };
      
      const result = handler.handleExpression(kubernetesRef, context);
      
      expect(result.valid).toBe(true);
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toBe('resources.deployment.status.readyReplicas');
      expect(result.dependencies).toHaveLength(1);
      expect(result.requiresConversion).toBe(true);
    });
    
    it('should handle schema references', () => {
      const handler = new DirectFactoryExpressionHandler();
      const context = createContext('direct');
      
      const schemaRef = {
        resourceId: '__schema__',
        fieldPath: 'spec.name',
        _type: 'string'
      };
      
      const result = handler.handleExpression(schemaRef, context);
      
      expect(result.valid).toBe(true);
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toBe('schema.spec.name');
      expect(result.dependencies).toHaveLength(1);
      expect(result.requiresConversion).toBe(true);
    });
    
    it('should handle static values without conversion', () => {
      const handler = new DirectFactoryExpressionHandler();
      const context = createContext('direct');
      
      const staticValue = 'hello world';
      const result = handler.handleExpression(staticValue, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true); // String expressions still need conversion
    });
    
    it('should handle objects without KubernetesRef objects', () => {
      const handler = new DirectFactoryExpressionHandler();
      const context = createContext('direct');
      
      const plainObject = { name: 'test', value: 42 };
      const result = handler.handleExpression(plainObject, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
      expect(result.dependencies).toHaveLength(0);
    });
    
  });

  describe('KroFactoryExpressionHandler', () => {
    
    it('should return correct pattern type', () => {
      const handler = new KroFactoryExpressionHandler();
      expect(handler.getPatternType()).toBe('kro');
    });
    
    it('should handle KubernetesRef objects', () => {
      const handler = new KroFactoryExpressionHandler();
      const context = createContext('kro');
      
      const kubernetesRef = {
        resourceId: 'service',
        fieldPath: 'status.loadBalancer.ingress[0].ip',
        _type: 'string'
      };
      
      const result = handler.handleExpression(kubernetesRef, context);
      
      expect(result.valid).toBe(true);
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toBe('resources.service.status.loadBalancer.ingress[0].ip');
      expect(result.dependencies).toHaveLength(1);
      expect(result.requiresConversion).toBe(true);
    });
    
    it('should handle schema references', () => {
      const handler = new KroFactoryExpressionHandler();
      const context = createContext('kro');
      
      const schemaRef = {
        resourceId: '__schema__',
        fieldPath: 'spec.replicas',
        _type: 'number'
      };
      
      const result = handler.handleExpression(schemaRef, context);
      
      expect(result.valid).toBe(true);
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toBe('schema.spec.replicas');
      expect(result.dependencies).toHaveLength(1);
      expect(result.requiresConversion).toBe(true);
    });
    
  });

  describe('FactoryPatternHandlerFactory', () => {
    
    it('should create DirectFactoryExpressionHandler for direct pattern', () => {
      const handler = FactoryPatternHandlerFactory.createHandler('direct');
      expect(handler).toBeInstanceOf(DirectFactoryExpressionHandler);
      expect(handler.getPatternType()).toBe('direct');
    });
    
    it('should create KroFactoryExpressionHandler for kro pattern', () => {
      const handler = FactoryPatternHandlerFactory.createHandler('kro');
      expect(handler).toBeInstanceOf(KroFactoryExpressionHandler);
      expect(handler.getPatternType()).toBe('kro');
    });
    
    it('should throw error for unsupported pattern', () => {
      expect(() => {
        FactoryPatternHandlerFactory.createHandler('unsupported' as any);
      }).toThrow('Unsupported factory pattern type: unsupported');
    });
    
    it('should detect factory pattern from context', () => {
      const directContext = createContext('direct');
      const kroContext = createContext('kro');
      
      expect(FactoryPatternHandlerFactory.detectFactoryPattern(directContext)).toBe('direct');
      expect(FactoryPatternHandlerFactory.detectFactoryPattern(kroContext)).toBe('kro');
    });
    
    it('should create handler from context', () => {
      const directContext = createContext('direct');
      const kroContext = createContext('kro');
      
      const directHandler = FactoryPatternHandlerFactory.createHandlerFromContext(directContext);
      const kroHandler = FactoryPatternHandlerFactory.createHandlerFromContext(kroContext);
      
      expect(directHandler).toBeInstanceOf(DirectFactoryExpressionHandler);
      expect(kroHandler).toBeInstanceOf(KroFactoryExpressionHandler);
    });
    
  });

  describe('handleExpressionWithFactoryPattern', () => {
    
    it('should use appropriate handler based on context factory type', () => {
      const directContext = createContext('direct');
      const kroContext = createContext('kro');
      
      const kubernetesRef = {
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        _type: 'number'
      };
      
      const directResult = handleExpressionWithFactoryPattern(kubernetesRef, directContext);
      const kroResult = handleExpressionWithFactoryPattern(kubernetesRef, kroContext);
      
      expect(directResult.valid).toBe(true);
      expect(kroResult.valid).toBe(true);
      
      // Both should generate the same CEL expression for this case
      expect(directResult.celExpression!.expression).toBe('resources.deployment.status.readyReplicas');
      expect(kroResult.celExpression!.expression).toBe('resources.deployment.status.readyReplicas');
    });
    
    it('should handle complex objects with nested KubernetesRef objects', () => {
      const context = createContext('direct');
      
      const complexObject = {
        name: 'test',
        replicas: {
          resourceId: 'deployment',
          fieldPath: 'spec.replicas',
          _type: 'number'
        },
        status: {
          ready: {
            resourceId: 'deployment',
            fieldPath: 'status.readyReplicas',
            _type: 'number'
          }
        }
      };
      
      const result = handleExpressionWithFactoryPattern(complexObject, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies).toHaveLength(2);
    });
    
  });

});