/**
 * Centralized default timeout constants for TypeKro.
 *
 * All timeout values are in milliseconds. These replace the previously
 * scattered magic numbers (30000, 60000, 300000, 600000) throughout
 * the codebase with self-documenting named constants.
 */

// =============================================================================
// DEPLOYMENT TIMEOUTS
// =============================================================================

/** Default timeout for overall deployment operations (5 minutes) */
export const DEFAULT_DEPLOYMENT_TIMEOUT = 300_000;

/** Default timeout for readiness polling / resource resolution (30 seconds) */
export const DEFAULT_READINESS_TIMEOUT = 30_000;

/** Default timeout for RGD (ResourceGraphDefinition) deployment (1 minute) */
export const DEFAULT_RGD_TIMEOUT = 60_000;

/** Default timeout for Kro custom-resource instance readiness (10 minutes) */
export const DEFAULT_KRO_INSTANCE_TIMEOUT = 600_000;

// =============================================================================
// HTTP & NETWORK TIMEOUTS
// =============================================================================

/** Default timeout for HTTP read operations — GET/LIST (30 seconds) */
export const DEFAULT_HTTP_READ_TIMEOUT = 30_000;

/** Default timeout for cluster readiness checks (30 seconds) */
export const DEFAULT_CLUSTER_READY_TIMEOUT = 30_000;

// =============================================================================
// RETRY & BACKOFF LIMITS
// =============================================================================

/** Maximum retry backoff delay (30 seconds) */
export const DEFAULT_MAX_RETRY_DELAY = 30_000;

/** Maximum reconnection delay for event monitors (30 seconds) */
export const DEFAULT_RECONNECT_MAX_DELAY = 30_000;

// =============================================================================
// POLL INTERVALS
// =============================================================================

/** Standard poll interval for readiness/status checks (2 seconds) */
export const DEFAULT_POLL_INTERVAL = 2_000;

/** Fast poll interval for time-sensitive checks like deletion confirmation (1 second) */
export const DEFAULT_FAST_POLL_INTERVAL = 1_000;

/** Short delay after delete-before-recreate on 409 conflict (500ms) */
export const DEFAULT_CONFLICT_RETRY_DELAY = 500;

// =============================================================================
// CACHE & HYDRATION TIMEOUTS
// =============================================================================

/** Status cache TTL (30 seconds) */
export const DEFAULT_STATUS_CACHE_TTL = 30_000;

/** Maximum timeout for status hydration — capped at 60 seconds */
export const DEFAULT_HYDRATION_TIMEOUT_CAP = 60_000;

/** Timeout for namespace/resource deletion waits (30 seconds) */
export const DEFAULT_DELETE_TIMEOUT = 30_000;

// =============================================================================
// CRD TIMEOUTS
// =============================================================================

/** Default timeout for CRD readiness / establishment (5 minutes) */
export const DEFAULT_CRD_READY_TIMEOUT = 300_000;

/** Default timeout for CRD JSON schema patching (30 seconds) */
export const DEFAULT_CRD_PATCH_TIMEOUT = 30_000;

/** Default timeout for waiting on resource readiness in resolver (30 seconds) */
export const DEFAULT_RESOURCE_READY_TIMEOUT = 30_000;
