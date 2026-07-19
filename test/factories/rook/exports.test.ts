import { describe, expect, it } from 'bun:test';
import { rook as rootRookNamespace } from '../../../src/factories/index.js';
import * as rook from '../../../src/factories/rook/index.js';

describe('Rook public exports', () => {
  it('exports the complete object-storage slice from typekro/rook', () => {
    expect(rook.rookCephOperatorBootstrap).toBeDefined();
    expect(rook.rookCephOperatorInstallation).toBe(rook.rookCephOperatorBootstrap);
    expect(rook.rookObjectStorageClaim).toBeDefined();
    expect(rook.rookCephSingleNodePlatform).toBeDefined();
    expect(rook.rookCephProductionPlatform).toBeDefined();
    expect(rook.rookCephClusterHelmRelease).toBeFunction();
    expect(rook.cephObjectStore).toBeFunction();
    expect(rook.cephObjectStoreUser).toBeFunction();
    expect(rook.objectBucketClaim).toBeFunction();
    expect(rook.rookBucketStorageClass).toBeFunction();
    expect(rook.DEFAULT_ROOK_CEPH_VERSION).toBe('v1.20.2');
  });

  it('exposes a namespaced root factory export', () => {
    expect(rootRookNamespace.rookObjectStorageClaim).toBe(rook.rookObjectStorageClaim);
    expect(rootRookNamespace.cephObjectStore).toBe(rook.cephObjectStore);
  });
});
