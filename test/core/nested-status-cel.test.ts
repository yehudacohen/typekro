/**
 * Unit tests for nested-status-cel.ts
 *
 * Tests the extracted functions that handle CEL expression extraction from
 * inner composition status mappings. Each branch of the extraction logic
 * is tested independently.
 */

import { describe, expect, it } from 'bun:test';
import { KUBERNETES_REF_BRAND, CEL_EXPRESSION_BRAND } from '../../src/core/constants/brands.js';
import {
  buildNestedCompositionAliases,
  extractNestedStatusCel,
  remapVariableNames,
  recoverGarbledExpression,
} from '../../src/core/composition/nested-status-cel.js';

describe('remapVariableNames', () => {
  it('should pass through known resource IDs unchanged', () => {
    const result = remapVariableNames(
      'deployment.status.ready',
      ['deployment', 'service']
    );
    expect(result).toBe('deployment.status.ready');
  });

  it('should pass through schema references unchanged', () => {
    const result = remapVariableNames(
      'schema.spec.name',
      ['deployment']
    );
    expect(result).toBe('schema.spec.name');
  });

  it('should match by exact lowercase', () => {
    const result = remapVariableNames(
      'Deployment.status.ready',
      ['deployment']
    );
    expect(result).toBe('deployment.status.ready');
  });

  it('should use single resource when unambiguous', () => {
    const result = remapVariableNames(
      'd.status.ready',
      ['inngestHelmRelease']
    );
    expect(result).toBe('inngestHelmRelease.status.ready');
  });

  it('should match unambiguous camelCase prefix', () => {
    const result = remapVariableNames(
      'inngest.status.ready',
      ['inngestHelmRelease', 'namespace']
    );
    expect(result).toBe('inngestHelmRelease.status.ready');
  });

  it('should reject ambiguous prefix matches', () => {
    // Both 'cache' and 'cacheService' match prefix 'cache'
    const result = remapVariableNames(
      'cache.status.ready',
      ['cache', 'cacheService']
    );
    // 'cache' is an exact match (included in innerResourceIds), so it passes through
    expect(result).toBe('cache.status.ready');
  });

  it('should reject ambiguous prefix when no exact match', () => {
    // 'c' matches both 'cache' and 'cacheService' at camelCase boundary...
    // actually 'c' -> 'cache' starts with 'c' and cache[1] = 'a' (lowercase) — NOT a camelCase boundary
    // 'c' -> 'cacheService' starts with 'c' and cacheService[1] = 'a' (lowercase) — NOT a boundary
    // So neither matches the prefix rule, and the variable is left as-is
    const result = remapVariableNames(
      'c.status.ready',
      ['cache', 'cacheService']
    );
    expect(result).toBe('c.status.ready');
  });

  it('should handle metadata and spec sections', () => {
    const result = remapVariableNames(
      'd.metadata.name',
      ['deployment']
    );
    expect(result).toBe('deployment.metadata.name');
  });
});

describe('recoverGarbledExpression', () => {
  it('should pass through non-garbled expressions unchanged', () => {
    const result = recoverGarbledExpression(
      'deployment.status.ready',
      ['deployment']
    );
    expect(result).toBe('deployment.status.ready');
  });

  it('should extract status field from factory call source', () => {
    const result = recoverGarbledExpression(
      'Cel.expr(_helmRelease.status.conditions, ".exists(c, c.type == \\"Ready\\")")',
      ['inngestHelmRelease']
    );
    expect(result).toBe('inngestHelmRelease.status.conditions');
  });

  it('should extract status field from arrow function source', () => {
    const result = recoverGarbledExpression(
      '(() => d.status.readyReplicas >= 1)',
      ['deployment']
    );
    expect(result).toBe('deployment.status.readyReplicas');
  });

  it('should return undefined when no status reference found', () => {
    const result = recoverGarbledExpression(
      'new SomeClass({config: true})',
      ['deployment']
    );
    expect(result).toBeUndefined();
  });

  it('should map variable name to matching resource in multi-resource composition', () => {
    const result = recoverGarbledExpression(
      'Cel.expr(helmRelease.status.conditions, ".exists()")',
      ['inngestHelmRelease', 'inngestNamespace']
    );
    // 'helmRelease' doesn't start with 'inngestHelmRelease' — it's the other way around
    // So it falls through to innerResources[0]
    expect(result).toBe('inngestHelmRelease.status.conditions');
  });
});

