/**
 * Nested Composition Status Synthesis
 *
 * When a composition contains nested compositions (e.g., inngestBootstrap inside
 * webAppWithProcessing), the deployment creates child resources with prefixed IDs.
 * After deployment, we need to synthesize a "ready" status for each nested
 * composition parent based on whether ALL its children are ready.
 *
 * This module is shared between direct and KRO deployment strategies.
 * It does NOT inspect resource-specific fields (Helm conditions, Namespace phase,
 * etc.) — it relies solely on deployment readiness, which is already determined
 * by factory-provided readiness evaluators.
 */

import type { TypeKroLogger } from '../logging/index.js';
import type { Enhanced } from '../types/index.js';

/**
 * Synthesize status entries for nested compositions and return an enriched
 * live status map that includes both the original resource statuses and
 * synthesized nested composition statuses.
 *
 * @param probeResources - Resource map from a probe execution of the composition.
 *   Keys are full composition paths like "outer1-inngestBootstrap1-inngestHelmRelease".
 * @param liveStatusMap - Live status data keyed by short resource IDs (e.g., "inngestHelmRelease").
 *   All resources in this map are considered "ready" (they passed waitForReady).
 * @param logger - Logger instance for debug output.
 * @param knownNestedIds - Explicit set of known nested composition base IDs
 *   (e.g., "inngestBootstrap1") from the composition context. When provided,
 *   only these IDs are considered as potential parents — no string-pattern
 *   heuristics are used. When absent, falls back to digit-suffix detection.
 * @returns Enriched map with additional entries for nested composition parent IDs.
 */
export function synthesizeNestedCompositionStatus(
  probeResources: Record<string, Enhanced<unknown, unknown>>,
  liveStatusMap: Map<string, Record<string, unknown>>,
  logger: TypeKroLogger,
  knownNestedIds?: Set<string>
): Map<string, Record<string, unknown>> {
  const enrichedMap = new Map(liveStatusMap);
  const deployedChildIds = new Set(liveStatusMap.keys());

  // Scan probe resource keys for nested composition parents.
  // Full keys follow the pattern: "{outer}-{parent}-{child}"
  // where {parent} is a known nested composition ID.
  const nestedParents = new Map<string, { childCount: number }>();

  for (const fullKey of Object.keys(probeResources)) {
    const segments = fullKey.split('-');

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;

      // Check if this segment is a known nested composition ID.
      // With the explicit registry, we match precisely. Without it,
      // fall back to the digit-suffix heuristic (composition counters
      // always end with a digit: bootstrap1, processing2, etc.).
      const isNestedId = knownNestedIds
        ? knownNestedIds.has(segment)
        : /\d$/.test(segment);
      if (!isNestedId) continue;

      const candidateParent = segments.slice(0, i + 1).join('-');
      // Skip if this is the entire key (no children)
      if (candidateParent === fullKey) continue;
      // Skip if already a real deployed resource
      if (deployedChildIds.has(candidateParent)) continue;

      const childSuffix = segments.slice(i + 1).join('-');
      if (!childSuffix) continue;

      // Check if this child was deployed (exists in liveStatusMap)
      if (deployedChildIds.has(childSuffix)) {
        if (!nestedParents.has(candidateParent)) {
          nestedParents.set(candidateParent, { childCount: 0 });
        }
        nestedParents.get(candidateParent)!.childCount++;
      }
    }
  }

  for (const [parentId, { childCount }] of nestedParents) {
    // All resources in liveStatusMap passed waitForReady, so if we found
    // children, the parent is ready.
    const synthesizedStatus: Record<string, unknown> = {
      ready: childCount > 0,
      phase: childCount > 0 ? 'Ready' : 'Installing',
      failed: false,
    };

    // Add under the full parent ID
    enrichedMap.set(parentId, synthesizedStatus);

    // Also add under shorter suffixes of the parent ID.
    // The inner composition's proxy uses a baseId like "inngestBootstrap1"
    // but the full context key may be "webAppWithProcessing1-inngestBootstrap1".
    const parentSegments = parentId.split('-');
    for (let j = 1; j < parentSegments.length; j++) {
      const suffix = parentSegments.slice(j).join('-');
      const isSuffixNested = knownNestedIds
        ? knownNestedIds.has(suffix)
        : /\d$/.test(suffix);
      if (isSuffixNested && !enrichedMap.has(suffix)) {
        enrichedMap.set(suffix, synthesizedStatus);
      }
    }

    logger.debug('Synthesized nested composition status', {
      parentId,
      ready: childCount > 0,
      childCount,
    });
  }

  return enrichedMap;
}
