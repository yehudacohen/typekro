/**
 * Nested Composition KRO Serialization Invariants
 *
 * Regression suite that encodes the invariants for how nested compositions
 * must be flattened into a KRO ResourceGraphDefinition. These tests are
 * expected to FAIL against current code — they document the target behavior
 * and the fix commit must make them pass.
 *
 * Invariants:
 *   I1 — depth-agnostic staticness
 *        A field (status or resource template) is static iff, after fully
 *        resolving any nested composition references, it depends only on
 *        schema refs (`__schema__`) and literals.
 *
 *   I2 — static fields never appear in KRO status CEL
 *        KRO status CEL does NOT support `schema.spec.*`. Any field
 *        classified as static by I1 must be hydrated by TypeKro at deploy
 *        time and must NOT appear in the RGD's spec.schema.status block.
 *
 *   I3 — dynamic fields must be canonical CEL
 *        No raw __KUBERNETES_REF__ markers, no `[object Object]`, no JS
 *        operators (`?.`, `??`) in emitted CEL expressions.
 *
 *   I4 — schema consistency
 *        Every `schema.spec.X` reference anywhere in the emitted RGD
 *        (CEL, schema defaults, string values) must point to a field
 *        that exists in the OUTER composition's spec schema. Inner
 *        nested-composition schema fields must never leak up.
 *
 *   I5 — nested ref resolution
 *        Every reference to `nestedComp.status.Y` must resolve to the
 *        inner composition's analyzed value for Y.
 *
 *   I6 — no virtual composition IDs in output
 *        Every `<id>.status.<field>` path in the emitted YAML must point
 *        to a real resource ID that appears in spec.resources[*].id.
 *        Virtual nested composition IDs (e.g., "webAppWithProcessing1")
 *        are lookup keys for nestedStatusCel, not RGD resource references.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import * as yaml from 'js-yaml';
import {
  createCompositionContext,
  runWithCompositionContext,
} from '../../src/core/composition/context.js';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { ConfigMap, Deployment } from '../../src/factories/simple/index.js';

// =============================================================================
// Parsed RGD helpers
// =============================================================================

interface ParsedRgdResource {
  id: string;
  template?: Record<string, unknown>;
  includeWhen?: string[];
  readyWhen?: string[];
  externalRef?: unknown;
}

interface ParsedRgd {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec: {
    schema: {
      apiVersion: string;
      kind: string;
      group?: string;
      spec: Record<string, unknown>;
      status?: Record<string, unknown>;
    };
    resources: ParsedRgdResource[];
  };
}

function parseRgd(yamlStr: string): ParsedRgd {
  return yaml.load(yamlStr) as ParsedRgd;
}

/** Recursively collect every string in a value tree. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

/** Assert that no raw __KUBERNETES_REF__ markers appear anywhere in `parsed`. */
function assertNoRawMarkers(parsed: ParsedRgd, context = ''): void {
  const strings = collectStrings(parsed);
  const offenders = strings.filter((s) => s.includes('__KUBERNETES_REF_'));
  if (offenders.length > 0) {
    const where = context ? ` in ${context}` : '';
    const lines = offenders.map((s) => `  - ${s.slice(0, 160)}`).join('\n');
    throw new Error(`I3 violated${where}: raw __KUBERNETES_REF__ markers found:\n${lines}`);
  }
}

/** Assert that no `[object Object]` stringification appears anywhere. */
function assertNoObjectObject(parsed: ParsedRgd, context = ''): void {
  const strings = collectStrings(parsed);
  const offenders = strings.filter((s) => s.includes('[object Object]'));
  if (offenders.length > 0) {
    const where = context ? ` in ${context}` : '';
    const lines = offenders.map((s) => `  - ${s.slice(0, 160)}`).join('\n');
    throw new Error(`I3 violated${where}: [object Object] found:\n${lines}`);
  }
}

/** Assert that no JS-only operators (?., ??) appear inside CEL expressions. */
function assertNoJsOperatorsInCel(parsed: ParsedRgd, context = ''): void {
  const strings = collectStrings(parsed);
  // Only flag these when they appear inside ${...} — outside of CEL they're
  // legitimate (e.g., in commented-out code or raw template strings we
  // don't emit).
  const celBlock = /\$\{([^}]*)\}/g;
  const offenders: string[] = [];
  for (const s of strings) {
    for (const m of s.matchAll(celBlock)) {
      const body = m[1] ?? '';
      if (body.includes('?.') || body.includes('??')) {
        offenders.push(m[0]);
      }
    }
  }
  if (offenders.length > 0) {
    const where = context ? ` in ${context}` : '';
    const lines = offenders.map((s) => `  - ${s.slice(0, 160)}`).join('\n');
    throw new Error(`I3 violated${where}: JS operators (?. or ??) inside CEL:\n${lines}`);
  }
}

/**
 * Walk every string in `parsed` and return every `schema.spec.<firstSegment>`
 * reference found. Used to verify I4.
 */
function extractSchemaFirstSegments(parsed: ParsedRgd): string[] {
  const strings = collectStrings(parsed);
  const pattern = /schema\.spec\.([a-zA-Z_$][\w$]*)/g;
  const segments = new Set<string>();
  for (const s of strings) {
    for (const m of s.matchAll(pattern)) {
      if (m[1]) segments.add(m[1]);
    }
  }
  return Array.from(segments);
}

/**
 * Walk every string in `parsed` and return every `<id>.status.<field>` reference
 * found. Excludes `schema.status.X` (which is KRO-specific). Used to verify I6.
 */
