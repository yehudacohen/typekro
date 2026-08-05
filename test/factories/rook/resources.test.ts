import { describe, expect, it } from 'bun:test';

import {
  CephObjectStoreConfigSchema,
  cephObjectStore,
  cephObjectStoreReadinessEvaluator,
  cephObjectStoreUser,
  cephObjectStoreUserReadinessEvaluator,
  ObjectBucketClaimConfigSchema,
  objectBucketClaim,
  objectBucketClaimReadinessEvaluator,
  rookBucketStorageClass,
} from '../../../src/factories/rook/index.js';

describe('Rook object storage resource factories', () => {
  describe('cephObjectStore', () => {
    it('emits the exact Rook v1 local object-store fields', () => {
      const store = cephObjectStore({
        name: 'assets',
        namespace: 'rook-ceph',
        spec: {
          metadataPool: {
            failureDomain: 'host',
            replicated: { size: 3, requireSafeReplicaSize: true },
          },
          dataPool: {
            failureDomain: 'host',
            erasureCoded: { dataChunks: 2, codingChunks: 1, algorithm: 'isa' },
            parameters: { bulk: 'true', compression_mode: 'none' },
          },
          preservePoolsOnDelete: true,
          gateway: {
            port: 80,
            instances: 2,
            resources: { requests: { cpu: '500m', memory: '1Gi' } },
            service: { annotations: { 'example.com/expose': 'true' } },
          },
          healthCheck: {
            startupProbe: { disabled: false },
            readinessProbe: { disabled: false },
          },
          allowUsersInNamespaces: ['apps'],
          hosting: {
            advertiseEndpoint: { dnsName: 's3.example.com', port: 443, useTls: true },
            dnsNames: ['s3.example.com'],
          },
        },
        id: 'assetsStore',
      });

      expect(store.apiVersion).toBe('ceph.rook.io/v1');
      expect(store.kind).toBe('CephObjectStore');
      expect(store.metadata.name).toBe('assets');
      expect(store.metadata.namespace).toBe('rook-ceph');
      expect(store.spec.metadataPool.replicated?.size).toBe(3);
      expect(store.spec.dataPool.erasureCoded?.dataChunks).toBe(2);
      expect(store.spec.gateway.instances).toBe(2);
      expect(store.spec.hosting?.advertiseEndpoint?.useTls).toBe(true);
    });

    it('evaluates every authoritative phase category', () => {
      expect(cephObjectStoreReadinessEvaluator({})).toEqual({
        ready: false,
        reason: 'StatusMissing',
        message: 'CephObjectStore has no status yet',
      });
      expect(cephObjectStoreReadinessEvaluator({ status: { phase: 'Ready' } }).ready).toBe(true);
      expect(cephObjectStoreReadinessEvaluator({ status: { phase: 'Progressing' } })).toEqual({
        ready: false,
        reason: 'Progressing',
        message: 'CephObjectStore phase is Progressing',
      });
      expect(
        cephObjectStoreReadinessEvaluator({
          status: { phase: 'Failure', message: 'RGW failed' },
        })
      ).toEqual({ ready: false, reason: 'Failure', message: 'RGW failed' });
    });

    it('enforces replicated metadata and exactly one data-pool durability mode', () => {
      expect(
        CephObjectStoreConfigSchema.allows({
          name: 'invalid-metadata',
          spec: {
            metadataPool: { erasureCoded: { dataChunks: 2, codingChunks: 1 } },
            dataPool: { replicated: { size: 3 } },
            gateway: { port: 80 },
          },
        })
      ).toBe(false);

      expect(
        CephObjectStoreConfigSchema.allows({
          name: 'invalid-data',
          spec: {
            metadataPool: { replicated: { size: 3 } },
            dataPool: {
              replicated: { size: 3 },
              erasureCoded: { dataChunks: 2, codingChunks: 1 },
            },
            gateway: { port: 80 },
          },
        })
      ).toBe(false);
    });
  });

  describe('cephObjectStoreUser', () => {
    it('preserves user quotas, capabilities, explicit key refs, and op mask', () => {
      const user = cephObjectStoreUser({
        name: 'publisher',
        namespace: 'apps',
        spec: {
          store: 'assets',
          clusterNamespace: 'rook-ceph',
          displayName: 'Publisher',
          capabilities: { bucket: 'read, write', usage: 'read', ratelimit: 'write' },
          quotas: { maxBuckets: 10, maxSize: '10Gi', maxObjects: 1000 },
          opMask: ['read', 'write'],
          keys: [
            {
              accessKeyRef: { name: 'publisher-keys', key: 'access' },
              secretKeyRef: { name: 'publisher-keys', key: 'secret' },
            },
          ],
        },
      });

      expect(user.apiVersion).toBe('ceph.rook.io/v1');
      expect(user.kind).toBe('CephObjectStoreUser');
      expect(user.spec.store).toBe('assets');
      expect(user.spec.quotas?.maxSize).toBe('10Gi');
      expect(user.spec.capabilities?.ratelimit).toBe('write');
      expect(user.spec.keys?.[0]?.accessKeyRef?.name).toBe('publisher-keys');
      expect(user.spec.opMask).toEqual(['read', 'write']);
    });

    it('waits for the Ready phase', () => {
      expect(cephObjectStoreUserReadinessEvaluator({}).ready).toBe(false);
      expect(cephObjectStoreUserReadinessEvaluator({ status: { phase: 'Creating' } })).toEqual({
        ready: false,
        reason: 'Creating',
        message: 'CephObjectStoreUser phase is Creating',
      });
      expect(cephObjectStoreUserReadinessEvaluator({ status: { phase: 'Ready' } }).ready).toBe(
        true
      );
    });
  });

  describe('objectBucketClaim', () => {
    it('emits the upstream v1alpha1 claim shape', () => {
      const claim = objectBucketClaim({
        name: 'uploads',
        namespace: 'apps',
        spec: {
          storageClassName: 'rook-ceph-retain',
          generateBucketName: 'uploads',
          additionalConfig: { maxObjects: '1000', maxSize: '2G' },
        },
      });

      expect(claim.apiVersion).toBe('objectbucket.io/v1alpha1');
      expect(claim.kind).toBe('ObjectBucketClaim');
      expect(claim.spec.storageClassName).toBe('rook-ceph-retain');
      expect(claim.spec.generateBucketName).toBe('uploads');
      expect(claim.spec.additionalConfig?.maxSize).toBe('2G');
    });

    it('rejects fixed and generated bucket names together', () => {
      expect(
        ObjectBucketClaimConfigSchema.allows({
          name: 'invalid',
          spec: {
            storageClassName: 'rook-ceph-retain',
            bucketName: 'fixed',
            generateBucketName: 'generated',
          },
        })
      ).toBe(false);
    });

    it('only reports ready when the claim is Bound', () => {
      expect(objectBucketClaimReadinessEvaluator({}).reason).toBe('StatusMissing');
      expect(objectBucketClaimReadinessEvaluator({ status: { phase: 'Pending' } }).ready).toBe(
        false
      );
      expect(objectBucketClaimReadinessEvaluator({ status: { phase: 'Bound' } })).toEqual({
        ready: true,
        reason: 'Bound',
        message: 'ObjectBucketClaim is bound and connection resources are available',
      });
      expect(objectBucketClaimReadinessEvaluator({ status: { phase: 'Released' } }).ready).toBe(
        false
      );
      expect(objectBucketClaimReadinessEvaluator({ status: { phase: 'Failed' } }).ready).toBe(
        false
      );
    });
  });

  describe('rookBucketStorageClass', () => {
    it('uses the configured Rook OBC provisioner prefix', () => {
      const storageClass = rookBucketStorageClass({
        name: 'rook-ceph-retain',
        objectStoreName: 'assets',
        objectStoreNamespace: 'rook-storage',
        operatorNamespace: 'rook-ceph',
        provisionerNamePrefix: 'rook-operator',
        reclaimPolicy: 'Retain',
      });

      expect(storageClass.kind).toBe('StorageClass');
      expect(String(storageClass.provisioner)).toBe('rook-operator.ceph.rook.io/bucket');
      expect(storageClass.parameters).toEqual({
        objectStoreName: 'assets',
        objectStoreNamespace: 'rook-storage',
      });
      expect(storageClass.reclaimPolicy).toBe('Retain');
    });

    it('supports brownfield buckets in the StorageClass, not the claim', () => {
      const storageClass = rookBucketStorageClass({
        name: 'existing-assets',
        objectStoreName: 'assets',
        objectStoreNamespace: 'rook-ceph',
        operatorNamespace: 'rook-operator',
        existingBucketName: 'company-assets',
      });

      expect(String(storageClass.provisioner)).toBe('rook-ceph.ceph.rook.io/bucket');
      expect(storageClass.parameters?.bucketName).toBe('company-assets');
      expect(storageClass.reclaimPolicy).toBe('Retain');
    });

    it('defaults the provisioner prefix to the Ceph cluster namespace like the Rook chart', () => {
      const storageClass = rookBucketStorageClass({
        name: 'cross-namespace-assets',
        objectStoreName: 'assets',
        objectStoreNamespace: 'rook-storage',
        operatorNamespace: 'rook-operator',
      });

      expect(String(storageClass.provisioner)).toBe('rook-storage.ceph.rook.io/bucket');
      expect(storageClass.parameters?.objectStoreNamespace).toBe('rook-storage');
    });

    it('accepts the exact unprefixed identity used by a global external provisioner', () => {
      const storageClass = rookBucketStorageClass({
        name: 'global-assets',
        objectStoreName: 'assets',
        objectStoreNamespace: 'rook-storage',
        provisionerName: 'ceph.rook.io/bucket',
      });

      expect(String(storageClass.provisioner)).toBe('ceph.rook.io/bucket');
    });
  });
});
