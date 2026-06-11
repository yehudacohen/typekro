/**
 * Container Image Resolution
 *
 * Resolves every {@link ContainerImageRef} reachable from a set of resources to its literal image URI,
 * building each distinct container ONCE by delegating to the existing {@link buildContainer} (this
 * module adds NO build/push logic of its own). The refs are replaced in place with the URI string.
 *
 * Runs CLIENT-SIDE before apply (direct mode) / RGD serialization (kro mode), so a container image is
 * never a CEL expression and Kro only ever sees a literal image string.
 */
import { getComponentLogger } from '../logging/index.js';
import { buildContainer } from './build.js';
import { type ContainerImageRef, isContainerImageRef } from './image.js';

const logger = getComponentLogger('container-resolve');

/** Deep-walk a value, invoking `onRef` for every ContainerImageRef found (cycle-safe). */
function walk(
  value: unknown,
  seen: Set<object>,
  onRef: (
    ref: ContainerImageRef,
    parent: Record<string, unknown> | unknown[],
    key: string | number
  ) => void,
  parent?: Record<string, unknown> | unknown[],
  key?: string | number
): void {
  if (isContainerImageRef(value)) {
    if (parent !== undefined && key !== undefined) onRef(value, parent, key);
    return; // never descend into a ref's internals
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, seen, onRef, value, i));
  } else {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      walk((value as Record<string, unknown>)[k], seen, onRef, value as Record<string, unknown>, k);
    }
  }
}

/**
 * Build + substitute every container image referenced by `resources`. Returns the resolved
 * `containerId → imageUri` map (also useful for logging/diagnostics). Mutates the resources in place.
 */
export async function resolveContainerImages(
  resources: readonly unknown[]
): Promise<Map<string, string>> {
  // 1. Collect the distinct containers referenced anywhere in the resource set.
  const byId = new Map<string, ContainerImageRef>();
  for (const resource of resources) {
    walk(resource, new Set(), (ref) => {
      if (!byId.has(ref.containerId)) byId.set(ref.containerId, ref);
    });
  }
  if (byId.size === 0) return new Map();

  // 2. Build each distinct container ONCE (delegating to buildContainer — the existing push mechanics).
  const uriByContainer = new Map<string, string>();
  for (const [containerId, ref] of byId) {
    logger.info('Building container image for reference', {
      containerId,
      imageName: ref.buildOptions.imageName,
    });
    const { imageUri } = await buildContainer(ref.buildOptions);
    uriByContainer.set(containerId, imageUri);
    logger.info('Resolved container image', { containerId, imageUri });
  }

  // 3. Substitute every ref with its resolved literal URI, in place.
  for (const resource of resources) {
    walk(resource, new Set(), (ref, parent, key) => {
      const uri = uriByContainer.get(ref.containerId);
      if (uri === undefined) return;
      (parent as Record<string | number, unknown>)[key] = uri;
    });
  }
  return uriByContainer;
}

/** Whether any resource in the set references a container image (cheap pre-check to skip resolution). */
export function hasContainerImageRefs(resources: readonly unknown[]): boolean {
  let found = false;
  for (const resource of resources) {
    walk(resource, new Set(), () => {
      found = true;
    });
    if (found) break;
  }
  return found;
}
