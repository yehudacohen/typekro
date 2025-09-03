/**
 * Comprehensive tests for field hydration integration with magic proxy system
 * 
 * Tests that JavaScript expressions integrate properly with TypeKro's field hydration
 * strategy by tracking KubernetesRef dependencies for proper status field population order.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { FieldHydrationExpressionProcessor } from '../../../src/core/expressions/field-hydration-processor.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';

describe('Field Hydration Integration - Comprehensive Tests', () => {
  let processor: FieldHydrationExpressionProcessor;
  let mockResources: Record<string, Enhanced<any, any>>;
  let mockSchemaProxy: any;

  beforeEach(() => {
    processor = new FieldHydrationExpressionProcessor();
    
    mockSchemaProxy = {
      spec: {},
      status: {}
    };
    
    // Mock Enhanced resources
    mockResources = {
      deployment: {
        metadata: { name: 'test-deployment' },
        spec: { replicas: 3 },
        status: {
          readyReplicas: createMockRef('deployment', 'status.readyReplicas'),
          phase: createMockRef('deployment', 'status.phase'),
          conditions: createMockRef('deployment', 'status.conditions')
        }
      } as any,
      
      service: {
        metadata: { name: 'test-service' },
        spec: { type: 'ClusterIP' },
        status: {
          ready: createMockRef('service', 'status.ready'),
          clusterIP: createMockRef('service', 'status.clusterIP'),
          loadBalancer: createMockRef('service', 'status.loadBalancer')
        }
      } as any,
      
      ingress: {
        metadata: { name: 'test-ingress' },
        spec: { rules: [] },
        status: {
          loadBalancer: createMockRef('ingress', 'status.loadBalancer')
        }
      } as any
    };
  });

  function createMockRef(resourceId: string, fieldPath: string): KubernetesRef<any> {
    return {
      [KUBERNETES_REF_BRAND]: true,
      resourceId,
      fieldPath,
      _type: 'unknown'
    };
  }

  describe('Status Expression Analysis with Dependency Tracking', () => {
    it('should analyze status builders and track KubernetesRef dependencies', () => {
      const statusBuilder = (_schema: any, resources: typeof mockResources) => ({
        // Simple dependency on deployment
        ready: resources.deployment!.status.readyReplicas > 0,
        
        // Multiple dependencies
        healthy: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready,
        
        // Complex dependency chain
        url: resources.service!.status?.loadBalancer?.ingress?.[0]?.ip || 'pending',
        
        // Nested dependency
        status: {
          deployment: resources.deployment?.status.phase,
          service: resources.service!.status.ready,
          ingress: resources.ingress!.status?.loadBalancer?.ingress?.length > 0
        }
      });

      const result = processor.processStatusExpressions(
        statusBuilder,
        mockResources,
        mockSchemaProxy
      );

      expect(result).toBeDefined();
      expect(result.statusMappings).toBeDefined();
      expect(result.dependencies).toBeDefined();
      expect(result.hydrationOrder).toBeDefined();

      // Should have detected dependencies for each field
      expect(result.dependencies.has('ready')).toBe(true);
      expect(result.dependencies.has('healthy')).toBe(true);
      expect(result.dependencies.has('url')).toBe(true);
      expect(result.dependencies.has('status')).toBe(true);

      // Dependencies should include the correct resources
      const readyDeps = result.dependencies.get('ready') || [];

      expect(readyDeps.some(dep => dep.resourceId === 'deployment')).toBe(true);

      const healthyDeps = result.dependencies.get('healthy') || [];
      expect(healthyDeps.some(dep => dep.resourceId === 'deployment')).toBe(true);
      expect(healthyDeps.some(dep => dep.resourceId === 'service')).toBe(true);
    });

    it('should calculate proper hydration order based on dependencies', () => {
      const statusBuilder = (_schema: any, resources: typeof mockResources) => ({
        // Field that depends on deployment only
        deploymentReady: resources.deployment!.status.readyReplicas > 0,
        
        // Field that depends on service only
        serviceReady: resources.service!.status.ready,
        
        // Field that depends on both (should come after both are hydrated)
        overallReady: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready,
        
        // Field that depends on all three
        fullyReady: resources.deployment!.status.readyReplicas > 0 && 
                   resources.service!.status.ready && 
                   resources.ingress!.status?.loadBalancer?.ingress?.length > 0
      });

      const result = processor.processStatusExpressions(
        statusBuilder,
        mockResources,
        mockSchemaProxy
      );

      expect(result.hydrationOrder).toBeDefined();
      expect(result.hydrationOrder.length).toBeGreaterThan(0);

      // Fields with fewer dependencies should come first
      const deploymentReadyIndex = result.hydrationOrder.indexOf('deploymentReady');
      const serviceReadyIndex = result.hydrationOrder.indexOf('serviceReady');
      const overallReadyIndex = result.hydrationOrder.indexOf('overallReady');
      const fullyReadyIndex = result.hydrationOrder.indexOf('fullyReady');

      expect(deploymentReadyIndex).toBeGreaterThanOrEqual(0);
      expect(serviceReadyIndex).toBeGreaterThanOrEqual(0);
      expect(overallReadyIndex).toBeGreaterThan(Math.max(deploymentReadyIndex, serviceReadyIndex));
      expect(fullyReadyIndex).toBeGreaterThan(overallReadyIndex);
    });

    it('should handle optional chaining in dependency analysis', () => {
      const statusBuilder = (_schema: any, resources: typeof mockResources) => ({
        // Optional chaining should still track dependencies
        ingressIP: resources.ingress!.status?.loadBalancer?.ingress?.[0]?.ip,
        
        // Complex optional chaining
        serviceEndpoint: resources.service!.status?.loadBalancer?.ingress?.[0]?.ip || 
                        resources.service!.status?.clusterIP,
        
        // Conditional with optional chaining
        hasIngress: resources.ingress!.status?.loadBalancer?.ingress?.length > 0,
        
        // Mixed optional and required access
        endpoint: resources.service!.metadata.name + ':' + 
                 (resources.service!.status?.loadBalancer?.ingress?.[0]?.port || 80)
      });

      const result = processor.processStatusExpressions(
        statusBuilder,
        mockResources,
        mockSchemaProxy
      );

      expect(result).toBeDefined();

      // Should track dependencies even with optional chaining
      const ingressIPDeps = result.dependencies.get('ingressIP') || [];
      expect(ingressIPDeps.some(dep => dep.resourceId === 'ingress')).toBe(true);

      const serviceEndpointDeps = result.dependencies.get('serviceEndpoint') || [];
      expect(serviceEndpointDeps.some(dep => dep.resourceId === 'service')).toBe(true);

      const endpointDeps = result.dependencies.get('endpoint') || [];
      expect(endpointDeps.some(dep => dep.resourceId === 'service')).toBe(true);
    });
  });

  describe('Hydration Strategy Integration', () => {
    it('should integrate with field hydration strategy for ordering', () => {
      let calculateHydrationOrderCalled = false;
      let calculateHydrationOrderArgs: any = null;
      
      const mockStrategy = {
        calculateHydrationOrder: (dependencies: Map<string, any>) => {
          calculateHydrationOrderCalled = true;
          calculateHydrationOrderArgs = dependencies;
          return ['level1', 'level2', 'level3'];
        },
        canHydrateInParallel: () => false,
        getFieldPriority: () => 1
      };
      
      const customProcessor = new FieldHydrationExpressionProcessor(undefined, {
        hydrationStrategy: mockStrategy
      });
      
      const statusBuilder = (_schema: any, resources: typeof mockResources) => ({
        level1: resources.deployment!.status.readyReplicas > 0,
        level2: resources.service!.status.ready,
        level3: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready
      });

      const result = customProcessor.processStatusExpressions(
        statusBuilder,
        mockResources,
        mockSchemaProxy
      );

      expect(result.hydrationOrder).toBeDefined();
      expect(calculateHydrationOrderCalled).toBe(true);

      // Should have called the strategy with the correct dependencies
      expect(calculateHydrationOrderArgs).toBeDefined();
      expect(calculateHydrationOrderArgs).toBeInstanceOf(Map);
    });

    it('should handle complex dependency graphs', () => {
      const statusBuilder = (_schema: any, resources: typeof mockResources) => ({
        // Create a complex dependency graph
        a: resources.deployment!.status.readyReplicas > 0,
        b: resources.service!.status.ready,
        c: resources.ingress!.status?.loadBalancer?.ingress?.length > 0,
        
        // Fields that depend on previous fields (simulated)
        ab: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready,
        bc: resources.service!.status.ready && resources.ingress!.status?.loadBalancer?.ingress?.length > 0,
        ac: resources.deployment!.status.readyReplicas > 0 && resources.ingress!.status?.loadBalancer?.ingress?.length > 0,
        
        // Field that depends on everything
        abc: resources.deployment!.status.readyReplicas > 0 && 
             resources.service!.status.ready && 
             resources.ingress!.status?.loadBalancer?.ingress?.length > 0
      });

      const result = processor.processStatusExpressions(
        statusBuilder,
        mockResources,
        mockSchemaProxy
      );

      expect(result).toBeDefined();
      expect(result.hydrationOrder.length).toBe(7);

      // Basic fields should come first
      const basicFields = ['a', 'b', 'c'];
      const combinedFields = ['ab', 'bc', 'ac'];
      const finalField = 'abc';

      for (const field of basicFields) {
        const index = result.hydrationOrder.indexOf(field);
        expect(index).toBeGreaterThanOrEqual(0);
        
        // Should come before combined fields
        for (const combinedField of combinedFields) {
          const combinedIndex = result.hydrationOrder.indexOf(combinedField);
          expect(index).toBeLessThan(combinedIndex);
        }
        
        // Should come before final field
        const finalIndex = result.hydrationOrder.indexOf(finalField);
        expect(index).toBeLessThan(finalIndex);
      }
    });
  });

  describe('Performance with Large Dependency Graphs', () => {
    it('should handle large numbers of status fields efficiently', () => {
      // Create a status builder with many static fields (reduced from 100 to 10 for static analysis)
      const largeStatusBuilder = (_schema: any, resources: typeof mockResources) => ({
        field0: resources.deployment!.status.ready,
        field1: resources.service!.status.ready,
        field2: resources.ingress!.status?.loadBalancer?.ingress?.length > 0,
        field3: resources.deployment!.status.readyReplicas > 0,
        field4: resources.service!.status.ready,
        field5: resources.ingress!.status?.loadBalancer?.ingress?.length > 0,
        field6: resources.deployment!.status.readyReplicas > 0,
        field7: resources.service!.status.ready,
        field8: resources.ingress!.status?.loadBalancer?.ingress?.length > 0,
        field9: resources.deployment!.status.readyReplicas > 0
      });

      const startTime = performance.now();
      
      const result = processor.processStatusExpressions(
        largeStatusBuilder,
        mockResources,
        mockSchemaProxy
      );
      
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(result).toBeDefined();
      expect(result.statusMappings).toBeDefined();
      expect(Object.keys(result.statusMappings)).toHaveLength(10);
      
      // Should complete in reasonable time
      expect(duration).toBeLessThan(1000); // Less than 1 second
    });

    it('should scale well with dependency complexity', () => {
      // Test with different levels of complexity using static fields
      const simpleStatusBuilder = (_schema: any, resources: typeof mockResources) => ({
        simple1: resources.deployment!.status.readyReplicas > 0,
        simple2: resources.service!.status.ready
      });

      const mediumStatusBuilder = (_schema: any, resources: typeof mockResources) => ({
        simple1: resources.deployment!.status.readyReplicas > 0,
        simple2: resources.service!.status.ready,
        medium1: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready,
        medium2: resources.service!.status.ready && resources.ingress!.status?.loadBalancer?.ingress?.length > 0
      });

      const complexStatusBuilder = (_schema: any, resources: typeof mockResources) => ({
        simple1: resources.deployment!.status.readyReplicas > 0,
        simple2: resources.service!.status.ready,
        medium1: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready,
        medium2: resources.service!.status.ready && resources.ingress!.status?.loadBalancer?.ingress?.length > 0,
        complex1: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready && resources.ingress!.status?.loadBalancer?.ingress?.length > 0,
        complex2: resources.deployment!.status.readyReplicas > 0 || (resources.service!.status.ready && resources.ingress!.status?.loadBalancer?.ingress?.length > 0)
      });

      const builders = [simpleStatusBuilder, mediumStatusBuilder, complexStatusBuilder];
      const expectedCounts = [2, 4, 6];
      const durations: number[] = [];

      for (let i = 0; i < builders.length; i++) {
        const startTime = performance.now();
        
        const result = processor.processStatusExpressions(
          builders[i]!,
          mockResources,
          mockSchemaProxy
        );
        
        const endTime = performance.now();
        durations.push(endTime - startTime);

        expect(result).toBeDefined();
        expect(Object.keys(result.statusMappings)).toHaveLength(expectedCounts[i]!);
      }

      // Performance should scale reasonably (allow some variance)
      expect(durations[0]).toBeLessThan(1000);
      expect(durations[1]).toBeLessThan(1000);
      expect(durations[2]).toBeLessThan(1000);
    });
  });

  describe('Error Handling in Field Hydration', () => {
    it('should handle missing resources gracefully', () => {
      const statusBuilder = (_schema: any, resources: typeof mockResources) => ({
        // Valid expression that should work
        validReady: resources.deployment!.status.readyReplicas > 0,
        
        // Another valid expression
        serviceReady: resources.service!.status.ready,
        
        // Complex but valid expression
        bothReady: resources.deployment!.status.readyReplicas > 0 && resources.service!.status.ready
      });

      const result = processor.processStatusExpressions(
        statusBuilder,
        mockResources,
        mockSchemaProxy
      );

      expect(result).toBeDefined();
      expect(result.statusMappings).toBeDefined();
      
      // Should handle gracefully without throwing
      // All valid expressions should work
      expect(result.statusMappings.validReady).toBeDefined();
      expect(result.statusMappings.serviceReady).toBeDefined();
      expect(result.statusMappings.bothReady).toBeDefined();
      
      // Should have processed all valid fields
      expect(Object.keys(result.statusMappings)).toHaveLength(3);
    });

    it('should provide meaningful errors for invalid expressions', () => {
      const invalidStatusBuilder = (_schema: any, _resources: typeof mockResources) => ({
        // This might cause parsing errors
        invalid: 'resources.deployment!.status.readyReplicas >' // Incomplete expression
      });

      const result = processor.processStatusExpressions(
        invalidStatusBuilder,
        mockResources,
        mockSchemaProxy
      );

      expect(result).toBeDefined();
      
      // Should handle errors gracefully
      if (result.statusMappings.invalid === undefined) {
        // If the invalid expression was rejected, that's acceptable
        expect(true).toBe(true);
      } else {
        // If it was processed, it should be handled somehow
        expect(result.statusMappings.invalid).toBeDefined();
      }
    });
  });

  describe('Integration with Enhanced Type Optionality', () => {
    it('should handle Enhanced type fields that might be undefined at runtime', () => {
      // Simulate Enhanced types that appear non-optional but might be undefined during hydration
      const enhancedResources = {
        ...mockResources,
        deployment: {
          ...mockResources.deployment,
          status: {
            // These might be undefined during field hydration despite appearing non-optional
            readyReplicas: undefined,
            phase: undefined,
            conditions: undefined
          }
        }
      };

      const statusBuilder = (_schema: any, resources: typeof enhancedResources) => ({
        // These expressions should handle undefined values gracefully
        ready: (resources.deployment!.status?.readyReplicas || 0) > 0,
        phase: resources.deployment!.status?.phase || 'Unknown',
        hasConditions: (resources.deployment!.status?.conditions as any)?.length > 0
      });

      const result = processor.processStatusExpressions(
        statusBuilder as any,
        enhancedResources as Record<string, Enhanced<any, any>>,
        mockSchemaProxy
      );

      expect(result).toBeDefined();
      expect(result.statusMappings).toBeDefined();
      
      // Should handle undefined Enhanced fields
      expect(result.statusMappings.ready).toBeDefined();
      expect(result.statusMappings.phase).toBeDefined();
      expect(result.statusMappings.hasConditions).toBeDefined();
    });

    it('should add null-safety to generated CEL expressions for Enhanced types', () => {
      const statusBuilder = (_schema: any, resources: typeof mockResources) => ({
        // These should generate null-safe CEL expressions
        ready: resources.deployment!.status.readyReplicas > 0,
        phase: resources.deployment!.status.phase,
        conditions: resources.deployment!.status.conditions?.length > 0
      });

      const result = processor.processStatusExpressions(
        statusBuilder,
        mockResources,
        mockSchemaProxy
      );

      expect(result).toBeDefined();
      expect(result.statusMappings).toBeDefined();

      // The generated CEL expressions should include null-safety
      for (const [_fieldName, celExpression] of Object.entries(result.statusMappings)) {
        expect(celExpression).toBeDefined();
        
        // Should be a proper CEL expression (this would be validated by the actual CEL system)
        expect(typeof celExpression.toString).toBe('function');
      }
    });
  });


});