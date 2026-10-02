// Checks for common Vertical Pod Autoscaler mistakes.
//
// Errors are things the API server or the VPA rejects; the factory throws on
// them. Warnings are legal but usually unintended. Values that are schema
// references or CEL expressions are only known at reconcile time and are
// skipped.
//
// The HPA check reads the other resources already declared in the current
// composition. A VPA that sets CPU or memory while an HPA (or a KEDA
// ScaledObject, which creates one) scales the same workload on that resource
// makes the two controllers fight: the VPA changes the requests the HPA's
// utilization is computed against. The KEDA factory makes the same check the
// other way round, so declaration order does not matter.

import { getCurrentCompositionContext } from '../../../core/composition/context.js';
import { TypeKroError } from '../../../core/errors.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type { VerticalPodAutoscalerSpec, VpaBootstrapConfig } from '../types.js';

/** One finding from a VPA validator. */
export interface VpaValidationIssue {
  severity: 'error' | 'warning';
  /** Dotted path of the offending field, relative to `spec`. */
  path: string;
  message: string;
}

const logger = getComponentLogger('vpa-validation');
const RESOURCES = ['cpu', 'memory'] as const;
type ScaledResource = (typeof RESOURCES)[number];

function isGraphValue(value: unknown): boolean {
  return isKubernetesRef(value) || isCelExpression(value);
}

function concrete<T>(value: T | undefined): T | undefined {
  return value === undefined || isGraphValue(value) ? undefined : value;
}

/**
 * Validate a `VerticalPodAutoscaler` spec.
 *
 * @example
 * ```typescript
 * const errors = validateVerticalPodAutoscalerSpec(spec).filter((i) => i.severity === 'error');
 * ```
 */
export function validateVerticalPodAutoscalerSpec(
  spec: VerticalPodAutoscalerSpec
): VpaValidationIssue[] {
  const issues: VpaValidationIssue[] = [];
  if (isGraphValue(spec)) return issues;
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });

  const target = spec?.targetRef;
  if (!target || (!isGraphValue(target) && (!target.kind || !target.name))) {
    error('targetRef', 'targetRef needs a kind and a name');
  }

  const mode = concrete(spec?.updatePolicy?.updateMode);
  if (mode === 'Auto') {
    warn(
      'updatePolicy.updateMode',
      '"Auto" is deprecated since VPA 1.5; use "Recreate" or "InPlaceOrRecreate"'
    );
  }

  if (mode === 'InPlace') {
    warn(
      'updatePolicy.updateMode',
      '"InPlace" needs the InPlace feature gate on the admission controller and the updater ' +
        '(--feature-gates=InPlace=true)'
    );
  }

  const recommenders = concrete(spec?.recommenders);
  if (Array.isArray(recommenders) && recommenders.length > 1) {
    error('recommenders', 'at most one recommender is supported');
  }

  const policies = concrete(spec?.resourcePolicy?.containerPolicies);
  if (Array.isArray(policies)) {
    const seen = new Set<string>();
    policies.forEach((policy, index) => {
      const name = concrete(policy?.containerName);
      if (typeof name === 'string') {
        if (seen.has(name)) {
          error(
            `resourcePolicy.containerPolicies[${index}].containerName`,
            `duplicate policy for "${name}"`
          );
        }
        seen.add(name);
      }
      const controlled = concrete(policy?.controlledResources);
      if (Array.isArray(controlled) && controlled.length === 0) {
        warn(
          `resourcePolicy.containerPolicies[${index}].controlledResources`,
          'an empty list controls nothing; use mode: "Off" to exclude a container'
        );
      }
    });
  }
  return issues;
}

/**
 * Validate the `vpaBootstrap` spec. All findings are warnings.
 *
 * @example
 * ```typescript
 * validateVpaBootstrapConfig({ name: 'vpa', admissionController: { enabled: false } });
 * ```
 */
export function validateVpaBootstrapConfig(config: VpaBootstrapConfig): VpaValidationIssue[] {
  const issues: VpaValidationIssue[] = [];
  if (isGraphValue(config)) return issues;
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });
  const enabled = (value: boolean | undefined) => concrete(value) !== false;

  if (!enabled(config.recommender?.enabled)) {
    warn('recommender.enabled', 'no VPA gets a recommendation without a recommender');
  }
  if (enabled(config.updater?.enabled) && !enabled(config.admissionController?.enabled)) {
    warn(
      'updater.enabled',
      'the updater evicts pods that only the admission controller resizes on restart; ' +
        'disable both for recommend-only'
    );
  }
  for (const name of ['recommender', 'updater'] as const) {
    const replicas = concrete(config[name]?.replicas);
    if (typeof replicas === 'number' && replicas > 1) {
      warn(
        `${name}.replicas`,
        'this chart grants no leader-election lease, so extra replicas run in parallel'
      );
    }
  }
  const storage = concrete(config.recommender?.storage);
  if (storage === 'prometheus' && concrete(config.recommender?.prometheusAddress) === undefined) {
    warn('recommender.prometheusAddress', 'defaults to http://prometheus.monitoring.svc');
  }
  return issues;
}

