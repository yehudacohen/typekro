/**
 * Tests for nested composition status synthesis.
 *
 * Verifies that the shared synthesizeNestedCompositionStatus utility
 * correctly identifies nested composition parents and synthesizes
 * their readiness from child resource deployment status.
 */

import { describe, expect, it } from 'bun:test';
import { synthesizeNestedCompositionStatus } from '../../src/core/deployment/nested-composition-status.js';
import { getComponentLogger } from '../../src/core/logging/index.js';
import type { Enhanced } from '../../src/core/types/index.js';

const logger = getComponentLogger('test');

function mockResources(keys: string[]): Record<string, Enhanced<unknown, unknown>> {
  const resources: Record<string, Enhanced<unknown, unknown>> = {};
  for (const key of keys) {
    resources[key] = {} as Enhanced<unknown, unknown>;
  }
  return resources;
}

describe('synthesizeNestedCompositionStatus', () => {
  it('should synthesize ready status for nested composition when all children are in liveStatusMap', () => {
    const probeResources = mockResources([
      'outer1-inngest-bootstrap1-inngestHelmRelease',
      'outer1-inngest-bootstrap1-inngestHelmRepository',
      'outer1-inngest-bootstrap1-inngestNamespace',
      'outer1-database',
      'outer1-cache',
      'outer1-app',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['inngestHelmRelease', { conditions: [{ type: 'Ready', status: 'True' }] }],
      ['inngestHelmRepository', {}],
      ['inngestNamespace', { phase: 'Active' }],
      ['database', { readyInstances: 1 }],
      ['cache', { ready: true }],
      ['app', { readyReplicas: 1 }],
    ]);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger);

    // Should have the original entries plus synthesized nested composition entries
    expect(enriched.has('inngest-bootstrap1')).toBe(true);
    expect(enriched.get('inngest-bootstrap1')?.ready).toBe(true);
    expect(enriched.get('inngest-bootstrap1')?.phase).toBe('Ready');
  });

  it('should also add shorter suffix keys for the nested composition', () => {
    const probeResources = mockResources([
      'web-app-with-processing1-inngest-bootstrap1-inngestHelmRelease',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['inngestHelmRelease', {}],
    ]);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger);

    // Full path
    expect(enriched.has('web-app-with-processing1-inngest-bootstrap1')).toBe(true);
    // Short suffix (used by the proxy)
    expect(enriched.has('inngest-bootstrap1')).toBe(true);
    // Both should be ready
    expect(enriched.get('inngest-bootstrap1')?.ready).toBe(true);
  });

  it('should only count children present in liveStatusMap (missing children are ignored)', () => {
    const probeResources = mockResources([
      'outer1-inner1-childA',
      'outer1-inner1-childB',
    ]);

    // Only childA is deployed, childB is missing
    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['childA', {}],
    ]);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger);

    // inner1 found with 1 child (childA), childB not in map so not counted
    // This means 1 child found and it's ready → parent ready
    // (missing children don't count as "not ready" — they just aren't part of the count)
    expect(enriched.has('inner1')).toBe(true);
    expect(enriched.get('inner1')?.ready).toBe(true);
  });

  it('should synthesize for parent segments ending with a digit (composition instance IDs)', () => {
    // "outer1-database" → segments ['outer1', 'database']
    // 'outer1' ends with digit → recognized as a composition instance ID.
    // 'database' is in the live map → recognized as a deployed child.
    // So "outer1" IS synthesized — this pattern matches nested compositions
    // like inngestBootstrap1-inngestHelmRelease.
    const probeResources = mockResources([
      'outer1-database',
      'outer1-cache',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['database', {}],
      ['cache', {}],
    ]);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger);

    // outer1 IS synthesized — parent ends with digit, children are in live map
    expect(enriched.has('outer1')).toBe(true);
    expect(enriched.get('outer1')?.ready).toBe(true);
    // Original entries preserved
    expect(enriched.has('database')).toBe(true);
    expect(enriched.has('cache')).toBe(true);
  });

  it('should not create entries when no segment ends with a digit', () => {
    const probeResources = mockResources([
      'myapp-database',
      'myapp-cache',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['database', {}],
      ['cache', {}],
    ]);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger);

    expect(enriched.has('myapp')).toBe(false);
  });

  it('should preserve all original liveStatusMap entries', () => {
    const probeResources = mockResources(['outer1-child']);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['child', { custom: 'data' }],
      ['other', { foo: 'bar' }],
    ]);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger);

    expect(enriched.get('child')).toEqual({ custom: 'data' });
    expect(enriched.get('other')).toEqual({ foo: 'bar' });
  });

  it('should handle multiple nested compositions', () => {
    const probeResources = mockResources([
      'outer1-inngest1-helmRelease',
      'outer1-inngest1-namespace',
      'outer1-valkey1-valkeyResource',
      'outer1-database',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['helmRelease', {}],
      ['namespace', {}],
      ['valkeyResource', {}],
      ['database', {}],
    ]);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger);

    expect(enriched.has('inngest1')).toBe(true);
    expect(enriched.get('inngest1')?.ready).toBe(true);
    expect(enriched.has('valkey1')).toBe(true);
    expect(enriched.get('valkey1')?.ready).toBe(true);
  });
});
