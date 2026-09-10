/**
 * Kubernetes API Helpers - Utility functions for K8s API interactions
 *
 * Extracted from engine.ts. Contains error classification, media type handling,
 * and resource patching utilities.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  formatKubernetesError,
  getErrorDetails,
  getErrorStatusCode,
  isRetryableError,
} from '../kubernetes/errors.js';
import { getComponentLogger } from '../logging/index.js';
import type { KubernetesApiError } from '../types.js';

const logger = getComponentLogger('k8s-helpers');

/**
 * Check if an error is a "not found" error (HTTP 404)
 */
export function isNotFoundError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    // Cover all three shapes the @kubernetes/client-node stack surfaces a 404 as:
    // `statusCode` (typed API errors), `body.code` (parsed Status body), and the
    // bare `code` some code paths set — the KRO teardown reads all three, so the
    // engine's shared 404 check must too or a gate would miss a real 404.
    const k8sError = error as KubernetesApiError & { code?: number };
    return (
      k8sError.statusCode === 404 ||
      k8sError.response?.statusCode === 404 ||
      k8sError.body?.code === 404 ||
      k8sError.code === 404 ||
      (typeof k8sError.message === 'string' && k8sError.message.includes('HTTP-Code: 404'))
    );
  }
  return false;
}

/**
 * Check if an error is an HTTP 409 Conflict error — e.g. an optimistic-concurrency
 * failure when a PATCH/PUT carries a `metadata.resourceVersion` that no longer
 * matches the server (the object was modified between read and write), or an
 * AlreadyExists on a create (create-first namespace ownership).
 *
 * Covers ALL four shapes the @kubernetes/client-node stack surfaces a 409 as —
 * `statusCode` (typed API errors), `response.statusCode` (the http-layer error),
 * `body.code` (parsed Status body), and the bare `code` some code paths set —
 * mirroring {@link isNotFoundError} so no gate misses a real 409.
 */
export function isConflictError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const k8sError = error as KubernetesApiError & { code?: number };
    return (
      k8sError.statusCode === 409 ||
      k8sError.response?.statusCode === 409 ||
      k8sError.body?.code === 409 ||
      k8sError.code === 409 ||
      (typeof k8sError.message === 'string' && k8sError.message.includes('HTTP-Code: 409'))
    );
  }
  return false;
}

/**
 * How a failed Kubernetes read should be treated by a loop that polls against a time budget.
 *
 * The two retryable classifications describe a cluster that may still produce the object. The
 * rest describe a request that will fail identically until something outside the deployment
 * changes, so polling them only spends the budget and then reports a timeout that hides the
 * real cause.
 */
export type ReadErrorClassification =
  /** The object is absent but its type is served — it may still appear. */
  | 'object-not-found'
  /** Rate limiting, a server-side fault, or a transport failure. */
  | 'transient'
  /** The apiVersion/kind itself is not served: a wrong reference or an uninstalled CRD. */
  | 'unknown-resource-type'
  /** 401/403 — the deployment's credentials may not read this resource. */
  | 'permission-denied'
  /** 400/405/422 and other client errors — the request itself is malformed or rejected. */
  | 'invalid-request'
  /** A programming error with no Kubernetes API shape at all. */
  | 'not-a-kubernetes-error';

/** A classified read failure, with the pieces an error message needs. */
export interface ReadErrorAssessment {
  classification: ReadErrorClassification;
  /** Whether reading again could plausibly succeed without anything else changing. */
  retryable: boolean;
  /** Short human-readable form of the classification, e.g. `permission denied (HTTP 403)`. */
  summary: string;
  /** The best available underlying message, never the `[object Object]` a bare status yields. */
  detail: string;
  statusCode: number | undefined;
}

const READ_ERROR_SUMMARIES: Record<ReadErrorClassification, string> = {
  'object-not-found': 'not found',
  transient: 'transient API error',
  'unknown-resource-type': 'unknown resource type',
  'permission-denied': 'permission denied',
  'invalid-request': 'invalid request',
  'not-a-kubernetes-error': 'not a Kubernetes API error',
};

