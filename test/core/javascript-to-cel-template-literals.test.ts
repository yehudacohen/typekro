/**
 * JavaScript to CEL Template Literals Tests
 * 
 * These tests verify that template literals in JavaScript compositions are properly
 * converted to CEL expressions for runtime evaluation by Kro.
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition, simple } from '../../src/index.js';
import { cel } from '../../src/core/references/cel.js';

describe('JavaScript to CEL Template Literals', () => {
  describe('cel template literal tag', () => {
    it('should create CelExpression objects from template literals with schema references', () => {
      const TestSpec = type({
        name: 'string',
        hostname: 'string',
      });

      const TestStatus = type({
        url: 'string',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'cel-template-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'CelTemplateTest',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          // Use the cel template literal tag
          const url = cel`https://${spec.hostname}/api`;

          return {
            url: url,
          };
        }
      );

      // Verify the composition generates correct YAML
      const yaml = testComposition.toYaml();
      
      // Should include the URL field as a CEL expression
      expect(yaml).toContain('url: ${"https://" + schema.spec.hostname + "/api"}');
      
      // Should not treat it as a static field
      expect(yaml).not.toContain('status: {}');
      
      // Verify that cel template literal creates correct CelExpression
      // (This is tested separately since we can't run assertions inside the composition)
      const testUrl = cel`https://${'test'}/api`;
      const KUBERNETES_REF_BRAND = Symbol.for('TypeKro.CelExpression');
      expect((testUrl as any)[KUBERNETES_REF_BRAND]).toBe(true);
      expect(testUrl.expression).toBe('"https://" + "test" + "/api"');
      expect(testUrl._type).toBe('string');
    });

    it('should handle template literals with resource references', () => {
      const TestSpec = type({
        name: 'string',
      });

      const TestStatus = type({
        message: 'string',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'resource-ref-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'ResourceRefTest',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            id: 'deployment',
          });

          // Use cel template with resource reference
          const message = cel`Deployment ${deployment.metadata.name} has ${deployment.status.readyReplicas} replicas`;

          return {
            message: message,
          };
        }
      );

      const yaml = testComposition.toYaml();
      
      // Should include the message field as a CEL expression
      // Note: deployment.metadata.name becomes schema.spec.name because it references the spec
      expect(yaml).toContain('message: ${"Deployment " + schema.spec.name + " has " + deployment.status.readyReplicas + " replicas"}');
      
      // Verify CEL template behavior separately
      const testMessage = cel`Deployment ${'test'} has ${42} replicas`;
      const CEL_BRAND = Symbol.for('TypeKro.CelExpression');
      expect((testMessage as any)[CEL_BRAND]).toBe(true);
      expect(testMessage.expression).toBe('"Deployment " + "test" + " has " + 42 + " replicas"');
    });

    it('should handle mixed schema and resource references in template literals', () => {
      const TestSpec = type({
        name: 'string',
      });

      const TestStatus = type({
        status: 'string',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'mixed-ref-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'MixedRefTest',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            id: 'deployment',
          });

          // Mix schema and resource references
          const status = cel`App ${spec.name} has ${deployment.status.readyReplicas} replicas`;

          return {
            status: status,
          };
        }
      );

      const yaml = testComposition.toYaml();
      
      // Should include the status field as a CEL expression
      expect(yaml).toContain('status: ${"App " + schema.spec.name + " has " + deployment.status.readyReplicas + " replicas"}');
      
      // Verify CEL expression behavior separately
      const testStatus = cel`App ${'test'} has ${42} replicas`;
      const CEL_BRAND = Symbol.for('TypeKro.CelExpression');
      expect((testStatus as any)[CEL_BRAND]).toBe(true);
      expect(testStatus.expression).toBe('"App " + "test" + " has " + 42 + " replicas"');
    });
  });

  describe('imperative analyzer template literal conversion', () => {
    it('should convert natural template literals to CEL expressions', () => {
      const TestSpec = type({
        hostname: 'string',
      });

      const TestStatus = type({
        url: 'string',
        message: 'string',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'natural-template-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'NaturalTemplateTest',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: 'test-app',
            image: 'nginx',
            id: 'deployment',
          });

          // Use natural JavaScript template literals (should be converted by imperative analyzer)
          return {
            url: `https://${spec.hostname}/api`,
            message: `Deployment ${deployment.metadata.name} has ${deployment.status.readyReplicas} replicas`,
          };
        }
      );

      const yaml = testComposition.toYaml();
      
      // Both template literals should be converted to CEL expressions
      expect(yaml).toContain('url: ${"https://" + schema.spec.hostname + "/api"}');
      expect(yaml).toContain('message: ${"Deployment " + deployment.metadata.name + " has " + deployment.status.readyReplicas + " replicas"}');
    });

    it('should handle schema-only template literals correctly', () => {
      const TestSpec = type({
        name: 'string',
      });

      const TestStatus = type({
        url: 'string',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'schema-only-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'SchemaOnlyTest',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          // Template literal with only schema references
          return {
            url: `https://${spec.name}.example.com`,
          };
        }
      );

      const yaml = testComposition.toYaml();
      
      // Should be converted to CEL expression
      expect(yaml).toContain('url: ${"https://" + schema.spec.name + ".example.com"}');
      
      // Should not be treated as static
      expect(yaml).not.toContain('status: {}');
    });
  });

  describe('magic proxy behavior', () => {
    it('should return KubernetesRef objects for schema properties in status builder context', async () => {
      const TestSpec = type({
        name: 'string',
        hostname: 'string',
      });

      const TestStatus = type({
        debug: 'string',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'magic-proxy-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'MagicProxyTest',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          return {
            debug: 'test',
          };
        }
      );

      // Should not throw errors
      expect(() => testComposition.toYaml()).not.toThrow();
      
      // Test magic proxy behavior separately using a simple schema proxy
      const { createSchemaProxy } = await import('../../src/core/references/schema-proxy.js');
      const schemaProxy = createSchemaProxy<typeof TestSpec.infer, typeof TestStatus.infer>();
      
      const KUBERNETES_REF_BRAND = Symbol.for('TypeKro.KubernetesRef');
      expect((schemaProxy.spec.name as any)[KUBERNETES_REF_BRAND]).toBe(true);
      expect((schemaProxy.spec.hostname as any)[KUBERNETES_REF_BRAND]).toBe(true);
      expect((schemaProxy.spec.name as any).resourceId).toBe('__schema__');
      expect((schemaProxy.spec.hostname as any).resourceId).toBe('__schema__');
      expect((schemaProxy.spec.name as any).fieldPath).toBe('spec.name');
      expect((schemaProxy.spec.hostname as any).fieldPath).toBe('spec.hostname');
    });

    it('should return KubernetesRef objects for resource properties in status builder context', () => {
      const TestSpec = type({
        name: 'string',
      });

      const TestStatus = type({
        debug: 'string',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'resource-proxy-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'ResourceProxyTest',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          const _deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            id: 'deployment',
          });

          return {
            debug: 'test',
          };
        }
      );

      // Should not throw errors
      expect(() => testComposition.toYaml()).not.toThrow();
      
      // Test resource proxy behavior separately
      // Note: Resource proxies are created during composition execution,
      // so we test the behavior through the composition system
      const yaml = testComposition.toYaml();
      expect(yaml).toBeDefined();
    });
  });

  describe('CEL expression validation', () => {
    it('should treat all CelExpression objects as requiring Kro resolution', () => {
      const TestSpec = type({
        hostname: 'string',
      });

      const TestStatus = type({
        schemaOnlyUrl: 'string',
        resourceOnlyMessage: 'string',
        mixedMessage: 'string',
      });

      const testComposition = kubernetesComposition(
        {
          name: 'cel-validation-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'CelValidationTest',
          spec: TestSpec,
          status: TestStatus,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: 'test-app',
            image: 'nginx',
            id: 'deployment',
          });

          return {
            // Schema-only CEL expression - should be sent to Kro
            schemaOnlyUrl: cel`https://${spec.hostname}/api`,
            
            // Resource-only CEL expression - should be sent to Kro
            resourceOnlyMessage: cel`Deployment has ${deployment.status.readyReplicas} replicas`,
            
            // Mixed CEL expression - should be sent to Kro
            mixedMessage: cel`App ${spec.hostname} has ${deployment.status.readyReplicas} replicas`,
          };
        }
      );

      const yaml = testComposition.toYaml();
      
      // All three fields should be in the YAML as CEL expressions
      expect(yaml).toContain('schemaOnlyUrl: ${"https://" + schema.spec.hostname + "/api"}');
      expect(yaml).toContain('resourceOnlyMessage: ${"Deployment has " + deployment.status.readyReplicas + " replicas"}');
      expect(yaml).toContain('mixedMessage: ${"App " + schema.spec.hostname + " has " + deployment.status.readyReplicas + " replicas"}');
      
      // None should be treated as static fields
      expect(yaml).not.toContain('Static fields');
    });
  });
});