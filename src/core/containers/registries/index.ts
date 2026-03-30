/**
 * Registry Resolver
 *
 * Maps a RegistryConfig to its handler implementation.
 */

import { ContainerBuildError } from '../errors.js';
import { EcrRegistryHandler } from './ecr.js';
import { OrbstackRegistryHandler } from './orbstack.js';
import type { RegistryConfig, RegistryHandler } from './types.js';

export function resolveRegistry(config: RegistryConfig): RegistryHandler {
  switch (config.type) {
    case 'orbstack':
      return new OrbstackRegistryHandler();
    case 'ecr':
      return new EcrRegistryHandler(config);
    case 'gcr':
      throw ContainerBuildError.registryNotSupported('gcr');
    case 'acr':
      throw ContainerBuildError.registryNotSupported('acr');
    default:
      throw ContainerBuildError.registryNotSupported(String((config as { type: string }).type));
  }
}

export type { RegistryConfig, RegistryHandler } from './types.js';
