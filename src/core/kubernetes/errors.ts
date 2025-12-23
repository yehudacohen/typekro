/**
 * Kubernetes Error Handling Utilities
 *
 * Centralized error handling for Kubernetes API errors.
 * Supports both the old request-based errors (0.x) and new fetch-based errors (1.x+).
 *
 * This module provides consistent error handling across the codebase,
 * making it easier to handle API errors and prepare for future client upgrades.
 */

import { getComponentLogger } from '../logging/index.js';

const logger = getComponentLogger('kubernetes-errors');

/**
 * Interface representing a Kubernetes API error with various possible structures.
 * The error structure varies between client versions:
 * - 0.x (request-based): error.statusCode, error.body
 * - 1.x+ (fetch-based): error.response?.statusCode, error.statusCode, error.body?.code
 */
export interface KubernetesApiError {
  statusCode?: number;
  response?: {
    statusCode?: number;
    body?: unknown;
  };
  body?: {
    code?: number;
    message?: string;
    reason?: string;
    details?: unknown;
  };
  message?: string;
  name?: string;
}

/**
 * Extract the HTTP status code from a Kubernetes API error.
 *
 * Handles multiple error structures from different client versions:
 * - Direct statusCode property (0.x style)
 * - Nested response.statusCode (1.x+ fetch style)
 * - Nested body.code (some error responses)
 *
 * @param error - The error object to extract status code from
 * @returns The HTTP status code, or undefined if not found
 *
 * @example
 * ```typescript
 * try {
 *   await api.read(resource);
 * } catch (error) {
 *   const statusCode = getErrorStatusCode(error);
 *   if (statusCode === 404) {
 *     // Handle not found
 *   }
 * }
 * ```
 */
export function getErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const err = error as KubernetesApiError;

  // Try direct statusCode first (0.x style and some 1.x errors)
  if (typeof err.statusCode === 'number') {
    return err.statusCode;
  }

  // Try nested response.statusCode (1.x+ fetch style)
  if (typeof err.response?.statusCode === 'number') {
    return err.response.statusCode;
  }

  // Try nested body.code (some Kubernetes error responses)
  if (typeof err.body?.code === 'number') {
    return err.body.code;
  }

  // Log unexpected error shape at debug level for diagnostics
  logger.debug('Could not extract status code from error', {
    errorType: typeof error,
    hasStatusCode: 'statusCode' in err,
    hasResponse: 'response' in err,
    hasBody: 'body' in err,
    errorKeys: Object.keys(err),
  });

  return undefined;
}

/**
 * Check if an error is a "Not Found" (404) error.
 *
 * @param error - The error to check
 * @returns true if the error is a 404 Not Found error
 *
 * @example
 * ```typescript
 * try {
 *   await api.read(resource);
 * } catch (error) {
 *   if (isNotFoundError(error)) {
 *     console.log('Resource does not exist');
 *   }
 * }
 * ```
 */
export function isNotFoundError(error: unknown): boolean {
  return getErrorStatusCode(error) === 404;
}

/**
 * Check if an error is a "Conflict" (409) error.
 *
 * Conflict errors typically occur when:
 * - Trying to create a resource that already exists
 * - Optimistic locking fails due to resource version mismatch
 *
 * @param error - The error to check
 * @returns true if the error is a 409 Conflict error
 *
 * @example
 * ```typescript
 * try {
 *   await api.create(resource);
 * } catch (error) {
 *   if (isConflictError(error)) {
 *     console.log('Resource already exists');
 *   }
 * }
 * ```
 */
export function isConflictError(error: unknown): boolean {
  return getErrorStatusCode(error) === 409;
}


/**
 * HTTP status codes that are typically retryable.
 * These indicate temporary issues that may resolve on retry.
 */
const RETRYABLE_STATUS_CODES = [
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
];

/**
 * Check if an error is retryable.
 *
 * An error is considered retryable if:
 * - It has a retryable HTTP status code (408, 429, 500, 502, 503, 504)
 * - It's a network connectivity error (ECONNREFUSED, ENOTFOUND, ETIMEDOUT)
 * - It's a fetch-related TypeError (network failure)
 * - It's an AbortError (timeout)
 *
 * @param error - The error to check
 * @returns true if the error is retryable
 *
 * @example
 * ```typescript
 * try {
 *   await api.read(resource);
 * } catch (error) {
 *   if (isRetryableError(error)) {
 *     // Retry the operation
 *   } else {
 *     // Don't retry, handle the error
 *   }
 * }
 * ```
 */
