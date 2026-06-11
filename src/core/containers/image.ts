/**
 * Container Image Utility
 *
 * `container()` declares a container image built from source and pushed to a registry, as a
 * FIRST-CLASS typekro utility. It is defined at program scope — OUTSIDE a `kubernetesComposition` —
 * because an image is a build-time artifact with no dependency on cluster state; it should never be a
 * node in the cluster resource graph. Resources WITHIN a composition reference its `.imageUri`.
 *
 * `.imageUri` is a `ContainerImageRef` (a distinct brand, NOT a `KubernetesRef`): typekro resolves it
 * CLIENT-SIDE to a literal image URI before apply (direct mode) / RGD serialization (kro mode), by
 * delegating to the existing {@link buildContainer} — once per container identity. Kro never sees a
 * build, only a literal image string.
 *
 * @example
 * ```typescript
 * import { container } from 'typekro/containers';
 *
 * // Defined OUTSIDE the composition:
 * const appImage = container({ context: './app', imageName: 'app', registry: { type: 'ecr' } });
 *
 * // Referenced WITHIN one:
 * kubernetesComposition(def, () => {
 *   Deployment({ name: 'app', image: appImage.imageUri, ports: [{ containerPort: 3000 }] });
 * });
 * ```
 */
import { CONTAINER_IMAGE_REF_BRAND } from '../constants/brands.js';
import type { ContainerBuildOptions } from './registries/types.js';

/**
 * A reference to a container image's URI. Resolved client-side to a literal string (the built +
 * pushed image URI) before apply / RGD serialization — distinct from a `KubernetesRef`, which is a
 * cluster-state reference serialized to CEL.
 */
export interface ContainerImageRef<T extends string = string> {
  readonly [CONTAINER_IMAGE_REF_BRAND]: true;
  /** Stable identity — multiple references to the same container build the image only ONCE. */
  readonly containerId: string;
  /** The build spec, carried inline so the resolver is self-contained (delegates to `buildContainer`). */
  readonly buildOptions: ContainerBuildOptions;
  readonly _type?: T;
}

/** A first-class container image: defined outside a composition, referenced within one. */
export interface ContainerImage {
  /**
   * The image-URI reference — assign to any resource image field (e.g. a container's `image`). Typed
   * as `string` so it's assignable to plain string fields, exactly like typekro's schema/resource
   * refs; at RUNTIME it is a branded {@link ContainerImageRef} that the resolver substitutes with the
   * built image URI at deploy time. Use {@link isContainerImageRef} to detect it.
   */
  readonly imageUri: string;
}

/** Options for {@link container}: the {@link ContainerBuildOptions} plus an optional stable identity. */
export interface ContainerOptions extends ContainerBuildOptions {
  /** Stable identity for dedup across references; defaults to `imageName`. Set when two containers share one. */
  id?: string;
}

/**
 * Declare a container image as a first-class typekro utility (see the module doc). Returns a handle
 * whose `.imageUri` is referenced from resources; the build (via {@link buildContainer}) happens once
 * at deploy time and the literal URI is substituted before apply / serialization.
 */
export function container(options: ContainerOptions): ContainerImage {
  const { id, ...buildOptions } = options;
  const containerId = id ?? buildOptions.imageName;
  const ref: ContainerImageRef<string> = {
    [CONTAINER_IMAGE_REF_BRAND]: true,
    containerId,
    buildOptions,
  };
  // Typed as `string` (assignable to any image field) but a branded ref at runtime — mirrors how
  // typekro's schema/resource refs present as their underlying type while carrying runtime markers.
  return { imageUri: ref as unknown as string };
}

/** Type guard: is `value` a {@link ContainerImageRef} (the `.imageUri` of a `container()`)? */
export function isContainerImageRef(value: unknown): value is ContainerImageRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[CONTAINER_IMAGE_REF_BRAND] === true
  );
}
