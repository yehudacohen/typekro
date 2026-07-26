import { TypeKroError } from '../errors.js';

import { canonicalDigest, canonicalStringify } from './canonical.js';
import {
  SEMANTIC_PLAN_VERSION,
  type DesiredStatePlan,
  type PlanDiagnostic,
  type PlanValue,
  type SchemaIR,
  type SchemaNodeIR,
} from './types.js';
import { decodePlanValue } from './values.js';

type UnknownRecord = Record<string, unknown>;

/** Failure raised when a serialized semantic plan violates its versioned contract. */
export class DesiredStatePlanDecodeError extends TypeKroError {
  constructor(message: string, path: string) {
    super(message, 'DESIRED_STATE_PLAN_DECODE_FAILED', { path });
    this.name = 'DesiredStatePlanDecodeError';
  }
}

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DesiredStatePlanDecodeError(`Expected an object at ${path}.`, path);
  }
  return value as UnknownRecord;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new DesiredStatePlanDecodeError(`Expected an array at ${path}.`, path);
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DesiredStatePlanDecodeError(`Expected a non-empty string at ${path}.`, path);
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new DesiredStatePlanDecodeError(`Expected an integer >= ${minimum} at ${path}.`, path);
  }
  return value as number;
}

function planValue(value: unknown, path: string): asserts value is PlanValue {
  try {
    decodePlanValue(JSON.stringify(value));
  } catch (error: unknown) {
    throw new DesiredStatePlanDecodeError(
      `Invalid PlanValue at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path
    );
  }
}

function diagnostic(value: unknown, path: string): asserts value is PlanDiagnostic {
  const item = record(value, path);
  string(item.code, `${path}.code`);
  string(item.message, `${path}.message`);
  if (!['info', 'warning', 'error'].includes(String(item.severity))) {
    throw new DesiredStatePlanDecodeError(`Invalid diagnostic severity at ${path}.severity.`, path);
  }
  if (item.path !== undefined && typeof item.path !== 'string') {
    throw new DesiredStatePlanDecodeError(`Invalid diagnostic path at ${path}.path.`, path);
  }
  if (item.location !== undefined) {
    const location = record(item.location, `${path}.location`);
    if (location.file !== undefined) string(location.file, `${path}.location.file`);
    if (location.line !== undefined) integer(location.line, `${path}.location.line`, 1);
    if (location.column !== undefined) integer(location.column, `${path}.location.column`, 1);
  }
  if (item.details !== undefined) {
    const details = record(item.details, `${path}.details`);
    for (const [key, detail] of Object.entries(details)) {
      if (
        detail !== null &&
        typeof detail !== 'string' &&
        typeof detail !== 'boolean' &&
        (typeof detail !== 'number' || !Number.isFinite(detail))
      ) {
        throw new DesiredStatePlanDecodeError(
          `Diagnostic detail ${key} is not a canonical primitive.`,
          `${path}.details.${key}`
        );
      }
    }
  }
}

function diagnostics(value: unknown, path: string): void {
  array(value, path).forEach((entry, index) => diagnostic(entry, `${path}[${index}]`));
}

function constraint(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => constraint(entry, `${path}[${index}]`));
    return;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  throw new DesiredStatePlanDecodeError(`Invalid schema constraint at ${path}.`, path);
}

function schemaNode(value: unknown, path: string): asserts value is SchemaNodeIR {
  const node = record(value, path);
  switch (node.kind) {
    case 'primitive': {
      if (!['string', 'number', 'boolean', 'null', 'unknown'].includes(String(node.type))) {
        throw new DesiredStatePlanDecodeError(`Invalid primitive schema at ${path}.`, path);
      }
      if (node.constraints !== undefined) {
        const constraints = record(node.constraints, `${path}.constraints`);
        Object.entries(constraints).forEach(([key, entry]) =>
          constraint(entry, `${path}.constraints.${key}`)
        );
      }
      return;
    }
    case 'literal':
      constraint(node.value, `${path}.value`);
      if (Array.isArray(node.value)) {
        throw new DesiredStatePlanDecodeError(
          `Schema literal cannot be an array at ${path}.`,
          path
        );
      }
      return;
    case 'array':
      schemaNode(node.items, `${path}.items`);
      return;
    case 'object': {
      const names = new Set<string>();
      array(node.properties, `${path}.properties`).forEach((propertyValue, index) => {
        const property = record(propertyValue, `${path}.properties[${index}]`);
        const name = string(property.name, `${path}.properties[${index}].name`);
        if (names.has(name)) {
          throw new DesiredStatePlanDecodeError(
            `Duplicate schema property ${name} at ${path}.`,
            `${path}.properties[${index}]`
          );
        }
        names.add(name);
        if (typeof property.required !== 'boolean') {
          throw new DesiredStatePlanDecodeError(
            `Invalid required flag at ${path}.properties[${index}].required.`,
            `${path}.properties[${index}].required`
          );
        }
        schemaNode(property.schema, `${path}.properties[${index}].schema`);
        if (property.defaultValue !== undefined) {
          planValue(property.defaultValue, `${path}.properties[${index}].defaultValue`);
        }
      });
      return;
    }
    case 'union':
      array(node.variants, `${path}.variants`).forEach((variant, index) =>
        schemaNode(variant, `${path}.variants[${index}]`)
      );
      return;
    case 'unsupported':
      string(node.description, `${path}.description`);
      planValue(node.raw, `${path}.raw`);
      return;
    default:
      throw new DesiredStatePlanDecodeError(
        `Unknown schema node kind ${String(node.kind)} at ${path}.`,
        `${path}.kind`
      );
  }
}

function schema(value: unknown, path: string): asserts value is SchemaIR {
  const item = record(value, path);
  if (item.version !== 1) {
    throw new DesiredStatePlanDecodeError(
      `Unsupported SchemaIR version at ${path}.`,
      `${path}.version`
    );
  }
  schemaNode(item.root, `${path}.root`);
  const digest = string(item.digest, `${path}.digest`);
  diagnostics(item.diagnostics, `${path}.diagnostics`);
  if (canonicalDigest({ version: 1, root: item.root }) !== digest) {
    throw new DesiredStatePlanDecodeError(`Schema digest mismatch at ${path}.`, `${path}.digest`);
  }
}

function compositionIdentity(value: unknown, path: string): void {
  const identity = record(value, path);
  string(identity.name, `${path}.name`);
  string(identity.apiVersion, `${path}.apiVersion`);
  string(identity.kind, `${path}.kind`);
  if (identity.stability === 'stable') {
    const revision = record(identity.revision, `${path}.revision`);
    if (revision.kind !== 'version' && revision.kind !== 'bundle-digest') {
      throw new DesiredStatePlanDecodeError(`Invalid composition revision at ${path}.`, path);
    }
    string(revision.value, `${path}.revision.value`);
  } else if (identity.stability === 'preview-unstable') {
    string(identity.diagnosticSourceDigest, `${path}.diagnosticSourceDigest`);
    if (identity.revision !== undefined) {
      throw new DesiredStatePlanDecodeError(
        `Preview composition identity cannot carry a durable revision.`,
        `${path}.revision`
      );
    }
  } else {
    throw new DesiredStatePlanDecodeError(`Invalid composition stability at ${path}.`, path);
  }
}

function capability(value: unknown, path: string): void {
  const item = record(value, path);
  string(item.id, `${path}.id`);
  integer(item.version, `${path}.version`, 1);
  if (item.target !== undefined && !['direct', 'kro'].includes(String(item.target))) {
    throw new DesiredStatePlanDecodeError(`Invalid capability target at ${path}.target.`, path);
  }
  if (item.host !== undefined && !['standalone', 'alchemy'].includes(String(item.host))) {
    throw new DesiredStatePlanDecodeError(`Invalid capability host at ${path}.host.`, path);
  }
  if (item.output !== undefined && !['live', 'static'].includes(String(item.output))) {
    throw new DesiredStatePlanDecodeError(`Invalid capability output at ${path}.output.`, path);
  }
  if (item.nodeId !== undefined) string(item.nodeId, `${path}.nodeId`);
}

function lifecycle(value: unknown, path: string): void {
  const item = record(value, path);
  if (!['create', 'adopt', 'require-existing'].includes(String(item.creation))) {
    throw new DesiredStatePlanDecodeError(`Invalid creation policy at ${path}.`, path);
  }
  if (!['authoritative', 'cooperative', 'reference-only'].includes(String(item.management))) {
    throw new DesiredStatePlanDecodeError(`Invalid management policy at ${path}.`, path);
  }
  if (!['delete', 'retain', 'delete-when-unused'].includes(String(item.deletion))) {
    throw new DesiredStatePlanDecodeError(`Invalid deletion policy at ${path}.`, path);
  }
  if (!['exclusive', 'shareable'].includes(String(item.sharing))) {
    throw new DesiredStatePlanDecodeError(`Invalid sharing policy at ${path}.`, path);
  }
  const instancing = record(item.instancing, `${path}.instancing`);
  if (!['per-instance', 'per-scope', 'per-cluster'].includes(String(instancing.kind))) {
    throw new DesiredStatePlanDecodeError(`Invalid instancing policy at ${path}.`, path);
  }
  if (instancing.kind === 'per-scope') planValue(instancing.key, `${path}.instancing.key`);
  if (item.deletion === 'delete-when-unused' && item.unusedEvidence === undefined) {
    throw new DesiredStatePlanDecodeError(
      `delete-when-unused requires authoritative unused evidence.`,
      `${path}.unusedEvidence`
    );
  }
  if (item.unusedEvidence !== undefined) {
    const evidence = record(item.unusedEvidence, `${path}.unusedEvidence`);
    string(evidence.provider, `${path}.unusedEvidence.provider`);
    integer(evidence.version, `${path}.unusedEvidence.version`, 1);
    planValue(evidence.inputs, `${path}.unusedEvidence.inputs`);
  }
}

function kubernetesIdentity(value: unknown, path: string): void {
  const identity = record(value, path);
  string(identity.apiVersion, `${path}.apiVersion`);
  string(identity.kind, `${path}.kind`);
  planValue(identity.name, `${path}.name`);
  if (identity.namespace !== undefined) planValue(identity.namespace, `${path}.namespace`);
  if (identity.scope !== 'cluster' && identity.scope !== 'namespaced') {
    throw new DesiredStatePlanDecodeError(`Invalid Kubernetes scope at ${path}.scope.`, path);
  }
  if (identity.scope === 'cluster' && identity.namespace !== undefined) {
    throw new DesiredStatePlanDecodeError(
      `Cluster-scoped identity cannot carry a namespace.`,
      `${path}.namespace`
    );
  }
}

function node(value: unknown, path: string): string {
  const item = record(value, path);
  const id = string(item.id, `${path}.id`);
  if (item.type !== 'kubernetes-resource' && item.type !== 'compatibility-closure') {
    throw new DesiredStatePlanDecodeError(`Invalid plan node type at ${path}.type.`, path);
  }
  if (item.identity !== undefined) kubernetesIdentity(item.identity, `${path}.identity`);
  if (item.desired !== undefined) planValue(item.desired, `${path}.desired`);
  if (item.type === 'kubernetes-resource' && item.desired === undefined) {
    throw new DesiredStatePlanDecodeError(
      `Kubernetes node requires desired state.`,
      `${path}.desired`
    );
  }
  lifecycle(item.lifecycle, `${path}.lifecycle`);
  array(item.activation, `${path}.activation`).forEach((entry, index) =>
    planValue(entry, `${path}.activation[${index}]`)
  );
  array(item.readiness, `${path}.readiness`).forEach((entry, index) =>
    planValue(entry, `${path}.readiness[${index}]`)
  );
  if (item.readinessStrategy !== undefined) {
    readinessStrategy(item.readinessStrategy, `${path}.readinessStrategy`);
  }
  if (item.iteration !== undefined) {
    array(item.iteration, `${path}.iteration`).forEach((entry, index) => {
      const dimensionPath = `${path}.iteration[${index}]`;
      const dimension = record(entry, dimensionPath);
      string(dimension.variable, `${dimensionPath}.variable`);
      planValue(dimension.collection, `${dimensionPath}.collection`);
      const itemPath = string(dimension.itemPath, `${dimensionPath}.itemPath`);
      if (!itemPath.split('.').includes('$item')) {
        throw new DesiredStatePlanDecodeError(
          `Iteration itemPath must contain a $item segment.`,
          `${dimensionPath}.itemPath`
        );
      }
    });
  }
  if (item.templateOverrides !== undefined) {
    array(item.templateOverrides, `${path}.templateOverrides`).forEach((entry, index) => {
      const override = record(entry, `${path}.templateOverrides[${index}]`);
      string(override.propertyPath, `${path}.templateOverrides[${index}].propertyPath`);
      planValue(override.value, `${path}.templateOverrides[${index}].value`);
    });
  }
  array(item.requiredCapabilities, `${path}.requiredCapabilities`).forEach((entry, index) =>
    capability(entry, `${path}.requiredCapabilities[${index}]`)
  );
  return id;
}

function readinessStrategy(value: unknown, path: string): void {
  const strategy = record(value, path);
  if (strategy.kind === 'registered') {
    string(strategy.id, `${path}.id`);
    string(strategy.revision, `${path}.revision`);
    if (strategy.configuration !== undefined) {
      planValue(strategy.configuration, `${path}.configuration`);
    }
    return;
  }
  if (strategy.kind === 'runtime-binding') {
    string(strategy.binding, `${path}.binding`);
    if (strategy.version !== 1) {
      throw new DesiredStatePlanDecodeError(
        `Unsupported runtime readiness binding version.`,
        `${path}.version`
      );
    }
    if (strategy.classification !== undefined) {
      const classification = record(strategy.classification, `${path}.classification`);
      if (
        ![
          'ambient-clock',
          'ambient-state',
          'host-callback',
          'opaque-code',
          'unclassified-evaluator',
        ].includes(String(classification.reason))
      ) {
        throw new DesiredStatePlanDecodeError(
          `Invalid runtime readiness classification.`,
          `${path}.classification.reason`
        );
      }
      if (
        classification.description !== undefined &&
        typeof classification.description !== 'string'
      ) {
        throw new DesiredStatePlanDecodeError(
          `Runtime readiness classification description must be a string.`,
          `${path}.classification.description`
        );
      }
    }
    return;
  }
  throw new DesiredStatePlanDecodeError(`Unknown readiness strategy.`, `${path}.kind`);
}

function edge(value: unknown, path: string, nodeIds: ReadonlySet<string>): void {
  const item = record(value, path);
  const endpoints: string[] = [];
  if (item.kind === 'output') {
    endpoints.push(
      string(item.producer, `${path}.producer`),
      string(item.consumer, `${path}.consumer`)
    );
    string(item.output, `${path}.output`);
  } else if (item.kind === 'existence' || item.kind === 'ready') {
    endpoints.push(
      string(item.prerequisite, `${path}.prerequisite`),
      string(item.dependent, `${path}.dependent`)
    );
  } else if (item.kind === 'ownership') {
    endpoints.push(string(item.owner, `${path}.owner`), string(item.child, `${path}.child`));
  } else if (item.kind === 'delete-after') {
    endpoints.push(
      string(item.resource, `${path}.resource`),
      string(item.blocker, `${path}.blocker`)
    );
  } else {
    throw new DesiredStatePlanDecodeError(`Invalid plan edge kind at ${path}.kind.`, path);
  }
  for (const endpoint of endpoints) {
    if (!nodeIds.has(endpoint)) {
      throw new DesiredStatePlanDecodeError(
        `Edge at ${path} references unknown node ${endpoint}.`,
        path
      );
    }
  }
}

function statusContract(value: unknown, path: string): void {
  const status = record(value, path);
  schema(status.persistedSchema, `${path}.persistedSchema`);
  schema(status.hydratedSchema, `${path}.hydratedSchema`);
  const persisted = status.persistedSchema as SchemaIR;
  const hydrated = status.hydratedSchema as SchemaIR;
  if (persisted.root.kind === 'object' && hydrated.root.kind === 'object') {
    const hydratedProperties = new Map(
      hydrated.root.properties.map((property) => [property.name, property] as const)
    );
    for (const property of persisted.root.properties) {
      const hydratedProperty = hydratedProperties.get(property.name);
      if (
        !hydratedProperty ||
        canonicalStringify(hydratedProperty) !== canonicalStringify(property)
      ) {
        throw new DesiredStatePlanDecodeError(
          `Persisted status field ${property.name} is absent or differs in hydrated status.`,
          `${path}.persistedSchema`
        );
      }
    }
  }
  array(status.projections, `${path}.projections`).forEach((projectionValue, index) => {
    const projection = record(projectionValue, `${path}.projections[${index}]`);
    string(projection.path, `${path}.projections[${index}].path`);
    if (
      !['live-resource', 'desired-spec', 'static', 'derived', 'client-only'].includes(
        String(projection.source)
      )
    ) {
      throw new DesiredStatePlanDecodeError(
        `Invalid status source.`,
        `${path}.projections[${index}].source`
      );
    }
    if (!['auto', 'native', 'relay', 'client-only'].includes(String(projection.mode))) {
      throw new DesiredStatePlanDecodeError(
        `Invalid status mode.`,
        `${path}.projections[${index}].mode`
      );
    }
    if (projection.persistedPath !== undefined) {
      string(projection.persistedPath, `${path}.projections[${index}].persistedPath`);
    }
    if (projection.value !== undefined) {
      planValue(projection.value, `${path}.projections[${index}].value`);
    }
    if (
      (projection.mode === 'native' || projection.mode === 'relay') &&
      projection.persistedPath === undefined
    ) {
      throw new DesiredStatePlanDecodeError(
        `Persisted status projection requires persistedPath.`,
        `${path}.projections[${index}]`
      );
    }
  });
}

function artifactRequirement(value: unknown, path: string): void {
  const requirement = record(value, path);
  string(requirement.kind, `${path}.kind`);
  string(requirement.id, `${path}.id`);
  planValue(requirement.descriptor, `${path}.descriptor`);
  const outputs = array(requirement.outputs, `${path}.outputs`).map((entry, index) =>
    string(entry, `${path}.outputs[${index}]`)
  );
  if (new Set(outputs).size !== outputs.length) {
    throw new DesiredStatePlanDecodeError(`Artifact outputs must be unique.`, `${path}.outputs`);
  }
}

function validateSemanticPlan(plan: UnknownRecord): void {
  if (plan.version !== SEMANTIC_PLAN_VERSION) {
    throw new DesiredStatePlanDecodeError(
      `Unsupported semantic plan version ${String(plan.version)}.`,
      '$.version'
    );
  }
  compositionIdentity(plan.composition, '$.composition');
  const schemas = record(plan.schemas, '$.schemas');
  if (schemas.irVersion !== 1) {
    throw new DesiredStatePlanDecodeError(`Unsupported schema IR version.`, '$.schemas.irVersion');
  }
  schema(schemas.spec, '$.schemas.spec');
  const specSchema = schemas.spec as SchemaIR;
  if (schemas.specDigest !== specSchema.digest) {
    throw new DesiredStatePlanDecodeError(`Spec schema digest mismatch.`, '$.schemas.specDigest');
  }
  statusContract(plan.status, '$.status');
  const status = plan.status as DesiredStatePlan['status'];
  if (schemas.persistedStatusDigest !== status.persistedSchema.digest) {
    throw new DesiredStatePlanDecodeError(
      `Persisted status schema digest mismatch.`,
      '$.schemas.persistedStatusDigest'
    );
  }
  if (schemas.hydratedStatusDigest !== status.hydratedSchema.digest) {
    throw new DesiredStatePlanDecodeError(
      `Hydrated status schema digest mismatch.`,
      '$.schemas.hydratedStatusDigest'
    );
  }
  const instance = record(plan.instance, '$.instance');
  string(instance.composition, '$.instance.composition');
  planValue(instance.name, '$.instance.name');
  planValue(plan.spec, '$.spec');

  const nodeIds = new Set<string>();
  array(plan.nodes, '$.nodes').forEach((entry, index) => {
    const id = node(entry, `$.nodes[${index}]`);
    if (nodeIds.has(id)) {
      throw new DesiredStatePlanDecodeError(`Duplicate plan node ${id}.`, `$.nodes[${index}].id`);
    }
    nodeIds.add(id);
  });
  const seenEdges = new Set<string>();
  array(plan.edges, '$.edges').forEach((entry, index) => {
    edge(entry, `$.edges[${index}]`, nodeIds);
    const encoded = canonicalStringify(entry);
    if (seenEdges.has(encoded)) {
      throw new DesiredStatePlanDecodeError(`Duplicate plan edge.`, `$.edges[${index}]`);
    }
    seenEdges.add(encoded);
  });

  const outputs = record(plan.outputs, '$.outputs');
  Object.entries(outputs).forEach(([key, value]) => planValue(value, `$.outputs.${key}`));
  const artifactRequirementIds = new Set<string>();
  array(plan.inputs, '$.inputs').forEach((entryValue, index) => {
    const entry = record(entryValue, `$.inputs[${index}]`);
    string(entry.name, `$.inputs[${index}].name`);
    if (entry.kind === 'ordinary') {
      planValue(entry.value, `$.inputs[${index}].value`);
    } else if (entry.kind === 'sensitive') {
      string(entry.binding, `$.inputs[${index}].binding`);
      if (entry.version !== undefined) string(entry.version, `$.inputs[${index}].version`);
    } else if (entry.kind === 'artifact') {
      artifactRequirement(entry.requirement, `$.inputs[${index}].requirement`);
      const id = (entry.requirement as UnknownRecord).id as string;
      if (artifactRequirementIds.has(id)) {
        throw new DesiredStatePlanDecodeError(
          `Duplicate artifact requirement ${id}.`,
          `$.inputs[${index}].requirement.id`
        );
      }
      artifactRequirementIds.add(id);
    } else {
      throw new DesiredStatePlanDecodeError(`Invalid input kind.`, `$.inputs[${index}].kind`);
    }
  });
  array(plan.aspects, '$.aspects').forEach((entryValue, index) => {
    const entry = record(entryValue, `$.aspects[${index}]`);
    string(entry.id, `$.aspects[${index}].id`);
    string(entry.revision, `$.aspects[${index}].revision`);
    integer(entry.order, `$.aspects[${index}].order`);
    if (entry.order !== index) {
      throw new DesiredStatePlanDecodeError(
        `Aspect order must be contiguous and match array order.`,
        `$.aspects[${index}].order`
      );
    }
    planValue(entry.configuration, `$.aspects[${index}].configuration`);
  });
  array(plan.representationRequirements, '$.representationRequirements').forEach(
    (entryValue, index) => {
      const entry = record(entryValue, `$.representationRequirements[${index}]`);
      if (entry.target !== 'direct' && entry.target !== 'kro') {
        throw new DesiredStatePlanDecodeError(
          `Invalid representation target.`,
          `$.representationRequirements[${index}].target`
        );
      }
      string(entry.kind, `$.representationRequirements[${index}].kind`);
      string(entry.extension, `$.representationRequirements[${index}].extension`);
      integer(entry.version, `$.representationRequirements[${index}].version`, 1);
      planValue(entry.inputs, `$.representationRequirements[${index}].inputs`);
      if (entry.sourceNodeId !== undefined) {
        const sourceNodeId = string(
          entry.sourceNodeId,
          `$.representationRequirements[${index}].sourceNodeId`
        );
        if (!nodeIds.has(sourceNodeId)) {
          throw new DesiredStatePlanDecodeError(
            `Representation requirement references unknown node ${sourceNodeId}.`,
            `$.representationRequirements[${index}].sourceNodeId`
          );
        }
      }
      if (entry.factoryName !== undefined) {
        string(entry.factoryName, `$.representationRequirements[${index}].factoryName`);
      }
    }
  );
  const provenance = record(plan.provenance, '$.provenance');
  array(provenance.canonicalizers, '$.provenance.canonicalizers').forEach((entryValue, index) => {
    const entry = record(entryValue, `$.provenance.canonicalizers[${index}]`);
    string(entry.id, `$.provenance.canonicalizers[${index}].id`);
    string(entry.revision, `$.provenance.canonicalizers[${index}].revision`);
    if (entry.stage !== 'desired') {
      throw new DesiredStatePlanDecodeError(
        `Invalid canonicalizer stage.`,
        `$.provenance.canonicalizers[${index}].stage`
      );
    }
    if (entry.factoryName !== undefined) {
      string(entry.factoryName, `$.provenance.canonicalizers[${index}].factoryName`);
    }
  });
  array(plan.requiredCapabilities, '$.requiredCapabilities').forEach((entry, index) =>
    capability(entry, `$.requiredCapabilities[${index}]`)
  );
  const durability = record(plan.durability, '$.durability');
  if (
    typeof durability.cacheEligible !== 'boolean' ||
    typeof durability.provenanceEligible !== 'boolean'
  ) {
    throw new DesiredStatePlanDecodeError(`Invalid durability eligibility.`, '$.durability');
  }
  diagnostics(durability.reasons, '$.durability.reasons');
  diagnostics(plan.diagnostics, '$.diagnostics');

  const inputDigest = string(plan.inputDigest, '$.inputDigest');
  const aspectDigest = string(plan.aspectDigest, '$.aspectDigest');
  const semanticContentDigest = string(plan.semanticContentDigest, '$.semanticContentDigest');
  const planIdentityDigest = string(plan.planIdentityDigest, '$.planIdentityDigest');
  if (canonicalDigest(plan.inputs) !== inputDigest) {
    throw new DesiredStatePlanDecodeError(`Input digest mismatch.`, '$.inputDigest');
  }
  if (canonicalDigest(plan.aspects) !== aspectDigest) {
    throw new DesiredStatePlanDecodeError(`Aspect digest mismatch.`, '$.aspectDigest');
  }
  const semanticPayload = {
    version: 1,
    schemas: {
      specDigest: schemas.specDigest,
      persistedStatusDigest: schemas.persistedStatusDigest,
      hydratedStatusDigest: schemas.hydratedStatusDigest,
    },
    instance: plan.instance,
    spec: plan.spec,
    nodes: plan.nodes,
    edges: plan.edges,
    outputs: plan.outputs,
    inputs: plan.inputs,
    aspects: plan.aspects,
    representationRequirements: plan.representationRequirements,
    canonicalizers: provenance.canonicalizers,
    requiredCapabilities: plan.requiredCapabilities,
  };
  if (canonicalDigest(semanticPayload) !== semanticContentDigest) {
    throw new DesiredStatePlanDecodeError(
      `Semantic content digest mismatch.`,
      '$.semanticContentDigest'
    );
  }
  if (
    canonicalDigest({ composition: plan.composition, semanticContentDigest }) !== planIdentityDigest
  ) {
    throw new DesiredStatePlanDecodeError(`Plan identity digest mismatch.`, '$.planIdentityDigest');
  }
}

/** Canonically encode a semantic desired-state plan. */
export function encodeDesiredStatePlan(plan: DesiredStatePlan): string {
  return canonicalStringify(plan);
}

/** Decode and validate a complete semantic desired-state plan. */
export function decodeDesiredStatePlan(encoded: string): DesiredStatePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error: unknown) {
    throw new DesiredStatePlanDecodeError(
      `Desired-state plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      '$'
    );
  }
  const plan = record(parsed, '$');
  validateSemanticPlan(plan);
  return plan as unknown as DesiredStatePlan;
}
