/**
 * Enhanced Type Optionality Handler Tests
 * 
 * Tests for the Enhanced Type Optionality Support implementation
 */

import { describe, it, expect } from 'bun:test';
import { 
  EnhancedTypeOptionalityHandler,
  analyzeOptionalityRequirements,
  generateNullSafeCelExpression,
  handleOptionalChainingWithEnhancedTypes,
  generateCelWithHasChecks,
  detectNullSafetyRequirements,
  type OptionalityContext,
  type FieldHydrationState
} from '../../../src/core/expressions/optionality-handler.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';

// Mock KubernetesRef for testing
function createMockKubernetesRef(resourceId: string, fieldPath: string): KubernetesRef<any> {
  return {
    [KUBERNETES_REF_BRAND]: true,
    resourceId,
    fieldPath,
    type: 'string'
  } as KubernetesRef<any>;
}

// Mock Enhanced resource for testing
function createMockEnhanced(resourceId: string): Enhanced<object, object> {
  return {
    __resourceId: resourceId,
    apiVersion: 'v1',
    kind: 'MockResource',
    metadata: { name: 'test' },
    spec: {},
    status: {},
    withReadinessEvaluator: () => ({} as Enhanced<object, object>),
    toYaml: () => '',
    toJson: () => ({}),
    toKubernetesResource: () => ({} as any),
    getReadinessEvaluator: () => undefined,
    __brand: 'Enhanced' as const,
    __specType: {} as object,
    __statusType: {} as object
  } as unknown as Enhanced<object, object>;
}

