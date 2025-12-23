/**
 * Tests for Magic Proxy Analyzer
 * 
 * This test suite validates the magic proxy system integration for JavaScript
 * to CEL expression conversion, including KubernetesRef detection and analysis.
 */

import { describe, expect, it } from 'bun:test';
import {
  MagicProxyAnalyzer,
  MagicProxyUtils,
  globalMagicProxyAnalyzer,
  type MagicProxyAnalysisContext
} from '../../../src/core/expressions/magic-proxy-analyzer.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';

describe('Magic Proxy Analyzer', () => {

  const createContext = (): MagicProxyAnalysisContext => ({
    type: 'status',
    availableReferences: {
      deployment: {} as Enhanced<any, any>,
      service: {} as Enhanced<any, any>
    },
    factoryType: 'kro',
    dependencies: [],
    deepAnalysis: true,
    maxDepth: 5
  });

  const createKubernetesRef = (resourceId: string, fieldPath: string, type?: string): KubernetesRef<any> => ({
    [KUBERNETES_REF_BRAND]: true,
    resourceId,
    fieldPath,
    _type: type
  });

  describe('MagicProxyAnalyzer', () => {

    it('should detect KubernetesRef objects in simple values', () => {
      const analyzer = new MagicProxyAnalyzer();
      const kubernetesRef = createKubernetesRef('deployment', 'status.readyReplicas', 'number');

      const refs = analyzer.detectKubernetesRefs(kubernetesRef);

      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual(kubernetesRef);
    });

    it('should detect KubernetesRef objects in arrays', () => {
      const analyzer = new MagicProxyAnalyzer();
      const ref1 = createKubernetesRef('deployment', 'status.readyReplicas', 'number');
      const ref2 = createKubernetesRef('service', 'status.loadBalancer.ingress[0].ip', 'string');

      const array = [ref1, 'static-value', ref2];
      const refs = analyzer.detectKubernetesRefs(array);

      expect(refs).toHaveLength(2);
      expect(refs).toContain(ref1);
      expect(refs).toContain(ref2);
    });

    it('should detect KubernetesRef objects in nested objects', () => {
      const analyzer = new MagicProxyAnalyzer();
      const ref1 = createKubernetesRef('deployment', 'spec.replicas', 'number');
      const ref2 = createKubernetesRef('__schema__', 'spec.name', 'string');

      const nestedObject = {
        config: {
          replicas: ref1,
          name: ref2,
          static: 'value'
        },
        other: 'data'
      };

      const refs = analyzer.detectKubernetesRefs(nestedObject);

      expect(refs).toHaveLength(2);
      expect(refs).toContain(ref1);
      expect(refs).toContain(ref2);
    });

    it('should respect maximum depth to prevent infinite recursion', () => {
      const analyzer = new MagicProxyAnalyzer();
      const ref = createKubernetesRef('deployment', 'status.readyReplicas', 'number');

      // Create deeply nested structure
      let nested: any = ref;
      for (let i = 0; i < 20; i++) {
        nested = { level: i, data: nested };
      }

      const refs = analyzer.detectKubernetesRefs(nested, 5); // Max depth 5

      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual(ref);
    });

    it('should analyze expressions with KubernetesRef objects', () => {
      const analyzer = new MagicProxyAnalyzer();
      const context = createContext();
      const ref = createKubernetesRef('deployment', 'status.readyReplicas', 'number');

      const result = analyzer.analyzeExpressionWithRefs(ref, context);

      expect(result.valid).toBe(true);
      expect(result.celExpression).toBeTruthy();
      expect(result.celExpression!.expression).toBe('resources.deployment.status.readyReplicas');
      expect(result.dependencies).toHaveLength(1);
      expect(result.proxyTypes).toContain('resource');
      expect(result.resourceReferences).toContain('deployment.status.readyReplicas');
      expect(result.requiresConversion).toBe(true);
    });

    it('should handle schema references', () => {
      const analyzer = new MagicProxyAnalyzer();
      const context = createContext();
      const schemaRef = createKubernetesRef('__schema__', 'spec.name', 'string');

      const result = analyzer.analyzeExpressionWithRefs(schemaRef, context);

      expect(result.valid).toBe(true);
      expect(result.celExpression!.expression).toBe('schema.spec.name');
      expect(result.proxyTypes).toContain('schema');
      expect(result.schemaReferences).toContain('spec.name');
    });

    it('should handle expressions without KubernetesRef objects', () => {
      const analyzer = new MagicProxyAnalyzer();
      const context = createContext();
      const staticValue = { name: 'test', value: 42 };

      const result = analyzer.analyzeExpressionWithRefs(staticValue, context);

      expect(result.valid).toBe(true);
      expect(result.celExpression).toBeNull();
      expect(result.dependencies).toHaveLength(0);
      expect(result.proxyTypes).toHaveLength(0);
      expect(result.requiresConversion).toBe(false);
    });

    it('should validate KubernetesRef objects against available references', () => {
      const analyzer = new MagicProxyAnalyzer();
      const context = createContext();

      const validRef = createKubernetesRef('deployment', 'status.readyReplicas', 'number');
      const invalidRef = createKubernetesRef('nonexistent', 'status.field', 'string');

      const { valid, invalid } = analyzer.validateKubernetesRefs([validRef, invalidRef], context);

      expect(valid).toHaveLength(1);
      expect(valid[0]).toEqual(validRef);
      expect(invalid).toHaveLength(1);
      expect(invalid[0]?.ref).toEqual(invalidRef);
      expect(invalid[0]?.reason).toContain('not found in available references');
    });

    it('should handle analysis errors gracefully', () => {
      const analyzer = new MagicProxyAnalyzer();
      const context = createContext();

      // Create a problematic value that might cause errors
      const problematicValue = {
        get badProperty() {
          throw new Error('Property access failed');
        }
      };

      const result = analyzer.analyzeExpressionWithRefs(problematicValue, context);

      // The analyzer should handle property access errors gracefully by skipping them
      // This results in a successful analysis with no KubernetesRefs found
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.celExpression).toBe(null);
      expect(result.requiresConversion).toBe(false);
    });

  });

  describe('MagicProxyUtils', () => {

    it('should check if value contains KubernetesRef objects', () => {
      const ref = createKubernetesRef('deployment', 'status.readyReplicas', 'number');
      const objectWithRef = { data: ref };
      const objectWithoutRef = { data: 'static' };

      expect(MagicProxyUtils.containsKubernetesRefs(ref)).toBe(true);
      expect(MagicProxyUtils.containsKubernetesRefs(objectWithRef)).toBe(true);
      expect(MagicProxyUtils.containsKubernetesRefs(objectWithoutRef)).toBe(false);
    });

    it('should extract KubernetesRef objects from complex structures', () => {
      const ref1 = createKubernetesRef('deployment', 'spec.replicas', 'number');
      const ref2 = createKubernetesRef('service', 'status.loadBalancer.ingress[0].ip', 'string');

      const complexStructure = {
        config: [ref1, { nested: ref2 }],
        other: 'data'
      };

      const refs = MagicProxyUtils.extractKubernetesRefs(complexStructure);

      expect(refs).toHaveLength(2);
      expect(refs).toContain(ref1);
      expect(refs).toContain(ref2);
    });

    it('should identify KubernetesRef objects correctly', () => {
      const validRef = createKubernetesRef('deployment', 'status.readyReplicas', 'number');
      const invalidRef = { resourceId: 'test', fieldPath: 'field' }; // Missing __brand
      const notRef = { some: 'object' };

      expect(MagicProxyUtils.isKubernetesRef(validRef)).toBe(true);
      expect(MagicProxyUtils.isKubernetesRef(invalidRef)).toBe(false);
      expect(MagicProxyUtils.isKubernetesRef(notRef)).toBe(false);
    });

    it('should identify schema references', () => {
      const schemaRef = createKubernetesRef('__schema__', 'spec.name', 'string');
      const resourceRef = createKubernetesRef('deployment', 'status.readyReplicas', 'number');

      expect(MagicProxyUtils.isSchemaReference(schemaRef)).toBe(true);
      expect(MagicProxyUtils.isSchemaReference(resourceRef)).toBe(false);
    });

    it('should identify resource references', () => {
      const schemaRef = createKubernetesRef('__schema__', 'spec.name', 'string');
      const resourceRef = createKubernetesRef('deployment', 'status.readyReplicas', 'number');

      expect(MagicProxyUtils.isResourceReference(schemaRef)).toBe(false);
      expect(MagicProxyUtils.isResourceReference(resourceRef)).toBe(true);
    });

    it('should generate correct CEL expressions', () => {
      const schemaRef = createKubernetesRef('__schema__', 'spec.name', 'string');
      const resourceRef = createKubernetesRef('deployment', 'status.readyReplicas', 'number');

      expect(MagicProxyUtils.getCelExpression(schemaRef)).toBe('schema.spec.name');
      expect(MagicProxyUtils.getCelExpression(resourceRef)).toBe('resources.deployment.status.readyReplicas');
    });

  });

  describe('Global Magic Proxy Analyzer', () => {

    it('should provide a global analyzer instance', () => {
      expect(globalMagicProxyAnalyzer).toBeInstanceOf(MagicProxyAnalyzer);
    });

    it('should be reusable across multiple analyses', () => {
      const ref1 = createKubernetesRef('deployment', 'status.readyReplicas', 'number');
      const ref2 = createKubernetesRef('service', 'status.loadBalancer.ingress[0].ip', 'string');

      const refs1 = globalMagicProxyAnalyzer.detectKubernetesRefs(ref1);
      const refs2 = globalMagicProxyAnalyzer.detectKubernetesRefs(ref2);

      expect(refs1).toHaveLength(1);
      expect(refs2).toHaveLength(1);
      expect(refs1[0]).toEqual(ref1);
      expect(refs2[0]).toEqual(ref2);
    });

  });

});