interface ManifestLike {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: Record<string, unknown>;
}

// A plain clone of a declared resource. `toJSON` drops schema references
// (functions), so only concrete names are compared.
function manifestOf(resource: unknown): ManifestLike | undefined {
  try {
    return JSON.parse(JSON.stringify(resource)) as ManifestLike;
  } catch {
    return undefined;
  }
}

function hpaResources(spec: Record<string, unknown>): ScaledResource[] {
  if (typeof spec.targetCPUUtilizationPercentage === 'number') return ['cpu'];
  const metrics = spec.metrics as
    | Array<{ type?: string; resource?: { name?: string }; containerResource?: { name?: string } }>
    | undefined;
  // autoscaling/v2 without metrics defaults to 80% CPU.
  if (!Array.isArray(metrics) || metrics.length === 0) return ['cpu'];
  return RESOURCES.filter((name) =>
    metrics.some((metric) => (metric.resource ?? metric.containerResource)?.name === name)
  );
}

function scaledObjectResources(spec: Record<string, unknown>): ScaledResource[] {
  const triggers = spec.triggers as Array<{ type?: string }> | undefined;
  if (!Array.isArray(triggers)) return [];
  return RESOURCES.filter((name) => triggers.some((trigger) => trigger.type === name));
}

/** Resources the VPA sets: cpu and memory unless every active policy narrows them. */
function vpaResources(spec: VerticalPodAutoscalerSpec): ScaledResource[] {
  const policies = concrete(spec.resourcePolicy?.containerPolicies);
  if (!Array.isArray(policies) || policies.length === 0) return [...RESOURCES];
  const controlled = new Set<ScaledResource>();
  for (const policy of policies) {
    if (concrete(policy?.mode) === 'Off') continue;
    const list = concrete(policy?.controlledResources);
    for (const name of Array.isArray(list) ? list : RESOURCES) controlled.add(name);
  }
  return [...controlled];
}

/**
 * Warnings for autoscalers declared in the current composition that scale the
 * VPA's target on a resource the VPA also sets. Empty outside a composition
 * and for `updateMode: 'Off'`.
 *
 * @example
 * ```typescript
 * findVpaAutoscalerConflicts(spec, 'default');
 * ```
 */
export function findVpaAutoscalerConflicts(
  spec: VerticalPodAutoscalerSpec,
  namespace: string | undefined
): VpaValidationIssue[] {
  const context = getCurrentCompositionContext();
  if (!context || isGraphValue(spec) || concrete(spec.updatePolicy?.updateMode) === 'Off') {
    return [];
  }
  const kind = concrete(spec.targetRef?.kind);
  const name = concrete(spec.targetRef?.name);
  if (typeof kind !== 'string' || typeof name !== 'string') return [];
  const ours = vpaResources(spec);

  const issues: VpaValidationIssue[] = [];
  for (const resource of Object.values(context.resources)) {
    const manifest = manifestOf(resource);
    const other = manifest?.spec;
    if (!manifest || !other) continue;
    if (concrete(namespace) !== undefined && manifest.metadata?.namespace !== undefined) {
      if (manifest.metadata.namespace !== namespace) continue;
    }
    const isHpa = manifest.kind === 'HorizontalPodAutoscaler';
    const isScaledObject =
      manifest.kind === 'ScaledObject' && manifest.apiVersion?.startsWith('keda.sh/') === true;
    if (!isHpa && !isScaledObject) continue;
    const ref = other.scaleTargetRef as { kind?: string; name?: string } | undefined;
    // A ScaledObject's scaleTargetRef.kind defaults to Deployment.
    const refKind = ref?.kind ?? (isScaledObject ? 'Deployment' : undefined);
    if (ref?.name !== name || refKind !== kind) continue;
    const shared = (isHpa ? hpaResources(other) : scaledObjectResources(other)).filter((r) =>
      ours.includes(r)
    );
    if (shared.length === 0) continue;
    issues.push({
      severity: 'warning',
      path: 'updatePolicy.updateMode',
      message:
        `${manifest.kind} "${manifest.metadata?.name}" also scales ${kind}/${name} on ` +
        `${shared.join(' and ')}; set updateMode "Off", or limit controlledResources to what ` +
        'the horizontal autoscaler does not use',
    });
  }
  return issues;
}

/** Log validator warnings, once per composition run. Used by the factories. */
export function warnVpaIssues(source: string, issues: VpaValidationIssue[]): void {
  if (getCurrentCompositionContext()?.suppressResourceDiagnostics) return;
  for (const issue of issues) {
    if (issue.severity === 'warning') logger.warn(`${source}: ${issue.path}: ${issue.message}`);
  }
}

/** Throw on validator errors. Used by the factories. */
export function assertNoVpaErrors(name: unknown, issues: VpaValidationIssue[]): void {
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length === 0) return;
  const label = typeof name === 'string' && !isGraphValue(name) ? ` "${name}"` : '';
  throw new TypeKroError(
    `Invalid VerticalPodAutoscaler${label}: ${errors.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    'VPA_INVALID_SPEC',
    { issues: errors }
  );
}
