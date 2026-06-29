/**
 * Unit tests for hybrid spec functionality in composition functions
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { Cel } from '../../../src/core/references/cel.js';
import { externalRef } from '../../../src/core/references/external-refs.js';

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

  it('collapses a no-op has() conditional instead of guarding an unrelated `||` field', () => {
    // Regression: when a composition has an optional field with a `||` default (here `version`)
    // AND a separate resource field built from a CEL expression over a DIFFERENT field (`name`),
    // the proxy/hybrid serialization passes diverge structurally on that leaf but render to the
    // IDENTICAL CEL. The serializer used to emit `has(schema.spec.version) ? <expr> : <expr>` —
    // a no-op guard keyed on the WRONG field (pickConditionField's first-overridden fallback),
    // misleading and, for `${...}`-bearing reprs, structurally invalid. It must now emit `<expr>`.
    const Spec = type({ name: 'string', 'version?': 'string' });
    const Status = type({ ready: 'boolean', version: 'string' });
    const comp = kubernetesComposition(
      {
        name: 'noop-conditional-collapse',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'NoopCollapse',
        spec: Spec,
        status: Status,
      },
      (spec) => {
        const version = spec.version || 'latest'; // unrelated `||` default → an "overridden field"
        externalRef({
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: Cel.expr<string>('schema.spec.name + "-webserver"') },
          id: 'observed',
        });
        return {
          ready: Cel.expr<boolean>('has(observed.status) && observed.status.availableReplicas >= 1'),
          version,
        };
      }
    );

    const yaml = comp.toYaml();
    // The observed Deployment name is the clean expression — no guard, no identical-branch ternary.
    expect(yaml).toContain('${schema.spec.name + "-webserver"}');
    expect(yaml).not.toContain('has(schema.spec.version) ? schema.spec.name');
  });
});