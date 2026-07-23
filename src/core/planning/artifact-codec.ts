import { TypeKroError } from '../errors.js';

import {
  ARTIFACT_PLAN_VERSION,
  type ArtifactApplyPolicy,
  type ArtifactPlan,
  type DirectKubernetesArtifactResource,
  type DirectKubernetesArtifactPlan,
  type KroArtifactPlan,
} from './artifacts.js';
import { canonicalDigest, canonicalStringify } from './canonical.js';
import { decodePlanValue } from './values.js';

type UnknownRecord = Record<string, unknown>;

export class ArtifactPlanDecodeError extends TypeKroError {
  constructor(message: string, path: string) {
    super(message, 'ARTIFACT_PLAN_DECODE_FAILED', { path });
    this.name = 'ArtifactPlanDecodeError';
  }
}

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArtifactPlanDecodeError(`Expected an object at ${path}.`, path);
  }
  return value as UnknownRecord;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ArtifactPlanDecodeError(`Expected a non-empty string at ${path}.`, path);
  }
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ArtifactPlanDecodeError(`Expected an array at ${path}.`, path);
  }
  return value;
}

function planValue(value: unknown, path: string): void {
  try {
    decodePlanValue(JSON.stringify(value));
  } catch (error: unknown) {
    throw new ArtifactPlanDecodeError(
      `Invalid PlanValue at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path
    );
  }
}

function applyPolicy(value: unknown, path: string): asserts value is ArtifactApplyPolicy {
  const policy = record(value, path);
  const strategy = nonEmptyString(policy.strategy, `${path}.strategy`);
  if (strategy === 'create-or-patch') {
    if (!['warn', 'fail', 'patch', 'replace'].includes(String(policy.existingResource))) {
      throw new ArtifactPlanDecodeError(`Invalid existing-resource policy at ${path}.`, path);
    }
    if (!['fail', 'recreate'].includes(String(policy.immutableFieldPolicy))) {
      throw new ArtifactPlanDecodeError(`Invalid immutable-field policy at ${path}.`, path);
    }
    return;
  }
  if (strategy === 'server-side-apply') {
    nonEmptyString(policy.fieldManager, `${path}.fieldManager`);
    if (!['fail', 'force-owned-fields'].includes(String(policy.fieldConflictPolicy))) {
      throw new ArtifactPlanDecodeError(`Invalid field-conflict policy at ${path}.`, path);
    }
    if (!['fail', 'recreate'].includes(String(policy.immutableFieldPolicy))) {
      throw new ArtifactPlanDecodeError(`Invalid immutable-field policy at ${path}.`, path);
    }
    return;
  }
  if (strategy !== 'create-only' && strategy !== 'replace') {
    throw new ArtifactPlanDecodeError(`Unknown apply strategy ${strategy} at ${path}.`, path);
  }
}

function identity(value: unknown, path: string): void {
  const item = record(value, path);
  nonEmptyString(item.apiVersion, `${path}.apiVersion`);
  nonEmptyString(item.kind, `${path}.kind`);
  planValue(item.name, `${path}.name`);
  if (item.namespace !== undefined) planValue(item.namespace, `${path}.namespace`);
  if (item.scope !== 'cluster' && item.scope !== 'namespaced') {
    throw new ArtifactPlanDecodeError(
      `Invalid Kubernetes scope at ${path}.scope.`,
      `${path}.scope`
    );
  }
}

function lifecycle(value: unknown, path: string): void {
  const item = record(value, path);
  if (!['create', 'adopt', 'require-existing'].includes(String(item.creation))) {
    throw new ArtifactPlanDecodeError(`Invalid creation policy at ${path}.creation.`, path);
  }
  if (!['authoritative', 'cooperative', 'reference-only'].includes(String(item.management))) {
    throw new ArtifactPlanDecodeError(`Invalid management policy at ${path}.management.`, path);
  }
  if (!['delete', 'retain', 'delete-when-unused'].includes(String(item.deletion))) {
    throw new ArtifactPlanDecodeError(`Invalid deletion policy at ${path}.deletion.`, path);
  }
  if (!['exclusive', 'shareable'].includes(String(item.sharing))) {
    throw new ArtifactPlanDecodeError(`Invalid sharing policy at ${path}.sharing.`, path);
  }
  const instancing = record(item.instancing, `${path}.instancing`);
  if (!['per-instance', 'per-scope', 'per-cluster'].includes(String(instancing.kind))) {
    throw new ArtifactPlanDecodeError(`Invalid instancing policy at ${path}.instancing.`, path);
  }
  if (instancing.kind === 'per-scope') planValue(instancing.key, `${path}.instancing.key`);
  if (item.unusedEvidence !== undefined) {
    const evidence = record(item.unusedEvidence, `${path}.unusedEvidence`);
    nonEmptyString(evidence.provider, `${path}.unusedEvidence.provider`);
    if (typeof evidence.version !== 'number') {
      throw new ArtifactPlanDecodeError(`Invalid unused-evidence version at ${path}.`, path);
    }
    planValue(evidence.inputs, `${path}.unusedEvidence.inputs`);
  }
}

function artifactBase(value: unknown, path: string): UnknownRecord {
  const item = record(value, path);
  nonEmptyString(item.id, `${path}.id`);
  nonEmptyString(item.role, `${path}.role`);
  if (item.sourceNodeId !== undefined) nonEmptyString(item.sourceNodeId, `${path}.sourceNodeId`);
  if (item.identity !== undefined) identity(item.identity, `${path}.identity`);
  if (item.desired !== undefined) planValue(item.desired, `${path}.desired`);
  lifecycle(item.lifecycle, `${path}.lifecycle`);
  const readiness = record(item.readiness, `${path}.readiness`);
  array(readiness.activation, `${path}.readiness.activation`).forEach((entry, index) =>
    planValue(entry, `${path}.readiness.activation[${index}]`)
  );
  array(readiness.readyWhen, `${path}.readiness.readyWhen`).forEach((entry, index) =>
    planValue(entry, `${path}.readiness.readyWhen[${index}]`)
  );
  if (readiness.strategy !== undefined) {
    const strategy = record(readiness.strategy, `${path}.readiness.strategy`);
    if (strategy.kind === 'registered') {
      nonEmptyString(strategy.id, `${path}.readiness.strategy.id`);
      nonEmptyString(strategy.revision, `${path}.readiness.strategy.revision`);
      if (strategy.configuration !== undefined) {
        planValue(strategy.configuration, `${path}.readiness.strategy.configuration`);
      }
    } else if (strategy.kind === 'runtime-binding') {
      nonEmptyString(strategy.binding, `${path}.readiness.strategy.binding`);
      if (strategy.version !== 1) {
        throw new ArtifactPlanDecodeError(
          `Unsupported runtime readiness binding version.`,
          `${path}.readiness.strategy.version`
        );
      }
      if (strategy.classification !== undefined) {
        const classification = record(
          strategy.classification,
          `${path}.readiness.strategy.classification`
        );
        if (
          ![
            'ambient-clock',
            'ambient-state',
            'host-callback',
            'opaque-code',
            'unclassified-evaluator',
          ].includes(String(classification.reason))
        ) {
          throw new ArtifactPlanDecodeError(
            `Invalid runtime readiness classification.`,
            `${path}.readiness.strategy.classification.reason`
          );
        }
        if (
          classification.description !== undefined &&
          typeof classification.description !== 'string'
        ) {
          throw new ArtifactPlanDecodeError(
            `Runtime readiness classification description must be a string.`,
            `${path}.readiness.strategy.classification.description`
          );
        }
      }
    } else {
      throw new ArtifactPlanDecodeError(
        `Unknown readiness strategy.`,
        `${path}.readiness.strategy.kind`
      );
    }
  }
  if (item.iteration !== undefined) {
    array(item.iteration, `${path}.iteration`).forEach((entry, index) => {
      const dimensionPath = `${path}.iteration[${index}]`;
      const dimension = record(entry, dimensionPath);
      nonEmptyString(dimension.variable, `${dimensionPath}.variable`);
      planValue(dimension.collection, `${dimensionPath}.collection`);
      const itemPath = nonEmptyString(dimension.itemPath, `${dimensionPath}.itemPath`);
      if (!itemPath.split('.').includes('$item')) {
        throw new ArtifactPlanDecodeError(
          `Iteration itemPath must contain a $item segment.`,
          `${dimensionPath}.itemPath`
        );
      }
    });
  }
  if (item.templateOverrides !== undefined) {
    array(item.templateOverrides, `${path}.templateOverrides`).forEach((entry, index) => {
      const override = record(entry, `${path}.templateOverrides[${index}]`);
      nonEmptyString(override.propertyPath, `${path}.templateOverrides[${index}].propertyPath`);
      planValue(override.value, `${path}.templateOverrides[${index}].value`);
    });
  }
  array(item.requiredCapabilities, `${path}.requiredCapabilities`);
  return item;
}

function directResource(value: unknown, path: string): void {
  const item = artifactBase(value, path);
  if (item.role === 'external-reference' || item.role === 'compatibility-closure') {
    if (item.apply !== undefined) {
      throw new ArtifactPlanDecodeError(
        `${item.role} must not carry an apply policy.`,
        `${path}.apply`
      );
    }
    return;
  }
  if (
    item.role !== 'application-resource' &&
    item.role !== 'singleton-owner' &&
    item.role !== 'direct-prerequisite'
  ) {
    throw new ArtifactPlanDecodeError(
      `Unknown direct artifact role ${String(item.role)}.`,
      `${path}.role`
    );
  }
  applyPolicy(item.apply, `${path}.apply`);
}

function kroResource(value: unknown, path: string): void {
  const item = artifactBase(value, path);
  if (item.role === 'kro-graph-child' || item.role === 'kro-external-reference') {
    if (item.apply !== undefined) {
      throw new ArtifactPlanDecodeError(
        `${item.role} is KRO-owned and must not carry a TypeKro apply policy.`,
        `${path}.apply`
      );
    }
    return;
  }
  if (
    item.role !== 'kro-prerequisite' &&
    item.role !== 'hoisted-namespace' &&
    item.role !== 'singleton-owner' &&
    item.role !== 'resource-graph-definition' &&
    item.role !== 'instance'
  ) {
    throw new ArtifactPlanDecodeError(
      `Unknown KRO artifact role ${String(item.role)}.`,
      `${path}.role`
    );
  }
  applyPolicy(item.apply, `${path}.apply`);
  if (item.role === 'instance' && item.desired === undefined) {
    throw new ArtifactPlanDecodeError(
      'KRO instance artifact requires desired state.',
      `${path}.desired`
    );
  }
  if (item.role === 'resource-graph-definition') {
    const graph = record(item.graph, `${path}.graph`);
    if (graph.version !== 1) {
      throw new ArtifactPlanDecodeError(
        'Unsupported KRO graph IR version.',
        `${path}.graph.version`
      );
    }
    nonEmptyString(graph.name, `${path}.graph.name`);
    const root = record(graph.root, `${path}.graph.root`);
    nonEmptyString(root.apiVersion, `${path}.graph.root.apiVersion`);
    nonEmptyString(root.kind, `${path}.graph.root.kind`);
    record(root.specSchema, `${path}.graph.root.specSchema`);
    record(root.persistedStatusSchema, `${path}.graph.root.persistedStatusSchema`);
    array(graph.children, `${path}.graph.children`).forEach((entry, index) =>
      kroResource(entry, `${path}.graph.children[${index}]`)
    );
    array(graph.edges, `${path}.graph.edges`);
    array(graph.statusProjections, `${path}.graph.statusProjections`);
  }
}

function compiledDigest(plan: UnknownRecord): string {
  return canonicalDigest({
    version: plan.version,
    target: plan.target,
    compiler: plan.compiler,
    planIdentityDigest: plan.planIdentityDigest,
    resources: plan.resources,
    edges: plan.edges,
  });
}

function decode(encoded: string, expectedTarget?: 'direct' | 'kro'): ArtifactPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error: unknown) {
    throw new ArtifactPlanDecodeError(
      `Artifact plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      '$'
    );
  }
  const plan = record(parsed, '$');
  if (plan.version !== ARTIFACT_PLAN_VERSION) {
    throw new ArtifactPlanDecodeError(
      `Unsupported artifact plan version ${String(plan.version)}.`,
      '$.version'
    );
  }
  if (plan.target !== 'direct' && plan.target !== 'kro') {
    throw new ArtifactPlanDecodeError(
      `Unknown artifact target ${String(plan.target)}.`,
      '$.target'
    );
  }
  if (expectedTarget && plan.target !== expectedTarget) {
    throw new ArtifactPlanDecodeError(
      `Expected ${expectedTarget} plan, received ${plan.target}.`,
      '$.target'
    );
  }
  const compiler = record(plan.compiler, '$.compiler');
  const expectedCompiler = plan.target === 'direct' ? 'typekro.direct' : 'typekro.kro';
  if (compiler.id !== expectedCompiler || compiler.version !== 1) {
    throw new ArtifactPlanDecodeError('Artifact compiler identity is unsupported.', '$.compiler');
  }
  nonEmptyString(plan.planIdentityDigest, '$.planIdentityDigest');
  const expectedCompiledDigest = nonEmptyString(
    plan.compiledArtifactDigest,
    '$.compiledArtifactDigest'
  );
  array(plan.resources, '$.resources').forEach((entry, index) => {
    if (plan.target === 'direct') directResource(entry, `$.resources[${index}]`);
    else kroResource(entry, `$.resources[${index}]`);
  });
  array(plan.edges, '$.edges');
  array(plan.requiredCapabilities, '$.requiredCapabilities');
  array(plan.diagnostics, '$.diagnostics');
  if (compiledDigest(plan) !== expectedCompiledDigest) {
    throw new ArtifactPlanDecodeError(
      'Artifact plan digest does not match its canonical compiled content.',
      '$.compiledArtifactDigest'
    );
  }
  return plan as unknown as ArtifactPlan;
}

