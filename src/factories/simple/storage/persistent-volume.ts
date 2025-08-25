/**
 * Simple PersistentVolume Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes PersistentVolume resources with sensible defaults.
 */

import { persistentVolume } from '../../kubernetes/storage/persistent-volume.js';
import type {
  V1PvSpec,
  V1PvStatus,
} from '../../kubernetes/storage/persistent-volume.js';
import type { Enhanced } from '../../../core/types.js';
import type { PersistentVolumeConfig } from '../types.js';

/**
 * Creates a simple PersistentVolume with sensible defaults
 *
 * @param config - Configuration for the persistent volume
 * @returns Enhanced PersistentVolume resource
 */
export function PersistentVolume(
  config: PersistentVolumeConfig
): Enhanced<V1PvSpec, V1PvStatus> {
  const {
    name,
    size,
    storageClass,
    accessModes = ['ReadWriteOnce'],
    hostPath,
    nfs,
    persistentVolumeReclaimPolicy = 'Retain',
  } = config;

  // Determine the volume source
  const volumeSource: any = {};
  if (hostPath) {
    volumeSource.hostPath = { path: hostPath };
  } else if (nfs) {
    volumeSource.nfs = nfs;
  } else {
    // Default to hostPath if no source is specified
    volumeSource.hostPath = { path: '/tmp/default-pv' };
  }

  return persistentVolume({
    metadata: {
      name,
      ...(storageClass && { annotations: { 'volume.beta.kubernetes.io/storage-class': storageClass } }),
    },
    spec: {
      capacity: { storage: size },
      accessModes,
      persistentVolumeReclaimPolicy,
      ...(storageClass && { storageClassName: storageClass }),
      ...volumeSource,
    },
  });
}
