import { describe, expect, it } from 'bun:test';
import { type, type Type } from 'arktype';

import { TypeKroError } from '../../../src/core/errors.js';
import { specConstraint } from '../../../src/core/validation/spec-constraint.js';
import { Cel, kubernetesComposition, simple } from '../../../src/index.js';
import { admissionErrors } from '../../utils/kro-admission.js';

const PINNED_TAG = specConstraint({
  path: 'tag',
  type: type(/^v[0-9]+\.[0-9]+\.[0-9]+$/),
  code: 'TEST_TAG_NOT_PINNED',
  message: (value) => `tag must be pinned; got ${JSON.stringify(value)}`,
});

const SCOPED_ACCESS = specConstraint({
  path: 'access',
  type: type({ 'namespaces?': 'string[]', 'labels?': 'Record<string, string>' }),
  rule: '(has(self.namespaces) && size(self.namespaces) > 0) || (has(self.labels) && size(self.labels) > 0)',
  holds: (access) =>
    (access.namespaces?.length ?? 0) > 0 || Object.keys(access.labels ?? {}).length > 0,
  required: true,
  code: 'TEST_ACCESS_UNSCOPED',
  declaredWith: 'SCOPED_ACCESS.type',
  message: () => 'access must name namespaces or labels',
});

const constrained = kubernetesComposition(
  {
    name: 'spec-constraint-test',
    kind: 'SpecConstraintTest',
    spec: type({ name: 'string', tag: PINNED_TAG.type, access: SCOPED_ACCESS.type }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    PINNED_TAG.check(spec.tag);
    SCOPED_ACCESS.check(spec.access);
    simple.ConfigMap({ id: 'config', name: spec.name, data: { tag: spec.tag } });
    return { ready: true };
  }
);

const good = { name: 'demo', tag: 'v1.2.3', access: { namespaces: ['apps'] } };

describe('specConstraint', () => {
  it('admits and refuses concrete values with both halves', () => {
    expect(PINNED_TAG.admits('v1.2.3')).toBe(true);
    expect(PINNED_TAG.admits('latest')).toBe(false);
    expect(SCOPED_ACCESS.admits({ labels: { team: 'a' } })).toBe(true);
    expect(SCOPED_ACCESS.admits({})).toBe(false);
    expect(SCOPED_ACCESS.admits({ namespaces: [] })).toBe(false);
  });

  it('throws a named error for a refused concrete value and passes undefined', () => {
    expect(() => PINNED_TAG.check('latest')).toThrow(TypeKroError);
    try {
      PINNED_TAG.check('latest');
    } catch (error) {
      expect((error as TypeKroError).code).toBe('TEST_TAG_NOT_PINNED');
      expect((error as TypeKroError).message).toBe('tag must be pinned; got "latest"');
    }
    expect(() => PINNED_TAG.check(undefined)).not.toThrow();
  });

  it('refuses a rule without its TypeScript form, and two rules on one path', () => {
    expect(() =>
      specConstraint({
        path: 'x',
        type: type('string'),
        rule: 'size(self) > 0',
        code: 'X',
        message: () => 'x',
      })
    ).toThrow(/together/);
  });

  it('runs in direct mode, when the composition body sees concrete values', () => {
    expect(() => constrained({ ...good, tag: 'latest' })).toThrow(/tag must be pinned/);
    expect(() => constrained({ ...good, access: {} })).toThrow(/access must name/);
    expect(() => constrained(good)).not.toThrow();
  });

  describe('KRO mode', () => {
    const yaml = constrained.factory('kro').toYaml();

    it('puts both halves on the generated instance schema with no per-composition wiring', () => {
      expect(yaml).toContain('tag: string | pattern="^v[0-9]+\\\\.[0-9]+\\\\.[0-9]+$"');
      expect(yaml).toContain('validation="(has(self.namespaces)');
      expect(yaml).toContain('required=true');
    });

    it('refuses an instance that omits a required constrained field', () => {
      const { access: _omitted, ...withoutAccess } = good;
      expect(admissionErrors(yaml, 'SpecConstraintTest', withoutAccess)).toEqual([
        'spec.access: Required value',
      ]);
    });

    it('admits a good instance', () => {
      expect(admissionErrors(yaml, 'SpecConstraintTest', good)).toEqual([]);
    });

    it('refuses a bad instance at admission, where the body check never runs', () => {
      expect(admissionErrors(yaml, 'SpecConstraintTest', { ...good, tag: 'latest' })).toEqual([
        'spec.tag: "latest" does not match ^v[0-9]+\\.[0-9]+\\.[0-9]+$',
      ]);
      expect(admissionErrors(yaml, 'SpecConstraintTest', { ...good, access: {} })).toEqual([
        `spec.access: failed rule: ${SCOPED_ACCESS.rule}`,
      ]);
    });
  });

  describe('enforce, for a factory that takes the value from any caller', () => {
    // The thunk defines the composition, which runs its body against the schema proxy, and
    // serializes it, so a refusal at either step counts.
    const probe = (schema: Type<object>, pick: (spec: never) => unknown) => () => {
      const composition = kubernetesComposition(
        {
          name: 'enforce-probe',
          kind: 'EnforceProbe',
          spec: schema,
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          SCOPED_ACCESS.enforce(pick(spec as never));
          simple.ConfigMap({ id: 'config', name: 'probe', data: { a: 'b' } });
          return { ready: true };
        }
      );
      return composition.toYaml();
    };

    it('accepts a concrete admitted value and refuses a refused or missing one', () => {
      expect(() => SCOPED_ACCESS.enforce({ namespaces: ['apps'] })).not.toThrow();
      expect(() => SCOPED_ACCESS.enforce({})).toThrow(/access must name/);
      expect(() => SCOPED_ACCESS.enforce(undefined)).toThrow(/access must name/);
    });

    it('accepts a reference to a required field declared with the constrained type', () => {
      expect(
        probe(type({ access: SCOPED_ACCESS.type }), (spec: { access: unknown }) => spec.access)
      ).not.toThrow();
    });

    it('refuses a reference to an unconstrained, optional or derived field', () => {
      const unconstrained = probe(
        type({ access: { 'namespaces?': 'string[]', 'labels?': 'Record<string, string>' } }),
        (spec: { access: unknown }) => spec.access
      );
      expect(unconstrained).toThrow(/declared with SCOPED_ACCESS\.type/);
      expect(
        probe(type({ 'access?': SCOPED_ACCESS.type }), (spec: { access: unknown }) => spec.access)
      ).toThrow(/declared with SCOPED_ACCESS\.type/);
      expect(
        probe(type({ access: SCOPED_ACCESS.type }), (spec: { access: unknown }) =>
          Cel.expr('has(', spec.access, ') ? ', spec.access, ' : {}')
        )
      ).toThrow(/declared with SCOPED_ACCESS\.type/);
    });

    it('refuses an optional field declared with a constraint that requires it', () => {
      const composition = kubernetesComposition(
        {
          name: 'optional-required',
          kind: 'OptionalRequired',
          spec: type({ 'access?': SCOPED_ACCESS.type }),
          status: type({ ready: 'boolean' }),
        },
        () => {
          simple.ConfigMap({ id: 'config', name: 'probe', data: { a: 'b' } });
          return { ready: true };
        }
      );
      expect(() => composition.toYaml()).toThrow(/requires the field, but the field is optional/);
    });
  });
});
