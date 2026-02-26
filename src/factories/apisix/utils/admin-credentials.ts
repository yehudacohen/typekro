/**
 * APISIX Admin API Credential Resolution
 *
 * Resolves APISIX admin API credentials from (in order of priority):
 * 1. Explicit configuration via `gateway.adminCredentials`
 * 2. Environment variables (`APISIX_ADMIN_KEY`, `APISIX_VIEWER_KEY`)
 * 3. Development-only defaults (with a warning logged to stderr)
 *
 * @security This module handles sensitive admin API keys. Never log resolved
 * credential values. In production, always provide credentials via the spec
 * or environment variables.
 *
 * @module
 */

/**
 * Well-known APISIX chart default keys — used ONLY as a development fallback.
 * These are the public defaults shipped in the upstream Helm chart and provide
 * zero additional security. They exist here solely so that local development
 * workflows do not break when env vars are unset.
 *
 * @security Do NOT rely on these in any environment other than local development.
 * @internal
 */
const DEV_DEFAULT_ADMIN_KEY = 'edd1c9f034335f136f87ad84b625c8f1';
const DEV_DEFAULT_VIEWER_KEY = '4054f7cf07e344346cd3f287985e76a2';

/** Whether we have already emitted the dev-default warning in this process. */
let devDefaultWarningEmitted = false;

/**
 * Resolved APISIX admin credentials.
 *
 * @security Treat both values as secrets — do not log or persist them.
 */
export interface ResolvedAdminCredentials {
  admin: string;
  viewer: string;
}

/**
 * Resolves APISIX admin API credentials.
 *
 * Resolution order:
 * 1. Values provided explicitly via the `specCredentials` parameter (from
 *    `gateway.adminCredentials` in the bootstrap spec).
 * 2. Environment variables `APISIX_ADMIN_KEY` / `APISIX_VIEWER_KEY`.
 * 3. Development-only defaults identical to the upstream chart defaults.
 *    A warning is emitted to stderr the first time these are used.
 *
 * @security Callers must never log the returned credential values.
 *
 * @param specCredentials - Optional explicit credentials from the user spec.
 * @returns Resolved admin and viewer keys.
 */
export function resolveAdminCredentials(
  specCredentials?: { admin?: string; viewer?: string } | undefined
): ResolvedAdminCredentials {
  const admin = resolveKey(specCredentials?.admin, 'APISIX_ADMIN_KEY', DEV_DEFAULT_ADMIN_KEY);
  const viewer = resolveKey(specCredentials?.viewer, 'APISIX_VIEWER_KEY', DEV_DEFAULT_VIEWER_KEY);

  return { admin, viewer };
}

/**
 * Resolve a single credential value with the three-tier priority.
 *
 * @internal
 */
function resolveKey(specValue: string | undefined, envVarName: string, devDefault: string): string {
  // 1. Explicit spec value takes highest priority
  if (specValue) {
    return specValue;
  }

  // 2. Environment variable
  const envValue = process.env[envVarName];
  if (envValue) {
    return envValue;
  }

  // 3. Development-only default — warn once per process
  if (!devDefaultWarningEmitted) {
    devDefaultWarningEmitted = true;
    console.warn(
      '[typekro/apisix] WARNING: Using default APISIX admin API keys. ' +
        'These are the well-known chart defaults and are NOT secure. ' +
        'Set APISIX_ADMIN_KEY and APISIX_VIEWER_KEY environment variables, ' +
        'or pass gateway.adminCredentials in the spec for production deployments.'
    );
  }

  return devDefault;
}

/**
 * Reset the warning state — exposed only for testing.
 *
 * @internal
 */
export function _resetWarningState(): void {
  devDefaultWarningEmitted = false;
}
