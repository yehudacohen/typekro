import { describe, expect, it } from 'bun:test';
import {
  // New Certificate Resources
  certificateSigningRequest,
  componentStatus,
  csiDriver,
  csiNode,
  // New Extensions Resources
  customResourceDefinition,
  // New Autoscaling V1 Resources
  horizontalPodAutoscalerV1,
  // New Networking Resources
  ingressClass,
  isKubernetesRef,
  // New Coordination Resources
  lease,
  // New Admission Resources
  mutatingWebhookConfiguration,
  // New Core Resources
  node,
  // New Priority and Runtime Resources
  priorityClass,
  // New Apps Resources
  replicationController,
  runtimeClass,
  // Serialization
  toResourceGraph,
  validatingWebhookConfiguration,
  // New Storage Resources
  volumeAttachment,
} from '../../src/index';

describe('New Resource Factory Coverage', () => {
  describe('Apps Resources', () => {
    it('should create ReplicationController with proper type safety', () => {
      const rc = replicationController({
        metadata: { name: 'test-rc' },
        spec: {
          replicas: 3,
          selector: { app: 'test' },
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

      expect(rc.metadata.name).toBe('test-rc');
      expect(rc.kind).toBe('ReplicationController');
      expect(rc.apiVersion).toBe('v1');

      // Test cross-resource references
      const statusRef = rc.status?.replicas;
      expect(isKubernetesRef(statusRef)).toBe(true);
    });
  });

  describe('Core Resources', () => {
    it('should create Node with proper type safety', () => {
      const node1 = node({
        metadata: { name: 'worker-node-1' },
        spec: {
          podCIDR: '10.244.1.0/24',
        },
      });

      expect(node1.metadata.name).toBe('worker-node-1');
      expect(node1.kind).toBe('Node');
      expect(node1.apiVersion).toBe('v1');

      // Test status references
      const statusRef = node1.status?.nodeInfo;
      expect(isKubernetesRef(statusRef)).toBe(true);
    });

    it('should create ComponentStatus', () => {
      const cs = componentStatus({
        metadata: { name: 'etcd-0' },
        conditions: [
          {
            type: 'Healthy',
            status: 'True',
            message: 'etcd is healthy',
          },
        ],
      });

      expect(cs.metadata.name).toBe('etcd-0');
      expect(cs.kind).toBe('ComponentStatus');
      expect(cs.apiVersion).toBe('v1');
    });
  });

  describe('Storage Resources', () => {
    it('should create VolumeAttachment', () => {
      const va = volumeAttachment({
        metadata: { name: 'test-volume-attachment' },
        spec: {
          attacher: 'csi-driver',
          source: {
            persistentVolumeName: 'test-pv',
          },
          nodeName: 'worker-node-1',
        },
      });

      expect(va.metadata.name).toBe('test-volume-attachment');
      expect(va.kind).toBe('VolumeAttachment');
      expect(va.apiVersion).toBe('storage.k8s.io/v1');
    });

    it('should create CSIDriver', () => {
      const driver = csiDriver({
        metadata: { name: 'test-csi-driver' },
        spec: {
          attachRequired: true,
          podInfoOnMount: true,
        },
      });

      expect(driver.metadata.name).toBe('test-csi-driver');
      expect(driver.kind).toBe('CSIDriver');
      expect(driver.apiVersion).toBe('storage.k8s.io/v1');
    });

    it('should create CSINode', () => {
      const csinode = csiNode({
        metadata: { name: 'worker-node-1' },
        spec: {
          drivers: [
            {
              name: 'test-csi-driver',
              nodeID: 'node-1',
              topologyKeys: ['zone'],
            },
          ],
        },
      });

      expect(csinode.metadata.name).toBe('worker-node-1');
      expect(csinode.kind).toBe('CSINode');
      expect(csinode.apiVersion).toBe('storage.k8s.io/v1');
    });
  });

  describe('Networking Resources', () => {
    it('should create IngressClass', () => {
      const ic = ingressClass({
        metadata: { name: 'nginx-ingress' },
        spec: {
          controller: 'nginx.org/ingress-controller',
        },
      });

      expect(ic.metadata.name).toBe('nginx-ingress');
      expect(ic.kind).toBe('IngressClass');
      expect(ic.apiVersion).toBe('networking.k8s.io/v1');
    });
  });

  describe('Certificate Resources', () => {
    it('should create CertificateSigningRequest', () => {
      const csr = certificateSigningRequest({
        metadata: { name: 'test-csr' },
        spec: {
          request: Buffer.from('test-csr-data').toString('base64'),
          signerName: 'kubernetes.io/kube-apiserver-client',
          usages: ['client auth'],
        },
      });

      expect(csr.metadata.name).toBe('test-csr');
      expect(csr.kind).toBe('CertificateSigningRequest');
      expect(csr.apiVersion).toBe('certificates.k8s.io/v1');

      // Test status references
      const statusRef = csr.status?.conditions;
      expect(isKubernetesRef(statusRef)).toBe(true);
    });
  });

  describe('Coordination Resources', () => {
    it('should create Lease', () => {
      const lease1 = lease({
        metadata: { name: 'test-lease', namespace: 'kube-system' },
        spec: {
          holderIdentity: 'test-holder',
          leaseDurationSeconds: 30,
        },
      });

      expect(lease1.metadata.name).toBe('test-lease');
      expect(lease1.kind).toBe('Lease');
      expect(lease1.apiVersion).toBe('coordination.k8s.io/v1');
    });
  });

  describe('Admission Resources', () => {
    it('should create MutatingWebhookConfiguration', () => {
      const mwc = mutatingWebhookConfiguration({
        metadata: { name: 'test-mutating-webhook' },
        webhooks: [
          {
            name: 'test-webhook.example.com',
            sideEffects: 'None',
            clientConfig: {
              service: {
                name: 'webhook-service',
                namespace: 'default',
                path: '/mutate',
              },
            },
            rules: [
              {
                operations: ['CREATE'],
                apiGroups: [''],
                apiVersions: ['v1'],
                resources: ['pods'],
              },
            ],
            admissionReviewVersions: ['v1'],
          },
        ],
      });

      expect(mwc.metadata.name).toBe('test-mutating-webhook');
      expect(mwc.kind).toBe('MutatingAdmissionWebhook');
      expect(mwc.apiVersion).toBe('admissionregistration.k8s.io/v1');
    });

    it('should create ValidatingWebhookConfiguration', () => {
      const vwc = validatingWebhookConfiguration({
        metadata: { name: 'test-validating-webhook' },
        webhooks: [
          {
            name: 'test-webhook.example.com',
            sideEffects: 'None',
            clientConfig: {
              service: {
                name: 'webhook-service',
                namespace: 'default',
                path: '/validate',
              },
            },
            rules: [
              {
                operations: ['CREATE', 'UPDATE'],
                apiGroups: [''],
                apiVersions: ['v1'],
                resources: ['pods'],
              },
            ],
            admissionReviewVersions: ['v1'],
          },
        ],
      });

      expect(vwc.metadata.name).toBe('test-validating-webhook');
      expect(vwc.kind).toBe('ValidatingAdmissionWebhook');
      expect(vwc.apiVersion).toBe('admissionregistration.k8s.io/v1');
    });
  });

  describe('Extensions Resources', () => {
    it('should create CustomResourceDefinition', () => {
      const crd = customResourceDefinition({
        metadata: { name: 'databases.example.com' },
        spec: {
          group: 'example.com',
          versions: [
            {
              name: 'v1',
              served: true,
              storage: true,
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: {
                      type: 'object',
                      properties: {
                        engine: { type: 'string' },
                        version: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          ],
          scope: 'Namespaced',
          names: {
            plural: 'databases',
            singular: 'database',
            kind: 'Database',
          },
        },
      });

      expect(crd.metadata.name).toBe('databases.example.com');
      expect(crd.kind).toBe('CustomResourceDefinition');
      expect(crd.apiVersion).toBe('apiextensions.k8s.io/v1');

      // Test status references
      const statusRef = crd.status?.conditions;
      expect(isKubernetesRef(statusRef)).toBe(true);
    });
  });

  describe('Priority and Runtime Resources', () => {
    it('should create PriorityClass', () => {
      const pc = priorityClass({
        metadata: { name: 'high-priority' },
        value: 1000,
        globalDefault: false,
        description: 'High priority class for critical workloads',
      });

      expect(pc.metadata.name).toBe('high-priority');
      expect(pc.kind).toBe('PriorityClass');
      expect(pc.apiVersion).toBe('scheduling.k8s.io/v1');
    });

    it('should create RuntimeClass', () => {
      const rc = runtimeClass({
        metadata: { name: 'gvisor' },
        handler: 'runsc',
      });

      expect(rc.metadata.name).toBe('gvisor');
      expect(rc.kind).toBe('RuntimeClass');
      expect(rc.apiVersion).toBe('node.k8s.io/v1');
    });
  });

  describe('Autoscaling V1 Resources', () => {
    it('should create HorizontalPodAutoscaler V1', () => {
      const hpa = horizontalPodAutoscalerV1({
        metadata: { name: 'test-hpa-v1' },
        spec: {
          scaleTargetRef: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            name: 'test-deployment',
          },
          minReplicas: 2,
          maxReplicas: 10,
          targetCPUUtilizationPercentage: 70,
        },
      });

      expect(hpa.metadata.name).toBe('test-hpa-v1');
      expect(hpa.kind).toBe('HorizontalPodAutoscaler');
      expect(hpa.apiVersion).toBe('autoscaling/v1');

      // Test status references
      const statusRef = hpa.status?.currentReplicas;
      expect(isKubernetesRef(statusRef)).toBe(true);
    });
  });

  describe('Cross-Resource References with New Resources', () => {
    it('should support type-safe references between new resource types', () => {
      const node1 = node({
        metadata: { name: 'worker-node-1' },
        spec: { podCIDR: '10.244.1.0/24' },
      });

      const lease1 = lease({
        metadata: { name: 'node-lease', namespace: 'kube-node-lease' },
        spec: {
          holderIdentity: node1.metadata.name!, // Type-safe reference
          leaseDurationSeconds: 40,
        },
      });

      const pc = priorityClass({
        metadata: { name: 'node-critical' },
        value: 2000,
        description: 'Priority class for node-critical workloads',
      });

      // Test that references work correctly
      expect(isKubernetesRef(node1.status?.nodeInfo)).toBe(true);
      expect(typeof lease1.spec?.holderIdentity).toBe('string');
      expect(pc.value).toBe(2000);
    });
  });

  describe('Serialization with New Resources', () => {
    it('should serialize new resource types correctly', async () => {
      const node1 = node({
        metadata: { name: 'worker-node-1' },
        spec: { podCIDR: '10.244.1.0/24' },
      });

      const lease1 = lease({
        metadata: { name: 'node-lease', namespace: 'kube-node-lease' },
        spec: {
          holderIdentity: node1.metadata.name!,
          leaseDurationSeconds: 40,
        },
      });

      const pc = priorityClass({
        metadata: { name: 'high-priority' },
        value: 1000,
        description: 'High priority workloads',
      });

      const { type } = await import('arktype');
      const TestSchema = type({ name: 'string' });
      const resourceGraph = toResourceGraph(
        {
          name: 'comprehensive-resources',
          apiVersion: 'test.com/v1',
          kind: 'TestResource',
          spec: TestSchema,
          status: TestSchema,
        },
        () => ({ node1, lease1, pc }),
        () => ({ name: 'test-status' })
      );

      const yaml = resourceGraph.toYaml();

      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('workerNode1');
      expect(yaml).toContain('nodeLease');
      expect(yaml).toContain('priorityclassHighPriority');
    });
  });
});
