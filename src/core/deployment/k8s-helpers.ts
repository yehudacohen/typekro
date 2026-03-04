/**
 * Kubernetes API Helpers - Utility functions for K8s API interactions
 *
 * Extracted from engine.ts. Contains error classification, media type handling,
 * and resource patching utilities.
 */

import type * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../logging/index.js';
import type { KubernetesApiError } from '../types.js';

const logger = getComponentLogger('k8s-helpers');

/**
 * Check if an error is a "not found" error (HTTP 404)
 */
export function isNotFoundError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const k8sError = error as KubernetesApiError;
    return k8sError.statusCode === 404 || k8sError.body?.code === 404;
  }
  return false;
}

/**
 * Check if an error is an HTTP 415 Unsupported Media Type error
 */
export function isUnsupportedMediaTypeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const apiError = error as KubernetesApiError;
  return (
    apiError.statusCode === 415 ||
    apiError.response?.statusCode === 415 ||
    apiError.body?.code === 415
  );
}

/**
 * Extract accepted media types from HTTP 415 error message
 */
export function extractAcceptedMediaTypes(error: unknown): string[] {
  const defaultTypes = [
    'application/json-patch+json',
    'application/merge-patch+json',
    'application/apply-patch+yaml',
  ];

  try {
    const apiError = error as KubernetesApiError;
    const message = apiError.message || apiError.body?.message || '';
    const match = message.match(/accepted media types include: ([^"]+)/);

    if (match && match[1]) {
      return match[1].split(', ').map((type: string) => type.trim());
    }
  } catch (err: unknown) {
    logger.debug('Failed to extract media types from error, using defaults', { err });
  }

  return defaultTypes;
}

/**
 * Patch a resource with the correct Content-Type header for merge patch operations.
 * Fixes HTTP 415 "Unsupported Media Type" errors.
 */
export async function patchResourceWithCorrectContentType(
  k8sApi: k8s.KubernetesObjectApi,
  resource: k8s.KubernetesObject
): Promise<k8s.KubernetesObject> {
  // Log Secret resource metadata (sensitive fields redacted)
  if (resource.kind === 'Secret') {
    logger.debug('Patching Secret resource', {
      name: resource.metadata?.name,
      namespace: resource.metadata?.namespace,
      hasData: 'data' in resource,
      hasStringData: 'stringData' in resource,
      dataKeyCount: (resource as { data?: Record<string, string> }).data
        ? Object.keys((resource as { data: Record<string, string> }).data).length
        : 0,
    });
  }

  return await k8sApi.patch(
    resource,
    undefined, // pretty
    undefined, // dryRun
    undefined, // fieldManager
    undefined, // force
    'application/merge-patch+json' // patchStrategy
  );
}

/**
 * Enhance a resource for evaluation by applying kind-specific logic.
 * This allows generic evaluators to work correctly without needing special cases.
 */
export function enhanceResourceForEvaluation(
  resource: {
    spec?: unknown;
    status?: {
      conditions?: Array<{ type: string; status: string; message?: string; reason?: string }>;
    };
    metadata?: { generation?: number; resourceVersion?: string };
  },
  kind: string
): typeof resource {
  // For HelmRepository resources, handle OCI special case
  if (kind === 'HelmRepository') {
    const spec = resource.spec as { type?: string } | undefined;
    const isOciRepository = spec?.type === 'oci';
    const hasBeenProcessed = resource.metadata?.generation && resource.metadata?.resourceVersion;

    if (
      isOciRepository &&
      hasBeenProcessed &&
      !resource.status?.conditions?.some((c) => c.type === 'Ready')
    ) {
      return {
        ...resource,
        status: {
          ...resource.status,
          conditions: [
            ...(resource.status?.conditions || []),
            {
              type: 'Ready',
              status: 'True',
              message: 'OCI repository is functional',
              reason: 'OciRepositoryProcessed',
            },
          ],
        },
      };
    }
  }

  return resource;
}
