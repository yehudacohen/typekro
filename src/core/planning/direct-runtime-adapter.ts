import { toCamelCase } from '../../utils/string.js';
import { materializeValuesMergeExpressions } from '../aspects/values-merge.js';
import { DependencyGraph } from '../dependencies/graph.js';
import { TypeKroError } from '../errors.js';
import {
  copyResourceMetadata,
  setMetadataField,
  setReadinessEvaluator,
  setResourceId,
} from '../metadata/index.js';
import type { DeploymentResourceGraph } from '../types/deployment.js';
import type {
  DeployableK8sResource,
  Enhanced,
  KubernetesResource,
  ReadinessEvaluator,
} from '../types/kubernetes.js';

import type {
  DirectKubernetesArtifactPlan,
  DirectKubernetesArtifactResource,
} from './artifacts.js';
import {
  evaluatePlanActivation,
  materializePlanValue,
  type PlanMaterializationBindings,
} from './materialization.js';

export interface DirectArtifactRuntimeAdapterOptions extends PlanMaterializationBindings {
  readonly instanceName: string;
  /** Compatibility name used by the established direct deployment graph. */
  readonly graphName?: string;
  /**
   * Runtime graph-node aliases keyed by canonical artifact id. These preserve
   * existing deployment-state identities while artifact ids remain the
   * host-independent semantic authority.
   */
  readonly graphIdsByArtifactId?: Readonly<Record<string, string>>;
  /** Include compiler-generated prerequisite/singleton operations in this graph. */
  readonly includeSupportingArtifacts?: boolean;
  /**
   * Optional same-process resources keyed by semantic node id. Their function-valued
   * readiness metadata is copied while factories migrate to serializable strategies.
   */
  readonly runtimeResources?: Readonly<Record<string, KubernetesResource>>;
  /** Named runtime evaluator bindings required by non-portable readiness strategies. */
  readonly readinessEvaluators?: Readonly<Record<string, ReadinessEvaluator<unknown>>>;
  /** Resolve a registered portable readiness strategy by its stable identity. */
  readonly resolveReadinessStrategy?: (
    strategy: Extract<
      NonNullable<DirectKubernetesArtifactResource['readiness']['strategy']>,
      { kind: 'registered' }
    >
  ) => ReadinessEvaluator<unknown> | undefined;
}

export class DirectArtifactRuntimeAdapterError extends TypeKroError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'DIRECT_ARTIFACT_ADAPTER_FAILED', details);
    this.name = 'DirectArtifactRuntimeAdapterError';
  }
}

function isAppliedArtifact(
  artifact: DirectKubernetesArtifactResource
): artifact is Extract<
  DirectKubernetesArtifactResource,
  { role: 'application-resource' | 'singleton-owner' | 'direct-prerequisite' }
> {
  return (
    artifact.role === 'application-resource' ||
    artifact.role === 'singleton-owner' ||
    artifact.role === 'direct-prerequisite'
  );
}

function isArtifactActive(
  artifact: DirectKubernetesArtifactResource,
  options: DirectArtifactRuntimeAdapterOptions
): boolean {
  return artifact.readiness.activation.every((condition, index) => {
    const active = evaluatePlanActivation(
      condition,
      options,
      `$.resources.${artifact.id}.readiness.activation[${index}]`
    );
    return active !== false;
  });
}

interface ExpandedArtifactBinding {
  readonly bindings: DirectArtifactRuntimeAdapterOptions;
  readonly coordinates: Readonly<Record<string, number>>;
}

interface ExpandedArtifactInstance extends ExpandedArtifactBinding {
  readonly artifact: DirectKubernetesArtifactResource;
  readonly graphId: string;
  readonly logicalId: string;
}

