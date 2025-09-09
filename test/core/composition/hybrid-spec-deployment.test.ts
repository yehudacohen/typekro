/**
 * Integration tests for hybrid spec functionality during deployment
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';

describe('Hybrid Spec During Deployment', () => {
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
    actualValue: 'string',
  });

  it('should provide actual values during deployment', async () => {
    let capturedSpecType: string = 'unknown';
    let capturedActualValue: string = 'unknown';

    const testComposition = kubernetesComposition(
      {
        name: 'deployment-hybrid-test',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'DeploymentHybridTest',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (spec) => {
        // Capture what type we actually get
        capturedSpecType = typeof spec.networking.kubeProxyReplacement;
        capturedActualValue = String(spec.networking.kubeProxyReplacement);

        // Test conditional logic that should work with actual values
        let mappedValue = 'unknown';
        switch (spec.networking.kubeProxyReplacement) {
          case 'strict':
            mappedValue = 'boolean-true';
            break;
          case 'disabled':
            mappedValue = 'boolean-false';
            break;
          case 'partial':
            mappedValue = 'string-partial';
            break;
          default:
            mappedValue = `unexpected-${spec.networking.kubeProxyReplacement}`;
        }

        return {
          ready: spec.replicas > 0,
          mappedValue,
          typeCheck: capturedSpecType,
          actualValue: capturedActualValue,
        };
      }
    );

    // Create a direct factory (which should provide actual values)
    const factory = testComposition.factory('direct', {
      namespace: 'test',
      waitForReady: false,
    });

    // Deploy with actual spec values
    const instance = await factory.deploy({
      name: 'test-deployment',
      networking: {
        kubeProxyReplacement: 'strict',
        routingMode: 'tunnel',
      },
      replicas: 3,
    });

    // Verify that the composition function received actual values
    expect(instance.status.typeCheck).toBe('string'); // Should be 'string', not 'function'
    expect(instance.status.actualValue).toBe('strict'); // Should be the actual value
    expect(instance.status.mappedValue).toBe('boolean-true'); // Should be mapped correctly
    expect(instance.status.ready).toBe(true); // Should work with numeric comparison
  });

  it('should handle different kubeProxyReplacement values correctly', async () => {
    const testComposition = kubernetesComposition(
      {
        name: 'mapping-test',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'MappingTest',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (spec) => {
        // Test the exact mapping logic that was failing in Cilium
        let mappedValue = 'unknown';
        
        if (typeof spec.networking.kubeProxyReplacement === 'string') {
          switch (spec.networking.kubeProxyReplacement) {
            case 'disabled':
              mappedValue = 'false';
              break;
            case 'partial':
              mappedValue = 'partial';
              break;
            case 'strict':
              mappedValue = 'true';
              break;
            default:
              mappedValue = `unmapped-${spec.networking.kubeProxyReplacement}`;
          }
        } else {
          mappedValue = `wrong-type-${typeof spec.networking.kubeProxyReplacement}`;
        }

        return {
          ready: true,
          mappedValue,
          typeCheck: typeof spec.networking.kubeProxyReplacement,
          actualValue: String(spec.networking.kubeProxyReplacement),
        };
      }
    );

    const factory = testComposition.factory('direct', {
      namespace: 'test',
      waitForReady: false,
    });

    // Test 'strict' -> 'true'
    const strictInstance = await factory.deploy({
      name: 'test-strict',
      networking: { kubeProxyReplacement: 'strict', routingMode: 'tunnel' },
      replicas: 1,
    });
    expect(strictInstance.status.mappedValue).toBe('true');
    expect(strictInstance.status.typeCheck).toBe('string');

    // Test 'disabled' -> 'false'
    const disabledInstance = await factory.deploy({
      name: 'test-disabled',
      networking: { kubeProxyReplacement: 'disabled', routingMode: 'tunnel' },
      replicas: 1,
    });
    expect(disabledInstance.status.mappedValue).toBe('false');
    expect(disabledInstance.status.typeCheck).toBe('string');

    // Test 'partial' -> 'partial'
    const partialInstance = await factory.deploy({
      name: 'test-partial',
      networking: { kubeProxyReplacement: 'partial', routingMode: 'tunnel' },
      replicas: 1,
    });
    expect(partialInstance.status.mappedValue).toBe('partial');
    expect(partialInstance.status.typeCheck).toBe('string');
  });
});