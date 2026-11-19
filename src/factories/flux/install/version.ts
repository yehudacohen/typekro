import { type } from 'arktype';
import { TypeKroError } from '../../../core/errors.js';
import { type SpecConstraint, specConstraint } from '../../../core/validation/spec-constraint.js';

/**
 * A pinned Flux version: `v<major>.<minor>.<patch>`, optionally with a pre-release suffix such
 * as `v2.8.0-rc.1`. It refuses `latest`, an unprefixed version (`2.10.0`) and a partial one
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
      `Flux version must be pinned, like "v2.10.0"; got ${JSON.stringify(version)}.`,
      'FLUX_VERSION_NOT_PINNED',
      { version }
    );
  }
}

/** One constraint per release version, so every schema that declares it shares one type. */
const VERSION_CONSTRAINTS = new Map<string, SpecConstraint<string>>();

/**
 * `version` of one release's install composition: exactly `releaseVersion`. Its enum and
 * `required=true` are on the instance schema, so the API server refuses a KRO instance asking
 * for another version or none, and the composition refuses one in direct mode with
 * `FLUX_INSTALL_VERSION_MISMATCH`.
 *
 * A composition that passes one of its own spec fields as `version`, for example to a Flux
 * install composed inside it, declares that field with this constraint's `type` as a required
 * key. Any other reference is refused when the composition is built.
 */
export function fluxVersionConstraint(releaseVersion: string): SpecConstraint<string> {
  assertPinnedFluxVersion(releaseVersion);
  const existing = VERSION_CONSTRAINTS.get(releaseVersion);
  if (existing) return existing;
  const constraint = specConstraint<string>({
    path: 'version',
    type: type
      .unit(releaseVersion)
      .configure({ expected: `the release version ${releaseVersion}` }),
    required: true,
    code: 'FLUX_INSTALL_VERSION_MISMATCH',
    declaredWith: `fluxVersionConstraint(${JSON.stringify(releaseVersion)}).type`,
    message: (requested) =>
      `Flux ${String(requested)} is requested, but these manifests are ${releaseVersion}.`,
  });
  VERSION_CONSTRAINTS.set(releaseVersion, constraint);
  return constraint;
}
