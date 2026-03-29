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
 *   Keys are full composition paths like "outer1-inngest-bootstrap1-inngestHelmRelease".
 * @param liveStatusMap - Live status data keyed by short resource IDs (e.g., "inngestHelmRelease").
 *   All resources in this map are considered "ready" (they passed waitForReady).
 * @param logger - Logger instance for debug output.
 * @returns Enriched map with additional entries for nested composition parent IDs.
 */
export function synthesizeNestedCompositionStatus(
  probeResources: Record<string, Enhanced<unknown, unknown>>,
  liveStatusMap: Map<string, Record<string, unknown>>,
  logger: TypeKroLogger
): Map<string, Record<string, unknown>> {
  const enrichedMap = new Map(liveStatusMap);
  const deployedChildIds = new Set(liveStatusMap.keys());

  // Scan probe resource keys for nested composition parents.
  // Full keys follow the pattern: "{outer}-{parent}-{child}"
  // where {parent} ends with a digit (composition instance counter).
  // The {child} suffix should match a key in the liveStatusMap.
  const nestedParents = new Map<string, { childCount: number; readyCount: number }>();

  for (const fullKey of Object.keys(probeResources)) {
    const segments = fullKey.split('-');

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      // Composition instance IDs end with a digit (e.g., "bootstrap1", "processing1")
      if (!/\d$/.test(segment)) continue;

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
          nestedParents.set(candidateParent, { childCount: 0, readyCount: 0 });
        }
        const entry = nestedParents.get(candidateParent)!;
        entry.childCount++;
        // All resources in liveStatusMap passed waitForReady → they're ready
        entry.readyCount++;
      }
    }
  }

  for (const [parentId, { childCount, readyCount }] of nestedParents) {
    const allReady = childCount > 0 && readyCount === childCount;
    const synthesizedStatus: Record<string, unknown> = {
      ready: allReady,
      phase: allReady ? 'Ready' : 'Installing',
      failed: false,
    };

    // Add under the full parent ID
    enrichedMap.set(parentId, synthesizedStatus);

    // Also add under shorter suffixes of the parent ID.
    // The inner composition's proxy uses a baseId like "inngest-bootstrap1"
    // but the full context key may be "web-app-with-processing1-inngest-bootstrap1".
    const parentSegments = parentId.split('-');
    for (let j = 1; j < parentSegments.length; j++) {
      const suffix = parentSegments.slice(j).join('-');
      if (/\d$/.test(suffix) && !enrichedMap.has(suffix)) {
        enrichedMap.set(suffix, synthesizedStatus);
      }
    }

    logger.debug('Synthesized nested composition status', {
      parentId,
      ready: allReady,
      childCount,
    });
  }

  return enrichedMap;
}
