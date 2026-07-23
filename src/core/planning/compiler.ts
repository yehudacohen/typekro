import { convertToKubernetesName } from '../deployment/shared-utilities.js';
import { TypeKroError } from '../errors.js';

import {
  ARTIFACT_PLAN_VERSION,
  type ArtifactApplyPolicy,
  type DirectArtifactCompilerOptions,
  type DirectKubernetesArtifactPlan,
  type DirectKubernetesArtifactResource,
  type KroArtifactCompilerOptions,
  type KroArtifactPlan,
  type KroArtifactResource,
  type KroGraphChildArtifact,
  type KroInstanceArtifact,
  type KroResourceGraphDefinitionArtifact,
  type KroSupportingArtifact,
} from './artifacts.js';
import { canonicalDigest, canonicalStringify } from './canonical.js';
import { targetCapabilityDiagnostics } from './capabilities.js';
import type {
  ArtifactOutputUse,
  DesiredStatePlan,
  KubernetesIdentity,
  LifecyclePolicy,
  PlanDiagnostic,
  PlanEdge,
  PlanValue,
  RepresentationRequirement,
  SchemaIR,
} from './types.js';
import {
  collectArtifactOutputUses,
  kroArtifactOutputField,
  kroArtifactRequirementField,
} from './values.js';

const KRO_RESERVED_STATUS_FIELDS = new Set(['conditions', 'state', 'observedGeneration']);

const DEFAULT_APPLY_POLICY: ArtifactApplyPolicy = {
  strategy: 'create-or-patch',
  existingResource: 'patch',
  immutableFieldPolicy: 'fail',
};

/** Error raised when a target compiler cannot faithfully represent a semantic plan. */
export class ArtifactCompilationError extends TypeKroError {
  constructor(target: 'direct' | 'kro', diagnostics: readonly PlanDiagnostic[]) {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    const detail = errors
      .map((diagnostic) => `${diagnostic.path ?? '$'}: ${diagnostic.message}`)
      .join('; ');
    super(
      `Cannot compile semantic plan for ${target}.${detail ? ` ${detail}` : ''}`,
      'ARTIFACT_COMPILATION_FAILED',
      { target, diagnostics }
    );
    this.name = 'ArtifactCompilationError';
  }
}

function objectValue(entries: Readonly<Record<string, PlanValue | undefined>>): PlanValue {
  return {
    kind: 'object',
    entries: Object.entries(entries)
      .filter((entry): entry is [string, PlanValue] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value })),
  };
}

