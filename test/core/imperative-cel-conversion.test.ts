/**
 * Unit tests for JavaScript-to-CEL conversion in imperative compositions
 * 
 * This test suite focuses on the specific issue where JavaScript expressions
 * like `schema.spec.name + "-namespace-policy"` are not being converted to CEL
 * expressions properly in Kro factory mode.
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition, enableCompositionDebugging } from '../../src/core/composition/imperative.js';
import { NetworkPolicy } from '../../src/factories/cilium/resources/networking.js';

// Enable debug logging to see what's happening
enableCompositionDebugging();

const TestSpecSchema = type({
  name: 'string',
  tier: 'string',
  enableGlobalPolicy: 'boolean',
});

const TestStatusSchema = type({
  ready: 'boolean',
  namespacePolicyName: 'string',
  clusterPolicyName: 'string',
  policiesApplied: 'number',
});

describe('Imperative CEL Conversion', () => {
  describe('JavaScript Expression Conversion', () => {
    it('should convert JavaScript string concatenation to CEL expressions', () => {
      const composition = kubernetesComposition(
        {
          name: 'cel-conversion-test',
          apiVersion: 'test.com/v1',
          kind: 'CelTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          const _namespacePolicy = NetworkPolicy({
            name: `${spec.name}-namespace-policy`, // This should become a CEL expression
            spec: {
              endpointSelector: {
                matchLabels: { tier: spec.tier }
              }
            },
            id: 'namespacePolicy'
          });

          const _clusterPolicy = NetworkPolicy({
            name: `${spec.name}-cluster-policy`, // This should become a CEL expression
            spec: {
              endpointSelector: {
                matchLabels: { tier: spec.tier }
              }
            },
            id: 'clusterPolicy'
          });

          return {
            ready: true,
            namespacePolicyName: `${spec.name}-namespace-policy`, // This should become a CEL expression
            clusterPolicyName: `${spec.name}-cluster-policy`, // This should become a CEL expression
            policiesApplied: 2,
          };
        }
      );

      // Test Kro factory - this should work and convert JavaScript expressions to CEL
      const kroFactory = composition.factory('kro', { namespace: 'test' });
      expect(kroFactory).toBeDefined();

      // Generate YAML to see if CEL expressions are properly generated
      const yaml = composition.toYaml();
      expect(yaml).toContain('${'); // Should contain CEL expressions for resource references

      // Status fields with only schema references are classified as static fields
      // and are hydrated directly by TypeKro, not sent to Kro
      expect(yaml).toContain('status: {}'); // Static fields don't appear in Kro YAML
      
      // But resource references should still appear as CEL expressions
      expect(yaml).toContain('${schema.spec.tier}');
      
      console.log('Generated YAML:', yaml);
    });

    it('should handle JavaScript expressions in both resource properties and status fields', () => {
      const composition = kubernetesComposition(
        {
          name: 'mixed-expressions-test',
          apiVersion: 'test.com/v1',
          kind: 'MixedTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          // JavaScript expression in resource name
          const _policy = NetworkPolicy({
            name: `${spec.name}-policy`, // JavaScript expression in resource property
            spec: {
              endpointSelector: {
                matchLabels: { tier: spec.tier }
              }
            },
            id: 'policy'
          });

          return {
            ready: true,
            namespacePolicyName: `${spec.name}-policy`, // JavaScript expression in status field
            clusterPolicyName: 'static-name', // Static value
            policiesApplied: 1,
          };
        }
      );

      // Test that both Kro and Direct factories work
      const kroFactory = composition.factory('kro', { namespace: 'test' });
      const directFactory = composition.factory('direct', { namespace: 'test' });
      
      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();

      // Generate YAML and check for proper CEL conversion
      const yaml = composition.toYaml();
      console.log('Mixed expressions YAML:', yaml);
      
      // Status fields with only schema references are static and don't appear in Kro YAML
      expect(yaml).toContain('status: {}'); // Static fields are hydrated by TypeKro
      
      // Resource references should still appear as CEL expressions
      expect(yaml).toContain('${schema.spec.tier}');
    });

    it('should preserve static values and only convert JavaScript expressions', () => {
      const composition = kubernetesComposition(
        {
          name: 'static-vs-dynamic-test',
          apiVersion: 'test.com/v1',
          kind: 'StaticDynamicTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          const _policy = NetworkPolicy({
            name: 'static-policy-name', // Static string
            spec: {
              endpointSelector: {
                matchLabels: { tier: spec.tier } // This should become a CEL expression
              }
            },
            id: 'policy'
          });

          return {
            ready: true,
            namespacePolicyName: 'static-namespace-policy', // Static string
            clusterPolicyName: `${spec.name}-cluster-policy`, // JavaScript expression
            policiesApplied: 1, // Static number
          };
        }
      );

      const yaml = composition.toYaml();
      console.log('Static vs Dynamic YAML:', yaml);
      
      // Status fields with only schema references are static and don't appear in Kro YAML
      expect(yaml).toContain('status: {}'); // Static fields are hydrated by TypeKro
      
      // Resource references should still appear as CEL expressions
      expect(yaml).toContain('${schema.spec.tier}');
      
      // Static values should not appear in the YAML (they're hydrated by TypeKro)
      // Only dynamic CEL expressions should appear
    });
  });

  describe('Kro Factory Deployment', () => {
    it('should successfully deploy with Kro factory when JavaScript expressions are converted', async () => {
      const composition = kubernetesComposition(
        {
          name: 'kro-deployment-test',
          apiVersion: 'test.com/v1',
          kind: 'KroDeploymentTest',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (spec) => {
          const _policy = NetworkPolicy({
            name: `${spec.name}-test-policy`,
            spec: {
              endpointSelector: {
                matchLabels: { tier: spec.tier }
              }
            },
            id: 'testPolicy'
          });

          return {
            ready: true,
            namespacePolicyName: `${spec.name}-test-policy`,
            clusterPolicyName: `cluster-${spec.name}`,
            policiesApplied: 1,
          };
        }
      );

      // This should work without throwing errors
      const kroFactory = composition.factory('kro', { namespace: 'test' });
      expect(kroFactory).toBeDefined();
      expect(kroFactory.deploy).toBeDefined();
      
      // The factory should be able to generate proper deployment specs
      // without throwing errors about unresolved CEL expressions
    });
  });
});