function expandArtifactBindings(
  artifact: DirectKubernetesArtifactResource,
  options: DirectArtifactRuntimeAdapterOptions
): ExpandedArtifactBinding[] {
  let expanded: ExpandedArtifactBinding[] = [{ bindings: options, coordinates: {} }];
  for (const [dimensionIndex, dimension] of (artifact.iteration ?? []).entries()) {
    expanded = expanded.flatMap((state) => {
      const collection = materializePlanValue(
        dimension.collection,
        state.bindings,
        `$.resources.${artifact.id}.iteration[${dimensionIndex}].collection`
      );
      if (!Array.isArray(collection)) {
        throw new DirectArtifactRuntimeAdapterError(
          `Iteration ${dimension.variable} on ${artifact.id} did not materialize to an array.`,
          {
            artifactId: artifact.id,
            dimension: dimension.variable,
            resultType: collection === null ? 'null' : typeof collection,
          }
        );
      }
      return collection.map((item, itemIndex) => ({
        bindings: {
          ...state.bindings,
          locals: { ...(state.bindings.locals ?? {}), [dimension.variable]: item },
          iterationItems: {
            ...(state.bindings.iterationItems ?? {}),
            [dimension.itemPath]: item,
          },
        },
        coordinates: { ...state.coordinates, [dimension.itemPath]: itemIndex },
      }));
    });
  }
  return expanded;
}

export function materializeDirectArtifactManifest(
  artifact: DirectKubernetesArtifactResource,
  options: DirectArtifactRuntimeAdapterOptions,
  deployedId: string,
  logicalId = artifact.sourceNodeId ?? artifact.id
): KubernetesResource {
  if (!artifact.desired) {
    throw new DirectArtifactRuntimeAdapterError(
      `Applied artifact ${artifact.id} has no desired Kubernetes manifest.`,
      { artifactId: artifact.id, role: artifact.role }
    );
  }
  const value = materializeValuesMergeExpressions(
    materializePlanValue(artifact.desired, options, `$.resources.${artifact.id}.desired`)
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DirectArtifactRuntimeAdapterError(
      `Applied artifact ${artifact.id} did not materialize to a Kubernetes object.`,
      { artifactId: artifact.id }
    );
  }
  const manifest = { ...(value as KubernetesResource), id: deployedId };
  if (artifact.role === 'external-reference' && artifact.identity) {
    const name = materializePlanValue(
      artifact.identity.name,
      options,
      `$.resources.${artifact.id}.identity.name`
    );
    if (typeof name !== 'string' || name.length === 0) {
      throw new DirectArtifactRuntimeAdapterError(
        `External reference ${artifact.id} did not materialize a Kubernetes name.`,
        { artifactId: artifact.id }
      );
    }
    const namespace = artifact.identity.namespace
      ? materializePlanValue(
          artifact.identity.namespace,
          options,
          `$.resources.${artifact.id}.identity.namespace`
        )
      : undefined;
    if (namespace !== undefined && (typeof namespace !== 'string' || namespace.length === 0)) {
      throw new DirectArtifactRuntimeAdapterError(
        `External reference ${artifact.id} did not materialize a valid Kubernetes namespace.`,
        { artifactId: artifact.id }
      );
    }
    const metadata = {
      ...manifest.metadata,
      name,
    };
    if (namespace !== undefined) {
      metadata.namespace = namespace;
    } else {
      delete metadata.namespace;
    }
    manifest.metadata = metadata;
  }
  // Template overrides compensate for JavaScript branches that must remain
  // symbolic in a KRO template. Direct planning executes with a concrete spec,
  // so `desired` already contains the selected branch and is authoritative.
  if (
    typeof manifest.apiVersion !== 'string' ||
    typeof manifest.kind !== 'string' ||
    !manifest.metadata ||
    typeof manifest.metadata.name !== 'string'
  ) {
    throw new DirectArtifactRuntimeAdapterError(
      `Applied artifact ${artifact.id} is missing Kubernetes identity fields.`,
      { artifactId: artifact.id }
    );
  }

  const runtimeResource = options.runtimeResources?.[artifact.sourceNodeId ?? artifact.id];
  if (runtimeResource) {
    copyResourceMetadata(runtimeResource, manifest, {
      exclude: ['readinessEvaluator', 'includeWhen', 'readyWhen', 'forEach', 'templateOverrides'],
    });
  }
  setResourceId(manifest, logicalId);
  if (artifact.identity?.scope) setMetadataField(manifest, 'scope', artifact.identity.scope);
  if (isAppliedArtifact(artifact)) setMetadataField(manifest, 'applyPolicy', artifact.apply);
  const readinessStrategy = artifact.readiness.strategy;
  if (readinessStrategy?.kind === 'runtime-binding') {
    const evaluator = options.readinessEvaluators?.[readinessStrategy.binding];
    if (!evaluator) {
      throw new DirectArtifactRuntimeAdapterError(
        `Readiness binding ${readinessStrategy.binding} is not materialized.`,
        { artifactId: artifact.id, binding: readinessStrategy.binding }
      );
    }
    setReadinessEvaluator(manifest, evaluator);
  } else if (readinessStrategy?.kind === 'registered') {
    const evaluator = options.resolveReadinessStrategy?.(readinessStrategy);
    if (!evaluator) {
      throw new DirectArtifactRuntimeAdapterError(
        `Registered readiness strategy ${readinessStrategy.id}@${readinessStrategy.revision} is unavailable.`,
        { artifactId: artifact.id, strategy: readinessStrategy.id }
      );
    }
    setReadinessEvaluator(manifest, evaluator);
  }
  if (artifact.readiness.activation.length > 0) {
    const runtimeActivation = artifact.readiness.activation.flatMap((condition, index) => {
      const active = evaluatePlanActivation(
        condition,
        options,
        `$.resources.${artifact.id}.readiness.activation[${index}]`
      );
      return active === undefined
        ? [
            materializePlanValue(
              condition,
              options,
              `$.resources.${artifact.id}.readiness.activation[${index}]`
            ),
          ]
        : [];
    });
    if (runtimeActivation.length > 0) {
      setMetadataField(manifest, 'includeWhen', runtimeActivation);
    }
  }
  if (artifact.readiness.readyWhen.length > 0) {
    setMetadataField(
      manifest,
      'readyWhen',
      artifact.readiness.readyWhen.map((condition, index) =>
        materializePlanValue(
          condition,
          options,
          `$.resources.${artifact.id}.readiness.readyWhen[${index}]`
        )
      )
    );
  }
  if (artifact.lifecycle.instancing.kind === 'per-scope') {
    const scopeKey = materializePlanValue(
      artifact.lifecycle.instancing.key,
      options,
      `$.resources.${artifact.id}.lifecycle.instancing.key`
    );
    if (typeof scopeKey === 'string' && scopeKey.length > 0) {
      setMetadataField(manifest, 'scopes', scopeKey.split('|').filter(Boolean));
    }
  }
  return manifest;
}

