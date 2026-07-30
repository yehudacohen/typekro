/**
 * Arktype `object` → KRO `object` in the core type converter.
 *
 * Arktype represents a bare `type('object')` as the STRING "object" — not as `{ domain: "object" }`, which
 * the converter's object branch already handled. The primitive switch had no case for it, so it fell through
 * to the `'string'` default and EVERY schemaless-object field was declared `string` in the generated RGD.
 * KRO admission then pruned whatever object a caller sent, silently: no error, no warning, the field simply
 * arrived empty.
 *
 * KRO models `object` as schemaless (`type: object` with `x-kubernetes-preserve-unknown-fields: true`), so
 * the correct representation already existed; only the mapping was missing.
 *
 * This is a CORE bug, not a Dagster one — every factory using `type('object')` for chart/config passthrough
 * (Dagster, APISIX, Ory, ClickHouse) was affected.
 */
import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { arktypeToKroSchema } from '../../src/core/serialization/schema.js';

const specTypes = (spec: ReturnType<typeof type>): Record<string, unknown> => {
  const out = arktypeToKroSchema('Probe', {
    apiVersion: 'test.typekro.io/v1alpha1',
    kind: 'Probe',
    spec: spec as never,
    status: type({ 'ready?': 'boolean' }) as never,
  });
  return (out as unknown as { spec: Record<string, unknown> }).spec;
};

describe('arktype object primitive → KRO object', () => {
  test('maps a bare `object` to KRO `object`, not `string`', () => {
    expect(specTypes(type({ 'values?': 'object' })).values).toBe('object');
  });

  test('maps `object[]` to `[]object` — the array branch recurses through the same switch', () => {
    expect(specTypes(type({ 'items?': 'object[]' })).items).toBe('[]object');
  });

  test('a required `object` is still `object` (optionality must not change the type)', () => {
    expect(specTypes(type({ values: 'object' })).values).toBe('object');
  });

  test('leaves the other primitives alone', () => {
    const t = specTypes(type({ 'a?': 'string', 'b?': 'boolean', 'c?': 'number' }));
    expect(t.a).toBe('string');
    expect(t.b).toBe('boolean');
    // `number` maps to KRO `float`; only an integer-divisor node becomes `integer`.
    expect(t.c).toBe('float');
  });

  test('does not regress the STRUCTURED object forms, which took a different branch already', () => {
    // `{ domain: 'object', index: [...] }` — a real string map stays a typed map, NOT opaque, so a
    // Secret-annotations-style field keeps rejecting non-string values.
    expect(specTypes(type({ 'tags?': 'Record<string, string>' })).tags).toBe('map[string]string');
    // A nested shape stays a nested schema rather than collapsing to opaque.
    // (KRO SimpleSchema carries optionality separately, so the emitted keys have no `?` suffix.)
    const nested = specTypes(type({ 'image?': { repository: 'string', 'tag?': 'string' } }));
    expect(nested.image).toEqual({ repository: 'string', tag: 'string' });
  });

  test('`Record<string, unknown>` remains opaque `object` (the pre-existing passthrough form)', () => {
    expect(specTypes(type({ 'free?': 'Record<string, unknown>' })).free).toBe('object');
  });
});
