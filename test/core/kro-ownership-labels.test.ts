import { describe, expect, test } from 'bun:test';
import {
  isKroOwnershipLabel,
  KRO_OWNERSHIP_LABELS,
} from '../../src/core/kro/labels.js';
import { KRO_OWNERSHIP_LABELS as KRO_OWNERSHIP_LABELS_FROM_ROOT } from '../../src/index.js';

describe('KRO_OWNERSHIP_LABELS', () => {
  test('pins the exact label set and its order', () => {
    // This set is a contract: it is what `labelPropagationGuard()` strips and
    // what operator-side propagation filters are configured with. Adding or
    // removing a key changes cluster behaviour, so the change must be
    // deliberate enough to update this assertion.
    expect([...KRO_OWNERSHIP_LABELS]).toEqual([
      'applyset.kubernetes.io/part-of',
      'applyset.kubernetes.io/id',
      'kro.run/owned',
      'kro.run/node-id',
      'kro.run/kro-version',
    ]);
  });

  test('contains no duplicates', () => {
    expect(new Set(KRO_OWNERSHIP_LABELS).size).toBe(KRO_OWNERSHIP_LABELS.length);
  });

  test('includes kro.run/kro-version — the upgrade-time selector desync key', () => {
    // A KRO upgrade rewrites this value on the parent CR. An operator that
    // re-copies the parent label map onto a Service selector or pod template
    // then moves the selector to a value no running pod carries.
    expect(KRO_OWNERSHIP_LABELS).toContain('kro.run/kro-version');
  });

  test('excludes app.kubernetes.io/managed-by', () => {
    // KRO 0.9.2 overwrites it with `kro` on graph children, but it carries no
    // ownership meaning for the pruner and operators set it legitimately.
    expect(KRO_OWNERSHIP_LABELS).not.toContain('app.kubernetes.io/managed-by');
  });

  test('every key is a valid Kubernetes label key', () => {
    // prefix/name, prefix a DNS subdomain, name <= 63 chars of [A-Za-z0-9._-]
    const labelKey = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
    for (const key of KRO_OWNERSHIP_LABELS) {
      expect(key).toMatch(labelKey);
      const name = key.split('/')[1] ?? '';
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  test('isKroOwnershipLabel narrows membership', () => {
    for (const key of KRO_OWNERSHIP_LABELS) {
      expect(isKroOwnershipLabel(key)).toBe(true);
    }
    expect(isKroOwnershipLabel('app.kubernetes.io/managed-by')).toBe(false);
    expect(isKroOwnershipLabel('kro.run/owned-by')).toBe(false);
    expect(isKroOwnershipLabel('')).toBe(false);
  });

  test('is re-exported from the package root', () => {
    expect(KRO_OWNERSHIP_LABELS_FROM_ROOT).toBe(KRO_OWNERSHIP_LABELS);
  });
});
