// Checks for common Karpenter configuration mistakes.
//
// Errors are things the API server or Karpenter rejects; the factories throw
// on them. Warnings are legal but usually unintended. Values that are schema
// references or CEL expressions are only known at reconcile time and are
// skipped.

import { getCurrentCompositionContext } from '../../../core/composition/context.js';
import { TypeKroError } from '../../../core/errors.js';
import { getComponentLogger } from '../../../core/logging/index.js';
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
const VALUED_OPERATORS = ['In', 'Gt', 'Lt', 'Gte', 'Lte'];
// Alias family -> the amiFamily values the CRD accepts alongside it.
const ALIAS_FAMILIES: Record<string, string> = {
  al2: 'AL2',
  al2023: 'AL2023',
  bottlerocket: 'Bottlerocket',
  windows2019: 'Windows2019',
  windows2022: 'Windows2022',
  windows2025: 'Windows2025',
};
const logger = getComponentLogger('karpenter-validation');

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
    if (VALUED_OPERATORS.includes(requirement.operator) && requirement.values === undefined) {
      error(`${path}.values`, `Operator '${requirement.operator}' needs values.`);
    }
    if (
      typeof requirement.minValues === 'number' &&
      (requirement.minValues < 1 || requirement.minValues > 50)
    ) {
      error(`${path}.minValues`, 'minValues must be between 1 and 50.');
    }
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

  if (
    spec?.disruption !== undefined &&
    !isGraphValue(spec.disruption) &&
    spec.disruption.consolidateAfter === undefined
  ) {
    error(
      'disruption.consolidateAfter',
      "consolidateAfter is required when disruption is set (e.g. '0s' or '1m')."
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
    if (isConcreteString(term.alias)) {
      const [family = '', version] = term.alias.split('@');
      const amiFamily = ALIAS_FAMILIES[family];
      if (!/^[a-zA-Z0-9]+@.+$/.test(term.alias) || amiFamily === undefined) {
        error(
          `${path}.alias`,
          `Alias must be <family>@<version> with family one of ${Object.keys(ALIAS_FAMILIES).join(', ')}.`
        );
      } else if (family.startsWith('windows') && version !== 'latest') {
        error(`${path}.alias`, 'Windows aliases only support @latest.');
      } else if (
        isConcreteString(spec.amiFamily) &&
        spec.amiFamily !== 'Custom' &&
        spec.amiFamily !== amiFamily
      ) {
        error('amiFamily', `amiFamily must be ${amiFamily} or Custom with alias ${term.alias}.`);
      }
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

  const mappings = concreteArray(spec?.blockDeviceMappings);
  mappings?.forEach((mapping, index) => {
    if (
      mapping.ebs &&
      mapping.ebs.volumeSize === undefined &&
      mapping.ebs.snapshotID === undefined
    ) {
      error(`blockDeviceMappings[${index}].ebs`, 'An EBS mapping needs volumeSize or snapshotID.');
    }
  });
  const rootVolumes = mappings?.filter((mapping) => mapping.rootVolume);
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
  if (
    config.resources !== undefined &&
    !isGraphValue(config.resources) &&
    config.resources.requests === undefined
  ) {
    warn(
      'resources.requests',
      'No controller resource requests: a BestEffort controller is starved first and cannot reschedule onto the nodes it launches.'
    );
  }
  return issues;
}

/** Log validator warnings, once per real composition run. Used by the factories. */
export function warnKarpenterIssues(source: string, issues: KarpenterValidationIssue[]): void {
  if (getCurrentCompositionContext()?.suppressResourceDiagnostics) return;
  for (const issue of issues) {
    if (issue.severity === 'warning') logger.warn(`${source}: ${issue.path}: ${issue.message}`);
  }
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
