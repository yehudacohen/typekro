// Karpenter `NodePool` factory (`karpenter.sh/v1`, cluster-scoped).

import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Composable, Enhanced, ReadinessEvaluator } from '../../../core/types/index.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { createResource } from '../../shared.js';
import { KARPENTER_API_VERSION, KARPENTER_AWS_GROUP } from '../constants.js';
import type { NodePoolConfig, NodePoolSpec, NodePoolStatus } from '../types.js';
import { assertNoKarpenterErrors, validateNodePoolSpec } from '../utils/validation.js';
import { evaluateKarpenterReadiness } from './readiness.js';

/** `NodePool` readiness: `Ready=True` for the current generation. */
export const nodePoolReadinessEvaluator: ReadinessEvaluator<unknown> =
  registerPortableReadinessEvaluator('typekro.readiness.karpenter.node-pool', '1', (resource) =>
    evaluateKarpenterReadiness('NodePool', resource)
  );

// A spec (or nodeClassRef) passed whole as a schema reference cannot be
// spread; it goes through unchanged and must carry group/kind itself.
function withNodeClassDefaults(spec: NodePoolSpec): NodePoolSpec {
  const ref = isKubernetesRef(spec) ? undefined : spec.template?.spec?.nodeClassRef;
  if (
    !ref ||
    isKubernetesRef(spec.template) ||
    isKubernetesRef(spec.template.spec) ||
    isKubernetesRef(ref)
  ) {
    return spec;
  }
  return {
    ...spec,
    template: {
      ...spec.template,
      spec: {
        ...spec.template.spec,
        nodeClassRef: {
          group: ref.group ?? KARPENTER_AWS_GROUP,
          kind: ref.kind ?? 'EC2NodeClass',
          name: ref.name,
        },
      },
    },
  };
}

/**
 * Create a Karpenter `NodePool`.
 *
 * `nodeClassRef.group` and `nodeClassRef.kind` default to the AWS
 * `EC2NodeClass`. Throws on the errors {@link validateNodePoolSpec} reports.
 *
 * @example
 * ```typescript
 * nodePool({
 *   name: 'general',
 *   spec: {
 *     template: {
 *       spec: {
 *         nodeClassRef: { name: 'default' },
 *         requirements: [
 *           { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] },
 *           { key: 'karpenter.k8s.aws/instance-category', operator: 'In', values: ['c', 'm', 'r'] },
 *         ],
 *       },
 *     },
 *     limits: { cpu: '200', memory: '800Gi' },
 *   },
 *   id: 'generalPool',
 * });
 * ```
 */
export function nodePool(
  config: Composable<NodePoolConfig>
): Enhanced<NodePoolSpec, NodePoolStatus> {
  const spec = config.spec as NodePoolSpec;
  assertNoKarpenterErrors('NodePool', config.name, validateNodePoolSpec(spec));
  return createResource<NodePoolSpec, NodePoolStatus>(
    {
      apiVersion: KARPENTER_API_VERSION,
      kind: 'NodePool',
      metadata: {
        name: config.name,
        ...(config.labels ? { labels: config.labels as Record<string, string> } : {}),
        ...(config.annotations
          ? { annotations: config.annotations as Record<string, string> }
          : {}),
      },
      spec: withNodeClassDefaults(spec),
      ...(config.id ? { id: config.id } : {}),
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(nodePoolReadinessEvaluator);
}