function extractResourceStatusRefs(parsed: ParsedRgd): Array<{ id: string; field: string }> {
  const strings = collectStrings(parsed);
  // Match the segment immediately before `.status.field` so we capture
  // the resource id (not the dotted path that precedes it). The capture
  // is anchored on a word boundary to avoid matching mid-identifier.
  const pattern = /([a-zA-Z_$][\w$]*)\.status\.([a-zA-Z_$][\w$.]*)/g;
  const refs: Array<{ id: string; field: string }> = [];
  for (const s of strings) {
    for (const m of s.matchAll(pattern)) {
      const id = m[1] ?? '';
      const field = m[2] ?? '';
      if (id === 'schema') continue;
      refs.push({ id, field });
    }
  }
  return refs;
}

/** Return the set of resource IDs declared in spec.resources. */
function getResourceIds(parsed: ParsedRgd): Set<string> {
  return new Set(parsed.spec.resources.map((r) => r.id));
}

/**
 * Pluck a Deployment-like resource's container env array from a parsed
 * resource template. Walks the typical Pod template path
 * `template.spec.template.spec.containers[0].env` with safe narrowing
 * and returns the env var entries cast to a typed shape.
 */
function getContainerEnv(
  resource: ParsedRgdResource | undefined
): Array<{ name: string; value: string }> {
  if (!resource?.template) throw new Error('resource template missing');
  const tplSpec = (resource.template.spec ?? {}) as Record<string, unknown>;
  const podTpl = (tplSpec.template ?? {}) as Record<string, unknown>;
  const podSpec = (podTpl.spec ?? {}) as Record<string, unknown>;
  const containers = podSpec.containers as Array<{ env?: unknown }> | undefined;
  if (!containers || containers.length === 0) {
    throw new Error('resource has no containers');
  }
  const env = containers[0]?.env;
  if (!Array.isArray(env)) throw new Error('container env is not an array');
  return env as Array<{ name: string; value: string }>;
}

/**
 * Shape of the internal direct-factory hook we read for test introspection.
 * Mirrors the structure populated by `createDirectResourceFactory` — only
 * the fields used here are typed.
 */
interface DirectFactoryInternal {
  factoryOptions?: {
    compositionFn?: (spec: Record<string, unknown>) => Record<string, unknown>;
  };
}

interface CallableCompositionLike {
  factory(mode: 'direct', opts: { namespace: string }): unknown;
}

/**
 * Invoke a composition's `_compositionFn` in a direct-mode re-execution
 * context and return the resulting status object. This mirrors the pattern
 * used by `nested-composition-direct-mode.test.ts` to test static field
 * hydration without actually deploying resources to a cluster.
 *
 * The cast to `DirectFactoryInternal` is intentional — we're reaching into
 * factory internals that aren't part of the public API surface, but this
 * is what the existing direct-mode tests do too. The cast is the smallest
 * possible type widening to access just what we need.
 */
function reExecuteStatus(
  composition: CallableCompositionLike,
  spec: Record<string, unknown>
): Record<string, unknown> {
  const factory = composition.factory('direct', { namespace: 'test' }) as DirectFactoryInternal;
  const compositionFn = factory.factoryOptions?.compositionFn;
  expect(compositionFn).toBeDefined();
  if (!compositionFn) throw new Error('expected compositionFn to be defined');
  const reCtx = createCompositionContext('re-exec', {
    deduplicateIds: true,
    isReExecution: true,
  });
  let status: Record<string, unknown> = {};
  runWithCompositionContext(reCtx, () => {
    status = compositionFn(spec);
  });
  return status;
}

// =============================================================================
// T1 — inner schema-only static field propagates as static
// =============================================================================

describe('T1 — inner schema-only static field propagates as static (I1, I2, I5)', () => {
  const innerComp = kubernetesComposition(
    {
      name: 't1-inner',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T1Inner',
      spec: type({ name: 'string', port: 'number' }),
      status: type({ url: 'string' }),
    },
    (spec) => {
      Deployment({ name: spec.name, image: 'nginx', id: 'innerDeploy' });
      return {
        // Pure schema-ref template literal — no resource refs anywhere.
        // This should be classified as STATIC transitively.
        url: `http://${spec.name}:${spec.port}`,
      };
    }
  );

  const outerComp = kubernetesComposition(
    {
      name: 't1-outer',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T1Outer',
      spec: type({ appName: 'string', appPort: 'number' }),
      status: type({ url: 'string' }),
    },
    (spec) => {
      const inner = innerComp({ name: spec.appName, port: spec.appPort });
      return {
        url: inner.status.url,
      };
    }
  );

  it('I2: outer RGD status does NOT contain url (static → hydrated locally)', () => {
    const yamlStr = outerComp.toYaml();
    const parsed = parseRgd(yamlStr);
    // The static field must be hydrated by TypeKro and NOT sent to KRO.
    expect(parsed.spec.schema.status?.url).toBeUndefined();
  });

  it('I3: outer YAML contains no raw KUBERNETES_REF markers anywhere', () => {
    const parsed = parseRgd(outerComp.toYaml());
    assertNoRawMarkers(parsed, 't1-outer');
  });

  it('I4: every schema.spec.X in YAML references the outer schema', () => {
    const parsed = parseRgd(outerComp.toYaml());
    const outerFields = new Set(['appName', 'appPort']);
    const segments = extractSchemaFirstSegments(parsed);
    for (const seg of segments) {
      expect(outerFields.has(seg)).toBe(true);
    }
  });

  it('direct-mode re-execution resolves url against outer spec', () => {
    const status = reExecuteStatus(outerComp, { appName: 'myapp', appPort: 8080 });
    expect(status.url).toBe('http://myapp:8080');
  });
});

