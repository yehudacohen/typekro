/**
 * Resource Identifier Generation
 *
 * Deterministic and random resource ID generation for Kro resource entries
 * and deployment tracking keys.
 */

import { toCamelCase } from '../../utils/string.js';
import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { ValidationError } from '../errors.js';
import type { CelExpression, KubernetesRef } from '../types/common.js';
import type { KubernetesResource } from '../types/kubernetes.js';

/**
 * Resolve the resource graph identifier for a resource, using the standard
 * fallback chain:
 *
 * 1. `resource.id` — explicit graph ID set by the user or by {@link createResource}
 * 2. `resource.metadata?.name` — Kubernetes name (fallback for ad-hoc resources)
 * 3. `fallback` — caller-provided default (defaults to `'unknown'`)
 *
 * This centralises a pattern that was previously duplicated across 6+ call sites.
 *
 * @see {@link KubernetesResource.id} for full documentation of the `id` field semantics.
 */
export function getResourceId(
  resource: Pick<KubernetesResource, 'id' | 'metadata'>,
  fallback = 'unknown'
): string {
  return resource.id || resource.metadata?.name || fallback;
}

/**
 * Generate a deterministic resource graph identifier from resource metadata.
 *
 * Produces a camelCase ID suitable for use as a Kro resource entry identifier
 * and CEL expression target.  The result is stable across invocations for the
 * same inputs, enabling GitOps workflows.
 *
 * @throws {ValidationError} If `name` is a {@link KubernetesRef} or {@link CelExpression}
 *   (dynamic names cannot produce static identifiers — provide an explicit `id` instead).
 * @throws {ValidationError} If `name` contains template expressions (`${...}` or `{{...}}`).
 *
 * @example
 * ```ts
 * generateDeterministicResourceId('Deployment', 'my-app')         // → 'deploymentMyApp'
 * generateDeterministicResourceId('Service', 'my-deployment-svc') // → 'myDeploymentSvc' (kind already in name)
 * ```
 */
export function generateDeterministicResourceId(
  kind: string,
  name: string | KubernetesRef<unknown> | CelExpression<unknown>,
  _namespace?: string
): string {
  const cleanKind = kind.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');

  if (isKubernetesRef(name)) {
    throw new ValidationError(
      `Cannot generate deterministic resource ID for ${kind} with KubernetesRef name. ` +
        `Please provide an explicit 'id' field in the resource config, e.g.: ` +
        `simple.Deployment({ name: schema.spec.name, image: 'nginx', id: 'my-deployment' })`,
      kind,
      'unknown',
      'name'
    );
  }

  if (isCelExpression(name)) {
    throw new ValidationError(
      `Cannot generate deterministic resource ID for ${kind} with CEL expression name. ` +
        `Please provide an explicit 'id' field in the resource config, e.g.: ` +
        `simple.Deployment({ name: Cel.expr('my-', schema.spec.name), image: 'nginx', id: 'my-deployment' })`,
      kind,
      'unknown',
      'name'
    );
  }

  const nameStr = name as string;

  if (nameStr.includes('${') || nameStr.includes('{{')) {
    throw new ValidationError(
      `Cannot generate deterministic resource ID for ${kind} with template expression in name: "${nameStr}". ` +
        `Please either use static names or provide an explicit 'id' in the resource factory options.`,
      kind,
      nameStr,
      'name'
    );
  }

  // If the name already contains the kind, just use the name
  if (nameStr.toLowerCase().includes(cleanKind)) {
    return toCamelCase(nameStr);
  }

  // Otherwise, prefix with kind for clarity
  return toCamelCase(`${cleanKind}-${nameStr}`);
}

/**
 * Generate a unique resource ID (legacy random version for development).
 */
export function generateResourceId(name?: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return name
    ? `${name.replace(/[^a-zA-Z0-9-]/g, '')}-${timestamp}-${random}`
    : `resource-${timestamp}-${random}`;
}
