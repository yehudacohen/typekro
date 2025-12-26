/**
 * Kubernetes Type Guards
 *
 * Type guards for validating Kubernetes API response shapes.
 * These guards help ensure type safety when working with API responses
 * that may have different structures across client versions.
 */

import type { KubernetesApiError } from './errors.js';

/**
 * Interface representing a standard Kubernetes API response.
 * The response typically contains a body property with the actual data.
 */
export interface KubernetesResponse<T> {
  body: T;
  response?: {
    statusCode?: number;
    headers?: Record<string, string>;
  };
}

/**
 * Interface representing a Kubernetes resource with standard metadata.
 */
export interface KubernetesResourceShape {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: unknown;
  status?: unknown;
}

/**
 * Check if a value is a Kubernetes API response with a body property.
 *
 * @param response - The value to check
 * @returns true if the value is a KubernetesResponse
 *
 * @example
 * ```typescript
 * const result = await api.read(resource);
 * if (isKubernetesResponse(result)) {
 *   const resource = result.body;
 * }
 * ```
 */
export function isKubernetesResponse<T>(
  response: unknown
): response is KubernetesResponse<T> {
  return (
    typeof response === 'object' &&
    response !== null &&
    'body' in response
  );
}

/**
 * Check if an error is a Kubernetes API error with expected properties.
 *
 * @param error - The error to check
 * @returns true if the error is a KubernetesApiError
 *
 * @example
 * ```typescript
 * try {
 *   await api.read(resource);
 * } catch (error) {
 *   if (isKubernetesError(error)) {
 *     console.log('Status:', error.statusCode);
 *   }
 * }
 * ```
 */
export function isKubernetesError(error: unknown): error is KubernetesApiError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const err = error as Record<string, unknown>;

  // Check for common Kubernetes error properties
  return (
    typeof err.statusCode === 'number' ||
    (typeof err.response === 'object' &&
      err.response !== null &&
      typeof (err.response as Record<string, unknown>).statusCode === 'number') ||
    (typeof err.body === 'object' &&
      err.body !== null &&
      typeof (err.body as Record<string, unknown>).code === 'number')
  );
}

/**
 * Check if an object has a statusCode property.
 *
 * @param obj - The object to check
 * @returns true if the object has a numeric statusCode property
 *
 * @example
 * ```typescript
 * if (hasStatusCode(error)) {
 *   console.log('HTTP Status:', error.statusCode);
 * }
 * ```
 */
export function hasStatusCode(obj: unknown): obj is { statusCode: number } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'statusCode' in obj &&
    typeof (obj as Record<string, unknown>).statusCode === 'number'
  );
}

/**
 * Check if a value is a Kubernetes resource with standard shape.
 *
 * @param value - The value to check
 * @returns true if the value has Kubernetes resource shape
 *
 * @example
 * ```typescript
 * if (isKubernetesResource(obj)) {
 *   console.log('Kind:', obj.kind);
 *   console.log('Name:', obj.metadata?.name);
 * }
 * ```
 */
export function isKubernetesResource(
  value: unknown
): value is KubernetesResourceShape {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  // A Kubernetes resource should have at least apiVersion and kind
  return (
    (typeof obj.apiVersion === 'string' || obj.apiVersion === undefined) &&
    (typeof obj.kind === 'string' || obj.kind === undefined) &&
    (typeof obj.metadata === 'object' || obj.metadata === undefined)
  );
}

/**
 * Check if a value has a body property with a specific shape.
 *
 * @param value - The value to check
 * @param bodyGuard - A type guard function to validate the body
 * @returns true if the value has a body that passes the guard
 *
 * @example
 * ```typescript
 * if (hasBody(response, isKubernetesResource)) {
 *   console.log('Resource:', response.body.kind);
 * }
 * ```
 */
export function hasBody<T>(
  value: unknown,
  bodyGuard: (body: unknown) => body is T
): value is { body: T } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'body' in value &&
    bodyGuard((value as { body: unknown }).body)
  );
}

/**
 * Check if a value is a list response from the Kubernetes API.
 *
 * @param value - The value to check
 * @returns true if the value is a Kubernetes list response
 */
export function isKubernetesList(
  value: unknown
): value is { items: unknown[]; metadata?: { resourceVersion?: string } } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.items);
}

/**
 * Check if a response has a resourceVersion in its metadata.
 *
 * @param value - The value to check
 * @returns true if the value has a resourceVersion
 */
export function hasResourceVersion(
  value: unknown
): value is { metadata: { resourceVersion: string } } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  if (typeof obj.metadata !== 'object' || obj.metadata === null) {
    return false;
  }

  const metadata = obj.metadata as Record<string, unknown>;
  return typeof metadata.resourceVersion === 'string';
}
