/**
 * Karpenter on EKS: the controller plus two NodePools.
 *
 *  1. `karpenterBootstrap` installs the CRDs (`karpenter-crd`) and the
 *     controller with Flux. IAM, the SQS interruption queue and the discovery
 *     tags are AWS prerequisites created outside TypeKro (see
 *     docs/api/karpenter).
 *  2. One `EC2NodeClass` picks the latest AL2023 AMI and finds subnets and
 *     security groups by their `karpenter.sh/discovery` tag.
 *  3. A spot `NodePool` for batch and dev work, tainted so only workloads that
 *     tolerate interruption land on it, and an on-demand `NodePool` for
 *     everything else. Both are capped by `limits`.
 *
 * Run: `bun run build:examples` typechecks this file.
 */

import type { KubeConfig } from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../src/core/composition/imperative.js';
import { karpenterBootstrap } from '../src/factories/karpenter/compositions/karpenter-bootstrap.js';
import { KARPENTER_DISCOVERY_TAG, KARPENTER_LABELS } from '../src/factories/karpenter/constants.js';
import { ec2NodeClass } from '../src/factories/karpenter/resources/ec2-node-class.js';
import { nodePool } from '../src/factories/karpenter/resources/node-pool.js';
import { karpenterReady } from '../src/factories/karpenter/resources/readiness.js';

/** Node capacity for one cluster. */
export const clusterCapacity = kubernetesComposition(
  {
    name: 'cluster-capacity',
    kind: 'ClusterCapacity',
    spec: type({
      clusterName: 'string',
      /** IAM role name the nodes run as (Karpenter creates its instance profile). */
      nodeRole: 'string',
    }),
    status: type({
      ready: 'boolean',
      spotNodes: 'number',
      onDemandNodes: 'number',
    }),
  },
  (spec) => {
    const nodeClass = ec2NodeClass({
      name: 'default',
      spec: {
        role: spec.nodeRole,
        amiSelectorTerms: [{ alias: 'al2023@latest' }],
        subnetSelectorTerms: [{ tags: { [KARPENTER_DISCOVERY_TAG]: spec.clusterName } }],
        securityGroupSelectorTerms: [{ tags: { [KARPENTER_DISCOVERY_TAG]: spec.clusterName } }],
        blockDeviceMappings: [
          {
            deviceName: '/dev/xvda',
            rootVolume: true,
            ebs: { volumeSize: '50Gi', volumeType: 'gp3', encrypted: true },
          },
        ],
        // IMDSv2 only, and unreachable from pods (hop limit 1).
        metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1 },
        kubelet: { maxPods: 110 },
        tags: { team: 'platform' },
      },
      id: 'defaultNodeClass',
    });

    const spot = nodePool({
      name: 'spot-batch',
      spec: {
        template: {
          metadata: { labels: { workload: 'batch' } },
          spec: {
            nodeClassRef: { name: 'default' },
            requirements: [
              { key: KARPENTER_LABELS.capacityType, operator: 'In', values: ['spot'] },
              { key: KARPENTER_LABELS.instanceCategory, operator: 'In', values: ['c', 'm', 'r'] },
              { key: KARPENTER_LABELS.instanceGeneration, operator: 'Gt', values: ['5'] },
              { key: KARPENTER_LABELS.arch, operator: 'In', values: ['amd64', 'arm64'] },
              // Keep at least five instance families in play so spot capacity
              // can be found when one family runs dry.
              {
                key: KARPENTER_LABELS.instanceFamily,
                operator: 'Exists',
                minValues: 5,
              },
            ],
            // Only batch and dev workloads tolerate this taint.
            taints: [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }],
            expireAfter: '168h',
          },
        },
        disruption: {
          consolidationPolicy: 'WhenEmptyOrUnderutilized',
          consolidateAfter: '1m',
          budgets: [{ nodes: '20%' }],
        },
        limits: { cpu: '400', memory: '1600Gi' },
        weight: 10,
      },
      id: 'spotBatchPool',
    });

    const onDemand = nodePool({
      name: 'on-demand',
      spec: {
        template: {
          spec: {
            nodeClassRef: { name: 'default' },
            requirements: [
              { key: KARPENTER_LABELS.capacityType, operator: 'In', values: ['on-demand'] },
              { key: KARPENTER_LABELS.instanceCategory, operator: 'In', values: ['c', 'm', 'r'] },
              { key: KARPENTER_LABELS.instanceSize, operator: 'NotIn', values: ['metal'] },
            ],
            expireAfter: '720h',
            terminationGracePeriod: '24h',
          },
        },
        disruption: {
          consolidationPolicy: 'WhenEmpty',
          consolidateAfter: '5m',
          // No voluntary disruption during business hours on weekdays.
          budgets: [
            { nodes: '10%' },
            {
              nodes: '0',
              schedule: '0 8 * * mon-fri',
              duration: '10h',
              reasons: ['Underutilized'],
            },
          ],
        },
        limits: { cpu: '200', memory: '800Gi' },
      },
      id: 'onDemandPool',
    });

    return {
      ready: karpenterReady(nodeClass, spot, onDemand),
      spotNodes: spot.status.nodes,
      onDemandNodes: onDemand.status.nodes,
    };
  }
);

/** Install the controller, then the node capacity. */
export async function deployKarpenter(kubeConfig: KubeConfig) {
  await karpenterBootstrap
    .factory('direct', { namespace: 'flux-system', waitForReady: true, kubeConfig })
    .deploy({
      name: 'karpenter',
      clusterName: 'my-cluster',
      interruptionQueue: 'my-cluster',
      // IRSA. With EKS Pod Identity, omit the annotation and associate the
      // role with the `karpenter` ServiceAccount in kube-system instead.
      serviceAccount: {
        annotations: {
          'eks.amazonaws.com/role-arn':
            'arn:aws:iam::111122223333:role/KarpenterController-my-cluster',
        },
      },
      resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '1Gi' } },
    });

  return clusterCapacity
    .factory('direct', { namespace: 'default', waitForReady: true, kubeConfig })
    .deploy({ clusterName: 'my-cluster', nodeRole: 'KarpenterNodeRole-my-cluster' });
}
