import { TypeKroError } from '../errors.js';

import { decodeDirectArtifactResource } from './artifact-codec.js';
import {
  DIRECT_ARTIFACT_EXECUTION_RECORD_VERSION,
  type DirectArtifactExecutionRecord,
  type DirectKubernetesArtifactPlan,
  type DirectKubernetesArtifactResource,
} from './artifacts.js';
import { canonicalDigest, canonicalStringify } from './canonical.js';
import { materializePlanValue, type PlanMaterializationBindings } from './materialization.js';
import type { LifecyclePolicy, PlanValue, ReadinessStrategyIdentity } from './types.js';
import { lowerPlanValue } from './values.js';

type UnknownRecord = Record<string, unknown>;

export interface DirectArtifactExecutionMaterialization {
  readonly record: DirectArtifactExecutionRecord;
  /** Ephemeral values keyed by the binding identities stored in record. */
  readonly sensitiveBindings: Readonly<Record<string, unknown>>;
}

export class DirectArtifactExecutionRecordError extends TypeKroError {
  constructor(message: string, path = '$', details: Record<string, unknown> = {}) {
    super(message, 'DIRECT_ARTIFACT_EXECUTION_RECORD_INVALID', { path, ...details });
    this.name = 'DirectArtifactExecutionRecordError';
  }
}

function concretePlanValue(
  value: PlanValue,
  bindings: PlanMaterializationBindings,
  path: string,
  sensitiveBindings: Record<string, unknown>
): PlanValue {
  if (value.kind === 'array') {
    return {
      ...value,
      items: value.items.map((item, index) =>
        concretePlanValue(item, bindings, `${path}[${index}]`, sensitiveBindings)
      ),
    };
  }
  if (value.kind === 'object') {
    return {
      ...value,
      entries: value.entries.map((entry) => ({
        ...entry,
        value: concretePlanValue(
          entry.value,
          bindings,
          `${path}.${entry.key}`,
          sensitiveBindings
        ),
      })),
    };
  }
  // Durable execution records preserve tainted symbolic structure. Resolving
  // this wrapper here would place secret bytes in Alchemy state and in the
  // execution digest. The host must supply the value through an explicit
  // sensitive/spec binding when the operation is materialized.
  if (value.kind === 'sensitive-value') {
    return {
      kind: 'sensitive-value',
      value: concreteSensitiveSource(
        value.value,
        bindings,
        `${path}.value`,
        sensitiveBindings
      ),
    };
  }
  if (value.kind === 'sensitive-binding') {
    if (Object.hasOwn(bindings.sensitive ?? {}, value.binding)) {
      sensitiveBindings[value.binding] = bindings.sensitive?.[value.binding];
    }
    return value;
  }
  const materialized = materializePlanValue(value, bindings, path);
  const lowered = lowerPlanValue(materialized);
  const errors = lowered.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new DirectArtifactExecutionRecordError(
      `Materialized artifact value could not be lowered canonically.`,
      path,
      { diagnostics: errors }
    );
  }
  return lowered.value;
}

function concreteSensitiveSource(
  value: PlanValue,
  bindings: PlanMaterializationBindings,
  path: string,
  sensitiveBindings: Record<string, unknown>
): PlanValue {
  switch (value.kind) {
    case 'array':
      return {
        ...value,
        items: value.items.map((item, index) =>
          concreteSensitiveSource(item, bindings, `${path}[${index}]`, sensitiveBindings)
        ),
      };
    case 'object':
      return {
        ...value,
        entries: value.entries.map((entry) => ({
          ...entry,
          value: concreteSensitiveSource(
            entry.value,
            bindings,
            `${path}.${entry.key}`,
            sensitiveBindings
          ),
        })),
      };
    case 'sensitive-value':
      return {
        ...value,
        value: concreteSensitiveSource(
          value.value,
          bindings,
          `${path}.value`,
          sensitiveBindings
        ),
      };
    case 'reference':
      if (value.source === 'resource' || bindings.spec === undefined) return value;
      break;
    case 'expression':
      if (
        value.expression.references.some((reference) => reference.source === 'resource') ||
        (value.expression.references.length > 0 && bindings.spec === undefined)
      ) {
        return value;
      }
      break;
    case 'template':
      if (
        value.segments.some(
          (segment) =>
            (segment.kind === 'reference' && segment.source === 'resource') ||
            (segment.kind === 'expression' &&
              segment.expression.references.some((reference) => reference.source === 'resource'))
        ) ||
        (value.segments.some(
          (segment) =>
            (segment.kind === 'reference' && segment.source === 'spec') ||
            (segment.kind === 'expression' &&
              segment.expression.references.some((reference) => reference.source === 'spec'))
        ) &&
          bindings.spec === undefined)
      ) {
        return value;
      }
      break;
    case 'sensitive-binding':
      if (!Object.hasOwn(bindings.sensitive ?? {}, value.binding)) return value;
      sensitiveBindings[value.binding] = bindings.sensitive?.[value.binding];
      return value;
    case 'external-input':
      if (!Object.hasOwn(bindings.externalInputs ?? {}, value.name)) return value;
      break;
    case 'artifact-output':
      if (!Object.hasOwn(bindings.artifactOutputs?.[value.requirementId] ?? {}, value.output)) {
        return value;
      }
      break;
    case 'omitted':
      return value;
    case 'literal':
      throw new DirectArtifactExecutionRecordError(
        'Sensitive source unexpectedly contained a plaintext literal.',
        path
      );
  }

  const binding = `artifact/${encodeURIComponent(path)}`;
  sensitiveBindings[binding] = materializePlanValue(value, bindings, path);
  return { kind: 'sensitive-binding', binding };
}

