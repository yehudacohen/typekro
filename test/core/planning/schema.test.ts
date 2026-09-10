import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { encodeSchemaIR, schemaToIR } from '../../../src/core/planning/schema.js';

describe('SchemaIR portable profile', () => {
  it('preserves optionality, defaults, unions, arrays, patterns, lengths, and bounds', () => {
    const schema = type({
      count: 'number >= 1',
      mode: '"safe" | "fast"',
      name: /^[a-z]+$/,
      tags: 'string[]',
      'description?': 'string >= 2',
      region: type('string').default('us-east-1'),
    });

    const result = schemaToIR(schema, { strict: true });

    expect(result.root.kind).toBe('object');
    if (result.root.kind !== 'object') throw new Error('Expected object schema');
    expect(result.root.properties.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'count', required: true },
      { name: 'description', required: false },
      { name: 'mode', required: true },
      { name: 'name', required: true },
      { name: 'region', required: false },
      { name: 'tags', required: true },
    ]);
    expect(
      result.root.properties.find((property) => property.name === 'region')?.defaultValue
    ).toEqual({ kind: 'literal', value: 'us-east-1' });
    expect(result.diagnostics).toEqual([]);
    expect(encodeSchemaIR(result)).toContain(result.digest);
  });

  it('lowers a constraint carrying a custom message, and keeps the message out of the IR', () => {
    // A factory that explains a derived limit to its caller configures the
    // message on the constraint, which makes ArkType serialize it as
    // `{ rule, meta }`. Reading that without unwrapping rejects the whole
    // composition as "outside the portable planning profile" — and the message
    // itself is prose, so it must not reach the IR digest either.
    const schema = type({
      name: type(/^[a-z]+$/).and(
        type.string.atMostLength(46).configure({ message: 'at most 46 characters' }),
      ),
    });

    const result = schemaToIR(schema, { strict: true });

    expect(result.diagnostics).toEqual([]);
    if (result.root.kind !== 'object') throw new Error('Expected object schema');
    const name = result.root.properties.find((property) => property.name === 'name');
    expect(name?.schema).toEqual({
      kind: 'primitive',
      type: 'string',
      constraints: { maxLength: 46, pattern: ['^[a-z]+$'] },
    });
    expect(encodeSchemaIR(result)).not.toContain('at most 46 characters');
  });

  it('is stable across equivalent object key order', () => {
    const left = schemaToIR(type({ b: 'boolean', a: 'string' }));
    const right = schemaToIR(type({ a: 'string', b: 'boolean' }));

    expect(left.digest).toBe(right.digest);
  });

  it('preserves explicitly open object and collection element schemas', () => {
    const result = schemaToIR(
      type({
        payload: 'object',
        items: 'object[]',
      }),
      { strict: true }
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.root).toEqual({
      kind: 'object',
      additionalProperties: true,
      properties: [
        {
          name: 'items',
          required: true,
          schema: {
            kind: 'array',
            items: {
              kind: 'object',
              properties: [],
              additionalProperties: true,
            },
          },
        },
        {
          name: 'payload',
          required: true,
          schema: {
            kind: 'object',
            properties: [],
            additionalProperties: true,
          },
        },
      ],
    });
  });

  it('preserves root open-object and undeclared-key policies', () => {
    expect(schemaToIR(type('object'), { strict: true }).root).toEqual({
      kind: 'object',
      properties: [],
      additionalProperties: true,
    });
    expect(
      schemaToIR(type({ value: 'string' }).onUndeclaredKey('ignore'), {
        strict: true,
      }).root
    ).toEqual({
      kind: 'object',
      properties: [
        {
          name: 'value',
          required: true,
          schema: { kind: 'primitive', type: 'string' },
        },
      ],
      additionalProperties: true,
    });
    for (const policy of ['reject', 'delete'] as const) {
      expect(
        schemaToIR(type({ value: 'string' }).onUndeclaredKey(policy), {
          strict: true,
        }).root
      ).toEqual({
        kind: 'object',
        properties: [
          {
            name: 'value',
            required: true,
            schema: { kind: 'primitive', type: 'string' },
          },
        ],
      });
    }
  });

  it('diagnoses constructs outside the portable profile before execution', () => {
    const unsupported = { json: { domain: 'symbol' } };

    expect(schemaToIR(unsupported).diagnostics).toEqual([
      expect.objectContaining({ code: 'SCHEMA_IR_UNSUPPORTED', severity: 'error', path: '$' }),
    ]);
    expect(() => schemaToIR(unsupported, { strict: true })).toThrow(
      'outside the portable planning profile'
    );
  });
});
