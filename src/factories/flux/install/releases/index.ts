/**
 * PINNED FLUX RELEASES
 *
 * This registry is intentionally empty. Downloading Flux's release `install.yaml` has not been
 * approved yet, so no upstream manifests are vendored. Tests use a neutral stand-in release
 * (`test/fixtures/flux/stand-in-release.ts`) that has the shape of Flux's manifests but is not
 * Flux.
 *
 * To add a release once the download is approved, follow `../README.md`: add
 * `releases/<version>.ts` exporting a `FluxRelease` parsed from that version's `install.yaml`,
 * and register it below.
 */
import type { FluxRelease } from '../types.js';

export const FLUX_RELEASES: Readonly<Record<string, FluxRelease>> = {
  // 'v2.7.5': fluxV2_7_5,  <- pinned release manifests go here once the download is approved.
};