describe('extractNestedStatusCel', () => {
  it('should extract CelExpression values', () => {
    const mappings: Record<string, string> = {};
    extractNestedStatusCel(
      {
        ready: { [CEL_EXPRESSION_BRAND]: true, expression: 'deployment.status.ready' },
      },
      {
        baseId: 'inner1',
        innerResourceIds: ['deployment'],
        registerMapping: (k, v) => { mappings[k] = v; },
      }
    );
    expect(mappings['__nestedStatus:inner1:ready']).toBe('deployment.status.ready');
  });

  it('should extract KubernetesRef values', () => {
    const mappings: Record<string, string> = {};
    extractNestedStatusCel(
      {
        ready: { [KUBERNETES_REF_BRAND]: true, resourceId: 'deployment', fieldPath: 'status.ready' },
      },
      {
        baseId: 'inner1',
        innerResourceIds: ['deployment'],
        registerMapping: (k, v) => { mappings[k] = v; },
      }
    );
    expect(mappings['__nestedStatus:inner1:ready']).toBe('deployment.status.ready');
  });

  it('should extract plain string values', () => {
    const mappings: Record<string, string> = {};
    extractNestedStatusCel(
      {
        version: 'schema.spec.version',
      },
      {
        baseId: 'inner1',
        innerResourceIds: ['deployment'],
        registerMapping: (k, v) => { mappings[k] = v; },
      }
    );
    expect(mappings['__nestedStatus:inner1:version']).toBe('schema.spec.version');
  });

  it('should skip internal fields', () => {
    const mappings: Record<string, string> = {};
    extractNestedStatusCel(
      {
        __internal: 'should-be-skipped',
        ready: 'deployment.status.ready',
      },
      {
        baseId: 'inner1',
        innerResourceIds: ['deployment'],
        registerMapping: (k, v) => { mappings[k] = v; },
      }
    );
    expect(Object.keys(mappings)).toEqual(['__nestedStatus:inner1:ready']);
  });

  it('should recurse into nested objects', () => {
    const mappings: Record<string, string> = {};
    extractNestedStatusCel(
      {
        components: {
          app: { [CEL_EXPRESSION_BRAND]: true, expression: 'app.status.ready' },
          db: { [CEL_EXPRESSION_BRAND]: true, expression: 'database.status.ready' },
        },
      },
      {
        baseId: 'inner1',
        innerResourceIds: ['app', 'database'],
        registerMapping: (k, v) => { mappings[k] = v; },
      }
    );
    expect(mappings['__nestedStatus:inner1:components.app']).toBe('app.status.ready');
    expect(mappings['__nestedStatus:inner1:components.db']).toBe('database.status.ready');
  });

  it('should fall back to Phase B for comparison artifacts', () => {
    const mappings: Record<string, string> = {};
    extractNestedStatusCel(
      {
        ready: false, // comparison artifact
      },
      {
        baseId: 'inner1',
        innerResourceIds: ['deployment'],
        registerMapping: (k, v) => { mappings[k] = v; },
      },
      '',
      {
        ready: { expression: 'deployment.status.readyReplicas >= 1' },
      }
    );
    expect(mappings['__nestedStatus:inner1:ready']).toBe('deployment.status.readyReplicas >= 1');
  });

  it('should use Phase B subtree when Phase A object is empty', () => {
    const mappings: Record<string, string> = {};
    extractNestedStatusCel(
      {
        metadata: {}, // empty — proxy values lost during serialization
      },
      {
        baseId: 'inner1',
        innerResourceIds: ['deployment'],
        registerMapping: (k, v) => { mappings[k] = v; },
      },
      '',
      {
        metadata: {
          name: { expression: 'deployment.metadata.name' },
        },
      }
    );
    expect(mappings['__nestedStatus:inner1:metadata.name']).toBe('deployment.metadata.name');
  });
});