export function isRetryableError(error: unknown): boolean {
  // Check for retryable HTTP status codes
  const statusCode = getErrorStatusCode(error);
  if (statusCode !== undefined && RETRYABLE_STATUS_CODES.includes(statusCode)) {
    return true;
  }

  // Check for network errors by message content
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Network connectivity issues
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('etimedout') ||
      message.includes('network error') ||
      message.includes('socket hang up') ||
      message.includes('connection reset')
    ) {
      return true;
    }

    // Fetch-related network errors (1.x+ client)
    if (error instanceof TypeError && message.includes('fetch')) {
      return true;
    }

    // Abort errors (timeout)
    if (error.name === 'AbortError') {
      return true;
    }
  }

  // Check for DOMException AbortError (browser/Node.js fetch)
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: string }).name === 'AbortError'
  ) {
    return true;
  }

  return false;
}

/**
 * Format a Kubernetes API error into a human-readable message.
 *
 * Extracts relevant information from the error and formats it consistently.
 *
 * @param error - The error to format
 * @returns A formatted error message string
 *
 * @example
 * ```typescript
 * try {
 *   await api.read(resource);
 * } catch (error) {
 *   console.error(formatKubernetesError(error));
 *   // Output: "Kubernetes API error (404): Not Found - the resource does not exist"
 * }
 * ```
 */
export function formatKubernetesError(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error);
  }

  const err = error as KubernetesApiError;
  const statusCode = getErrorStatusCode(error);
  const parts: string[] = [];

  // Add status code if available
  if (statusCode !== undefined) {
    parts.push(`Kubernetes API error (${statusCode})`);
  } else {
    parts.push('Kubernetes API error');
  }

  // Add reason if available from body
  if (err.body?.reason) {
    parts.push(err.body.reason);
  }

  // Add message
  if (err.body?.message) {
    parts.push(err.body.message);
  } else if (err.message) {
    parts.push(err.message);
  }

  return parts.join(': ');
}

/**
 * Check if an error is an "Unauthorized" (401) error.
 *
 * @param error - The error to check
 * @returns true if the error is a 401 Unauthorized error
 */
export function isUnauthorizedError(error: unknown): boolean {
  return getErrorStatusCode(error) === 401;
}

/**
 * Check if an error is a "Forbidden" (403) error.
 *
 * @param error - The error to check
 * @returns true if the error is a 403 Forbidden error
 */
export function isForbiddenError(error: unknown): boolean {
  return getErrorStatusCode(error) === 403;
}

/**
 * Check if an error is a "Bad Request" (400) error.
 *
 * @param error - The error to check
 * @returns true if the error is a 400 Bad Request error
 */
export function isBadRequestError(error: unknown): boolean {
  return getErrorStatusCode(error) === 400;
}

/**
 * Check if an error is a "Unprocessable Entity" (422) error.
 *
 * This typically indicates validation errors in the request body.
 *
 * @param error - The error to check
 * @returns true if the error is a 422 Unprocessable Entity error
 */
export function isValidationError(error: unknown): boolean {
  return getErrorStatusCode(error) === 422;
}

/**
 * Extract the error reason from a Kubernetes API error.
 *
 * @param error - The error to extract reason from
 * @returns The error reason string, or undefined if not available
 */
export function getErrorReason(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const err = error as KubernetesApiError;
  return err.body?.reason;
}

/**
 * Extract detailed error information from a Kubernetes API error.
 *
 * @param error - The error to extract details from
 * @returns An object containing all available error details
 */
export function getErrorDetails(error: unknown): {
  statusCode: number | undefined;
  reason: string | undefined;
  message: string | undefined;
  details: unknown;
} {
  if (typeof error !== 'object' || error === null) {
    return {
      statusCode: undefined,
      reason: undefined,
      message: String(error),
      details: undefined,
    };
  }

  const err = error as KubernetesApiError;

  return {
    statusCode: getErrorStatusCode(error),
    reason: err.body?.reason,
    message: err.body?.message ?? err.message,
    details: err.body?.details,
  };
}
