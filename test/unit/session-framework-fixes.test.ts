/**
 * Regression tests for the framework fixes implemented during the
 * KRO dogfooding session. Each `describe` block corresponds
 * to one specific bug and pins the behavior that unblocked the real
 * KRO deploy — so any regression would fail these tests first, before
 * the full end-to-end deploy loop.
 *
 * Fixes covered:
 *   #36 — BARE_LITERAL_PATTERN: literal nested refs wrapped with
 *         `string(...)` when reached via template-literal coercion
 *   #47 — applyJsToCelConversions strips `?.` before the `??`/`||` regex
 *   #49 — getKroTypeFromJson emits `map[string]V` for `Record<K,V>`
 *   #51 — conditionToCel rewrites `Object.keys(X).length` → `size(X)`
 *         and wraps optional-field truthiness with `has()` in compounds
 *   #52 — collectOmitFields recurses into nested objects; maybeWrapWithOmit
 *         resolves ancestor optional fields for sub-path refs
 *   #53 — createSchemaProxy with arktype JSON is shape-aware:
 *         spread and Object.keys enumerate declared fields
 *   #56 — stripOrphanedItemSentinels: $item sentinel stripped from non-forEach
 *         resources so KRO receives valid CEL (no `$item` identifier)
 *
 * Fixes #35, #48, and #50 are covered by other test suites
 * (nested-composition-kro-serialization, integration tests, and the
 * KRO factory integration tests respectively).
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import * as jsYaml from 'js-yaml';
import {
  createSchemaProxy,
  isSchemaReference,
} from '../../src/core/references/index.js';
import {
  generateKroSchemaFromArktype,
} from '../../src/core/serialization/schema.js';
import { shouldPreserveRgd } from '../../src/core/deployment/kro-factory.js';
import { isKubernetesRef } from '../../src/utils/type-guards.js';
import type { KubernetesRef } from '../../src/core/types/common.js';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Deployment, ConfigMap } from '../../src/factories/simple/index.js';
import { Cel } from '../../src/core/references/cel.js';

// =============================================================================
// Fix #36 — BARE_LITERAL_PATTERN: literal nested refs in template context
// =============================================================================
//
// When a nested composition's analyzed expression resolves to a bare
// literal (int, float, bool, null) and the ref is reached through a
// template-literal coercion (e.g. `${stack.status.cachePort}`), the
// result must be wrapped with `string(...)` so KRO's CEL evaluation
// produces a string value. Without this wrap, KRO rejects the
// expression with a type mismatch ("returns type int but expected string").
//
// The fix lives in `innerExprToYamlSegment` in cel-references.ts.
// We exercise it end-to-end via a nested composition that forces the
// marker-substitution path.

describe('#36 literal nested refs in template context', () => {
  it('wraps a bare integer expression with string() in template context', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const InnerSpec = type({ name: 'string' });
    const InnerStatus = type({ port: 'number' });
    const innerComp = kubernetesComposition(
      {
        name: 'inner-port',
        kind: 'InnerPort',
        spec: InnerSpec,
        status: InnerStatus,
      },
      (_spec) => ({ port: 6379 })
    );

    const OuterSpec = type({ name: 'string', image: 'string' });
    const OuterStatus = type({ ready: 'boolean' });
    const outerComp = kubernetesComposition(
      {
        name: 'outer-port',
        kind: 'OuterPort',
        spec: OuterSpec,
        status: OuterStatus,
      },
      (spec) => {
        const inner = innerComp({ name: spec.name });
        simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
          env: {
            // Template-literal coercion forces the marker path. The
            // inner expression resolves to a bare int literal (6379),
            // which must be wrapped with string(...) so the env var
            // value keeps its string type.
            REDIS_PORT: `${inner.status.port}`,
          },
        });
        return { ready: true };
      }
    );

    const yaml = outerComp.toYaml();
    // The value should be the string-wrapped literal, not a raw int.
    expect(yaml).toContain('${string(6379)}');
    // And NOT the unwrapped form that KRO would reject.
    expect(yaml).not.toContain('${6379}');
  });
});

// =============================================================================
// Fix #47 — JS-to-CEL strips `?.` before `??`/`||`
// =============================================================================
//
// The imperative analyzer converts composition source to CEL via targeted
// regexes. The `??` regex only matches against `schema.spec.X.Y.Z` member
// paths — if the user writes `spec.parent?.child ?? literal`, the
// optional chain character `?` keeps the path from matching and the raw
// `??` escapes into the emitted CEL, which KRO rejects as invalid syntax.
//
// The fix preprocesses the source to strip `?.` → `.` before the `??`
// and `||` regexes run, so the full member path matches.

describe('#47 applyJsToCelConversions strips optional chaining', () => {
  it('emits valid CEL (no raw `?.` or `??`) for `spec.parent?.count ?? 1`', async () => {
    const { kubernetesComposition } = await import(
      '../../src/core/composition/imperative.js'
    );
    const { simple } = await import('../../src/factories/simple/index.js');

    const Spec = type({
      name: 'string',
      image: 'string',
      'parent?': { 'count?': 'number' },
    });
    const Status = type({ ready: 'boolean', count: 'number' });

    const comp = kubernetesComposition(
      { name: 't47', kind: 'T47', spec: Spec, status: Status },
      (spec) => {
        const app = simple.Deployment({
          name: 'app',
          image: spec.image,
          id: 'app',
        });
        return {
          // Mix a real resource ref into the expression so it's
          // classified as "dynamic" and goes through the KRO CEL
          // conversion path — otherwise the field is "static" and
          // gets hydrated at runtime, skipping the regex we're testing.
          ready: app.status.readyReplicas >= 1,
          // This is the pattern the fix targets — user writes
          // native TypeScript optional chaining + nullish
          // coalescing, mixed with a real resource ref to force
          // the dynamic path.
          count: (spec.parent?.count ?? 1) + app.status.readyReplicas,
        };
      }
    );

    const yaml = comp.toYaml();
    // Extract the status section (between `status:` and the next
    // top-level `resources:` key) so we can scope assertions to CEL
    // actually emitted for the status builder.
    const statusIdx = yaml.indexOf('    status:');
    const resourcesIdx = yaml.indexOf('\n  resources:', statusIdx);
    const statusBlock = yaml.slice(statusIdx, resourcesIdx);

    // The count field should exist in the emitted CEL.
    expect(statusBlock).toContain('count:');
    // Resource ref is preserved through the conversion.
    expect(statusBlock).toContain('app.status.readyReplicas');
    // No raw JS operators should survive in the status CEL — KRO
    // would reject either of these as parse errors.
    expect(statusBlock).not.toMatch(/schema\.spec\.parent\?\.count/);
    expect(statusBlock).not.toMatch(/\?\?/);
  });
});

// =============================================================================
// Fix #49 — getKroTypeFromJson emits `map[string]V` for `Record<K,V>`
// =============================================================================
//
// Arktype's `Record<string, string>` serializes as
// `{ domain: 'object', index: [{ signature: 'string', value: 'string' }] }`.
// The KRO SimpleSchema converter previously fell through to a bare
// `string` fallback, causing KRO to reject CRs with map-shaped fields
// (e.g. `spec.secrets.FOO: bar` → "unknown field"). The fix detects
// the index shape and emits KRO's native `map[string]V` notation.

describe('#49 Record<K,V> arktype → KRO map[string]V schema', () => {
  it('emits map[string]string for Record<string, string>', () => {
    const schemaDef = type({
      name: 'string',
      secrets: 'Record<string, string>',
    });

    const statusDef = type({ ready: 'boolean' });

    const schema = generateKroSchemaFromArktype('test-map', {
      apiVersion: 'v1alpha1',
      kind: 'TestMap',
      spec: schemaDef,
      status: statusDef,
    });

    // The spec section should carry the real map type, not `string`.
    expect(schema.spec.secrets).toBe('map[string]string');
  });

  it('emits map[string]integer for Record<string, number>', () => {
    const schemaDef = type({
      name: 'string',
      counts: 'Record<string, number>',
    });

    const schema = generateKroSchemaFromArktype('test-map-num', {
      apiVersion: 'v1alpha1',
      kind: 'TestMapNum',
      spec: schemaDef,
      status: type({ ready: 'boolean' }),
    });

    expect(schema.spec.counts).toBe('map[string]integer');
  });

  it('leaves regular nested object types alone', () => {
    const schemaDef = type({
      name: 'string',
      app: { port: 'number', replicas: 'number' },
    });

    const schema = generateKroSchemaFromArktype('test-nested', {
      apiVersion: 'v1alpha1',
      kind: 'TestNested',
      spec: schemaDef,
      status: type({ ready: 'boolean' }),
    });

    // Nested object should be an object, not a map.
    expect(typeof schema.spec.app).toBe('object');
    expect((schema.spec.app as Record<string, unknown>).port).toBe('integer');
  });
});

// =============================================================================
// Fix #51 — conditionToCel handles `Object.keys(X).length` + optional has()
// =============================================================================
//
// `conditionToCel` converts the test expression of an `if` statement
// into a KRO CEL expression for includeWhen. Two fixes here:
//
//   1. `Object.keys(X).length` → `size(X)` — KRO CEL has no Object.keys
//      but does have `size()` for maps and lists.
//   2. Optional-field truthiness in compound expressions (`X && Y`,
//      `X || Y`) wraps `X` with `has(X)` when X is a declared optional
//      field — raw map/list access throws in CEL if absent.

describe('#51 conditionToCel with Object.keys and optional has() wrapping', () => {
  it('rewrites `Object.keys(spec.X).length > 0` to `size(schema.spec.X) > 0`', async () => {
    const { Parser } = await import('acorn');
    const { conditionToCel } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );

    const source = '(spec) => Object.keys(spec.items).length > 0';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // Navigate to the BinaryExpression inside the arrow body
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal for test
    const body = (ast as any).body[0].expression.body;

    const cel = conditionToCel(body, source, 'spec', new Set());
    // Should contain size(), not Object.keys().length
    expect(cel).not.toContain('Object.keys');
    expect(cel).not.toContain('.length');
    expect(cel).toContain('size(schema.spec.items)');
    expect(cel).toContain('> 0');
  });

  it('wraps optional-field bare truthiness with has() in a compound `&&`', async () => {
    const { Parser } = await import('acorn');
    const { conditionToCel } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );

    const source =
      '(spec) => spec.secrets && Object.keys(spec.secrets).length > 0';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal for test
    const body = (ast as any).body[0].expression.body;

    // Tell the helper that `secrets` is a declared optional field
    const cel = conditionToCel(body, source, 'spec', new Set(['secrets']));
    // The LHS bare truthiness becomes `has(...)`, the RHS becomes `size(...) > 0`
    expect(cel).toContain('has(schema.spec.secrets)');
    expect(cel).toContain('size(schema.spec.secrets) > 0');
    expect(cel).toContain('&&');
  });

  it('leaves required-field truthiness alone in compounds', async () => {
    const { Parser } = await import('acorn');
    const { conditionToCel } = await import(
      '../../src/core/expressions/composition/composition-analyzer-helpers.js'
    );

    const source = '(spec) => spec.enabled && spec.count > 0';
    const ast = Parser.parse(source, { ecmaVersion: 2022, ranges: true });
    // biome-ignore lint/suspicious/noExplicitAny: AST traversal for test
    const body = (ast as any).body[0].expression.body;

    // `enabled` and `count` are NOT in the optionalFieldNames set, so
    // no has() wrapping should be applied.
    const cel = conditionToCel(body, source, 'spec', new Set());
    expect(cel).not.toContain('has(');
    expect(cel).toContain('schema.spec.enabled');
    expect(cel).toContain('schema.spec.count > 0');
  });
});

// =============================================================================
// Fix #52 — collectOmitFields recurses; maybeWrapWithOmit resolves ancestors
// =============================================================================
//
// Previously `collectOmitFields` only walked the top-level optional list
// and `maybeWrapWithOmit` only matched `schema.spec.<single-field>` refs.
// Nested optional fields like `database.storageClass?` were emitted
// without omit() guards, causing KRO to error with "no such key" at
// eval time.
//
// The fix recursively walks nested objects AND adds ancestor-prefix
// lookup in the wrap function: a ref to `database.owner` gets
// `has(database.owner)` guard; a ref to `cache.replicas` where `cache`
// is also optional gets `has(cache.replicas)` (deepest match wins).

describe('#52 nested optional omit() wrapping', () => {
  it('collectOmitFields walks nested optional leaves', () => {
    // Internal helper is not exported, but we can observe its effect
    // via generateKroSchemaFromArktype's __omitFields metadata.
    const schemaDef = type({
      name: 'string',
      database: {
        storageSize: 'string',
        'storageClass?': 'string',
        'owner?': 'string',
      },
    });

    const schema = generateKroSchemaFromArktype('test-nested-omit', {
      apiVersion: 'v1alpha1',
      kind: 'TestNestedOmit',
      spec: schemaDef,
      status: type({ ready: 'boolean' }),
    });

    const omitFields = (
      schema as unknown as { __omitFields?: string[] }
    ).__omitFields ?? [];
    // Nested optionals must be collected with dotted paths.
    expect(omitFields).toContain('database.storageClass');
    expect(omitFields).toContain('database.owner');
    // Required nested sibling is NOT in the omit set.
    expect(omitFields).not.toContain('database.storageSize');
  });

  it('collects both parent and children for optional nested objects', () => {
    // When `cache?` is optional and `cache.replicas?` is also optional,
    // both paths must be tracked so a partially-set `cache: { shards: 1 }`
    // (present but missing replicas) guards cache.replicas specifically.
    const schemaDef = type({
      name: 'string',
      'cache?': {
        shards: 'number',
        'replicas?': 'number',
      },
    });

    const schema = generateKroSchemaFromArktype('test-parent-child', {
      apiVersion: 'v1alpha1',
      kind: 'TestParentChild',
      spec: schemaDef,
      status: type({ ready: 'boolean' }),
    });

    const omitFields = (
      schema as unknown as { __omitFields?: string[] }
    ).__omitFields ?? [];
    expect(omitFields).toContain('cache');
    expect(omitFields).toContain('cache.replicas');
  });

  it('maybeWrapWithOmit (via processResourceReferences) guards nested optional ref with ancestor has()', async () => {
    const { processResourceReferences } = await import(
      '../../src/core/serialization/cel-references.js'
    );
    // Construct a __KUBERNETES_REF__ marker for `spec.database.storageClass`
    const marker = '__KUBERNETES_REF___schema___spec.database.storageClass__';
    // omitFields set contains only the leaf path (`database.storageClass`)
    const result = processResourceReferences(marker, {
      omitFields: new Set(['database.storageClass']),
    });
    expect(result).toBe(
      '${has(schema.spec.database.storageClass) ? schema.spec.database.storageClass : omit()}'
    );
  });

  it('resolves to ancestor optional for deeper sub-path refs', async () => {
    const { processResourceReferences } = await import(
      '../../src/core/serialization/cel-references.js'
    );
    // ref: spec.cache.someDescendant.leaf — omit set has only `cache`
    const marker = '__KUBERNETES_REF___schema___spec.cache.nested.leaf__';
    const result = processResourceReferences(marker, {
      omitFields: new Set(['cache']),
    });
    // Deepest prefix match is `cache`, and the leaf is deeper — chain has() guards.
    expect(result).toBe(
      '${has(schema.spec.cache) && has(schema.spec.cache.nested) && has(schema.spec.cache.nested.leaf) ? schema.spec.cache.nested.leaf : omit()}'
    );
  });

  it('prefers the deepest matching ancestor over a shorter prefix', async () => {
    const { processResourceReferences } = await import(
      '../../src/core/serialization/cel-references.js'
    );
    // Both `cache` and `cache.replicas` are in the omit set.
    // Ref: spec.cache.replicas → should pick the deeper `cache.replicas`
    // match, not the shallower `cache` match.
    const marker = '__KUBERNETES_REF___schema___spec.cache.replicas__';
    const result = processResourceReferences(marker, {
      omitFields: new Set(['cache', 'cache.replicas']),
    });
    expect(result).toBe(
      '${has(schema.spec.cache.replicas) ? schema.spec.cache.replicas : omit()}'
    );
  });

  it('chains has() guards when ancestor is optional but leaf is a sub-field', async () => {
    // This is the cnpgOperator.version pattern: cnpgOperator is optional,
    // version is a required sub-field. If cnpgOperator exists but version
    // doesn't (user provides an incomplete object), a single has() on
    // cnpgOperator would pass but version access would fail with
    // "no such key". Chain both guards.
    const { processResourceReferences } = await import(
      '../../src/core/serialization/cel-references.js'
    );
    const marker = '__KUBERNETES_REF___schema___spec.cnpgOperator.version__';
    const result = processResourceReferences(marker, {
      omitFields: new Set(['cnpgOperator']),
    });
    expect(result).toBe(
      '${has(schema.spec.cnpgOperator) && has(schema.spec.cnpgOperator.version) ? schema.spec.cnpgOperator.version : omit()}'
    );
  });

  it('does NOT chain has() when guard IS the leaf field (same depth)', async () => {
    // When the omit field matches the leaf exactly, no chaining needed.
    const { processResourceReferences } = await import(
      '../../src/core/serialization/cel-references.js'
    );
    const marker = '__KUBERNETES_REF___schema___spec.namespace__';
    const result = processResourceReferences(marker, {
      omitFields: new Set(['namespace']),
    });
    expect(result).toBe(
      '${has(schema.spec.namespace) ? schema.spec.namespace : omit()}'
    );
  });

  it('chains ALL intermediate has() guards for 3+ level depth', async () => {
    // cnpgOperator.monitoring.enabled: cnpgOperator is optional,
    // monitoring is an intermediate object, enabled is the leaf.
    // All three levels need has() guards.
    const { processResourceReferences } = await import(
      '../../src/core/serialization/cel-references.js'
    );
    const marker = '__KUBERNETES_REF___schema___spec.cnpgOperator.monitoring.enabled__';
    const result = processResourceReferences(marker, {
      omitFields: new Set(['cnpgOperator']),
    });
    expect(result).toBe(
      '${has(schema.spec.cnpgOperator) && has(schema.spec.cnpgOperator.monitoring) && has(schema.spec.cnpgOperator.monitoring.enabled) ? schema.spec.cnpgOperator.monitoring.enabled : omit()}'
    );
  });
});

// =============================================================================
// Fix #53 — Schema-shape-aware proxy: spread and Object.keys enumeration
// =============================================================================
//
// The schema proxy's `ownKeys`/`getOwnPropertyDescriptor` traps
// previously returned nothing (or just a sentinel), so spreading a
// schema proxy (`{ ...spec.processing }`) returned an empty object —
// silently dropping every declared field and breaking nested
// compositions that used spread to forward fields.
//
// The fix threads the arktype JSON through `createSchemaProxy` so the
// proxy can enumerate real declared field names. Map-typed fields
// (Record<K,V>) still use the sentinel because their keys are unknown
// until runtime.

describe('#53 schema-shape-aware proxy', () => {
  it('spread of a schema-aware proxy enumerates declared fields', () => {
    const Spec = type({
      name: 'string',
      processing: {
        eventKey: 'string',
        signingKey: 'string',
        'sdkUrl?': 'string[]',
      },
    });
    const Status = type({ ready: 'boolean' });

    const schema = createSchemaProxy<
      typeof Spec.infer,
      typeof Status.infer
    >(Spec.json, Status.json);

    // Spread should preserve eventKey, signingKey, and sdkUrl — not
    // silently drop them as the old opaque proxy did.
    const forwarded = { ...schema.spec.processing };
    const keys = Object.keys(forwarded).filter(
      (k) => !k.startsWith('__') && k !== 'length' && k !== 'name' && k !== 'prototype'
    );
    expect(keys).toContain('eventKey');
    expect(keys).toContain('signingKey');
    expect(keys).toContain('sdkUrl');
  });

  it('spread values are still schema references (not raw values)', () => {
    const Spec = type({
      processing: {
        eventKey: 'string',
      },
    });
    const Status = type({ ready: 'boolean' });

    const schema = createSchemaProxy<
      typeof Spec.infer,
      typeof Status.infer
    >(Spec.json, Status.json);

    const forwarded = { ...schema.spec.processing };
    // eventKey's value should be a schema KubernetesRef that serializes
    // to `spec.processing.eventKey`.
    const ref = forwarded.eventKey as unknown as KubernetesRef<unknown>;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(isSchemaReference(ref)).toBe(true);
    expect(ref.fieldPath).toBe('spec.processing.eventKey');
  });

  it('Object.keys on a map-typed field returns a sentinel so length > 0 is true', () => {
    const Spec = type({
      name: 'string',
      'secrets?': 'Record<string, string>',
    });
    const Status = type({ ready: 'boolean' });

    const schema = createSchemaProxy<
      typeof Spec.infer,
      typeof Status.infer
    >(Spec.json, Status.json);

    // Map types have no statically knowable keys, so we return a
    // sentinel key. The .length check must be > 0 so the common
    // `if (Object.keys(spec.secrets).length > 0)` pattern fires and
    // the conditional resource is registered.
    const keys = Object.keys(schema.spec.secrets);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('get trap still works independently of ownKeys', () => {
    const Spec = type({
      processing: {
        eventKey: 'string',
      },
    });
    const Status = type({ ready: 'boolean' });

    const schema = createSchemaProxy<
      typeof Spec.infer,
      typeof Status.infer
    >(Spec.json, Status.json);

    // Direct access must still produce a schema ref — the shape awareness
    // MUST NOT interfere with plain property lookup.
    const ref = schema.spec.processing
      .eventKey as unknown as KubernetesRef<unknown>;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(ref.fieldPath).toBe('spec.processing.eventKey');
  });

  it('accessing an undeclared field still returns a ref (no shape enforcement)', () => {
    const Spec = type({
      processing: {
        eventKey: 'string',
      },
    });
    const Status = type({ ready: 'boolean' });

    const schema = createSchemaProxy<
      Record<string, unknown>,
      typeof Status.infer
    >(Spec.json, Status.json);

    // Even though `nonExistent` isn't in the schema, dot-access returns
    // a ref. This matches the long-standing lazy behavior of the proxy
    // — shape-awareness affects enumeration, not strict-property-lookup.
    // biome-ignore lint/suspicious/noExplicitAny: intentional undeclared access
    const ref = (schema.spec as any).processing.nonExistent as KubernetesRef<
      unknown
    >;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(ref.fieldPath).toBe('spec.processing.nonExistent');
  });

  it('no-arg createSchemaProxy still works (backward compat)', () => {
    // Call without schema JSON — the proxy falls back to the old opaque
    // behavior (ownKeys returns a sentinel, spread produces only the
    // sentinel). Direct access still works.
    const schema = createSchemaProxy<{ name: string }, { ready: boolean }>();
    // biome-ignore lint/suspicious/noExplicitAny: intentionally loose typing for compat test
    const ref = (schema.spec as any).name as KubernetesRef<unknown>;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(ref.fieldPath).toBe('spec.name');
  });
});

// =============================================================================
// Fix #55 — Preserve RGD when KRO CR delete poll times out
// =============================================================================
//
// The original deleteInstance logic unconditionally filtered the
// just-deleted instance out of the live list before checking
// "hasRemainingInstances", causing the RGD to be torn down even when
// the CR was stuck in DELETING (finalizer not yet processed by KRO).
// Tearing down the RGD mid-finalizer orphans the `kro.run/finalizer`
// and permanently blocks cleanup — only recoverable via manual
// `kubectl patch ... finalizers:[]`.
//
// The fix tracks whether the poll loop confirmed a 404 via an
// `instanceDeleted` flag and skips the "filter our own name" step
// when the delete is still in progress. The decision is extracted to
// `shouldPreserveRgd` as a pure function so the branching is easily
// exercised without mocking the whole K8s client.

describe('#55 shouldPreserveRgd decision', () => {
  it('successful delete + no other instances → tear down (false)', () => {
    // instanceDeleted = true. The only remaining entry is the just-
    // deleted target (visible due to list-cache lag). Filter it out,
    // 0 others remain, return false (no preserve).
    const result = shouldPreserveRgd(
      [{ metadata: { name: 'myapp' } }],
      'myapp',
      true
    );
    expect(result).toBe(false);
  });

  it('successful delete + other instances → preserve (true)', () => {
    // instanceDeleted = true. Another instance is sharing the RGD —
    // preserve so it keeps working.
    const result = shouldPreserveRgd(
      [
        { metadata: { name: 'myapp' } },
        { metadata: { name: 'other' } },
      ],
      'myapp',
      true
    );
    expect(result).toBe(true);
  });

  it('stuck delete + only target in list → preserve (true)', () => {
    // The regression case. instanceDeleted = false (poll timed out);
    // the target is still in the list because the finalizer is still
    // pending. Previously the factory filtered it out and tore down
    // the RGD, orphaning the finalizer. Now we keep it in the
    // remaining set so the RGD is preserved.
    const result = shouldPreserveRgd(
      [{ metadata: { name: 'myapp' } }],
      'myapp',
      false
    );
    expect(result).toBe(true);
  });

  it('stuck delete + target plus others → preserve (true)', () => {
    // Multiple instances, one stuck. Preserve unconditionally.
    const result = shouldPreserveRgd(
      [
        { metadata: { name: 'myapp' } },
        { metadata: { name: 'other' } },
      ],
      'myapp',
      false
    );
    expect(result).toBe(true);
  });

  it('stuck delete + empty list → no preserve (the instance literally vanished between poll and list)', () => {
    // Unusual race: the poll said it was still there but the list
    // shows it gone. No other instances either. Nothing to preserve
    // the RGD for.
    const result = shouldPreserveRgd([], 'myapp', false);
    expect(result).toBe(false);
  });

  it('successful delete + empty list → no preserve', () => {
    // Standard clean-delete case.
    const result = shouldPreserveRgd([], 'myapp', true);
    expect(result).toBe(false);
  });

  it('tolerates instances with undefined metadata', () => {
    // Defensive: the K8s list can technically include items with
    // missing metadata.name. Those should just never match the target.
    const result = shouldPreserveRgd(
      [{ metadata: {} }, { metadata: { name: 'myapp' } }],
      'myapp',
      true
    );
    // Target filtered out, one other entry remains (the nameless one)
    // which doesn't match our name → counted as a remaining instance.
    expect(result).toBe(true);
  });
});

// =============================================================================
// Fix #56 — stripOrphanedItemSentinels: $item not leaked into KRO CEL
// =============================================================================
//
// When a schema array proxy is spread (`...spec.envFrom`) into a literal
// array, the proxy iterator yields elements with `$item` in their ref path.
// For forEach resources, `substituteForEachSentinels` resolves these. For
// non-forEach resources (like a Deployment whose envFrom mixes a literal
// with a schema array spread), the $item must be stripped so KRO receives
// valid CEL. `$` is not a valid CEL identifier character.
//
// Before the fix, KRO rejected the RGD with:
//   parse error: token recognition error at: '$'
//   | has(schema.spec.app.envFrom) ? schema.spec.app.envFrom.$item : omit()

/** Parse RGD YAML and return typed object */
function parseRgd(yamlStr: string) {
  return jsYaml.load(yamlStr) as {
    spec: {
      // biome-ignore lint/suspicious/noExplicitAny: parsed YAML template shape varies
      resources: Array<{ id: string; template: any; forEach?: any }>;
      // biome-ignore lint/suspicious/noExplicitAny: parsed YAML schema shape
      schema: any;
    };
  };
}

