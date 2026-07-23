import {
  getMetadataField,
  setForEach,
  setIncludeWhen,
  setMetadataField,
  setReadinessEvaluator,
  setReadyWhen,
  setResourceId,
  setTemplateOverrides,
} from '../metadata/index.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import type { KubernetesResource, ReadinessEvaluator } from '../types/kubernetes.js';

import type {
  KroArtifactPlan,
  KroGraphChildArtifact,
  KroInstanceArtifact,
  KroSupportingArtifact,
} from './artifacts.js';
import {
  materializePlanValue,
  materializePlanValueForKro,
  type PlanMaterializationBindings,
} from './materialization.js';
import type { ReadinessStrategyIdentity } from './types.js';

/** Error raised when a KRO artifact cannot be adapted to the established serializer. */
export class KroArtifactRuntimeAdapterError extends Error {
  readonly code = 'KRO_ARTIFACT_ADAPTER_FAILED';

  constructor(
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'KroArtifactRuntimeAdapterError';
  }
}

function templateOverrideExpression(
  value: unknown,
  artifactId: string,
  index: number
): string {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    Reflect.get(value, CEL_EXPRESSION_BRAND) === true &&
    typeof Reflect.get(value, 'expression') === 'string'
  ) {
    return Reflect.get(value, 'expression') as string;
  }
  throw new KroArtifactRuntimeAdapterError(
    `KRO template override ${index} on ${artifactId} did not materialize to a CEL expression.`,
    { artifactId, index }
  );
}

function asResource(child: KroGraphChildArtifact): KubernetesResource {
  if (!child.desired) {
    throw new KroArtifactRuntimeAdapterError(
      `KRO graph child ${child.id} has no desired resource template.`,
      { artifactId: child.id, role: child.role }
    );
  }
  const desired = materializePlanValueForKro(child.desired, `$.resources.${child.id}.desired`);
  if (!desired || typeof desired !== 'object' || Array.isArray(desired)) {
    throw new KroArtifactRuntimeAdapterError(
      `KRO graph child ${child.id} did not materialize to a Kubernetes resource.`,
      { artifactId: child.id }
    );
  }
  const resource = desired as KubernetesResource;
  if (
    typeof resource.apiVersion !== 'string' ||
    typeof resource.kind !== 'string' ||
    !resource.metadata ||
    !Object.hasOwn(resource.metadata, 'name')
  ) {
    throw new KroArtifactRuntimeAdapterError(
      `KRO graph child ${child.id} is missing Kubernetes identity fields.`,
      { artifactId: child.id }
    );
  }

  Reflect.set(resource, 'id', child.sourceNodeId ?? child.id);
  setResourceId(resource, child.id);
  if (child.identity?.scope) setMetadataField(resource, 'scope', child.identity.scope);
  if (child.role === 'kro-external-reference') {
    Object.defineProperty(resource, '__externalRef', { value: true, enumerable: false });
  }
  if (child.readiness.activation.length > 0) {
    setIncludeWhen(
      resource,
      child.readiness.activation.map((condition, index) =>
        materializePlanValueForKro(
          condition,
          `$.resources.${child.id}.readiness.activation[${index}]`
        )
      )
    );
  }
  if (child.readiness.readyWhen.length > 0) {
    setReadyWhen(
      resource,
      child.readiness.readyWhen.map((condition, index) =>
        materializePlanValueForKro(
          condition,
          `$.resources.${child.id}.readiness.readyWhen[${index}]`
        )
      )
    );
  }
  if (child.iteration && child.iteration.length > 0) {
    const dimensions = child.iteration.map((dimension, index) => {
      if (
        dimension.collection.kind !== 'expression' ||
        dimension.collection.expression.language !== 'portable-cel'
      ) {
        throw new KroArtifactRuntimeAdapterError(
          `KRO iteration ${index} on ${child.id} is not a portable collection expression.`,
          { artifactId: child.id, index }
        );
      }
      return {
        [dimension.variable]: `\${${dimension.collection.expression.expression}}`,
      };
    });
    setForEach(resource, dimensions);
  }
  if (child.templateOverrides && child.templateOverrides.length > 0) {
    setTemplateOverrides(
      resource,
      child.templateOverrides.map((override, index) => {
        const value = materializePlanValueForKro(
          override.value,
          `$.resources.${child.id}.templateOverrides[${index}].value`
        );
        return {
          propertyPath: override.propertyPath,
          celExpression: templateOverrideExpression(value, child.id, index),
        };
      })
    );
  }
  return resource;
}

