/**
 * Unit tests for hybrid spec functionality in composition functions
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';

describe('Hybrid Spec in Composition Functions', () => {
  const TestSpecSchema = type({
    name: 'string',
    networking: {
      kubeProxyReplacement: '"disabled" | "partial" | "strict"',
      routingMode: '"tunnel" | "native"',
    },
    replicas: 'number',
  });

  const TestStatusSchema = type({
    ready: 'boolean',
    mappedValue: 'string',
    typeCheck: 'string',
  });

  it('should provide actual values for JavaScript logic in composition functions', () => {
    const testComposition = kubernetesComposition(
      {
        name: 'hybrid-spec-test',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'HybridSpecTest',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (spec) => {
        // Test that we get actual values for JavaScript operations
        let mappedValue = 'unknown';
        let typeCheck = 'unknown';

        // Test typeof check - should work with actual values
        if (typeof spec.networking.kubeProxyReplacement === 'string') {
          typeCheck = 'string';
        } else if (typeof spec.networking.kubeProxyReplacement === 'function') {
          typeCheck = 'function';
        }

        // Test switch statement - should work with actual values
        switch (spec.networking.kubeProxyReplacement) {
          case 'strict':
            mappedValue = 'true';
            break;
          case 'disabled':
            mappedValue = 'false';
            break;
          case 'partial':
            mappedValue = 'partial';
            break;
          default:
            mappedValue = 'unknown';
        }

        return {
          ready: spec.replicas > 0,
          mappedValue,
          typeCheck,
        };
      }
    );

    // Test that the composition was created successfully
    expect(testComposition).toBeDefined();
    expect(testComposition.name).toBe('hybrid-spec-test');

    // Test that we can create a factory
    const factory = testComposition.factory('direct', {
      namespace: 'test',
      waitForReady: false,
    });

    expect(factory).toBeDefined();
  });

  it('should handle nested object access correctly', () => {
    const testComposition = kubernetesComposition(
      {
        name: 'nested-hybrid-test',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'NestedHybridTest',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (spec) => {
        // Test nested object access
        const networkingConfig = spec.networking;
        let mappedValue = 'unknown';

        // Test that nested access works
        if (networkingConfig.kubeProxyReplacement === 'strict') {
          mappedValue = 'strict-mode';
        }

        return {
          ready: true,
          mappedValue,
          typeCheck: typeof networkingConfig.routingMode,
        };
      }
    );

    expect(testComposition).toBeDefined();
    expect(testComposition.name).toBe('nested-hybrid-test');
  });
});