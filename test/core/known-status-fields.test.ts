/**
 * Tests for KNOWN_STATUS_FIELDS registry and typo detection (Phase 2.12)
 *
 * @see src/core/proxy/known-status-fields.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  detectStatusFieldTypo,
  getKnownStatusFields,
} from '../../src/core/proxy/known-status-fields.js';

// =============================================================================
// getKnownStatusFields
// =============================================================================

describe('getKnownStatusFields', () => {
  test('returns known fields for Deployment', () => {
    const fields = getKnownStatusFields('Deployment');
    expect(fields).toBeDefined();
    expect(fields).toContain('readyReplicas');
    expect(fields).toContain('availableReplicas');
    expect(fields).toContain('conditions');
  });

  test('returns known fields for StatefulSet', () => {
    const fields = getKnownStatusFields('StatefulSet');
    expect(fields).toBeDefined();
    expect(fields).toContain('readyReplicas');
    expect(fields).toContain('currentRevision');
  });

  test('returns known fields for Service', () => {
    const fields = getKnownStatusFields('Service');
    expect(fields).toBeDefined();
    expect(fields).toContain('loadBalancer');
  });

  test('returns known fields for Pod', () => {
    const fields = getKnownStatusFields('Pod');
    expect(fields).toBeDefined();
    expect(fields).toContain('phase');
    expect(fields).toContain('containerStatuses');
    expect(fields).toContain('podIP');
  });

  test('returns known fields for Job', () => {
    const fields = getKnownStatusFields('Job');
    expect(fields).toBeDefined();
    expect(fields).toContain('succeeded');
    expect(fields).toContain('failed');
    expect(fields).toContain('conditions');
  });

  test('returns undefined for unknown CRD kinds', () => {
    expect(getKnownStatusFields('WebApp')).toBeUndefined();
    expect(getKnownStatusFields('MyCustomResource')).toBeUndefined();
    expect(getKnownStatusFields('HelmRelease')).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(getKnownStatusFields('')).toBeUndefined();
  });
});

// =============================================================================
// detectStatusFieldTypo — no false positives
// =============================================================================

describe('detectStatusFieldTypo: no false positives', () => {
  test('returns null for valid Deployment status fields', () => {
    expect(detectStatusFieldTypo('Deployment', 'readyReplicas')).toBeNull();
    expect(detectStatusFieldTypo('Deployment', 'availableReplicas')).toBeNull();
    expect(detectStatusFieldTypo('Deployment', 'conditions')).toBeNull();
    expect(detectStatusFieldTypo('Deployment', 'replicas')).toBeNull();
  });

  test('returns null for unknown kinds (CRDs)', () => {
    expect(detectStatusFieldTypo('WebApp', 'readyReplicas')).toBeNull();
    expect(detectStatusFieldTypo('WebApp', 'anythingAtAll')).toBeNull();
    expect(detectStatusFieldTypo('HelmRelease', 'phase')).toBeNull();
    expect(detectStatusFieldTypo('MyCustomResource', 'status')).toBeNull();
  });

  test('returns null when no close match exists', () => {
    // 'url' has no close match in Deployment status fields
    expect(detectStatusFieldTypo('Deployment', 'url')).toBeNull();
    // 'hostname' is too far from any Deployment field
    expect(detectStatusFieldTypo('Deployment', 'hostname')).toBeNull();
    // 'foobar' is nothing like any field
    expect(detectStatusFieldTypo('Deployment', 'foobar')).toBeNull();
  });

  test('returns null for valid Pod status fields', () => {
    expect(detectStatusFieldTypo('Pod', 'phase')).toBeNull();
    expect(detectStatusFieldTypo('Pod', 'podIP')).toBeNull();
    expect(detectStatusFieldTypo('Pod', 'conditions')).toBeNull();
  });
});

// =============================================================================
// detectStatusFieldTypo — detects common typos
// =============================================================================

describe('detectStatusFieldTypo: detects typos', () => {
  test('detects missing "s" in readyReplicas', () => {
    const suggestion = detectStatusFieldTypo('Deployment', 'readyReplica');
    expect(suggestion).toBe('readyReplicas');
  });

  test('detects transposed letters in readyReplicas', () => {
    const suggestion = detectStatusFieldTypo('Deployment', 'reedyReplicas');
    expect(suggestion).toBe('readyReplicas');
  });

  test('detects typo in availableReplicas', () => {
    const suggestion = detectStatusFieldTypo('Deployment', 'avalableReplicas');
    expect(suggestion).toBe('availableReplicas');
  });

  test('detects typo in conditions', () => {
    const suggestion = detectStatusFieldTypo('Deployment', 'conditons');
    expect(suggestion).toBe('conditions');
  });

  test('detects missing "s" in conditions', () => {
    const suggestion = detectStatusFieldTypo('Deployment', 'condition');
    expect(suggestion).toBe('conditions');
  });

  test('detects typo in observedGeneration', () => {
    const suggestion = detectStatusFieldTypo('Deployment', 'observdGeneration');
    expect(suggestion).toBe('observedGeneration');
  });

  test('detects typo in StatefulSet currentRevision', () => {
    const suggestion = detectStatusFieldTypo('StatefulSet', 'currentRevsion');
    expect(suggestion).toBe('currentRevision');
  });

  test('detects typo in Pod containerStatuses', () => {
    const suggestion = detectStatusFieldTypo('Pod', 'containerStatus');
    expect(suggestion).toBe('containerStatuses');
  });

  test('detects typo in Service loadBalancer', () => {
    const suggestion = detectStatusFieldTypo('Service', 'loadBalanser');
    expect(suggestion).toBe('loadBalancer');
  });

  test('detects typo in DaemonSet numberReady', () => {
    const suggestion = detectStatusFieldTypo('DaemonSet', 'numberRedy');
    expect(suggestion).toBe('numberReady');
  });

  test('detects case-close typo in Job succeeded', () => {
    const suggestion = detectStatusFieldTypo('Job', 'succeded');
    expect(suggestion).toBe('succeeded');
  });
});

// =============================================================================
// detectStatusFieldTypo — edge cases
// =============================================================================

describe('detectStatusFieldTypo: edge cases', () => {
  test('empty string field name returns null for most kinds', () => {
    // Empty string has distance > 2 from any reasonable field name
    expect(detectStatusFieldTypo('Deployment', '')).toBeNull();
  });

  test('very short field names are checked', () => {
    // 'pod' is distance 2 from 'podIP' — depends on whether that triggers
    // Let the test characterize actual behavior
    const result = detectStatusFieldTypo('Pod', 'podI');
    expect(result).toBe('podIP');
  });

  test('exact match returns null (not a typo)', () => {
    expect(detectStatusFieldTypo('Deployment', 'replicas')).toBeNull();
    expect(detectStatusFieldTypo('Pod', 'phase')).toBeNull();
  });

  test('returns the closest match when multiple fields are close', () => {
    // 'replica' is distance 1 from 'replicas' (missing s)
    const suggestion = detectStatusFieldTypo('Deployment', 'replica');
    expect(suggestion).toBe('replicas');
  });

  test('HPA fields are detected', () => {
    const suggestion = detectStatusFieldTypo('HorizontalPodAutoscaler', 'desiredReplica');
    expect(suggestion).toBe('desiredReplicas');
  });

  test('Ingress loadBalancer typo detected', () => {
    const suggestion = detectStatusFieldTypo('Ingress', 'loadbalancer');
    expect(suggestion).toBe('loadBalancer');
  });

  test('PVC phase typo detected', () => {
    const suggestion = detectStatusFieldTypo('PersistentVolumeClaim', 'phasee');
    expect(suggestion).toBe('phase');
  });
});
