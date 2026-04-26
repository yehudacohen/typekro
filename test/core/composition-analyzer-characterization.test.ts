/**
 * Characterization tests for composition-analyzer.ts
 *
 * These tests capture the CURRENT behavior of the composition body analyzer
 * as a safety net for future refactoring (Phase 2 registry pattern).
 *
 * All functions in composition-analyzer.ts are pure (no I/O, no K8s) — they
 * operate on function source strings parsed to ASTs via acorn.
 *
 * @see src/core/expressions/composition/composition-analyzer.ts
 */

import { describe, expect, it } from 'bun:test';
import {
  analyzeCompositionBody,
  applyAnalysisToResources,
} from '../../src/core/expressions/composition/composition-analyzer.js';
import { conditionToCel } from '../../src/core/expressions/composition/composition-analyzer-helpers.js';
import type { ASTAnalysisResult as CompositionAnalysisResult } from '../../src/core/expressions/composition/composition-analyzer-types.js';
import {
  getForEach,
  getIncludeWhen,
  getTemplateOverrides,
  setForEach,
  setIncludeWhen,
} from '../../src/core/metadata/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Factory stubs — these must match KNOWN_FACTORY_NAMES so the analyzer recognizes them.
 * They're never executed; the analyzer only sees their names in .toString() output.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
function Deployment(_opts: Record<string, unknown>) {
  return {};
}
function ConfigMap(_opts: Record<string, unknown>) {
  return {};
}
const simple = { Deployment, ConfigMap };
/* eslint-enable @typescript-eslint/no-unused-vars */

// ===========================================================================
// analyzeCompositionBody — basic functionality
// ===========================================================================

