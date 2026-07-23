import type { V1NetworkPolicy } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import { registerFactory } from '../../../core/resources/factory-registry.js';
import type { Enhanced } from '../../../core/types/index.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';
import { createResource } from '../../shared.js';

export type V1NetworkPolicySpec = NonNullable<V1NetworkPolicy['spec']>;

/**
 * Emit the API-server-stable form of a NetworkPolicy.
 *
 * Kubernetes drops empty rule arrays during wire normalization. Keeping `ingress: []` or
 * `egress: []` in a KRO template can therefore create perpetual desired/live drift. Explicit
 * `policyTypes` preserves the policy's isolation semantics while empty arrays are omitted.
 */
export function canonicalizeNetworkPolicyDesired(resource: KubernetesResource): KubernetesResource {
  const rawSpec = resource.spec;
  if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) return resource;

  const spec = { ...(rawSpec as Record<string, unknown>) };
  const ingress = spec.ingress;
  const egress = spec.egress;
  let changed = false;

  const canInferPolicyTypes = egress === undefined || Array.isArray(egress);
  if (spec.policyTypes === undefined && canInferPolicyTypes) {
    spec.policyTypes = [
      'Ingress',
      ...(Array.isArray(egress) && egress.length > 0 ? ['Egress'] : []),
    ];
    changed = true;
  }
  if (Array.isArray(ingress) && ingress.length === 0) {
    delete spec.ingress;
    changed = true;
  }
  if (Array.isArray(egress) && egress.length === 0) {
    delete spec.egress;
    changed = true;
  }

  return changed ? { ...resource, spec } : resource;
}

registerFactory({
  factoryName: 'NetworkPolicy',
  kind: 'NetworkPolicy',
  apiVersion: 'networking.k8s.io/v1',
  semanticAliases: ['networkPolicy', 'policy'],
  desiredCanonicalizer: {
    id: 'kubernetes.networking.k8s.io/network-policy',
    revision: '1',
    canonicalize: canonicalizeNetworkPolicyDesired,
  },
  liveCanonicalizer: {
    id: 'kubernetes.networking.k8s.io/network-policy-comparison',
    revision: '1',
    canonicalize: canonicalizeNetworkPolicyDesired,
  },
});

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
  return createResource(
    {
      ...normalized,
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: resource.metadata ?? { name: 'unnamed-networkpolicy' },
    },
    { factoryName: 'NetworkPolicy' }
  ).withReadinessEvaluator(createAlwaysReadyEvaluator<V1NetworkPolicy>('NetworkPolicy'));
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
