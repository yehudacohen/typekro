/**
 * Container Build Utilities
 *
 * Build Docker images and push them to container registries.
 * Returns image URIs for use in TypeKro compositions.
 *
 * The low-level `buildContainer` builds + pushes imperatively and returns a URI. The higher-level
 * `container()` utility wraps it declaratively: define an image once at program scope and reference
 * its `.imageUri` from resources inside a composition — typekro builds it (via `buildContainer`) and
 * substitutes the literal URI at deploy time.
 *
 * @example
 * ```typescript
 * import { buildContainer, container } from 'typekro/containers';
 *
 * // Imperative (build now, get a URI):
 * const { imageUri } = await buildContainer({ context: './app', imageName: 'app', registry: { type: 'orbstack' } });
 *
 * // Declarative (defined outside a composition, referenced within):
 * const appImage = container({ context: './app', imageName: 'app', registry: { type: 'ecr' } });
 * // … later, inside a composition: Deployment({ image: appImage.imageUri, … })
 * ```
 */

export { buildContainer } from './build.js';
export { ContainerBuildError } from './errors.js';
export { container, type ContainerImage, type ContainerImageRef, type ContainerOptions, isContainerImageRef } from './image.js';
export { hasContainerImageRefs, resolveContainerImages } from './resolve.js';
export type {
  ContainerBuildOptions,
  ContainerBuildResult,
  EcrRegistryConfig,
  OrbstackRegistryConfig,
  RegistryConfig,
} from './registries/types.js';
