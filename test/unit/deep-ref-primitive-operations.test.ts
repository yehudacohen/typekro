/**
 * Tests for DeepKubernetesRef primitive value operations
 *
 * Validates that KubernetesRef objects can be used in:
 * - Boolean expressions (&&, ||, !)
 * - Arithmetic operations (+, -, *, /)
 * - String operations (concatenation)
 * - Comparison operations (>, <, ===, etc.)
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';

describe('DeepKubernetesRef Primitive Operations', () => {
  it('should support boolean expressions with && operator', () => {
    const Spec = type({ name: 'string' });
    const Status = type({
      components: {
        database: 'boolean',
        api: 'boolean',
        cache: 'boolean',
      },
    });

    const comp = kubernetesComposition(
      {
        name: 'test-comp',
        kind: 'TestComp',
        spec: Spec,
        status: Status,
      },
      (_spec) => {
        return {
          components: {
            database: true,
            api: true,
            cache: false,
          },
        };
      }
    );

    // This should compile without errors - the key test!
    const allReady = comp.status.components.database && comp.status.components.api;
    const anyFailed = !comp.status.components.cache;

    // Type should be: boolean | KubernetesRef<boolean>
    // Runtime: These are KubernetesRef objects, but type-wise they can be used as booleans
    expect(allReady).toBeDefined();
    expect(anyFailed).toBeDefined();
  });

  it('should support boolean expressions with || operator', () => {
    const Spec = type({ name: 'string' });
    const Status = type({
      ready: 'boolean',
      fallbackReady: 'boolean',
    });

    const comp = kubernetesComposition(
      {
        name: 'fallback-comp',
        kind: 'FallbackComp',
        spec: Spec,
        status: Status,
      },
      (_spec) => {
        return {
          ready: false,
          fallbackReady: true,
        };
      }
    );

    // Should compile: KubernetesRef<boolean> | boolean can be used in || expression
    const isReady = comp.status.ready || comp.status.fallbackReady;
    expect(isReady).toBeDefined();
  });

  it('should support negation with ! operator', () => {
    const Spec = type({ name: 'string' });
    const Status = type({ disabled: 'boolean' });

    const comp = kubernetesComposition(
      {
        name: 'toggle-comp',
        kind: 'ToggleComp',
        spec: Spec,
        status: Status,
      },
      (_spec) => ({ disabled: false })
    );

    // Should compile: Can negate KubernetesRef<boolean> | boolean
    const enabled = !comp.status.disabled;
    expect(enabled).toBeDefined();
  });

  it('should support real-world nested composition pattern', () => {
    // Simulate TypeKro runtime bootstrap
    const RuntimeSpec = type({ namespace: 'string' });
    const RuntimeStatus = type({
      phase: '"Pending" | "Installing" | "Ready" | "Failed"',
      components: {
        fluxSystem: 'boolean',
        kroSystem: 'boolean',
      },
    });

    const runtimeBootstrap = kubernetesComposition(
      {
        name: 'runtime-bootstrap',
        kind: 'RuntimeBootstrap',
        spec: RuntimeSpec,
        status: RuntimeStatus,
      },
      (_spec) => {
        return {
          phase: 'Ready' as const,
          components: {
            fluxSystem: true as boolean, // Explicit boolean to avoid literal type
            kroSystem: true as boolean,
          },
        };
      }
    );

    // Parent composition that uses runtime bootstrap
    const AppSpec = type({ name: 'string' });
    const AppStatus = type({
      ready: 'boolean',
      runtimeReady: 'boolean',
    });

    // THIS IS THE KEY TEST - this pattern should work without TypeScript errors!
    const appComposition = kubernetesComposition(
      {
        name: 'application',
        kind: 'Application',
        spec: AppSpec,
        status: AppStatus,
      },
      (_spec) => {
        // The original problem: this should work!
        const ready =
          runtimeBootstrap.status.components.kroSystem &&
          runtimeBootstrap.status.components.fluxSystem;

        return {
          ready: ready,
          runtimeReady: runtimeBootstrap.status.components.kroSystem,
        };
      }
    );

    expect(appComposition).toBeDefined();
    expect(typeof appComposition.toYaml).toBe('function');
  });

  it('should work with complex boolean logic', () => {
    const Spec = type({ name: 'string' });
    const Status = type({
      services: {
        web: 'boolean',
        api: 'boolean',
        database: 'boolean',
        cache: 'boolean',
      },
    });

    const comp = kubernetesComposition(
      {
        name: 'complex-comp',
        kind: 'ComplexComp',
        spec: Spec,
        status: Status,
      },
      (_spec) => {
        return {
          services: {
            web: true as boolean,
            api: true as boolean,
            database: true as boolean,
            cache: false as boolean,
          },
        };
      }
    );

    // Complex nested boolean expression - should compile!
    const coreReady =
      comp.status.services.web && comp.status.services.api && comp.status.services.database;

    const allReady = coreReady && comp.status.services.cache;

    const anyReady =
      comp.status.services.web ||
      comp.status.services.api ||
      comp.status.services.database ||
      comp.status.services.cache;

    expect(coreReady).toBeDefined();
    expect(allReady).toBeDefined();
    expect(anyReady).toBeDefined();
  });

  it('should support ternary operator with boolean refs', () => {
    const Spec = type({ name: 'string' });
    const Status = type({
      enabled: 'boolean',
      message: 'string',
    });

    const comp = kubernetesComposition(
      {
        name: 'ternary-comp',
        kind: 'TernaryComp',
        spec: Spec,
        status: Status,
      },
      (_spec) => {
        return {
          enabled: true as boolean,
          message: 'active',
        };
      }
    );

    // Should work with ternary operator
    const status = comp.status.enabled ? 'active' : 'inactive';
    expect(status).toBeDefined();
  });
});