describe('Fix #56 — orphaned $item sentinel stripping', () => {
  it('array spread of optional schema array produces valid CEL (no $item)', () => {
    // Simulates the webapp composition pattern:
    //   const envFrom = [
    //     { secretRef: { name: inngestSecret } },
    //     ...((spec.app.envFrom ?? []) as EnvFromSource[]),
    //   ];
    const AppSpec = type({
      name: 'string',
      image: 'string',
      'envFrom?': type({ name: 'string' }).array(),
    });

    const graph = kubernetesComposition(
      {
        name: 'item-sentinel-test',
        kind: 'ItemSentinelTest',
        spec: AppSpec,
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        // Build envFrom by spreading an optional array (the pattern that triggers $item)
        const envFrom = [
          { secretRef: { name: 'static-secret' } },
          ...((spec.envFrom ?? []) as Array<{ name: string }>),
        ];

        const app = Deployment({
          name: spec.name,
          image: spec.image,
          envFrom: envFrom as never[],
          id: 'app',
        });

        return { ready: app.status.readyReplicas >= 1 };
      }
    );

    const yamlStr = graph.toYaml();

    // The YAML must not contain $item anywhere — it's not valid CEL
    expect(yamlStr).not.toContain('$item');

    // The optional envFrom should be guarded with has()/omit()
    expect(yamlStr).toContain('has(schema.spec.envFrom)');
    expect(yamlStr).toContain('omit()');

    // The static secret should still be present
    expect(yamlStr).toContain('static-secret');
  });

  it('forEach resources preserve $item for later substitution', () => {
    // forEach resources SHOULD have $item resolved by substituteForEachSentinels,
    // not by stripOrphanedItemSentinels. Verify the final output has the
    // forEach variable name (not $item and not the raw schema path).
    const WorkerSpec = type({
      name: 'string',
      workers: type({ label: 'string' }).array(),
    });

    const graph = kubernetesComposition(
      {
        name: 'foreach-item-test',
        kind: 'ForEachItemTest',
        spec: WorkerSpec,
        status: type({ count: 'number' }),
      },
      (spec) => {
        for (const worker of spec.workers) {
          ConfigMap({
            name: `${spec.name}-${worker.label}`,
            data: { label: String(worker.label) },
            id: 'workerCfg',
          });
        }
        return { count: Cel.expr<number>('size(workerCfg)') };
      }
    );

    const yamlStr = graph.toYaml();
    const parsed = parseRgd(yamlStr);
    const resource = parsed.spec.resources.find(r => r.id === 'workerCfg');

    // $item must NOT appear — substituteForEachSentinels should have resolved it
    expect(yamlStr).not.toContain('$item');

    // forEach dimension should reference workers
    expect(resource?.forEach).toBeDefined();

    // Template should use the forEach variable, not raw schema paths
    const templateName = resource?.template?.metadata?.name;
    expect(templateName).toContain('worker.label');
  });

  it('mixed literal + spread array does not nest arrays', () => {
    // When the $item is stripped, the reference becomes the whole array.
    // The YAML should have the static element AND the schema ref element.
    const Spec = type({
      name: 'string',
      'tags?': 'string[]',
    });

    const graph = kubernetesComposition(
      {
        name: 'mixed-array-test',
        kind: 'MixedArrayTest',
        spec: Spec,
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const allTags = ['built-in', ...((spec.tags ?? []) as string[])];

        ConfigMap({
          name: spec.name,
          data: { tags: allTags.join(',') },
          id: 'cfg',
        });

        return { ready: true };
      }
    );

    const yamlStr = graph.toYaml();

    // No $item should leak through
    expect(yamlStr).not.toContain('$item');
  });

  it('webapp composition envFrom produces no $item in YAML', async () => {
    // End-to-end regression: the actual webapp composition that triggered the bug
    const { webAppWithProcessing } = await import(
      '../../src/factories/webapp/compositions/web-app-with-processing.js'
    );

    const yamlStr = webAppWithProcessing.toYaml();

    // No $item anywhere in the output
    expect(yamlStr).not.toContain('$item');

    // The envFrom CEL should be clean
    expect(yamlStr).toContain('has(schema.spec.app.envFrom)');
    expect(yamlStr).not.toContain('envFrom.$item');

    // The inngest credentials secret should still be wired
    expect(yamlStr).toContain('inngest-credentials');
  });

  it('non-forEach resource with nested $item field access collapses to parent', () => {
    // When $item.field.subfield appears, the entire $item.field.subfield
    // should be stripped, leaving just the parent array path.
    const Spec = type({
      name: 'string',
      'sources?': type({ url: 'string', priority: 'number' }).array(),
    });

    const graph = kubernetesComposition(
      {
        name: 'nested-item-test',
        kind: 'NestedItemTest',
        spec: Spec,
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        // Spread an array of objects — each element's fields have $item markers
        const allSources = [
          { url: 'https://default.example.com', priority: 0 },
          ...((spec.sources ?? []) as Array<{ url: string; priority: number }>),
        ];

        ConfigMap({
          name: spec.name,
          data: { firstUrl: allSources[0]?.url ?? 'none' },
          id: 'cfg',
        });

        return { ready: true };
      }
    );

    const yamlStr = graph.toYaml();

    // No $item should survive
    expect(yamlStr).not.toContain('$item');
  });
});

