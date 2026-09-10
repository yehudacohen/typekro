/**
 * Shared plumbing for the Traefik CRD resource factories.
 *
 * All of it exists to answer one question consistently: what does readiness
 * mean for a resource that has no status?
 */

import { createAlwaysReadyEvaluator } from '../../../core/readiness/evaluator-factories.js';
import type { Composable, ReadinessEvaluator } from '../../../core/types/index.js';

/** Configuration accepted by every namespaced Traefik CRD factory. */
export interface TraefikResourceConfig<TSpec extends object> {
  readonly name: string;
  readonly namespace: string;
  readonly spec: TSpec;
  /** Extra labels merged onto the managed label set. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
  /** Resource graph id. Required when `name` is a schema reference. */
  readonly id?: string;
}

/**
 * Readiness evaluator for a Traefik CRD.
 *
 * **Why always-ready:** none of the `traefik.io/v1alpha1` kinds
 * (`IngressRoute`, `IngressRouteTCP`, `Middleware`, `TLSOption`, `TLSStore`,
 * `ServersTransport`, `TraefikService`) declares a `status` subresource — the
 * proxy consumes them as dynamic configuration and reports problems in its own
 * logs and metrics, never on the object. A condition-based evaluator would
 * therefore poll to its deadline and then fail a deployment whose routing is
 * in fact live, so applying the object successfully is the only readiness
 * signal the API offers. This mirrors how `envoy-ai-gateway` treats Envoy
 * Gateway's status-less `Backend` kind.
 *
 * A route that references a missing Service or Middleware is still surfaced —
 * by the referenced resource's own readiness, and by Traefik returning 404/503
 * for the route, which the integration suite asserts on.
 *
 * @param kind - Traefik kind name, used in the readiness message.
 */
export function traefikStatuslessReadinessEvaluator<T = unknown>(
  kind: string
): ReadinessEvaluator<T> {
  return createAlwaysReadyEvaluator<T>(
    kind,
    `${kind} is ready (Traefik CRDs publish no status subresource)`
  );
}

/** The `app.kubernetes.io` label set TypeKro stamps on Traefik resources. */
export function traefikManagedLabels(instance: string): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'traefik',
    'app.kubernetes.io/instance': instance,
    'app.kubernetes.io/managed-by': 'typekro',
  };
}

/**
 * Build the resource definition passed to `createResource`.
 *
 * Takes `Composable<...>` so a composition can pass proxy-sourced optional
 * fields straight through (integration-skill.md: "All factory functions use
 * `Composable<MyConfig>`").
 */
export function traefikResourceDefinition<TSpec extends object>(
  apiVersion: string,
  kind: string,
  config: Composable<TraefikResourceConfig<TSpec>>
) {
  return {
    apiVersion,
    kind,
    metadata: {
      name: config.name,
      namespace: config.namespace,
      labels: { ...traefikManagedLabels(config.name), ...config.labels },
      ...(config.annotations ? { annotations: { ...config.annotations } } : {}),
    },
    spec: config.spec as TSpec,
    ...(config.id ? { id: config.id } : {}),
  };
}
