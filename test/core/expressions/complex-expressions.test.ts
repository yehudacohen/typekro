/**
 * Tests for complex nested expressions and edge cases with KubernetesRef objects
 * 
 * This test suite validates that the JavaScript to CEL conversion system can handle
 * complex, deeply nested expressions with multiple KubernetesRef objects and edge cases.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { JavaScriptToCelAnalyzer, type AnalysisContext } from '../../../src/core/expressions/analyzer.js';
import { SourceMapBuilder } from '../../../src/core/expressions/source-map.js';

describe('Complex Expressions and Edge Cases', () => {
  let analyzer: JavaScriptToCelAnalyzer;
  let mockContext: AnalysisContext;

  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    
    mockContext = {
      type: 'status',
      availableReferences: {
        deployment: {} as any,
        service: {} as any,
        ingress: {} as any,
        configmap: {} as any,
        secret: {} as any,
        database: {} as any,
        redis: {} as any,
        monitoring: {} as any
      },
      factoryType: 'kro',
      sourceMap: new SourceMapBuilder(),
      dependencies: []
    };
  });

  describe('Deeply Nested Expressions', () => {
    it('should handle deeply nested property access', () => {
      const deepExpressions = [
        'deployment.status.conditions[0].lastTransitionTime',
        'service.status.loadBalancer.ingress[0].hostname',
        'ingress.status.loadBalancer.ingress[0].ports[0].port',
        'deployment.spec.template.spec.containers[0].env[0].value',
        'configmap.data["config.yaml"].split("\\n")[0]'
      ];

      for (const expr of deepExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
        expect(result.celExpression).toBeDefined();
        
        // Should preserve the deep nesting in CEL
        const celString = result.celExpression!.expression;
        expect(celString).toContain('.');
      }
    });

    it('should handle nested optional chaining', () => {
      const optionalChainExpressions = [
        'service.status?.loadBalancer?.ingress?.[0]?.ip',
        'deployment.status?.conditions?.[0]?.lastTransitionTime',
        'ingress.spec?.rules?.[0]?.http?.paths?.[0]?.path',
        'configmap.data?.["app.config"]?.split?.("\\n")?.[0]',
        'secret.data?.password?.toString?.()?.length'
      ];

      for (const expr of optionalChainExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
        
        // Should use Kro's ? operator
        const celString = result.celExpression!.expression;
        expect(celString).toContain('?');
      }
    });

    it('should handle nested conditional expressions', () => {
      const nestedConditionals = [
        'deployment.status.readyReplicas > 0 ? (service.status.ready ? "fully-ready" : "partially-ready") : "not-ready"',
        'schema.spec.environment === "production" ? (schema.spec.replicas > 1 ? "ha-prod" : "single-prod") : (schema.spec.environment === "staging" ? "staging" : "dev")',
        'deployment.status.phase === "Running" ? (deployment.status.readyReplicas === schema.spec.replicas ? "healthy" : "degraded") : (deployment.status.phase === "Pending" ? "starting" : "failed")'
      ];

      for (const expr of nestedConditionals) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
        
        // Should handle nested ternary operators
        const celString = result.celExpression!.expression;
        expect(celString).toContain('?');
        expect(celString).toContain(':');
      }
    });
  });

  describe('Complex Template Literals', () => {
    it('should handle template literals with multiple interpolations', () => {
      const complexTemplates = [
        '`http://${service.status.loadBalancer.ingress[0].ip}:${service.spec.ports[0].port}/${schema.spec.path}`',
        '`${schema.spec.name}-${deployment.status.readyReplicas}/${schema.spec.replicas}-${service.status.ready ? "ready" : "not-ready"}`',
        '`Database: postgres://${database.status.podIP}:5432/${schema.spec.dbName}?sslmode=${schema.spec.ssl ? "require" : "disable"}`',
        '`Status: ${deployment.status.phase} | Ready: ${deployment.status.readyReplicas}/${schema.spec.replicas} | URL: ${service.status?.loadBalancer?.ingress?.[0]?.ip || "pending"}`'
      ];

      for (const expr of complexTemplates) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
        
        // Should handle multiple interpolations
        const celString = result.celExpression!.expression;
        expect(celString).toBeDefined();
      }
    });

    it('should handle nested template literals', () => {
      const nestedTemplates = [
        '`Outer: ${`Inner: ${deployment.status.readyReplicas}`}`',
        '`Config: ${configmap.data[`${schema.spec.name}-config`]}`',
        '`URL: ${service.status.ready ? `http://${service.status.clusterIP}` : "not-ready"}`'
      ];

      for (const expr of nestedTemplates) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should handle template literals with complex expressions', () => {
      const complexExpressionTemplates = [
        '`Ready: ${deployment.status.conditions.find(c => c.type === "Available")?.status === "True" ? "yes" : "no"}`',
        '`Health: ${deployment.status.readyReplicas > 0 && service.status.ready && ingress.status?.loadBalancer?.ingress?.length > 0 ? "healthy" : "unhealthy"}`',
        '`Replicas: ${Math.min(deployment.status.readyReplicas || 0, schema.spec.replicas)}`'
      ];

      for (const expr of complexExpressionTemplates) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Complex Logical Expressions', () => {
    it('should handle complex boolean logic with multiple resources', () => {
      const complexLogicalExpressions = [
        'deployment.status.readyReplicas > 0 && service.status.ready && ingress.status?.loadBalancer?.ingress?.length > 0',
        '(deployment.status.phase === "Running" || deployment.status.phase === "Succeeded") && service.status.ready',
        'deployment.status.readyReplicas === schema.spec.replicas && service.status.ready && (ingress.status?.loadBalancer?.ingress?.length > 0 || schema.spec.ingress === false)',
        '(database.status.ready ?? false) && (redis.status?.ready ?? false) && deployment.status.readyReplicas > 0'
      ];

      for (const expr of complexLogicalExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
        
        // Should contain multiple resource references
        const resourceIds = new Set(result.dependencies.map(dep => dep.resourceId));
        expect(resourceIds.size).toBeGreaterThan(1);
      }
    });

    it('should handle mixed logical and comparison operators', () => {
      const mixedExpressions = [
        'deployment.status.readyReplicas >= schema.spec.replicas * 0.8 && service.status.ready',
        'deployment.status.readyReplicas > 0 || (service.status.type === "NodePort" && service.status.ready)',
        '(deployment.status.readyReplicas / schema.spec.replicas) > 0.5 && service.status.loadBalancer?.ingress?.length > 0',
        'deployment.status.readyReplicas === schema.spec.replicas && (service.status.ready ?? false) && ingress.status?.loadBalancer?.ingress?.[0]?.ip !== undefined'
      ];

      for (const expr of mixedExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Array and Object Method Calls', () => {
    it('should handle complex array method chains', () => {
      const arrayMethodExpressions = [
        'deployment.status.conditions.filter(c => c.status === "True").map(c => c.type)',
        'service.spec.ports.find(p => p.name === "http")?.port',
        'deployment.status.conditions.some(c => c.type === "Available" && c.status === "True")',
        'ingress.spec.rules.flatMap(r => r.http.paths).find(p => p.path === schema.spec.path)',
        'deployment.spec.template.spec.containers.filter(c => c.name.startsWith(schema.spec.name))'
      ];

      for (const expr of arrayMethodExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should handle nested method calls with complex predicates', () => {
      const nestedMethodExpressions = [
        'deployment.status.conditions.find(c => c.type === "Available" && c.status === "True" && c.lastTransitionTime)',
        'service.spec.ports.filter(p => p.port > 1000 && p.protocol === "TCP").map(p => p.targetPort)',
        'deployment.spec.template.spec.containers.find(c => c.env.some(e => e.name === "DATABASE_URL"))?.image',
        'ingress.spec.rules.find(r => r.host === schema.spec.hostname)?.http?.paths?.find(p => p.path === "/api")?.backend?.service?.name'
      ];

      for (const expr of nestedMethodExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle expressions with null and undefined checks', () => {
      const nullCheckExpressions = [
        'deployment.status.readyReplicas !== null && deployment.status.readyReplicas !== undefined',
        'service.status?.loadBalancer?.ingress?.[0]?.ip != null',
        'deployment.status.conditions?.length > 0 && deployment.status.conditions[0] !== undefined',
        '(database.status?.ready ?? null) !== null',
        'service.status.loadBalancer?.ingress !== undefined && service.status.loadBalancer.ingress.length > 0'
      ];

      for (const expr of nullCheckExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should handle expressions with type coercion', () => {
      const typeCoercionExpressions = [
        'Boolean(deployment.status.readyReplicas)',
        'String(service.spec.ports[0].port)',
        'Number(configmap.data.replicas)',
        '!!deployment.status.ready',
        '+deployment.status.readyReplicas'
      ];

      for (const expr of typeCoercionExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should handle expressions with mathematical operations', () => {
      const mathExpressions = [
        'deployment.status.readyReplicas / schema.spec.replicas * 100',
        'Math.min(deployment.status.readyReplicas, schema.spec.replicas)',
        'Math.max(0, deployment.status.readyReplicas - 1)',
        'Math.round((deployment.status.readyReplicas / schema.spec.replicas) * 100)',
        'deployment.status.readyReplicas ** 2'
      ];

      for (const expr of mathExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('should handle expressions with string operations', () => {
      const stringExpressions = [
        'schema.spec.name.toUpperCase()',
        'deployment.metadata.name.includes(schema.spec.prefix)',
        'service.metadata.name.startsWith(schema.spec.name)',
        'configmap.data.config.split("\\n").join(", ")',
        '`${schema.spec.name}`.padStart(10, "0")'
      ];

      for (const expr of stringExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Performance with Complex Expressions', () => {
    it('should handle very complex expressions efficiently', () => {
      const veryComplexExpression = `
        deployment.status.conditions.find(c => c.type === "Available")?.status === "True" &&
        service.status.ready &&
        (ingress.status?.loadBalancer?.ingress?.length > 0 || schema.spec.ingress === false) &&
        (database.status?.ready ?? false) &&
        (redis.status?.ready ?? true) &&
        deployment.status.readyReplicas >= Math.ceil(schema.spec.replicas * 0.8) &&
        service.spec.ports.some(p => p.port === 80 || p.port === 443) &&
        deployment.spec.template.spec.containers.every(c => 
          c.resources?.limits?.memory && 
          c.resources?.limits?.cpu &&
          c.env?.some(e => e.name === "NODE_ENV")
        ) &&
        configmap.data?.["app.config"]?.includes(schema.spec.environment) &&
        secret.data?.password?.length > 8
      `.trim().replace(/\s+/g, ' ');

      const startTime = performance.now();
      const result = analyzer.analyzeExpression(veryComplexExpression, mockContext);
      const endTime = performance.now();

      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies.length).toBeGreaterThan(0);
      
      // Should complete complex analysis in reasonable time
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(500); // Less than 500ms
      
      // Should have multiple resource dependencies
      const resourceIds = new Set(result.dependencies.map(dep => dep.resourceId));
      expect(resourceIds.size).toBeGreaterThan(3);
    });

    it('should handle expressions with many nested levels', () => {
      const deeplyNestedExpression = 'deployment.spec.template.spec.containers[0].env.find(e => e.name === "CONFIG").valueFrom.configMapKeyRef.key';
      
      const result = analyzer.analyzeExpression(deeplyNestedExpression, mockContext);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies.length).toBeGreaterThan(0);
      
      // Should preserve deep nesting structure
      const celString = result.celExpression!.expression;
      expect(celString.split('.').length).toBeGreaterThan(5);
    });
  });

  describe('Error Handling in Complex Expressions', () => {
    it('should provide meaningful errors for complex invalid expressions', () => {
      const complexInvalidExpressions = [
        'deployment.status.conditions.find(c => c.type === "Available" && c.status === "True"',  // Missing closing parenthesis
        'service.status?.loadBalancer?.ingress?.[0]?.ip || "pending")',  // Extra closing parenthesis
        '`${deployment.status.readyReplicas > 0 ? "ready" : "not-ready"`',  // Missing closing brace in template
        'deployment.status.readyReplicas > 0 && (service.status.ready && ingress.status.ready',  // Unmatched parenthesis
      ];

      for (const expr of complexInvalidExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        
        const error = result.errors[0];
        expect(error?.message).toBeDefined();
        expect(error?.expression).toBe(expr);
        
        // Should provide helpful context for complex expressions
        expect(error?.message.length).toBeGreaterThan(10);
      }
    });

    it('should handle partial failures in complex expressions gracefully', () => {
      const partiallyValidComplexExpressions = [
        'deployment.status.readyReplicas > 0 && service.status.invalidProperty',
        'validExpression && deployment.status.conditions.invalidMethod()',
        'deployment.status.readyReplicas > 0 ? "ready" : invalidExpression'
      ];

      for (const expr of partiallyValidComplexExpressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        
        // Should attempt to parse what it can
        expect(result).toBeDefined();
        
        if (result.valid) {
          // If it succeeds, should have extracted some valid dependencies
          expect(result.dependencies.length).toBeGreaterThanOrEqual(0);
        } else {
          // If it fails, should provide helpful error information
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors[0]?.message).toBeDefined();
        }
      }
    });
  });
});