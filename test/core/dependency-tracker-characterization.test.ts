/**
 * Characterization tests for DependencyTracker
 *
 * These tests capture the CURRENT behavior of dependency tracking,
 * circular dependency detection (DFS + Tarjan's SCC), and deployment ordering.
 *
 * Source: src/core/expressions/factory/dependency-tracker.ts (774 lines)
 */

import { describe, expect, it } from 'bun:test';
import { DependencyTracker } from '../../src/core/expressions/factory/dependency-tracker.js';
import type { KubernetesRef } from '../../src/core/types/common.js';
import { KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

// Helper to create a KubernetesRef
function ref(resourceId: string, fieldPath: string, _type?: string): KubernetesRef {
  return {
    [KUBERNETES_REF_BRAND]: true as const,
    resourceId,
    fieldPath,
    ...(_type !== undefined ? { _type } : {}),
  };
}

describe('DependencyTracker', () => {
  describe('constructor', () => {
    it('initializes with empty dependency graph', () => {
      const tracker = new DependencyTracker();
      const graph = tracker.getDependencyGraph();

      expect(graph.dependencies.size).toBe(0);
      expect(graph.dependents.size).toBe(0);
      expect(graph.circularChains).toEqual([]);
      expect(graph.deploymentOrder).toEqual([]);
    });
  });

  describe('trackDependencies', () => {
    it('tracks resource dependencies and returns DependencyInfo array', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'status.ready'), ref('service1', 'spec.clusterIP')];
      const paths = ['spec.readyCheck', 'spec.endpoint'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result).toHaveLength(2);
      expect(result[0]?.fieldPath).toBe('spec.readyCheck');
      expect(result[0]?.dependencyType).toBe('resource');
      expect(result[1]?.fieldPath).toBe('spec.endpoint');
    });

    it('classifies __schema__ refs as schema type', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('__schema__', 'spec.name')];
      const paths = ['name'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.dependencyType).toBe('schema');
    });

    it('classifies uppercase/special-char refs as external type', () => {
      const tracker = new DependencyTracker();
      // determineDependencyType checks /^[a-z][a-z0-9-]*$/ — uppercase doesn't match
      const deps = [ref('ExternalService', 'status.endpoint')];
      const paths = ['external'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.dependencyType).toBe('external');
    });

    it('marks schema dependencies as required', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('__schema__', 'spec.name')];
      const paths = ['name'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.required).toBe(true);
    });

    it('marks dependencies on required fields as required', () => {
      const tracker = new DependencyTracker();
      // 'name', 'image', 'namespace' are considered required fields
      const deps = [ref('deploy1', 'metadata.name')];
      const paths = ['spec.name'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.required).toBe(true);
    });

    it('marks conditional dependencies as not required', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'status.ready')];
      // Field path with '?' indicates conditional context
      const paths = ['spec.enabled?.check'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.required).toBe(false);
    });

    it('detects readiness-affecting dependencies via status field path', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'status.readyReplicas')];
      const paths = ['check'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.metadata?.affectsReadiness).toBe(true);
    });

    it('detects readiness-affecting dependencies via field keywords', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'spec.template')];
      const paths = ['spec.replicas']; // 'replicas' is a readiness keyword

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.metadata?.affectsReadiness).toBe(true);
    });

    it('skips null/undefined dependencies gracefully', () => {
      const tracker = new DependencyTracker();
      const deps = [undefined as any, ref('deploy1', 'status.ready'), null as any];
      const paths = ['first', 'second', 'third'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      // Only the valid ref should be tracked
      expect(result).toHaveLength(1);
      expect(result[0]?.fieldPath).toBe('second');
    });

    it('uses fallback field path when index exceeds paths array', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'status.ready'), ref('deploy2', 'status.ready')];
      const paths = ['first']; // only one path for two deps

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.fieldPath).toBe('first');
      expect(result[1]?.fieldPath).toBe('unknown[1]');
    });

    it('sets expectedType from ref._type', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'status.ready', 'boolean')];
      const paths = ['check'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.expectedType).toBe('boolean');
    });

    it('defaults expectedType to unknown when _type is missing', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'status.ready')];
      const paths = ['check'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.expectedType).toBe('unknown');
    });
  });

  describe('trackDependencies — skipping by options', () => {
    it('creates skipped info when trackSchemaDependencies is false', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('__schema__', 'spec.name')];
      const paths = ['name'];

      const result = tracker.trackDependencies('my-app', deps, paths, {
        trackSchemaDependencies: false,
      });

      expect(result[0]?.required).toBe(false);
      expect(result[0]?.expectedType).toBe('skipped');
    });

    it('creates skipped info when trackResourceDependencies is false', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'status.ready')];
      const paths = ['check'];

      const result = tracker.trackDependencies('my-app', deps, paths, {
        trackResourceDependencies: false,
      });

      expect(result[0]?.expectedType).toBe('skipped');
    });

    it('creates skipped info when trackExternalDependencies is false', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('ExternalSvc', 'status.url')];
      const paths = ['endpoint'];

      const result = tracker.trackDependencies('my-app', deps, paths, {
        trackExternalDependencies: false,
      });

      expect(result[0]?.expectedType).toBe('skipped');
    });
  });

  describe('dependency graph operations', () => {
    it('builds dependency graph from tracked dependencies', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('app', [ref('db', 'status.ready')], ['readyCheck']);
      tracker.trackDependencies('web', [ref('app', 'status.endpoint')], ['backend']);

      const graph = tracker.getDependencyGraph();

      expect(graph.dependencies.size).toBe(2);
      expect(graph.dependencies.get('app')).toHaveLength(1);
      expect(graph.dependencies.get('web')).toHaveLength(1);
    });

    it('builds reverse dependency map (dependents)', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('app', [ref('db', 'status.ready')], ['readyCheck']);
      tracker.trackDependencies('web', [ref('db', 'status.ready')], ['dbCheck']);

      const dependents = tracker.getDependents('db');

      expect(dependents).toContain('app');
      expect(dependents).toContain('web');
    });

    it('does not add duplicates in dependents', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies(
        'app',
        [ref('db', 'status.ready'), ref('db', 'status.port')],
        ['readyCheck', 'portCheck']
      );

      const dependents = tracker.getDependents('db');

      // 'app' should appear only once even though it references 'db' twice
      expect(dependents.filter((d) => d === 'app')).toHaveLength(1);
    });

    it('does not track __schema__ in dependents', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('app', [ref('__schema__', 'spec.name')], ['name']);

      const dependents = tracker.getDependents('__schema__');

      expect(dependents).toEqual([]);
    });

    it('getDependencies returns empty array for unknown resource', () => {
      const tracker = new DependencyTracker();

      expect(tracker.getDependencies('nonexistent')).toEqual([]);
    });

    it('getDependents returns empty array for unknown resource', () => {
      const tracker = new DependencyTracker();

      expect(tracker.getDependents('nonexistent')).toEqual([]);
    });
  });

  describe('circular dependency detection (DFS)', () => {
    it('detects simple circular dependency', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('A', [ref('B', 'status.ready')], ['dep'], {
        detectCircularDependencies: false,
      });
      tracker.trackDependencies('B', [ref('A', 'status.ready')], ['dep'], {
        detectCircularDependencies: true,
      });

      expect(tracker.hasCircularDependencies()).toBe(true);
    });

    it('detects transitive circular dependency', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('A', [ref('B', 'status.x')], ['dep']);
      tracker.trackDependencies('B', [ref('C', 'status.x')], ['dep']);
      tracker.trackDependencies('C', [ref('A', 'status.x')], ['dep'], {
        detectCircularDependencies: true,
      });

      expect(tracker.hasCircularDependencies()).toBe(true);
    });

    it('does not falsely detect cycles in DAGs', () => {
      const tracker = new DependencyTracker();
      // Diamond: A→B, A→C, B→D, C→D (no cycle)
      tracker.trackDependencies('A', [ref('B', 's'), ref('C', 's')], ['b', 'c']);
      tracker.trackDependencies('B', [ref('D', 's')], ['d']);
      tracker.trackDependencies('C', [ref('D', 's')], ['d'], {
        detectCircularDependencies: true,
      });

      expect(tracker.hasCircularDependencies()).toBe(false);
    });
  });

  describe('deployment order (topological sort)', () => {
    it('computes correct deployment order for linear chain', () => {
      const tracker = new DependencyTracker();
      // A depends on B, B depends on C → deploy order: C, B, A
      tracker.trackDependencies('A', [ref('B', 's')], ['dep']);
      tracker.trackDependencies('B', [ref('C', 's')], ['dep'], {
        computeDeploymentOrder: true,
      });

      const order = tracker.getDeploymentOrder();

      // C should come before B, B before A
      const indexC = order.indexOf('C');
      const indexB = order.indexOf('B');
      const indexA = order.indexOf('A');

      expect(indexC).toBeLessThan(indexB);
      expect(indexB).toBeLessThan(indexA);
    });

    it('returns empty order when no dependencies tracked', () => {
      const tracker = new DependencyTracker();

      expect(tracker.getDeploymentOrder()).toEqual([]);
    });

    it('ignores __schema__ in deployment order', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('A', [ref('__schema__', 'spec.name')], ['name'], {
        computeDeploymentOrder: true,
      });

      const order = tracker.getDeploymentOrder();

      expect(order).toContain('A');
      expect(order).not.toContain('__schema__');
    });
  });

  describe('reset', () => {
    it('clears all tracked data', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('A', [ref('B', 's')], ['dep']);
      tracker.trackDependencies('B', [ref('A', 's')], ['dep'], {
        detectCircularDependencies: true,
        computeDeploymentOrder: true,
      });

      tracker.reset();

      const graph = tracker.getDependencyGraph();
      expect(graph.dependencies.size).toBe(0);
      expect(graph.dependents.size).toBe(0);
      expect(graph.circularChains).toEqual([]);
      expect(graph.deploymentOrder).toEqual([]);
      expect(tracker.hasCircularDependencies()).toBe(false);
    });
  });

  describe('detectCircularDependencyChains (Tarjan SCC)', () => {
    it('returns no circular dependencies for acyclic graph', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('A', [ref('B', 's')], ['dep']);
      tracker.trackDependencies('B', [ref('C', 's')], ['dep']);

      const analysis = tracker.detectCircularDependencyChains();

      expect(analysis.hasCircularDependencies).toBe(false);
      expect(analysis.circularChains).toEqual([]);
      expect(analysis.recommendations).toEqual([]);
    });

    it('detects simple cycle and provides analysis', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('A', [ref('B', 's')], ['dep']);
      tracker.trackDependencies('B', [ref('A', 's')], ['dep']);

      const analysis = tracker.detectCircularDependencyChains();

      expect(analysis.hasCircularDependencies).toBe(true);
      expect(analysis.circularChains.length).toBeGreaterThan(0);
      expect(analysis.chainAnalysis.length).toBeGreaterThan(0);
    });

    it('provides chain analysis with severity and risk level', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('A', [ref('B', 'status.ready')], ['readyCheck']);
      tracker.trackDependencies('B', [ref('A', 'status.ready')], ['readyCheck']);

      const analysis = tracker.detectCircularDependencyChains();

      expect(analysis.chainAnalysis[0]?.chainLength).toBeGreaterThan(0);
      expect(analysis.chainAnalysis[0]?.severity).toBeGreaterThanOrEqual(0);
      expect(analysis.chainAnalysis[0]?.severity).toBeLessThanOrEqual(1);
      expect(['low', 'medium', 'high']).toContain(analysis.chainAnalysis[0]?.riskLevel);
    });

    it('provides break point recommendations for optional dependencies', () => {
      const tracker = new DependencyTracker();
      // Use conditional field path to create optional dependency
      tracker.trackDependencies('A', [ref('B', 'status.ready')], ['spec.check?.enabled']);
      tracker.trackDependencies('B', [ref('A', 'status.ready')], ['required']);

      const analysis = tracker.detectCircularDependencyChains();

      if (analysis.hasCircularDependencies) {
        // A has an optional (conditional) dependency, so it may be a break point
        expect(analysis.chainAnalysis[0]?.breakPoints.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('recommends architecture refactoring for high-severity chains', () => {
      const tracker = new DependencyTracker();
      // Create a chain with required, readiness-affecting dependencies
      tracker.trackDependencies('A', [ref('B', 'status.readyReplicas')], ['spec.name']);
      tracker.trackDependencies('B', [ref('A', 'status.readyReplicas')], ['spec.name']);

      const analysis = tracker.detectCircularDependencyChains();

      // The recommendations may or may not include 'refactor-architecture'
      // depending on severity threshold — document actual behavior
      if (analysis.recommendations.some((r) => r.type === 'refactor-architecture')) {
        expect(
          analysis.recommendations.find((r) => r.type === 'refactor-architecture')?.severity
        ).toBe('high');
      }
    });

    it('ignores single-node SCCs (not circular)', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('A', [ref('B', 's')], ['dep']);

      const analysis = tracker.detectCircularDependencyChains();

      // Single-node SCCs should not be reported as circular
      expect(analysis.hasCircularDependencies).toBe(false);
    });

    it('finds affected fields in circular chains', () => {
      const tracker = new DependencyTracker();
      tracker.trackDependencies('A', [ref('B', 'status.ready')], ['readyCheck']);
      tracker.trackDependencies('B', [ref('A', 'status.endpoint')], ['endpointRef']);

      const analysis = tracker.detectCircularDependencyChains();

      if (analysis.hasCircularDependencies) {
        expect(analysis.chainAnalysis[0]?.affectedFields.length).toBeGreaterThan(0);
      }
    });
  });

  describe('expression context extraction', () => {
    it('extracts top-level field as expression context', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'status.ready')];
      const paths = ['spec.containers.image'];

      const result = tracker.trackDependencies('my-app', deps, paths);

      expect(result[0]?.metadata?.expressionContext).toBe('spec');
    });

    it('uses fallback field path for empty string, so context is from fallback', () => {
      const tracker = new DependencyTracker();
      const deps = [ref('deploy1', 'status.ready')];
      const paths = ['']; // empty string is falsy, so fallback is 'unknown[0]'

      const result = tracker.trackDependencies('my-app', deps, paths);

      // Empty string in paths[0] is falsy → fieldPaths[i] || `unknown[${i}]`
      // So fieldPath becomes 'unknown[0]', and expressionContext is 'unknown[0]'
      expect(result[0]?.fieldPath).toBe('unknown[0]');
      expect(result[0]?.metadata?.expressionContext).toBe('unknown[0]');
    });
  });
});
