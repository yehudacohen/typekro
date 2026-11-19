import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { TypeKroError } from '../../../src/core/errors.js';
import {
  specConstraint,
  specConstraintValidations,
} from '../../../src/core/validation/spec-constraint.js';
import { kubernetesComposition, simple } from '../../../src/index.js';
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
  code: 'TEST_ACCESS_UNSCOPED',
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
  },
  { schemaFieldValidations: specConstraintValidations(PINNED_TAG, SCOPED_ACCESS) }
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
    expect(() => specConstraintValidations(SCOPED_ACCESS, SCOPED_ACCESS)).toThrow(/combine/);
  });

  it('runs in direct mode, when the composition body sees concrete values', () => {
    expect(() => constrained({ ...good, tag: 'latest' })).toThrow(/tag must be pinned/);
    expect(() => constrained({ ...good, access: {} })).toThrow(/access must name/);
    expect(() => constrained(good)).not.toThrow();
  });

  describe('KRO mode', () => {
    const yaml = constrained.factory('kro').toYaml();

    it('puts both halves on the generated instance schema', () => {
      expect(yaml).toContain('tag: string | pattern="^v[0-9]+\\\\.[0-9]+\\\\.[0-9]+$"');
      expect(yaml).toContain('validation="(has(self.namespaces)');
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
});
