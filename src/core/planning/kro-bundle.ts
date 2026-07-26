import { TypeKroError } from '../errors.js';
import type { KubernetesResource } from '../types/kubernetes.js';

import { decodeKroArtifactResource } from './artifact-codec.js';
import {
  KRO_ARTIFACT_BUNDLE_VERSION,
  type KroArtifactBundle,
  type KroArtifactBundleOperation,
  type KroArtifactBundleOperationRole,
  type KroExecutableArtifact,
} from './artifacts.js';
import { canonicalDigest, canonicalStringify } from './canonical.js';
import { materializePlanValue, type PlanMaterializationBindings } from './materialization.js';
import type { ArtifactRequirement, CapabilityRequirement } from './types.js';
import { decodePlanValue } from './values.js';

type UnknownRecord = Record<string, unknown>;

export class KroArtifactBundleError extends TypeKroError {
  constructor(message: string, path = '$', details: Record<string, unknown> = {}) {
    super(message, 'KRO_ARTIFACT_BUNDLE_INVALID', { path, ...details });
    this.name = 'KroArtifactBundleError';
  }
}

function expectedArtifactRole(role: KroArtifactBundleOperationRole): string {
  switch (role) {
    case 'kro-prerequisite':
      return 'kro-prerequisite';
    case 'hoisted-namespace':
      return 'hoisted-namespace';
    case 'singleton-owner-rgd':
    case 'resource-graph-definition':
      return 'resource-graph-definition';
    case 'singleton-owner-instance':
    case 'instance':
      return 'instance';
  }
}

function normalizedOperation(operation: KroArtifactBundleOperation): KroArtifactBundleOperation {
  if (!operation.id) {
    throw new KroArtifactBundleError('KRO bundle operation id must be non-empty.', '$.operations');
  }
  if (!Array.isArray(operation.sources) || operation.sources.length === 0) {
    throw new KroArtifactBundleError(
      `KRO bundle operation ${operation.id} has no source identity.`,
      `$.operations.${operation.id}.sources`
    );
  }
  const sources = [...operation.sources]
    .map((source, index) => {
      if (!source.memberId || !source.planIdentityDigest || !source.compiledArtifactDigest) {
        throw new KroArtifactBundleError(
          `KRO bundle operation ${operation.id} has incomplete source identity.`,
          `$.operations.${operation.id}.sources[${index}]`
        );
      }
      return source;
    })
    .sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
  if (new Set(sources.map((source) => canonicalStringify(source))).size !== sources.length) {
    throw new KroArtifactBundleError(
      `KRO bundle operation ${operation.id} repeats a source identity.`,
      `$.operations.${operation.id}.sources`
    );
  }
  const artifact = decodeKroArtifactResource(canonicalStringify(operation.artifact));
  const expectedRole = expectedArtifactRole(operation.role);
  if (artifact.role !== expectedRole) {
    throw new KroArtifactBundleError(
      `KRO bundle operation ${operation.id} uses ${operation.role} with artifact role ${artifact.role}.`,
      `$.operations.${operation.id}.artifact.role`,
      { expectedRole, actualRole: artifact.role }
    );
  }
  decodePlanValue(canonicalStringify(operation.manifest));
  const dependencies = [...new Set(operation.dependencies)].sort();
  if (dependencies.includes(operation.id)) {
    throw new KroArtifactBundleError(
      `KRO bundle operation ${operation.id} depends on itself.`,
      `$.operations.${operation.id}.dependencies`
    );
  }
  return { ...operation, sources, artifact: artifact as KroExecutableArtifact, dependencies };
}

