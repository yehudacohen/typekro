import { describe, expect, it } from 'bun:test';

import {
  controlPlaneNamespaceFor,
  K8S_NAMESPACE_NAME_MAX_LENGTH,
} from '../../src/core/config/defaults.js';

/**
 * P2 regression: `controlPlaneNamespaceFor` blindly appended `-kro`, so a
 * workload namespace name >59 chars produced an invalid (>63-char) Kubernetes
 * namespace. It must now truncate deterministically with a short hash so the
 * result is always ≤63 chars, stable, and collision-resistant.
 */
describe('controlPlaneNamespaceFor', () => {
  it('appends the -kro suffix verbatim for short workload namespaces', () => {
    expect(controlPlaneNamespaceFor('dagster')).toBe('dagster-kro');
    expect(controlPlaneNamespaceFor('clickhouse-system')).toBe('clickhouse-system-kro');
  });

  it('never exceeds the 63-char namespace limit, even for a 60+ char workload namespace', () => {
    const longNs = 'a'.repeat(60);
    const result = controlPlaneNamespaceFor(longNs);
    expect(result.length).toBeLessThanOrEqual(K8S_NAMESPACE_NAME_MAX_LENGTH);
    expect(result.endsWith('-kro')).toBe(true);
  });

  it('is deterministic — same input yields the same result', () => {
    const longNs = `workload-${'x'.repeat(80)}`;
    expect(controlPlaneNamespaceFor(longNs)).toBe(controlPlaneNamespaceFor(longNs));
  });

  it('is distinct for distinct inputs that share a truncated prefix', () => {
    // Two long names identical for the first 60 chars but differing at the tail:
    // naive truncation would collide; the hash of the FULL name disambiguates.
    const base = 'z'.repeat(70);
    const a = controlPlaneNamespaceFor(`${base}-alpha`);
    const b = controlPlaneNamespaceFor(`${base}-beta`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(K8S_NAMESPACE_NAME_MAX_LENGTH);
    expect(b.length).toBeLessThanOrEqual(K8S_NAMESPACE_NAME_MAX_LENGTH);
  });

  it('produces a DNS-1123-valid label (no leading/trailing/doubled dashes)', () => {
    const result = controlPlaneNamespaceFor('a'.repeat(62));
    expect(result.length).toBeLessThanOrEqual(K8S_NAMESPACE_NAME_MAX_LENGTH);
    expect(result).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(result).not.toContain('--');
  });
});
