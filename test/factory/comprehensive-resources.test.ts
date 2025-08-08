import { describe, expect, it } from 'bun:test';
import {
  clusterRole,
  clusterRoleBinding,
  // Apps resources
  daemonSet,
  endpointSlice,
  // Networking resources
  endpoints,
  // Utils
  isKubernetesRef,
  limitRange,
  namespace,
  persistentVolume,
  // Core resources
  pod,
  // Policy resources
  podDisruptionBudget,
  replicaSet,
  resourceQuota,
  // RBAC resources
  role,
  roleBinding,
  serviceAccount,
  // Storage resources
  storageClass,
} from '../../src/index';

describe('Comprehensive Resource Factory Coverage', () => {
  describe('RBAC Resources', () => {
    it('should create Role with proper type safety', () => {
      const testRole = role({
        metadata: { name: 'test-role' },
        rules: [
          {
            apiGroups: [''],
            resources: ['pods'],
            verbs: ['get', 'list'],
          },
        ],
      });

      expect(testRole.kind).toBe('Role');
      expect(testRole.apiVersion).toBe('rbac.authorization.k8s.io/v1');
      expect(testRole.metadata.name).toBe('test-role');
      expect(testRole.rules).toHaveLength(1);
    });

    it('should create RoleBinding with cross-resource references', () => {
      const testRole = role({
        metadata: { name: 'test-role' },
        rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }],
      });

      const testRoleBinding = roleBinding({
        metadata: { name: 'test-binding' },
        subjects: [
          {
            kind: 'ServiceAccount',
            name: 'test-sa',
            namespace: 'default',
          },
        ],
        roleRef: {
          kind: 'Role',
          name: testRole.metadata.name!,
          apiGroup: 'rbac.authorization.k8s.io',
        },
      });

      expect(testRoleBinding.kind).toBe('RoleBinding');
      expect(testRoleBinding.roleRef.name).toBe('test-role');
    });

    it('should create ServiceAccount', () => {
      const sa = serviceAccount({
        metadata: { name: 'test-sa' },
      });

      expect(sa.kind).toBe('ServiceAccount');
      expect(sa.apiVersion).toBe('v1');
      expect(sa.metadata.name).toBe('test-sa');
    });

    it('should create ClusterRole and ClusterRoleBinding', () => {
      const cr = clusterRole({
        metadata: { name: 'cluster-admin' },
        rules: [
          {
            apiGroups: ['*'],
            resources: ['*'],
            verbs: ['*'],
          },
        ],
      });

      const crb = clusterRoleBinding({
        metadata: { name: 'cluster-admin-binding' },
        subjects: [
          {
            kind: 'ServiceAccount',
            name: 'admin',
            namespace: 'kube-system',
          },
        ],
        roleRef: {
          kind: 'ClusterRole',
          name: cr.metadata.name!,
          apiGroup: 'rbac.authorization.k8s.io',
        },
      });

      expect(cr.kind).toBe('ClusterRole');
      expect(crb.kind).toBe('ClusterRoleBinding');
      expect(crb.roleRef.name).toBe('cluster-admin');
    });
  });

  describe('Apps Resources', () => {
    it('should create DaemonSet with proper pod template', () => {
      const ds = daemonSet({
        metadata: { name: 'test-daemonset' },
        spec: {
          selector: { matchLabels: { app: 'test' } },
          template: {
            metadata: { labels: { app: 'test' } },
            spec: {
              containers: [
                {
                  name: 'test-container',
                  image: 'nginx:latest',
                },
              ],
            },
          },
        },
      });

      expect(ds.kind).toBe('DaemonSet');
      expect(ds.apiVersion).toBe('apps/v1');
      expect(ds.metadata.name).toBe('test-daemonset');
    });

    it('should create ReplicaSet', () => {
      const rs = replicaSet({
        metadata: { name: 'test-replicaset' },
        spec: {
          replicas: 3,
          selector: { matchLabels: { app: 'test' } },
          template: {
            metadata: { labels: { app: 'test' } },
            spec: {
              containers: [
                {
                  name: 'test-container',
                  image: 'nginx:latest',
                },
              ],
            },
          },
        },
      });

      expect(rs.kind).toBe('ReplicaSet');
      expect(rs.apiVersion).toBe('apps/v1');
      expect(rs.spec?.replicas).toBe(3);
    });
  });

  describe('Core Resources', () => {
    it('should create Pod with type-safe references', () => {
      const testPod = pod({
        metadata: { name: 'test-pod' },
        spec: {
          containers: [
            {
              name: 'test-container',
              image: 'nginx:latest',
            },
          ],
        },
      });

      expect(testPod.kind).toBe('Pod');
      expect(testPod.apiVersion).toBe('v1');
      expect(testPod.metadata.name).toBe('test-pod');

      // Test that status references work
      const statusRef = testPod.status?.phase;
      expect(isKubernetesRef(statusRef)).toBe(true);
    });

    it('should create Namespace', () => {
      const ns = namespace({
        metadata: { name: 'test-namespace' },
      });

      expect(ns.kind).toBe('Namespace');
      expect(ns.apiVersion).toBe('v1');
      expect(ns.metadata.name).toBe('test-namespace');
    });

    it('should create PersistentVolume', () => {
      const pv = persistentVolume({
        metadata: { name: 'test-pv' },
        spec: {
          capacity: { storage: '10Gi' },
          accessModes: ['ReadWriteOnce'],
          hostPath: { path: '/tmp/data' },
        },
      });

      expect(pv.kind).toBe('PersistentVolume');
      expect(pv.apiVersion).toBe('v1');
      expect(pv.spec?.capacity?.storage).toBe('10Gi');
    });
  });

  describe('Policy Resources', () => {
    it('should create PodDisruptionBudget', () => {
      const pdb = podDisruptionBudget({
        metadata: { name: 'test-pdb' },
        spec: {
          minAvailable: 1,
          selector: { matchLabels: { app: 'test' } },
        },
      });

      expect(pdb.kind).toBe('PodDisruptionBudget');
      expect(pdb.apiVersion).toBe('policy/v1');
      expect(pdb.spec?.minAvailable).toBe(1);
    });

    it('should create ResourceQuota', () => {
      const quota = resourceQuota({
        metadata: { name: 'test-quota' },
        spec: {
          hard: {
            'requests.cpu': '4',
            'requests.memory': '8Gi',
            'limits.cpu': '8',
            'limits.memory': '16Gi',
          },
        },
      });

      expect(quota.kind).toBe('ResourceQuota');
      expect(quota.apiVersion).toBe('v1');
      expect(quota.spec?.hard?.['requests.cpu']).toBe('4');
    });

    it('should create LimitRange', () => {
      const lr = limitRange({
        metadata: { name: 'test-limits' },
        spec: {
          limits: [
            {
              type: 'Container',
              _default: {
                cpu: '100m',
                memory: '128Mi',
              },
              defaultRequest: {
                cpu: '50m',
                memory: '64Mi',
              },
            },
          ],
        },
      });

      expect(lr.kind).toBe('LimitRange');
      expect(lr.apiVersion).toBe('v1');
      expect(lr.spec?.limits).toHaveLength(1);
    });
  });

  describe('Storage Resources', () => {
    it('should create StorageClass', () => {
      const sc = storageClass({
        metadata: { name: 'fast-ssd' },
        provisioner: 'kubernetes.io/gce-pd',
        parameters: {
          type: 'pd-ssd',
          replication: 'none',
        },
      });

      expect(sc.kind).toBe('StorageClass');
      expect(sc.apiVersion).toBe('storage.k8s.io/v1');
      expect(sc.provisioner).toBe('kubernetes.io/gce-pd' as any);
    });
  });

  describe('Networking Resources', () => {
    it('should create Endpoints', () => {
      const ep = endpoints({
        metadata: { name: 'test-endpoints' },
        subsets: [
          {
            addresses: [{ ip: '192.168.1.1' }],
            ports: [{ port: 80, protocol: 'TCP' }],
          },
        ],
      });

      expect(ep.kind).toBe('Endpoints');
      expect(ep.apiVersion).toBe('v1');
      expect(ep.subsets).toHaveLength(1);
    });

    it('should create EndpointSlice', () => {
      const es = endpointSlice({
        metadata: { name: 'test-endpointslice' },
        addressType: 'IPv4',
        endpoints: [
          {
            addresses: ['192.168.1.1'],
            conditions: { ready: true },
          },
        ],
        ports: [{ port: 80, protocol: 'TCP' }],
      });

      expect(es.kind).toBe('EndpointSlice');
      expect(es.apiVersion).toBe('discovery.k8s.io/v1');
      expect(es.addressType).toBe('IPv4');
    });
  });

  describe('Cross-Resource References', () => {
    it('should support type-safe references between different resource types', () => {
      // Create a service account
      const sa = serviceAccount({
        metadata: { name: 'app-sa', namespace: 'default' },
      });

      // Create a role
      const appRole = role({
        metadata: { name: 'app-role' },
        rules: [
          {
            apiGroups: [''],
            resources: ['configmaps'],
            verbs: ['get', 'list'],
          },
        ],
      });

      // Create role binding that references both
      const binding = roleBinding({
        metadata: { name: 'app-binding' },
        subjects: [
          {
            kind: 'ServiceAccount',
            name: sa.metadata.name!,
            namespace: sa.metadata.namespace || 'default',
          },
        ],
        roleRef: {
          kind: 'Role',
          name: appRole.metadata.name!,
          apiGroup: 'rbac.authorization.k8s.io',
        },
      });

      // Create a pod that uses the service account
      const appPod = pod({
        metadata: { name: 'app-pod' },
        spec: {
          serviceAccountName: sa.metadata.name!,
          containers: [
            {
              name: 'app',
              image: 'nginx:latest',
            },
          ],
        },
      });

      expect(binding.subjects?.[0]?.name).toBe('app-sa');
      expect(binding.roleRef.name).toBe('app-role');
      expect(appPod.spec?.serviceAccountName).toBe('app-sa');
    });
  });
});