function validateTopology(operations: readonly KroArtifactBundleOperation[]): void {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  for (const operation of operations) {
    for (const dependency of operation.dependencies) {
      if (!byId.has(dependency)) {
        throw new KroArtifactBundleError(
          `KRO bundle operation ${operation.id} references missing dependency ${dependency}.`,
          `$.operations.${operation.id}.dependencies`,
          { dependency }
        );
      }
    }
  }

  const indegree = new Map(operations.map((operation) => [operation.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const operation of operations) {
    indegree.set(operation.id, operation.dependencies.length);
    for (const dependency of operation.dependencies) {
      const current = dependents.get(dependency) ?? [];
      current.push(operation.id);
      dependents.set(dependency, current);
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    visited += 1;
    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (visited !== operations.length) {
    throw new KroArtifactBundleError(
      'KRO bundle operation dependencies contain a cycle.',
      '$.operations',
      {
        operations: [...indegree.entries()]
          .filter(([, count]) => count > 0)
          .map(([id]) => id)
          .sort()
          .join(','),
      }
    );
  }
}

function unsignedBundle(
  root: KroArtifactBundle['root'],
  requiredCapabilities: readonly CapabilityRequirement[],
  artifactRequirements: readonly ArtifactRequirement[],
  operations: readonly KroArtifactBundleOperation[]
): Omit<KroArtifactBundle, 'bundleDigest'> {
  return {
    version: KRO_ARTIFACT_BUNDLE_VERSION,
    target: 'kro',
    root,
    requiredCapabilities,
    artifactRequirements,
    operations,
  };
}

function normalizedArtifactRequirements(
  requirements: readonly ArtifactRequirement[]
): readonly ArtifactRequirement[] {
  const byId = new Map<string, ArtifactRequirement>();
  for (const [index, requirement] of requirements.entries()) {
    if (
      !requirement.id ||
      !requirement.kind ||
      requirement.outputs.length === 0 ||
      requirement.outputs.some((output) => output.length === 0) ||
      new Set(requirement.outputs).size !== requirement.outputs.length
    ) {
      throw new KroArtifactBundleError(
        `KRO bundle artifact requirement ${index} is invalid.`,
        `$.artifactRequirements[${index}]`
      );
    }
    const prior = byId.get(requirement.id);
    if (prior && canonicalStringify(prior) !== canonicalStringify(requirement)) {
      throw new KroArtifactBundleError(
        `KRO bundle artifact requirement ${requirement.id} has conflicting definitions.`,
        `$.artifactRequirements[${index}]`
      );
    }
    byId.set(requirement.id, requirement);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizedCapabilities(
  capabilities: readonly CapabilityRequirement[]
): readonly CapabilityRequirement[] {
  for (const [index, capability] of capabilities.entries()) {
    if (
      typeof capability.id !== 'string' ||
      capability.id.length === 0 ||
      !Number.isSafeInteger(capability.version) ||
      capability.version < 1 ||
      (capability.target !== undefined && !['direct', 'kro'].includes(capability.target)) ||
      (capability.host !== undefined && !['standalone', 'alchemy'].includes(capability.host)) ||
      (capability.output !== undefined && !['live', 'static'].includes(capability.output))
    ) {
      throw new KroArtifactBundleError(
        `KRO bundle capability ${index} is invalid.`,
        `$.requiredCapabilities[${index}]`
      );
    }
  }
  return [
    ...new Map(
      capabilities.map((capability) => [canonicalStringify(capability), capability] as const)
    ).values(),
  ].sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
}

/** Merge repeated physical operations while rejecting semantic drift. */
export function mergeKroArtifactBundleOperations(
  operations: readonly KroArtifactBundleOperation[]
): readonly KroArtifactBundleOperation[] {
  const byId = new Map<string, KroArtifactBundleOperation>();
  for (const operation of operations) {
    const existing = byId.get(operation.id);
    if (!existing) {
      byId.set(operation.id, operation);
      continue;
    }
    if (
      existing.role !== operation.role ||
      canonicalStringify(existing.artifact) !== canonicalStringify(operation.artifact) ||
      canonicalStringify(existing.manifest) !== canonicalStringify(operation.manifest)
    ) {
      throw new KroArtifactBundleError(
        `KRO bundle operation ${operation.id} is produced with conflicting semantics.`,
        `$.operations.${operation.id}`,
        { existingRole: existing.role, incomingRole: operation.role }
      );
    }
    byId.set(operation.id, {
      ...existing,
      sources: [
        ...new Map(
          [...existing.sources, ...operation.sources].map((source) => [
            canonicalStringify(source),
            source,
          ])
        ).values(),
      ],
      dependencies: [...new Set([...existing.dependencies, ...operation.dependencies])],
    });
  }
  return [...byId.values()];
}

/** Validate and canonicalize a complete host-independent KRO outer bundle. */
export function createKroArtifactBundle(input: {
  readonly root: KroArtifactBundle['root'];
  readonly operations: readonly KroArtifactBundleOperation[];
  readonly requiredCapabilities?: readonly CapabilityRequirement[];
  readonly artifactRequirements?: readonly ArtifactRequirement[];
}): KroArtifactBundle {
  const operations = input.operations
    .map(normalizedOperation)
    .sort((left, right) => left.id.localeCompare(right.id));
  const duplicates = operations
    .filter(
      (operation, index) => operations.findIndex((item) => item.id === operation.id) !== index
    )
    .map((operation) => operation.id);
  if (duplicates.length > 0) {
    throw new KroArtifactBundleError('KRO bundle operation ids must be unique.', '$.operations', {
      duplicates: [...new Set(duplicates)].sort().join(','),
    });
  }
  validateTopology(operations);

  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const rootRgd = byId.get(input.root.rgdOperationId);
  if (
    !rootRgd ||
    rootRgd.role !== 'resource-graph-definition' ||
    !rootRgd.sources.some((source) => source.memberId === input.root.memberId)
  ) {
    throw new KroArtifactBundleError(
      'KRO bundle root RGD does not identify the root member resource-graph-definition operation.',
      '$.root.rgdOperationId'
    );
  }
  if (input.root.instanceOperationId) {
    const rootInstance = byId.get(input.root.instanceOperationId);
    if (
      !rootInstance ||
      rootInstance.role !== 'instance' ||
      !rootInstance.sources.some((source) => source.memberId === input.root.memberId)
    ) {
      throw new KroArtifactBundleError(
        'KRO bundle root instance does not identify the root member instance operation.',
        '$.root.instanceOperationId'
      );
    }
  }

  const requiredCapabilities = normalizedCapabilities(input.requiredCapabilities ?? []);
  const artifactRequirements = normalizedArtifactRequirements(input.artifactRequirements ?? []);
  const unsigned = unsignedBundle(
    input.root,
    requiredCapabilities,
    artifactRequirements,
    operations
  );
  return { ...unsigned, bundleDigest: canonicalDigest(unsigned) };
}

export function encodeKroArtifactBundle(bundle: KroArtifactBundle): string {
  return canonicalStringify(bundle);
}

export function decodeKroArtifactBundle(encoded: string): KroArtifactBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error: unknown) {
    throw new KroArtifactBundleError(
      `KRO artifact bundle is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KroArtifactBundleError('Expected a KRO artifact bundle object.');
  }
  const record = parsed as UnknownRecord;
  if (record.version !== KRO_ARTIFACT_BUNDLE_VERSION || record.target !== 'kro') {
    throw new KroArtifactBundleError(
      `Unsupported KRO artifact bundle ${String(record.version)}/${String(record.target)}.`
    );
  }
  if (!record.root || typeof record.root !== 'object' || Array.isArray(record.root)) {
    throw new KroArtifactBundleError('KRO artifact bundle root is invalid.', '$.root');
  }
  if (!Array.isArray(record.operations)) {
    throw new KroArtifactBundleError(
      'KRO artifact bundle operations must be an array.',
      '$.operations'
    );
  }
  if (typeof record.bundleDigest !== 'string' || record.bundleDigest.length === 0) {
    throw new KroArtifactBundleError('KRO artifact bundle digest is missing.', '$.bundleDigest');
  }
  const requiredCapabilities = Array.isArray(record.requiredCapabilities)
    ? (record.requiredCapabilities as CapabilityRequirement[])
    : [];
  const artifactRequirements = Array.isArray(record.artifactRequirements)
    ? (record.artifactRequirements as ArtifactRequirement[])
    : [];
  const normalized = createKroArtifactBundle({
    root: record.root as KroArtifactBundle['root'],
    operations: record.operations as KroArtifactBundleOperation[],
    requiredCapabilities,
    artifactRequirements,
  });
  const legacyDigest = canonicalDigest({
    version: KRO_ARTIFACT_BUNDLE_VERSION,
    target: 'kro',
    root: record.root,
    operations: normalized.operations,
  });
  const preArtifactRequirementsDigest = canonicalDigest({
    version: KRO_ARTIFACT_BUNDLE_VERSION,
    target: 'kro',
    root: record.root,
    requiredCapabilities: normalized.requiredCapabilities,
    operations: normalized.operations,
  });
  const matchesPreviousBundleShape =
    record.artifactRequirements === undefined &&
    preArtifactRequirementsDigest === record.bundleDigest;
  const matchesLegacyBundleShape =
    record.requiredCapabilities === undefined &&
    record.artifactRequirements === undefined &&
    legacyDigest === record.bundleDigest;
  if (
    normalized.bundleDigest !== record.bundleDigest &&
    !matchesPreviousBundleShape &&
    !matchesLegacyBundleShape
  ) {
    throw new KroArtifactBundleError(
      'KRO artifact bundle digest does not match its canonical content.',
      '$.bundleDigest'
    );
  }
  return normalized;
}

/** Topological operation order, with stable lexical order among independent operations. */
export function orderKroArtifactBundleOperations(
  bundle: KroArtifactBundle
): readonly KroArtifactBundleOperation[] {
  const byId = new Map(bundle.operations.map((operation) => [operation.id, operation]));
  const remaining = new Map(
    bundle.operations.map((operation) => [operation.id, new Set(operation.dependencies)])
  );
  const ordered: KroArtifactBundleOperation[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) {
      throw new KroArtifactBundleError('KRO artifact bundle contains a dependency cycle.');
    }
    for (const id of ready) {
      const operation = byId.get(id);
      if (!operation) {
        throw new KroArtifactBundleError(
          `KRO artifact bundle operation ${id} is missing from the operation index.`,
          `$.operations.${id}`
        );
      }
      ordered.push(operation);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return ordered;
}

/** Materialize the concrete manifest carried by a bundle operation. */
export function materializeKroArtifactBundleOperation(
  operation: KroArtifactBundleOperation,
  bindings: PlanMaterializationBindings = {}
): KubernetesResource {
  const manifest = materializePlanValue(
    operation.manifest,
    bindings,
    `$.operations.${operation.id}.manifest`
  );
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new KroArtifactBundleError(
      `KRO bundle operation ${operation.id} did not materialize to a Kubernetes resource.`,
      `$.operations.${operation.id}.manifest`
    );
  }
  const resource = manifest as KubernetesResource;
  if (
    typeof resource.apiVersion !== 'string' ||
    typeof resource.kind !== 'string' ||
    typeof resource.metadata?.name !== 'string'
  ) {
    throw new KroArtifactBundleError(
      `KRO bundle operation ${operation.id} is missing Kubernetes identity.`,
      `$.operations.${operation.id}.manifest`
    );
  }
  return resource;
}
