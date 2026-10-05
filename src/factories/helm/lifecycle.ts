// Shared Flux lifecycle policy for every TypeKro HelmRelease factory.
//
// Each integration factory used to hand-write its own `install`/`upgrade`
// blocks, and several wrote none at all. Flux then fell back to its own
// defaults — a 5m timeout and zero remediation retries — so one slow first
// install left the release Stalled until someone ran `flux reconcile --reset`.
// Routing every factory through this helper gives them all the same knobs and,
// unless a factory says otherwise, the same bounded-retry defaults as the
// generic `helmRelease`.

import { SCHEMA_REFERENCE_OPTIONAL_BRAND } from '../../core/constants/brands.js';
import { Cel } from '../../core/references/cel.js';
import { declaredSchemaFields, isSchemaReference } from '../../core/references/schema-proxy.js';
import type { KubernetesRef } from '../../core/types/common.js';
import type { Composable } from '../../core/types/composable.js';
import type { RefOrValue } from '../../core/types/references.js';
import { isKubernetesRef } from '../../utils/type-guards.js';
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

/**
 * Read one field of a caller override. A plain object answers directly. A
 * schema or resource reference (KRO mode, e.g. `install: spec.install`) arrives
 * as a proxy, and spreading a proxy enumerates nothing, so fields are always
 * read by name: reading a field off a reference yields a reference to that
 * field. A field the instance schema does not declare can never be set, so it
 * reads as absent rather than as CEL selecting a field the schema lacks.
 */
function readField(bag: unknown, key: string): unknown {
  if (bag === undefined || bag === null) return undefined;
  if (isKubernetesRef(bag)) {
    const declared = declaredSchemaFields(bag);
    if (declared && !declared.has(key)) return undefined;
  }
  return (bag as FieldBag)[key];
}

/**
 * Whether a value is read from the instance at reconcile time and may be
 * missing there: any graph reference except a schema field the schema
 * declares required.
 */
function mayBeAbsentAtInstanceTime(value: unknown): value is KubernetesRef<unknown> {
  if (!isKubernetesRef(value)) return false;
  return !isSchemaReference(value) || Reflect.get(value, SCHEMA_REFERENCE_OPTIONAL_BRAND) === true;
}

/**
 * "Caller value when set, otherwise the default" for one leaf. With concrete
 * values that is `??`. A reference only resolves per instance, where `??` has
 * nothing to test at build time (a reference is never `undefined`), so the
 * choice is emitted as CEL instead: the instance field when present, else the
 * default. Direct mode passes concrete values and takes the `??` path.
 */
function withDefault(override: unknown, fallback: unknown): unknown {
  if (fallback !== undefined && mayBeAbsentAtInstanceTime(override)) {
    // Leaves are scalars or (drift detection) objects; the emitted CEL is the
    // same either way, so the object overload stands in for both.
    return Cel.default<object | undefined>(override, fallback as RefOrValue<object>);
  }
  return override ?? fallback;
}

function mergeFields(
  keys: readonly string[],
  remediationKeys: readonly string[],
  base: FieldBag | undefined,
  override: unknown
): FieldBag | undefined {
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const value =
      key === 'remediation'
        ? mergeFields(
            remediationKeys,
            [],
            base?.remediation as FieldBag | undefined,
            readField(override, key)
          )
        : withDefault(readField(override, key), base?.[key]);
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
 * In KRO mode an override can be a schema reference at any level, down to a
 * whole `install` or `upgrade` object. Every leaf that has a default then
 * renders as `Cel.default(<instance field>, <default>)`: the instance's value
 * when it sets the field, otherwise the default, exactly as in direct mode.
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
    readField(options, 'install')
  );
  const upgrade = mergeFields(
    UPGRADE_KEYS,
    UPGRADE_REMEDIATION_KEYS,
    defaults.upgrade,
    readField(options, 'upgrade')
  );
  // Drift detection replaces the default as a whole, so it is one leaf.
  const driftDetection = withDefault(readField(options, 'driftDetection'), defaults.driftDetection);
  const spec: HelmReleaseLifecycleSpec = {};
  if (install) spec.install = install as HelmReleaseInstallPolicy;
  if (upgrade) spec.upgrade = upgrade as HelmReleaseUpgradePolicy;
  if (driftDetection) {
    spec.driftDetection = driftDetection as NonNullable<HelmReleaseSpec['driftDetection']>;
  }
  return spec;
}
