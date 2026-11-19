/**
 * Pinned Flux releases, by exact version. Each is generated from that release's `install.yaml`
 * by `scripts/vendor-flux-release.ts`; see `../README.md` to add another.
 *
 * A release module holds the whole install (about 680 KB of source for v2.7.5), so nothing here
 * imports one statically: importing `typekro` or `typekro/flux` loads no release.
 * {@link loadFluxRelease} loads one on demand, and each release is also its own subpath export,
 * such as `typekro/flux/releases/v2.7.5`, for a synchronous import.
 */
import { TypeKroError } from '../../../../core/errors.js';
import type { FluxRelease } from '../types.js';
import { assertPinnedFluxVersion } from '../version.js';

const FLUX_RELEASE_LOADERS: Readonly<Record<string, () => Promise<FluxRelease>>> = {
  'v2.7.5': async () => (await import('./v2.7.5.js')).fluxV2_7_5,
};

/** Versions with pinned, vendored install manifests. */
export const FLUX_RELEASE_VERSIONS: readonly string[] = Object.freeze(
  Object.keys(FLUX_RELEASE_LOADERS)
);

/** Load the pinned release for `version`. Throws if it isn't one of {@link FLUX_RELEASE_VERSIONS}. */
export async function loadFluxRelease(version: string): Promise<FluxRelease> {
  assertPinnedFluxVersion(version);
  const load = Object.hasOwn(FLUX_RELEASE_LOADERS, version)
    ? FLUX_RELEASE_LOADERS[version]
    : undefined;
  if (!load) {
    throw new TypeKroError(
      `No pinned Flux manifests for ${version}. Add them as described in src/factories/flux/install/README.md.`,
      'FLUX_INSTALL_RELEASE_NOT_PINNED',
      { version, available: FLUX_RELEASE_VERSIONS }
    );
  }
  return load();
}
