/**
 * Orbstack Registry Handler
 *
 * Orbstack makes locally-built Docker images automatically available to its
 * built-in Kubernetes cluster. No push step is needed — `docker build` is
 * sufficient.
 */

import { getComponentLogger } from '../../logging/index.js';
import type { RegistryHandler } from './types.js';

const logger = getComponentLogger('container-registry-orbstack');

export class OrbstackRegistryHandler implements RegistryHandler {
  async resolveImageUri(imageName: string, tag: string): Promise<string> {
    return `${imageName}:${tag}`;
  }

  async authenticate(): Promise<void> {
    // No authentication needed — Orbstack uses the local Docker daemon.
    logger.debug('Orbstack registry: no authentication needed');
  }

  async push(_imageUri: string, _imageName: string): Promise<boolean> {
    // No push needed — images built locally are auto-available to Orbstack K8s.
    logger.debug('Orbstack registry: skipping push (images auto-available to local K8s)');
    return false;
  }
}
