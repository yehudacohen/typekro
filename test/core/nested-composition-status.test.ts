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
      'inngestBootstrap1HelmRelease',
      'inngestBootstrap1HelmRepository',
      'inngestBootstrap1Namespace',
      'database',
      'cache',
      'app',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['inngestBootstrap1HelmRelease', { conditions: [{ type: 'Ready', status: 'True' }] }],
      ['inngestBootstrap1HelmRepository', {}],
      ['inngestBootstrap1Namespace', { phase: 'Active' }],
      ['database', { readyInstances: 1 }],
      ['cache', { ready: true }],
      ['app', { readyReplicas: 1 }],
    ]);

    const knownNestedIds = new Set(['inngestBootstrap1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    // Should have the original entries plus synthesized nested composition entries
    expect(enriched.has('inngestBootstrap1')).toBe(true);
    expect(enriched.get('inngestBootstrap1')?.ready).toBe(true);
    expect(enriched.get('inngestBootstrap1')?.phase).toBe('Ready');
  });

  it('should synthesize the nested parent id directly from merged child ids', () => {
    const probeResources = mockResources([
      'inngestBootstrap1HelmRelease',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['inngestBootstrap1HelmRelease', {}],
    ]);

    const knownNestedIds = new Set(['inngestBootstrap1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    expect(enriched.has('inngestBootstrap1')).toBe(true);
    expect(enriched.get('inngestBootstrap1')?.ready).toBe(true);
  });

  it('should only count children present in liveStatusMap (missing children are ignored)', () => {
    const probeResources = mockResources([
      'inner1ChildA',
      'inner1ChildB',
    ]);

    // Only childA is deployed, childB is missing
    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['inner1ChildA', {}],
    ]);

    const knownNestedIds = new Set(['inner1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    // inner1 found with 1 child (childA), childB not in map so not counted
    expect(enriched.has('inner1')).toBe(true);
    expect(enriched.get('inner1')?.ready).toBe(true);
  });

  it('should use knownNestedIds for precise identification (no digit heuristic)', () => {
    const probeResources = mockResources([
      'outer1Database',
      'outer1Cache',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['outer1Database', {}],
      ['outer1Cache', {}],
    ]);

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
      'app1WorkerV2Config',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['app1WorkerV2Config', {}],
    ]);

    const knownNestedIds = new Set(['app1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    expect(enriched.has('workerV2')).toBe(false);
    expect(enriched.has('app1')).toBe(true);
  });

  it('does not treat app10 resources as children of app1', () => {
    const probeResources = mockResources([
      'app10Service',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['app10Service', {}],
    ]);

    const knownNestedIds = new Set(['app1', 'app10']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    expect(enriched.has('app1')).toBe(false);
    expect(enriched.has('app10')).toBe(true);
    expect(enriched.get('app10')?.ready).toBe(true);
  });

  it('should preserve all original liveStatusMap entries', () => {
    const probeResources = mockResources(['outer1Child']);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['child', { custom: 'data' }],
      ['other', { foo: 'bar' }],
    ]);

    const knownNestedIds = new Set(['outer1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    expect(enriched.get('child')).toEqual({ custom: 'data' });
    expect(enriched.get('other')).toEqual({ foo: 'bar' });
  });

  it('preserves snapshot readiness when there are no live child resources', () => {
    const probeResources = mockResources([]);

    const liveStatusMap = new Map<string, Record<string, unknown>>();

    const enriched = synthesizeNestedCompositionStatus(
      probeResources,
      liveStatusMap,
      logger,
      new Set(['staticOnlyNested']),
      new Map([
        ['staticOnlyNested', {
          ready: true,
          phase: 'Ready',
          failed: false,
          endpoint: 'http://shared:80',
        }],
      ])
    );

    expect(enriched.get('staticOnlyNested')).toEqual({
      ready: true,
      phase: 'Ready',
      failed: false,
      endpoint: 'http://shared:80',
    });
  });

  it('should handle multiple nested compositions', () => {
    const probeResources = mockResources([
      'inngest1HelmRelease',
      'inngest1Namespace',
      'valkey1ValkeyResource',
      'database',
    ]);

    const liveStatusMap = new Map<string, Record<string, unknown>>([
      ['inngest1HelmRelease', {}],
      ['inngest1Namespace', {}],
      ['valkey1ValkeyResource', {}],
      ['database', {}],
    ]);

    const knownNestedIds = new Set(['inngest1', 'valkey1']);

    const enriched = synthesizeNestedCompositionStatus(probeResources, liveStatusMap, logger, knownNestedIds);

    expect(enriched.has('inngest1')).toBe(true);
    expect(enriched.get('inngest1')?.ready).toBe(true);
    expect(enriched.has('valkey1')).toBe(true);
    expect(enriched.get('valkey1')?.ready).toBe(true);
  });
});
