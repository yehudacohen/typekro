/**
 * Simple Secret Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes Secret resources with sensible defaults.
 *
 * Note: This factory always converts stringData to base64-encoded data
 * to ensure consistent behavior and avoid serialization issues.
 */

import type { Enhanced } from '../../../core/types.js';
import { secret } from '../../kubernetes/config/secret.js';
import type { SecretConfig } from '../types.js';

// Secrets don't have a spec field in Kubernetes - data is at the root level
// We use an empty spec type to match the base factory
type SecretSpec = {}

type SecretStatus = {}

/**
 * Creates a simple Secret with sensible defaults
 *
 * This factory handles both stringData (plain text) and data (base64-encoded) inputs.
 * stringData is automatically converted to base64-encoded data to ensure consistent
 * behavior across all deployment scenarios.
 *
 * @param config - Configuration for the secret
 * @returns Enhanced Secret resource
 */
export function Secret(config: SecretConfig): Enhanced<SecretSpec, SecretStatus> {
  // Convert stringData to base64-encoded data
  let secretData: Record<string, string> = {};

  if (config.stringData) {
    secretData = Object.entries(config.stringData).reduce(
      (acc, [key, value]) => {
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

  return secret({
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    data: secretData, // Always use data field with base64-encoded values
    ...(config.id && { id: config.id }),
  } as any);
}