function concreteLifecycle(
  lifecycle: LifecyclePolicy,
  bindings: PlanMaterializationBindings,
  path: string,
  sensitiveBindings: Record<string, unknown>
): LifecyclePolicy {
  return {
    ...lifecycle,
    instancing:
      lifecycle.instancing.kind === 'per-scope'
        ? {
            kind: 'per-scope',
            key: concretePlanValue(
              lifecycle.instancing.key,
              bindings,
              `${path}.instancing.key`,
              sensitiveBindings
            ),
          }
        : lifecycle.instancing,
    ...(lifecycle.unusedEvidence
      ? {
          unusedEvidence: {
            ...lifecycle.unusedEvidence,
            inputs: concretePlanValue(
              lifecycle.unusedEvidence.inputs,
              bindings,
              `${path}.unusedEvidence.inputs`,
              sensitiveBindings
            ),
          },
        }
      : {}),
  };
}

function concreteReadinessStrategy(
  strategy: ReadinessStrategyIdentity | undefined,
  bindings: PlanMaterializationBindings,
  path: string,
  sensitiveBindings: Record<string, unknown>
): ReadinessStrategyIdentity | undefined {
  if (!strategy || strategy.kind === 'runtime-binding' || !strategy.configuration) {
    return strategy;
  }
  return {
    ...strategy,
    configuration: concretePlanValue(
      strategy.configuration,
      bindings,
      `${path}.configuration`,
      sensitiveBindings
    ),
  };
}

