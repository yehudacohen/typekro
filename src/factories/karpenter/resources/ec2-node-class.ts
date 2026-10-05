// Karpenter `EC2NodeClass` factory (`karpenter.k8s.aws/v1`, cluster-scoped).

import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Composable, Enhanced, ReadinessEvaluator } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { KARPENTER_AWS_API_VERSION } from '../constants.js';
import type { EC2NodeClassConfig, EC2NodeClassSpec, EC2NodeClassStatus } from '../types.js';
import {
  assertNoKarpenterErrors,
  validateEC2NodeClassSpec,
  warnKarpenterIssues,
} from '../utils/validation.js';
import { evaluateKarpenterReadiness } from './readiness.js';

/** `EC2NodeClass` readiness: `Ready=True` (AMIs, subnets, security groups and profile resolved). */
export const ec2NodeClassReadinessEvaluator: ReadinessEvaluator<unknown> =
  registerPortableReadinessEvaluator(
    'typekro.readiness.karpenter.ec2-node-class',
    '1',
    (resource) => evaluateKarpenterReadiness('EC2NodeClass', resource)
  );

/**
 * Create a Karpenter `EC2NodeClass`.
 *
 * IMDS options are left to the CRD default (IMDSv2 required, hop limit 1).
 * Throws on the errors {@link validateEC2NodeClassSpec} reports.
 *
 * @example
 * ```typescript
 * ec2NodeClass({
 *   name: 'default',
 *   spec: {
 *     role: 'KarpenterNodeRole-my-cluster',
 *     amiSelectorTerms: [{ alias: 'al2023@latest' }],
 *     subnetSelectorTerms: [{ tags: { 'karpenter.sh/discovery': 'my-cluster' } }],
 *     securityGroupSelectorTerms: [{ tags: { 'karpenter.sh/discovery': 'my-cluster' } }],
 *   },
 *   id: 'defaultNodeClass',
 * });
 * ```
 */
export function ec2NodeClass(
  config: Composable<EC2NodeClassConfig>
): Enhanced<EC2NodeClassSpec, EC2NodeClassStatus> {
  const spec = config.spec as EC2NodeClassSpec;
  const issues = validateEC2NodeClassSpec(spec, config.name as string);
  assertNoKarpenterErrors('EC2NodeClass', config.name, issues);
  warnKarpenterIssues('ec2NodeClass', issues);
  return createResource<EC2NodeClassSpec, EC2NodeClassStatus>(
    {
      apiVersion: KARPENTER_AWS_API_VERSION,
      kind: 'EC2NodeClass',
      metadata: {
        name: config.name,
        ...(config.labels ? { labels: config.labels as Record<string, string> } : {}),
        ...(config.annotations
          ? { annotations: config.annotations as Record<string, string> }
          : {}),
      },
      spec,
      ...(config.id ? { id: config.id } : {}),
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(ec2NodeClassReadinessEvaluator);
}
