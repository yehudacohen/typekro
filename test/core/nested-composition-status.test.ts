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
      'outer1-inngestBootstrap1-inngestHelmRelease',
      'outer1-inngestBootstrap1-inngestHelmRepository',
      'outer1-inngestBootstrap1-inngestNamespace',
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

    const knownNestedIds = new Set(['outer1', 'inngestBootstrap1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    // Should have the original entries plus synthesized nested composition entries
    expect(enriched.has('inngestBootstrap1')).toBe(true);
    expect(enriched.get('inngestBootstrap1')?.ready).toBe(true);
    expect(enriched.get('inngestBootstrap1')?.phase).toBe('Ready');
  });

  it('should also add shorter suffix keys for the nested composition', () => {
    const probeResources = mockResources([
      'webAppWithProcessing1-inngestBootstrap1-inngestHelmRelease',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['inngestHelmRelease', {}],
    ]);

    const knownNestedIds = new Set(['webAppWithProcessing1', 'inngestBootstrap1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    // Full path
    expect(enriched.has('webAppWithProcessing1-inngestBootstrap1')).toBe(true);
    // Short suffix (used by the proxy)
    expect(enriched.has('inngestBootstrap1')).toBe(true);
    // Both should be ready
    expect(enriched.get('inngestBootstrap1')?.ready).toBe(true);
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

    const knownNestedIds = new Set(['outer1', 'inner1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    // inner1 found with 1 child (childA), childB not in map so not counted
    expect(enriched.has('inner1')).toBe(true);
    expect(enriched.get('inner1')?.ready).toBe(true);
  });

  it('should use knownNestedIds for precise identification (no digit heuristic)', () => {
    const probeResources = mockResources([
      'outer1-database',
      'outer1-cache',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['database', {}],
      ['cache', {}],
    ]);

    // outer1 IS a known nested ID
    const knownNestedIds = new Set(['outer1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    expect(enriched.has('outer1')).toBe(true);
    expect(enriched.get('outer1')?.ready).toBe(true);
  });

  it('should skip synthesis when knownNestedIds is absent', () => {
    const probeResources = mockResources([
      'outer1-database',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['database', {}],
    ]);

    // No knownNestedIds — synthesis is skipped entirely
    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger);

    expect(enriched.has('outer1')).toBe(false);
    // Original entries preserved
    expect(enriched.has('database')).toBe(true);
  });

  it('should not misidentify user resource names ending in digits', () => {
    const probeResources = mockResources([
      'app1-workerV2-config',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['config', {}],
    ]);

    // Only app1 is a known nested ID, workerV2 is NOT
    const knownNestedIds = new Set(['app1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    // app1 should NOT be synthesized because 'workerV2-config' is not in liveStatusMap
    // (workerV2 is not a known nested ID, so it's not split further)
    expect(enriched.has('workerV2')).toBe(false);
    // app1 IS synthesized because the child suffix 'workerV2-config' is not in liveStatusMap...
    // Actually, 'workerV2' is not a known nested ID, so the only candidate parent is 'app1'
    // with child suffix 'workerV2-config' which is NOT in liveStatusMap → no synthesis
    expect(enriched.has('app1')).toBe(false);
  });

  it('should preserve all original liveStatusMap entries', () => {
    const probeResources = mockResources(['outer1-child']);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['child', { custom: 'data' }],
      ['other', { foo: 'bar' }],
    ]);

    const knownNestedIds = new Set(['outer1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

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

    const knownNestedIds = new Set(['outer1', 'inngest1', 'valkey1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    expect(enriched.has('inngest1')).toBe(true);
    expect(enriched.get('inngest1')?.ready).toBe(true);
    expect(enriched.has('valkey1')).toBe(true);
    expect(enriched.get('valkey1')?.ready).toBe(true);
  });
});
