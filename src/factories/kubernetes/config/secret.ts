import type { V1Secret } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1SecretData = NonNullable<V1Secret['data']>;

// Secret spec type - Secrets don't have a traditional spec, they have data
// We use an empty spec type since Secrets don't have a spec field in Kubernetes
type SecretSpec = {};

// Secret status type - Secrets don't have status
type SecretStatus = {};

/**
 * Creates a Kubernetes Secret resource.
 *
 * @security Do not hardcode sensitive values (passwords, tokens, keys) directly in source code.
 * Use environment variables, external secret management (e.g., Vault, Sealed Secrets, External
 * Secrets Operator), or Kubernetes Secret references instead. Secrets in Kubernetes are
 * base64-encoded, not encrypted — enable encryption at rest on the cluster.
 *
 * @param resource - The Secret specification
 * @returns Enhanced Secret resource
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
  }).withReadinessEvaluator((_liveResource: V1Secret) => {
    // Secrets are ready when they exist - they're just data storage
    return {
      ready: true,
      message: 'Secret is ready when created',
    };
  });
}