/**
 * Property-Based Tests for Modern Syntax Native Support
 *
 * **Feature: unify-acorn-parser, Property 2: Modern Syntax Native Support**
 * **Validates: Requirements 1.3, 1.4, 6.2**
 *
 * Property 2: Modern Syntax Native Support
 * *For any* JavaScript expression containing optional chaining (?.) or nullish coalescing (??),
 * the parser SHALL parse it successfully without any preprocessing transformation.
 */
import fc from 'fast-check';

describe('Property-Based Tests: Modern Syntax Native Support', () => {
  /**
   * Arbitrary for generating valid JavaScript identifiers
   */
  const identifierArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/).filter((s) => {
    // Filter out JavaScript reserved words
    const reserved = [
      'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete',
      'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof',
      'new', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
      'void', 'while', 'with', 'class', 'const', 'enum', 'export', 'extends',
      'import', 'super', 'implements', 'interface', 'let', 'package', 'private',
      'protected', 'public', 'static', 'yield', 'null', 'true', 'false',
    ];
    return s.length > 0 && s.length <= 20 && !reserved.includes(s);
  });

  /**
   * Arbitrary for generating optional chaining expressions (ES2020+)
   * These should be parsed natively without preprocessing
   */
  const optionalChainingExpressionArb = fc
    .array(identifierArb, { minLength: 2, maxLength: 5 })
    .map((parts) => parts.join('?.'));

  /**
   * Arbitrary for generating nullish coalescing expressions (ES2020+)
   * These should be parsed natively without preprocessing
   */
  const nullishCoalescingExpressionArb = fc
    .tuple(identifierArb, identifierArb)
    .map(([left, right]) => `${left} ?? ${right}`);

  /**
   * Arbitrary for generating combined optional chaining + nullish coalescing
   */
  const combinedModernSyntaxArb = fc
    .tuple(
      fc.array(identifierArb, { minLength: 2, maxLength: 4 }),
      identifierArb
    )
    .map(([chainParts, fallback]) => `${chainParts.join('?.')} ?? ${fallback}`);

  /**
   * Arbitrary for generating complex modern syntax expressions
   */
  const complexModernSyntaxArb = fc.oneof(
    optionalChainingExpressionArb,
    nullishCoalescingExpressionArb,
    combinedModernSyntaxArb
  );

  const createContext = (): MagicProxyAnalysisContext => ({
    type: 'status',
    availableReferences: {},
    factoryType: 'kro',
    dependencies: [],
    deepAnalysis: true,
    maxDepth: 5
  });

  it('Property 2.1: Optional chaining expressions should parse without preprocessing', () => {
    /**
     * **Feature: unify-acorn-parser, Property 2: Modern Syntax Native Support**
     * **Validates: Requirements 1.3, 6.2**
     */
    fc.assert(
      fc.property(optionalChainingExpressionArb, (expression) => {
        const analyzer = new MagicProxyAnalyzer();
        const context = createContext();
        
        // The analyzer should be able to analyze the expression without errors
        // This validates that optional chaining is parsed natively
        const result = analyzer.analyzeExpressionWithRefs(expression, context);
        
        // The analysis should complete without throwing
        // Even if no KubernetesRefs are found, the parsing should succeed
        return result !== undefined && result.errors.length === 0;
      }),
      { numRuns: 100 }
    );
  });

  it('Property 2.2: Nullish coalescing expressions should parse without preprocessing', () => {
    /**
     * **Feature: unify-acorn-parser, Property 2: Modern Syntax Native Support**
     * **Validates: Requirements 1.4, 6.2**
     */
    fc.assert(
      fc.property(nullishCoalescingExpressionArb, (expression) => {
        const analyzer = new MagicProxyAnalyzer();
        const context = createContext();
        
        // The analyzer should be able to analyze the expression without errors
        // This validates that nullish coalescing is parsed natively
        const result = analyzer.analyzeExpressionWithRefs(expression, context);
        
        // The analysis should complete without throwing
        return result !== undefined && result.errors.length === 0;
      }),
      { numRuns: 100 }
    );
  });

  it('Property 2.3: Combined modern syntax should parse without preprocessing', () => {
    /**
     * **Feature: unify-acorn-parser, Property 2: Modern Syntax Native Support**
     * **Validates: Requirements 1.3, 1.4, 6.2**
     */
    fc.assert(
      fc.property(combinedModernSyntaxArb, (expression) => {
        const analyzer = new MagicProxyAnalyzer();
        const context = createContext();
        
        // The analyzer should handle combined optional chaining and nullish coalescing
        const result = analyzer.analyzeExpressionWithRefs(expression, context);
        
        // The analysis should complete without throwing
        return result !== undefined && result.errors.length === 0;
      }),
      { numRuns: 100 }
    );
  });

  it('Property 2.4: Modern syntax expressions should not require any transformation', () => {
    /**
     * **Feature: unify-acorn-parser, Property 2: Modern Syntax Native Support**
     * **Validates: Requirements 1.3, 1.4, 6.2**
     * 
     * This property validates that the parser handles modern syntax natively,
     * meaning no preprocessing step is needed to transform ?. or ?? operators.
     */
    fc.assert(
      fc.property(complexModernSyntaxArb, (expression) => {
        const analyzer = new MagicProxyAnalyzer();
        const context = createContext();
        
        // Analyze the expression - this should work without any preprocessing
        const result = analyzer.analyzeExpressionWithRefs(expression, context);
        
        // The result should be valid (no parse errors)
        // The expression may or may not require conversion depending on content
        // but the parsing itself should succeed
        return result.valid === true;
      }),
      { numRuns: 100 }
    );
  });

  it('Property 2.5: ES2022 features should be supported by default', () => {
    /**
     * **Feature: unify-acorn-parser, Property 2: Modern Syntax Native Support**
     * **Validates: Requirements 6.1, 6.2**
     * 
     * This property validates that ES2022 features are supported by default
     * without requiring any special configuration.
     */
    const es2022Expressions = [
      'obj?.prop',
      'obj?.method?.()',
      'arr?.[0]',
      'value ?? fallback',
      'obj?.prop ?? "default"',
      'a?.b?.c ?? d?.e ?? "fallback"',
    ];

    for (const expression of es2022Expressions) {
      const analyzer = new MagicProxyAnalyzer();
      const context = createContext();
      
      const result = analyzer.analyzeExpressionWithRefs(expression, context);
      
      // All ES2022 expressions should parse successfully
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });
});
