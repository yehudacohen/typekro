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
import { ValidationError } from '../../core/errors.js';
import { Cel } from '../../core/references/cel.js';
import {
  declaredSchemaFields,
  declaredSchemaNumberKind,
  isSchemaReference,
} from '../../core/references/schema-proxy.js';
import { getInnerCelPath } from '../../core/serialization/cel-references.js';
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
 * Whether a value is an optional field of the instance schema, which KRO may
 * find unset. Only those get a CEL fallback. A required schema field always has
 * a value. A reference to another resource keeps KRO's usual behaviour of
 * waiting until the field exists, rather than applying the default first and
 * changing the spec once the field appears.
 */
function isOptionalSchemaField(value: unknown): value is KubernetesRef<unknown> {
  return (
    isKubernetesRef(value) &&
    isSchemaReference(value) &&
    Reflect.get(value, SCHEMA_REFERENCE_OPTIONAL_BRAND) === true
  );
}

/** Lifecycle leaves Flux types as integers. */
const INTEGER_KEYS: ReadonlySet<string> = new Set(['retries']);

/**
 * An optional schema field used as a fallback inside a CEL choice. A bare
 * reference to it would fail at reconcile time with "no such key" when the
 * instance leaves it unset, so it is guarded and omitted instead.
 */
function guardedFallback(fallback: unknown): unknown {
  return isOptionalSchemaField(fallback)
    ? Cel.default<object | undefined>(fallback, Cel.expr<object>('omit()'))
    : fallback;
}

/**
 * Reject an integer leaf (`retries`) that cannot be an integer, so direct and
 * KRO mode fail alike instead of KRO silently coercing a value. A concrete
 * non-integer fails here, as the HelmRelease CRD would reject it. A schema
 * field declared as a plain ArkType `'number'` is a KRO `float`, which KRO's
 * type checker rejects for an integer field only after the RGD is applied, so
 * it fails at build time with the declaration to use. When the declared type
 * is unknown (a resource reference, a union, a map), the reference is passed
 * through unchanged and KRO's type checker decides.
 */
function assertIntegerLeaf(value: unknown, path: string): void {
  const fail = (message: string): never => {
    throw new ValidationError(message, 'HelmRelease', path, path, [
      `Declare the schema field as 'number.integer', or pass a whole number.`,
    ]);
  };
  if (typeof value === 'number' && !Number.isInteger(value)) {
    fail(`HelmRelease ${path} must be a whole number; got ${value}.`);
  }
  if (isKubernetesRef(value) && declaredSchemaNumberKind(value) === 'float') {
    fail(
      `HelmRelease ${path} is the schema field ${getInnerCelPath(value)}, declared as 'number', ` +
        "which KRO types as a float. Flux requires an integer: declare it as 'number.integer'."
    );
  }
}

/**
 * "Caller value when set, otherwise the default" for one lifecycle leaf. With
 * concrete values (direct mode, or a plain object in KRO mode) that is `??`.
 * An optional schema field is a reference that only resolves per instance, so
 * `??` has nothing to test at build time; the choice is emitted as CEL instead:
 * the instance field when present, else the default.
 *
 * Exported for factories whose defaults themselves depend on another field
 * (Cilium's per-action timeouts fall back to its release-wide `timeout`).
 */
export function lifecycleDefault(value: unknown, fallback: unknown): unknown {
  if (fallback === undefined || !isOptionalSchemaField(value)) {
    return value ?? fallback;
  }
  // Leaves are scalars or (drift detection) objects; the emitted CEL is the
  // same either way, so the object overload stands in for both.
  return Cel.default<object | undefined>(value, guardedFallback(fallback) as RefOrValue<object>);
}

function mergeFields(
  keys: readonly string[],
  remediationKeys: readonly string[],
  base: FieldBag | undefined,
  override: unknown,
  path: string
): FieldBag | undefined {
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    let value: unknown;
    if (key === 'remediation') {
      value = mergeFields(
        remediationKeys,
        [],
        base?.remediation as FieldBag | undefined,
        readField(override, key),
        `${path}.remediation`
      );
    } else {
      const callerValue = readField(override, key);
      if (INTEGER_KEYS.has(key)) {
        assertIntegerLeaf(callerValue, `spec.${path}.${key}`);
        assertIntegerLeaf(base?.[key], `spec.${path}.${key}`);
      }
      value = lifecycleDefault(callerValue, base?.[key]);
    }
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
    readField(options, 'install'),
    'install'
  );
  const upgrade = mergeFields(
    UPGRADE_KEYS,
    UPGRADE_REMEDIATION_KEYS,
    defaults.upgrade,
    readField(options, 'upgrade'),
    'upgrade'
  );
  // Drift detection replaces the default as a whole, so it is one leaf.
  const driftDetection = lifecycleDefault(
    readField(options, 'driftDetection'),
    defaults.driftDetection
  );
  const spec: HelmReleaseLifecycleSpec = {};
  if (install) spec.install = install as HelmReleaseInstallPolicy;
  if (upgrade) spec.upgrade = upgrade as HelmReleaseUpgradePolicy;
  if (driftDetection) {
    spec.driftDetection = driftDetection as NonNullable<HelmReleaseSpec['driftDetection']>;
  }
  return spec;
}