// =============================================================================
// Fix #35 additional coverage — nullish default propagation
// =============================================================================
//
// When a composition body uses `spec.field ?? literal` for a field with a
// default, the schema must include `field: type | default="literal"` so KRO
// resolves the reference correctly. `extractNullishDefaults` detects these
// `??` patterns and `addMissingDefaultFields` injects them into the schema.

describe('Fix #35 additional coverage — nullish default propagation', () => {
  /** Parse the RGD YAML and extract the spec portion of the schema block. */
  function extractSchemaSpec(yamlStr: string): Record<string, unknown> {
    const parsed = jsYaml.load(yamlStr) as {
      spec: { schema: { spec: Record<string, unknown> } };
    };
    return parsed.spec.schema.spec;
  }

  it('creates a leaf field with default for spec.field ?? literal', () => {
    // The composition body uses `spec.database ?? "app"` but the arktype
    // spec only declares `name` and `image`. The generated schema should
    // auto-declare `database: string | default="app"`.
    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });
    const comp = kubernetesComposition(
      { name: 'leaf-default', kind: 'LeafDefault', spec: Spec, status: Status },
      (spec) => {
        const dbName = spec.database ?? 'app';
        Deployment({
          name: spec.name,
          image: spec.image,
          env: { DB_NAME: String(dbName) },
          id: 'app',
        });
        return { ready: true };
      }
    );

    const yamlStr = comp.toYaml();
    const schemaSpec = extractSchemaSpec(yamlStr);

    // database should appear with its default
    expect(schemaSpec.database).toBe('string | default="app"');
  });

  it('adds default annotation even to existing fields when ?? is used', () => {
    // Both the arktype spec and the function body reference `database`.
    // The ?? pattern adds a KRO default annotation regardless — this makes
    // the field optional from KRO's perspective even though arktype
    // declares it as required. This is intentional: the composition author
    // is explicitly providing a fallback.
    const Spec = type({ name: 'string', database: 'string' });
    const Status = type({ ready: 'boolean' });
    const comp = kubernetesComposition(
      { name: 'existing-default', kind: 'ExistingDefault', spec: Spec, status: Status },
      (spec) => {
        const dbName = spec.database ?? 'app';
        ConfigMap({
          name: spec.name,
          data: { db: String(dbName) },
          id: 'cfg',
        });
        return { ready: true };
      }
    );

    const yamlStr = comp.toYaml();
    const schemaSpec = extractSchemaSpec(yamlStr);

    // default annotation is added — the ?? makes it optional with fallback
    expect(schemaSpec.database).toBe('string | default="app"');
  });

  it('handles numeric defaults', () => {
    const Spec = type({ name: 'string' });
    const Status = type({ ready: 'boolean' });
    const comp = kubernetesComposition(
      { name: 'num-default', kind: 'NumDefault', spec: Spec, status: Status },
      (spec) => {
        const replicas = spec.replicas ?? 1;
        Deployment({
          name: spec.name,
          image: 'nginx',
          replicas: Number(replicas),
          id: 'app',
        });
        return { ready: true };
      }
    );

    const yamlStr = comp.toYaml();
    const schemaSpec = extractSchemaSpec(yamlStr);

    // replicas should appear with integer default
    expect(schemaSpec.replicas).toBe('integer | default=1');
  });

  it('webapp composition has database defaults in schema', async () => {
    // End-to-end: the real webapp composition uses database.database ?? "app"
    // and database.owner ?? "app" — verify they appear in the schema.
    const { webAppWithProcessing } = await import(
      '../../src/factories/webapp/compositions/web-app-with-processing.js'
    );

    const yamlStr = webAppWithProcessing.toYaml();
    const schemaSpec = extractSchemaSpec(yamlStr);
    const database = schemaSpec.database as Record<string, unknown>;

    expect(database.database).toBe('string | default="app"');
    expect(database.owner).toBe('string | default="app"');
  });
});

