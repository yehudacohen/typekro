// Checks for common KEDA configuration mistakes.
//
// Errors are things KEDA's admission webhook or the CRD rejects; the factories
// throw on them. Warnings are legal but usually unintended. Values that are
// schema references or CEL expressions are only known at reconcile time and
// are skipped.
//
// The conflict check reads the other resources already declared in the
// current composition:
// - an HPA on the same target: KEDA creates and owns the target's HPA, and its
//   webhook rejects a ScaledObject whose target already has one;
// - a VerticalPodAutoscaler that sets CPU or memory on a target this
//   ScaledObject scales on CPU or memory: the VPA changes the requests the
//   utilization is computed against, and the two chase each other.
// The VPA factory makes the second check the other way round.

import { getCurrentCompositionContext } from '../../../core/composition/context.js';
import { TypeKroError } from '../../../core/errors.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type {
  KedaBootstrapConfig,
  KedaTrigger,
  ScaledJobSpec,
  ScaledObjectSpec,
} from '../types.js';

/** One finding from a KEDA validator. */
export interface KedaValidationIssue {
  severity: 'error' | 'warning';
  /** Dotted path of the offending field, relative to `spec`. */
  path: string;
  message: string;
}

const logger = getComponentLogger('keda-validation');
const RESOURCE_TRIGGERS = ['cpu', 'memory'];

function isGraphValue(value: unknown): boolean {
  return isKubernetesRef(value) || isCelExpression(value);
}

function concrete<T>(value: T | undefined): T | undefined {
  return value === undefined || isGraphValue(value) ? undefined : value;
}

function concreteTriggers(triggers: readonly KedaTrigger[] | undefined): KedaTrigger[] | undefined {
  const list = concrete(triggers);
  return Array.isArray(list) ? list.filter((trigger) => !isGraphValue(trigger)) : undefined;
}

function validateTriggers(
  triggers: readonly KedaTrigger[] | undefined,
  issues: KedaValidationIssue[]
): void {
  if (triggers === undefined || (concrete(triggers) !== undefined && triggers.length === 0)) {
    issues.push({
      severity: 'error',
      path: 'triggers',
      message: 'at least one trigger is required',
    });
  }
  const list = concreteTriggers(triggers) ?? [];
  const names = new Set<string>();
  list.forEach((trigger, index) => {
    const name = concrete(trigger.name);
    if (typeof name === 'string') {
      if (names.has(name)) {
        issues.push({
          severity: 'error',
          path: `triggers[${index}].name`,
          message: `trigger name "${name}" is used twice`,
        });
      }
      names.add(name);
    }
    const type = concrete(trigger.type);
    const metricType = concrete(trigger.metricType as string | undefined);
    if (typeof type === 'string' && RESOURCE_TRIGGERS.includes(type) && metricType === 'Value') {
      issues.push({
        severity: 'error',
        path: `triggers[${index}].metricType`,
        message: `${type} triggers take "Utilization" or "AverageValue", not "Value"`,
      });
    }
    if (
      typeof type === 'string' &&
      !RESOURCE_TRIGGERS.includes(type) &&
      metricType === 'Utilization'
    ) {
      issues.push({
        severity: 'error',
        path: `triggers[${index}].metricType`,
        message: '"Utilization" is only valid for cpu and memory triggers',
      });
    }
  });
}

/**
 * Validate a `ScaledObject` spec.
 *
 * @example
 * ```typescript
 * const errors = validateScaledObjectSpec(spec).filter((issue) => issue.severity === 'error');
 * ```
 */