describe('buildNestedCompositionAliases', () => {
  // Existing entries the inner composition has accumulated for one
  // nested call (`webAppWithProcessing` instance #1) with two status fields.
  const baseEntries: Record<string, string> = {
    '__nestedStatus:webAppWithProcessing1:url': 'http://example',
    '__nestedStatus:webAppWithProcessing1:ready': 'app.status.readyReplicas >= 1',
  };

  it('aliases a `const x = factory(...)` assignment to the matching baseId', () => {
    const source = `
      function composition(spec) {
        const stack = webAppWithProcessing({ name: spec.name });
        return { ready: stack.status.ready };
      }
    `;
    const aliases = buildNestedCompositionAliases(
      source,
      new Set(['webAppWithProcessing1']),
      baseEntries
    );
    expect(aliases['__nestedStatus:stack:url']).toBe('http://example');
    expect(aliases['__nestedStatus:stack:ready']).toBe('app.status.readyReplicas >= 1');
  });

  it('aliases comma-continuation declarations (Bun/esbuild minified shape)', () => {
    // After Bun's transform, multiple `const a = ..., b = ...` declarations
    // collapse onto one line. The regex must match `, stack = factory(`.
    const source = `(spec) => { const ns = "default", stack = webAppWithProcessing({ name: spec.name }); return { ready: stack.status.ready }; }`;
    const aliases = buildNestedCompositionAliases(
      source,
      new Set(['webAppWithProcessing1']),
      baseEntries
    );
    expect(aliases['__nestedStatus:stack:url']).toBe('http://example');
  });

  it('aliases `let` and `var` assignments in addition to `const`', () => {
    const letSource = `function f(spec) { let stack = webAppWithProcessing({}); return stack.status.ready; }`;
    const letAliases = buildNestedCompositionAliases(
      letSource,
      new Set(['webAppWithProcessing1']),
      baseEntries
    );
    expect(letAliases['__nestedStatus:stack:url']).toBe('http://example');

    const varSource = `function f(spec) { var stack = webAppWithProcessing({}); return stack.status.ready; }`;
    const varAliases = buildNestedCompositionAliases(
      varSource,
      new Set(['webAppWithProcessing1']),
      baseEntries
    );
    expect(varAliases['__nestedStatus:stack:url']).toBe('http://example');
  });

  it('skips ambiguous matches when the same factory is called twice', () => {
    // Two instances of the same composition produce two baseIds with
    // the same stem. The function can't disambiguate from source alone,
    // so it skips both var assignments and produces no aliases.
    const source = `(spec) => { const a = wap({}); const b = wap({}); return { x: a.status.url, y: b.status.url }; }`;
    const entries: Record<string, string> = {
      '__nestedStatus:wap1:url': 'http://a',
      '__nestedStatus:wap2:url': 'http://b',
    };
    const aliases = buildNestedCompositionAliases(
      source,
      new Set(['wap1', 'wap2']),
      entries
    );
    expect(Object.keys(aliases)).toHaveLength(0);
  });

  it('skips when the variable name is already a known baseId', () => {
    // Edge case: user named their local var the same as the composition
    // baseId. We don't shadow real entries.
    const source = `(spec) => { const webAppWithProcessing1 = webAppWithProcessing({}); return webAppWithProcessing1.status.ready; }`;
    const aliases = buildNestedCompositionAliases(
      source,
      new Set(['webAppWithProcessing1']),
      baseEntries
    );
    // No alias entries — the existing entries already cover this var name.
    expect(Object.keys(aliases)).toHaveLength(0);
  });

  it('skips destructuring assignments (known limitation)', () => {
    // const { ready } = factory() — the LHS isn't a bare identifier so
    // the regex doesn't match. Documented limitation.
    const source = `(spec) => { const { ready } = webAppWithProcessing({}); return ready; }`;
    const aliases = buildNestedCompositionAliases(
      source,
      new Set(['webAppWithProcessing1']),
      baseEntries
    );
    expect(Object.keys(aliases)).toHaveLength(0);
  });

  it('skips property assignments (e.g., `obj.foo = factory()`)', () => {
    // The LHS is a member expression, not a bare identifier. The regex
    // shouldn't match because the boundary character before the LHS is
    // a `.`, which fails the explicit guard.
    const source = `(spec) => { const obj = {}; obj.stack = webAppWithProcessing({}); return obj.stack.status.ready; }`;
    const aliases = buildNestedCompositionAliases(
      source,
      new Set(['webAppWithProcessing1']),
      baseEntries
    );
    expect(aliases['__nestedStatus:stack:url']).toBeUndefined();
  });

  it('returns empty when nestedCompositionIds is empty', () => {
    const aliases = buildNestedCompositionAliases(
      '(spec) => { const stack = wap({}); return {}; }',
      new Set(),
      baseEntries
    );
    expect(Object.keys(aliases)).toHaveLength(0);
  });

  it('returns empty when nestedCompositionIds is undefined', () => {
    const aliases = buildNestedCompositionAliases(
      '(spec) => { const stack = wap({}); return {}; }',
      undefined,
      baseEntries
    );
    expect(Object.keys(aliases)).toHaveLength(0);
  });

  it('returns empty when no factory call matches a known baseId stem', () => {
    // The composition source mentions `unrelated()` which isn't in
    // the baseId stem map.
    const source = `(spec) => { const x = unrelated({}); return {}; }`;
    const aliases = buildNestedCompositionAliases(
      source,
      new Set(['webAppWithProcessing1']),
      baseEntries
    );
    expect(Object.keys(aliases)).toHaveLength(0);
  });

  it('handles instance-suffix variations (factoryName matches baseId stem regardless of digits)', () => {
    // The baseId is `wap5` (not `wap1`) because of monotonic counter.
    // Source uses `wap()` — stem-stripping should still match.
    const source = `(spec) => { const stack = wap({}); return stack.status.url; }`;
    const entries: Record<string, string> = {
      '__nestedStatus:wap5:url': 'http://example',
    };
    const aliases = buildNestedCompositionAliases(source, new Set(['wap5']), entries);
    expect(aliases['__nestedStatus:stack:url']).toBe('http://example');
  });

  it('does not throw on malformed source', () => {
    // Garbage in — empty result out, no exception.
    const source = '!@#$%^&*()_+~`|}{[]:;<>,./?';
    expect(() =>
      buildNestedCompositionAliases(source, new Set(['webAppWithProcessing1']), baseEntries)
    ).not.toThrow();
  });
});