// =============================================================================
// T2 — inner resource-ref dynamic field propagates as dynamic
// =============================================================================

describe('T2 — inner resource-ref field propagates as dynamic (I1, I3, I5)', () => {
  const innerComp = kubernetesComposition(
    {
      name: 't2-inner',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T2Inner',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      const deploy = Deployment({
        name: spec.name,
        image: 'nginx',
        id: 'innerDeploy',
      });
      return {
        // Dynamic — depends on a real resource's status.
        ready: deploy.status.readyReplicas >= 1,
      };
    }
  );

  const outerComp = kubernetesComposition(
    {
      name: 't2-outer',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T2Outer',
      spec: type({ appName: 'string' }),
      status: type({ innerReady: 'boolean' }),
    },
    (spec) => {
      const inner = innerComp({ name: spec.appName });
      return {
        innerReady: inner.status.ready,
      };
    }
  );

  it('outer RGD status.innerReady exists (dynamic → emitted as CEL)', () => {
    const parsed = parseRgd(outerComp.toYaml());
    expect(parsed.spec.schema.status?.innerReady).toBeDefined();
  });

  it('I3: innerReady CEL references the real resource ID, not a virtual one', () => {
    const parsed = parseRgd(outerComp.toYaml());
    const innerReady = String(parsed.spec.schema.status?.innerReady ?? '');
    // The dynamic field now resolves to the merged parent resource id for the
    // nested composition leaf, not the raw inner resource id.
    expect(innerReady).toContain('t2Inner1.status.readyReplicas');
    expect(innerReady).not.toContain('__KUBERNETES_REF_');
  });

  it('I6: every <id>.status.X in the YAML points to an actual resource id', () => {
    const parsed = parseRgd(outerComp.toYaml());
    const resourceIds = getResourceIds(parsed);
    const refs = extractResourceStatusRefs(parsed);
    for (const { id } of refs) {
      expect(resourceIds.has(id)).toBe(true);
    }
  });
});

// =============================================================================
// T3 — mixed static + dynamic nested refs
// =============================================================================

describe('T3 — mixed static/dynamic components (I1, I2, I3, I5)', () => {
  const innerComp = kubernetesComposition(
    {
      name: 't3-inner',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T3Inner',
      spec: type({ name: 'string', port: 'number' }),
      status: type({ url: 'string', ready: 'boolean' }),
    },
    (spec) => {
      const deploy = Deployment({
        name: spec.name,
        image: 'nginx',
        id: 'innerDeploy',
      });
      return {
        url: `http://${spec.name}:${spec.port}`, // static
        ready: deploy.status.readyReplicas >= 1, // dynamic
      };
    }
  );

  const outerComp = kubernetesComposition(
    {
      name: 't3-outer',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T3Outer',
      spec: type({ appName: 'string', appPort: 'number' }),
      status: type({ innerUrl: 'string', innerReady: 'boolean' }),
    },
    (spec) => {
      const inner = innerComp({ name: spec.appName, port: spec.appPort });
      return {
        innerUrl: inner.status.url, // → static (only schema refs transitively)
        innerReady: inner.status.ready, // → dynamic (transitively hits a resource ref)
      };
    }
  );

  it('I2: static field (innerUrl) is NOT in RGD status', () => {
    const parsed = parseRgd(outerComp.toYaml());
    expect(parsed.spec.schema.status?.innerUrl).toBeUndefined();
  });

  it('dynamic field (innerReady) IS in RGD status', () => {
    const parsed = parseRgd(outerComp.toYaml());
    expect(parsed.spec.schema.status?.innerReady).toBeDefined();
  });

  it('I3: no raw markers in YAML', () => {
    const parsed = parseRgd(outerComp.toYaml());
    assertNoRawMarkers(parsed, 't3-outer');
  });

  it('direct-mode hydrates innerUrl against outer spec', () => {
    const status = reExecuteStatus(outerComp, { appName: 'myapp', appPort: 8080 });
    expect(status.innerUrl).toBe('http://myapp:8080');
  });
});

// =============================================================================
// T4 — inner literal field (number) propagates correctly
// =============================================================================