function withObjectField(value: PlanValue, key: string, fieldValue: PlanValue): PlanValue {
  if (value.kind !== 'object') return value;
  return {
    kind: 'object',
    entries: [
      ...value.entries.filter((entry) => entry.key !== key),
      { key, value: fieldValue },
    ].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function kroArtifactBindingValue(uses: readonly ArtifactOutputUse[]): PlanValue {
  const byRequirement = new Map<string, ArtifactOutputUse[]>();
  for (const use of uses) {
    const current = byRequirement.get(use.requirementId) ?? [];
    current.push(use);
    byRequirement.set(use.requirementId, current);
  }
  return objectValue(
    Object.fromEntries(
      [...byRequirement.entries()].map(([requirementId, requirementUses]) => [
        kroArtifactRequirementField(requirementId),
        objectValue(
          Object.fromEntries(
            requirementUses.map((use) => {
              const output: PlanValue = {
                kind: 'artifact-output',
                requirementId: use.requirementId,
                output: use.output,
              };
              return [
                kroArtifactOutputField(use.output),
                use.sensitive ? { kind: 'sensitive-value', value: output } : output,
              ];
            })
          )
        ),
      ])
    )
  );
}

function kroSpecSchemaWithArtifactBindings(
  schema: SchemaIR,
  uses: readonly ArtifactOutputUse[]
): SchemaIR {
  if (uses.length === 0 || schema.root.kind !== 'object') return schema;
  const byRequirement = new Map<string, ArtifactOutputUse[]>();
  for (const use of uses) {
    const current = byRequirement.get(use.requirementId) ?? [];
    current.push(use);
    byRequirement.set(use.requirementId, current);
  }
  const bindingProperty = {
    name: '__typekroArtifacts',
    required: true,
    schema: {
      kind: 'object' as const,
      properties: [...byRequirement.entries()].map(([requirementId, requirementUses]) => ({
        name: kroArtifactRequirementField(requirementId),
        required: true,
        schema: {
          kind: 'object' as const,
          properties: requirementUses.map((use) => ({
            name: kroArtifactOutputField(use.output),
            required: true,
            schema: { kind: 'primitive' as const, type: 'string' as const },
          })),
        },
      })),
    },
  };
  const root = {
    ...schema.root,
    properties: [
      ...schema.root.properties.filter((property) => property.name !== bindingProperty.name),
      bindingProperty,
    ].sort((left, right) => left.name.localeCompare(right.name)),
  };
  return { ...schema, root, digest: canonicalDigest({ version: schema.version, root }) };
}

function literal(value: string | number | boolean | null): PlanValue {
  return { kind: 'literal', value };
}

function objectField(value: PlanValue, key: string): PlanValue | undefined {
  return value.kind === 'object'
    ? value.entries.find((entry) => entry.key === key)?.value
    : undefined;
}

function literalString(value: PlanValue | undefined): string | undefined {
  return value?.kind === 'literal' && typeof value.value === 'string' ? value.value : undefined;
}

function identityFromManifest(value: PlanValue): KubernetesIdentity | undefined {
  const apiVersion = literalString(objectField(value, 'apiVersion'));
  const kind = literalString(objectField(value, 'kind'));
  const metadata = objectField(value, 'metadata');
  const name = metadata ? objectField(metadata, 'name') : undefined;
  if (!apiVersion || !kind || !name) return undefined;
  const namespace = metadata ? objectField(metadata, 'namespace') : undefined;
  return {
    apiVersion,
    kind,
    name,
    ...(namespace ? { namespace } : {}),
    scope: namespace ? 'namespaced' : 'cluster',
  };
}

function compilerDiagnostics(plan: DesiredStatePlan, target: 'direct' | 'kro'): PlanDiagnostic[] {
  // Value-lowering failures are target blockers. Dropping them lets an unsupported function,
  // symbol, class instance, or circular value become `omitted` before the legacy serializer can
  // issue its path-specific error. Other plan diagnostics remain inspection evidence until their
  // respective IR migrations are strict (for example, arbitrary chart-value schema nodes are
  // intentionally accepted today), so do not turn every diagnostic into a compiler failure here.
  const valueErrors = plan.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === 'error' &&
      (diagnostic.code === 'PLAN_VALUE_UNSUPPORTED' || diagnostic.code === 'PLAN_VALUE_CIRCULAR')
  );
  return [...valueErrors, ...targetCapabilityDiagnostics(plan.requiredCapabilities, target)];
}

function supportingLifecycle(): LifecyclePolicy {
  return {
    creation: 'create',
    management: 'authoritative',
    deletion: 'delete-when-unused',
    instancing: { kind: 'per-cluster' },
    sharing: 'shareable',
    unusedEvidence: {
      provider: 'typekro.singleton-consumer-registry',
      version: 1,
      inputs: objectValue({}),
    },
  };
}

function lifecycleFromPlanValue(value: PlanValue | undefined): LifecyclePolicy | undefined {
  if (!value || value.kind !== 'object') return undefined;
  const creation = literalString(objectField(value, 'creation'));
  const management = literalString(objectField(value, 'management'));
  const deletion = literalString(objectField(value, 'deletion'));
  const sharing = literalString(objectField(value, 'sharing'));
  const instancingValue = objectField(value, 'instancing');
  const instancingKind = literalString(
    instancingValue ? objectField(instancingValue, 'kind') : undefined
  );
  if (
    !['create', 'adopt', 'require-existing'].includes(creation ?? '') ||
    !['authoritative', 'cooperative', 'reference-only'].includes(management ?? '') ||
    !['delete', 'retain', 'delete-when-unused'].includes(deletion ?? '') ||
    !['exclusive', 'shareable'].includes(sharing ?? '') ||
    !['per-instance', 'per-scope', 'per-cluster'].includes(instancingKind ?? '')
  ) {
    return undefined;
  }
  const instancing =
    instancingKind === 'per-scope'
      ? {
          kind: 'per-scope' as const,
          key:
            (instancingValue ? objectField(instancingValue, 'key') : undefined) ??
            literal('default'),
        }
      : { kind: instancingKind as 'per-instance' | 'per-cluster' };
  const unusedEvidenceValue = objectField(value, 'unusedEvidence');
  const provider = unusedEvidenceValue
    ? literalString(objectField(unusedEvidenceValue, 'provider'))
    : undefined;
  const versionValue = unusedEvidenceValue
    ? objectField(unusedEvidenceValue, 'version')
    : undefined;
  const version =
    versionValue?.kind === 'literal' && typeof versionValue.value === 'number'
      ? versionValue.value
      : undefined;
  const inputs = unusedEvidenceValue ? objectField(unusedEvidenceValue, 'inputs') : undefined;
  return {
    creation: creation as LifecyclePolicy['creation'],
    management: management as LifecyclePolicy['management'],
    deletion: deletion as LifecyclePolicy['deletion'],
    instancing,
    sharing: sharing as LifecyclePolicy['sharing'],
    ...(provider && version !== undefined && inputs
      ? { unusedEvidence: { provider, version, inputs } }
      : {}),
  };
}

function singletonArtifact(
  requirement: RepresentationRequirement,
  apply: ArtifactApplyPolicy,
  target: 'direct' | 'kro',
  index: number
): DirectKubernetesArtifactResource | KroArtifactResource | undefined {
  if (requirement.extension !== 'typekro.singleton-owner' || requirement.version !== 1) {
    return undefined;
  }
  const desired = objectField(requirement.inputs, 'owner');
  if (!desired) return undefined;
  const singletonKey = literalString(objectField(requirement.inputs, 'singletonKey'));
  const lifecycle =
    lifecycleFromPlanValue(objectField(requirement.inputs, 'lifecycle')) ?? supportingLifecycle();
  const id = `singleton:${singletonKey ?? index}`;
  const identity = identityFromManifest(desired);
  const base = {
    id,
    ...(identity ? { identity } : {}),
    desired,
    lifecycle,
    readiness: { activation: [], readyWhen: [] },
    requiredCapabilities: [],
    role: 'singleton-owner' as const,
    apply,
  };
  return target === 'direct' ? base : base;
}

function requirementArtifacts(
  plan: DesiredStatePlan,
  target: 'direct' | 'kro',
  apply: ArtifactApplyPolicy,
  diagnostics: PlanDiagnostic[]
): Array<DirectKubernetesArtifactResource | KroArtifactResource> {
  return plan.representationRequirements.flatMap((requirement, index) => {
    if (requirement.target !== target) return [];
    const singleton = singletonArtifact(requirement, apply, target, index);
    if (singleton) return [singleton];
    diagnostics.push({
      code: 'ARTIFACT_REPRESENTATION_EXTENSION_UNSUPPORTED',
      severity: 'error',
      message: `Compiler ${target} does not support representation extension ${requirement.extension}@${requirement.version}.`,
      path: `$.representationRequirements[${index}]`,
      details: {
        extension: requirement.extension,
        version: requirement.version,
        target,
      },
    });
    return [];
  });
}

function throwIfStrict(
  target: 'direct' | 'kro',
  diagnostics: readonly PlanDiagnostic[],
  strict: boolean
): void {
  if (strict && diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new ArtifactCompilationError(target, diagnostics);
  }
}

function artifactIdentityDiagnostics(resources: readonly KroArtifactResource[]): PlanDiagnostic[] {
  const positions = new Map<string, number[]>();
  resources.forEach((resource, index) => {
    const indexes = positions.get(resource.id) ?? [];
    indexes.push(index);
    positions.set(resource.id, indexes);
  });
  return [...positions.entries()].flatMap(([id, indexes]) =>
    indexes.length > 1
      ? [
          {
            code: 'ARTIFACT_ID_DUPLICATE',
            severity: 'error' as const,
            message: `Artifact id ${id} is produced more than once.`,
            path: '$.resources',
            details: { artifactId: id, indexes: indexes.join(',') },
          },
        ]
      : []
  );
}

function edgeEndpointIds(edge: PlanEdge): readonly [string, string] {
  switch (edge.kind) {
    case 'output':
      return [edge.producer, edge.consumer];
    case 'existence':
    case 'ready':
      return [edge.prerequisite, edge.dependent];
    case 'ownership':
      return [edge.owner, edge.child];
    case 'delete-after':
      return [edge.resource, edge.blocker];
  }
}

function outerEdgeDiagnostics(
  edges: readonly PlanEdge[],
  resources: readonly KroArtifactResource[]
): PlanDiagnostic[] {
  const artifactIds = new Set(resources.map((resource) => resource.id));
  const diagnostics: PlanDiagnostic[] = [];
  edges.forEach((edge, index) => {
    for (const endpoint of edgeEndpointIds(edge)) {
      if (!artifactIds.has(endpoint)) {
        diagnostics.push({
          code: 'ARTIFACT_EDGE_ENDPOINT_MISSING',
          severity: 'error',
          message: `Outer artifact edge ${index} references missing artifact ${endpoint}.`,
          path: `$.outerEdges[${index}]`,
          details: { endpoint, edge: canonicalStringify(edge) },
        });
      }
    }
  });

  const orderingEdges = edges.filter(
    (edge): edge is Extract<PlanEdge, { kind: 'existence' | 'ready' }> =>
      edge.kind === 'existence' || edge.kind === 'ready'
  );
  const indegree = new Map(resources.map((resource) => [resource.id, 0]));
  const dependents = new Map<string, Set<string>>();
  for (const edge of orderingEdges) {
    if (!artifactIds.has(edge.prerequisite) || !artifactIds.has(edge.dependent)) continue;
    const targets = dependents.get(edge.prerequisite) ?? new Set<string>();
    if (targets.has(edge.dependent)) continue;
    targets.add(edge.dependent);
    dependents.set(edge.prerequisite, targets);
    indegree.set(edge.dependent, (indegree.get(edge.dependent) ?? 0) + 1);
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.pop();
    if (current === undefined) break;
    visited += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const degree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, degree);
      if (degree === 0) ready.push(dependent);
    }
  }
  if (visited !== indegree.size) {
    diagnostics.push({
      code: 'ARTIFACT_EDGE_CYCLE',
      severity: 'error',
      message: 'Outer artifact existence/readiness edges contain a cycle.',
      path: '$.outerEdges',
      details: {
        artifactIds: [...indegree.entries()]
          .filter(([, degree]) => degree > 0)
          .map(([id]) => id)
          .sort()
          .join(','),
      },
    });
  }
  return diagnostics;
}