export function validateScaledObjectSpec(spec: ScaledObjectSpec): KedaValidationIssue[] {
  const issues: KedaValidationIssue[] = [];
  if (isGraphValue(spec)) return issues;
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });

  if (!spec?.scaleTargetRef || (!isGraphValue(spec.scaleTargetRef) && !spec.scaleTargetRef.name)) {
    error('scaleTargetRef.name', 'scaleTargetRef needs a name');
  }
  validateTriggers(spec?.triggers, issues);

  const min = concrete(spec?.minReplicaCount);
  const max = concrete(spec?.maxReplicaCount);
  const idle = concrete(spec?.idleReplicaCount);
  const effectiveMin = typeof min === 'number' ? min : 0;
  if (typeof max === 'number' && effectiveMin > max) {
    error('minReplicaCount', 'minReplicaCount must not exceed maxReplicaCount');
  }
  if (typeof idle === 'number' && idle >= effectiveMin) {
    error('idleReplicaCount', 'idleReplicaCount must be lower than minReplicaCount');
  }

  const triggers = concreteTriggers(spec?.triggers) ?? [];
  const types = triggers.map((trigger) => concrete(trigger.type));
  const onlyResource =
    triggers.length > 0 &&
    types.every((type) => typeof type === 'string' && RESOURCE_TRIGGERS.includes(type));
  if (onlyResource && effectiveMin === 0) {
    error(
      'minReplicaCount',
      'scaling to zero needs at least one trigger other than cpu or memory; set minReplicaCount >= 1'
    );
  }

  const modifiers = concrete(spec?.advanced?.scalingModifiers);
  if (modifiers && concrete(modifiers.formula) !== undefined) {
    if (!concrete(modifiers.target)) {
      error('advanced.scalingModifiers.target', 'a formula needs a target');
    }
    triggers.forEach((trigger, index) => {
      if (trigger.name === undefined) {
        warn(`triggers[${index}].name`, 'name every trigger the formula refers to');
      }
    });
  }

  const fallback = concrete(spec?.fallback);
  if (fallback !== undefined) {
    if (
      concrete(fallback.behavior) === 'scalingModifiers' &&
      concrete(modifiers?.formula) === undefined
    ) {
      error('fallback.behavior', '"scalingModifiers" needs advanced.scalingModifiers.formula');
    }
    triggers.forEach((trigger, index) => {
      const type = concrete(trigger.type);
      if (typeof type === 'string' && RESOURCE_TRIGGERS.includes(type)) {
        warn(`triggers[${index}]`, 'fallback does not apply to cpu and memory triggers');
      }
    });
  }
  return issues;
}

/**
 * Validate a `ScaledJob` spec.
 *
 * @example
 * ```typescript
 * validateScaledJobSpec(spec);
 * ```
 */
export function validateScaledJobSpec(spec: ScaledJobSpec): KedaValidationIssue[] {
  const issues: KedaValidationIssue[] = [];
  if (isGraphValue(spec)) return issues;
  if (!spec?.jobTargetRef) {
    issues.push({ severity: 'error', path: 'jobTargetRef', message: 'jobTargetRef is required' });
  }
  validateTriggers(spec?.triggers, issues);
  const min = concrete(spec?.minReplicaCount);
  const max = concrete(spec?.maxReplicaCount);
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    issues.push({
      severity: 'error',
      path: 'minReplicaCount',
      message: 'minReplicaCount must not exceed maxReplicaCount',
    });
  }
  return issues;
}

/**
 * Validate the `kedaBootstrap` spec. All findings are warnings.
 *
 * @example
 * ```typescript
 * validateKedaBootstrapConfig({ name: 'keda', webhooks: { enabled: false } });
 * ```
 */