/**
 * Adapt a host-independent direct artifact plan into the graph consumed by the
 * established direct deployment engine. No Kubernetes calls occur here.
 */
export function directArtifactPlanToResourceGraph(
  plan: DirectKubernetesArtifactPlan,
  options: DirectArtifactRuntimeAdapterOptions
): DeploymentResourceGraph {
  if (plan.target !== 'direct') {
    throw new DirectArtifactRuntimeAdapterError(`Expected a direct artifact plan.`, {
      target: Reflect.get(plan, 'target'),
    });
  }
  if (plan.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new DirectArtifactRuntimeAdapterError(
      `Direct artifact plan contains compilation errors.`,
      { diagnostics: plan.diagnostics }
    );
  }

  const dependencyGraph = new DependencyGraph();
  const resources: DeploymentResourceGraph['resources'] = [];
  const externalReferences: NonNullable<DeploymentResourceGraph['externalReferences']> = [];
  // External references are never applied, so they get no dependency-graph node. Their ordering
  // requirement is recorded alongside them instead: the engine reads them after these graph ids
  // have been applied and are ready.
  const externalReferenceDependencies = new Map<string, Set<string>>();
  const externalReferenceIdsByArtifactId = new Map<string, string[]>();
  const instancesByArtifactId = new Map<string, ExpandedArtifactInstance[]>();
  const includedArtifacts = plan.resources.filter(
    (artifact) =>
      (isAppliedArtifact(artifact) || artifact.role === 'external-reference') &&
      (options.includeSupportingArtifacts !== false ||
        artifact.role === 'application-resource' ||
        artifact.role === 'external-reference')
  );
  for (const artifact of includedArtifacts) {
    const baseLogicalId = artifact.sourceNodeId ?? artifact.id;
    const expanded = expandArtifactBindings(artifact, options)
      .filter((state) => isArtifactActive(artifact, state.bindings))
      .map((state, ordinal): ExpandedArtifactInstance => {
        const suffix = ordinal === 0 ? '' : `-${ordinal}`;
        const logicalId = `${baseLogicalId}${suffix}`;
        const configuredGraphId =
          ordinal === 0 ? options.graphIdsByArtifactId?.[artifact.id] : undefined;
        const graphId =
          configuredGraphId ??
          toCamelCase(
            `${options.instanceName}-${artifact.role === 'external-reference' ? 'external' : 'resource'}-${artifact.id}${suffix}`
          );
        return { ...state, artifact, graphId, logicalId };
      });
    if (instancesByArtifactId.has(artifact.id)) {
      throw new DirectArtifactRuntimeAdapterError(`Duplicate artifact id ${artifact.id}.`, {
        artifactId: artifact.id,
      });
    }
    instancesByArtifactId.set(artifact.id, expanded);
  }

  const matchingProducer = (
    consumer: ExpandedArtifactInstance,
    producers: readonly ExpandedArtifactInstance[]
  ): ExpandedArtifactInstance | undefined => {
    if (producers.length === 1) return producers[0];
    const matches = producers.filter((producer) => {
      const commonPaths = Object.keys(producer.coordinates).filter((path) =>
        Object.hasOwn(consumer.coordinates, path)
      );
      return (
        commonPaths.length > 0 &&
        commonPaths.every((path) => producer.coordinates[path] === consumer.coordinates[path])
      );
    });
    return matches.length === 1 ? matches[0] : undefined;
  };

  const bindingsFor = (
    instance: ExpandedArtifactInstance
  ): DirectArtifactRuntimeAdapterOptions => ({
    ...instance.bindings,
    resourceIds: Object.fromEntries(
      [...instancesByArtifactId.entries()].flatMap(([artifactId, producers]) => {
        const producer = matchingProducer(instance, producers);
        return producer ? [[artifactId, producer.logicalId] as const] : [];
      })
    ),
  });

  for (const instance of [...instancesByArtifactId.values()].flat()) {
    const { artifact, graphId, logicalId } = instance;
    if (!isAppliedArtifact(artifact)) continue;
    const manifest = materializeDirectArtifactManifest(
      artifact,
      bindingsFor(instance),
      graphId,
      logicalId
    );
    const deployable = manifest as DeployableK8sResource<Enhanced<unknown, unknown>>;
    dependencyGraph.addNode(graphId, deployable);
    resources.push({ id: graphId, manifest: deployable });
  }

  for (const instance of [...instancesByArtifactId.values()].flat()) {
    const { artifact, graphId, logicalId } = instance;
    if (artifact.role !== 'external-reference') continue;
    const manifest = materializeDirectArtifactManifest(
      artifact,
      bindingsFor(instance),
      graphId,
      logicalId
    );
    externalReferences.push({
      id: logicalId,
      manifest: manifest as DeployableK8sResource<Enhanced<unknown, unknown>>,
    });
    externalReferenceDependencies.set(logicalId, new Set());
    externalReferenceIdsByArtifactId.set(artifact.id, [
      ...(externalReferenceIdsByArtifactId.get(artifact.id) ?? []),
      logicalId,
    ]);
  }

  const pairedInstances = (
    prerequisites: readonly ExpandedArtifactInstance[],
    dependents: readonly ExpandedArtifactInstance[]
  ): ReadonlyArray<readonly [ExpandedArtifactInstance, ExpandedArtifactInstance]> => {
    const pairs: Array<readonly [ExpandedArtifactInstance, ExpandedArtifactInstance]> = [];
    for (const dependent of dependents) {
      const commonPaths = new Set(
        prerequisites.flatMap((prerequisite) =>
          Object.keys(prerequisite.coordinates).filter((path) =>
            Object.hasOwn(dependent.coordinates, path)
          )
        )
      );
      const matches =
        commonPaths.size === 0
          ? prerequisites
          : prerequisites.filter((prerequisite) =>
              [...commonPaths].every(
                (path) => prerequisite.coordinates[path] === dependent.coordinates[path]
              )
            );
      for (const prerequisite of matches) pairs.push([prerequisite, dependent]);
    }
    return pairs;
  };

  const normalizedEdges = plan.edges.flatMap((edge) => {
    const [prerequisiteArtifactId, dependentArtifactId] =
      edge.kind === 'output'
        ? [edge.producer, edge.consumer]
        : edge.kind === 'existence' || edge.kind === 'ready'
          ? [edge.prerequisite, edge.dependent]
          : edge.kind === 'ownership'
            ? [edge.owner, edge.child]
            : [undefined, undefined];
    return prerequisiteArtifactId && dependentArtifactId
      ? [{ prerequisiteArtifactId, dependentArtifactId } as const]
      : [];
  });

  const appliedInstances = (artifactId: string): readonly ExpandedArtifactInstance[] =>
    (instancesByArtifactId.get(artifactId) ?? []).filter((instance) =>
      isAppliedArtifact(instance.artifact)
    );

  // An edge that points at an external reference cannot become a graph edge — the reference has no
  // node to attach to, since it is read rather than applied. Record it as a read-ordering
  // requirement on the reference instead, so the engine can defer the live read until those
  // resources are applied and ready.
  for (const { prerequisiteArtifactId, dependentArtifactId } of normalizedEdges) {
    for (const referenceId of externalReferenceIdsByArtifactId.get(dependentArtifactId) ?? []) {
      const recorded = externalReferenceDependencies.get(referenceId);
      if (!recorded) continue;
      for (const prerequisite of appliedInstances(prerequisiteArtifactId)) {
        recorded.add(prerequisite.graphId);
      }
    }
  }

  for (const { prerequisiteArtifactId, dependentArtifactId } of normalizedEdges) {
    const prerequisites = appliedInstances(prerequisiteArtifactId);
    const dependents = appliedInstances(dependentArtifactId);
    // Consuming a deferred external reference means consuming whatever produces it, so the
    // consumer inherits the reference's own prerequisites. Without this it could be scheduled at a
    // level that runs before the reference has been read, and would resolve against nothing.
    for (const referenceId of externalReferenceIdsByArtifactId.get(prerequisiteArtifactId) ?? []) {
      for (const inherited of externalReferenceDependencies.get(referenceId) ?? []) {
        for (const dependent of dependents) {
          if (inherited !== dependent.graphId)
            dependencyGraph.addEdge(dependent.graphId, inherited);
        }
      }
    }
    for (const [prerequisite, dependent] of pairedInstances(prerequisites, dependents)) {
      if (prerequisite.graphId !== dependent.graphId) {
        dependencyGraph.addEdge(dependent.graphId, prerequisite.graphId);
      }
    }
  }

  for (const reference of externalReferences) {
    const dependencies = [...(externalReferenceDependencies.get(reference.id) ?? [])].sort();
    if (dependencies.length > 0) reference.dependsOn = dependencies;
  }

  return {
    name: options.graphName ?? `${options.instanceName}-direct-artifacts`,
    resources,
    ...(externalReferences.length > 0 ? { externalReferences } : {}),
    dependencyGraph,
  };
}
