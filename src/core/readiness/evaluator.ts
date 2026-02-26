/**
 * Readiness Evaluator Resolution
 *
 * Ensures that a Kubernetes resource has a readiness evaluator attached,
 * either from an existing attachment, from the global registry, or throws
 * an informative error if none can be found.
 */

import { TypeKroError } from '../errors.js';
import type { Enhanced } from '../types/kubernetes.js';
import { ReadinessEvaluatorRegistry } from './registry.js';

/**
 * Ensure a readiness evaluator is attached to the given resource.
 *
 * Resolution order:
 * 1. Resource already has an attached evaluator → return as-is.
 * 2. Global {@link ReadinessEvaluatorRegistry} has an evaluator for the
 *    resource's `kind` → attach it.
 * 3. Neither → throw a {@link TypeKroError} with guidance.
 *
 * @throws {TypeKroError} If no readiness evaluator can be resolved.
 */
export function ensureReadinessEvaluator<T extends Enhanced<unknown, unknown>>(resource: T): T {
  // First: Check if resource already has attached evaluator
  if (typeof resource.readinessEvaluator === 'function') {
    return resource;
  }

  // Second: Look up in registry by KIND
  const registry = ReadinessEvaluatorRegistry.getInstance();
  const evaluator = registry.getEvaluatorForKind(resource.kind);

  if (evaluator) {
    Object.defineProperty(resource, 'readinessEvaluator', {
      value: evaluator,
      enumerable: false,
      configurable: true,
      writable: false,
    });
    return resource;
  }

  // Third: No evaluator found anywhere
  throw new TypeKroError(
    `No readiness evaluator found for ${resource.kind}/${resource.metadata?.name}. ` +
      `Use a factory function like deployment(), configMap(), etc., or call .withReadinessEvaluator().`,
    'MISSING_READINESS_EVALUATOR',
    { kind: resource.kind, name: resource.metadata?.name }
  );
}
