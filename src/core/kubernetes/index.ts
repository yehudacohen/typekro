/**
 * Kubernetes Module
 *
 * Centralized exports for Kubernetes client functionality.
 * This module provides:
 * - Client provider for managing Kubernetes API clients
 * - API utilities for common operations
 * - Error handling utilities for consistent error management
 */

// Client provider and configuration
export {
  KubernetesClientProvider,
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  getKubernetesClientProvider,
  getKubernetesApi,
  getKubeConfig,
  getCoreV1Api,
  getAppsV1Api,
} from './client-provider.js';

export type {
  KubernetesClientConfig,
  KubernetesApiConsumer,
  KubeConfigConsumer,
  RetryOptions,
} from './client-provider.js';

// API utilities
export { KubernetesApi } from './api.js';

// Error handling utilities
export {
  getErrorStatusCode,
  isNotFoundError,
  isConflictError,
  isRetryableError,
  formatKubernetesError,
  isUnauthorizedError,
  isForbiddenError,
  isBadRequestError,
  isValidationError,
  getErrorReason,
  getErrorDetails,
} from './errors.js';

export type { KubernetesApiError } from './errors.js';

// Type guards
export {
  isKubernetesResponse,
  isKubernetesError,
  hasStatusCode,
  isKubernetesResource,
  hasBody,
  isKubernetesList,
  hasResourceVersion,
} from './type-guards.js';

export type {
  KubernetesResponse,
  KubernetesResourceShape,
} from './type-guards.js';

// Bun compatibility utilities
// These provide workarounds for Bun's fetch TLS issues
// See: https://github.com/oven-sh/bun/issues/10642
export {
  BunCompatibleHttpLibrary,
  isBunRuntime,
  getHttpLibraryForRuntime,
} from './bun-http-library.js';

export {
  createBunCompatibleApiClient,
  createBunCompatibleCoreV1Api,
  createBunCompatibleAppsV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleBatchV1Api,
  createBunCompatibleNetworkingV1Api,
  createBunCompatibleRbacAuthorizationV1Api,
  createBunCompatibleStorageV1Api,
  createBunCompatibleApiextensionsV1Api,
  createBunCompatibleKubernetesObjectApi,
} from './bun-api-client.js';
