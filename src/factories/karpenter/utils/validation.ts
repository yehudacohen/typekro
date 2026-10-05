// Checks for common Karpenter configuration mistakes.
//
// Errors are things the API server or Karpenter rejects; the factories throw
// on them. Warnings are legal but usually unintended. Values that are schema
// references or CEL expressions are only known at reconcile time and are
// skipped.

import { getCurrentCompositionContext } from '../../../core/composition/context.js';
import { TypeKroError } from '../../../core/errors.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import { REQUIRED_FIELD_SENTINEL } from '../../../core/serialization/schema.js';
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
// Keys in the restricted `karpenter.sh` and `karpenter.k8s.aws` label domains
// the pinned NodePool CRD still accepts in requirements and template labels.
const ALLOWED_KARPENTER_SH_LABELS = ['karpenter.sh/capacity-type', 'karpenter.sh/nodepool'];
const ALLOWED_KARPENTER_AWS_LABELS = [
  'instance-tenancy',
  'capacity-reservation-type',
  'capacity-reservation-id',
  'capacity-reservation-interruptible',
  'ec2nodeclass',
  'instance-encryption-in-transit-supported',
  'instance-category',
  'instance-hypervisor',
  'instance-family',
  'instance-generation',
  'instance-local-nvme',
  'instance-size',
  'instance-cpu',
  'instance-cpu-manufacturer',
  'instance-cpu-sustained-clock-speed-mhz',
  'instance-memory',
  'instance-ebs-bandwidth',
  'instance-network-bandwidth',
  'instance-gpu-name',
  'instance-gpu-manufacturer',
  'instance-gpu-count',
  'instance-gpu-memory',
  'instance-accelerator-name',
  'instance-accelerator-manufacturer',
  'instance-accelerator-count',
  'instance-capability-flex',
  'placement-group-id',
  'placement-group-partition',
].map((name) => `karpenter.k8s.aws/${name}`);
// Duration patterns from the pinned NodePool CRD.
const EXPIRE_AFTER = /^(([0-9]+(s|m|h))+|Never)$/;
const CONSOLIDATE_AFTER = /^(([0-9]+(s|m|h))+|Never)$/;
const TERMINATION_GRACE_PERIOD = /^([0-9]+(s|m|h))+$/;
const BUDGET_DURATION = /^((([0-9]+(h|m))|([0-9]+h[0-9]+m))(0s)?)$/;
const BUDGET_NODES = /^((100|[0-9]{1,2})%|[0-9]+)$/;
// EC2NodeClass `spec.tags` keys the CRD reserves for EKS and Karpenter.
const RESTRICTED_TAGS = [
  'eks:eks-cluster-name',
  'karpenter.sh/nodepool',
  'karpenter.sh/nodeclaim',
  'karpenter.k8s.aws/ec2nodeclass',
];
// Karpenter puts NodePool and EC2NodeClass names in label values on every
// NodeClaim and Node (`karpenter.sh/nodepool`, `karpenter.k8s.aws/ec2nodeclass`).
const MAX_LABEL_VALUE_NAME = 63;
// What a schema proxy stringifies to inside a template literal.
const KUBERNETES_REF_MARKER_PREFIX = '__KUBERNETES_REF_';
// What the CRD's `int(x) >= 0` accepts: cel-go's int() parses like Go's
// strconv.ParseInt into an int64, so a sign is allowed ('+5', and '-0', which
// is 0) and anything above int64 max is refused.
const SIGNED_INTEGER = /^[+-]?\d+$/;
const INT64_MAX = 9223372036854775807n;
function isNonNegativeInteger(value: string): boolean {
  return SIGNED_INTEGER.test(value) && BigInt(value) >= 0n && BigInt(value) <= INT64_MAX;
}
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
// amiSelectorTerms limits from the pinned EC2NodeClass CRD.
const MAX_AMI_SELECTOR_TERMS = 30;
const MAX_AMI_SELECTOR_TAGS = 20;
const MAX_ALIAS_LENGTH = 30;
const AMI_TERM_FIELDS = ['alias', 'id', 'ssmParameter', 'name', 'tags', 'owner'] as const;
// The CRD's `pattern: ami-[0-9a-z]+` (OpenAPI patterns are unanchored).
const AMI_ID = /ami-[0-9a-z]+/;
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

/** A name a build-time check can judge (not a reference, template over one, or placeholder). */
function isConcreteName(value: unknown): value is string {
  return (
    isConcreteString(value) &&
    !value.includes(KUBERNETES_REF_MARKER_PREFIX) &&
    !value.includes(REQUIRED_FIELD_SENTINEL)
  );
}

/** Why the CRD rejects this requirement or template label key, or undefined. */
function restrictedLabelReason(key: string): string | undefined {
  if (RESTRICTED_LABELS.includes(key)) return `${key} is reserved.`;
  const domain = /^([^/]+)/.exec(key)?.[1] ?? '';
  if (domain.endsWith('karpenter.sh') && !ALLOWED_KARPENTER_SH_LABELS.includes(key)) {
    return `the label domain "karpenter.sh" is restricted (only karpenter.sh/capacity-type is allowed).`;
  }
  if (domain.endsWith('karpenter.k8s.aws') && !ALLOWED_KARPENTER_AWS_LABELS.includes(key)) {
    return `the label domain "karpenter.k8s.aws" is restricted to Karpenter's well-known labels.`;
  }
  return undefined;
}

