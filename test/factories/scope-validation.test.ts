import { describe, expect, it } from 'bun:test';
import { createResource } from '../../src/factories/shared.js';

describe('createResource scope validation', () => {
  it('should throw error when cluster-scoped resource has namespace', () => {
    expect(() => {
      createResource(
        {
          apiVersion: 'rbac.authorization.k8s.io/v1',
          kind: 'ClusterRole',
          metadata: { name: 'test-cluster-role', namespace: 'default' },
          spec: { rules: [] },
        },
        { scope: 'cluster' }
      );
    }).toThrow(/ClusterRole is cluster-scoped and cannot have a namespace/);
  });

  it('should allow cluster-scoped resource without namespace', () => {
    expect(() => {
      createResource(
        {
          apiVersion: 'rbac.authorization.k8s.io/v1',
          kind: 'ClusterRole',
          metadata: { name: 'test-cluster-role' },
          spec: { rules: [] },
        },
        { scope: 'cluster' }
      );
    }).not.toThrow();
  });

  it('should allow namespaced resource with namespace', () => {
    expect(() => {
      createResource(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'test-config', namespace: 'default' },
          spec: { data: {} },
        },
        { scope: 'namespaced' }
      );
    }).not.toThrow();
  });

  it('should warn but not throw when namespaced resource has no namespace', () => {
    expect(() => {
      createResource(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'test-config' },
          spec: { data: {} },
        },
        { scope: 'namespaced' }
      );
    }).not.toThrow();
  });

  it('should work without scope option for backward compatibility', () => {
    expect(() => {
      createResource({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'test-config', namespace: 'default' },
        spec: { data: {} },
      });
    }).not.toThrow();
  });

  it('should work without scope option even with cluster-scoped resource', () => {
    expect(() => {
      createResource({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRole',
        metadata: { name: 'test-cluster-role' },
        spec: { rules: [] },
      });
    }).not.toThrow();
  });

  it('should throw detailed error message for cluster-scoped violation', () => {
    try {
      createResource(
        {
          apiVersion: 'storage.k8s.io/v1',
          kind: 'StorageClass',
          metadata: { name: 'test-storage', namespace: 'kube-system' },
          provisioner: 'kubernetes.io/no-provisioner',
        },
        { scope: 'cluster' }
      );
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.message).toContain('StorageClass');
      expect(error.message).toContain('cluster-scoped');
      expect(error.message).toContain('cannot have a namespace');
    }
  });
});
