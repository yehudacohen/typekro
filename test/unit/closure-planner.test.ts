/**
 * Unit tests for closure-planner.ts pure functions:
 * - analyzeClosureDependencies
 * - integrateClosuresIntoPlan
 */

import { describe, expect, it } from 'bun:test';
import { DependencyGraph } from '../../src/core/dependencies/graph.js';
import { DependencyResolver } from '../../src/core/dependencies/resolver.js';
import {
  analyzeClosureDependencies,
  integrateClosuresIntoPlan,
} from '../../src/core/deployment/closure-planner.js';
import type { ClosureDependencyInfo, DeploymentClosure } from '../../src/core/types/deployment.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal mock deployment closure */
function mockClosure(): DeploymentClosure {
  return async () => [];
}

/** Create a minimal deployment plan */
function makePlan(
  levels: string[][],
  totalResources: number,
  maxParallelism: number
): { levels: string[][]; totalResources: number; maxParallelism: number } {
  return { levels, totalResources, maxParallelism };
}

/** Build a ClosureDependencyInfo for testing integrateClosuresIntoPlan */
function makeClosureInfo(
  name: string,
  level: number,
  dependencies: string[] = []
): ClosureDependencyInfo {
  return { name, closure: mockClosure(), dependencies, level };
}

// ============================================================================
// analyzeClosureDependencies
// ============================================================================