function concreteArtifact(
  artifact: DirectKubernetesArtifactResource,
  bindings: PlanMaterializationBindings,
  sensitiveBindings: Record<string, unknown>
): DirectKubernetesArtifactResource {
  const path = `$.artifact`;
  const readinessStrategy = concreteReadinessStrategy(
    artifact.readiness.strategy,
    bindings,
    `${path}.readiness.strategy`,
    sensitiveBindings
  );
  return {
    ...artifact,
    ...(artifact.identity
      ? {
          identity: {
            ...artifact.identity,
            name: concretePlanValue(
              artifact.identity.name,
              bindings,
              `${path}.identity.name`,
              sensitiveBindings
            ),
            ...(artifact.identity.namespace
              ? {
                  namespace: concretePlanValue(
                    artifact.identity.namespace,
                    bindings,
                    `${path}.identity.namespace`,
                    sensitiveBindings
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(artifact.desired
      ? {
          desired: concretePlanValue(
            artifact.desired,
            bindings,
            `${path}.desired`,
            sensitiveBindings
          ),
        }
      : {}),
    lifecycle: concreteLifecycle(
      artifact.lifecycle,
      bindings,
      `${path}.lifecycle`,
      sensitiveBindings
    ),
    readiness: {
      activation: artifact.readiness.activation.map((value, index) =>
        concretePlanValue(
          value,
          bindings,
          `${path}.readiness.activation[${index}]`,
          sensitiveBindings
        )
      ),
      readyWhen: artifact.readiness.readyWhen.map((value, index) =>
        concretePlanValue(
          value,
          bindings,
          `${path}.readiness.readyWhen[${index}]`,
          sensitiveBindings
        )
      ),
      ...(readinessStrategy ? { strategy: readinessStrategy } : {}),
    },
    ...(artifact.iteration
      ? {
          iteration: artifact.iteration.map((dimension, index) => ({
            ...dimension,
            collection: concretePlanValue(
              dimension.collection,
              bindings,
              `${path}.iteration[${index}].collection`,
              sensitiveBindings
            ),
          })),
        }
      : {}),
    ...(artifact.templateOverrides
      ? {
          templateOverrides: artifact.templateOverrides.map((override, index) => ({
            ...override,
            value: concretePlanValue(
              override.value,
              bindings,
              `${path}.templateOverrides[${index}].value`,
              sensitiveBindings
            ),
          })),
        }
      : {}),
  };
}

function incomingDependencies(
  plan: DirectKubernetesArtifactPlan,
  artifactId: string
): readonly string[] {
  const emittedArtifactIds = new Set(
    plan.resources
      .filter((artifact) => artifact.role === 'application-resource')
      .map((artifact) => artifact.id)
  );
  const dependencies = new Set<string>();
  for (const edge of plan.edges) {
    if (edge.kind === 'output' && edge.consumer === artifactId) dependencies.add(edge.producer);
    if ((edge.kind === 'existence' || edge.kind === 'ready') && edge.dependent === artifactId) {
      dependencies.add(edge.prerequisite);
    }
    if (edge.kind === 'ownership' && edge.child === artifactId) dependencies.add(edge.owner);
  }
  dependencies.delete(artifactId);
  return [...dependencies].filter((dependency) => emittedArtifactIds.has(dependency)).sort();
}

function executionDigest(record: Omit<DirectArtifactExecutionRecord, 'executionDigest'>): string {
  return canonicalDigest(record);
}

/** Select and concretize one direct operation for a fan-out execution host. */
export function createDirectArtifactExecutionRecord(
  plan: DirectKubernetesArtifactPlan,
  artifactId: string,
  bindings: PlanMaterializationBindings = {}
): DirectArtifactExecutionRecord {
  return createDirectArtifactExecutionMaterialization(plan, artifactId, bindings).record;
}

/**
 * Build a durable execution record plus its deliberately non-serialized secret envelope.
 * Host adapters must map the envelope to their native sensitive-input mechanism.
 */
export function createDirectArtifactExecutionMaterialization(
  plan: DirectKubernetesArtifactPlan,
  artifactId: string,
  bindings: PlanMaterializationBindings = {}
): DirectArtifactExecutionMaterialization {
  const artifact = plan.resources.find((candidate) => candidate.id === artifactId);
  if (!artifact) {
    throw new DirectArtifactExecutionRecordError(
      `Direct artifact ${artifactId} does not exist in the compiled plan.`,
      '$.artifactId',
      { artifactId }
    );
  }
  const sensitiveBindings: Record<string, unknown> = {};
  const unsigned = {
    version: DIRECT_ARTIFACT_EXECUTION_RECORD_VERSION,
    target: 'direct' as const,
    planIdentityDigest: plan.planIdentityDigest,
    compiledArtifactDigest: plan.compiledArtifactDigest,
    artifact: concreteArtifact(artifact, bindings, sensitiveBindings),
    dependencies: incomingDependencies(plan, artifactId),
  };
  return {
    record: { ...unsigned, executionDigest: executionDigest(unsigned) },
    sensitiveBindings,
  };
}

export function encodeDirectArtifactExecutionRecord(record: DirectArtifactExecutionRecord): string {
  return canonicalStringify(record);
}

export function decodeDirectArtifactExecutionRecord(
  encoded: string
): DirectArtifactExecutionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error: unknown) {
    throw new DirectArtifactExecutionRecordError(
      `Direct artifact execution record is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DirectArtifactExecutionRecordError(`Expected an execution-record object.`);
  }
  const record = parsed as UnknownRecord;
  if (record.version !== DIRECT_ARTIFACT_EXECUTION_RECORD_VERSION || record.target !== 'direct') {
    throw new DirectArtifactExecutionRecordError(
      `Unsupported direct artifact execution-record identity.`
    );
  }
  for (const key of ['planIdentityDigest', 'compiledArtifactDigest', 'executionDigest'] as const) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      throw new DirectArtifactExecutionRecordError(`Expected a non-empty ${key}.`, `$.${key}`);
    }
  }
  const artifact = decodeDirectArtifactResource(canonicalStringify(record.artifact));
  if (!Array.isArray(record.dependencies)) {
    throw new DirectArtifactExecutionRecordError(`Expected a dependency array.`, '$.dependencies');
  }
  const dependencies = record.dependencies.map((dependency, index) => {
    if (typeof dependency !== 'string' || dependency.length === 0) {
      throw new DirectArtifactExecutionRecordError(
        `Expected a non-empty dependency id.`,
        `$.dependencies[${index}]`
      );
    }
    return dependency;
  });
  if (
    new Set(dependencies).size !== dependencies.length ||
    dependencies.some((dependency) => dependency === artifact.id)
  ) {
    throw new DirectArtifactExecutionRecordError(
      `Dependencies must be unique and must not contain the selected artifact.`,
      '$.dependencies'
    );
  }
  const decoded = {
    version: DIRECT_ARTIFACT_EXECUTION_RECORD_VERSION,
    target: 'direct' as const,
    planIdentityDigest: record.planIdentityDigest as string,
    compiledArtifactDigest: record.compiledArtifactDigest as string,
    artifact,
    dependencies,
    executionDigest: record.executionDigest as string,
  };
  const expected = executionDigest({
    version: decoded.version,
    target: decoded.target,
    planIdentityDigest: decoded.planIdentityDigest,
    compiledArtifactDigest: decoded.compiledArtifactDigest,
    artifact: decoded.artifact,
    dependencies: decoded.dependencies,
  });
  if (expected !== decoded.executionDigest) {
    throw new DirectArtifactExecutionRecordError(
      `Execution-record digest does not match its canonical content.`,
      '$.executionDigest'
    );
  }
  return decoded;
}
