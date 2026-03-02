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

/** Default timeout for HTTP write operations — POST/PUT/PATCH (2 minutes) */
export const DEFAULT_HTTP_WRITE_TIMEOUT = 120_000;

/** Default timeout for HTTP delete operations (3 minutes) */
export const DEFAULT_HTTP_DELETE_TIMEOUT = 180_000;

/** Default timeout for HTTP watch connections (1 hour) */
export const DEFAULT_HTTP_WATCH_TIMEOUT = 3_600_000;

// =============================================================================
// RETRY & BACKOFF LIMITS
// =============================================================================

/** Default maximum retries for operations that can be retried (3 attempts) */
export const DEFAULT_MAX_RETRIES = 3;

/** Default base delay for exponential backoff retries (1 second) */
export const DEFAULT_RETRY_BASE_DELAY = 1_000;

/** Default multiplier for exponential backoff (doubles each retry) */
export const DEFAULT_BACKOFF_MULTIPLIER = 2;

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

/** Maximum backoff delay for readiness polling (10 seconds) */
export const DEFAULT_READINESS_MAX_BACKOFF = 10_000;

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

// =============================================================================
// EVENT MONITORING
// =============================================================================

/** Maximum simultaneous watch connections for event monitoring */
export const DEFAULT_MAX_WATCH_CONNECTIONS = 10;

/** Maximum reconnection attempts before giving up */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/** Jitter factor for reconnection backoff (0.0 - 1.0) */
export const DEFAULT_RECONNECT_JITTER_FACTOR = 0.2;

/** Watch timeout in seconds for K8s API watch calls */
export const DEFAULT_WATCH_TIMEOUT_SECONDS = 5;

/** Maximum events per second before rate limiting */
export const DEFAULT_MAX_EVENTS_PER_SECOND = 50;

/** Default event batch size for batch processing */
export const DEFAULT_EVENT_BATCH_SIZE = 10;

/** Deduplication window for event filtering (seconds) */
export const DEFAULT_DEDUPLICATION_WINDOW_SECONDS = 60;

/** Maximum tracked events per resource */
export const DEFAULT_MAX_EVENTS_PER_RESOURCE = 100;

// =============================================================================
// EXPRESSION CACHE
// =============================================================================

/** Maximum entries in the expression cache */
export const DEFAULT_CACHE_MAX_ENTRIES = 1_000;

/** Maximum memory (MB) for the expression cache */
export const DEFAULT_CACHE_MAX_MEMORY_MB = 50;

/** Time-to-live for expression cache entries (5 minutes) */
export const DEFAULT_CACHE_TTL_MS = 300_000;

// =============================================================================
// STATUS & DEBUG
// =============================================================================

/** Maximum size of status objects in debug logs (bytes) */
export const DEFAULT_MAX_STATUS_OBJECT_SIZE = 1_024;

/** Default timeout for status query operations (10 seconds) */
export const DEFAULT_STATUS_QUERY_TIMEOUT = 10_000;