const RETRYABLE_READ_CLASSIFICATIONS: ReadonlySet<ReadErrorClassification> =
  new Set<ReadErrorClassification>(['object-not-found', 'transient']);

/**
 * Distinguish a 404 for the resource *type* from a 404 for the *object*.
 *
 * A 404 for an object the API server knows how to serve always names it: the Status body carries
 * `details.name` and `details.kind` (`services "foo" not found`). A request to a path the server
 * does not serve has no object to name, so it answers only that it could not find the requested
 * resource and leaves `details` empty. The client can also refuse before any request:
 * `KubernetesObjectApi` cannot build a URL for an apiVersion/kind missing from discovery and
 * throws a plain `Error` with no status code at all.
 */
function isUnknownResourceTypeError(error: unknown, statusCode: number | undefined): boolean {
  if (!error || typeof error !== 'object') return false;
  const apiError = error as KubernetesApiError;

  if (
    typeof apiError.message === 'string' &&
    apiError.message.includes('Unrecognized API version and kind')
  ) {
    return true;
  }

  if (statusCode !== 404) return false;

  const body = apiError.body;
  if (
    typeof body?.message === 'string' &&
    /could not find the requested resource/i.test(body.message)
  ) {
    return true;
  }

  // Only treat a structured NotFound as a type miss when the server declined to name an object;
  // a bare `{ statusCode: 404 }` carries no evidence either way and stays retryable.
  const details = body?.details;
  return (
    body?.reason === 'NotFound' &&
    !!details &&
    typeof details === 'object' &&
    !details.name &&
    !details.kind
  );
}

function classifyReadErrorKind(
  error: unknown,
  statusCode: number | undefined
): ReadErrorClassification {
  if (isUnknownResourceTypeError(error, statusCode)) return 'unknown-resource-type';
  if (statusCode === 401 || statusCode === 403) return 'permission-denied';
  if (statusCode === 404) return 'object-not-found';
  // Covers 408/429/5xx plus connection resets, DNS failures and fetch-level TypeErrors.
  if (isRetryableError(error)) return 'transient';
  if (statusCode === undefined) return 'not-a-kubernetes-error';
  if (statusCode >= 400 && statusCode < 500) return 'invalid-request';
  return 'transient';
}

/**
 * Classify a failed Kubernetes read as worth retrying or permanently broken.
 *
 * Built on the shared predicates in `../kubernetes/errors.js` — {@link getErrorStatusCode} for the
 * status across every client-version error shape, and {@link isRetryableError} for the transient
 * set — so this adds a retry policy rather than a second error taxonomy.
 */
export function classifyReadError(error: unknown): ReadErrorAssessment {
  const statusCode = getErrorStatusCode(error);
  const classification = classifyReadErrorKind(error, statusCode);
  const label = READ_ERROR_SUMMARIES[classification];

  return {
    classification,
    retryable: RETRYABLE_READ_CLASSIFICATIONS.has(classification),
    summary: statusCode === undefined ? label : `${label} (HTTP ${statusCode})`,
    detail: describeReadError(error),
    statusCode,
  };
}

/**
 * Best available human-readable description of a read failure.
 *
 * `ensureError` on a bare `{ statusCode: 403 }` yields `[object Object]`, which tells an operator
 * nothing, so fall back to the formatted API error when neither the Status body nor the error
 * itself carries a message.
 */
export function describeReadError(error: unknown): string {
  const { message } = getErrorDetails(error);
  if (typeof message === 'string' && message.length > 0 && message !== '[object Object]') {
    return message;
  }
  return formatKubernetesError(error);
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

    if (match?.[1]) {
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
  resource: k8s.KubernetesObject,
  patchType: 'merge' | 'strategic' = 'merge'
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
    patchType === 'strategic'
      ? 'application/strategic-merge-patch+json'
      : 'application/merge-patch+json'
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