describe('Enhanced Type Optionality Handler', () => {
  describe('EnhancedTypeOptionalityHandler', () => {
    it('should create handler with default options', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      expect(handler).toBeDefined();
    });

    it('should analyze optionality requirements for KubernetesRef objects', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      const kubernetesRef = createMockKubernetesRef('deployment', 'status.readyReplicas');
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {
          deployment: createMockEnhanced('deployment')
        },
        factoryType: 'kro',
        conservativeNullSafety: true,
        useKroConditionals: true,
        generateHasChecks: true
      };

      const results = handler.analyzeOptionalityRequirements(kubernetesRef, context);
      
      expect(results).toHaveLength(1);
      expect(results[0]?.kubernetesRef).toBe(kubernetesRef);
      expect(results[0]?.potentiallyUndefined).toBe(true);
      expect(results[0]?.requiresNullSafety).toBe(true);
      expect(results[0]?.isSchemaReference).toBe(false);
    });

    it('should detect schema references correctly', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      const schemaRef = createMockKubernetesRef('__schema__', 'spec.name');
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {},
        factoryType: 'kro',
        conservativeNullSafety: true
      };

      const results = handler.analyzeOptionalityRequirements(schemaRef, context);
      
      expect(results).toHaveLength(1);
      expect(results[0]?.isSchemaReference).toBe(true);
      expect(results[0]?.potentiallyUndefined).toBe(true); // Conservative approach treats schema fields as potentially undefined
    });

    it('should generate CEL expressions with has() checks', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      const kubernetesRef = createMockKubernetesRef('deployment', 'status.readyReplicas');
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {
          deployment: createMockEnhanced('deployment')
        },
        factoryType: 'kro',
        generateHasChecks: true
      };

      const optionalityResults = handler.analyzeOptionalityRequirements(kubernetesRef, context);
      const celResult = handler.generateCelWithHasChecks(kubernetesRef, optionalityResults, context);
      
      expect(celResult).toBeDefined();
      expect(celResult.expression).toContain('has(');
      expect(celResult.expression).toContain('resources.deployment.status.readyReplicas');
    });

    it('should generate Kro ? prefix operator for optional chaining', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      const kubernetesRef = createMockKubernetesRef('service', 'status.loadBalancer.ingress');
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {
          service: createMockEnhanced('service')
        },
        factoryType: 'kro',
        useKroConditionals: true
      };

      const result = handler.handleOptionalChainingWithEnhancedTypes(kubernetesRef, context);
      
      expect(result.valid).toBe(true);
      expect(result.celExpression?.expression).toContain('resources.service.status.?loadBalancer.?ingress');
    });

    it('should detect null-safety requirements for Enhanced types', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      
      const enhancedResources = {
        deployment: createMockEnhanced('deployment'),
        service: createMockEnhanced('service')
      };
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: enhancedResources,
        factoryType: 'kro',
        conservativeNullSafety: true
      };

      const nullSafetyMap = handler.detectNullSafetyRequirements(enhancedResources, context);
      
      expect(nullSafetyMap.size).toBeGreaterThan(0);
      expect(nullSafetyMap.has('deployment')).toBe(true);
      expect(nullSafetyMap.has('service')).toBe(true);
    });
  });

  describe('Convenience Functions', () => {
    it('should provide analyzeOptionalityRequirements convenience function', () => {
      const kubernetesRef = createMockKubernetesRef('deployment', 'status.readyReplicas');
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {
          deployment: createMockEnhanced('deployment')
        },
        factoryType: 'kro'
      };

      const results = analyzeOptionalityRequirements(kubernetesRef, context);
      
      expect(results).toHaveLength(1);
      expect(results[0]?.kubernetesRef).toBe(kubernetesRef);
    });

    it('should provide generateNullSafeCelExpression convenience function', () => {
      const kubernetesRef = createMockKubernetesRef('deployment', 'status.readyReplicas');
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {
          deployment: createMockEnhanced('deployment')
        },
        factoryType: 'kro',
        generateHasChecks: true
      };

      const optionalityResults = analyzeOptionalityRequirements(kubernetesRef, context);
      const celResult = generateNullSafeCelExpression(kubernetesRef, optionalityResults, context);
      
      expect(celResult.valid).toBe(true);
      expect(celResult.celExpression).toBeDefined();
    });

    it('should provide handleOptionalChainingWithEnhancedTypes convenience function', () => {
      const kubernetesRef = createMockKubernetesRef('deployment', 'status.readyReplicas');
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {
          deployment: createMockEnhanced('deployment')
        },
        factoryType: 'kro',
        useKroConditionals: true
      };

      const result = handleOptionalChainingWithEnhancedTypes(kubernetesRef, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true);
    });

    it('should provide generateCelWithHasChecks convenience function', () => {
      const kubernetesRef = createMockKubernetesRef('deployment', 'status.readyReplicas');
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {
          deployment: createMockEnhanced('deployment')
        },
        factoryType: 'kro',
        generateHasChecks: true
      };

      const optionalityResults = analyzeOptionalityRequirements(kubernetesRef, context);
      const celExpression = generateCelWithHasChecks(kubernetesRef, optionalityResults, context);
      
      expect(celExpression).toBeDefined();
      expect(celExpression.expression).toContain('has(');
    });

    it('should provide detectNullSafetyRequirements convenience function', () => {
      const enhancedResources = {
        deployment: createMockEnhanced('deployment')
      };
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: enhancedResources,
        factoryType: 'kro'
      };

      const nullSafetyMap = detectNullSafetyRequirements(enhancedResources, context);
      
      expect(nullSafetyMap).toBeDefined();
      expect(nullSafetyMap.size).toBeGreaterThan(0);
    });
  });

  describe('Field Hydration Integration', () => {
    it('should integrate with field hydration timing', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      const kubernetesRef = createMockKubernetesRef('deployment', 'status.readyReplicas');
      
      const hydrationStates = new Map<string, FieldHydrationState>();
      hydrationStates.set('deployment:status.readyReplicas', {
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        isHydrated: false,
        isHydrating: true,
        hydrationFailed: false
      });
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {
          deployment: createMockEnhanced('deployment')
        },
        factoryType: 'kro',
        hydrationStates
      };

      const result = handler.integrateWithFieldHydrationTiming(kubernetesRef, hydrationStates, context);
      
      expect(result.transitionHandlers).toBeDefined();
      expect(result.transitionHandlers.length).toBeGreaterThan(0);
    });

    it('should handle undefined-to-defined transitions', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      const kubernetesRef = createMockKubernetesRef('deployment', 'status.readyReplicas');
      
      const hydrationStates = new Map<string, FieldHydrationState>();
      hydrationStates.set('deployment:status.readyReplicas', {
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        isHydrated: false,
        isHydrating: false,
        hydrationFailed: false
      });
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {
          deployment: createMockEnhanced('deployment')
        },
        factoryType: 'kro'
      };

      const result = handler.handleUndefinedToDefinedTransitions(kubernetesRef, hydrationStates, context);
      
      expect(result.valid).toBe(true);
      expect(result.transitionPlan).toBeDefined();
      expect(result.phaseExpressions).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid expressions gracefully', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {},
        factoryType: 'kro'
      };

      const results = handler.analyzeOptionalityRequirements(null, context);
      
      expect(results).toHaveLength(0);
    });

    it('should handle missing context gracefully', () => {
      const handler = new EnhancedTypeOptionalityHandler();
      const kubernetesRef = createMockKubernetesRef('deployment', 'status.readyReplicas');
      
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: {},
        factoryType: 'kro'
      };

      const results = handler.analyzeOptionalityRequirements(kubernetesRef, context);
      
      expect(results).toHaveLength(1);
      expect(results[0]?.confidence).toBeGreaterThan(0);
    });
  });
});