/**
 * Test suite for CRD Schema Fix utilities
 *
 * Tests the CRD schema validation fix utilities for Kubernetes 1.33+
 * compatibility, including:
 * - needsCRDSchemaFix() - Check if CRD needs fixes
 * - fixCRDSchemaForK8s133() - Apply fixes to CRD
 * - smartFixCRDSchemaForK8s133() - Only apply fixes when needed
 */

import { describe, expect, it } from 'bun:test';
import {
  fixCRDSchemaForK8s133,
  fixCRDSchemasForK8s133,
  needsCRDSchemaFix,
  smartFixCRDSchemaForK8s133,
  smartFixCRDSchemasForK8s133,
} from '../../../src/core/utils/crd-schema-fix.js';
import type { KubernetesResource } from '../../../src/core/types/kubernetes.js';

describe('CRD Schema Fix Utilities', () => {
  describe('needsCRDSchemaFix', () => {
    it('should return false for non-CRD resources', () => {
      const deployment: KubernetesResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment' },
      };

      const result = needsCRDSchemaFix(deployment);

      expect(result.needsFix).toBe(false);
      expect(result.issues).toHaveLength(0);
    });

    it('should return false for CRD without schema issues', () => {
      const crd: KubernetesResource = {
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
                        name: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = needsCRDSchemaFix(crd);

      expect(result.needsFix).toBe(false);
      expect(result.issues).toHaveLength(0);
      expect(result.crdName).toBe('test.example.com');
    });

    it('should detect x-kubernetes-preserve-unknown-fields without type', () => {
      const crd: KubernetesResource = {
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
                          // Missing type field - this is the issue
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = needsCRDSchemaFix(crd);

      expect(result.needsFix).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.includes('x-kubernetes-preserve-unknown-fields without type'))).toBe(true);
    });

    it('should detect known fields missing x-kubernetes-preserve-unknown-fields', () => {
      const crd: KubernetesResource = {
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
                          type: 'object',
                          // Missing x-kubernetes-preserve-unknown-fields
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = needsCRDSchemaFix(crd);

      expect(result.needsFix).toBe(true);
      expect(result.issues.some((i) => i.includes('missing x-kubernetes-preserve-unknown-fields'))).toBe(true);
    });

    it('should check nested properties recursively', () => {
      const crd: KubernetesResource = {
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
                        nested: {
                          type: 'object',
                          properties: {
                            deeplyNested: {
                              'x-kubernetes-preserve-unknown-fields': true,
                              // Missing type
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
        },
      } as any;

      const result = needsCRDSchemaFix(crd);

      expect(result.needsFix).toBe(true);
      expect(result.issues.some((i) => i.includes('deeplyNested'))).toBe(true);
    });
  });

  describe('fixCRDSchemaForK8s133', () => {
    it('should not modify non-CRD resources', () => {
      const deployment: KubernetesResource = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment' },
      };

      const result = fixCRDSchemaForK8s133(deployment);

      expect(result).toBe(deployment); // Same reference
    });

    it('should add type: object to fields with x-kubernetes-preserve-unknown-fields', () => {
      const crd: KubernetesResource = {
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
                        data: {
                          'x-kubernetes-preserve-unknown-fields': true,
                          // No type field
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = fixCRDSchemaForK8s133(crd) as any;

      const dataField = result.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.data;
      expect(dataField.type).toBe('object');
      expect(dataField['x-kubernetes-preserve-unknown-fields']).toBe(true);
    });

    it('should add x-kubernetes-preserve-unknown-fields to known fields like values', () => {
      const crd: KubernetesResource = {
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
                          // Missing both type and x-kubernetes-preserve-unknown-fields
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = fixCRDSchemaForK8s133(crd) as any;

      const valuesField = result.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values;
      expect(valuesField.type).toBe('object');
      expect(valuesField['x-kubernetes-preserve-unknown-fields']).toBe(true);
    });

    it('should not modify original CRD (deep clone)', () => {
      const crd: KubernetesResource = {
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
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = fixCRDSchemaForK8s133(crd);

      // Result should be a different object
      expect(result).not.toBe(crd);

      // Original should not be modified
      const originalValues = (crd as any).spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values;
      expect(originalValues.type).toBeUndefined();
    });

    it('should handle CRD without versions gracefully', () => {
      const crd: KubernetesResource = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'test.example.com' },
        spec: {
          // No versions
        },
      } as any;

      const result = fixCRDSchemaForK8s133(crd);

      expect(result).toBe(crd); // Same reference, no modification needed
    });

    it('should fix multiple versions', () => {
      const crd: KubernetesResource = {
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
                        },
                      },
                    },
                  },
                },
              },
            },
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
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = fixCRDSchemaForK8s133(crd) as any;

      // Both versions should be fixed
      expect(result.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values.type).toBe('object');
      expect(result.spec.versions[1].schema.openAPIV3Schema.properties.spec.properties.values.type).toBe('object');
    });
  });

  describe('smartFixCRDSchemaForK8s133', () => {
    it('should not modify CRD that does not need fixes', () => {
      const crd: KubernetesResource = {
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
                        name: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = smartFixCRDSchemaForK8s133(crd);

      // Should return the same reference since no fix needed
      expect(result).toBe(crd);
    });

    it('should fix CRD that needs fixes', () => {
      const crd: KubernetesResource = {
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
                          // Missing type
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = smartFixCRDSchemaForK8s133(crd) as any;

      // Should return a fixed copy
      expect(result).not.toBe(crd);
      expect(result.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values.type).toBe('object');
    });
  });

  describe('fixCRDSchemasForK8s133', () => {
    it('should fix all CRDs in array', () => {
      const manifests: KubernetesResource[] = [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'test-deployment' },
        },
        {
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: { name: 'crd1.example.com' },
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
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        } as any,
        {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: 'test-service' },
        },
      ];

      const results = fixCRDSchemasForK8s133(manifests);

      expect(results).toHaveLength(3);

      // Deployment should be unchanged
      expect(results[0]).toBe(manifests[0]!);

      // CRD should be fixed
      const fixedCrd = results[1] as any;
      expect(fixedCrd.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values.type).toBe('object');

      // Service should be unchanged
      expect(results[2]).toBe(manifests[2]!);
    });
  });

  describe('smartFixCRDSchemasForK8s133', () => {
    it('should only fix CRDs that need fixes', () => {
      const manifests: KubernetesResource[] = [
        {
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: { name: 'good-crd.example.com' },
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
                          name: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        } as any,
        {
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: { name: 'bad-crd.example.com' },
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
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        } as any,
      ];

      const results = smartFixCRDSchemasForK8s133(manifests);

      expect(results).toHaveLength(2);

      // Good CRD should be unchanged (same reference)
      expect(results[0]).toBe(manifests[0]!);

      // Bad CRD should be fixed (different reference)
      expect(results[1]).not.toBe(manifests[1]);
      const fixedCrd = results[1] as any;
      expect(fixedCrd.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values.type).toBe('object');
    });
  });

  describe('Real-world Flux CRD scenarios', () => {
    it('should fix HelmRelease CRD with values field', () => {
      // Simulated Flux HelmRelease CRD structure
      const helmReleaseCrd: KubernetesResource = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'helmreleases.helm.toolkit.fluxcd.io' },
        spec: {
          group: 'helm.toolkit.fluxcd.io',
          names: {
            kind: 'HelmRelease',
            plural: 'helmreleases',
          },
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
                        chart: {
                          type: 'object',
                          properties: {
                            spec: {
                              type: 'object',
                              properties: {
                                chart: { type: 'string' },
                                version: { type: 'string' },
                              },
                            },
                          },
                        },
                        values: {
                          // This is the problematic field - accepts arbitrary Helm values
                          'x-kubernetes-preserve-unknown-fields': true,
                          // Missing type: object
                        },
                        valuesFrom: {
                          type: 'array',
                          items: {
                            type: 'object',
                            // Items might also need preserve-unknown-fields
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = fixCRDSchemaForK8s133(helmReleaseCrd) as any;

      // values field should have type: object added
      const valuesField = result.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values;
      expect(valuesField.type).toBe('object');
      expect(valuesField['x-kubernetes-preserve-unknown-fields']).toBe(true);
    });

    it('should handle additionalProperties in CRD schema', () => {
      const crd: KubernetesResource = {
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
                      additionalProperties: {
                        'x-kubernetes-preserve-unknown-fields': true,
                        // Missing type
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = fixCRDSchemaForK8s133(crd) as any;

      const additionalProps = result.spec.versions[0].schema.openAPIV3Schema.properties.spec.additionalProperties;
      expect(additionalProps.type).toBe('object');
    });

    it('should handle items in array schema', () => {
      const crd: KubernetesResource = {
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
                        items: {
                          type: 'array',
                          items: {
                            'x-kubernetes-preserve-unknown-fields': true,
                            // Missing type
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any;

      const result = fixCRDSchemaForK8s133(crd) as any;

      const itemsSchema = result.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.items.items;
      expect(itemsSchema.type).toBe('object');
    });
  });
});
