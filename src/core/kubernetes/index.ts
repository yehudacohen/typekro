/**
 * Kubernetes Module
 *
 * Centralized exports for Kubernetes client functionality.
 * This module provides:
 * - Client provider for managing Kubernetes API clients
 * - API utilities for common operations
 * - Error handling utilities for consistent error management
 */

// API utilities
export { KubernetesApi } from './api.js';
export {
  createBunCompatibleApiClient,
  createBunCompatibleApiextensionsV1Api,
  createBunCompatibleAppsV1Api,
  createBunCompatibleBatchV1Api,
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
  createBunCompatibleNetworkingV1Api,
  createBunCompatibleRbacAuthorizationV1Api,
  createBunCompatibleStorageV1Api,
} from './bun-api-client.js';
export type { HttpTimeoutConfig } from './bun-http-library.js';
// Bun compatibility utilities
// These provide workarounds for Bun's fetch TLS issues
// See: https://github.com/oven-sh/bun/issues/10642
export {
  BunCompatibleHttpLibrary,
  getHttpLibraryForRuntime,
  isBunRuntime,
} from './bun-http-library.js';
export type {
  KubeConfigConsumer,
  KubernetesApiConsumer,
  KubernetesClientConfig,
  RetryOptions,
} from './client-provider.js';
// Client provider and configuration
export {
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  getAppsV1Api,
  getCoreV1Api,
  getKubeConfig,
  getKubernetesApi,
  getKubernetesClientProvider,
  KubernetesClientProvider,
} from './client-provider.js';
export type { KubernetesApiError } from './errors.js';
// Error handling utilities
export {
  formatKubernetesError,
  getErrorDetails,
  getErrorReason,
  getErrorStatusCode,
  isBadRequestError,
  isConflictError,
  isForbiddenError,
  isNotFoundError,
  isRetryableError,
  isUnauthorizedError,
  isValidationError,
} from './errors.js';
export type {
  KubernetesResourceShape,
  KubernetesResponse,
} from './type-guards.js';
// Type guards
export {
  hasBody,
  hasResourceVersion,
  hasStatusCode,
  isKubernetesError,
  isKubernetesList,
  isKubernetesResource,
  isKubernetesResponse,
} from './type-guards.js';
