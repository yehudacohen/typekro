// Checks for common Karpenter configuration mistakes.
//
// Errors are things the API server or Karpenter rejects; the factories throw
// on them. Warnings are legal but usually unintended. Values that are schema
// references or CEL expressions are only known at reconcile time and are
// skipped.

import { TypeKroError } from '../../../core/errors.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type { EC2NodeClassSpec, KarpenterBootstrapConfig, NodePoolSpec } from '../types.js';

/** One finding from a Karpenter validator. */
export interface KarpenterValidationIssue {
  severity: 'error' | 'warning';
  /** Dotted path of the offending field, relative to `spec`. */
  path: string;
  message: string;
}

const RESTRICTED_LABELS = ['karpenter.sh/nodepool', 'kubernetes.io/hostname'];
const INTEGER = /^\d+$/;

function isGraphValue(value: unknown): boolean {
  return isKubernetesRef(value) || isCelExpression(value);
}

/** A concrete array, or undefined when absent or only known at reconcile time. */
function concreteArray<T>(value: readonly T[] | undefined): readonly T[] | undefined {
  return Array.isArray(value) && !isGraphValue(value) ? value : undefined;
}

function isConcreteString(value: unknown): value is string {
  return typeof value === 'string' && !isGraphValue(value);
}

function hasAny(term: object, keys: readonly string[]): boolean {
  return keys.some((key) => (term as Record<string, unknown>)[key] !== undefined);
}

/**
 * Validate a `NodePool` spec.
 *
 * @example
 * ```typescript
 * const errors = validateNodePoolSpec(spec).filter((issue) => issue.severity === 'error');
 * ```
 */
export function validateNodePoolSpec(spec: NodePoolSpec): KarpenterValidationIssue[] {
  const issues: KarpenterValidationIssue[] = [];
  if (isGraphValue(spec)) return issues;
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });

  const template = spec?.template?.spec;
  if (!template?.nodeClassRef) {
    error('template.spec.nodeClassRef', 'A NodePool needs a nodeClassRef naming its EC2NodeClass.');
  } else if (isConcreteString(template.nodeClassRef.name) && template.nodeClassRef.name === '') {
    error('template.spec.nodeClassRef.name', 'nodeClassRef.name must not be empty.');
  }

  const requirements = concreteArray(template?.requirements);
  if (requirements?.length === 0) {
    warn(
      'template.spec.requirements',
      'No requirements: Karpenter may launch any on-demand amd64 instance type, including very large ones. Constrain at least the capacity type and instance category or family.'
    );
  }
  requirements?.forEach((requirement, index) => {
    const path = `template.spec.requirements[${index}]`;
    const values = concreteArray(requirement.values);
    if (isConcreteString(requirement.key) && RESTRICTED_LABELS.includes(requirement.key)) {
      error(`${path}.key`, `${requirement.key} is reserved and cannot be a requirement.`);
    }
    if (requirement.operator === 'In' && values?.length === 0) {
      error(`${path}.values`, "Operator 'In' needs at least one value.");
    }
    if (['Gt', 'Lt', 'Gte', 'Lte'].includes(requirement.operator) && values) {
      const [only] = values;
      if (values.length !== 1 || !isConcreteString(only) || !INTEGER.test(only)) {
        error(
          `${path}.values`,
          `Operator '${requirement.operator}' needs exactly one non-negative integer value.`
        );
      }
    }
    if (
      typeof requirement.minValues === 'number' &&
      requirement.operator === 'In' &&
      values &&
      values.length < requirement.minValues
    ) {
      error(
        `${path}.minValues`,
        `minValues ${requirement.minValues} exceeds the ${values.length} values listed.`
      );
    }
  });

  if (spec?.limits === undefined) {
    warn(
      'limits',
      'No limits: this NodePool can scale without bound. Set limits.cpu and limits.memory.'
    );
  }

  concreteArray(spec?.disruption?.budgets)?.forEach((budget, index) => {
    if ((budget.schedule === undefined) !== (budget.duration === undefined)) {
      error(`disruption.budgets[${index}]`, 'A budget schedule and duration must be set together.');
    }
  });

  if (typeof spec?.weight === 'number' && (spec.weight < 1 || spec.weight > 100)) {
    error('weight', 'weight must be between 1 and 100.');
  }

  return issues;
}

/**
 * Validate an `EC2NodeClass` spec.
 *
 * @example
 * ```typescript
 * validateEC2NodeClassSpec({ ...spec, metadataOptions: { httpTokens: 'optional' } });
 * // [{ severity: 'warning', path: 'metadataOptions.httpTokens', ... }]
 * ```
 */
