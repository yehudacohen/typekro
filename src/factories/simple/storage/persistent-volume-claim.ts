/**
 * Simple PVC Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes PersistentVolumeClaim resources with sensible defaults.
 */

import { persistentVolumeClaim } from '../../kubernetes/storage/persistent-volume-claim.js';
import type {
  V1PvcSpec,
  V1PvcStatus,
} from '../../kubernetes/types.js';
import type { Enhanced } from '../../../core/types.js';
import type { PvcConfig } from '../types.js';

/**
 * Creates a simple PVC with sensible defaults
 *
 * @param config - Configuration for the persistent volume claim
 * @returns Enhanced PersistentVolumeClaim resource
 */
export function Pvc(
  config: PvcConfig
): Enhanced<V1PvcSpec, V1PvcStatus> {
  return persistentVolumeClaim({
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
      accessModes: config.accessModes || ['ReadWriteOnce'],
      resources: {
        requests: {
          storage: config.size,
        },
      },
      ...(config.storageClass && { storageClassName: config.storageClass }),
    },
  });
}