export function validateKedaBootstrapConfig(config: KedaBootstrapConfig): KedaValidationIssue[] {
  const issues: KedaValidationIssue[] = [];
  if (isGraphValue(config)) return issues;
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });

  if (concrete(config.webhooks?.enabled) === false) {
    warn(
      'webhooks.enabled',
      'without the webhooks, ScaledObjects that conflict with an HPA or with each other are accepted'
    );
  }
  for (const name of ['operator', 'metricsServer', 'webhooks'] as const) {
    const component = config[name];
    const replicas = concrete(component?.replicas) ?? 1;
    const minAvailable = concrete(component?.podDisruptionBudget?.minAvailable);
    if (typeof minAvailable === 'number' && minAvailable >= replicas) {
      warn(
        `${name}.podDisruptionBudget.minAvailable`,
        `minAvailable ${minAvailable} with ${replicas} replica(s) blocks every voluntary eviction`
      );
    }
  }
  const irsa = concrete(config.podIdentity?.awsIrsa);
  if (concrete(irsa?.enabled) === true && !concrete(irsa?.roleArn)) {
    warn('podIdentity.awsIrsa.roleArn', 'IRSA is enabled without a role ARN');
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

/** Resources a VPA sets: cpu and memory unless every active policy narrows them. */
function vpaResources(spec: Record<string, unknown>): string[] {
  const policies = (spec.resourcePolicy as { containerPolicies?: unknown[] } | undefined)
    ?.containerPolicies as Array<{ mode?: string; controlledResources?: string[] }> | undefined;
  if (!Array.isArray(policies) || policies.length === 0) return [...RESOURCE_TRIGGERS];
  const controlled = new Set<string>();
  for (const policy of policies) {
    if (policy.mode === 'Off') continue;
    for (const name of policy.controlledResources ?? RESOURCE_TRIGGERS) controlled.add(name);
  }
  return [...controlled];
}

/**
 * Warnings for autoscalers declared in the current composition that conflict
 * with a ScaledObject: any HPA on its target, and a VPA (not `Off`) setting
 * CPU or memory this ScaledObject scales on. Empty outside a composition.
 *
 * @example
 * ```typescript
 * findKedaAutoscalerConflicts(spec, 'default');
 * ```
 */
export function findKedaAutoscalerConflicts(
  spec: ScaledObjectSpec,
  namespace: string | undefined
): KedaValidationIssue[] {
  const context = getCurrentCompositionContext();
  if (!context || isGraphValue(spec)) return [];
  const name = concrete(spec.scaleTargetRef?.name);
  const kind = concrete(spec.scaleTargetRef?.kind) ?? 'Deployment';
  if (typeof name !== 'string' || typeof kind !== 'string') return [];
  const resourceTriggers = RESOURCE_TRIGGERS.filter((resource) =>
    (concreteTriggers(spec.triggers) ?? []).some((trigger) => trigger.type === resource)
  );

  const issues: KedaValidationIssue[] = [];
  for (const resource of Object.values(context.resources)) {
    const manifest = manifestOf(resource);
    const other = manifest?.spec;
    if (!manifest || !other) continue;
    if (concrete(namespace) !== undefined && manifest.metadata?.namespace !== undefined) {
      if (manifest.metadata.namespace !== namespace) continue;
    }
    if (manifest.kind === 'HorizontalPodAutoscaler') {
      const ref = other.scaleTargetRef as { kind?: string; name?: string } | undefined;
      if (ref?.name === name && ref.kind === kind) {
        issues.push({
          severity: 'warning',
          path: 'scaleTargetRef',
          message:
            `HorizontalPodAutoscaler "${manifest.metadata?.name}" already scales ${kind}/${name}; ` +
            'KEDA creates its own HPA and its webhook rejects a second one. Remove the HPA',
        });
      }
      continue;
    }
    const isVpa =
      manifest.kind === 'VerticalPodAutoscaler' &&
      manifest.apiVersion?.startsWith('autoscaling.k8s.io/') === true;
    if (!isVpa || resourceTriggers.length === 0) continue;
    const ref = other.targetRef as { kind?: string; name?: string } | undefined;
    const mode = (other.updatePolicy as { updateMode?: string } | undefined)?.updateMode;
    if (ref?.name !== name || ref.kind !== kind || mode === 'Off') continue;
    const shared = resourceTriggers.filter((r) => vpaResources(other).includes(r));
    if (shared.length === 0) continue;
    issues.push({
      severity: 'warning',
      path: 'triggers',
      message:
        `VerticalPodAutoscaler "${manifest.metadata?.name}" also sets ${shared.join(' and ')} ` +
        `requests on ${kind}/${name}; set its updateMode "Off", or scale on a metric other than ` +
        'the resource it controls',
    });
  }
  return issues;
}

/** Log validator warnings, once per composition run. Used by the factories. */
export function warnKedaIssues(source: string, issues: KedaValidationIssue[]): void {
  if (getCurrentCompositionContext()?.suppressResourceDiagnostics) return;
  for (const issue of issues) {
    if (issue.severity === 'warning') logger.warn(`${source}: ${issue.path}: ${issue.message}`);
  }
}

/** Throw on validator errors. Used by the factories. */
export function assertNoKedaErrors(
  kind: string,
  name: unknown,
  issues: KedaValidationIssue[]
): void {
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length === 0) return;
  const label = typeof name === 'string' && !isGraphValue(name) ? ` "${name}"` : '';
  throw new TypeKroError(
    `Invalid ${kind}${label}: ${errors.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    'KEDA_INVALID_SPEC',
    { kind, issues: errors }
  );
}
