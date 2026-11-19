// `karpenterSpotPool`: the Karpenter controller plus one EC2NodeClass and one
// spot NodePool. Stable capacity is an EKS managed node group outside
// Karpenter; the controller runs there, tolerating its taint, and the chart's
// default affinity keeps it off Karpenter-managed nodes.
//
// TypeKro creates no AWS resources: the node role, the interruption queue and
// the discovery-tagged subnets and security groups are passed by name.

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { TypeKroError } from '../../../core/errors.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import {
  DEFAULT_KARPENTER_NAMESPACE,
  KARPENTER_AWS_GROUP,
  KARPENTER_DEFAULT_TOLERATIONS,
  KARPENTER_DISCOVERY_TAG,
  KARPENTER_LABELS,
} from '../constants.js';
import { ec2NodeClass } from '../resources/ec2-node-class.js';
import { nodePool } from '../resources/node-pool.js';
import { karpenterReady } from '../resources/readiness.js';
import {
  type KarpenterSpotPoolConfig,
  KarpenterSpotPoolConfigSchema,
  type KarpenterSpotPoolStatus,
  KarpenterSpotPoolStatusSchema,
} from '../types.js';
import { karpenterControllerResources } from './karpenter-bootstrap.js';

/** Arm64 families across c/m/r 6g/7g/8g. */
export const DEFAULT_SPOT_INSTANCE_FAMILIES = [
  'c6g',
  'c7g',
  'c8g',
  'm6g',
  'm7g',
  'm8g',
  'r6g',
  'r7g',
  'r8g',
];

export const DEFAULT_SPOT_INSTANCE_SIZES = ['large', 'xlarge'];

/**
 * Minimum distinct instance types Karpenter keeps in each spot launch, so a
 * shortage of one type falls through to another before on-demand.
 */
export const SPOT_MIN_INSTANCE_TYPES = 8;

/**
 * A pinned AMI alias, `<family>@v<version>` such as `al2023@v20251117`. It
 * refuses `@latest` and a second `@`, which Karpenter v1.15.2 accepts and then
 * crash-loops on (aws/karpenter-provider-aws#9800).
 */
export const PINNED_AMI_ALIAS = /^[a-z0-9]+@v[0-9][0-9A-Za-z._-]*$/;

/** True when `alias` is a concrete, pinned AMI alias. */
export function isPinnedAmiAlias(alias: unknown): boolean {
  return typeof alias === 'string' && PINNED_AMI_ALIAS.test(alias);
}

/** Throws unless `alias` is pinned. Graph references (KRO mode) pass. */
export function assertPinnedAmiAlias(alias: unknown): void {
  if (typeof alias === 'string' && !PINNED_AMI_ALIAS.test(alias)) {
    throw new TypeKroError(
      `amiAlias must be pinned, like "al2023@v20251117"; got "${alias}".`,
      'KARPENTER_AMI_ALIAS_NOT_PINNED',
      { alias }
    );
  }
}

/**
 * Karpenter controller, EC2NodeClass and spot NodePool.
 *
 * The pool's capacity types are `[spot, on-demand]`, so Karpenter prefers spot
 * and falls back to on-demand. It uses at least 8 arm64 instance types across
 * c/m/r 6g/7g/8g in sizes large and xlarge, spreads over `zones`, consolidates
 * empty or underutilized nodes after 5 minutes, disrupts one node at a time,
 * and has a CPU limit of 16 by default.
 *
 * Deploy it in direct mode, which installs the controller and CRDs before the
 * NodeClass and NodePool. KRO mode needs the Karpenter CRDs installed first,
 * and it cannot check that a referenced `amiAlias` is pinned.
 *
 * @example
 * ```typescript
 * const factory = karpenterSpotPool.factory('direct', { namespace: 'kube-system' });
 * await factory.deploy({
 *   name: 'karpenter',
 *   clusterName: 'platform',
 *   interruptionQueue: 'platform-karpenter',
 *   nodeRole: 'platform-karpenter-node',
 *   stableTaintKey: 'example.com/capacity-class',
 *   zones: ['us-east-1a', 'us-east-1b', 'us-east-1c'],
 *   amiAlias: 'al2023@v20251117',
 * });
 * ```
 */
