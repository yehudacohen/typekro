import { TypeKroError } from '../errors.js';

import { canonicalStringify } from './canonical.js';
import type { CapabilityRequirement, PlanDiagnostic } from './types.js';

export interface ArtifactCapabilityContext {
  readonly target: 'direct' | 'kro';
  readonly host: 'standalone' | 'alchemy' | null;
  readonly output: 'live' | 'static';
}

interface CapabilityGroup {
  readonly requirements: readonly CapabilityRequirement[];
  readonly id: string;
  readonly version: number;
  readonly nodeId?: string;
}

function capabilityGroupKey(requirement: CapabilityRequirement): string {
  return canonicalStringify({
    id: requirement.id,
    version: requirement.version,
    nodeId: requirement.nodeId ?? null,
  });
}

function capabilityGroups(
  requirements: readonly CapabilityRequirement[]
): readonly CapabilityGroup[] {
  const groups = new Map<string, CapabilityRequirement[]>();
  for (const requirement of requirements) {
    const key = capabilityGroupKey(requirement);
    const current = groups.get(key) ?? [];
    current.push(requirement);
    groups.set(key, current);
  }
  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    if (!first) return [];
    return [
      {
        requirements: [...group].sort((left, right) =>
          canonicalStringify(left).localeCompare(canonicalStringify(right))
        ),
        id: first.id,
        version: first.version,
        ...(first.nodeId ? { nodeId: first.nodeId } : {}),
      },
    ];
  });
}

function targetMatches(
  requirement: CapabilityRequirement,
  target: ArtifactCapabilityContext['target']
): boolean {
  return requirement.target === undefined || requirement.target === target;
}

function environmentMatches(
  requirement: CapabilityRequirement,
  context: ArtifactCapabilityContext
): boolean {
  return (
    targetMatches(requirement, context.target) &&
    (requirement.host === undefined || requirement.host === context.host) &&
    (requirement.output === undefined || requirement.output === context.output)
  );
}

function requirementConstraints(requirement: CapabilityRequirement): Record<string, unknown> {
  return {
    ...(requirement.target ? { target: requirement.target } : {}),
    ...(requirement.host ? { host: requirement.host } : {}),
    ...(requirement.output ? { output: requirement.output } : {}),
  };
}

function unsupportedDiagnostic(
  group: CapabilityGroup,
  context: Pick<ArtifactCapabilityContext, 'target'> | ArtifactCapabilityContext,
  dimension: 'target' | 'adapter'
): PlanDiagnostic {
  const actual =
    dimension === 'target'
      ? { target: context.target }
      : {
          target: context.target,
          host: (context as ArtifactCapabilityContext).host ?? 'none',
          output: (context as ArtifactCapabilityContext).output,
        };
  return {
    code: 'ARTIFACT_CAPABILITY_UNSUPPORTED',
    severity: 'error',
    message: `Capability ${group.id}@${group.version} cannot be satisfied by ${canonicalStringify(actual)}.`,
    path: group.nodeId ? `$.nodes.${group.nodeId}` : '$.requiredCapabilities',
    details: {
      capability: group.id,
      ...actual,
      alternatives: canonicalStringify(group.requirements.map(requirementConstraints)),
    },
  };
}

/** Validate only deployment-target constraints during pure artifact compilation. */
export function targetCapabilityDiagnostics(
  requirements: readonly CapabilityRequirement[],
  target: ArtifactCapabilityContext['target']
): readonly PlanDiagnostic[] {
  return capabilityGroups(requirements).flatMap((group) =>
    group.requirements.some((requirement) => targetMatches(requirement, target))
      ? []
      : [unsupportedDiagnostic(group, { target }, 'target')]
  );
}

/** Validate the complete target/host/output environment at an adapter boundary. */
export function adapterCapabilityDiagnostics(
  requirements: readonly CapabilityRequirement[],
  context: ArtifactCapabilityContext
): readonly PlanDiagnostic[] {
  return capabilityGroups(requirements).flatMap((group) =>
    group.requirements.some((requirement) => environmentMatches(requirement, context))
      ? []
      : [unsupportedDiagnostic(group, context, 'adapter')]
  );
}

export class ArtifactCapabilityError extends TypeKroError {
  constructor(context: ArtifactCapabilityContext, diagnostics: readonly PlanDiagnostic[]) {
    super(
      `Artifact capabilities cannot be satisfied by ${context.target}/${context.host ?? 'no-host'}/${context.output}.`,
      'ARTIFACT_CAPABILITY_UNSUPPORTED',
      { context, diagnostics }
    );
    this.name = 'ArtifactCapabilityError';
  }
}

export function assertAdapterCapabilitiesSupported(
  requirements: readonly CapabilityRequirement[],
  context: ArtifactCapabilityContext
): void {
  const diagnostics = adapterCapabilityDiagnostics(requirements, context);
  if (diagnostics.length > 0) throw new ArtifactCapabilityError(context, diagnostics);
}
