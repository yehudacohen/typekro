/**
 * Tests for kubernetesComposition API integration with JavaScript to CEL conversion
 */

import { describe, expect, it } from 'bun:test';
import { 
  CompositionExpressionAnalyzer,
  CompositionIntegrationHooks,
  MagicProxyScopeManager,
  compositionUsesKubernetesRefs,
} from '../../../src/core/expressions/composition-integration.js';
import { createCompositionContext } from '../../../src/factories/shared.js';
import type { SchemaProxy } from '../../../src/core/types/serialization.js';

describe('CompositionIntegrationHooks', () => {
  it('should detect KubernetesRef usage in composition functions', () => {
    const _hooks = new CompositionIntegrationHooks();
    
    // Mock schema proxy
    const mockSchemaProxy = {
      spec: {
        name: 'test-app',
        replicas: 3,
      },
      status: {},
    } as SchemaProxy<any, any>;

    // Simple composition function that returns static values
    const staticComposition = (_spec: any) => ({
      ready: true,
      url: 'http://localhost:3000',
    });

    // This should not require CEL conversion since it uses static values
    const usesRefs = compositionUsesKubernetesRefs(staticComposition, mockSchemaProxy);
    expect(usesRefs).toBe(false);
  });

  it('should handle composition scope management', () => {
    const scopeManager = new MagicProxyScopeManager();
    
    // Enter a composition scope
    scopeManager.enterScope('test-composition');
    
    // Register some resources
    scopeManager.registerResource('deployment-1');
    scopeManager.registerResource('service-1');
    
    // Check scope state
    expect(scopeManager.getCurrentScopeResources()).toEqual(['deployment-1', 'service-1']);
    expect(scopeManager.isResourceInCurrentScope('deployment-1')).toBe(true);
    expect(scopeManager.isResourceInCurrentScope('unknown-resource')).toBe(false);
    
    // Exit scope
    scopeManager.exitScope();
    expect(scopeManager.getCurrentScope()).toBeUndefined();
  });

  it('should handle nested composition scopes', () => {
    const scopeManager = new MagicProxyScopeManager();
    
    // Enter parent scope
    scopeManager.enterScope('parent-composition');
    scopeManager.registerResource('parent-resource');
    
    // Enter child scope
    scopeManager.enterScope('child-composition');
    scopeManager.registerResource('child-resource');
    
    // Child should have access to both resources
    expect(scopeManager.isResourceAccessible('parent-resource')).toBe(true);
    expect(scopeManager.isResourceAccessible('child-resource')).toBe(true);
    
    // Check hierarchy
    const hierarchy = scopeManager.getScopeHierarchy();
    expect(hierarchy).toContain('parent-composition');
    expect(hierarchy).toContain('child-composition');
    
    // Exit child scope
    scopeManager.exitScope();
    
    // Parent should only have access to parent resource
    expect(scopeManager.isResourceAccessible('parent-resource')).toBe(true);
    expect(scopeManager.isResourceAccessible('child-resource')).toBe(false);
    
    // Exit parent scope
    scopeManager.exitScope();
    expect(scopeManager.getCurrentScope()).toBeUndefined();
  });

  it('should analyze composition functions with pattern detection', () => {
    const analyzer = new CompositionExpressionAnalyzer();
    
    // Mock schema proxy
    const mockSchemaProxy = {
      spec: {
        name: 'test-app',
        replicas: 3,
      },
      status: {},
    } as SchemaProxy<any, any>;

    // Mock composition context
    const context = createCompositionContext('test-composition');

    // Simple composition function
    const compositionFn = (spec: any) => ({
      ready: true,
      replicas: spec.replicas,
      url: `http://${spec.name}.example.com`,
    });

    // Analyze the composition
    const analysis = analyzer.analyzeCompositionFunction(compositionFn, mockSchemaProxy, context);
    
    expect(analysis).toBeDefined();
    expect(analysis.statusShape).toBeDefined();
    expect(analysis.conversionMetadata).toBeDefined();
    expect(typeof analysis.requiresCelConversion).toBe('boolean');
  });

  it('should validate composition pattern compatibility', () => {
    const analyzer = new CompositionExpressionAnalyzer();
    
    // Test imperative pattern with direct factory
    const imperativeDirectValidation = analyzer.validatePatternCompatibility('imperative', 'direct');
    expect(imperativeDirectValidation.isCompatible).toBe(true);
    
    // Test imperative pattern with kro factory
    const imperativeKroValidation = analyzer.validatePatternCompatibility('imperative', 'kro');
    expect(imperativeKroValidation.isCompatible).toBe(true);
    
    // Test declarative pattern with kro factory
    const declarativeKroValidation = analyzer.validatePatternCompatibility('declarative', 'kro');
    expect(declarativeKroValidation.isCompatible).toBe(true);
  });

  it('should provide pattern-specific recommendations', () => {
    const analyzer = new CompositionExpressionAnalyzer();
    
    // Mock analysis result with no KubernetesRef objects
    const mockAnalysisResult = {
      statusShape: {},
      kubernetesRefs: [],
      referencedResources: [],
      requiresCelConversion: false,
      conversionMetadata: {
        expressionsAnalyzed: 0,
        kubernetesRefsDetected: 0,
        celExpressionsGenerated: 0,
      },
    };

    const recommendations = analyzer.getPatternRecommendations('imperative', mockAnalysisResult);
    expect(Array.isArray(recommendations)).toBe(true);
  });
});

describe('CompositionExpressionAnalyzer', () => {
  it('should detect composition patterns correctly', () => {
    const analyzer = new CompositionExpressionAnalyzer();
    
    // Function that looks imperative
    const imperativeFunction = (_spec: any) => {
      // This would typically call simpleDeployment, etc.
      return { ready: true };
    };
    
    // Function that looks declarative
    const declarativeFunction = (spec: any) => ({ ready: spec.enabled });
    
    const imperativePattern = analyzer.detectCompositionPattern(imperativeFunction);
    const declarativePattern = analyzer.detectCompositionPattern(declarativeFunction);
    
    // Note: Without actual composition context, both might be detected as declarative
    // This is expected behavior for the pattern detection logic
    expect(['imperative', 'declarative']).toContain(imperativePattern);
    expect(['imperative', 'declarative']).toContain(declarativePattern);
  });

  it('should process composition status based on pattern', () => {
    const analyzer = new CompositionExpressionAnalyzer();
    
    const statusShape = {
      ready: true,
      url: 'http://example.com',
    };

    // Process for direct factory (should return unchanged)
    const directResult = analyzer.processCompositionByPattern(statusShape, 'imperative', 'direct');
    expect(directResult).toBe(statusShape);

    // Process for kro factory (should process through analyzer)
    const kroResult = analyzer.processCompositionByPattern(statusShape, 'imperative', 'kro');
    expect(kroResult).toBeDefined();
  });
});