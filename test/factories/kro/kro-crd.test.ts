/**
 * Test suite for KroCustomResourceDefinition Factory Function
 *
 * This tests the Kro-generated CustomResourceDefinition factory with
 * Kro-specific readiness evaluation logic.
 */

import { describe, expect, it } from 'bun:test';
import type { V1CustomResourceDefinition } from '@kubernetes/client-node';
import { kroCustomResourceDefinition } from '../../../src/factories/kro/kro-crd.js';

describe('KroCustomResourceDefinition Factory', () => {
  const createTestCRD = (
    name: string = 'webapplications.example.com.kro.run'
  ): V1CustomResourceDefinition => ({
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name,
      labels: {
        'kro.run/managed-by': 'kro-controller',
      },
    },
    spec: {
      group: 'example.com.kro.run',
      versions: [
        {
          name: 'v1alpha1',
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                spec: {
                  type: 'object',
                  properties: {
                    image: { type: 'string' },
                    replicas: { type: 'integer', _default: 1 as any },
                  },
                },
                status: {
                  type: 'object',
                  properties: {
                    phase: { type: 'string' },
                    conditions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          type: { type: 'string' },
                          status: { type: 'string' },
                          message: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
      scope: 'Namespaced',
      names: {
        plural: 'webapplications',
        singular: 'webapplication',
        kind: 'WebApplication',
        shortNames: ['webapp', 'webapps'],
      },
    },
  });

  describe('Factory Creation', () => {
    it('should create kroCustomResourceDefinition with proper structure', () => {
      const crdConfig = createTestCRD();
      const enhanced = kroCustomResourceDefinition(crdConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('CustomResourceDefinition');
      expect(enhanced.apiVersion).toBe('apiextensions.k8s.io/v1');
      expect(enhanced.metadata.name).toBe('webapplications.example.com.kro.run');
      expect(enhanced.spec.group).toBe('example.com.kro.run');
      expect(enhanced.spec.names.kind).toBe('WebApplication');
    });

    it('should preserve original spec configuration', () => {
      const crdConfig = createTestCRD('customresources.webapp.kro.run');
      crdConfig.spec.names.kind = 'CustomResource';
      crdConfig.spec.names.plural = 'customresources';

      const enhanced = kroCustomResourceDefinition(crdConfig);

      expect(enhanced.spec.names.kind).toBe('CustomResource');
      expect(enhanced.spec.names.plural).toBe('customresources');
      expect(enhanced.metadata.name).toBe('customresources.webapp.kro.run');
    });

    it('should handle CRD with complex schema', () => {
      const complexCRD = createTestCRD('databases.storage.kro.run');
      complexCRD.spec.versions = [
        {
          name: 'v1beta1',
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                spec: {
                  type: 'object',
                  properties: {
                    version: { type: 'string', _enum: ['12', '13', '14'] as any },
                    replicas: { type: 'integer', minimum: 1, maximum: 10 },
                    storage: {
                      type: 'object',
                      properties: {
                        size: { type: 'string' },
                        storageClass: { type: 'string' },
                      },
                      required: ['size'],
                    },
                  },
                  required: ['version'],
                },
              },
            },
          },
        },
      ];

      const enhanced = kroCustomResourceDefinition(complexCRD);

      expect(enhanced.spec.versions).toHaveLength(1);
      expect(enhanced.spec?.versions?.[0]?.name).toBe('v1beta1');
      expect(enhanced.spec?.versions?.[0]?.schema?.openAPIV3Schema?.properties?.spec?.required).toContain(
        'version'
      );
    });

    it('should handle missing metadata gracefully', () => {
      const crdConfig = createTestCRD();
      delete (crdConfig as any).metadata;

      const enhanced = kroCustomResourceDefinition(crdConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.metadata.name).toBe('unnamed-crd');
    });
  });

  describe('Readiness Evaluator', () => {
    it('should attach readiness evaluator', () => {
      const crdConfig = createTestCRD();
      const enhanced = kroCustomResourceDefinition(crdConfig);

      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate as ready when Established and NamesAccepted for Kro CRD', () => {
      const crdConfig = createTestCRD();
      const enhanced = kroCustomResourceDefinition(crdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockCRD: V1CustomResourceDefinition = {
        ...crdConfig,
        status: {
          conditions: [
            {
              type: 'Established',
              status: 'True',
              lastTransitionTime: new Date(),
              reason: 'InitialNamesAccepted',
              message: 'the initial names have been accepted',
            },
            {
              type: 'NamesAccepted',
              status: 'True',
              lastTransitionTime: new Date(),
              reason: 'NoConflicts',
              message: 'no conflicts found',
            },
          ],
          acceptedNames: {
            plural: 'webapplications',
            singular: 'webapplication',
            kind: 'WebApplication',
          },
          storedVersions: ['v1alpha1'],
        },
      };

      const result = evaluator(mockCRD);
      expect(result.ready).toBe(true);
      expect(result.message).toContain(
        'Kro-generated CRD webapplications.example.com.kro.run is established'
      );
    });

    it('should evaluate as not ready when Established is False', () => {
      const crdConfig = createTestCRD();
      const enhanced = kroCustomResourceDefinition(crdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockCRD: V1CustomResourceDefinition = {
        ...crdConfig,
        status: {
          conditions: [
            {
              type: 'Established',
              status: 'False',
              lastTransitionTime: new Date(),
              reason: 'Installing',
              message: 'the CRD is being installed',
            },
            {
              type: 'NamesAccepted',
              status: 'True',
              lastTransitionTime: new Date(),
              reason: 'NoConflicts',
              message: 'no conflicts found',
            },
          ],
        },
      };

      const result = evaluator(mockCRD);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroCRDNotReady');
      expect(result.message).toContain('Established: False');
    });

    it('should evaluate as not ready when NamesAccepted is False', () => {
      const crdConfig = createTestCRD();
      const enhanced = kroCustomResourceDefinition(crdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockCRD: V1CustomResourceDefinition = {
        ...crdConfig,
        status: {
          conditions: [
            {
              type: 'Established',
              status: 'True',
              lastTransitionTime: new Date(),
              reason: 'InitialNamesAccepted',
              message: 'the initial names have been accepted',
            },
            {
              type: 'NamesAccepted',
              status: 'False',
              lastTransitionTime: new Date(),
              reason: 'NameConflict',
              message: 'name conflicts found',
            },
          ],
        },
      };

      const result = evaluator(mockCRD);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroCRDNotReady');
      expect(result.message).toContain('NamesAccepted: False');
    });

    it('should evaluate as not ready for non-Kro CRD', () => {
      const nonKroCRD = createTestCRD('ingresses.networking.k8s.io'); // Not a .kro.run CRD
      const enhanced = kroCustomResourceDefinition(nonKroCRD);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockCRD: V1CustomResourceDefinition = {
        ...nonKroCRD,
        status: {
          conditions: [
            {
              type: 'Established',
              status: 'True',
              lastTransitionTime: new Date(),
              reason: 'InitialNamesAccepted',
              message: 'the initial names have been accepted',
            },
            {
              type: 'NamesAccepted',
              status: 'True',
              lastTransitionTime: new Date(),
              reason: 'NoConflicts',
              message: 'no conflicts found',
            },
          ],
        },
      };

      const result = evaluator(mockCRD);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroCRDNotReady');
      expect(result.details?.isKroCRD).toBe(false);
    });

    it('should handle missing status conditions', () => {
      const crdConfig = createTestCRD();
      const enhanced = kroCustomResourceDefinition(crdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockCRD: V1CustomResourceDefinition = {
        ...crdConfig,
        status: {
          // No conditions array
        },
      };

      const result = evaluator(mockCRD);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroCRDNotReady');
      expect(result.message).toContain('Established: Unknown');
      expect(result.message).toContain('NamesAccepted: Unknown');
    });

    it('should handle missing status entirely', () => {
      const crdConfig = createTestCRD();
      const enhanced = kroCustomResourceDefinition(crdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockCRD: V1CustomResourceDefinition = {
        ...crdConfig,
        // No status
      };

      const result = evaluator(mockCRD);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroCRDNotReady');
    });

    it('should handle evaluation errors gracefully', () => {
      const crdConfig = createTestCRD();
      const enhanced = kroCustomResourceDefinition(crdConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Pass invalid data that might cause an error
      const result = evaluator(null);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('EvaluationError');
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed CRD gracefully', () => {
      const malformedCRD = {
        spec: {
          // Missing required fields
        },
      } as any;

      const enhanced = kroCustomResourceDefinition(malformedCRD);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('CustomResourceDefinition');
      expect(enhanced.apiVersion).toBe('apiextensions.k8s.io/v1');
    });

    it('should handle missing spec gracefully', () => {
      const crdConfig = {
        metadata: { name: 'test.kro.run' },
      } as any;

      const enhanced = kroCustomResourceDefinition(crdConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.metadata.name).toBe('test.kro.run');
    });
  });

  describe('TypeScript Compilation', () => {
    it('should compile with proper K8s types', () => {
      const crdConfig = createTestCRD('typed.resources.kro.run');
      const result = kroCustomResourceDefinition(crdConfig);

      // These should compile without type errors
      expect(result.kind).toBe('CustomResourceDefinition');
      expect(result.apiVersion).toBe('apiextensions.k8s.io/v1');
      expect(result.spec.names.kind).toBe('WebApplication');
      expect(result.spec.scope).toBe('Namespaced');
    });
  });
});
