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
 * Why a read against the API server did not produce an answer.
 *
 * `notFound` is the only *definitive* outcome in this list: the server answered,
 * and the answer was "that does not exist". Every other member means the
 * question was never actually put to the server, so a caller must not read them
 * as a negative answer. That distinction is what capability discovery keys its
 * `unserved` / `unknown` split on.
 */
export type ApiReadFailure = 'notFound' | 'forbidden' | 'timeout' | 'unreachable' | 'other';

/** Read the HTTP status off any of the shapes the client-node stack uses. */
function apiErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const k8sError = error as KubernetesApiError & { code?: number | string };
  const numericCode = typeof k8sError.code === 'number' ? k8sError.code : undefined;
  return (
    k8sError.statusCode ?? k8sError.response?.statusCode ?? k8sError.body?.code ?? numericCode
  );
}

/** The `code` string Node sets on socket/DNS/TLS errors, when there is one. */
function systemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EPROTO',
  // TLS: the transport never came up, so the server was never asked. The
  // message keeps the certificate detail for the human reading the log.
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Classify why a read against the API server failed.
 *
 * Deliberately conservative: anything not positively recognised is `other`,
 * which callers treat the same as `unreachable` — "we did not learn the answer"
 * — rather than as a negative answer.
 */
export function classifyApiReadError(error: unknown): ApiReadFailure {
  if (isNotFoundError(error)) return 'notFound';

  const status = apiErrorStatus(error);
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 408 || status === 504) return 'timeout';

  const code = systemErrorCode(error);
  if (code && TIMEOUT_CODES.has(code)) return 'timeout';
  if (code && UNREACHABLE_CODES.has(code)) return 'unreachable';

  const message = error instanceof Error ? error.message : String(error ?? '');
  const lowered = message.toLowerCase();
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  if (lowered.includes('timeout') || lowered.includes('timed out')) return 'timeout';
  if (
    lowered.includes('forbidden') ||
    lowered.includes('unauthorized') ||
    lowered.includes('http-code: 401') ||
    lowered.includes('http-code: 403')
  ) {
    return 'forbidden';
  }
  if (
    lowered.includes('certificate') ||
    lowered.includes('unable to verify') ||
    lowered.includes('econnrefused') ||
    lowered.includes('getaddrinfo') ||
    lowered.includes('socket hang up')
  ) {
    return 'unreachable';
  }

  return 'other';
}

/** Short human phrase for an {@link ApiReadFailure}, for a log line or a reason string. */
export function describeApiReadFailure(failure: ApiReadFailure): string {
  switch (failure) {
    case 'notFound':
      return 'the server answered 404';
    case 'forbidden':
      return 'the request was refused (RBAC)';
    case 'timeout':
      return 'the request timed out';
    case 'unreachable':
      return 'the API server was unreachable';
    default:
      return 'the request failed';
  }
}

/**
 * One-line description of a failed API read: what went wrong, plus the
 * underlying message so the log is actionable.
 */
export function describeApiReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return `${describeApiReadFailure(classifyApiReadError(error))}: ${message}`;
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