/** Adapt the compiled KRO graph children to the established RGD serializer input. */
export function kroArtifactPlanToGraphResources(
  artifacts: KroArtifactPlan
): Record<string, KubernetesResource> {
  const rgd = artifacts.resources.find((resource) => resource.role === 'resource-graph-definition');
  if (!rgd || rgd.role !== 'resource-graph-definition') {
    throw new KroArtifactRuntimeAdapterError('KRO artifact plan has no graph definition artifact.');
  }
  const resources = Object.fromEntries(
    rgd.graph.children.map((child) => [child.id, asResource(child)] as const)
  );
  for (const edge of rgd.graph.edges) {
    if (edge.kind !== 'ready') continue;
    const dependent = resources[edge.dependent];
    if (!dependent || !resources[edge.prerequisite]) continue;
    const existing = getMetadataField(dependent, 'dependsOn') as
      | Array<{ resourceId: string }>
      | undefined;
    setMetadataField(dependent, 'dependsOn', [
      ...(existing ?? []),
      { resourceId: edge.prerequisite },
    ]);
  }
  return resources;
}

function instanceArtifact(artifacts: KroArtifactPlan): KroInstanceArtifact {
  const instance = artifacts.resources.find(
    (resource): resource is KroInstanceArtifact => resource.role === 'instance'
  );
  if (!instance) {
    throw new KroArtifactRuntimeAdapterError('KRO artifact plan has no instance artifact.');
  }
  return instance;
}

/** Materialize the physical KRO custom-resource instance from canonical artifact data. */
export function kroArtifactPlanToInstanceResource(
  artifacts: KroArtifactPlan,
  bindings: PlanMaterializationBindings = {}
): KubernetesResource {
  const instance = instanceArtifact(artifacts);
  const desired = materializePlanValue(
    instance.desired,
    bindings,
    `$.resources.${instance.id}.desired`
  );
  if (!desired || typeof desired !== 'object' || Array.isArray(desired)) {
    throw new KroArtifactRuntimeAdapterError(
      `KRO instance ${instance.id} did not materialize to a Kubernetes resource.`,
      { artifactId: instance.id }
    );
  }
  const resource = desired as KubernetesResource;
  if (
    typeof resource.apiVersion !== 'string' ||
    typeof resource.kind !== 'string' ||
    typeof resource.metadata?.name !== 'string'
  ) {
    throw new KroArtifactRuntimeAdapterError(
      `KRO instance ${instance.id} is missing concrete Kubernetes identity fields.`,
      { artifactId: instance.id }
    );
  }
  setResourceId(resource, instance.id);
  setMetadataField(resource, 'scope', 'namespaced');
  return resource;
}

/** One directly managed supporting operation reconstructed from a KRO artifact plan. */
export interface MaterializedKroSupportingArtifact {
  readonly artifact: KroSupportingArtifact;
  readonly resource: KubernetesResource;
}

export interface KroSupportingArtifactMaterializationOptions extends PlanMaterializationBindings {
  readonly readinessEvaluators?: Readonly<Record<string, ReadinessEvaluator<unknown>>>;
  readonly resolveReadinessStrategy?: (
    strategy: Extract<ReadinessStrategyIdentity, { kind: 'registered' }>
  ) => ReadinessEvaluator<unknown> | undefined;
}

