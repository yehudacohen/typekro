/**
 * Orbstack Registry Handler
 *
 * Orbstack makes locally-built Docker images automatically available to its
 * built-in Kubernetes cluster. No push step is needed — `docker build` is
 * sufficient.
 */

import { getComponentLogger } from '../../logging/index.js';
import type { RegistryHandler, RegistrySession } from './types.js';

const logger = getComponentLogger('container-registry-orbstack');

export class OrbstackRegistryHandler implements RegistryHandler {
  async resolveImageUri(imageName: string, tag: string): Promise<string> {
    return `${imageName}:${tag}`;
  }

  async prepare(
    _imageName: string,
    _timeout: number,
    _signal?: AbortSignal
  ): Promise<RegistrySession> {
    logger.debug('Orbstack registry: using local Docker image availability');
    return {
      remote: false,
      async cleanup() {
        // Local OrbStack builds create no temporary registry session.
      },
    };
  }
}
