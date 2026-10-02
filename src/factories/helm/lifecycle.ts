// Shared Flux lifecycle policy for every TypeKro HelmRelease factory.
//
// Each integration factory used to hand-write its own `install`/`upgrade`
// blocks, and several wrote none at all. Flux then fell back to its own
// defaults — a 5m timeout and zero remediation retries — so one slow first
// install left the release Stalled until someone ran `flux reconcile --reset`.
// Routing every factory through this helper gives them all the same knobs and,
// unless a factory says otherwise, the same bounded-retry defaults as the
// generic `helmRelease`.

import type { Composable } from '../../core/types/composable.js';
import type {
  HelmReleaseInstallPolicy,
  HelmReleaseLifecycleOptions,
  HelmReleaseSpec,
  HelmReleaseUpgradePolicy,
} from './types.js';

/** The `spec` fields the lifecycle helper renders. */
export type HelmReleaseLifecycleSpec = Pick<
  HelmReleaseSpec,
  'install' | 'upgrade' | 'driftDetection'
>;

// The generic `helmRelease` defaults. A chart that waits on something external
// (a database, a webhook, a CRD from another release) routinely needs more than
// Flux's 5m, and a retry budget turns a transient failure into a self-healing
// one instead of a Stalled release.
const DEFAULT_LIFECYCLE: HelmReleaseLifecycleSpec = {
  install: { timeout: '10m', remediation: { retries: 3 } },
  upgrade: { timeout: '10m', remediation: { retries: 3 } },
};

// Field order follows the generic factory's historic output so rendered YAML
// keeps its shape; `crds` is appended where it was previously dropped.
const INSTALL_KEYS = ['timeout', 'remediation', 'createNamespace', 'crds'] as const;
const UPGRADE_KEYS = ['timeout', 'remediation', 'crds'] as const;
const INSTALL_REMEDIATION_KEYS = ['retries', 'remediateLastFailure', 'ignoreTestFailures'] as const;
const UPGRADE_REMEDIATION_KEYS = [...INSTALL_REMEDIATION_KEYS, 'strategy'] as const;

type FieldBag = Readonly<Record<string, unknown>>;

// Fields are read one by one rather than spread. A schema reference arrives as
// a proxy, and spreading a proxy enumerates nothing, so the caller's setting
// would silently vanish. Reading a named field from it yields a field reference
// that serializes as CEL.
//
// Known gap: when a whole `install`/`upgrade` object is one schema reference,
// every field read from it is a reference too (never `undefined`), so the
// defaults do not fill the fields an instance leaves unset. Callers should pass
// individual fields in KRO mode; the Flux docs say so.
function mergeFields(
  keys: readonly string[],
  remediationKeys: readonly string[],
  base: FieldBag | undefined,
  override: FieldBag | undefined
): FieldBag | undefined {
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const value =
      key === 'remediation'
        ? mergeFields(
            remediationKeys,
            [],
            base?.remediation as FieldBag | undefined,
            override?.remediation as FieldBag | undefined
          )
        : (override?.[key] ?? base?.[key]);
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merge caller lifecycle options over a factory's defaults, for spreading into
 * a HelmRelease `spec`. Defaults to the generic `helmRelease` policy (10m
 * timeouts, 3 remediation retries).
 *
 * @example
 * ```typescript
 * spec: { ...helmReleaseLifecycle(config), chart, values }
 * ```
 */
export function helmReleaseLifecycle(
  options: Composable<HelmReleaseLifecycleOptions> | undefined,
  defaults: HelmReleaseLifecycleSpec = DEFAULT_LIFECYCLE
): HelmReleaseLifecycleSpec {
  const install = mergeFields(
    INSTALL_KEYS,
    INSTALL_REMEDIATION_KEYS,
    defaults.install,
    options?.install as FieldBag | undefined
  );
  const upgrade = mergeFields(
    UPGRADE_KEYS,
    UPGRADE_REMEDIATION_KEYS,
    defaults.upgrade,
    options?.upgrade as FieldBag | undefined
  );
  const driftDetection = options?.driftDetection ?? defaults.driftDetection;
  const spec: HelmReleaseLifecycleSpec = {};
  if (install) spec.install = install as HelmReleaseInstallPolicy;
  if (upgrade) spec.upgrade = upgrade as HelmReleaseUpgradePolicy;
  if (driftDetection) {
    spec.driftDetection = driftDetection as NonNullable<HelmReleaseSpec['driftDetection']>;
  }
  return spec;
}
