/**
 * Unit tests for CRD schema fix utilities.
 *
 * Tests the shared logic used by crd-schema-fix.ts (manifest transform),
 * crd-patcher.ts (live cluster patching), and yaml-file.ts (post-deployment fixing).
 */

import { describe, expect, it } from 'bun:test';
import {
  FIELDS_NEEDING_PRESERVE_UNKNOWN,
  fixCRDSchemaForK8s133,
  generateSchemaFixPatches,
  needsCRDSchemaFix,
  schemaFieldNeedsFix,
  smartFixCRDSchemaForK8s133,
} from '../../src/core/utils/crd-schema-fix.js';

describe('CRD Schema Fix Utilities', () => {
  describe('FIELDS_NEEDING_PRESERVE_UNKNOWN', () => {
    it('should contain known Helm-related fields', () => {
      expect(FIELDS_NEEDING_PRESERVE_UNKNOWN.has('values')).toBe(true);
      expect(FIELDS_NEEDING_PRESERVE_UNKNOWN.has('valuesFrom')).toBe(true);
      expect(FIELDS_NEEDING_PRESERVE_UNKNOWN.has('postRenderers')).toBe(true);
    });

    it('should not contain arbitrary field names', () => {
      expect(FIELDS_NEEDING_PRESERVE_UNKNOWN.has('name')).toBe(false);
      expect(FIELDS_NEEDING_PRESERVE_UNKNOWN.has('spec')).toBe(false);
    });
  });

  describe('schemaFieldNeedsFix', () => {
    it('should return false for null/undefined input', () => {
      expect(schemaFieldNeedsFix(null)).toBe(false);
      expect(schemaFieldNeedsFix(undefined)).toBe(false);
    });

    it('should return false for non-object input', () => {
      expect(schemaFieldNeedsFix('string')).toBe(false);
      expect(schemaFieldNeedsFix(42)).toBe(false);
    });

    it('should detect x-kubernetes-preserve-unknown-fields without type', () => {
      const schema = { 'x-kubernetes-preserve-unknown-fields': true };
      expect(schemaFieldNeedsFix(schema)).toBe(true);
    });

    it('should return false when x-kubernetes-preserve-unknown-fields has type', () => {
      const schema = { 'x-kubernetes-preserve-unknown-fields': true, type: 'object' };
      expect(schemaFieldNeedsFix(schema)).toBe(false);
    });

    it('should detect known fields missing x-kubernetes-preserve-unknown-fields', () => {
      const schema = { type: 'object' };
      expect(schemaFieldNeedsFix(schema, 'values')).toBe(true);
    });

    it('should return false for known fields that already have the fix', () => {
      const schema = { type: 'object', 'x-kubernetes-preserve-unknown-fields': true };
      expect(schemaFieldNeedsFix(schema, 'values')).toBe(false);
    });

    it('should return false for unknown fields with type: object', () => {
      const schema = { type: 'object' };
      expect(schemaFieldNeedsFix(schema, 'randomField')).toBe(false);
    });

    it('should recursively check nested properties', () => {
      const schema = {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            properties: {
              values: { type: 'object' }, // missing x-kubernetes-preserve-unknown-fields
            },
          },
        },
      };
      expect(schemaFieldNeedsFix(schema)).toBe(true);
    });

    it('should recursively check additionalProperties', () => {
      const schema = {
        type: 'object',
        additionalProperties: {
          'x-kubernetes-preserve-unknown-fields': true, // missing type
        },
      };
      expect(schemaFieldNeedsFix(schema)).toBe(true);
    });

    it('should recursively check array items', () => {
      const schema = {
        type: 'array',
        items: {
          'x-kubernetes-preserve-unknown-fields': true, // missing type
        },
      };
      expect(schemaFieldNeedsFix(schema)).toBe(true);
    });

    it('should return false for a fully fixed schema', () => {
      const schema = {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            properties: {
              values: {
                type: 'object',
                'x-kubernetes-preserve-unknown-fields': true,
              },
            },
          },
        },
      };
      expect(schemaFieldNeedsFix(schema)).toBe(false);
    });
  });

  describe('generateSchemaFixPatches', () => {
    it('should return empty array for null/undefined input', () => {
      expect(generateSchemaFixPatches(null, '/base')).toEqual([]);
      expect(generateSchemaFixPatches(undefined, '/base')).toEqual([]);
    });

    it('should generate patch to add type when preserve-unknown-fields lacks type', () => {
      const schema = { 'x-kubernetes-preserve-unknown-fields': true };
      const patches = generateSchemaFixPatches(schema, '/root');

      expect(patches).toEqual([{ op: 'add', path: '/root/type', value: 'object' }]);
    });

    it('should generate patch for known fields missing preserve-unknown-fields', () => {
      const schema = { type: 'object' };
      const patches = generateSchemaFixPatches(schema, '/root', 'values');

      expect(patches).toEqual([
        { op: 'add', path: '/root/x-kubernetes-preserve-unknown-fields', value: true },
      ]);
    });

    it('should return empty array when no fix needed', () => {
      const schema = { type: 'object', 'x-kubernetes-preserve-unknown-fields': true };
      const patches = generateSchemaFixPatches(schema, '/root', 'values');

      expect(patches).toEqual([]);
    });

    it('should generate nested patches with correct JSON pointer paths', () => {
      const schema = {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            properties: {
              values: { type: 'object' }, // needs preserve-unknown-fields
            },
          },
        },
      };

      const patches = generateSchemaFixPatches(schema, '/root');
      expect(patches).toEqual([
        {
          op: 'add',
          path: '/root/properties/spec/properties/values/x-kubernetes-preserve-unknown-fields',
          value: true,
        },
      ]);
    });

    it('should handle multiple issues in one schema', () => {
      const schema = {
        type: 'object',
        properties: {
          values: { type: 'object' }, // needs preserve-unknown-fields
          nested: {
            'x-kubernetes-preserve-unknown-fields': true, // needs type
          },
        },
      };

      const patches = generateSchemaFixPatches(schema, '/root');
      expect(patches).toHaveLength(2);
      expect(patches[0]?.path).toContain('values');
      expect(patches[1]?.path).toContain('nested');
    });

    it('should traverse additionalProperties', () => {
      const schema = {
        type: 'object',
        additionalProperties: {
          'x-kubernetes-preserve-unknown-fields': true, // needs type
        },
      };

      const patches = generateSchemaFixPatches(schema, '/root');
      expect(patches).toEqual([
        { op: 'add', path: '/root/additionalProperties/type', value: 'object' },
      ]);
    });

    it('should traverse array items', () => {
      const schema = {
        type: 'array',
        items: {
          'x-kubernetes-preserve-unknown-fields': true, // needs type
        },
      };

      const patches = generateSchemaFixPatches(schema, '/root');
      expect(patches).toEqual([{ op: 'add', path: '/root/items/type', value: 'object' }]);
    });
  });

  describe('needsCRDSchemaFix', () => {
    it('should return needsFix: false for non-CRD resources', () => {
      const result = needsCRDSchemaFix({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test' },
      });
      expect(result.needsFix).toBe(false);
      expect(result.issues).toEqual([]);
    });

    it('should return needsFix: false for CRD without versions', () => {
      const result = needsCRDSchemaFix({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'test.example.com' },
        spec: {},
      } as any);
      expect(result.needsFix).toBe(false);
    });

    it('should detect CRD needing fix', () => {
      const crd = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'helmreleases.helm.toolkit.fluxcd.io' },
        spec: {
          versions: [
            {
              name: 'v2',
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: {
                      type: 'object',
                      properties: {
                        values: {
                          'x-kubernetes-preserve-unknown-fields': true,
                          // missing type — needs fix
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      };

      const result = needsCRDSchemaFix(crd as any);
      expect(result.needsFix).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.crdName).toBe('helmreleases.helm.toolkit.fluxcd.io');
    });

    it('should return needsFix: false for already-fixed CRD', () => {
      const crd = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'test.example.com' },
        spec: {
          versions: [
            {
              name: 'v1',
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: {
                      type: 'object',
                      properties: {
                        values: {
                          type: 'object',
                          'x-kubernetes-preserve-unknown-fields': true,
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      };

      const result = needsCRDSchemaFix(crd as any);
      expect(result.needsFix).toBe(false);
    });
  });

  describe('fixCRDSchemaForK8s133', () => {
    it('should return non-CRD resources unchanged', () => {
      const deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test' },
      };
      expect(fixCRDSchemaForK8s133(deployment)).toBe(deployment);
    });

    it('should deep clone and fix CRD schema', () => {
      const crd = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'test.example.com' },
        spec: {
          versions: [
            {
              name: 'v1',
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: {
                      type: 'object',
                      properties: {
                        values: {
                          'x-kubernetes-preserve-unknown-fields': true,
                          // missing type
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      };

      const fixed = fixCRDSchemaForK8s133(crd as any) as any;

      // Should be a different object (deep clone)
      expect(fixed).not.toBe(crd);

      // Should have added type: object
      const valuesSchema =
        fixed.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values;
      expect(valuesSchema.type).toBe('object');
      expect(valuesSchema['x-kubernetes-preserve-unknown-fields']).toBe(true);

      // Original should be unchanged
      const originalValues = (crd as any).spec.versions[0].schema.openAPIV3Schema.properties.spec
        .properties.values;
      expect(originalValues.type).toBeUndefined();
    });

    it('should add x-kubernetes-preserve-unknown-fields to known fields', () => {
      const crd = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'test.example.com' },
        spec: {
          versions: [
            {
              name: 'v1',
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: {
                      type: 'object',
                      properties: {
                        values: {
                          // has neither type nor preserve-unknown-fields
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      };

      const fixed = fixCRDSchemaForK8s133(crd as any) as any;
      const valuesSchema =
        fixed.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values;
      expect(valuesSchema.type).toBe('object');
      expect(valuesSchema['x-kubernetes-preserve-unknown-fields']).toBe(true);
    });
  });

  describe('smartFixCRDSchemaForK8s133', () => {
    it('should return already-fixed CRD unchanged (same reference)', () => {
      const crd = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'test.example.com' },
        spec: {
          versions: [
            {
              name: 'v1',
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: {
                      type: 'object',
                      properties: {
                        values: {
                          type: 'object',
                          'x-kubernetes-preserve-unknown-fields': true,
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      };

      const result = smartFixCRDSchemaForK8s133(crd as any);
      // Should be the same reference — no cloning needed
      expect(result).toBe(crd);
    });

    it('should fix CRD that needs fixing', () => {
      const crd = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'test.example.com' },
        spec: {
          versions: [
            {
              name: 'v1',
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: {
                      type: 'object',
                      properties: {
                        values: {
                          'x-kubernetes-preserve-unknown-fields': true,
                          // missing type
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      };

      const result = smartFixCRDSchemaForK8s133(crd as any) as any;
      // Should be a new reference (deep cloned and fixed)
      expect(result).not.toBe(crd);
      const valuesSchema =
        result.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values;
      expect(valuesSchema.type).toBe('object');
    });
  });
});