function orderedSupportingArtifacts(artifacts: KroArtifactPlan): KroSupportingArtifact[] {
  const supporting = artifacts.resources.filter(
    (artifact): artifact is KroSupportingArtifact =>
      artifact.role === 'kro-prerequisite' ||
      artifact.role === 'hoisted-namespace' ||
      artifact.role === 'singleton-owner'
  );
  const byId = new Map(supporting.map((artifact) => [artifact.id, artifact]));
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map(supporting.map((artifact) => [artifact.id, 0]));
  for (const edge of artifacts.edges) {
    if (edge.kind !== 'existence' && edge.kind !== 'ready') continue;
    if (!byId.has(edge.prerequisite) || !byId.has(edge.dependent)) continue;
    const targets = dependents.get(edge.prerequisite) ?? new Set<string>();
    if (targets.has(edge.dependent)) continue;
    targets.add(edge.dependent);
    dependents.set(edge.prerequisite, targets);
    indegree.set(edge.dependent, (indegree.get(edge.dependent) ?? 0) + 1);
  }
  const ready = [...supporting]
    .filter((artifact) => indegree.get(artifact.id) === 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  const ordered: KroSupportingArtifact[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    ordered.push(current);
    for (const dependent of [...(dependents.get(current.id) ?? [])].sort()) {
      const nextIndegree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, nextIndegree);
      if (nextIndegree === 0) {
        const dependentArtifact = byId.get(dependent);
        if (!dependentArtifact) {
          throw new KroArtifactRuntimeAdapterError(
            `KRO supporting artifact ${dependent} is missing from the artifact index.`,
            { artifactId: dependent }
          );
        }
        ready.push(dependentArtifact);
        ready.sort((left, right) => left.id.localeCompare(right.id));
      }
    }
  }
  if (ordered.length !== supporting.length) {
    throw new KroArtifactRuntimeAdapterError(
      'KRO supporting artifact dependency graph contains a cycle.'
    );
  }
  return ordered;
}

/** Materialize prerequisites, hoisted namespaces, and singleton owners from canonical data. */
export function kroArtifactPlanToSupportingResources(
  artifacts: KroArtifactPlan,
  options: KroSupportingArtifactMaterializationOptions = {}
): readonly MaterializedKroSupportingArtifact[] {
  return orderedSupportingArtifacts(artifacts).map((artifact) => {
    if (!artifact.desired) {
      throw new KroArtifactRuntimeAdapterError(
        `KRO supporting artifact ${artifact.id} has no desired resource.`,
        { artifactId: artifact.id, role: artifact.role }
      );
    }
    const desired = materializePlanValue(
      artifact.desired,
      options,
      `$.resources.${artifact.id}.desired`
    );
    if (!desired || typeof desired !== 'object' || Array.isArray(desired)) {
      throw new KroArtifactRuntimeAdapterError(
        `KRO supporting artifact ${artifact.id} did not materialize to a Kubernetes resource.`,
        { artifactId: artifact.id, role: artifact.role }
      );
    }
    const resource = desired as KubernetesResource;
    if (
      typeof resource.apiVersion !== 'string' ||
      typeof resource.kind !== 'string' ||
      typeof resource.metadata?.name !== 'string'
    ) {
      throw new KroArtifactRuntimeAdapterError(
        `KRO supporting artifact ${artifact.id} is missing concrete Kubernetes identity fields.`,
        { artifactId: artifact.id, role: artifact.role }
      );
    }
    Object.defineProperty(resource, 'id', {
      value: artifact.id,
      configurable: true,
      enumerable: false,
    });
    setResourceId(resource, artifact.id);
    if (artifact.identity?.scope) {
      setMetadataField(resource, 'scope', artifact.identity.scope);
    }
    setMetadataField(resource, 'applyPolicy', artifact.apply);
    const strategy = artifact.readiness.strategy;
    if (strategy?.kind === 'runtime-binding') {
      const evaluator = options.readinessEvaluators?.[strategy.binding];
      if (!evaluator) {
        throw new KroArtifactRuntimeAdapterError(
          `Readiness binding ${strategy.binding} is not materialized.`,
          { artifactId: artifact.id, binding: strategy.binding }
        );
      }
      setReadinessEvaluator(resource, evaluator);
    } else if (strategy?.kind === 'registered') {
      const evaluator = options.resolveReadinessStrategy?.(strategy);
      if (!evaluator) {
        throw new KroArtifactRuntimeAdapterError(
          `Registered readiness strategy ${strategy.id}@${strategy.revision} is unavailable.`,
          { artifactId: artifact.id, strategy: strategy.id }
        );
      }
      setReadinessEvaluator(resource, evaluator);
    }
    return { artifact, resource };
  });
}
