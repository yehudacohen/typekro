/**
 * Test suite for ResourceGraphDefinition Factory Function
 *
 * This tests the ResourceGraphDefinition factory with its comprehensive
 * readiness evaluation logic for Kro RGD resources.
 */

import { describe, expect, it } from 'bun:test';
import { resourceGraphDefinition } from '../../../src/factories/kro/resource-graph-definition.js';

describe('ResourceGraphDefinition Factory', () => {
  const createTestRGD = (name: string = 'testRgd') => ({
    metadata: {
      name,
      namespace: 'default'
    },
    spec: {
      schema: {
        apiVersion: 'example.com/v1',
        kind: 'Example',
        spec: {
          name: { type: 'string' }
        }
      },
      resources: {
        service: {
          template: {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: {
              name: '{{ .metadata.name }}'
            },
            spec: {
              selector: {
                app: '{{ .metadata.name }}'
              }
            }
          }
        }
      }
    }
  });

  describe('Factory Creation', () => {
    it('should create resourceGraphDefinition with proper structure', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('ResourceGraphDefinition');
      expect(enhanced.apiVersion).toBe('kro.run/v1alpha1');
      expect(enhanced.metadata.name).toBe('testRgd');
      expect(enhanced.metadata.namespace).toBe('default');
      expect(enhanced.spec.schema.kind).toBe('Example');
    });

    it('should preserve original spec configuration', () => {
      const rgdConfig = createTestRGD('customRgd');
      const enhanced = resourceGraphDefinition(rgdConfig);

      expect(enhanced.spec.schema.apiVersion).toBe('example.com/v1');
      expect(enhanced.spec.resources.service).toBeDefined();
      expect(enhanced.spec.resources.service.template.kind).toBe('Service');
    });

    it('should handle RGD with complex resource templates', () => {
      const complexRGD = {
        metadata: { name: 'complexRgd', namespace: 'kroSystem' },
        spec: {
          schema: {
            apiVersion: 'webapp.example.com/v1',
            kind: 'WebApp',
            spec: {
              image: { type: 'string' },
              replicas: { type: 'integer', default: 1 }
            }
          },
          resources: {
            deployment: {
              template: {
                apiVersion: 'apps/v1',
                kind: 'Deployment',
                spec: {
                  replicas: '{{ .spec.replicas }}',
                  template: {
                    spec: {
                      containers: [{
                        image: '{{ .spec.image }}'
                      }]
                    }
                  }
                }
              }
            },
            service: {
              template: {
                apiVersion: 'v1',
                kind: 'Service'
              }
            }
          }
        }
      };

      const enhanced = resourceGraphDefinition(complexRGD);

      expect(enhanced.spec.resources.deployment).toBeDefined();
      expect(enhanced.spec.resources.service).toBeDefined();
      expect(enhanced.spec.schema.spec.replicas.default).toBe(1);
    });
  });

  describe('Readiness Evaluator', () => {
    it('should attach readiness evaluator', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);

      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate as not ready when resource not found', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const result = evaluator(null);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ResourceNotFound');
      expect(result.message).toBe('ResourceGraphDefinition not found in cluster.');
    });

    it('should evaluate as not ready when no status exists but has uid', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testRgd', uid: '12345' },
        spec: {}
        // No status
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusPending');
      expect(result.message).toBe('ResourceGraphDefinition exists but Kro controller has not yet initialized status.');
    });

    it('should evaluate as not ready when no status and no uid', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testRgd' },
        spec: {}
        // No status, no uid
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
    });

    it('should evaluate as ready when state is Active with all conditions', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testRgd', uid: '12345' },
        spec: {},
        status: {
          state: 'Active',
          conditions: [
            { type: 'ReconcilerReady', status: 'True', message: 'Reconciler is ready' },
            { type: 'GraphVerified', status: 'True', message: 'Graph is verified' },
            { type: 'CustomResourceDefinitionSynced', status: 'True', message: 'CRD is synced' }
          ]
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('ResourceGraphDefinition is active and ready.');
    });

    it('should evaluate as not ready when failed condition exists', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testRgd', uid: '12345' },
        spec: {},
        status: {
          state: 'failed',
          conditions: [
            { type: 'Ready', status: 'False', message: 'Validation failed' }
          ]
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('RGDProcessingFailed');
      expect(result.message).toContain('RGD processing failed');
    });

    it('should evaluate as not ready when in pending state', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testRgd', uid: '12345' },
        spec: {},
        status: {
          state: 'Pending',
          conditions: []
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ReconciliationPending');
      expect(result.message).toContain('Waiting for RGD to become active');
    });

    it('should evaluate as not ready with unknown state', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testRgd', uid: '12345' },
        spec: {},
        status: {
          state: 'Unknown',
          conditions: []
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ReconciliationPending');
      expect(result.message).toContain('current state: Unknown');
    });

    it('should handle missing status gracefully', () => {
      const rgdConfig = createTestRGD();
      const enhanced = resourceGraphDefinition(rgdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'testRgd' }
        // No spec or status
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing metadata gracefully', () => {
      const rgdConfig = { spec: { schema: { kind: 'Example' } } };
      const enhanced = resourceGraphDefinition(rgdConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('ResourceGraphDefinition');
      expect(enhanced.apiVersion).toBe('kro.run/v1alpha1');
    });

    it('should handle missing spec gracefully', () => {
      const rgdConfig = { metadata: { name: 'minimalRgd' } };
      const enhanced = resourceGraphDefinition(rgdConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.metadata.name).toBe('minimalRgd');
    });
  });

  describe('TypeScript Compilation', () => {
    it('should compile with proper typing', () => {
      const rgdConfig = createTestRGD('typedRgd');
      const result = resourceGraphDefinition(rgdConfig);

      // These should compile without type errors
      expect(result.kind).toBe('ResourceGraphDefinition');
      expect(result.apiVersion).toBe('kro.run/v1alpha1');
      expect(result.metadata.name).toBe('typedRgd');
    });
  });
});