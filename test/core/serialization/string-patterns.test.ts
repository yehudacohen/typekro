import { describe, expect, it } from 'bun:test';
import { type, type Type } from 'arktype';

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

    expect(rgdObject(schema)).toContain(
      "names: '[]string | minLength=1 | minItems=1'",
    );
  });
});

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

function rgdObject(schema: Type<object>): string {
  return kubernetesComposition(
    {
      name: 'string-pattern-object-test',
      kind: 'StringPatternObjectTest',
      spec: schema,
      status: type({ ready: 'boolean' }),
    },
    () => ({ ready: true }),
  ).factory('kro').toYaml();
}
