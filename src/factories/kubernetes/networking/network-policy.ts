import type { V1NetworkPolicy } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1NetworkPolicySpec = NonNullable<V1NetworkPolicy['spec']>;

export function networkPolicy(
  resource: V1NetworkPolicy & { id?: string }
): Enhanced<V1NetworkPolicySpec, object> {
  // client-node models the Kubernetes wire field `from` as `_from` because
  // `from` was historically reserved by its generator. KubernetesObjectApi,
  // TypeKro YAML, and KRO templates are unmodelled JSON paths and therefore do
  // not run client-node's ObjectSerializer; emitting `_from` makes the manifest
  // invalid. Preserve `_from` as a non-enumerable compatibility alias for typed
  // callers while serializing only the authoritative wire spelling.
  const normalized = normalizeNetworkPolicyIngress(resource);
  return createResource({
    ...normalized,
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: resource.metadata ?? { name: 'unnamed-networkpolicy' },
  }).withReadinessEvaluator(createAlwaysReadyEvaluator<V1NetworkPolicy>('NetworkPolicy'));
}

function normalizeNetworkPolicyIngress(
  resource: V1NetworkPolicy & { id?: string }
): V1NetworkPolicy & { id?: string } {
  // A composition proxy may supply the whole ingress array as a KubernetesRef
  // or CEL expression. That value is already serialized through its own wire
  // expression and cannot be enumerated during authoring-time graph discovery.
  if (!Array.isArray(resource.spec?.ingress)) return resource;
  const ingress = resource.spec.ingress.map((rule) => {
    const wireRule = { ...rule } as typeof rule & {
      from?: typeof rule._from;
    };
    if (rule._from !== undefined) wireRule.from = rule._from;
    Object.defineProperty(wireRule, '_from', {
      value: rule._from,
      enumerable: false,
      configurable: true,
      writable: false,
    });
    return wireRule;
  });
  return {
    ...resource,
    spec: {
      ...resource.spec,
      ingress,
    },
  };
}
