/**
 * Container Build Utilities
 *
 * Build Docker images and push them to container registries.
 * Returns image URIs for use in TypeKro compositions.
 *
 * @example
 * ```typescript
 * import { buildContainer } from 'typekro/containers';
 *
 * const { imageUri } = await buildContainer({
 *   context: './apps/my-app',
 *   imageName: 'my-app',
 *   registry: { type: 'orbstack' },
 * });
 * ```
 */

export { buildContainer } from './build.js';
export { ContainerBuildError } from './errors.js';
export type {
  ContainerBuildOptions,
  ContainerBuildResult,
  EcrRegistryConfig,
  OrbstackRegistryConfig,
  RegistryConfig,
} from './registries/types.js';
