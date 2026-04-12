/**
 * TDD tests for resource-status ternary compilation + dependsOn API.
 *
 * These tests define the EXPECTED behavior for 4 phases:
 *   Phase 1: dependsOn + Cel.cond
 *   Phase 2: Detection infrastructure
 *   Phase 3: Direct factory ternary compilation
 *   Phase 4: Cross-composition ternary compilation
 *
 * All tests should FAIL initially and pass as the features are implemented.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

// =============================================================================
// Phase 1: dependsOn + Cel.cond
// =============================================================================

describe('Phase 1: dependsOn API', () => {
  it('dependsOn on a direct Enhanced resource emits readyWhen in KRO YAML', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'depends-on-test', kind: 'DependsOnTest', spec: Spec, status: Status },
      (spec) => {
        const db = simple.Deployment({
          name: 'db',
          image: 'postgres:16',
          id: 'database',
        });

        const app = simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
        });

        // app should wait for database to be ready
        app.dependsOn(db);

        return { ready: app.status.readyReplicas >= 1 };
      }
    );

    const yaml = comp.toYaml();
    // The app resource should have a readyWhen referencing database
    expect(yaml).toContain('readyWhen');
    expect(yaml).toContain('database.status');
  });

  it('dependsOn on a NestedCompositionResource emits readyWhen on inner resources', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const InnerSpec = type({ name: 'string', image: 'string' });
    const InnerStatus = type({ ready: 'boolean' });

    const innerComp = kubernetesComposition(
      { name: 'inner', kind: 'Inner', spec: InnerSpec, status: InnerStatus },
      (spec) => {
        simple.Deployment({ name: spec.name, image: spec.image, id: 'innerDep' });
        return { ready: true };
      }
    );

    const OuterSpec = type({ name: 'string', image: 'string' });
    const OuterStatus = type({ ready: 'boolean' });

    const outerComp = kubernetesComposition(
      { name: 'outer', kind: 'Outer', spec: OuterSpec, status: OuterStatus },
      (spec) => {
        const cache = simple.Deployment({
          name: 'cache',
          image: 'valkey:latest',
          id: 'cache',
        });

        const inner = innerComp({ name: spec.name, image: spec.image });

        // inner composition's resources should wait for cache
        inner.dependsOn(cache);

        return { ready: true };
      }
    );

    const yaml = outerComp.toYaml();
    expect(yaml).toContain('readyWhen');
    expect(yaml).toContain('cache.status');
  });

  it('multiple dependsOn calls accumulate', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'multi-dep', kind: 'MultiDep', spec: Spec, status: Status },
      (spec) => {
        const db = simple.Deployment({ name: 'db', image: 'postgres', id: 'database' });
        const cache = simple.Deployment({ name: 'cache', image: 'valkey', id: 'cache' });
        const app = simple.Deployment({ name: 'app', image: spec.image, id: 'app' });

        app.dependsOn(db);
        app.dependsOn(cache);

        return { ready: app.status.readyReplicas >= 1 };
      }
    );

    const yaml = comp.toYaml();
    expect(yaml).toContain('database.status');
    expect(yaml).toContain('cache.status');
  });

  it('dependsOn does not apply readyWhen to ALL merged inner resources', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');
    const { namespace } = await import(
      '../../src/factories/kubernetes/core/namespace.js'
    );

    const InnerSpec = type({ name: 'string' });
    const InnerStatus = type({ ready: 'boolean' });

    const innerComp = kubernetesComposition(
      { name: 'multi-res', kind: 'MultiRes', spec: InnerSpec, status: InnerStatus },
      (spec) => {
        namespace({
          metadata: { name: `${spec.name}-ns` },
          id: 'innerNs',
        });
        simple.Deployment({
          name: spec.name,
          image: 'nginx',
          id: 'innerApp',
        });
        return { ready: true };
      }
    );

    const OuterSpec = type({ name: 'string' });
    const OuterStatus = type({ ready: 'boolean' });

    const outerComp = kubernetesComposition(
      { name: 'selective', kind: 'Selective', spec: OuterSpec, status: OuterStatus },
      (spec) => {
        const cache = simple.Deployment({ name: 'cache', image: 'valkey', id: 'cache' });
        const inner = innerComp({ name: spec.name });
        inner.dependsOn(cache);
        return { ready: true };
      }
    );

    const yaml = outerComp.toYaml();
    // The namespace resource should NOT have readyWhen
    // (it doesn't need to wait for cache)
    const lines = yaml.split('\n');
    const nsSection = findResourceSection(lines, 'innerNs');
    expect(nsSection).not.toContain('readyWhen');
  });
});

describe('Phase 1: Cel.cond', () => {
  it('produces a CEL ternary with resource status ref as condition', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');
    const { Cel } = await import('../../src/core/references/cel.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'cel-cond', kind: 'CelCond', spec: Spec, status: Status },
      (spec) => {
        const cache = simple.Deployment({ name: 'cache', image: 'valkey', id: 'cache' });

        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          env: {
            CACHE_MODE: Cel.cond(cache.status.ready, 'redis', 'memory'),
          },
        });

        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    // Should contain a CEL ternary referencing cache.status.ready.
    // YAML escapes inner quotes, so the actual text is:
    // ${cache.status.ready ? \"redis\" : \"memory\"}
    expect(yaml).toContain('cache.status.ready');
    expect(yaml).toContain('redis');
    expect(yaml).toContain('memory');
    expect(yaml).toMatch(/cache\.status\.ready\s*\?/);
  });

  it('Cel.cond handles marker strings in consequent', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');
    const { Cel } = await import('../../src/core/references/cel.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'cel-marker', kind: 'CelMarker', spec: Spec, status: Status },
      (spec) => {
        const cache = simple.Deployment({ name: 'cache', image: 'valkey', id: 'cache' });

        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          env: {
            REDIS_URL: Cel.cond(
              cache.status.ready,
              `redis://${cache.metadata.name}:6379`,
              ''
            ),
          },
        });

        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    // cache.status.ready should appear as the condition
    expect(yaml).toContain('cache.status.ready');
    // The consequent should contain the redis URL
    expect(yaml).toContain('redis://');
    expect(yaml).toContain(':6379');
  });
});

// =============================================================================
// Phase 2: Detection infrastructure
// =============================================================================

describe('Phase 2: referencesResourceStatus', () => {
  it('detects cache.status.ready as a resource status ref', async () => {
    const { extractResourceStatusRef } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );
    const { Parser } = await import('acorn');

    const source = '(spec) => cache.status.ready';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal
    const body = (ast as any).body[0].expression.body;

    const ref = extractResourceStatusRef(body, 'spec');
    expect(ref).toBeDefined();
    expect(ref!.variableName).toBe('cache');
    expect(ref!.statusField).toBe('ready');
  });

  it('rejects spec.cache.status as a spec ref', async () => {
    const { extractResourceStatusRef } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );
    const { Parser } = await import('acorn');

    const source = '(spec) => spec.cache.status.ready';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal
    const body = (ast as any).body[0].expression.body;

    const ref = extractResourceStatusRef(body, 'spec');
    expect(ref).toBeUndefined();
  });

  it('rejects globals like console.status.something', async () => {
    const { extractResourceStatusRef } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );
    const { Parser } = await import('acorn');

    const source = '(spec) => console.status.ready';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal
    const body = (ast as any).body[0].expression.body;

    const ref = extractResourceStatusRef(body, 'spec');
    expect(ref).toBeUndefined();
  });

  it('detects resource status ref inside logical expression', async () => {
    const { extractResourceStatusRef } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );
    const { Parser } = await import('acorn');

    const source = '(spec) => cache.status.ready && db.status.instances >= 1';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal
    const body = (ast as any).body[0].expression.body;

    const ref = extractResourceStatusRef(body, 'spec');
    expect(ref).toBeDefined();
    expect(ref!.variableName).toBe('cache');
  });
});

describe('Phase 2: ResourceStatusTernary detection', () => {
  it('detects resource-status ternary in composition source', async () => {
    const { analyzeCompositionBody } = await import(
      '../../src/core/expressions/composition/composition-analyzer.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    // The analyzer parses fn.toString() and scans factory call arguments
    // for ConditionalExpression nodes. The ternary must be inside an
    // object literal argument to a factory call (e.g., simple.Deployment).
    const fn = (spec: { name: string; image: string }) => {
      // biome-ignore lint/correctness/noUnusedVariables: needed in fn body for analyzer source parsing
      const cache = { status: { ready: true } };
      simple.ConfigMap({
        name: spec.name,
        data: { mode: cache.status.ready ? 'redis' : 'memory' },
        id: 'cfg',
      });
      return { ready: true };
    };

    const result = analyzeCompositionBody(
      fn as (...args: unknown[]) => unknown,
      new Set(['cache', 'cfg']),
      new Set()
    );

    expect(result.resourceStatusTernaries).toBeDefined();
    expect(Array.isArray(result.resourceStatusTernaries)).toBe(true);
    // Exactly one resource-status ternary (cache.status.ready ? ... : ...)
    expect(result.resourceStatusTernaries.length).toBe(1);
    const ternary = result.resourceStatusTernaries[0]!;
    expect(ternary.variableName).toBe('cache');
    expect(ternary.statusField).toBe('ready');
  });
});

describe('Phase 2: Variable-to-resource-ID mapping', () => {
  it('maps variable name to resource ID from factory call with explicit id', async () => {
    const { analyzeCompositionBody } = await import(
      '../../src/core/expressions/composition/composition-analyzer.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const fn = (spec: { name: string }) => {
      const myCache = simple.Deployment({
        name: 'cache',
        image: 'valkey',
        id: 'cacheResource',
      });
      return { ready: true };
    };

    const result = analyzeCompositionBody(
      fn as (...args: unknown[]) => unknown,
      new Set(['cacheResource']),
      new Set()
    );

    // The analyzer should have a variable map with myCache → cacheResource
    // (This requires a new field on ASTAnalysisResult)
    expect(result).toHaveProperty('variableToResourceId');
    const varMap = (result as Record<string, unknown>).variableToResourceId as
      | Map<string, string>
      | undefined;
    expect(varMap).toBeDefined();
    expect(varMap?.get('myCache')).toBe('cacheResource');
  });
});

// =============================================================================
// Phase 3: Direct factory ternary compilation
// =============================================================================

describe('Phase 3: Direct factory ternary compilation', () => {
  it('resource-status ternary in direct factory arg produces CEL conditional', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'direct-ternary', kind: 'DirectTernary', spec: Spec, status: Status },
      (spec) => {
        const cache = simple.Deployment({
          name: 'cache',
          image: 'valkey',
          id: 'cache',
        });

        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          env: {
            CACHE_MODE: cache.status.ready ? 'redis' : 'memory',
          },
        });

        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    // The CACHE_MODE env var should have a CEL conditional
    expect(yaml).toContain('cache.status');
    expect(yaml).toMatch(/CACHE_MODE.*cache\.status/s);
    // Should NOT contain the collapsed JS-runtime value 'redis'
    // as a plain string — it should be inside a conditional
    const lines = yaml.split('\n');
    const cacheModeLines = lines.filter((l) => l.includes('CACHE_MODE'));
    for (const line of cacheModeLines) {
      // The line should have a ternary, not just 'redis'
      if (line.includes('redis') && !line.includes('?')) {
        throw new Error(
          `CACHE_MODE should be a CEL conditional, not a plain value: ${line.trim()}`
        );
      }
    }
  });

  it('only the targeted property gets conditionalized, not siblings', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'targeted', kind: 'Targeted', spec: Spec, status: Status },
      (spec) => {
        const cache = simple.Deployment({
          name: 'cache',
          image: 'valkey',
          id: 'cache',
        });

        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          env: {
            // This IS a resource-status ternary → should be conditionalized
            CACHE_MODE: cache.status.ready ? 'redis' : 'memory',
            // This is a plain value → should NOT be conditionalized
            APP_NAME: 'my-app',
          },
        });

        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    // APP_NAME should be a plain value, not wrapped in a conditional
    expect(yaml).toContain('value: my-app');
    expect(yaml).not.toMatch(/APP_NAME[\s\S]*cache\.status/);
    // CACHE_MODE should have a CEL conditional
    expect(yaml).toContain('cache.status.ready');
  });
});

// =============================================================================
// Phase 4: Cross-composition ternary compilation
// =============================================================================

describe('Phase 4: Cross-composition dependency ordering', () => {
  it('dependsOn produces readyWhen on inner resource for cross-composition ordering', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const InnerSpec = type({
      name: 'string',
      image: 'string',
      redisUrl: 'string',
    });
    const InnerStatus = type({ ready: 'boolean' });

    const innerComp = kubernetesComposition(
      { name: 'inner-redis', kind: 'InnerRedis', spec: InnerSpec, status: InnerStatus },
      (spec) => {
        simple.Deployment({
          name: spec.name,
          image: spec.image,
          id: 'innerApp',
          env: {
            REDIS_URL: spec.redisUrl,
          },
        });
        return { ready: true };
      }
    );

    const OuterSpec = type({ name: 'string', image: 'string' });
    const OuterStatus = type({ ready: 'boolean' });

    const outerComp = kubernetesComposition(
      { name: 'outer-redis', kind: 'OuterRedis', spec: OuterSpec, status: OuterStatus },
      (spec) => {
        const cache = simple.Deployment({
          name: 'cache',
          image: 'valkey',
          id: 'cache',
        });

        const inner = innerComp({
          name: spec.name,
          image: spec.image,
          redisUrl: `redis://${cache.metadata.name}:6379`,
        });

        // Use dependsOn for cross-composition ordering
        inner.dependsOn(cache);

        return { ready: true };
      }
    );

    const yaml = outerComp.toYaml();
    // The inner composition should have readyWhen from dependsOn
    expect(yaml).toContain('readyWhen');
    expect(yaml).toContain('cache.status.ready');
  });

  it('outer resources are NOT affected by inner composition ternary', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const InnerSpec = type({ name: 'string', val: 'string' });
    const InnerStatus = type({ ready: 'boolean' });

    const innerComp = kubernetesComposition(
      { name: 'inner-val', kind: 'InnerVal', spec: InnerSpec, status: InnerStatus },
      (spec) => {
        simple.Deployment({ name: spec.name, image: 'nginx', id: 'innerDep', env: { VAL: spec.val } });
        return { ready: true };
      }
    );

    const OuterSpec = type({ name: 'string', image: 'string' });
    const OuterStatus = type({ ready: 'boolean' });

    const outerComp = kubernetesComposition(
      { name: 'outer-clean', kind: 'OuterClean', spec: OuterSpec, status: OuterStatus },
      (spec) => {
        const cache = simple.Deployment({ name: 'cache', image: 'valkey', id: 'cache' });

        // Outer resource — should NOT be conditionalized
        simple.Deployment({
          name: 'worker',
          image: spec.image,
          id: 'worker',
          env: { MODE: 'production' },
        });

        // Inner composition with a ternary
        innerComp({
          name: spec.name,
          val: cache.status.ready ? 'connected' : 'disconnected',
        });

        return { ready: true };
      }
    );

    const yaml = outerComp.toYaml();
    // The worker's MODE should be a plain value (not conditionalized)
    const lines = yaml.split('\n');
    const workerSection = findResourceSection(lines, 'worker');
    expect(workerSection).toContain('value: production');
    expect(workerSection).not.toContain('cache.status');
  });
});

// =============================================================================
// Additional Phase 1 edge cases
// =============================================================================

describe('Phase 1: dependsOn edge cases', () => {
  it('dependsOn with custom condition string', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'custom-cond', kind: 'CustomCond', spec: Spec, status: Status },
      (spec) => {
        const db = simple.Deployment({ name: 'db', image: 'postgres', id: 'database' });
        const app = simple.Deployment({ name: 'app', image: spec.image, id: 'app' });

        // Custom condition — not just "ready", but a specific phase check
        app.dependsOn(db, 'database.status.conditions.exists(c, c.type == "Ready" && c.status == "True")');

        return { ready: app.status.readyReplicas >= 1 };
      }
    );

    const yaml = comp.toYaml();
    expect(yaml).toContain('readyWhen');
    expect(yaml).toContain('database.status.conditions.exists');
  });
});

describe('Phase 1: Cel.cond edge cases', () => {
  it('Cel.cond with comparison condition via Cel.expr', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');
    const { Cel } = await import('../../src/core/references/cel.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'cel-compare', kind: 'CelCompare', spec: Spec, status: Status },
      (spec) => {
        const db = simple.Deployment({ name: 'db', image: 'postgres', id: 'database' });

        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          // JS comparison on a proxy evaluates to false at runtime,
          // so wrap in Cel.expr to preserve the comparison as CEL.
          replicas: Cel.cond(
            Cel.expr(db.status.readyReplicas, ' >= 1'),
            3,
            1
          ),
        });

        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    // Should contain a ternary with >= comparison
    expect(yaml).toMatch(/database\.status\.readyReplicas\s*>=\s*1\s*\?\s*3\s*:\s*1/);
  });

  it('Cel.cond composes inside template literal via toString', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');
    const { Cel } = await import('../../src/core/references/cel.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'cel-template', kind: 'CelTemplate', spec: Spec, status: Status },
      (spec) => {
        const cache = simple.Deployment({ name: 'cache', image: 'valkey', id: 'cache' });

        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          env: {
            REDIS_URL: `redis://${Cel.cond(cache.status.ready, cache.metadata.name, 'localhost')}:6379`,
          },
        });

        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    // Cel.cond's toString embeds as a KRO mixed-template inside the literal
    expect(yaml).toContain('cache.status.ready');
    expect(yaml).toContain(':6379');
    expect(yaml).toContain('localhost');
  });
});

// =============================================================================
// Additional Phase 2 edge cases
// =============================================================================

describe('Phase 2: extractResourceStatusRef edge cases', () => {
  it('detects negated resource status ref: !cache.status.ready', async () => {
    const { extractResourceStatusRef } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );
    const { Parser } = await import('acorn');

    const source = '(spec) => !cache.status.ready';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal
    const body = (ast as any).body[0].expression.body;

    const ref = extractResourceStatusRef(body, 'spec');
    expect(ref).toBeDefined();
    expect(ref!.variableName).toBe('cache');
    expect(ref!.statusField).toBe('ready');
  });

  it('detects resource status ref with comparison: db.status.instances >= 1', async () => {
    const { extractResourceStatusRef } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );
    const { Parser } = await import('acorn');

    const source = '(spec) => db.status.instances >= 1';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal
    const body = (ast as any).body[0].expression.body;

    const ref = extractResourceStatusRef(body, 'spec');
    expect(ref).toBeDefined();
    expect(ref!.variableName).toBe('db');
    expect(ref!.statusField).toBe('instances');
  });

  it('rejects schema as root variable', async () => {
    const { extractResourceStatusRef } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );
    const { Parser } = await import('acorn');

    const source = '(spec) => schema.status.ready';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal
    const body = (ast as any).body[0].expression.body;

    const ref = extractResourceStatusRef(body, 'spec');
    expect(ref).toBeUndefined();
  });
});

// =============================================================================
// Additional Phase 3 edge cases
// =============================================================================

describe('Phase 3: Direct factory ternary edge cases', () => {
  it('multiple ternaries in same factory call each get independent conditionals', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'multi-ternary', kind: 'MultiTernary', spec: Spec, status: Status },
      (spec) => {
        const cache = simple.Deployment({ name: 'cache', image: 'valkey', id: 'cache' });
        const db = simple.Deployment({ name: 'db', image: 'postgres', id: 'database' });

        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          env: {
            CACHE_MODE: cache.status.ready ? 'redis' : 'memory',
            DB_MODE: db.status.ready ? 'postgres' : 'sqlite',
          },
        });

        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    // Both env vars should have independent conditionals
    expect(yaml).toContain('cache.status');
    expect(yaml).toContain('database.status');
    expect(yaml).toMatch(/CACHE_MODE.*cache\.status/s);
    expect(yaml).toMatch(/DB_MODE.*database\.status/s);
  });

  it('ternary in deeply nested object property is detected', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'deep-ternary', kind: 'DeepTernary', spec: Spec, status: Status },
      (spec) => {
        const cache = simple.Deployment({ name: 'cache', image: 'valkey', id: 'cache' });

        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          env: {
            DEEP_VALUE: cache.status.ready ? 'connected' : 'disconnected',
          },
        });

        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    expect(yaml).toMatch(/DEEP_VALUE.*cache\.status/s);
  });
});

// =============================================================================
// Additional Phase 4 edge cases
// =============================================================================

describe('Phase 4: Cross-composition edge cases', () => {
  it('dependsOn with Cel.cond for cross-composition conditional values', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');
    const { Cel } = await import('../../src/core/references/cel.js');

    const InnerSpec = type({ name: 'string', url: 'string' });
    const InnerStatus = type({ ready: 'boolean' });

    const innerComp = kubernetesComposition(
      { name: 'inner-url', kind: 'InnerUrl', spec: InnerSpec, status: InnerStatus },
      (spec) => {
        simple.Deployment({
          name: spec.name,
          image: 'nginx',
          id: 'innerDep',
          env: { SERVICE_URL: spec.url },
        });
        return { ready: true };
      }
    );

    const OuterSpec = type({ name: 'string' });
    const OuterStatus = type({ ready: 'boolean' });

    const outerComp = kubernetesComposition(
      { name: 'outer-url', kind: 'OuterUrl', spec: OuterSpec, status: OuterStatus },
      (spec) => {
        const cache = simple.Deployment({ name: 'cache', image: 'valkey', id: 'cache' });

        const inner = innerComp({
          name: spec.name,
          // Use Cel.cond for cross-composition conditional values
          url: Cel.cond(
            cache.status.ready,
            `http://${cache.metadata.name}:6379`,
            ''
          ),
        });

        inner.dependsOn(cache);

        return { ready: true };
      }
    );

    const yaml = outerComp.toYaml();
    // Should have readyWhen from dependsOn
    expect(yaml).toContain('readyWhen');
    expect(yaml).toContain('cache.status.ready');
    // Cel.cond value should contain the URL
    expect(yaml).toContain(':6379');
  });
});

// =============================================================================
// Regression guards
// =============================================================================

describe('Regression guards', () => {
  it('composition with no resource-status ternaries is unaffected', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'no-ternary', kind: 'NoTernary', spec: Spec, status: Status },
      (spec) => {
        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          env: { MODE: 'production' },
        });
        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    // Should be a plain deployment with no conditionals
    expect(yaml).toContain('value: production');
    expect(yaml).not.toContain('? ');
    expect(yaml).not.toContain('status.ready');
  });

  it('webapp composition inngest has readyWhen from dependsOn(cache)', async () => {
    const { webAppWithProcessing } = await import(
      '../../src/factories/webapp/compositions/web-app-with-processing.js'
    );

    const yaml = webAppWithProcessing.toYaml();
    // The inngest resources should have a readyWhen referencing cache
    // from the dependsOn(cache) call in the composition
    expect(yaml).toContain('readyWhen');
    expect(yaml).toContain('cache.status.ready');
  });
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract the YAML section for a specific resource ID from the RGD output.
 * Returns the text between `- id: <resourceId>` and the next `- id:`.
 */