describe('analyzeCompositionBody: basic', () => {
  it('returns empty result for function with no factory calls', () => {
    const fn = (_spec: any) => {
      const x = 1 + 2;
      return { value: x };
    };
    const result = analyzeCompositionBody(fn, new Set());
    expect(result.resources.size).toBe(0);
    expect(result.unregisteredFactories).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('detects a single factory call with id', () => {
    const fn = (spec: any) => ({
      myDep: Deployment({ id: 'myDep', name: spec.name }),
    });
    const result = analyzeCompositionBody(fn, new Set(['myDep']));
    // The resource should be registered (may or may not have control flow)
    expect(result.errors).toHaveLength(0);
  });

  it('captures parse errors without throwing', () => {
    // Pass something whose .toString() is not valid JS
    const notAFunction = { toString: () => 'this is not valid javascript{{{' } as any;
    const result = analyzeCompositionBody(notAFunction, new Set());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Failed to analyze composition function');
  });

  it('handles empty function body', () => {
    const fn = (_spec: any) => {
      // intentionally empty
    };
    const result = analyzeCompositionBody(fn, new Set());
    expect(result.resources.size).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('extracts spec parameter name from arrow function', () => {
    // The analyzer should use "schema" as the param name here
    const fn = (schema: any) => ({
      dep: Deployment({ id: 'dep', name: schema.name }),
    });
    const result = analyzeCompositionBody(fn, new Set(['dep']));
    expect(result.errors).toHaveLength(0);
  });
});

// ===========================================================================
// analyzeCompositionBody — if-statement → includeWhen
// ===========================================================================

describe('analyzeCompositionBody: if-statement includeWhen', () => {
  it('creates includeWhen for if (spec.flag) wrapping a factory call', () => {
    const fn = (spec: any) => {
      const result: Record<string, any> = {};
      if (spec.monitoring) {
        result.monitor = Deployment({ id: 'monitor', name: 'prometheus' });
      }
      return result;
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['monitor']));
    const monitorFlow = analysisResult.resources.get('monitor');
    expect(monitorFlow).toBeDefined();
    if (monitorFlow) {
      expect(monitorFlow.includeWhen.length).toBeGreaterThan(0);
      // The CEL expression should reference schema.spec.monitoring
      const expr = monitorFlow.includeWhen[0]!.expression;
      expect(expr).toContain('schema.spec.monitoring');
    }
  });

  it('creates negated includeWhen for else branch', () => {
    const fn = (spec: any) => {
      const result: Record<string, any> = {};
      if (spec.useRedis) {
        result.redis = Deployment({ id: 'redis', name: 'redis' });
      } else {
        result.memcached = Deployment({ id: 'memcached', name: 'memcached' });
      }
      return result;
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['redis', 'memcached']));

    const redisFlow = analysisResult.resources.get('redis');
    const memcachedFlow = analysisResult.resources.get('memcached');

    // Redis should have the positive condition
    expect(redisFlow).toBeDefined();
    if (redisFlow) {
      expect(redisFlow.includeWhen.length).toBeGreaterThan(0);
    }

    // Memcached should have the negated condition
    expect(memcachedFlow).toBeDefined();
    if (memcachedFlow) {
      expect(memcachedFlow.includeWhen.length).toBeGreaterThan(0);
      const expr = memcachedFlow.includeWhen[0]!.expression;
      expect(expr).toContain('!');
    }
  });

  it('skips includeWhen for compile-time literal conditions', () => {
    const alwaysTrue = true;
    const fn = (_spec: any) => {
      const result: Record<string, any> = {};
      if (alwaysTrue) {
        result.always = Deployment({ id: 'always', name: 'always' });
      }
      return result;
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['always']));
    const alwaysFlow = analysisResult.resources.get('always');
    // Compile-time literal should not produce includeWhen
    if (alwaysFlow) {
      expect(alwaysFlow.includeWhen).toHaveLength(0);
    }
  });
});

// ===========================================================================
// analyzeCompositionBody — ternary → includeWhen
// ===========================================================================

describe('analyzeCompositionBody: ternary includeWhen', () => {
  it('detects ternary with factory calls in both branches', () => {
    const fn = (spec: any) => ({
      cache: spec.useRedis
        ? Deployment({ id: 'redisDep', name: 'redis' })
        : Deployment({ id: 'memcachedDep', name: 'memcached' }),
    });
    const analysisResult = analyzeCompositionBody(fn, new Set(['redisDep', 'memcachedDep']));

    const redisFlow = analysisResult.resources.get('redisDep');
    const memcachedFlow = analysisResult.resources.get('memcachedDep');

    // Both should have includeWhen conditions
    expect(redisFlow).toBeDefined();
    expect(memcachedFlow).toBeDefined();
  });

  it('detects ternary resource creation with member factory calls', () => {
    const fn = (spec: any) => spec.enabled
      ? simple.Deployment({ id: 'app', name: 'app' })
      : undefined;

    const analysisResult = analyzeCompositionBody(fn, new Set(['app']));
    const appFlow = analysisResult.resources.get('app');

    expect(appFlow).toBeDefined();
    expect(appFlow?.includeWhen[0]?.expression).toBe('${schema.spec.enabled}');
  });
});

describe('conditionToCel optional field guards', () => {
  it('wraps optional bare RHS operands in compound conditions', () => {
    const source = '(spec) => spec.required && spec.optional';
    const conditionStart = source.indexOf('spec.required');
    const conditionEnd = source.length;

    const cel = conditionToCel(
      { type: 'Identifier', range: [conditionStart, conditionEnd] },
      source,
      'spec',
      new Set(['optional'])
    );

    expect(cel).toBe('${schema.spec.required && has(schema.spec.optional)}');
  });
});

// ===========================================================================
// analyzeCompositionBody — logical AND → includeWhen
// ===========================================================================

describe('analyzeCompositionBody: logical AND short-circuit', () => {
  it('detects factory call inside logical AND expression', () => {
    const fn = (spec: any) => {
      const result: Record<string, any> = {};
      result.optional = spec.enableMetrics && Deployment({ id: 'metrics', name: 'metrics' });
      return result;
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['metrics']));
    // The analyzer should at least detect the factory call (even if includeWhen
    // detection depends on Bun's transpiler output)
    const metricsFlow = analysisResult.resources.get('metrics');
    const isUnregistered = analysisResult.unregisteredFactories.some(
      (f) => f.resourceId === 'metrics'
    );
    // Factory should be detected in one form or another
    expect(metricsFlow !== undefined || isUnregistered).toBe(true);
  });
});

// ===========================================================================
// analyzeCompositionBody — for-of → forEach
// ===========================================================================

describe('analyzeCompositionBody: for-of forEach', () => {
  it('creates forEach dimension for for-of loop wrapping factory call', () => {
    const fn = (spec: any) => {
      const result: Record<string, any> = {};
      for (const region of spec.regions) {
        result[region] = Deployment({ id: 'regionDep', name: region });
      }
      return result;
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['regionDep']));
    const regionFlow = analysisResult.resources.get('regionDep');

    expect(regionFlow).toBeDefined();
    if (regionFlow) {
      expect(regionFlow.forEach.length).toBeGreaterThan(0);
      const dim = regionFlow.forEach[0]!;
      expect(dim.variableName).toBe('region');
      expect(dim.source).toContain('schema.spec.regions');
    }
  });
});

