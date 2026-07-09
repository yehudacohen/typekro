/**
 * Rook/Ceph S3-compatible object-storage integration.
 *
 * Platform owners bootstrap Rook, create Ceph storage infrastructure, an RGW
 * CephObjectStore, and bucket StorageClasses. Application graphs consume that
 * capability through `rookObjectStorageClaim`, which owns only a namespaced
 * ObjectBucketClaim and exposes the generated Secret/ConfigMap binding names.
 *
 * @module
 */
export * from './compositions/index.js';
export * from './resources/index.js';
export * from './types.js';
export * from './utils/index.js';