describe('T4 — inner literal field (number) propagates as static (I1, I5)', () => {
  const innerComp = kubernetesComposition(
    {
      name: 't4-inner',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T4Inner',
      spec: type({ name: 'string' }),
      status: type({ port: 'number' }),
    },
    (spec) => {
      Deployment({ name: spec.name, image: 'nginx', id: 'innerDeploy' });
      return {
        // Literal — no refs at all. Should be classified as static.
        port: 6379,
      };
    }
  );

  describe('direct assignment (VAR: inner.status.port)', () => {
    const outerComp = kubernetesComposition(
      {
        name: 't4-outer-direct',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'T4OuterDirect',
        spec: type({ appName: 'string' }),
        status: type({ cachePort: 'number' }),
      },
      (spec) => {
        const inner = innerComp({ name: spec.appName });
        Deployment({
          name: `${spec.appName}-consumer`,
          image: 'nginx',
          // Direct assignment of the nested ref as an env var value.
          env: {
            VALKEY_PORT: inner.status.port as unknown as string,
          },
          id: 'consumer',
        });
        return { cachePort: inner.status.port };
      }
    );

    it('I2: cachePort is NOT in RGD status (literal → static)', () => {
      const parsed = parseRgd(outerComp.toYaml());
      expect(parsed.spec.schema.status?.cachePort).toBeUndefined();
    });

    it('I3: no [object Object] anywhere in the YAML', () => {
      const parsed = parseRgd(outerComp.toYaml());
      assertNoObjectObject(parsed, 't4-outer-direct');
    });

    it('I3: no raw markers in the YAML', () => {
      const parsed = parseRgd(outerComp.toYaml());
      assertNoRawMarkers(parsed, 't4-outer-direct');
    });

    it('I6: every <id>.status.X points to a real resource', () => {
      const parsed = parseRgd(outerComp.toYaml());
      const ids = getResourceIds(parsed);
      const refs = extractResourceStatusRefs(parsed);
      for (const { id } of refs) {
        expect(ids.has(id)).toBe(true);
      }
    });
  });

  describe('template-literal interpolation (VAR: `${inner.status.port}`)', () => {
    const outerComp = kubernetesComposition(
      {
        name: 't4-outer-interp',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'T4OuterInterp',
        spec: type({ appName: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const inner = innerComp({ name: spec.appName });
        Deployment({
          name: `${spec.appName}-consumer`,
          image: 'nginx',
          env: {
            // Interpolated in a template literal — the nested ref is
            // string-coerced. The framework must either resolve it cleanly
            // or fail loudly; "[object Object]" is NOT acceptable.
            VALKEY_PORT: `${inner.status.port}`,
          },
          id: 'consumer',
        });
        return { ready: true };
      }
    );

    it('I3: template-literal interpolation does NOT produce [object Object]', () => {
      // If this throws at composition time (e.g., because the nested ref
      // proxy rejects string coercion with a clear error), the test should
      // still treat that as acceptable behavior — the framework caught the
      // problem. What's NOT acceptable is silently producing [object Object].
      let yamlStr: string;
      try {
        yamlStr = outerComp.toYaml();
      } catch (err) {
        // Acceptable: framework rejected the usage with an error.
        expect((err as Error).message).toBeTruthy();
        return;
      }
      const parsed = parseRgd(yamlStr);
      assertNoObjectObject(parsed, 't4-outer-interp');
    });
  });
});

// =============================================================================
// T5 — resource template embedding a static nested ref
// =============================================================================

describe('T5 — resource template embedding static nested ref (I1, I3, I4, I5)', () => {
  const innerComp = kubernetesComposition(
    {
      name: 't5-inner',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T5Inner',
      spec: type({ name: 'string', dbName: 'string', dbUser: 'string' }),
      status: type({ databaseUrl: 'string' }),
    },
    (spec) => {
      Deployment({ name: spec.name, image: 'nginx', id: 'innerDeploy' });
      return {
        // Static (schema-only) template literal.
        databaseUrl: `postgresql://${spec.dbUser}@${spec.name}-db:5432/${spec.dbName}`,
      };
    }
  );

  const outerComp = kubernetesComposition(
    {
      name: 't5-outer',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T5Outer',
      spec: type({ appName: 'string', dbName: 'string', dbUser: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      const inner = innerComp({
        name: spec.appName,
        dbName: spec.dbName,
        dbUser: spec.dbUser,
      });
      Deployment({
        name: `${spec.appName}-worker`,
        image: 'nginx',
        env: {
          DATABASE_URL: inner.status.databaseUrl,
        },
        id: 'worker',
      });
      return { ready: true };
    }
  );

  it('I3: DATABASE_URL env var contains no raw markers', () => {
    const parsed = parseRgd(outerComp.toYaml());
    assertNoRawMarkers(parsed, 't5-outer');
  });

  it('I4: every schema.spec.X in the YAML refers to the outer schema', () => {
    const parsed = parseRgd(outerComp.toYaml());
    const outerFields = new Set(['appName', 'dbName', 'dbUser']);
    const segments = extractSchemaFirstSegments(parsed);
    for (const seg of segments) {
      expect(outerFields.has(seg)).toBe(true);
    }
  });

  it('I5: DATABASE_URL env var resolves to canonical CEL referencing outer fields', () => {
    const parsed = parseRgd(outerComp.toYaml());
    const worker = parsed.spec.resources.find((r) => r.id === 'worker');
    expect(worker).toBeDefined();
    const env = getContainerEnv(worker);
    const dbUrl = env.find((e) => e.name === 'DATABASE_URL');
    expect(dbUrl).toBeDefined();
    // Must contain outer schema refs for the database credentials.
    // We accept either the mixed-template form or the concat form — both
    // are valid CEL for string building — but the path must reference
    // schema.spec.dbUser (not schema.spec.user or some inner field).
    expect(dbUrl?.value).toMatch(/schema\.spec\.dbUser/);
    expect(dbUrl?.value).toMatch(/schema\.spec\.appName/);
    expect(dbUrl?.value).toMatch(/schema\.spec\.dbName/);
  });
});

// =============================================================================
// T6 — schema consistency (broad)
// =============================================================================

describe('T6 — schema consistency (I4)', () => {
  it('every schema.spec.X reference in a nested-composition YAML lands in the outer schema', () => {
    const inner = kubernetesComposition(
      {
        name: 't6-inner',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'T6Inner',
        spec: type({
          innerName: 'string',
          'innerPort?': 'number',
          'innerImage?': 'string',
        }),
        status: type({ url: 'string' }),
      },
      (spec) => {
        Deployment({
          name: spec.innerName,
          image: spec.innerImage ?? 'nginx:alpine',
          id: 'innerDeploy',
        });
        return {
          url: `http://${spec.innerName}:${spec.innerPort ?? 8080}`,
        };
      }
    );

    const outer = kubernetesComposition(
      {
        name: 't6-outer',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'T6Outer',
        spec: type({
          name: 'string',
          port: 'number',
        }),
        status: type({ url: 'string' }),
      },
      (spec) => {
        const i = inner({ innerName: spec.name, innerPort: spec.port });
        return { url: i.status.url };
      }
    );

    const parsed = parseRgd(outer.toYaml());
    const outerFields = new Set(['name', 'port']);
    const segments = extractSchemaFirstSegments(parsed);
    for (const seg of segments) {
      expect(outerFields.has(seg)).toBe(true);
    }
    // Specifically: innerName/innerPort/innerImage must NOT leak into
    // the outer RGD's emitted schema references.
    expect(segments).not.toContain('innerName');
    expect(segments).not.toContain('innerPort');
    expect(segments).not.toContain('innerImage');
  });
});

// =============================================================================
// T7 — strict virtual ID cross-reference
// =============================================================================

describe('T7 — strict virtual ID cross-reference (I6)', () => {
  it('every <id>.status.<field> in YAML refers to a real resource in spec.resources', () => {
    // Intentionally use multiple nested compositions to stress the virtual
    // ID resolution. The old prefix-match fallback produced false positives
    // here (e.g., `inngest.status.ready` when no resource was actually
    // named `inngest`).
    const serviceA = kubernetesComposition(
      {
        name: 't7-service-a',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'T7ServiceA',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const deploy = Deployment({
          name: spec.name,
          image: 'nginx',
          id: 'deployA',
        });
        return { ready: deploy.status.readyReplicas >= 1 };
      }
    );

    const serviceB = kubernetesComposition(
      {
        name: 't7-service-b',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'T7ServiceB',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const deploy = Deployment({
          name: spec.name,
          image: 'nginx',
          id: 'deployB',
        });
        return { ready: deploy.status.readyReplicas >= 1 };
      }
    );

    const outer = kubernetesComposition(
      {
        name: 't7-outer',
        apiVersion: 'test.example.com/v1alpha1',
        kind: 'T7Outer',
        spec: type({ name: 'string' }),
        status: type({ bothReady: 'boolean' }),
      },
      (spec) => {
        const a = serviceA({ name: `${spec.name}-a` });
        const b = serviceB({ name: `${spec.name}-b` });
        return {
          bothReady: a.status.ready && b.status.ready,
        };
      }
    );

    const parsed = parseRgd(outer.toYaml());
    const ids = getResourceIds(parsed);
    const refs = extractResourceStatusRefs(parsed);

    const dangling = refs.filter(({ id }) => !ids.has(id));
    if (dangling.length > 0) {
      throw new Error(
        `I6 violated: status refs point to non-existent resource IDs.\n` +
          `Actual resource IDs in spec.resources: ${Array.from(ids).join(', ')}\n` +
          `Dangling refs:\n` +
          dangling.map((r) => `  - ${r.id}.status.${r.field}`).join('\n')
      );
    }
  });
});

// =============================================================================
// T8 — full-stack webapp-shaped regression (minimized)
// =============================================================================

describe('T8 — full-stack webapp regression (I1–I6)', () => {
  // Mirrors the essential shape of a full-stack webapp composition:
  // a nested composition providing both static URL fields and dynamic
  // ready fields, plus a consumer Deployment in the outer that reads
  // those status values into env vars.
  const webappComp = kubernetesComposition(
    {
      name: 't8-webapp',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T8Webapp',
      spec: type({
        name: 'string',
        dbOwner: 'string',
        dbName: 'string',
      }),
      status: type({
        databaseUrl: 'string',
        cacheUrl: 'string',
        cacheHost: 'string',
        cachePort: 'number',
        ready: 'boolean',
      }),
    },
    (spec) => {
      const app = Deployment({
        name: spec.name,
        image: 'nginx',
        id: 'webappApp',
      });
      return {
        // All static — pure template literals over schema fields.
        databaseUrl: `postgresql://${spec.dbOwner}@${spec.name}-db:5432/${spec.dbName}`,
        cacheUrl: `redis://${spec.name}-cache:6379`,
        cacheHost: `${spec.name}-cache`,
        cachePort: 6379,
        // Dynamic — depends on a real resource.
        ready: app.status.readyReplicas >= 1,
      };
    }
  );

  const collectorComp = kubernetesComposition(
    {
      name: 't8-collector',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T8Collector',
      spec: type({
        name: 'string',
        owner: 'string',
        databaseName: 'string',
      }),
      status: type({
        ready: 'boolean',
        appUrl: 'string',
      }),
    },
    (spec) => {
      const stack = webappComp({
        name: spec.name,
        dbOwner: spec.owner,
        dbName: spec.databaseName,
      });
      // Supervisor consumes the nested composition's status values
      // as environment variables — a common full-stack webapp pattern.
      Deployment({
        name: `${spec.name}-supervisor`,
        image: 'nginx',
        env: {
          DATABASE_URL: stack.status.databaseUrl,
          VALKEY_HOST: stack.status.cacheHost,
          // Numeric literal nested ref — must resolve cleanly.
          VALKEY_PORT: stack.status.cachePort as unknown as string,
        },
        id: 'supervisor',
      });
      return {
        ready: stack.status.ready,
        appUrl: `http://${spec.name}:3000`,
      };
    }
  );

  it('I3: no raw KUBERNETES_REF markers anywhere', () => {
    const parsed = parseRgd(collectorComp.toYaml());
    assertNoRawMarkers(parsed, 't8-collector');
  });

  it('I3: no [object Object] anywhere', () => {
    const parsed = parseRgd(collectorComp.toYaml());
    assertNoObjectObject(parsed, 't8-collector');
  });

  it('I3: no JS operators inside CEL expressions', () => {
    const parsed = parseRgd(collectorComp.toYaml());
    assertNoJsOperatorsInCel(parsed, 't8-collector');
  });

  it('I4: every schema.spec.X reference belongs to the outer schema', () => {
    const parsed = parseRgd(collectorComp.toYaml());
    const outerFields = new Set(['name', 'owner', 'databaseName']);
    const segments = extractSchemaFirstSegments(parsed);
    for (const seg of segments) {
      expect(outerFields.has(seg)).toBe(true);
    }
  });

  it('I6: every <id>.status.X in YAML points to a real resource in spec.resources', () => {
    const parsed = parseRgd(collectorComp.toYaml());
    const ids = getResourceIds(parsed);
    const refs = extractResourceStatusRefs(parsed);
    const dangling = refs.filter(({ id }) => !ids.has(id));
    expect(dangling).toEqual([]);
  });

  it('I2: static outer status fields (appUrl) are NOT in RGD status', () => {
    const parsed = parseRgd(collectorComp.toYaml());
    // appUrl is schema-only — must be hydrated locally.
    expect(parsed.spec.schema.status?.appUrl).toBeUndefined();
  });

  it('dynamic outer status fields (ready) ARE in RGD status', () => {
    const parsed = parseRgd(collectorComp.toYaml());
    expect(parsed.spec.schema.status?.ready).toBeDefined();
  });

  it('supervisor env vars resolve cleanly', () => {
    const parsed = parseRgd(collectorComp.toYaml());
    const supervisor = parsed.spec.resources.find((r) => r.id === 'supervisor');
    expect(supervisor).toBeDefined();
    const env = getContainerEnv(supervisor);

    for (const envVar of env) {
      expect(envVar.value).not.toContain('__KUBERNETES_REF_');
      expect(envVar.value).not.toContain('[object Object]');
    }

    const dbUrl = env.find((e) => e.name === 'DATABASE_URL');
    expect(dbUrl).toBeDefined();
    expect(dbUrl?.value).toMatch(/schema\.spec\.owner/);
    expect(dbUrl?.value).toMatch(/schema\.spec\.name/);
    expect(dbUrl?.value).toMatch(/schema\.spec\.databaseName/);
  });

  it('direct-mode re-execution produces a fully hydrated status', () => {
    const status = reExecuteStatus(collectorComp, {
      name: 'myapp',
      owner: 'app',
      databaseName: 'appdb',
    });
    expect(status.appUrl).toBe('http://myapp:3000');
  });
});

// =============================================================================
// T9 — outer RGD never references inner-only schema fields (I4)
// =============================================================================

describe('T9 — outer RGD never references inner-only schema fields (I4)', () => {
  // This invariant test catches the inner-schema contamination class of bug:
  // a nested composition with optional fields that the outer doesn't pass
  // could leak its own schema field names into the outer RGD via the
  // hybrid-branch differential analysis. The test asserts the user-facing
  // outcome (no inner-only schema field names in outer YAML) — it doesn't
  // prescribe the implementation strategy, so future maintainers can change
  // HOW the invariant is enforced without rewriting the test.
  const innerWithOptional = kubernetesComposition(
    {
      name: 't9-inner-optional',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T9InnerOptional',
      spec: type({
        innerName: 'string',
        'innerMode?': 'string',
        'innerSidecar?': 'boolean',
      }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      Deployment({
        name: spec.innerName,
        image: spec.innerMode ?? 'nginx:alpine',
        id: 'innerDeploy',
      });
      // Branch on an optional field — the exact pattern the hybrid run fires on.
      if (!spec.innerSidecar) {
        ConfigMap({
          name: `${spec.innerName}-config`,
          data: { mode: spec.innerMode ?? 'default' },
          id: 'innerConfig',
        });
      }
      return { ready: true };
    }
  );

  const outer = kubernetesComposition(
    {
      name: 't9-outer',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T9Outer',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      // Outer does NOT pass innerSidecar or innerMode — inner fields are
      // outside the outer's control.
      const i = innerWithOptional({ innerName: spec.name });
      return { ready: i.status.ready };
    }
  );

  it('outer RGD contains no references to inner-only schema fields', () => {
    const parsed = parseRgd(outer.toYaml());
    const segments = extractSchemaFirstSegments(parsed);
    const innerOnly = ['innerSidecar', 'innerMode', 'innerName'];
    for (const innerField of innerOnly) {
      expect(segments).not.toContain(innerField);
    }
  });

  it('outer RGD schema spec contains only outer fields', () => {
    const parsed = parseRgd(outer.toYaml());
    const specFields = Object.keys(parsed.spec.schema.spec);
    // Outer schema has just `name`.
    expect(specFields).toContain('name');
    expect(specFields).not.toContain('innerSidecar');
    expect(specFields).not.toContain('innerMode');
    expect(specFields).not.toContain('innerName');
  });
});

// =============================================================================
// T10 — three-level nesting
// =============================================================================

describe('T10 — three-level nesting (I1, I4, I5, I6)', () => {
  const level3 = kubernetesComposition(
    {
      name: 't10-l3',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T10L3',
      spec: type({ name: 'string' }),
      status: type({ url: 'string', ready: 'boolean' }),
    },
    (spec) => {
      const d = Deployment({ name: spec.name, image: 'nginx', id: 'l3Deploy' });
      return {
        url: `http://${spec.name}:8080`, // static
        ready: d.status.readyReplicas >= 1, // dynamic
      };
    }
  );

  const level2 = kubernetesComposition(
    {
      name: 't10-l2',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T10L2',
      spec: type({ name: 'string' }),
      status: type({ url: 'string', ready: 'boolean' }),
    },
    (spec) => {
      const inner = level3({ name: `${spec.name}-l3` });
      return {
        url: inner.status.url, // → static (transitively)
        ready: inner.status.ready, // → dynamic (transitively)
      };
    }
  );

  const level1 = kubernetesComposition(
    {
      name: 't10-l1',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T10L1',
      spec: type({ name: 'string' }),
      status: type({ url: 'string', ready: 'boolean' }),
    },
    (spec) => {
      const mid = level2({ name: spec.name });
      return {
        url: mid.status.url, // → static (transitively, two levels deep)
        ready: mid.status.ready, // → dynamic (transitively, two levels deep)
      };
    }
  );

  it('I2: top-level static field (url) propagates through two levels', () => {
    const parsed = parseRgd(level1.toYaml());
    expect(parsed.spec.schema.status?.url).toBeUndefined();
  });

  it('top-level dynamic field (ready) propagates through two levels', () => {
    const parsed = parseRgd(level1.toYaml());
    expect(parsed.spec.schema.status?.ready).toBeDefined();
  });

  it('I4: every schema.spec.X in the L1 YAML lands in the L1 schema', () => {
    const parsed = parseRgd(level1.toYaml());
    const l1Fields = new Set(['name']);
    const segments = extractSchemaFirstSegments(parsed);
    for (const seg of segments) {
      expect(l1Fields.has(seg)).toBe(true);
    }
  });

  it('I6: every <id>.status.X in the L1 YAML points to a real resource', () => {
    const parsed = parseRgd(level1.toYaml());
    const ids = getResourceIds(parsed);
    const refs = extractResourceStatusRefs(parsed);
    const dangling = refs.filter(({ id }) => !ids.has(id));
    expect(dangling).toEqual([]);
  });

  it('I3: no raw markers in the L1 YAML', () => {
    const parsed = parseRgd(level1.toYaml());
    assertNoRawMarkers(parsed, 't10-l1');
  });

  it('direct-mode re-execution hydrates url across all three levels', () => {
    const status = reExecuteStatus(level1, { name: 'myapp' });
    expect(status.url).toBe('http://myapp-l3:8080');
  });
});

// =============================================================================
// T11 — multi-level propagation pin
// =============================================================================

describe('T11 — inner-of-inner status entries propagate to the outermost (I5)', () => {
  // This focused test pins the propagation step in
  // `executeNestedCompositionWithSpec` that copies the inner's
  // accumulated `__nestedStatus:*` entries up to the parent context.
  // T10 tests this transitively but doesn't pinpoint the propagation —
  // when T10 fails, you have to read the code to figure out which moving
  // part broke. This test asserts directly: "the outermost composition's
  // nestedStatusCel contains entries for the deepest level."
  const innerInner = kubernetesComposition(
    {
      name: 't11-inner-inner',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T11InnerInner',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      const d = Deployment({ name: spec.name, image: 'nginx', id: 'iiDeploy' });
      return { ready: d.status.readyReplicas >= 1 };
    }
  );

  const inner = kubernetesComposition(
    {
      name: 't11-inner',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T11Inner',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      const ii = innerInner({ name: `${spec.name}-ii` });
      return { ready: ii.status.ready };
    }
  );

  const outer = kubernetesComposition(
    {
      name: 't11-outer',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T11Outer',
      spec: type({ name: 'string' }),
      status: type({ allReady: 'boolean' }),
    },
    (spec) => {
      const i = inner({ name: spec.name });
      return { allReady: i.status.ready };
    }
  );

  it('outermost composition has nestedStatusCel entries for both inner and inner-inner', () => {
    // Pull the nestedStatusCel attached to the outer's captured status
    // by `executeCompositionCore`. The descriptor read bypasses the
    // Enhanced proxy's get-trap.
    const graph = outer as unknown as { _analysisResults?: Record<string, unknown> };
    const results = graph._analysisResults as Record<string, unknown> | undefined;
    const statusMappings = results?.statusMappings as Record<string, unknown> | undefined;
    expect(statusMappings).toBeDefined();
    const desc = statusMappings && Object.getOwnPropertyDescriptor(statusMappings, '__nestedStatusCel');
    const nestedStatusCel = desc?.value as Record<string, string> | undefined;
    expect(nestedStatusCel).toBeDefined();
    if (!nestedStatusCel) return;

    const keys = Object.keys(nestedStatusCel);
    // Direct entries (immediate inner): t11Inner<N>:ready
    const innerKeys = keys.filter((k) => /^__nestedStatus:t11Inner\d+:ready$/.test(k));
    expect(innerKeys.length).toBeGreaterThan(0);
    // Propagated entries (inner-of-inner): t11InnerInner<N>:ready
    const innerInnerKeys = keys.filter((k) => /^__nestedStatus:t11InnerInner\d+:ready$/.test(k));
    expect(innerInnerKeys.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// T12 — CEL macro lambda variables
// =============================================================================

describe('T12 — CEL macro lambda variables are not treated as resource refs (I3)', () => {
  // Inner has a status field that uses a CEL macro with a lambda variable
  // (`c` in `.exists(c, c.type == "Ready")`). The classifier and resolver
  // must not mistake `c` for a nested composition virtual id, and must
  // not substitute its `.status.X` accesses with arbitrary nested CEL.
  const innerComp = kubernetesComposition(
    {
      name: 't12-inner',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T12Inner',
      spec: type({ name: 'string' }),
      status: type({ available: 'boolean' }),
    },
    (spec) => {
      const d = Deployment({ name: spec.name, image: 'nginx', id: 't12Deploy' });
      return {
        // Uses a lambda variable `c` that should not be confused with
        // a nested composition reference.
        available: Cel.expr<boolean>(
          d.status.conditions,
          '.exists(c, c.type == "Available" && c.status == "True")'
        ),
      };
    }
  );

  const outerComp = kubernetesComposition(
    {
      name: 't12-outer',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T12Outer',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      const i = innerComp({ name: spec.name });
      return { ready: i.status.available };
    }
  );

  it('lambda body is preserved verbatim in the outer YAML (no spurious substitution of c.status)', () => {
    const parsed = parseRgd(outerComp.toYaml());
    const ready = String(parsed.spec.schema.status?.ready ?? '');
    // The lambda variable `c` and its `.status.` access must be intact.
    expect(ready).toContain('exists(c,');
    expect(ready).toContain('c.status');
    expect(ready).toContain('c.type');
  });

  it('lambda variables do not cause spurious dangling resource refs (I6)', () => {
    const parsed = parseRgd(outerComp.toYaml());
    const ids = getResourceIds(parsed);
    const refs = extractResourceStatusRefs(parsed);
    // Filter out lambda-variable refs — `c.status.X` is not a resource id.
    // The strict check is "every non-lambda <id>.status.X must point to
    // a real resource".
    const nonLambdaDangling = refs.filter(
      ({ id }) => id !== 'c' && id !== 'each' && !ids.has(id)
    );
    expect(nonLambdaDangling).toEqual([]);
  });
});

describe('T13 — nested CelExpression resource refs resolve through nested-id remapping', () => {
  const innerComp = kubernetesComposition(
    {
      name: 't13-inner',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T13Inner',
      spec: type({ name: 'string' }),
      status: type({ appUrl: 'string' }),
    },
    (spec) => {
      Deployment({ name: spec.name, image: 'nginx', id: 't13Deploy' });
      ConfigMap({ name: `${spec.name}-cfg`, data: { mode: 'on' }, id: 't13Config' });
      return { appUrl: `http://${spec.name}:80` };
    }
  );

  const outerComp = kubernetesComposition(
    {
      name: 't13-outer',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'T13Outer',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      const _inner = innerComp({ name: spec.name });
      ConfigMap({
        name: `${spec.name}-consumer`,
        data: {
          direct: Cel.expr<string>('inner.status.appUrl'),
          templated: Cel.template('prefix-%s', Cel.expr<string>('inner.status.appUrl')),
        },
        id: 't13Consumer',
      });
      return { ready: true };
    }
  );

  it('does not leak virtual nested ids in bare Cel.expr resource fields', () => {
    const yamlStr = outerComp.toYaml();
    expect(yamlStr).not.toContain('inner.status.appUrl');
    expect(yamlStr).not.toContain('__KUBERNETES_REF_inner');
  });

  it('does not leak virtual nested ids in Cel.template resource fields', () => {
    const parsed = parseRgd(outerComp.toYaml());
    const consumer = parsed.spec.resources.find((resource) => resource.id === 't13Consumer');
    const data = consumer?.template?.data as Record<string, string> | undefined;

    expect(data?.direct).not.toContain('inner.status.appUrl');
    expect(data?.direct).toContain('schema.spec.name');
    expect(data?.templated).toContain('prefix-');
    expect(data?.templated).not.toContain('inner.status.appUrl');
  });
});

// =============================================================================
// Cycle detection in resolveNestedCompositionRefs
// =============================================================================

describe('resolveNestedCompositionRefs — cycle detection', () => {
  it('converges in bounded iterations even with circular references', async () => {
    // Import the function directly to test the fixed-point loop
    const { finalizeCelForKro } = await import(
      '../../src/core/serialization/cel-references.js'
    );

    // Build a nestedStatusCel table with a cycle: a → b.status.x → a.status.y
    const cyclicTable: Record<string, string> = {
      '__nestedStatus:a:x': 'b.status.y',
      '__nestedStatus:b:y': 'a.status.x',
    };

    // This should NOT hang — the depth limit should catch the cycle
    // and return whatever partial resolution was achieved.
    const result = finalizeCelForKro('a.status.x', cyclicTable);

    // The result should be a string (not throw, not hang)
    expect(typeof result).toBe('string');
    // After 16 iterations of A→B→A→B..., the expression will still
    // contain unresolved refs, but the function must return.
  });

  it('normal 2-level nesting converges in 2 passes', async () => {
    const { finalizeCelForKro } = await import(
      '../../src/core/serialization/cel-references.js'
    );

    // Level 1: outer references inner.status.ready
    // Level 2: inner.status.ready → deployment.status.readyReplicas >= 1
    const table: Record<string, string> = {
      '__nestedStatus:inner:ready': 'innerDeploy.status.readyReplicas >= 1',
    };

    const result = finalizeCelForKro('inner.status.ready', table);
    expect(result).toContain('innerDeploy.status.readyReplicas');
    expect(result).not.toContain('inner.status');
  });
});
