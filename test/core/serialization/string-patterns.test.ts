import { describe, expect, it } from 'bun:test';
import { type, type Type } from 'arktype';
import { load } from 'js-yaml';

import { kubernetesComposition, simple } from '../../../src/index.js';

describe('KRO string pattern serialization', () => {
  it('preserves compatible RE2 patterns and string length constraints', () => {
    const schema = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and(
      'string <= 46',
    );

    expect(rgd(schema)).toContain(
      'name: string | maxLength=46 pattern="^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$"'
    );
  });

  it('escapes backslashes and quotes for the KRO SimpleSchema string', () => {
    expect(rgd(type(/^[a-z]+\.example$/))).toContain(
      'pattern="^[a-z]+\\\\.example$"'
    );
    expect(rgd(type(/^"quoted"$/))).toContain(
      'pattern="^\\"quoted\\"$"'
    );
  });

  it('fails closed for intersecting patterns that KRO cannot preserve as one marker', () => {
    const intersection = type(/^[a-z]+$/).and(/^[^x]+$/);

    expect(() => rgd(intersection)).toThrow(
      /supports one string pattern per field/,
    );
  });

  it('fails before emission for JavaScript lookarounds unsupported by Kubernetes RE2', () => {
    for (const pattern of [
      /^(?!foo)[a-z]+$/,
      /^(?=foo)[a-z]+$/,
      /(?<=foo)bar/,
      /(?<!foo)bar/,
    ]) {
      expect(() => rgd(type(pattern))).toThrow(
        /not compatible with Kubernetes RE2 validation/,
      );
    }
  });

  it('fails before emission for numeric and named backreferences', () => {
    for (const pattern of [/^(a)\1$/, /^(?<value>a)\k<value>$/]) {
      expect(() => rgd(type(pattern))).toThrow(
        /not compatible with Kubernetes RE2 validation/,
      );
    }
  });

  it('fails before emission for JavaScript escapes rejected by Kubernetes RE2', () => {
    expect(() => rgd(type(/^\u0061$/))).toThrow(
      /invalid escape sequence.*\\u/,
    );
  });

  it('fails closed for flagged ArkType patterns instead of discarding them', () => {
    expect(() => rgd(type(/foo/i))).toThrow(
      /uses JavaScript flags "i".*cannot preserve/,
    );
  });

  it('keeps the KRO constraint when a factory configures a custom message', () => {
    // ArkType serializes a constraint carrying `.configure({ message })` as
    // `{ rule, meta }` rather than as the bare rule. Reading the field without
    // unwrapping that silently DROPS the constraint, so a factory explaining
    // its limit to the caller would stop enforcing that limit at admission —
    // the one place the explanation cannot reach.
    const schema = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and(
      type.string.atMostLength(46).configure({ message: 'at most 46 characters, because a Pod name reserves 17' }),
    );

    expect(rgd(schema)).toContain(
      'name: string | maxLength=46 pattern="^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$"'
    );
    expect(String(schema('a'.repeat(47)))).toBe(
      'at most 46 characters, because a Pod name reserves 17'
    );
  });

  it('preserves constraints on array elements and on the array itself', () => {
    const schema = type({ names: 'string > 0[] > 0' });
    const spec = kroSpec(schema);

    // KRO applies the markers after `|` to the field, and refuses minLength on
    // a list, so the element constraint lives on a named custom type.
    const itemType = /^\[\](\w+) \| minItems=1$/.exec(String(spec.fields.names))?.[1];
    expect(itemType).toStartWith('StringPatternObjectTestNamesItem');
    expect(spec.types[itemType ?? '']).toBe('string | minLength=1');
  });

  // Each list must keep its own item type: a shared name would hand one list
  // the other's constraint.
  for (const [label, schema, paths] of [
    [
      'siblings that differ only in case',
      type({ trustedIps: '(string <= 5)[]', trustedIPs: '(string > 2)[]' }),
      [['trustedIps'], ['trustedIPs']],
    ],
    [
      'nested fields under parents that differ only in case',
      type({ ab: { c: '(string <= 5)[]' }, aB: { c: '(string > 2)[]' } }),
      [
        ['ab', 'c'],
        ['aB', 'c'],
      ],
    ],
    [
      'paths that differ only in where the underscore is',
      type({ a_b: { c: '(string <= 5)[]' }, a: { b_c: '(string > 2)[]' } }),
      [
        ['a_b', 'c'],
        ['a', 'b_c'],
      ],
    ],
  ] as const) {
    it(`gives each list its own item type: ${label}`, () => {
      const spec = kroSpec(schema);
      const [first, second] = paths.map((path) => itemTypeAt(spec, path));
      expect(first).not.toBe(second);
      expect(spec.types[first ?? '']).toBe('string | maxLength=5');
      expect(spec.types[second ?? '']).toBe('string | minLength=3');
    });
  }

  it('keeps a list item type apart from a validated structured field of the same stem', () => {
    const spec = kroSpec(type({ foo: '(string <= 5)[]', foo_item: { x: 'string' } }), {
      foo_item: 'has(self.x)',
    });
    const itemType = itemTypeAt(spec, ['foo']);
    expect(spec.fields.foo_item).toBe('StringPatternObjectTestFooItem | validation="has(self.x)"');
    expect(itemType).not.toBe('StringPatternObjectTestFooItem');
    expect(spec.types[itemType ?? '']).toBe('string | maxLength=5');
    expect(spec.types.StringPatternObjectTestFooItem).toEqual({ x: 'string' });
  });

  it('keeps type names to letters and digits, whatever the field key holds', () => {
    const spec = kroSpec(type({ 'a|b': '(string <= 5)[]', 'c.d e': '(string <= 5)[]' }));
    for (const key of ['a|b', 'c.d e']) {
      expect(itemTypeAt(spec, [key])).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('refuses two validated structured fields whose type names would clash', () => {
    expect(() =>
      kroSpec(type({ a_b: { c: { x: 'string' } }, a: { b_c: { y: 'number' } } }), {
        'a_b.c': 'has(self.x)',
        'a.b_c': 'has(self.y)',
      })
    ).toThrow(/would replace a different type of the same name/);
  });
});

interface KroSpecView {
  readonly fields: Record<string, unknown>;
  readonly types: Record<string, unknown>;
}

/** The KRO SimpleSchema `spec` and `types` the RGD carries for `schema`. */
function kroSpec(
  schema: Type<object>,
  schemaFieldValidations?: Record<string, string>
): KroSpecView {
  const yaml = kubernetesComposition(
    {
      name: 'string-pattern-object-test',
      kind: 'StringPatternObjectTest',
      spec: schema,
      status: type({ ready: 'boolean' }),
    },
    () => ({ ready: true }),
    schemaFieldValidations ? { schemaFieldValidations } : undefined
  )
    .factory('kro')
    .toYaml();
  const schemaNode = ['spec', 'schema'].reduce<unknown>(
    (node, key) => (typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined),
    load(yaml)
  );
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};
  return {
    fields: record(Reflect.get(record(schemaNode), 'spec')),
    types: record(Reflect.get(record(schemaNode), 'types')),
  };
}

function itemTypeAt(spec: KroSpecView, path: readonly string[]): string | undefined {
  let node: unknown = spec.fields;
  for (const segment of path) {
    node = typeof node === 'object' && node !== null ? Reflect.get(node, segment) : undefined;
  }
  return /^\[\](\w+)/.exec(String(node))?.[1];
}

function rgd(nameSchema: Type<string>): string {
  return kubernetesComposition(
    {
      name: 'string-pattern-test',
      kind: 'StringPatternTest',
      spec: type({ name: nameSchema }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      simple.ConfigMap({
        id: 'metadata',
        name: spec.name,
        data: { name: spec.name },
      });
      return { ready: true };
    },
  ).factory('kro').toYaml();
}