describe('analyzeClosureDependencies', () => {
  const emptyGraph = new DependencyGraph();
  const resolver = new DependencyResolver();

  it('returns empty array when closures map is empty', () => {
    const result = analyzeClosureDependencies({}, {}, emptyGraph, resolver);
    expect(result).toEqual([]);
  });

  it('returns one ClosureInfo with dependencies: [] and level: -1 for a single closure', () => {
    const closure = mockClosure();
    const result = analyzeClosureDependencies(
      { installCRDs: closure },
      { name: 'test' },
      emptyGraph,
      resolver
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('installCRDs');
    expect(result[0]!.closure).toBe(closure);
    expect(result[0]!.dependencies).toEqual([]);
    expect(result[0]!.level).toBe(-1);
  });

  it('returns all closures with level -1 for multiple independent closures', () => {
    const closureA = mockClosure();
    const closureB = mockClosure();
    const closureC = mockClosure();

    const result = analyzeClosureDependencies(
      { alpha: closureA, beta: closureB, gamma: closureC },
      {},
      emptyGraph,
      resolver
    );

    expect(result).toHaveLength(3);
    for (const info of result) {
      expect(info.level).toBe(-1);
      expect(info.dependencies).toEqual([]);
    }
  });

  it('preserves closure names and function references', () => {
    const fluxSystem = mockClosure();
    const certManager = mockClosure();

    const result = analyzeClosureDependencies(
      { fluxSystem, certManager },
      { replicas: 3 },
      emptyGraph,
      resolver
    );

    const names = result.map((r) => r.name);
    expect(names).toContain('fluxSystem');
    expect(names).toContain('certManager');

    const fluxInfo = result.find((r) => r.name === 'fluxSystem');
    expect(fluxInfo!.closure).toBe(fluxSystem);

    const certInfo = result.find((r) => r.name === 'certManager');
    expect(certInfo!.closure).toBe(certManager);
  });
});

// ============================================================================
// integrateClosuresIntoPlan
// ============================================================================

describe('integrateClosuresIntoPlan', () => {
  it('returns enhanced plan matching original resource levels with empty closure arrays when no closures', () => {
    const plan = makePlan([['deploy', 'configmap'], ['service']], 3, 2);
    const result = integrateClosuresIntoPlan(plan, []);

    expect(result.levels).toHaveLength(2);
    expect(result.levels[0]!.resources).toEqual(['deploy', 'configmap']);
    expect(result.levels[0]!.closures).toEqual([]);
    expect(result.levels[1]!.resources).toEqual(['service']);
    expect(result.levels[1]!.closures).toEqual([]);
    expect(result.totalResources).toBe(3);
    expect(result.totalClosures).toBe(0);
  });

  it('creates new level 0 with pre-resource closures and shifts resource levels by 1', () => {
    const plan = makePlan([['deploy'], ['service']], 2, 1);
    const closures = [makeClosureInfo('installCRDs', -1), makeClosureInfo('setupFlux', -1)];

    const result = integrateClosuresIntoPlan(plan, closures);

    // Level 0 should be the closure-only level
    expect(result.levels).toHaveLength(3);
    expect(result.levels[0]!.resources).toEqual([]);
    expect(result.levels[0]!.closures).toHaveLength(2);
    expect(result.levels[0]!.closures.map((c) => c.name)).toEqual(['installCRDs', 'setupFlux']);

    // Original resource levels shifted by 1
    expect(result.levels[1]!.resources).toEqual(['deploy']);
    expect(result.levels[1]!.closures).toEqual([]);
    expect(result.levels[2]!.resources).toEqual(['service']);
    expect(result.levels[2]!.closures).toEqual([]);
  });

  it('creates a single level with just closures when plan has no resource levels', () => {
    const plan = makePlan([], 0, 0);
    const closures = [makeClosureInfo('bootstrap', -1)];

    const result = integrateClosuresIntoPlan(plan, closures);

    expect(result.levels).toHaveLength(1);
    expect(result.levels[0]!.resources).toEqual([]);
    expect(result.levels[0]!.closures).toHaveLength(1);
    expect(result.levels[0]!.closures[0]!.name).toBe('bootstrap');
    expect(result.totalResources).toBe(0);
    expect(result.totalClosures).toBe(1);
  });

  it('handles multiple resource levels with pre-resource closures and correct level shifting', () => {
    const plan = makePlan([['ns'], ['deploy', 'configmap'], ['service'], ['ingress']], 5, 2);
    const closures = [makeClosureInfo('flux', -1)];

    const result = integrateClosuresIntoPlan(plan, closures);

    // 1 closure level + 4 original levels = 5 total
    expect(result.levels).toHaveLength(5);

    // Level 0: closures only
    expect(result.levels[0]!.resources).toEqual([]);
    expect(result.levels[0]!.closures).toHaveLength(1);

    // Levels 1-4: original resource levels shifted
    expect(result.levels[1]!.resources).toEqual(['ns']);
    expect(result.levels[2]!.resources).toEqual(['deploy', 'configmap']);
    expect(result.levels[3]!.resources).toEqual(['service']);
    expect(result.levels[4]!.resources).toEqual(['ingress']);
  });

  it('reports correct totalClosures and totalResources counts', () => {
    const plan = makePlan([['a', 'b'], ['c']], 3, 2);
    const closures = [
      makeClosureInfo('c1', -1),
      makeClosureInfo('c2', -1),
      makeClosureInfo('c3', -1),
    ];

    const result = integrateClosuresIntoPlan(plan, closures);

    expect(result.totalResources).toBe(3);
    expect(result.totalClosures).toBe(3);
  });

  it('computes maxParallelism as max of original and closure count per level', () => {
    // Original maxParallelism is 2, but we put 3 closures in level 0
    const plan = makePlan([['a', 'b']], 2, 2);
    const closures = [
      makeClosureInfo('c1', -1),
      makeClosureInfo('c2', -1),
      makeClosureInfo('c3', -1),
    ];

    const result = integrateClosuresIntoPlan(plan, closures);

    // maxParallelism should be max(2, 3) = 3
    expect(result.maxParallelism).toBe(3);
  });

  it('keeps maxParallelism at original when closures are fewer', () => {
    const plan = makePlan([['a', 'b', 'c', 'd']], 4, 4);
    const closures = [makeClosureInfo('c1', -1)];

    const result = integrateClosuresIntoPlan(plan, closures);

    expect(result.maxParallelism).toBe(4);
  });
});
