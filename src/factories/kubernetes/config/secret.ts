import type { V1Secret } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import { registerFactory } from '../../../core/resources/factory-registry.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

// Self-register under both the PascalCase `Secret` name (used by
// `simple.Secret`) and the lowercase `secret` name (this module's
// exported function). Registering both ensures that composition-body
// AST analysis (`isKnownFactory`) recognises direct calls like
// `secret({...})` inside compositions and can extract control-flow
// directives (includeWhen, forEach, etc).
registerFactory({
  factoryName: 'Secret',
  kind: 'Secret',
  apiVersion: 'v1',
  semanticAliases: ['secret'],
});
registerFactory({
  factoryName: 'secret',
  kind: 'Secret',
  apiVersion: 'v1',
});

export type V1SecretData = NonNullable<V1Secret['data']>;

// Secret spec type - Secrets don't have a traditional spec, they have data
// We use an empty spec type since Secrets don't have a spec field in Kubernetes
type SecretSpec = {};

// Secret status type - Secrets don't have status
type SecretStatus = {};

/**
 * Creates a Kubernetes Secret resource that is considered ready immediately upon creation.
 *
 * @security Do not hardcode sensitive values (passwords, tokens, keys) directly in source code.
 * Use environment variables, external secret management (e.g., Vault, Sealed Secrets, External
 * Secrets Operator), or Kubernetes Secret references instead. Secrets in Kubernetes are
 * base64-encoded, not encrypted -- enable encryption at rest on the cluster.
 *
 * @param resource - The Secret specification conforming to the Kubernetes V1Secret API, with an optional `id` field.
 * @returns An Enhanced Secret resource. Secrets have no spec or status fields; readiness is always true.
 * @example
 * const tlsSecret = secret({
 *   metadata: { name: 'tls-cert' },
 *   type: 'kubernetes.io/tls',
 *   data: { 'tls.crt': btoa(cert), 'tls.key': btoa(key) },
 * });
 */
export function secret(resource: V1Secret & { id?: string }): Enhanced<SecretSpec, SecretStatus> {
  // Secrets don't have a spec field in Kubernetes - data, stringData, type, and immutable
  // are at the root level. We must NOT create a synthetic spec field or Kro will fail
  // with "schema not found for field spec" error.
  return createResource<SecretSpec, SecretStatus>({
    ...resource,
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: resource.metadata ?? { name: 'unnamed-secret' },
    // Note: No spec field - Secrets have data/stringData/type/immutable at root level
  }).withReadinessEvaluator(createAlwaysReadyEvaluator<V1Secret>('Secret'));
}
