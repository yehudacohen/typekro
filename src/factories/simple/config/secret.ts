/**
 * Simple Secret Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes Secret resources with sensible defaults.
 *
 * Note: This factory always converts stringData to base64-encoded data
 * to ensure consistent behavior and avoid serialization issues.
 */

import { isKubernetesRef } from '../../../utils/type-guards.js';
import type { Enhanced } from '../../../core/types.js';
import { secret } from '../../kubernetes/config/secret.js';
import type { SecretConfig } from '../types.js';

// Secrets don't have a spec field in Kubernetes - data is at the root level
// We use an empty spec type to match the base factory
type SecretSpec = {};

type SecretStatus = {};

/**
 * Creates a simple Secret with sensible defaults
 *
 * This factory handles both stringData (plain text) and data (base64-encoded) inputs.
 * stringData is automatically converted to base64-encoded data to ensure consistent
 * behavior across all deployment scenarios.
 *
 * @param config - Configuration for the secret
 * @returns Enhanced Secret resource
 *
 * @example
 * ```typescript
 * const dbSecret = Secret({
 *   name: 'db-credentials',
 *   stringData: {
 *     username: 'admin',
 *     password: 's3cret',
 *   },
 * });
 * ```
 */
export function Secret(config: SecretConfig): Enhanced<SecretSpec, SecretStatus> {
  // Convert stringData to base64-encoded data
  let secretData: Record<string, string> = {};

  if (config.stringData) {
    secretData = Object.entries(config.stringData).reduce(
      (acc, [key, value]) => {
        // GUARD: simple.Secret eagerly base64-encodes stringData at
        // composition time. That breaks KRO mode when the value is a
        // `KubernetesRef` proxy or a string containing a
        // `__KUBERNETES_REF__` marker — we would encode the marker
        // token instead of the user's actual secret, producing a valid
        // but WRONG base64 value in the final Secret resource.
        //
        // Detect the two forms and throw with an actionable error. The
        // low-level `secret()` factory in
        // `src/factories/kubernetes/config/secret.ts` passes stringData
        // through untouched, so it handles proxy values correctly.
        if (isKubernetesRef(value)) {
          throw new Error(
            `simple.Secret received a KubernetesRef proxy for stringData["${key}"]. ` +
              `simple.Secret base64-encodes stringData at composition time, which ` +
              `would encode the proxy's marker token instead of the actual secret ` +
              `value. Use the low-level \`secret()\` factory from ` +
              `'typekro/factories/kubernetes/config/secret' instead — it passes ` +
              `stringData through untouched so KRO can resolve the reference at ` +
              `reconcile time. See integration-skill rule #31.`
          );
        }
        if (typeof value === 'string' && value.includes('__KUBERNETES_REF_')) {
          throw new Error(
            `simple.Secret received a string with __KUBERNETES_REF__ markers for ` +
              `stringData["${key}"] (likely from a template literal containing a ` +
              `schema proxy field). Use the low-level \`secret()\` factory instead — ` +
              `it preserves the marker for KRO to resolve at reconcile time. See ` +
              `integration-skill rule #31.`
          );
        }
        // Ensure value is a string before encoding
        const stringValue = typeof value === 'string' ? value : String(value);
        acc[key] = Buffer.from(stringValue).toString('base64');
        return acc;
      },
      {} as Record<string, string>
    );
  }

  // Merge with existing data if provided (data takes precedence as it's already encoded)
  if (config.data) {
    secretData = { ...secretData, ...config.data };
  }

  const secretArg: import('@kubernetes/client-node').V1Secret & { id?: string } = {
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    data: secretData, // Always use data field with base64-encoded values
  };
  if (config.id) {
    secretArg.id = config.id;
  }
  return secret(secretArg);
}
