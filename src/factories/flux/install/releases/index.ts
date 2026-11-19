/**
 * Pinned Flux releases, by exact version. Each is generated from that release's `install.yaml`
 * by `scripts/vendor-flux-release.ts`; see `../README.md` to add another.
 */
import type { FluxRelease } from '../types.js';
import { fluxV2_7_5 } from './v2.7.5.js';

export const FLUX_RELEASES: Readonly<Record<string, FluxRelease>> = {
  'v2.7.5': fluxV2_7_5,
};