export function encodeArtifactPlan(plan: ArtifactPlan): string {
  return canonicalStringify(plan);
}

export function decodeArtifactPlan(encoded: string): ArtifactPlan {
  return decode(encoded);
}

export function decodeDirectArtifactPlan(encoded: string): DirectKubernetesArtifactPlan {
  return decode(encoded, 'direct') as DirectKubernetesArtifactPlan;
}

/** Decode and validate one canonical direct artifact operation. */
export function decodeDirectArtifactResource(encoded: string): DirectKubernetesArtifactResource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error: unknown) {
    throw new ArtifactPlanDecodeError(
      `Direct artifact resource is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      '$'
    );
  }
  directResource(parsed, '$');
  return parsed as DirectKubernetesArtifactResource;
}

/** Decode and validate one canonical KRO artifact operation. */
export function decodeKroArtifactResource(encoded: string): KroArtifactPlan['resources'][number] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error: unknown) {
    throw new ArtifactPlanDecodeError(
      `KRO artifact resource is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      '$'
    );
  }
  kroResource(parsed, '$');
  return parsed as KroArtifactPlan['resources'][number];
}

export function decodeKroArtifactPlan(encoded: string): KroArtifactPlan {
  return decode(encoded, 'kro') as KroArtifactPlan;
}
