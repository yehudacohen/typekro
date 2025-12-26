import { describe, test, expect } from 'bun:test';
import { clusterRoleBinding } from '../../src/factories/kubernetes/rbac/index.js';

describe('ClusterRoleBinding Array Serialization', () => {
  test('subjects field should remain an array after structuredClone', () => {
    const crb = clusterRoleBinding({
      metadata: {
        name: 'test-cluster-reconciler',
        labels: {
          'app.kubernetes.io/instance': 'test',
        },
      },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: 'cluster-admin',
      },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: 'kustomize-controller',
          namespace: 'flux-system',
        },
        {
          kind: 'ServiceAccount',
          name: 'helm-controller',
          namespace: 'flux-system',
        },
      ],
    });

    console.log('Original subjects:', (crb as any).subjects);
    console.log('Original isArray:', Array.isArray((crb as any).subjects));
    console.log('Original keys:', Object.keys((crb as any).subjects));

    expect(Array.isArray((crb as any).subjects)).toBe(true);

    // Test with toJSON (which is what the resolver now uses)
    const plainObject = (crb as any).toJSON();
    console.log('\nAfter toJSON subjects:', plainObject.subjects);
    console.log('After toJSON isArray:', Array.isArray(plainObject.subjects));
    console.log('After toJSON keys:', Object.keys(plainObject.subjects));

    expect(Array.isArray(plainObject.subjects)).toBe(true);
    expect(plainObject.subjects.length).toBe(2);

    // Now clone the plain object
    const cloned = structuredClone(plainObject);
    console.log('\nCloned subjects:', cloned.subjects);
    console.log('Cloned isArray:', Array.isArray(cloned.subjects));
    console.log('Cloned keys:', Object.keys(cloned.subjects));

    expect(Array.isArray(cloned.subjects)).toBe(true);
    expect(cloned.subjects.length).toBe(2);
  });
});
