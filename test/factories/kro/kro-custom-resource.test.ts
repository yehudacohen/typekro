/**
 * Test suite for KroCustomResource Factory Function
 *
 * This tests the generic Kro custom resource factory with schema-based typing
 * and comprehensive readiness evaluation logic.
 */

import { describe, expect, it } from 'bun:test';
import { kroCustomResource } from '../../../src/factories/kro/kro-custom-resource.js';

describe('KroCustomResource Factory', () => {
  // Test spec and status types
  interface TestSpec {
    image: string;
    replicas?: number;
    config?: Record<string, string>;
  }

  interface TestStatus {
    phase: string;
    readyReplicas?: number;
  }

  const createTestResource = (name: string = 'testResource') => ({
    apiVersion: 'webapp.example.com/v1alpha1',
    kind: 'WebApplication',
    metadata: {
      name,
      namespace: 'default'
    },
    spec: {
      image: 'nginx:latest',
      replicas: 3,
      config: {
        env: 'production'
      }
    } as TestSpec
  });

  describe('Factory Creation', () => {
    it('should create kroCustomResource with proper structure', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('WebApplication');
      expect(enhanced.apiVersion).toBe('webapp.example.com/v1alpha1');
      expect(enhanced.metadata.name).toBe('testResource');
      expect(enhanced.metadata.namespace).toBe('default');
      expect(enhanced.spec.image).toBe('nginx:latest');
      expect(enhanced.spec.replicas).toBe(3);
    });

    it('should preserve original spec configuration', () => {
      const resourceConfig = createTestResource('customApp');
      resourceConfig.spec.config = { debug: 'true', timeout: '30s' };
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);

      expect(enhanced.spec.config?.debug).toBe('true');
      expect(enhanced.spec.config?.timeout).toBe('30s');
      expect(enhanced.metadata.name).toBe('customApp');
    });

    it('should handle minimal resource configuration', () => {
      const minimalConfig = {
        apiVersion: 'example.com/v1',
        kind: 'MinimalResource',
        metadata: { name: 'minimal' },
        spec: { image: 'alpine' } as TestSpec
      };

      const enhanced = kroCustomResource<TestSpec, TestStatus>(minimalConfig);

      expect(enhanced.kind).toBe('MinimalResource');
      expect(enhanced.spec.image).toBe('alpine');
      expect(enhanced.metadata.namespace).toBeDefined(); // Should have proxy function
    });

    it('should handle different custom resource kinds', () => {
      const databaseConfig = {
        apiVersion: 'database.example.com/v1beta1',
        kind: 'PostgreSQLCluster',
        metadata: { name: 'pgCluster', namespace: 'databases' },
        spec: { version: '14', replicas: 3 } as any
      };

      const enhanced = kroCustomResource(databaseConfig);

      expect(enhanced.kind).toBe('PostgreSQLCluster');
      expect(enhanced.apiVersion).toBe('database.example.com/v1beta1');
      expect(enhanced.metadata.namespace).toBe('databases');
    });
  });

  describe('Readiness Evaluator', () => {
    it('should attach readiness evaluator', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);

      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate as not ready when status is missing', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testResource' },
        spec: { image: 'nginx:latest' }
        // No status
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
      expect(result.message).toBe('WebApplication status not yet available');
    });

    it('should evaluate as not ready when state field is missing', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testResource' },
        spec: { image: 'nginx:latest' },
        status: {
          // Missing state field
          conditions: []
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StateFieldMissing');
      expect(result.message).toBe('WebApplication state field not yet populated by Kro controller');
    });

    it('should evaluate as ready when state is ACTIVE with Ready condition', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testResource' },
        spec: { image: 'nginx:latest' },
        status: {
          state: 'ACTIVE',
          conditions: [
            { type: 'Ready', status: 'True', message: 'All resources are ready' }
          ],
          phase: 'Running',
          readyReplicas: 3
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('WebApplication instance is active and ready');
    });

    it('should evaluate as ready when state is ACTIVE with InstanceSynced condition', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testResource' },
        spec: { image: 'nginx:latest' },
        status: {
          state: 'ACTIVE',
          conditions: [
            { type: 'InstanceSynced', status: 'True', message: 'Instance is synced' }
          ]
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('WebApplication instance is active and synced');
    });

    it('should evaluate as not ready when state is FAILED', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testResource' },
        spec: { image: 'nginx:latest' },
        status: {
          state: 'FAILED',
          conditions: [
            { type: 'Ready', status: 'False', message: 'Deployment failed' }
          ]
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroInstanceFailed');
      expect(result.message).toContain('WebApplication instance failed');
    });

    it('should evaluate as not ready when state is PROGRESSING', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testResource' },
        spec: { image: 'nginx:latest' },
        status: {
          state: 'PROGRESSING',
          conditions: []
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroInstanceProgressing');
      expect(result.message).toBe('WebApplication instance progressing - State: PROGRESSING');
    });

    it('should evaluate as not ready when state is not ACTIVE', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testResource' },
        spec: { image: 'nginx:latest' },
        status: {
          state: 'PENDING',
          conditions: []
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StateNotActive');
      expect(result.message).toBe("WebApplication state is 'PENDING', waiting for 'ACTIVE'");
    });

    it('should handle malformed status gracefully', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testResource' },
        spec: { image: 'nginx:latest' },
        status: 'invalid-status' // Non-object status
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StateFieldMissing');
    });

    it('should handle Ready condition false status', () => {
      const resourceConfig = createTestResource();
      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testResource' },
        spec: { image: 'nginx:latest' },
        status: {
          state: 'ACTIVE',
          conditions: [
            { type: 'Ready', status: 'False', message: 'Still waiting for resources' }
          ]
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ReadyConditionFalse');
      expect(result.message).toContain("WebApplication Ready condition is 'False'");
    });
  });

  describe('Error Handling', () => {
    it('should handle missing metadata gracefully', () => {
      const resourceConfig = {
        apiVersion: 'example.com/v1',
        kind: 'TestResource',
        spec: { image: 'nginx' } as TestSpec
      } as any;

      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('TestResource');
      expect(enhanced.metadata.name).toBe('unnamed-kro-resource');
    });

    it('should handle missing spec gracefully', () => {
      const resourceConfig = {
        apiVersion: 'example.com/v1',
        kind: 'TestResource',
        metadata: { name: 'testResource' }
      } as any;

      const enhanced = kroCustomResource<TestSpec, TestStatus>(resourceConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.metadata.name).toBe('testResource');
    });
  });

  describe('TypeScript Compilation', () => {
    it('should maintain type safety with generic parameters', () => {
      interface CustomSpec {
        replicas: number;
        image: string;
      }

      interface CustomStatus {
        phase: 'Pending' | 'Running' | 'Failed';
        message: string;
      }

      const resourceConfig = {
        apiVersion: 'custom.example.com/v1',
        kind: 'CustomApp',
        metadata: { name: 'typedApp' },
        spec: { replicas: 5, image: 'custom:latest' } as CustomSpec
      };

      const result = kroCustomResource<CustomSpec, CustomStatus>(resourceConfig);

      // These should compile without type errors
      expect(result.spec.replicas).toBe(5);
      expect(result.spec.image).toBe('custom:latest');
      expect(result.kind).toBe('CustomApp');
    });
  });
});