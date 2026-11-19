import { TypeKroError } from '../../../core/errors.js';

/**
 * A pinned Flux version: `v<major>.<minor>.<patch>`, optionally with a pre-release suffix such
 * as `v2.8.0-rc.1`. It refuses `latest`, an unprefixed version (`2.7.5`) and a partial one
 * (`v2.7`).
 */
export const PINNED_FLUX_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

export function isPinnedFluxVersion(version: unknown): version is string {
  return typeof version === 'string' && PINNED_FLUX_VERSION.test(version);
}

/** Throws unless `version` is a pinned Flux version. */
export function assertPinnedFluxVersion(version: unknown): asserts version is string {
  if (!isPinnedFluxVersion(version)) {
    throw new TypeKroError(
      `Flux version must be pinned, like "v2.7.5"; got ${JSON.stringify(version)}.`,
      'FLUX_VERSION_NOT_PINNED',
      { version }
    );
  }
}
