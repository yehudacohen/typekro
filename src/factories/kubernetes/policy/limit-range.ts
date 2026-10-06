import type { V1LimitRange } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1LimitRangeSpec = NonNullable<V1LimitRange['spec']>;

/**
 * Rewrite client-node's `_default` to the wire field `default`.
 *
 * client-node models `limits[].default` as `_default` because `default` is a
 * reserved word for its generator. TypeKro YAML and KRO templates do not run
 * client-node's serializer, so `_default` would reach the API server, which
 * drops it. `_default` stays readable as a non-enumerable alias.
 */
function normalizeLimitRangeDefaults(
  resource: V1LimitRange & { id?: string }
): V1LimitRange & { id?: string } {
  if (!Array.isArray(resource.spec?.limits)) return resource;
  const limits = resource.spec.limits.map((item) => {
    const wireItem = { ...item } as typeof item & { default?: typeof item._default };
    if (item._default !== undefined) wireItem.default = item._default;
    delete (wireItem as { _default?: unknown })._default;
    Object.defineProperty(wireItem, '_default', {
      value: item._default,
      enumerable: false,
      configurable: true,
      writable: false,
    });
    return wireItem;
  });
  return { ...resource, spec: { ...resource.spec, limits } };
}

export function limitRange(
  resource: V1LimitRange & { id?: string }
): Enhanced<V1LimitRangeSpec, unknown> {
  return createResource({
    ...normalizeLimitRangeDefaults(resource),
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: resource.metadata ?? { name: 'unnamed-limitrange' },
  }).withReadinessEvaluator(createAlwaysReadyEvaluator<V1LimitRange>('LimitRange'));
}