/** Purely compile a semantic plan into direct Kubernetes artifact operations. */
export function compileDirectArtifactPlan(
  plan: DesiredStatePlan,
  options: DirectArtifactCompilerOptions = {}
): DirectKubernetesArtifactPlan {
  const diagnostics = compilerDiagnostics(plan, 'direct');
  const apply = options.applyPolicy ?? DEFAULT_APPLY_POLICY;
  const resources: DirectKubernetesArtifactResource[] = plan.nodes.map((node) => {
    const base = {
      id: node.id,
      sourceNodeId: node.id,
      ...(node.identity ? { identity: node.identity } : {}),
      ...(node.desired ? { desired: node.desired } : {}),
      lifecycle: node.lifecycle,
      readiness: {
        activation: node.activation,
        readyWhen: node.readiness,
        ...(node.readinessStrategy ? { strategy: node.readinessStrategy } : {}),
      },
      ...(node.iteration ? { iteration: node.iteration } : {}),
      ...(node.templateOverrides ? { templateOverrides: node.templateOverrides } : {}),
      requiredCapabilities: node.requiredCapabilities,
    };
    if (node.type === 'compatibility-closure') {
      return { ...base, role: 'compatibility-closure' as const };
    }
    if (node.lifecycle.creation === 'require-existing') {
      return { ...base, role: 'external-reference' as const };
    }
    return { ...base, role: 'application-resource' as const, apply };
  });
  resources.push(
    ...(requirementArtifacts(
      plan,
      'direct',
      apply,
      diagnostics
    ) as DirectKubernetesArtifactResource[])
  );
  resources.sort((left, right) => left.id.localeCompare(right.id));
  const artifactRequirements = plan.inputs
    .filter((input) => input.kind === 'artifact')
    .map((input) => input.requirement);
  const compiledArtifactDigest = canonicalDigest({
    version: ARTIFACT_PLAN_VERSION,
    target: 'direct',
    compiler: { id: 'typekro.direct', version: 1 },
    planIdentityDigest: plan.planIdentityDigest,
    resources,
    edges: plan.edges,
    artifactRequirements,
  });
  throwIfStrict('direct', diagnostics, options.strict ?? true);
  return {
    version: ARTIFACT_PLAN_VERSION,
    target: 'direct',
    compiler: { id: 'typekro.direct', version: 1 },
    planIdentityDigest: plan.planIdentityDigest,
    compiledArtifactDigest,
    resources,
    edges: plan.edges,
    requiredCapabilities: plan.requiredCapabilities,
    artifactRequirements,
    diagnostics,
  };
}

