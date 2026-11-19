/**
 * Flux install types: a pinned Flux release (its version and parsed install manifests) and the
 * spec of the install composition.
 */

import { type Type, type } from 'arktype';

/** One Kubernetes object from a release's install manifests. */
export interface FluxManifestObject {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
  } & Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

/** A pinned Flux release: its exact version and its parsed install manifests. */
export interface FluxRelease {
  /** For example `v2.7.5`. */
  readonly version: string;
  /** sha256 of the release's `install.yaml` these documents were parsed from. */
  readonly sourceSha256?: string;
  readonly documents: readonly FluxManifestObject[];
}

export interface FluxToleration {
  key?: string;
  operator?: 'Equal' | 'Exists';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

/** Spec of the install composition. */
export interface FluxInstallConfig {
  /** Must equal the release's pinned version. */
  version: string;
  /** Replace every controller's pod tolerations. @default the manifest's own */
  tolerations?: FluxToleration[];
  /** Replace every controller's pod node selector. @default the manifest's own (none in v2.7.5) */
  nodeSelector?: Record<string, string>;
}

export const FluxInstallConfigSchema: Type<FluxInstallConfig> = type({
  version: 'string > 0',
  'tolerations?': type({
    'key?': 'string',
    'operator?': '"Equal" | "Exists"',
    'value?': 'string',
    'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
    'tolerationSeconds?': 'number.integer',
  }).array(),
  'nodeSelector?': 'Record<string, string>',
});

export interface FluxInstallStatus {
  ready: boolean;
}

export const FluxInstallStatusSchema: Type<FluxInstallStatus> = type({ ready: 'boolean' });

/** Build-time options of {@link makeFluxInstall}. They decide which resources exist. */
export interface FluxInstallBuildOptions {
  /** The pinned release whose manifests are rendered. */
  release: FluxRelease;
  /** Composition name. @default 'flux-install' */
  name?: string;
  /** Composition kind. @default 'FluxInstall' */
  kind?: string;
}