function checkName(kind: string, name: unknown, error: (path: string, message: string) => void) {
  if (isConcreteName(name) && name.length > MAX_LABEL_VALUE_NAME) {
    error(
      'name',
      `${kind} name is ${name.length} characters; at most ${MAX_LABEL_VALUE_NAME}, because Karpenter puts it in a label value on every NodeClaim and Node.`
    );
  }
}

function checkPattern(
  path: string,
  value: unknown,
  pattern: RegExp,
  example: string,
  error: (path: string, message: string) => void
) {
  if (isConcreteString(value) && !pattern.test(value)) {
    error(path, `"${value}" is not a valid value here, e.g. ${example}.`);
  }
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
export function validateNodePoolSpec(
  spec: NodePoolSpec,
  name?: string
): KarpenterValidationIssue[] {
  const issues: KarpenterValidationIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });
  checkName('NodePool', name, error);
  if (isGraphValue(spec)) return issues;

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
    const restricted = isConcreteString(requirement.key)
      ? restrictedLabelReason(requirement.key)
      : undefined;
    if (restricted) {
      error(`${path}.key`, `${requirement.key} cannot be a requirement: ${restricted}`);
    }
    if (requirement.operator === 'In' && values?.length === 0) {
      error(`${path}.values`, "Operator 'In' needs at least one value.");
    }
    if (['Gt', 'Lt', 'Gte', 'Lte'].includes(requirement.operator) && values) {
      const [only] = values;
      if (values.length !== 1 || !isConcreteString(only) || !isNonNegativeInteger(only)) {
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

  const labels = spec?.template?.metadata?.labels;
  if (labels !== undefined && !isGraphValue(labels)) {
    for (const key of Object.keys(labels)) {
      const restricted = restrictedLabelReason(key);
      if (restricted) {
        error(
          `template.metadata.labels.${key}`,
          `${key} cannot be a template label: ${restricted}`
        );
      }
    }
  }
  checkPattern(
    'template.spec.expireAfter',
    template?.expireAfter,
    EXPIRE_AFTER,
    "'720h' or 'Never'",
    error
  );
  checkPattern(
    'template.spec.terminationGracePeriod',
    template?.terminationGracePeriod,
    TERMINATION_GRACE_PERIOD,
    "'48h'",
    error
  );

  // Static NodePools (`replicas` set; not typed, alpha) take neither weight nor
  // limits other than `nodes`.
  const replicas = (spec as { replicas?: unknown } | undefined)?.replicas;
  if (replicas !== undefined) {
    if (spec.weight !== undefined) error('weight', 'weight is not supported on static NodePools.');
    const limitKeys =
      spec.limits !== undefined && !isGraphValue(spec.limits) ? Object.keys(spec.limits) : [];
    if (limitKeys.some((key) => key !== 'nodes')) {
      error('limits', 'Only limits.nodes is supported on static NodePools.');
    }
  }

  if (replicas === undefined && spec?.limits === undefined) {
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

  if (spec?.disruption !== undefined && !isGraphValue(spec.disruption)) {
    checkPattern(
      'disruption.consolidateAfter',
      spec.disruption.consolidateAfter,
      CONSOLIDATE_AFTER,
      "'0s', '1m' or 'Never'",
      error
    );
  }
  concreteArray(spec?.disruption?.budgets)?.forEach((budget, index) => {
    if ((budget.schedule === undefined) !== (budget.duration === undefined)) {
      error(`disruption.budgets[${index}]`, 'A budget schedule and duration must be set together.');
    }
    checkPattern(
      `disruption.budgets[${index}].nodes`,
      budget.nodes,
      BUDGET_NODES,
      "'10%' or '5'",
      error
    );
    checkPattern(
      `disruption.budgets[${index}].duration`,
      budget.duration,
      BUDGET_DURATION,
      "'8h' or '1h30m'",
      error
    );
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
export function validateEC2NodeClassSpec(
  spec: EC2NodeClassSpec,
  name?: string
): KarpenterValidationIssue[] {
  const issues: KarpenterValidationIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  checkName('EC2NodeClass', name, error);
  if (isGraphValue(spec)) return issues;

  if ((spec?.role === undefined) === (spec?.instanceProfile === undefined)) {
    error('role', 'Set exactly one of role or instanceProfile.');
  }
  for (const field of ['role', 'instanceProfile'] as const) {
    if (isConcreteString(spec?.[field]) && spec[field] === '') {
      error(field, `${field} must not be empty.`);
    }
  }
  const tags = spec?.tags;
  if (tags !== undefined && !isGraphValue(tags)) {
    for (const key of Object.keys(tags)) {
      if (key === '') error('tags', 'Tag keys must not be empty.');
      else if (RESTRICTED_TAGS.includes(key) || key.startsWith('kubernetes.io/cluster')) {
        error(`tags.${key}`, `The tag ${key} is reserved for EKS and Karpenter.`);
      }
    }
  }

  // Mirrors the amiSelectorTerms rules of the pinned EC2NodeClass CRD, plus one
  // stricter rule: alias, id and ssmParameter each resolve an AMI on their own,
  // and Karpenter ignores every other field in that term (alias wins over
  // everything; id wins over ssmParameter; ssmParameter wins over name, tags and
  // owner). The CRD leaves ssmParameter out of its exclusion rules, so without
  // this check those fields would be applied and then silently dropped.
  const amiTerms = concreteArray(spec?.amiSelectorTerms);
  if (amiTerms?.length === 0) {
    error(
      'amiSelectorTerms',
      'At least one AMI selector term is required, e.g. { alias: "al2023@latest" }.'
    );
  }
  if (amiTerms && amiTerms.length > MAX_AMI_SELECTOR_TERMS) {
    error(
      'amiSelectorTerms',
      `At most ${MAX_AMI_SELECTOR_TERMS} AMI selector terms are allowed (got ${amiTerms.length}).`
    );
  }
  if (amiTerms && amiTerms.length > 1 && amiTerms.some((term) => term.alias !== undefined)) {
    error('amiSelectorTerms', 'An alias term must be the only AMI selector term.');
  }
  amiTerms?.forEach((term, index) => {
    const path = `amiSelectorTerms[${index}]`;
    if (!hasAny(term, ['alias', 'id', 'name', 'tags', 'ssmParameter'])) {
      error(path, 'An AMI selector term needs alias, id, name, tags or ssmParameter.');
    }
    // Karpenter resolves the first of these that is set and ignores the rest.
    const winner = (['alias', 'id', 'ssmParameter'] as const).find(
      (field) => term[field] !== undefined
    );
    const ignored = AMI_TERM_FIELDS.filter(
      (field) => field !== winner && term[field] !== undefined
    );
    if (winner !== undefined && ignored.length > 0) {
      error(
        path,
        `${winner} must be the only field in its AMI selector term; Karpenter would ignore ${ignored.join(', ')}.`
      );
    }
    if (isConcreteString(term.id) && !AMI_ID.test(term.id)) {
      error(`${path}.id`, `AMI id "${term.id}" must look like ami-0123456789abcdef0.`);
    }
    if (term.tags !== undefined && !isGraphValue(term.tags)) {
      const entries = Object.entries(term.tags);
      if (entries.length > MAX_AMI_SELECTOR_TAGS) {
        error(`${path}.tags`, `At most ${MAX_AMI_SELECTOR_TAGS} tags are allowed in one term.`);
      }
      if (entries.some(([key, value]) => key === '' || (isConcreteString(value) && value === ''))) {
        error(`${path}.tags`, 'Tag keys and values must not be empty.');
      }
    }
    if (isConcreteString(term.alias) && term.alias.length > MAX_ALIAS_LENGTH) {
      error(`${path}.alias`, `An alias must be at most ${MAX_ALIAS_LENGTH} characters.`);
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

  // `precedence`: the provider resolves the first of these that is set and
  // ignores the rest of the term (subnet.go / securitygroup.go getFilterSets).
  const selectors = [
    {
      field: 'subnetSelectorTerms',
      value: spec?.subnetSelectorTerms,
      keys: ['tags', 'id'],
      precedence: ['id'],
      idPattern: /subnet-[0-9a-z]+/,
      example: 'subnet-0123456789abcdef0',
    },
    {
      field: 'securityGroupSelectorTerms',
      value: spec?.securityGroupSelectorTerms,
      keys: ['tags', 'id', 'name'],
      precedence: ['id', 'name'],
      idPattern: /sg-[0-9a-z]+/,
      example: 'sg-0123456789abcdef0',
    },
  ] as const;
  for (const { field, value, keys, precedence, idPattern, example } of selectors) {
    const terms = concreteArray<object>(value) as readonly Record<string, unknown>[] | undefined;
    if (terms?.length === 0) error(field, `At least one ${field} entry is required.`);
    terms?.forEach((term, index) => {
      const path = `${field}[${index}]`;
      if (!hasAny(term, keys)) error(path, `Each term needs one of: ${keys.join(', ')}.`);
      const winner = precedence.find((key) => term[key] !== undefined);
      const ignored = keys.filter((key) => key !== winner && term[key] !== undefined);
      if (winner !== undefined && ignored.length > 0) {
        error(
          path,
          `${winner} must be the only field in its term; Karpenter would ignore ${ignored.join(', ')}.`
        );
      }
      checkPattern(`${path}.id`, term.id, idPattern, example, error);
      const termTags = term.tags;
      if (
        termTags !== undefined &&
        !isGraphValue(termTags) &&
        Object.entries(termTags as Record<string, unknown>).some(
          ([key, tag]) => key === '' || (isConcreteString(tag) && tag === '')
        )
      ) {
        error(`${path}.tags`, 'Tag keys and values must not be empty.');
      }
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