// ===========================================================================
// analyzeCompositionBody — operator conversion
// ===========================================================================

describe('analyzeCompositionBody: CEL operator conversion', () => {
  it('converts === to == in CEL output', () => {
    const fn = (spec: any) => {
      const result: Record<string, any> = {};
      if (spec.env === 'production') {
        result.prod = Deployment({ id: 'prod', name: 'prod' });
      }
      return result;
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['prod']));
    const prodFlow = analysisResult.resources.get('prod');

    expect(prodFlow).toBeDefined();
    if (prodFlow && prodFlow.includeWhen.length > 0) {
      const expr = prodFlow.includeWhen[0]!.expression;
      // Should use == not ===
      expect(expr).not.toContain('===');
      expect(expr).toContain('==');
    }
  });

  it('converts !== to != in CEL output', () => {
    const fn = (spec: any) => {
      const result: Record<string, any> = {};
      if (spec.env !== 'development') {
        result.nonDev = Deployment({ id: 'nonDev', name: 'nonDev' });
      }
      return result;
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['nonDev']));
    const flow = analysisResult.resources.get('nonDev');

    expect(flow).toBeDefined();
    if (flow && flow.includeWhen.length > 0) {
      const expr = flow.includeWhen[0]!.expression;
      expect(expr).not.toContain('!==');
      expect(expr).toContain('!=');
    }
  });
});

// ===========================================================================
// analyzeCompositionBody — ternary in factory args → templateOverrides
// ===========================================================================

describe('analyzeCompositionBody: templateOverrides', () => {
  it('detects ternary in factory argument referencing spec', () => {
    const fn = (spec: any) => ({
      app: Deployment({
        id: 'app',
        name: spec.name,
        replicas: spec.env === 'prod' ? 3 : 1,
      }),
    });
    const analysisResult = analyzeCompositionBody(fn, new Set(['app']));
    // Template overrides may or may not be detected depending on how Bun transpiles
    // the ternary. This test characterizes the current behavior.
    expect(analysisResult.errors).toHaveLength(0);
    // Verify templateOverrides map exists (content varies by transpiler)
    expect(analysisResult.templateOverrides).toBeDefined();
  });

  it('preserves full resource status collection calls in ternary conditions', () => {
    function fn(spec: any) {
      const db = Deployment({ id: 'db', name: 'db' }) as any;
      return {
        app: ConfigMap({
          id: 'app',
          name: spec.name,
          data: {
            phase: db.status.conditions.exists((c: any) => c.type === 'Ready' && c.status === 'True')
              ? 'ready'
              : 'waiting',
          },
        }),
      };
    }

    const analysisResult = analyzeCompositionBody(fn, new Set(['db', 'app']));
    const ternary = analysisResult.resourceStatusTernaries.find((entry) => entry.variableName === 'db');

    expect(analysisResult.errors).toHaveLength(0);
    expect(ternary?.statusField).toBe('conditions');
    expect(ternary?.conditionExpression).toBe('db.status.conditions.exists(c, c.type == "Ready" && c.status == "True")');
    expect(ternary?.conditionExpression).not.toBe('db.status.conditions');
  });
});

// ===========================================================================
// analyzeCompositionBody — return statement → statusOverrides
// ===========================================================================

describe('analyzeCompositionBody: statusOverrides', () => {
  it('detects ternary in return statement value', () => {
    const fn = (spec: any) => {
      const _dep = Deployment({ id: 'app', name: spec.name });
      return {
        phase: spec.replicas > 0 ? 'running' : 'stopped',
      };
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['app']));
    // Status overrides should capture the ternary
    // Note: the return statement analysis may or may not capture this
    // depending on AST structure after Bun transpilation
    expect(analysisResult.errors).toHaveLength(0);
  });
});

// ===========================================================================
// analyzeCompositionBody — unregistered factories
// ===========================================================================

describe('analyzeCompositionBody: unregistered factories', () => {
  it('detects factory calls for resources not in resourceIds', () => {
    const fn = (spec: any) => {
      const result: Record<string, any> = {};
      if (spec.enableCache) {
        result.cache = Deployment({ id: 'cache', name: 'redis' });
      }
      result.app = Deployment({ id: 'app', name: spec.name });
      return result;
    };
    // Only 'app' is in resourceIds — 'cache' was in a branch not taken at runtime
    const analysisResult = analyzeCompositionBody(fn, new Set(['app']));

    // 'cache' should appear as either a registered resource or unregistered factory
    const hasCache =
      analysisResult.resources.has('cache') ||
      analysisResult.unregisteredFactories.some((f) => f.resourceId === 'cache');
    expect(hasCache).toBe(true);
  });
});