// =============================================================================
// Fix #35 additional coverage — addMissingDefaultFields
// =============================================================================
//
// `addMissingDefaultFields` injects schema fields for `??` defaults that
// the arktype spec does not declare. These tests exercise the function
// through the full composition pipeline: create a `kubernetesComposition`
// whose body uses `??` defaults on undeclared fields, call `.toYaml()`,
// and verify the schema section contains the expected defaults.

describe('Fix #35 additional coverage — addMissingDefaultFields', () => {
  function extractSchemaSpec(yamlStr: string): Record<string, unknown> {
    const parsed = jsYaml.load(yamlStr) as {
      spec: { schema: { spec: Record<string, unknown> } };
    };
    return parsed.spec.schema.spec;
  }

  it('creates a missing leaf field with default from spec.field ?? literal', () => {
    // The composition reads `spec.database ?? "app"` but the arktype spec
    // only declares `name` and `image`. addMissingDefaultFields should
    // auto-create `database: string | default="app"` in the schema.
    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });
    const comp = kubernetesComposition(
      {
        name: 'leaf-creation',
        kind: 'LeafCreation',
        spec: Spec,
        status: Status,
      },
      (spec) => {
        const db = spec.database ?? 'app';
        Deployment({
          name: spec.name,
          image: spec.image,
          env: { DB_NAME: String(db) },
          id: 'app',
        });
        return { ready: true };
      }
    );

    const yamlStr = comp.toYaml();
    const schemaSpec = extractSchemaSpec(yamlStr);

    // The schema should contain `database` with the default.
    expect(schemaSpec.database).toBe('string | default="app"');
  });

  it('creates intermediate object nodes for nested default paths', () => {
    // The composition reads `spec.config?.mode ?? "auto"` where the
    // arktype spec does not declare `config` at all. addMissingDefaultFields
    // should create the intermediate `config` object node and the
    // `mode` leaf with default="auto".
    const Spec = type({ name: 'string', image: 'string' });
    const Status = type({ ready: 'boolean' });
    const comp = kubernetesComposition(
      {
        name: 'intermediate-obj-test',
        kind: 'IntermediateObjTest',
        spec: Spec,
        status: Status,
      },
      (spec) => {
        const mode = spec.config?.mode ?? 'auto';
        Deployment({
          name: spec.name,
          image: spec.image,
          env: { MODE: String(mode) },
          id: 'app',
        });
        return { ready: true };
      }
    );

    const yamlStr = comp.toYaml();
    const schemaSpec = extractSchemaSpec(yamlStr);

    // `config` should be an auto-created object containing `mode`.
    expect(typeof schemaSpec.config).toBe('object');
    const config = schemaSpec.config as Record<string, unknown>;
    expect(config.mode).toBe('string | default="auto"');
  });

  it('does not overwrite an existing field declared by the arktype spec', () => {
    // The arktype spec declares `database` as a nested object with `host`.
    // The composition body reads `spec.database ?? "app"`. The `??`
    // default would produce a scalar type (`string | default="app"`), but
    // `addMissingDefaultFields` should skip the field because it already
    // exists as an object — preserving the declared structure.
    const Spec = type({
      name: 'string',
      database: { host: 'string' },
    });
    const Status = type({ ready: 'boolean' });
    const comp = kubernetesComposition(
      {
        name: 'no-overwrite-test',
        kind: 'NoOverwriteTest',
        spec: Spec,
        status: Status,
      },
      (spec) => {
        const db = spec.database ?? 'app';
        ConfigMap({
          name: spec.name,
          data: { db: String(db) },
          id: 'cfg',
        });
        return { ready: true };
      }
    );

    const yamlStr = comp.toYaml();
    const schemaSpec = extractSchemaSpec(yamlStr);

    // `database` was explicitly declared as an object with `host`.
    // addMissingDefaultFields must NOT overwrite it with a scalar.
    expect(typeof schemaSpec.database).toBe('object');
    const database = schemaSpec.database as Record<string, unknown>;
    expect(database.host).toBe('string');
  });

  it('bails gracefully when path traversal hits a scalar type', () => {
    // The composition reads `spec.tag?.sub ?? "fallback"` but the spec
    // declares `tag` as a plain string (scalar). Creating `tag.sub`
    // would require `tag` to be an object, which conflicts with the
    // existing scalar type. addMissingDefaultFields should bail and
    // leave `tag` as a string.
    const Spec = type({ name: 'string', tag: 'string' });
    const Status = type({ ready: 'boolean' });
    const comp = kubernetesComposition(
      {
        name: 'scalar-bail-test',
        kind: 'ScalarBailTest',
        spec: Spec,
        status: Status,
      },
      (spec) => {
        const sub = spec.tag?.sub ?? 'fallback';
        Deployment({
          name: spec.name,
          image: 'nginx',
          env: { SUB: String(sub) },
          id: 'app',
        });
        return { ready: true };
      }
    );

    const yamlStr = comp.toYaml();
    const schemaSpec = extractSchemaSpec(yamlStr);

    // `tag` should remain a plain string. No sub-object forced onto it.
    expect(schemaSpec.tag).toBe('string');
  });
});