export const karpenterSpotPool: CallableComposition<
  KarpenterSpotPoolConfig,
  KarpenterSpotPoolStatus
> = kubernetesComposition(
  {
    name: 'karpenter-spot-pool',
    kind: 'KarpenterSpotPool',
    spec: KarpenterSpotPoolConfigSchema,
    status: KarpenterSpotPoolStatusSchema,
  },
  (spec) => {
    assertPinnedAmiAlias(spec.amiAlias);

    const { controller, status: controllerStatus } = karpenterControllerResources({
      name: spec.name,
      namespace: Cel.default(spec.namespace, DEFAULT_KARPENTER_NAMESPACE),
      ...(spec.version !== undefined ? { version: spec.version } : {}),
      clusterName: spec.clusterName,
      interruptionQueue: spec.interruptionQueue,
      tolerations: [
        ...KARPENTER_DEFAULT_TOLERATIONS.map((toleration) => ({ ...toleration })),
        { key: spec.stableTaintKey, operator: 'Exists' as const },
      ],
    });

    const discovery = {
      [KARPENTER_DISCOVERY_TAG]: Cel.default(spec.discoveryTag, spec.clusterName),
    };
    const nodeClass = ec2NodeClass({
      name: spec.name,
      spec: {
        role: spec.nodeRole,
        amiSelectorTerms: [{ alias: spec.amiAlias }],
        subnetSelectorTerms: [{ tags: discovery }],
        securityGroupSelectorTerms: [{ tags: discovery }],
      },
      id: 'nodeClass',
    });
    nodeClass.dependsOn(controller);

    const spotPool = nodePool({
      name: Cel.template('%s-spot', spec.name),
      spec: {
        template: {
          spec: {
            nodeClassRef: { group: KARPENTER_AWS_GROUP, kind: 'EC2NodeClass', name: spec.name },
            requirements: [
              { key: KARPENTER_LABELS.capacityType, operator: 'In', values: ['spot', 'on-demand'] },
              {
                key: KARPENTER_LABELS.instanceFamily,
                operator: 'In',
                values: Cel.default(spec.spotInstanceFamilies, DEFAULT_SPOT_INSTANCE_FAMILIES),
              },
              {
                key: KARPENTER_LABELS.instanceSize,
                operator: 'In',
                values: Cel.default(spec.spotInstanceSizes, DEFAULT_SPOT_INSTANCE_SIZES),
              },
              {
                key: KARPENTER_LABELS.instanceType,
                operator: 'Exists',
                minValues: SPOT_MIN_INSTANCE_TYPES,
              },
              { key: KARPENTER_LABELS.arch, operator: 'In', values: ['arm64'] },
              { key: KARPENTER_LABELS.os, operator: 'In', values: ['linux'] },
              { key: KARPENTER_LABELS.zone, operator: 'In', values: spec.zones },
            ],
            expireAfter: Cel.default(spec.expireAfter, '720h'),
          },
        },
        disruption: {
          consolidationPolicy: 'WhenEmptyOrUnderutilized',
          consolidateAfter: Cel.default(spec.consolidateAfter, '5m'),
          budgets: [{ nodes: '1' }],
        },
        limits: { cpu: Cel.default(spec.spotCpuLimit, '16') },
      },
      id: 'spotPool',
    });
    spotPool.dependsOn(nodeClass);

    return {
      ready: Cel.expr<boolean>(controllerStatus.ready, ' && ', karpenterReady(nodeClass, spotPool)),
      controllerReady: controllerStatus.ready,
      capacityReady: karpenterReady(nodeClass, spotPool),
    };
  }
);
