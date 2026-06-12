/**
 * Unit tests for `singletonDriftVerdict` — the pure spec-drift decision behind the alchemy KRO
 * reconcile's singleton protection. Covers the fingerprinted cases AND the legacy/unfingerprinted
 * fallback (an existing owner with no annotation is still verified by comparing specs, so a
 * different-spec unfingerprinted owner is not silently accepted).
 */
import { describe, expect, it } from 'bun:test';
import { singletonDriftVerdict } from '../../../src/alchemy/resource-registration.js';

const FP = 'fnv64:1111111111111111';
const OTHER_FP = 'fnv64:2222222222222222';
const ann = (fingerprint?: string) =>
  fingerprint ? { metadata: { annotations: { 'typekro.io/singleton-spec-fingerprint': fingerprint } } } : {};

describe('singletonDriftVerdict', () => {
  it('no existing owner → no drift', () => {
    expect(singletonDriftVerdict(FP, { name: 'a' }, undefined)).toEqual({ drift: false });
  });

  it('matching fingerprint annotation → no drift', () => {
    expect(singletonDriftVerdict(FP, { name: 'a' }, ann(FP))).toEqual({ drift: false });
  });

  it('mismatched fingerprint annotation → drift', () => {
    const v = singletonDriftVerdict(FP, { name: 'a' }, ann(OTHER_FP));
    expect(v.drift).toBe(true);
    if (v.drift) expect(v.reason).toContain(OTHER_FP);
  });

  it('unfingerprinted owner with the SAME spec → no drift (legacy owner accepted)', () => {
    const live = { ...ann(undefined), spec: { name: 'a', replicas: 2 } };
    expect(singletonDriftVerdict(FP, { name: 'a', replicas: 2 }, live)).toEqual({ drift: false });
  });

  it('unfingerprinted owner with a DIFFERENT spec → drift (the gap that slipped through)', () => {
    const live = { ...ann(undefined), spec: { name: 'a', replicas: 9 } };
    const v = singletonDriftVerdict(FP, { name: 'a', replicas: 2 }, live);
    expect(v.drift).toBe(true);
    if (v.drift) expect(v.reason).toContain('unfingerprinted');
  });
});