function kroStatusDiagnostics(plan: DesiredStatePlan): PlanDiagnostic[] {
  const root = plan.status.hydratedSchema.root;
  if (root.kind !== 'object') return [];
  return root.properties.flatMap((property) =>
    KRO_RESERVED_STATUS_FIELDS.has(property.name)
      ? [
          {
            code: 'KRO_STATUS_FIELD_RESERVED',
            severity: 'error' as const,
            message: `Status field ${property.name} collides with a KRO-owned root status field.`,
            path: `$.status.${property.name}`,
            details: { field: property.name, policyVersion: 1 },
          },
        ]
      : []
  );
}

/** Purely compile semantic intent into host-independent KRO graph and outer artifacts. */
export function compileKroArtifactPlan(
  plan: DesiredStatePlan,
  options: KroArtifactCompilerOptions = {}
): KroArtifactPlan {
  const diagnostics = [...compilerDiagnostics(plan, 'kro'), ...kroStatusDiagnostics(plan)];
  const apply = options.outerApplyPolicy ?? DEFAULT_APPLY_POLICY;
  const graphChildren: KroGraphChildArtifact[] = plan.nodes.flatMap((node) => {
    if (node.type !== 'kubernetes-resource') return [];
    return [
      {
        id: node.id,
        sourceNodeId: node.id,
        role:
          node.lifecycle.creation === 'require-existing'
            ? ('kro-external-reference' as const)
            : ('kro-graph-child' as const),
        ...(node.identity ? { identity: node.identity } : {}),
        ...(node.desired ? { desired: node.desired } : {}),
        lifecycle: node.lifecycle,
        readiness: { activation: node.activation, readyWhen: node.readiness },
        ...(node.iteration ? { iteration: node.iteration } : {}),
        ...(node.templateOverrides ? { templateOverrides: node.templateOverrides } : {}),
        requiredCapabilities: node.requiredCapabilities,
      },
    ];
  });
  const artifactOutputUses = collectArtifactOutputUses({
    nodes: plan.nodes,
    outputs: plan.outputs,
    representationRequirements: plan.representationRequirements,
  });
  if (artifactOutputUses.length > 0 && plan.schemas.spec.root.kind !== 'object') {
    diagnostics.push({
      code: 'KRO_ARTIFACT_BINDING_SCHEMA_UNSUPPORTED',
      severity: 'error',
      message: 'KRO artifact outputs require an object-shaped root spec schema.',
      path: '$.schemas.spec',
      details: { schemaKind: plan.schemas.spec.root.kind },
    });
  }
  const rgdName = options.rgdName ?? convertToKubernetesName(plan.composition.name);
  const rgdId = '__typekro_rgd__';
  const instanceId = '__typekro_instance__';
  const graph = {
    version: 1 as const,
    name: rgdName,
    root: {
      apiVersion: plan.composition.apiVersion,
      kind: plan.composition.kind,
      specSchema: kroSpecSchemaWithArtifactBindings(plan.schemas.spec, artifactOutputUses),
      persistedStatusSchema: plan.status.persistedSchema,
    },
    children: graphChildren,
    edges: plan.edges,
    statusProjections: plan.status.projections,
  };
  const rgdLifecycle: LifecyclePolicy = {
    creation: 'adopt',
    management: 'authoritative',
    deletion: 'delete-when-unused',
    instancing: { kind: 'per-cluster' },
    sharing: 'shareable',
    unusedEvidence: {
      provider: 'typekro.kro-instance-list',
      version: 1,
      inputs: objectValue({ rgdName: literal(rgdName) }),
    },
  };
  const instanceName = options.instance?.name ?? plan.instance.name;
  const namespace = options.instance?.namespace;
  const instanceApiVersion = options.instance?.apiVersion ?? plan.composition.apiVersion;
  const instanceKind = options.instance?.kind ?? plan.composition.kind;
  const instanceIdentity: KubernetesIdentity = {
    apiVersion: instanceApiVersion,
    kind: instanceKind,
    name: instanceName,
    ...(namespace ? { namespace } : {}),
    scope: 'namespaced',
  };
  const instanceSpec =
    artifactOutputUses.length > 0
      ? withObjectField(
          options.instance?.spec ?? plan.spec,
          '__typekroArtifacts',
          kroArtifactBindingValue(artifactOutputUses)
        )
      : (options.instance?.spec ?? plan.spec);
  const instanceDesired = objectValue({
    apiVersion: literal(instanceApiVersion),
    kind: literal(instanceKind),
    metadata: objectValue({
      name: instanceName,
      namespace,
      labels: options.instance?.labels,
      annotations: options.instance?.annotations,
    }),
    spec: instanceSpec,
  });
  const rgdArtifact: KroResourceGraphDefinitionArtifact = {
    id: rgdId,
    role: 'resource-graph-definition',
    identity: {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      name: literal(rgdName),
      scope: 'cluster',
    },
    lifecycle: rgdLifecycle,
    readiness: { activation: [], readyWhen: [] },
    requiredCapabilities: [],
    graph,
    apply,
  };
  const instanceArtifact: KroInstanceArtifact = {
    id: instanceId,
    role: 'instance',
    identity: instanceIdentity,
    desired: instanceDesired,
    lifecycle: {
      creation: 'create',
      management: 'authoritative',
      deletion: 'delete',
      instancing: { kind: 'per-instance' },
      sharing: 'exclusive',
    },
    readiness: { activation: [], readyWhen: [] },
    requiredCapabilities: [],
    apply,
  };
  const supportingArtifacts: KroSupportingArtifact[] = (options.supportingArtifacts ?? []).map(
    (supporting) => ({
      id: supporting.id,
      role: supporting.role,
      ...(supporting.identity ? { identity: supporting.identity } : {}),
      desired: supporting.desired,
      lifecycle: supporting.lifecycle,
      readiness: supporting.readiness ?? { activation: [], readyWhen: [] },
      requiredCapabilities: supporting.requiredCapabilities ?? [],
      apply: supporting.apply ?? apply,
    })
  );
  const requirementResources = requirementArtifacts(
    plan,
    'kro',
    apply,
    diagnostics
  ) as KroArtifactResource[];
  const resources: KroArtifactResource[] = [
    ...graphChildren,
    ...requirementResources,
    ...supportingArtifacts,
    rgdArtifact,
    instanceArtifact,
  ].sort((left, right) => left.id.localeCompare(right.id));
  diagnostics.push(...artifactIdentityDiagnostics(resources));
  diagnostics.push(...outerEdgeDiagnostics(options.outerEdges ?? [], resources));
  const edges: PlanEdge[] = [
    ...plan.edges,
    ...(options.outerEdges ?? []),
    ...requirementResources
      .filter((resource) => resource.role === 'singleton-owner')
      .flatMap((resource): PlanEdge[] => [
        { kind: 'existence', prerequisite: resource.id, dependent: rgdId },
        { kind: 'existence', prerequisite: resource.id, dependent: instanceId },
      ]),
    { kind: 'existence', prerequisite: rgdId, dependent: instanceId },
  ];
  const uniqueEdges = [
    ...new Map(edges.map((edge) => [canonicalStringify(edge), edge])).values(),
  ].sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
  const artifactRequirements = plan.inputs
    .filter((input) => input.kind === 'artifact')
    .map((input) => input.requirement);
  const compiledArtifactDigest = canonicalDigest({
    version: ARTIFACT_PLAN_VERSION,
    target: 'kro',
    compiler: { id: 'typekro.kro', version: 1 },
    planIdentityDigest: plan.planIdentityDigest,
    resources,
    edges: uniqueEdges,
    artifactRequirements,
  });
  throwIfStrict('kro', diagnostics, options.strict ?? true);
  return {
    version: ARTIFACT_PLAN_VERSION,
    target: 'kro',
    compiler: { id: 'typekro.kro', version: 1 },
    planIdentityDigest: plan.planIdentityDigest,
    compiledArtifactDigest,
    resources,
    edges: uniqueEdges,
    requiredCapabilities: plan.requiredCapabilities,
    artifactRequirements,
    diagnostics,
  };
}
