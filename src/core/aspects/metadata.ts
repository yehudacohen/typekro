import { getResourceMetadata, setResourceMetadata } from '../metadata/resource-metadata.js';

import type { ResourceAspectMetadata } from './types.js';

type AspectOverrideFieldKind = 'scalar' | 'object' | 'array';

/** Factory-owned runtime mirror of a curated writable override schema. */
export interface AspectOverrideSchemaNode {
  readonly kind: AspectOverrideFieldKind;
  readonly children?: Readonly<Record<string, AspectOverrideSchemaNode>>;
}

interface ResourceAspectRuntimeMetadata extends ResourceAspectMetadata {
  readonly overrideSchema?: AspectOverrideSchemaNode;
}

/** Merges aspect matching metadata onto a resource object. */
export function setAspectMetadata(
  resource: WeakKey,
  metadata: ResourceAspectRuntimeMetadata
): void {
  const existing = getResourceMetadata(resource)?.aspects ?? {};
  const merged: ResourceAspectRuntimeMetadata = {
    ...existing,
    ...metadata,
    labels: { ...existing.labels, ...metadata.labels },
    ...(metadata.targetGroups !== undefined || existing.targetGroups !== undefined
      ? { targetGroups: metadata.targetGroups ?? existing.targetGroups }
      : {}),
    ...(metadata.surfaces !== undefined || existing.surfaces !== undefined
      ? { surfaces: metadata.surfaces ?? existing.surfaces }
      : {}),
  };
  setResourceMetadata(resource, {
    aspects: merged,
  });
}

/** Reads aspect matching metadata for a resource object. */
export function getAspectMetadata(resource: WeakKey): ResourceAspectRuntimeMetadata | undefined {
  return getResourceMetadata(resource)?.aspects;
}
