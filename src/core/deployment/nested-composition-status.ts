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
import { getMetadataField } from '../metadata/index.js';
import type { Enhanced } from '../types/index.js';

function isMarkerString(value: string): boolean {
  return value.includes('__KUBERNETES_REF_');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function filterConcreteNestedStatusFields(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'string') {
    return isMarkerString(value) ? undefined : value;
  }

  if (typeof value === 'function' || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const filtered = value
      .map((item) => filterConcreteNestedStatusFields(item))
      .filter((item) => item !== undefined);
    return filtered.length === value.length ? filtered : undefined;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  const filteredEntries = Object.entries(value)
    .filter(([key]) => !key.startsWith('__'))
    .map(([key, entryValue]) => [key, filterConcreteNestedStatusFields(entryValue)] as const)
    .filter(([, entryValue]) => entryValue !== undefined);

  return filteredEntries.length > 0 ? Object.fromEntries(filteredEntries) : undefined;
}

function resolveNestedSnapshot(
  parentId: string,
  nestedStatusSnapshots?: Map<string, Record<string, unknown>>
): Record<string, unknown> | undefined {
  if (!nestedStatusSnapshots || nestedStatusSnapshots.size === 0) {
    return undefined;
  }

  return nestedStatusSnapshots.get(parentId);
}

function isChildOfNestedId(
  resourceKey: string,
  resource: Enhanced<unknown, unknown>,
  nestedId: string
): boolean {
  if (resourceKey === nestedId) {
    return true;
  }

  const nextChar = resourceKey[nestedId.length];
  if (resourceKey.startsWith(nestedId) && nextChar !== undefined && /[A-Z_-]/.test(nextChar)) {
    return true;
  }

  const aliases = getMetadataField(resource, 'resourceAliases') as string[] | undefined;
  return aliases?.some((alias) => {
    if (alias === nestedId) {
      return true;
    }
    const boundaryChar = alias[nestedId.length];
    return alias.startsWith(nestedId) && boundaryChar !== undefined && /[A-Z_-]/.test(boundaryChar);
  }) ?? false;
}

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
 *   (e.g., "inngestBootstrap1") from the composition context. Required — without
 *   this, no synthesis is performed. The IDs are populated during composition
 *   execution by `executeNestedCompositionWithSpec`.
 * @returns Enriched map with additional entries for nested composition parent IDs.
 */
export function synthesizeNestedCompositionStatus(
  probeResources: Record<string, Enhanced<unknown, unknown>>,
  liveStatusMap: Map<string, Record<string, unknown>>,
  logger: TypeKroLogger,
  knownNestedIds?: Set<string>,
  nestedStatusSnapshots?: Map<string, Record<string, unknown>>
): Map<string, Record<string, unknown>> {
  const enrichedMap = new Map(liveStatusMap);

  // Without an explicit registry of nested composition IDs, we cannot
  // reliably identify virtual parents. Skip synthesis entirely.
  if (!knownNestedIds || knownNestedIds.size === 0) {
    return enrichedMap;
  }

  for (const parentId of knownNestedIds) {
    const childCount = Object.entries(probeResources).filter(([resourceKey, resource]) =>
      isChildOfNestedId(resourceKey, resource, parentId) && liveStatusMap.has(resourceKey)
    ).length;

    const snapshot = resolveNestedSnapshot(parentId, nestedStatusSnapshots);
    const filteredSnapshot = filterConcreteNestedStatusFields(snapshot);
    const snapshotReady = isPlainObject(filteredSnapshot) ? filteredSnapshot.ready : undefined;
    const snapshotPhase = isPlainObject(filteredSnapshot) ? filteredSnapshot.phase : undefined;
    const snapshotFailed = isPlainObject(filteredSnapshot) ? filteredSnapshot.failed : undefined;

    if (childCount === 0 && !isPlainObject(filteredSnapshot)) {
      continue;
    }

    // All resources in liveStatusMap passed waitForReady, so if we found
    // children, the parent is ready.
    const synthesizedStatus: Record<string, unknown> = {
      ...(isPlainObject(filteredSnapshot) ? filteredSnapshot : {}),
      ready: childCount > 0 ? true : typeof snapshotReady === 'boolean' ? snapshotReady : false,
      phase: childCount > 0 ? 'Ready' : typeof snapshotPhase === 'string' ? snapshotPhase : 'Installing',
      failed: childCount > 0 ? false : typeof snapshotFailed === 'boolean' ? snapshotFailed : false,
    };

    // Add under the full parent ID
    enrichedMap.set(parentId, synthesizedStatus);

    logger.debug('Synthesized nested composition status', {
      parentId,
      ready: childCount > 0,
      childCount,
    });
  }

  return enrichedMap;
}
