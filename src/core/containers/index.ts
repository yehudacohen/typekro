/**
 * Container Build Utilities
 *
 * Build Docker images and push them to container registries.
 * Returns image URIs for use in TypeKro compositions.
 *
 * The low-level `buildContainer` builds + pushes imperatively and returns a URI. The higher-level
 * `container()` is a memoized async builder that resolves to a SHAPED result (`{ imageUri,
 * repository, tag }`) — `await` it in setup code, then feed the full URI to a resource's image field
 * or the split `repository`/`tag` to a Helm chart's image values.
 *
 * @example
 * ```typescript
 * import { container } from 'typekro/containers';
 *
 * const img = await container({ context: './app', imageName: 'app', registry: { type: 'ecr' } });
 * Deployment({ image: img.imageUri, … });            // full URI
 * // or chart values:  { repository: img.repository, tag: img.tag }
 * ```
 */

export { buildContainer } from './build.js';
export { ContainerBuildError } from './errors.js';
export {
  type ContainerImage,
  type ContainerOptions,
  clearContainerCache,
  container,
  splitImageUri,
} from './image.js';
export type {
  ContainerBuildOptions,
  ContainerBuildResult,
  EcrRegistryConfig,
  OrbstackRegistryConfig,
  RegistryConfig,
} from './registries/types.js';