function findResourceSection(lines: string[], resourceId: string): string {
  let capturing = false;
  const captured: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith(`- id: ${resourceId}`)) {
      capturing = true;
      captured.push(line);
      continue;
    }
    if (capturing && line.trim().startsWith('- id:')) {
      break;
    }
    if (capturing) {
      captured.push(line);
    }
  }
  return captured.join('\n');
}

// =============================================================================
// Review feedback: additional edge case coverage
// =============================================================================

describe('Review feedback: dependsOn accepts CelExpression condition', () => {
  it('dependsOn with Cel.expr condition extracts expression string', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');
    const { Cel } = await import('../../src/core/references/cel.js');

    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });

    const comp = kubernetesComposition(
      { name: 'depends-cel-expr', kind: 'DependsCelExpr', spec: Spec, status: Status },
      (spec) => {
        const db = simple.Deployment({
          name: `${spec.name}-db`,
          image: spec.image,
          id: 'db',
        });

        const app = simple.Deployment({
          name: spec.name,
          image: spec.image,
          id: 'app',
        });

        // Use Cel.expr as the condition instead of a plain string
        app.dependsOn(db, Cel.expr<string>('db.status.readyReplicas >= 1'));

        return { ready: true };
      }
    );

    const yaml = comp.toYaml();
    // The readyWhen should contain the CEL expression string, not [object Object]
    expect(yaml).toContain('db.status.readyReplicas >= 1');
    expect(yaml).not.toContain('[object Object]');
  });
});

describe('Review feedback: computeMergedId is a shared utility', () => {
  it('computeMergedId returns baseId for single-resource compositions', async () => {
    const { computeMergedId } = await import(
      '../../src/core/composition/imperative.js'
    );
    expect(computeMergedId('myComp', 'innerRes', 1)).toBe('myComp');
  });

  it('computeMergedId returns baseId-innerResourceId for multi-resource compositions', async () => {
    const { computeMergedId } = await import(
      '../../src/core/composition/imperative.js'
    );
    expect(computeMergedId('myComp', 'helmRelease', 3)).toBe('myComp-helmRelease');
  });
});