export function validateEC2NodeClassSpec(spec: EC2NodeClassSpec): KarpenterValidationIssue[] {
  const issues: KarpenterValidationIssue[] = [];
  if (isGraphValue(spec)) return issues;
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });

  if ((spec?.role === undefined) === (spec?.instanceProfile === undefined)) {
    error('role', 'Set exactly one of role or instanceProfile.');
  }

  const amiTerms = concreteArray(spec?.amiSelectorTerms);
  if (amiTerms?.length === 0) {
    error(
      'amiSelectorTerms',
      'At least one AMI selector term is required, e.g. { alias: "al2023@latest" }.'
    );
  }
  amiTerms?.forEach((term, index) => {
    const path = `amiSelectorTerms[${index}]`;
    if (!hasAny(term, ['alias', 'id', 'name', 'tags', 'ssmParameter'])) {
      error(path, 'An AMI selector term needs alias, id, name, tags or ssmParameter.');
    }
    if (
      term.alias !== undefined &&
      (hasAny(term, ['id', 'name', 'tags', 'owner']) || amiTerms.length > 1)
    ) {
      error(path, 'An alias must be the only AMI selector term and the only field in it.');
    }
  });
  if (
    amiTerms?.length &&
    !amiTerms.some((term) => term.alias !== undefined) &&
    spec.amiFamily === undefined
  ) {
    error('amiFamily', 'amiFamily is required when amiSelectorTerms do not use an alias.');
  }

  const selectors = [
    ['subnetSelectorTerms', spec?.subnetSelectorTerms, ['tags', 'id']],
    ['securityGroupSelectorTerms', spec?.securityGroupSelectorTerms, ['tags', 'id', 'name']],
  ] as const;
  for (const [field, value, keys] of selectors) {
    const terms = concreteArray<object>(value);
    if (terms?.length === 0) error(field, `At least one ${field} entry is required.`);
    terms?.forEach((term, index) => {
      if (!hasAny(term, keys))
        error(`${field}[${index}]`, `Each term needs one of: ${keys.join(', ')}.`);
    });
  }

  if (spec?.metadataOptions?.httpTokens === 'optional') {
    issues.push({
      severity: 'warning',
      path: 'metadataOptions.httpTokens',
      message: 'httpTokens "optional" allows IMDSv1. Use "required" (IMDSv2 only).',
    });
  }

  const rootVolumes = concreteArray(spec?.blockDeviceMappings)?.filter(
    (mapping) => mapping.rootVolume
  );
  if (rootVolumes && rootVolumes.length > 1) {
    error('blockDeviceMappings', 'At most one block device mapping may set rootVolume.');
  }

  return issues;
}

/**
 * Warnings for a `karpenterBootstrap` spec.
 *
 * @example
 * ```typescript
 * validateKarpenterBootstrapConfig({ name: 'karpenter', clusterName: 'demo' });
 * // [{ severity: 'warning', path: 'interruptionQueue', ... }]
 * ```
 */
export function validateKarpenterBootstrapConfig(
  config: KarpenterBootstrapConfig
): KarpenterValidationIssue[] {
  const issues: KarpenterValidationIssue[] = [];
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });

  if (config.interruptionQueue === undefined || config.interruptionQueue === '') {
    warn(
      'interruptionQueue',
      'No interruption queue: spot interruptions and scheduled maintenance will not drain nodes ahead of time.'
    );
  }
  if (typeof config.replicas === 'number' && config.replicas < 2) {
    warn('replicas', 'A single controller replica stops all provisioning while it restarts.');
  }
  if (
    config.affinity !== undefined &&
    !isGraphValue(config.affinity) &&
    !JSON.stringify(config.affinity).includes('karpenter.sh/nodepool')
  ) {
    warn(
      'affinity',
      'The affinity no longer excludes karpenter.sh/nodepool nodes, so the controller may be scheduled onto a node it manages.'
    );
  }
  if (config.resources?.requests === undefined) {
    warn(
      'resources.requests',
      'No controller resource requests. Upstream suggests at least 1 CPU and 1Gi.'
    );
  }
  return issues;
}

/** Throw on validator errors. Used by the factories. */
export function assertNoKarpenterErrors(
  kind: string,
  name: unknown,
  issues: KarpenterValidationIssue[]
): void {
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length === 0) return;
  const label = isConcreteString(name) ? ` "${name}"` : '';
  throw new TypeKroError(
    `Invalid ${kind}${label}: ${errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    'KARPENTER_INVALID_SPEC',
    { kind, issues: errors }
  );
}