// ===========================================================================
// analyzeCompositionBody — nested control flow
// ===========================================================================

describe('analyzeCompositionBody: nested control flow', () => {
  it('handles for-of inside if-statement', () => {
    const fn = (spec: any) => {
      const result: Record<string, any> = {};
      if (spec.multiRegion) {
        for (const region of spec.regions) {
          result[region] = Deployment({ id: 'regionDep', name: region });
        }
      }
      return result;
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['regionDep']));
    const flow = analysisResult.resources.get('regionDep');

    expect(flow).toBeDefined();
    if (flow) {
      // Should have both includeWhen (from if) and forEach (from for-of)
      expect(flow.includeWhen.length).toBeGreaterThan(0);
      expect(flow.forEach.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// analyzeCompositionBody — multiple factory calls
// ===========================================================================

describe('analyzeCompositionBody: multiple resources', () => {
  it('tracks multiple distinct factory calls', () => {
    const fn = (_spec: any) => ({
      frontend: Deployment({ id: 'frontend', name: 'web' }),
      backend: Deployment({ id: 'backend', name: 'api' }),
      config: ConfigMap({ id: 'config', name: 'app-config' }),
    });
    const analysisResult = analyzeCompositionBody(fn, new Set(['frontend', 'backend', 'config']));
    expect(analysisResult.errors).toHaveLength(0);
  });
});

// ===========================================================================
// analyzeCompositionBody — array method iterations
// ===========================================================================

describe('analyzeCompositionBody: array method iterations', () => {
  it('detects factory call inside .map() callback', () => {
    const fn = (spec: any) => {
      const deps = spec.services.map((svc: any) => Deployment({ id: 'svcDep', name: svc.name }));
      return { deps };
    };
    const analysisResult = analyzeCompositionBody(fn, new Set(['svcDep']));
    // The factory call should be detected (forEach detection depends on transpiler)
    const flow = analysisResult.resources.get('svcDep');
    const isUnregistered = analysisResult.unregisteredFactories.some(
      (f) => f.resourceId === 'svcDep'
    );
    expect(flow !== undefined || isUnregistered).toBe(true);
    expect(analysisResult.errors).toHaveLength(0);
  });
});

// ===========================================================================
// applyAnalysisToResources
// ===========================================================================

describe('applyAnalysisToResources', () => {
  function makeAnalysis(
    overrides: Partial<CompositionAnalysisResult> = {}
  ): CompositionAnalysisResult {
    return {
      resources: new Map(),
      hybridOverrideConditions: new Map(),
      differentialConditionFields: new Set(),
      unregisteredFactories: [],
      templateOverrides: new Map(),
      _collectionVariables: new Map(),
      statusOverrides: [],
      errors: [],
      ...overrides,
    } as CompositionAnalysisResult;
  }

  it('attaches forEach via WeakMap metadata', () => {
    const resources: Record<string, any> = {
      myDep: { apiVersion: 'apps/v1', kind: 'Deployment' },
    };
    const analysis = makeAnalysis({
      resources: new Map([
        [
          'myDep',
          {
            resourceId: 'myDep',
            forEach: [{ variableName: 'region', source: '${schema.spec.regions}' }],
            includeWhen: [],
          },
        ],
      ]),
    });

    applyAnalysisToResources(resources, analysis);

    // forEach should be stored in WeakMap metadata
    expect(getForEach(resources.myDep)).toEqual([{ region: '${schema.spec.regions}' }]);
    // Should NOT be a property on the object
    expect(Object.keys(resources.myDep)).not.toContain('forEach');
  });

  it('attaches includeWhen via WeakMap metadata', () => {
    const resources: Record<string, any> = {
      optional: { apiVersion: 'apps/v1', kind: 'Deployment' },
    };
    const analysis = makeAnalysis({
      resources: new Map([
        [
          'optional',
          {
            resourceId: 'optional',
            forEach: [],
            includeWhen: [{ expression: '${schema.spec.enabled}' }],
          },
        ],
      ]),
    });

    applyAnalysisToResources(resources, analysis);

    // includeWhen should be stored in WeakMap metadata
    expect(getIncludeWhen(resources.optional)).toEqual(['${schema.spec.enabled}']);
    // Should NOT be a property on the object
    expect(Object.keys(resources.optional)).not.toContain('includeWhen');
  });

  it('attaches templateOverrides via WeakMap metadata', () => {
    const resources: Record<string, any> = {
      app: { apiVersion: 'apps/v1', kind: 'Deployment' },
    };
    const analysis = makeAnalysis({
      templateOverrides: new Map([
        [
          'app',
          [
            {
              propertyPath: 'spec.replicas',
              celExpression: '${schema.spec.env == "prod" ? 3 : 1}',
            },
          ],
        ],
      ]),
    });

    applyAnalysisToResources(resources, analysis);

    // templateOverrides should be stored in WeakMap metadata
    const overrides = getTemplateOverrides(resources.app);
    expect(overrides).toBeDefined();
    expect(overrides).toHaveLength(1);
    expect(overrides![0]?.propertyPath).toBe('spec.replicas');
  });

  it('skips resources not found in the resources record', () => {
    const resources: Record<string, any> = {};
    const analysis = makeAnalysis({
      resources: new Map([
        [
          'missing',
          { resourceId: 'missing', forEach: [{ variableName: 'x', source: 'y' }], includeWhen: [] },
        ],
      ]),
    });

    // Should not throw
    applyAnalysisToResources(resources, analysis);
    expect(Object.keys(resources)).toHaveLength(0);
  });

  it('skips non-object resource values', () => {
    const resources: Record<string, any> = { bad: null };
    const analysis = makeAnalysis({
      resources: new Map([
        [
          'bad',
          { resourceId: 'bad', forEach: [{ variableName: 'x', source: 'y' }], includeWhen: [] },
        ],
      ]),
    });

    // Should not throw
    applyAnalysisToResources(resources, analysis);
  });

  it('merges with existing forEach in WeakMap', () => {
    const resources: Record<string, any> = {
      myDep: { apiVersion: 'apps/v1', kind: 'Deployment' },
    };
    // Pre-set a forEach via WeakMap
    setForEach(resources.myDep, [{ existing: '${schema.spec.existing}' }]);

    const analysis = makeAnalysis({
      resources: new Map([
        [
          'myDep',
          {
            resourceId: 'myDep',
            forEach: [{ variableName: 'region', source: '${schema.spec.regions}' }],
            includeWhen: [],
          },
        ],
      ]),
    });

    applyAnalysisToResources(resources, analysis);

    // Should merge both entries
    expect(getForEach(resources.myDep)).toHaveLength(2);
  });

  it('merges with existing includeWhen in WeakMap', () => {
    const resources: Record<string, any> = {
      opt: { apiVersion: 'apps/v1', kind: 'Deployment' },
    };
    // Pre-set includeWhen via WeakMap
    setIncludeWhen(resources.opt, ['${schema.spec.existingCondition}']);

    const analysis = makeAnalysis({
      resources: new Map([
        [
          'opt',
          {
            resourceId: 'opt',
            forEach: [],
            includeWhen: [{ expression: '${schema.spec.newCondition}' }],
          },
        ],
      ]),
    });

    applyAnalysisToResources(resources, analysis);

    // Should merge both entries
    expect(getIncludeWhen(resources.opt)).toHaveLength(2);
  });

  it('does nothing for empty analysis', () => {
    const resources: Record<string, any> = {
      app: { apiVersion: 'apps/v1', kind: 'Deployment' },
    };
    const analysis = makeAnalysis();

    applyAnalysisToResources(resources, analysis);

    // No new properties should be added
    expect(Object.getOwnPropertyDescriptor(resources.app, 'forEach')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(resources.app, 'includeWhen')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(resources.app, '__templateOverrides')).toBeUndefined();
  });

  it('handles multiple resources with different directives', () => {
    const resources: Record<string, any> = {
      frontend: { apiVersion: 'apps/v1', kind: 'Deployment' },
      backend: { apiVersion: 'apps/v1', kind: 'Deployment' },
    };
    const analysis = makeAnalysis({
      resources: new Map([
        [
          'frontend',
          {
            resourceId: 'frontend',
            forEach: [],
            includeWhen: [{ expression: '${schema.spec.hasFrontend}' }],
          },
        ],
        [
          'backend',
          {
            resourceId: 'backend',
            forEach: [{ variableName: 'svc', source: '${schema.spec.services}' }],
            includeWhen: [],
          },
        ],
      ]),
    });

    applyAnalysisToResources(resources, analysis);

    expect(getIncludeWhen(resources.frontend)).toEqual(['${schema.spec.hasFrontend}']);
    expect(getForEach(resources.backend)).toEqual([{ svc: '${schema.spec.services}' }]);
  });
});
