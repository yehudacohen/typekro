/**
 * Unit tests for JavaScript expression analysis and KubernetesRef detection
 * 
 * These tests verify that the JavaScript expression analysis system correctly
 * detects KubernetesRef objects in expressions and converts them to CEL appropriately.
 * 
 * This test suite ensures that expressions containing KubernetesRef objects are
 * properly identified for conversion while static expressions are left unchanged.
 */

import { describe, expect, it } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import { analyzeStatusBuilderForToResourceGraph } from '../../src/core/expressions/status-builder-analyzer.js';
import { simple } from '../../src/index.js';

describe('JavaScript Expression Analysis', () => {
  describe('KubernetesRef detection in expressions', () => {
    it('should detect KubernetesRef objects in simple expressions', () => {
      // Create resources with KubernetesRef status fields
      const deployment = simple.Deployment({
        name: 'test-app',
        image: 'nginx:latest'
      });

      const service = simple.Service({
        name: 'test-service',
        ports: [{ port: 80 }],
        selector: { app: 'test-app' }
      });

      // Create status builder with expressions containing KubernetesRef objects
      const statusBuilder = (_schema: any, resources: any) => ({
        ready: resources.deployment.status.readyReplicas > 0,
        url: `http://${resources.service.status.clusterIP}:80`,
        replicas: resources.deployment.status.readyReplicas,
        phase: 'Running' // Static value
      });

      const mockResources = { deployment, service };
      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, mockResources);

      expect(analysis).toBeDefined();
      expect(analysis.statusMappings).toBeDefined();

      // Should detect KubernetesRef in expressions
      expect(analysis.statusMappings.ready?.toString()).toContain('${');
      expect(analysis.statusMappings.ready?.toString()).toContain('deployment.status.readyReplicas');
      
      expect(analysis.statusMappings.url?.toString()).toContain('${');
      expect(analysis.statusMappings.url?.toString()).toContain('service.status.clusterIP');
      
      expect(analysis.statusMappings.replicas?.toString()).toContain('${');
      expect(analysis.statusMappings.replicas?.toString()).toContain('deployment.status.readyReplicas');
      
      // Static value should remain unchanged
      expect(analysis.statusMappings.phase?.toString()).toBe('Running');
    });

    it('should handle complex expressions with multiple KubernetesRef objects', () => {
      const deployment = simple.Deployment({
        name: 'test-app',
        image: 'nginx:latest'
      });

      const service = simple.Service({
        name: 'test-service',
        ports: [{ port: 80 }],
        selector: { app: 'test-app' }
      });

      const statusBuilder = (_schema: any, resources: any) => ({
        // Complex boolean expression
        ready: resources.deployment.status.readyReplicas > 0 && 
               resources.service.status.clusterIP !== null,
        
        // Conditional expression
        phase: resources.deployment.status.readyReplicas === resources.deployment.spec.replicas 
               ? 'Ready' : 'Scaling',
        
        // Template with multiple references
        endpoint: `http://${resources.service.status.clusterIP}:${resources.service.spec.ports[0].port}`,
        
        // Static value for comparison
        environment: 'production'
      });

      const mockResources = { deployment, service };
      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, mockResources);

      // All expressions with KubernetesRef should be converted to CEL
      expect(analysis.statusMappings.ready?.toString()).toContain('${');
      expect(analysis.statusMappings.ready?.toString()).toContain('deployment.status.readyReplicas');
      expect(analysis.statusMappings.ready?.toString()).toContain('service.status.clusterIP');
      
      expect(analysis.statusMappings.phase?.toString()).toContain('${');
      expect(analysis.statusMappings.phase?.toString()).toContain('deployment.status.readyReplicas');
      expect(analysis.statusMappings.phase?.toString()).toContain('deployment.spec.replicas');
      
      expect(analysis.statusMappings.endpoint?.toString()).toContain('${');
      expect(analysis.statusMappings.endpoint?.toString()).toContain('service.status.clusterIP');
      
      // Static value should remain unchanged
      expect(analysis.statusMappings.environment?.toString()).toBe('production');
    });

    it('should handle optional chaining with KubernetesRef objects', () => {
      const service = simple.Service({
        name: 'test-service',
        ports: [{ port: 80 }],
        selector: { app: 'test-app' }
      });

      const statusBuilder = (_schema: any, resources: any) => ({
        // Optional chaining expressions
        ip: resources.service.status?.loadBalancer?.ingress?.[0]?.ip,
        ready: resources.service.status?.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True',
        url: resources.service.status?.loadBalancer?.ingress?.[0]?.ip 
             ? `https://${resources.service.status.loadBalancer.ingress[0].ip}`
             : 'pending'
      });

      const mockResources = { service };
      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, mockResources);

      // All expressions should be converted to CEL with proper optional chaining
      expect(analysis.statusMappings.ip?.toString()).toContain('${');
      expect(analysis.statusMappings.ip?.toString()).toContain('service.status');
      
      expect(analysis.statusMappings.ready?.toString()).toContain('${');
      expect(analysis.statusMappings.ready?.toString()).toContain('service.status');
      
      expect(analysis.statusMappings.url?.toString()).toContain('${');
      expect(analysis.statusMappings.url?.toString()).toContain('service.status');
    });
  });

  describe('Static value preservation', () => {
    it('should leave static values unchanged for performance', () => {
      const statusBuilder = (_schema: any, _resources: any) => ({
        // All static values - no KubernetesRef objects
        environment: 'production',
        version: '1.0.0',
        enabled: true,
        count: 42,
        config: {
          debug: false,
          timeout: 30
        }
      });

      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, {});

      // All values should remain unchanged (no CEL conversion)
      expect((analysis.statusMappings.environment as any)?.expression || analysis.statusMappings.environment?.toString()).toBe('production');
      expect((analysis.statusMappings.version as any)?.expression || analysis.statusMappings.version?.toString()).toBe('1.0.0');
      expect((analysis.statusMappings.enabled as any)?.expression || analysis.statusMappings.enabled?.toString()).toBe('true');
      expect((analysis.statusMappings.count as any)?.expression || analysis.statusMappings.count?.toString()).toBe('42');
      
      // Handle config object - it might be a direct object or a CelExpression
      const configMapping = analysis.statusMappings.config;
      if (configMapping && typeof configMapping === 'object' && 'expression' in configMapping) {
        // It's a CelExpression, try to parse the expression
        try {
          expect(JSON.parse((configMapping as any).expression)).toEqual({ debug: false, timeout: 30 });
        } catch {
          // If parsing fails, compare the expression string directly
          expect((configMapping as any).expression).toContain('debug');
          expect((configMapping as any).expression).toContain('timeout');
        }
      } else {
        // It's a direct object
        expect(configMapping).toBeDefined();
        expect(configMapping as any).toEqual({ debug: false, timeout: 30 });
      }
    });

    it('should handle mixed static and KubernetesRef expressions correctly', () => {
      const deployment = simple.Deployment({
        name: 'test-app',
        image: 'nginx:latest'
      });

      const statusBuilder = (_schema: any, resources: any) => ({
        // Static values
        environment: 'production',
        version: '1.0.0',
        
        // KubernetesRef expressions
        ready: resources.deployment.status.readyReplicas > 0,
        replicas: resources.deployment.status.readyReplicas,
        
        // Mixed expression (contains KubernetesRef)
        status: `v1.0.0-${resources.deployment.status.readyReplicas}-replicas`,
        
        // Static object
        metadata: {
          created: '2024-01-01',
          author: 'system'
        }
      });

      const mockResources = { deployment };
      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, mockResources);

      // Static values should remain unchanged
      expect((analysis.statusMappings.environment as any)?.expression || analysis.statusMappings.environment?.toString()).toBe('production');
      expect((analysis.statusMappings.version as any)?.expression || analysis.statusMappings.version?.toString()).toBe('1.0.0');
      
      // Handle metadata object - it might be a direct object or a CelExpression
      const metadataMapping = analysis.statusMappings.metadata;
      if (metadataMapping && typeof metadataMapping === 'object' && 'expression' in metadataMapping) {
        // It's a CelExpression, try to parse the expression
        try {
          expect(JSON.parse((metadataMapping as any).expression)).toEqual({
            created: '2024-01-01',
            author: 'system'
          });
        } catch {
          // If parsing fails, compare the expression string directly
          expect((metadataMapping as any).expression).toContain('created');
          expect((metadataMapping as any).expression).toContain('author');
        }
      } else {
        // It's a direct object
        expect(metadataMapping).toBeDefined();
        expect(metadataMapping as any).toEqual({
          created: '2024-01-01',
          author: 'system'
        });
      }

      // KubernetesRef expressions should be converted to CEL
      expect(analysis.statusMappings.ready?.toString()).toContain('${');
      expect(analysis.statusMappings.ready?.toString()).toContain('deployment.status.readyReplicas');
      
      expect(analysis.statusMappings.replicas?.toString()).toContain('${');
      expect(analysis.statusMappings.replicas?.toString()).toContain('deployment.status.readyReplicas');
      
      expect(analysis.statusMappings.status?.toString()).toContain('${');
      expect(analysis.statusMappings.status?.toString()).toContain('deployment.status.readyReplicas');
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle empty status builders gracefully', () => {
      const statusBuilder = (_schema: any, _resources: any) => ({});

      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, {});

      expect(analysis).toBeDefined();
      expect(analysis.statusMappings).toEqual({});
    });

    it('should handle status builders with undefined values', () => {
      const deployment = simple.Deployment({
        name: 'test-app',
        image: 'nginx:latest'
      });

      const statusBuilder = (_schema: any, resources: any) => ({
        ready: resources.deployment.status.readyReplicas > 0,
        url: undefined,
        phase: null,
        replicas: resources.deployment.status.readyReplicas
      });

      const mockResources = { deployment };
      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, mockResources);

      // Should handle undefined/null values appropriately
      expect(analysis.statusMappings.ready?.toString()).toContain('${');
      expect(analysis.statusMappings.url).toBeUndefined();
      expect(analysis.statusMappings.phase).toBeNull();
      expect(analysis.statusMappings.replicas?.toString()).toContain('${');
    });

    it('should handle deeply nested KubernetesRef expressions', () => {
      const deployment = simple.Deployment({
        name: 'test-app',
        image: 'nginx:latest'
      });

      const statusBuilder = (_schema: any, resources: any) => ({
        health: {
          deployment: {
            ready: resources.deployment.status.readyReplicas > 0,
            replicas: {
              current: resources.deployment.status.readyReplicas,
              desired: resources.deployment.spec.replicas
            }
          },
          overall: resources.deployment.status.readyReplicas === resources.deployment.spec.replicas
        }
      });

      const mockResources = { deployment };
      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, mockResources);

      // Should handle nested structures with KubernetesRef expressions
      expect(analysis.statusMappings.health).toBeDefined();
      expect(typeof analysis.statusMappings.health).toBe('object');
      
      // The nested expressions should be converted to CEL
      const healthStr = JSON.stringify(analysis.statusMappings.health);
      expect(healthStr).toContain('${');
      expect(healthStr).toContain('deployment.status.readyReplicas');
    });
  });

  describe('Regression prevention', () => {
    it('should catch if KubernetesRef detection stops working', () => {
      const deployment = simple.Deployment({
        name: 'regression-test',
        image: 'nginx:latest'
      });

      // This test ensures KubernetesRef objects are properly detected
      const readyReplicas = deployment.status.readyReplicas;
      
      // Should be a KubernetesRef function
      expect(typeof readyReplicas).toBe('function');
      expect(KUBERNETES_REF_BRAND in (readyReplicas as any)).toBe(true);
      
      // Should be detectable in expressions
      const statusBuilder = (_schema: any, resources: any) => ({
        ready: resources.deployment.status.readyReplicas > 0
      });

      const mockResources = { deployment };
      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, mockResources);

      // Should convert to CEL
      expect(analysis.statusMappings.ready?.toString()).toContain('${');
      expect(analysis.statusMappings.ready?.toString()).toContain('deployment.status.readyReplicas');
    });

    it('should ensure analysis works with all factory types', () => {
      // Test multiple factory types to ensure consistency
      const deployment = simple.Deployment({ name: 'test', image: 'nginx' });
      const service = simple.Service({ name: 'test', ports: [{ port: 80 }], selector: { app: 'test' } });
      const pvc = simple.Pvc({ name: 'test', size: '1Gi', accessModes: ['ReadWriteOnce'] });

      const statusBuilder = (_schema: any, resources: any) => ({
        deploymentReady: resources.deployment.status.readyReplicas > 0,
        serviceReady: resources.service.status.clusterIP !== null,
        storageReady: resources.pvc.status.phase === 'Bound'
      });

      const mockResources = { deployment, service, pvc };
      const analysis = analyzeStatusBuilderForToResourceGraph(statusBuilder, mockResources);

      // All expressions should be converted to CEL
      expect(analysis.statusMappings.deploymentReady?.toString()).toContain('${');
      expect(analysis.statusMappings.deploymentReady?.toString()).toContain('deployment.status.readyReplicas');
      
      expect(analysis.statusMappings.serviceReady?.toString()).toContain('${');
      expect(analysis.statusMappings.serviceReady?.toString()).toContain('service.status.clusterIP');
      
      expect(analysis.statusMappings.storageReady?.toString()).toContain('${');
      expect(analysis.statusMappings.storageReady?.toString()).toContain('pvc.status.phase');
    });
  });
});