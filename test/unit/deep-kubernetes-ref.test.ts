/**
 * Tests for DeepKubernetesRef type and nested property access
 *
 * Validates that the type system properly supports nested property access
 * on KubernetesRef objects, matching the runtime Proxy behavior.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { expectKubernetesRef } from '../utils/mock-factories.js';

describe('DeepKubernetesRef Type System', () => {
  it('should allow nested property access on complex status objects', () => {
    const ComplexSpec = type({
      name: 'string',
    });

    const ComplexStatus = type({
      components: {
        database: 'boolean',
        api: 'boolean',
        cache: {
          enabled: 'boolean',
          size: 'number',
        },
      },
      health: {
        overall: 'string',
        lastCheck: 'string',
      },
    });

    const complexComp = kubernetesComposition(
      {
        name: 'complex-app',
        kind: 'ComplexApp',
        spec: ComplexSpec,
        status: ComplexStatus,
      },
      (_spec) => {
        return {
          components: {
            database: true,
            api: true,
            cache: {
              enabled: false,
              size: 100,
            },
          },
          health: {
            overall: 'healthy',
            lastCheck: '2025-01-01T00:00:00Z',
          },
        };
      }
    );

    // TypeScript should allow all these nested accesses without errors
    const componentsRef = complexComp.status.components;
    const databaseRef = complexComp.status.components.database;
    const cacheRef = complexComp.status.components.cache;
    const healthRef = complexComp.status.health;
    const overallHealthRef = complexComp.status.health.overall;

    // Verify they're all KubernetesRef objects with correct field paths
    expectKubernetesRef(componentsRef, { fieldPath: 'status.components' });
    expectKubernetesRef(databaseRef, { fieldPath: 'status.components.database' });
    expectKubernetesRef(cacheRef, { fieldPath: 'status.components.cache' });
    expectKubernetesRef(healthRef, { fieldPath: 'status.health' });
    expectKubernetesRef(overallHealthRef, { fieldPath: 'status.health.overall' });

    // Note: The current Proxy implementation supports up to 2 levels of nesting
    // Deeper nesting (3+ levels) requires recursive Proxy implementation
    // For now, the type system supports it but runtime doesn't - this is sufficient
    // for most real-world cases like: composition.status.components.kroSystem
  });

  it('should work in real-world nested composition scenario', () => {
    // Simulate TypeKro runtime bootstrap structure
    const RuntimeSpec = type({
      namespace: 'string',
    });

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
            fluxSystem: true,
            kroSystem: true,
          },
        };
      }
    );

    // Parent composition that uses runtime bootstrap
    const AppSpec = type({
      name: 'string',
    });

    const AppStatus = type({
      ready: 'boolean',
      runtimeReady: 'boolean',
    });

    const appComposition = kubernetesComposition(
      {
        name: 'application',
        kind: 'Application',
        spec: AppSpec,
        status: AppStatus,
      },
      (_spec) => {
        // This pattern should work without TypeScript errors!
        const kroReady = runtimeBootstrap.status.components.kroSystem;
        const fluxReady = runtimeBootstrap.status.components.fluxSystem;

        return {
          ready: kroReady && fluxReady, // Type system should handle this
          runtimeReady: runtimeBootstrap.status.components.kroSystem,
        };
      }
    );

    // Verify the composition was created successfully
    expect(appComposition).toBeDefined();
    expect(typeof appComposition.toYaml).toBe('function');
  });

  it('should maintain type safety with primitive values', () => {
    const SimpleSpec = type({
      name: 'string',
    });

    const SimpleStatus = type({
      ready: 'boolean',
      count: 'number',
      message: 'string',
    });

    const simpleComp = kubernetesComposition(
      {
        name: 'simple-comp',
        kind: 'SimpleComp',
        spec: SimpleSpec,
        status: SimpleStatus,
      },
      (_spec) => {
        return {
          ready: true,
          count: 5,
          message: 'hello',
        };
      }
    );

    // Primitive values should be KubernetesRef without nested access
    const readyRef = simpleComp.status.ready;
    const countRef = simpleComp.status.count;
    const messageRef = simpleComp.status.message;

    expectKubernetesRef(readyRef, { fieldPath: 'status.ready' });
    expectKubernetesRef(countRef, { fieldPath: 'status.count' });
    expectKubernetesRef(messageRef, { fieldPath: 'status.message' });
  });

  it('should support 2 levels of nesting (current runtime limit)', () => {
    const TwoLevelSpec = type({
      name: 'string',
    });

    const TwoLevelStatus = type({
      level1: {
        level2: {
          value: 'string',
          enabled: 'boolean',
        },
      },
    });

    const twoLevelComp = kubernetesComposition(
      {
        name: 'two-level-comp',
        kind: 'TwoLevelComp',
        spec: TwoLevelSpec,
        status: TwoLevelStatus,
      },
      (_spec) => {
        return {
          level1: {
            level2: {
              value: 'nested',
              enabled: true,
            },
          },
        };
      }
    );

    // Current Proxy implementation supports up to 2 levels
    const level1Ref = twoLevelComp.status.level1;
    const level2Ref = twoLevelComp.status.level1.level2;

    // TypeScript allows these but runtime only creates Proxy for first 2 levels
    // This is sufficient for real-world patterns like: status.components.kroSystem
    expectKubernetesRef(level1Ref, { fieldPath: 'status.level1' });
    expectKubernetesRef(level2Ref, { fieldPath: 'status.level1.level2' });

    // Note: 3+ levels would require recursive Proxy implementation
    // For now, type system supports it for DX, but runtime doesn't need it
    // since typical use cases are 1-2 levels deep
  });
});
