import {
  isCelExpression,
  isKubernetesRef,
  isMixedTemplate,
  isResourceReference,
} from '../../utils/type-guards.js';
import { applyAspects } from '../aspects/apply.js';
import { DependencyResolver } from '../dependencies/index.js';
import { TypeKroError } from '../errors.js';
import { convertReadyWhenCallbackToCel } from '../expressions/analysis/ready-when.js';
import {
  copyResourceMetadata,
  getForEach,
  getMetadataField,
  getReadinessEvaluator,
  getResourceId,
  getResourceScope,
  getTemplateOverrides,
  setResourceId,
} from '../metadata/resource-metadata.js';
import {
  getPortableReadinessStrategy,
  getRuntimeReadinessClassification,
} from '../readiness/portable-strategies.js';
import {
  getFactoryRegistration,
  getFactoryRegistrationsForGVK,
  type FactoryRepresentationRequirement,
  type FactoryRegistration,
} from '../resources/factory-registry.js';
import type { DeploymentResourceGraph } from '../types/deployment.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from '../types/kubernetes.js';
import type { KroCompatibleType } from '../types/schema.js';

import { createAspectManifest } from './aspects.js';
import { canonicalDigest, canonicalStringify } from './canonical.js';
import type { CapturedCompositionRuntime } from './capture.js';
import { schemaToIR } from './schema.js';
import type {
  CanonicalizerManifestEntry,
  CapabilityRequirement,
  CompositionIdentity,
  CompositionInspection,
  DeclaredInputManifestEntry,
  DesiredStatePlan,
  KubernetesIdentity,
  LifecyclePolicy,
  PlanDiagnostic,
  PlanEdge,
  PlanIterationDimension,
  PlanNode,
  PlanOptions,
  PlanValue,
  RepresentationRequirement,
  SchemaIR,
  SchemaNodeIR,
  StatusContract,
  StatusProjection,
} from './types.js';
import { expressionIR, lowerPlanValue } from './values.js';

/** Error raised by strict semantic planning. */
export class SemanticPlanningError extends TypeKroError {
  constructor(message: string, diagnostics: readonly PlanDiagnostic[]) {
    super(message, 'SEMANTIC_PLANNING_FAILED', { diagnostics });
    this.name = 'SemanticPlanningError';
  }
}

function compositionIdentity<TSpec extends KroCompatibleType>(
  capture: CapturedCompositionRuntime<TSpec>
): CompositionIdentity {
  const diagnosticSourceDigest = canonicalDigest(capture.diagnosticSource);
  const revision = capture.ir.definition.revision;
  return revision
    ? {
        name: capture.ir.definition.name,
        apiVersion: capture.ir.definition.apiVersion,
        kind: capture.ir.definition.kind,
        stability: 'stable',
        revision: { kind: 'version', value: revision },
        diagnosticSourceDigest,
      }
    : {
        name: capture.ir.definition.name,
        apiVersion: capture.ir.definition.apiVersion,
        kind: capture.ir.definition.kind,
        stability: 'preview-unstable',
        diagnosticSourceDigest,
      };
}

interface ValueReferenceSummary {
  readonly resource: boolean;
  readonly spec: boolean;
  readonly sensitive: boolean;
}

function markNestedStatusReferences(
  value: PlanValue,
  nestedStatusMappings: Readonly<Record<string, string>>
): PlanValue {
  if (value.kind === 'sensitive-value') {
    return {
      ...value,
      value: markNestedStatusReferences(value.value, nestedStatusMappings),
    };
  }
  if (value.kind === 'reference') {
    if (value.source !== 'resource' || !value.resourceId || value.nestedComposition) return value;
    const fieldPath = value.fieldPath.replace(/^status\./, '');
    return Object.hasOwn(nestedStatusMappings, `__nestedStatus:${value.resourceId}:${fieldPath}`)
      ? { ...value, nestedComposition: true }
      : value;
  }
  if (value.kind === 'array') {
    return {
      ...value,
      items: value.items.map((item) => markNestedStatusReferences(item, nestedStatusMappings)),
    };
  }
  if (value.kind === 'object') {
    return {
      ...value,
      entries: value.entries.map((entry) => ({
        ...entry,
        value: markNestedStatusReferences(entry.value, nestedStatusMappings),
      })),
    };
  }
  if (value.kind === 'template') {
    return {
      ...value,
      segments: value.segments.map((segment) => {
        if (
          segment.kind !== 'reference' ||
          segment.source !== 'resource' ||
          !segment.resourceId ||
          segment.nestedComposition
        ) {
          return segment;
        }
        const fieldPath = segment.fieldPath.replace(/^status\./, '');
        return Object.hasOwn(
          nestedStatusMappings,
          `__nestedStatus:${segment.resourceId}:${fieldPath}`
        )
          ? { ...segment, nestedComposition: true as const }
          : segment;
      }),
    };
  }
  return value;
}

function summarizeValue(value: PlanValue): ValueReferenceSummary {
  switch (value.kind) {
    case 'sensitive-binding':
      return { resource: false, spec: false, sensitive: true };
    case 'sensitive-value': {
      const wrapped = summarizeValue(value.value);
      return { ...wrapped, sensitive: true };
    }
    case 'reference':
      return {
        resource: value.source === 'resource',
        spec: value.source === 'spec',
        sensitive: false,
      };
    case 'expression':
      return {
        resource: value.expression.references.some((reference) => reference.source === 'resource'),
        spec: value.expression.references.some((reference) => reference.source === 'spec'),
        sensitive: value.expression.sensitivity === 'sensitive',
      };
    case 'template':
      return {
        resource: value.segments.some(
          (segment) => segment.kind === 'reference' && segment.source === 'resource'
        ),
        spec: value.segments.some(
          (segment) => segment.kind === 'reference' && segment.source === 'spec'
        ),
        sensitive: false,
      };
    case 'array':
      return value.items.reduce<ValueReferenceSummary>(
        (summary, item) => {
          const child = summarizeValue(item);
          return {
            resource: summary.resource || child.resource,
            spec: summary.spec || child.spec,
            sensitive: summary.sensitive || child.sensitive,
          };
        },
        { resource: false, spec: false, sensitive: false }
      );
    case 'object':
      return value.entries.reduce<ValueReferenceSummary>(
        (summary, entry) => {
          const child = summarizeValue(entry.value);
          return {
            resource: summary.resource || child.resource,
            spec: summary.spec || child.spec,
            sensitive: summary.sensitive || child.sensitive,
          };
        },
        { resource: false, spec: false, sensitive: false }
      );
    default:
      return { resource: false, spec: false, sensitive: false };
  }
}

function specPathIsSensitive(fieldPath: string, sensitivePaths: ReadonlySet<string>): boolean {
  for (const sensitivePath of sensitivePaths) {
    if (
      fieldPath === sensitivePath ||
      fieldPath.startsWith(`${sensitivePath}.`) ||
      sensitivePath.startsWith(`${fieldPath}.`)
    ) {
      return true;
    }
  }
  return false;
}

function markSensitiveSpecReferences(
  value: PlanValue,
  sensitivePaths: ReadonlySet<string>
): PlanValue {
  if (sensitivePaths.size === 0 || value.kind === 'sensitive-binding') return value;
  if (value.kind === 'sensitive-value') return value;
  if (
    value.kind === 'reference' &&
    value.source === 'spec' &&
    specPathIsSensitive(value.fieldPath, sensitivePaths)
  ) {
    return { kind: 'sensitive-value', value };
  }
  if (
    value.kind === 'expression' &&
    value.expression.references.some(
      (reference) =>
        reference.source === 'spec' && specPathIsSensitive(reference.fieldPath, sensitivePaths)
    )
  ) {
    return { kind: 'sensitive-value', value };
  }
  if (
    value.kind === 'template' &&
    value.segments.some(
      (segment) =>
        (segment.kind === 'reference' &&
          segment.source === 'spec' &&
          specPathIsSensitive(segment.fieldPath, sensitivePaths)) ||
        (segment.kind === 'expression' &&
          segment.expression.references.some(
            (reference) =>
              reference.source === 'spec' &&
              specPathIsSensitive(reference.fieldPath, sensitivePaths)
          ))
    )
  ) {
    return { kind: 'sensitive-value', value };
  }
  if (value.kind === 'array') {
    return {
      ...value,
      items: value.items.map((item) => markSensitiveSpecReferences(item, sensitivePaths)),
    };
  }
  if (value.kind === 'object') {
    return {
      ...value,
      entries: value.entries.map((entry) => ({
        ...entry,
        value: markSensitiveSpecReferences(entry.value, sensitivePaths),
      })),
    };
  }
  return value;
}

/**
 * Preserve symbolic leaves whose meaning cannot be recovered from an already
 * materialized manifest. Concrete object/array shape remains authoritative so
 * direct-only JavaScript branches and nested composition expansion are not
 * undone by the overlay.
 */
function preserveCapturedDynamicValue(
  concrete: PlanValue,
  captured: PlanValue,
  sensitivePaths: ReadonlySet<string>
): PlanValue {
  const symbolic = markSensitiveSpecReferences(captured, sensitivePaths);
  switch (symbolic.kind) {
    case 'sensitive-binding':
    case 'sensitive-value':
    case 'external-input':
    case 'artifact-output':
      return symbolic;
    case 'reference':
      return symbolic.source === 'resource' && symbolic.nestedComposition !== true
        ? symbolic
        : concrete;
    case 'expression':
      return symbolic.expression.references.some((reference) => reference.source === 'resource')
        ? symbolic
        : concrete;
    case 'template':
      return symbolic.segments.some(
        (segment) =>
          (segment.kind === 'reference' &&
            segment.source === 'resource' &&
            segment.nestedComposition !== true) ||
          (segment.kind === 'expression' &&
            segment.expression.references.some((reference) => reference.source === 'resource'))
      )
        ? symbolic
        : concrete;
    case 'array':
      return concrete.kind === 'array'
        ? {
            ...concrete,
            items: concrete.items.map((item, index) => {
              const capturedItem = symbolic.items[index];
              return capturedItem
                ? preserveCapturedDynamicValue(item, capturedItem, sensitivePaths)
                : item;
            }),
          }
        : concrete;
    case 'object': {
      if (concrete.kind !== 'object') return concrete;
      const capturedEntries = new Map(
        symbolic.entries.map((entry) => [entry.key, entry.value] as const)
      );
      return {
        ...concrete,
        entries: concrete.entries.map((entry) => {
          const capturedValue = capturedEntries.get(entry.key);
          return capturedValue
            ? {
                ...entry,
                value: preserveCapturedDynamicValue(entry.value, capturedValue, sensitivePaths),
              }
            : entry;
        }),
      };
    }
    default:
      return concrete;
  }
}

function statusProjections(
  statusMappings: Readonly<Record<string, unknown>>,
  diagnostics: PlanDiagnostic[],
  specSchema: SchemaIR,
  sensitiveSpecPaths: ReadonlySet<string> = new Set()
): {
  readonly outputs: Readonly<Record<string, PlanValue>>;
  readonly projections: StatusProjection[];
} {
  const outputs: Record<string, PlanValue> = {};
  const projections: StatusProjection[] = [];
  // Nested-composition analysis stores Maps and helper tables beside the user status mapping.
  // The established schema serializer already excludes this `__*` metadata; semantic planning
  // must apply the same boundary so strict value diagnostics do not mistake internal Maps for
  // user-authored status values.
  for (const key of Object.keys(statusMappings).filter((key) => !key.startsWith('__')).sort()) {
    const lowered = lowerPlanValue(statusMappings[key], { specSchema });
    const value = markSensitiveSpecReferences(lowered.value, sensitiveSpecPaths);
    outputs[key] = value;
    diagnostics.push(
      ...lowered.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: `$.outputs.${key}${diagnostic.path?.slice(1) ?? ''}`,
      }))
    );
    const summary = summarizeValue(value);
    const source: StatusProjection['source'] = summary.resource
      ? 'live-resource'
      : summary.spec
        ? 'desired-spec'
        : 'static';
    const native = summary.resource && !summary.spec && !summary.sensitive;
    projections.push({
      path: key,
      source,
      mode: native ? 'native' : 'client-only',
      ...(native ? { persistedPath: key } : {}),
      value,
    });
    if (summary.sensitive) {
      diagnostics.push({
        code: 'PLAN_STATUS_SENSITIVE',
        severity: 'error',
        message: `Status field ${key} derives from sensitive data and cannot be projected.`,
        path: `$.status.${key}`,
      });
    }
  }
  return { outputs, projections };
}

function filteredStatusSchema(schema: SchemaIR, persistedFields: ReadonlySet<string>): SchemaIR {
  if (schema.root.kind !== 'object') return schema;
  const root: SchemaNodeIR = {
    kind: 'object',
    properties: schema.root.properties.filter((property) => persistedFields.has(property.name)),
  };
  return {
    version: 1,
    root,
    digest: canonicalDigest({ version: 1, root }),
    diagnostics: schema.diagnostics,
  };
}

function buildStatusContract<TSpec extends KroCompatibleType>(
  capture: CapturedCompositionRuntime<TSpec>,
  diagnostics: PlanDiagnostic[],
  strict: boolean,
  specSchema: SchemaIR,
  sensitiveSpecPaths: ReadonlySet<string> = new Set()
): { readonly contract: StatusContract; readonly outputs: Readonly<Record<string, PlanValue>> } {
  const hydratedSchema = schemaToIR(capture.ir.definition.statusSchema, { strict: false });
  diagnostics.push(...hydratedSchema.diagnostics);
  const projected = statusProjections(
    capture.ir.statusMappings,
    diagnostics,
    specSchema,
    sensitiveSpecPaths
  );
  const persistedFields = new Set(
    projected.projections
      .filter((projection) => projection.mode === 'native' || projection.mode === 'relay')
      .map((projection) => projection.path.split('.')[0])
      .filter((field): field is string => field !== undefined)
  );
  const persistedSchema = filteredStatusSchema(hydratedSchema, persistedFields);
  if (strict && diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new SemanticPlanningError('Status contract is not portable.', diagnostics);
  }
  return {
    contract: {
      persistedSchema,
      hydratedSchema,
      projections: projected.projections,
    },
    outputs: projected.outputs,
  };
}

function inputManifest(
  options: PlanOptions,
  diagnostics: PlanDiagnostic[]
): DeclaredInputManifestEntry[] {
  const manifest: DeclaredInputManifestEntry[] = [];
  for (const name of Object.keys(options.inputs ?? {}).sort()) {
    const binding = options.inputs?.[name];
    if (!binding) continue;
    if (binding.kind === 'ordinary') {
      const lowered = lowerPlanValue(binding.value);
      diagnostics.push(
        ...lowered.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: `$.inputs.${name}${diagnostic.path?.slice(1) ?? ''}`,
        }))
      );
      if (lowered.sensitivity === 'sensitive') {
        diagnostics.push({
          code: 'PLAN_INPUT_KIND_MISMATCH',
          severity: 'error',
          message: `Ordinary input ${name} contains a sensitive binding; declare it as sensitive.`,
          path: `$.inputs.${name}`,
        });
      }
      manifest.push({ name, kind: 'ordinary', value: lowered.value });
    } else if (binding.kind === 'sensitive') {
      manifest.push({
        name,
        kind: 'sensitive',
        binding: binding.binding,
        ...(binding.version !== undefined ? { version: binding.version } : {}),
      });
    } else {
      manifest.push({ name, kind: 'artifact', requirement: binding.requirement });
    }
  }
  return manifest;
}

function cloneCanonicalizerInput<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (
    value === null ||
    typeof value !== 'object' ||
    isKubernetesRef(value) ||
    isCelExpression(value) ||
    isMixedTemplate(value) ||
    isResourceReference(value)
  ) {
    return value;
  }
  const prior = seen.get(value);
  if (prior) return prior as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    value.forEach((entry) => clone.push(cloneCanonicalizerInput(entry, seen)));
    return clone as T;
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const key of Object.keys(value)) {
    clone[key] = cloneCanonicalizerInput(Reflect.get(value, key), seen);
  }
  return clone as T;
}

function canonicalizeResource(
  resource: KubernetesResource,
  diagnostics: PlanDiagnostic[]
): {
  readonly resource: KubernetesResource;
  readonly canonicalizers: CanonicalizerManifestEntry[];
} {
  const registeredFactoryName = getMetadataField(resource, 'factoryName');
  const exactRegistration = registeredFactoryName
    ? getFactoryRegistration(registeredFactoryName)
    : undefined;
  const gvkRegistrations = getFactoryRegistrationsForGVK(resource.apiVersion, resource.kind);
  let registrations: readonly FactoryRegistration[];
  if (
    exactRegistration &&
    exactRegistration.apiVersion === resource.apiVersion &&
    exactRegistration.kind === resource.kind
  ) {
    registrations = [exactRegistration];
  } else {
    registrations = gvkRegistrations;
    if (registeredFactoryName) {
      diagnostics.push({
        code: 'PLAN_FACTORY_PROVENANCE_INVALID',
        severity: 'error',
        message: `Resource provenance names factory ${registeredFactoryName}, but it is not registered for ${resource.apiVersion}/${resource.kind}.`,
        path: '$.provenance.canonicalizers',
        details: { factoryName: registeredFactoryName },
      });
    } else if (gvkRegistrations.length > 1) {
      diagnostics.push({
        code: 'PLAN_FACTORY_PROVENANCE_AMBIGUOUS',
        severity: 'error',
        message: `${resource.apiVersion}/${resource.kind} was created without factory provenance and has multiple registered factories. Pass factoryName to createResource().`,
        path: '$.provenance.canonicalizers',
        details: { apiVersion: resource.apiVersion, kind: resource.kind },
      });
    }
  }
  const canonicalizers = registrations
    .flatMap((registration) =>
      registration.desiredCanonicalizer
        ? [
            {
              canonicalizer: registration.desiredCanonicalizer,
              factoryName: registration.factoryName,
            },
          ]
        : []
    )
    .filter(
      (entry, index, all) =>
        all.findIndex((candidate) => candidate.canonicalizer.id === entry.canonicalizer.id) ===
        index
    )
    .sort((left, right) => left.canonicalizer.id.localeCompare(right.canonicalizer.id));

  let current = resource;
  const manifest: CanonicalizerManifestEntry[] = [];
  for (const { canonicalizer, factoryName } of canonicalizers) {
    const first = canonicalizer.canonicalize(cloneCanonicalizerInput(current));
    const second = canonicalizer.canonicalize(cloneCanonicalizerInput(current));
    const firstLowered = lowerPlanValue(first);
    const secondLowered = lowerPlanValue(second);
    diagnostics.push(...firstLowered.diagnostics, ...secondLowered.diagnostics);
    if (canonicalStringify(firstLowered.value) !== canonicalStringify(secondLowered.value)) {
      diagnostics.push({
        code: 'PLAN_CANONICALIZER_NONDETERMINISTIC',
        severity: 'error',
        message: `Desired canonicalizer ${canonicalizer.id}@${canonicalizer.revision} produced different outputs for identical inputs.`,
        path: '$.provenance.canonicalizers',
      });
    }
    current = first;
    manifest.push({
      id: canonicalizer.id,
      revision: canonicalizer.revision,
      stage: 'desired',
      factoryName,
    });
  }
  return { resource: current, canonicalizers: manifest };
}

function factoryRegistrationForResource(
  resource: KubernetesResource
): FactoryRegistration | undefined {
  const factoryName = getMetadataField(resource, 'factoryName');
  if (factoryName) {
    const registration = getFactoryRegistration(factoryName);
    if (registration?.apiVersion === resource.apiVersion && registration.kind === resource.kind) {
      return registration;
    }
    return undefined;
  }
  const registrations = getFactoryRegistrationsForGVK(resource.apiVersion, resource.kind);
  return registrations.length === 1 ? registrations[0] : undefined;
}

function factoryRepresentationRequirements(
  resource: KubernetesResource,
  logicalId: string,
  diagnostics: PlanDiagnostic[]
): RepresentationRequirement[] {
  const registration = factoryRegistrationForResource(resource);
  const producer = registration?.representationRequirements;
  if (!registration || !producer) return [];

  let first: readonly FactoryRepresentationRequirement[];
  let second: readonly FactoryRepresentationRequirement[];
  try {
    first = producer.produce(cloneCanonicalizerInput(resource));
    second = producer.produce(cloneCanonicalizerInput(resource));
  } catch (_error: unknown) {
    diagnostics.push({
      code: 'PLAN_REPRESENTATION_PRODUCER_FAILED',
      severity: 'error',
      message: `Representation producer ${producer.id}@${producer.revision} failed for ${logicalId}.`,
      path: `$.nodes.${logicalId}`,
      details: { producer: producer.id },
    });
    return [];
  }

  const lower = (
    requirements: readonly FactoryRepresentationRequirement[],
    pass: 'first' | 'second'
  ): RepresentationRequirement[] =>
    requirements.map((requirement, index) => {
      const lowered = lowerPlanValue(requirement.inputs);
      diagnostics.push(
        ...lowered.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: `$.nodes.${logicalId}.representationRequirements.${pass}[${index}]${diagnostic.path?.slice(1) ?? ''}`,
        }))
      );
      return {
        target: requirement.target,
        kind: requirement.kind,
        extension: requirement.extension,
        version: requirement.version,
        inputs: lowered.value,
        sourceNodeId: logicalId,
        factoryName: registration.factoryName,
      };
    });

  const firstLowered = lower(first, 'first');
  const secondLowered = lower(second, 'second');
  if (canonicalStringify(firstLowered) !== canonicalStringify(secondLowered)) {
    diagnostics.push({
      code: 'PLAN_REPRESENTATION_PRODUCER_NONDETERMINISTIC',
      severity: 'error',
      message: `Representation producer ${producer.id}@${producer.revision} produced different declarations for identical inputs.`,
      path: `$.nodes.${logicalId}.representationRequirements`,
      details: { producer: producer.id },
    });
  }
  return firstLowered;
}

function planValueReferences(value: PlanValue): Array<{ resourceId: string; fieldPath: string }> {
  switch (value.kind) {
    case 'sensitive-value':
      return planValueReferences(value.value);
    case 'reference':
      return value.source === 'resource' && value.resourceId
        ? [{ resourceId: value.resourceId, fieldPath: value.fieldPath }]
        : [];
    case 'expression':
      return value.expression.references.flatMap((reference) =>
        reference.source === 'resource' && reference.resourceId
          ? [{ resourceId: reference.resourceId, fieldPath: reference.fieldPath }]
          : []
      );
    case 'template':
      return value.segments.flatMap((segment) => {
        if (segment.kind === 'reference') {
          return segment.source === 'resource' && segment.resourceId
            ? [{ resourceId: segment.resourceId, fieldPath: segment.fieldPath }]
            : [];
        }
        if (segment.kind === 'expression') {
          return segment.expression.references.flatMap((reference) =>
            reference.source === 'resource' && reference.resourceId
              ? [{ resourceId: reference.resourceId, fieldPath: reference.fieldPath }]
              : []
          );
        }
        return [];
      });
    case 'array':
      return value.items.flatMap((item) => planValueReferences(item));
    case 'object':
      return value.entries.flatMap((entry) => planValueReferences(entry.value));
    default:
      return [];
  }
}

function planValueCapabilities(value: PlanValue, nodeId?: string): CapabilityRequirement[] {
  switch (value.kind) {
    case 'sensitive-value':
      return [
        {
          id: 'typekro.sensitive-materialization',
          version: 1,
          ...(nodeId ? { nodeId } : {}),
        },
        ...planValueCapabilities(value.value, nodeId),
      ];
    case 'expression':
      return value.expression.language === 'raw-cel'
        ? [{ id: 'typekro.raw-cel', version: 1, target: 'kro', ...(nodeId ? { nodeId } : {}) }]
        : value.expression.sensitivity === 'sensitive'
          ? [
              {
                id: 'typekro.sensitive-materialization',
                version: 1,
                ...(nodeId ? { nodeId } : {}),
              },
            ]
          : [];
    case 'sensitive-binding':
      return [
        {
          id: 'typekro.sensitive-materialization',
          version: 1,
          ...(nodeId ? { nodeId } : {}),
        },
      ];
    case 'external-input':
      return [{ id: 'typekro.external-input', version: 1, ...(nodeId ? { nodeId } : {}) }];
    case 'artifact-output':
      return [
        {
          id: 'typekro.artifact-output',
          version: 1,
          host: 'alchemy',
          output: 'live',
          ...(nodeId ? { nodeId } : {}),
        },
      ];
    case 'template':
      return [];
    case 'array':
      return value.items.flatMap((item) => planValueCapabilities(item, nodeId));
    case 'object':
      return value.entries.flatMap((entry) => planValueCapabilities(entry.value, nodeId));
    default:
      return [];
  }
}

function uniqueCapabilities(
  capabilities: readonly CapabilityRequirement[]
): CapabilityRequirement[] {
  return [
    ...new Map(
      capabilities.map((capability) => [canonicalStringify(capability), capability] as const)
    ).values(),
  ].sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
}

function purityDiagnostics(source: string): PlanDiagnostic[] {
  const unsupportedEffects = [
    { pattern: /\bMath\.random\s*\(/, effect: 'randomness' },
    { pattern: /\bDate\.now\s*\(|\bnew\s+Date\s*\(/, effect: 'wall-clock time' },
    { pattern: /\b(?:process|Bun)\.env\b|\bDeno\.env\b/, effect: 'environment access' },
    { pattern: /\bfetch\s*\(/, effect: 'network access' },
    {
      pattern: /\b(?:readFile|readFileSync|exec|execSync|spawn|spawnSync)\s*\(/,
      effect: 'ambient I/O',
    },
  ];
  return unsupportedEffects.flatMap(({ pattern, effect }) =>
    pattern.test(source)
      ? [
          {
            code: 'PLAN_AMBIENT_EFFECT_UNSUPPORTED',
            severity: 'error' as const,
            message: `Composition source contains undeclared ${effect}, which is outside the supported planning subset.`,
            path: '$.composition',
            details: { effect },
          },
        ]
      : []
  );
}

function resourceIdentity(resource: KubernetesResource, specSchema: SchemaIR): KubernetesIdentity {
  const name = lowerPlanValue(resource.metadata?.name, { specSchema }).value;
  const namespace = resource.metadata?.namespace;
  const declaredScope = getResourceScope(resource);
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name,
    ...(namespace !== undefined
      ? { namespace: lowerPlanValue(namespace, { specSchema }).value }
      : {}),
    scope:
      declaredScope === 'cluster' || declaredScope === 'namespaced'
        ? declaredScope
        : namespace === undefined
          ? 'cluster'
          : 'namespaced',
  };
}

function collectSensitiveSpecPaths(value: PlanValue, paths: Set<string>): void {
  switch (value.kind) {
    case 'reference':
      if (value.source === 'spec') paths.add(value.fieldPath);
      return;
    case 'expression':
      value.expression.references.forEach((reference) => {
        if (reference.source === 'spec') paths.add(reference.fieldPath);
      });
      return;
    case 'template':
      value.segments.forEach((segment) => {
        if (segment.kind === 'reference' && segment.source === 'spec') {
          paths.add(segment.fieldPath);
        } else if (segment.kind === 'expression') {
          segment.expression.references.forEach((reference) => {
            if (reference.source === 'spec') paths.add(reference.fieldPath);
          });
        }
      });
      return;
    case 'sensitive-value':
      collectSensitiveSpecPaths(value.value, paths);
      return;
    case 'array':
      value.items.forEach((item) => collectSensitiveSpecPaths(item, paths));
      return;
    case 'object':
      value.entries.forEach((entry) => collectSensitiveSpecPaths(entry.value, paths));
      return;
    default:
      return;
  }
}

function sensitiveSpecReferences(
  value: PlanValue,
  sensitivePaths: ReadonlySet<string>
): readonly string[] {
  const references = new Set<string>();
  collectSensitiveSpecPaths(value, references);
  return [...references]
    .filter((fieldPath) => specPathIsSensitive(fieldPath, sensitivePaths))
    .sort();
}

function diagnoseSensitiveControlFlow(
  diagnostics: PlanDiagnostic[],
  nodeId: string,
  controlFlow: 'activation' | 'readiness' | 'iteration',
  value: PlanValue,
  path: string,
  sensitivePaths: ReadonlySet<string>
): void {
  if (!summarizeValue(value).sensitive) return;

  const exposure =
    controlFlow === 'activation'
      ? 'resource existence'
      : controlFlow === 'readiness'
        ? 'readiness state or timing'
        : 'resource cardinality and identity';
  const sensitiveReferences = sensitiveSpecReferences(value, sensitivePaths);
  diagnostics.push({
    code: 'PLAN_SENSITIVE_CONTROL_FLOW',
    severity: 'error',
    message: `Resource ${nodeId} ${controlFlow} depends on sensitive data and would expose it through ${exposure}.`,
    path,
    details: {
      controlFlow,
      ...(sensitiveReferences.length > 0 ? { sensitivePath: sensitiveReferences.join(',') } : {}),
    },
  });
}

function secretValueHasDynamicSource(value: PlanValue): boolean {
  switch (value.kind) {
    case 'reference':
    case 'external-input':
    case 'artifact-output':
    case 'sensitive-binding':
    case 'sensitive-value':
      return true;
    case 'expression':
      return value.expression.references.length > 0;
    case 'template':
      return value.segments.some(
        (segment) =>
          segment.kind === 'reference' ||
          (segment.kind === 'expression' && segment.expression.references.length > 0)
      );
    case 'array':
      return value.items.some(secretValueHasDynamicSource);
    case 'object':
      return value.entries.some((entry) => secretValueHasDynamicSource(entry.value));
    default:
      return false;
  }
}

function classifySecretLeaf(
  value: PlanValue,
  logicalId: string,
  field: string,
  keyPath: string,
  diagnostics: PlanDiagnostic[],
  sensitiveSpecPaths: Set<string>
): PlanValue {
  if (value.kind === 'sensitive-binding' || value.kind === 'sensitive-value') {
    collectSensitiveSpecPaths(value, sensitiveSpecPaths);
    return value;
  }
  if (value.kind === 'omitted') return value;
  if (value.kind === 'array') {
    return {
      ...value,
      items: value.items.map((item, index) =>
        classifySecretLeaf(
          item,
          logicalId,
          field,
          `${keyPath}/${index}`,
          diagnostics,
          sensitiveSpecPaths
        )
      ),
    };
  }
  if (value.kind === 'object') {
    return {
      ...value,
      entries: value.entries.map((entry) => ({
        ...entry,
        value: classifySecretLeaf(
          entry.value,
          logicalId,
          field,
          `${keyPath}/${entry.key}`,
          diagnostics,
          sensitiveSpecPaths
        ),
      })),
    };
  }
  if (secretValueHasDynamicSource(value)) {
    collectSensitiveSpecPaths(value, sensitiveSpecPaths);
    return { kind: 'sensitive-value', value };
  }

  const binding = `inline-secret/${logicalId}/${field}/${keyPath}`;
  diagnostics.push({
    code: 'PLAN_INLINE_SECRET_REQUIRES_BINDING',
    severity: 'error',
    message: `Secret ${logicalId} field ${field}.${keyPath.replaceAll('/', '.')} contains inline material and requires a named sensitive binding for serialization.`,
    path: `$.nodes.${logicalId}.desired.${field}.${keyPath.replaceAll('/', '.')}`,
  });
  return { kind: 'sensitive-binding', binding };
}

function classifySecretValues(
  value: PlanValue,
  logicalId: string,
  diagnostics: PlanDiagnostic[],
  sensitiveSpecPaths: Set<string>
): PlanValue {
  if (value.kind !== 'object') return value;
  return {
    ...value,
    entries: value.entries.map((entry) => {
      if ((entry.key !== 'data' && entry.key !== 'stringData') || entry.value.kind !== 'object') {
        return entry;
      }
      return {
        ...entry,
        value: {
          ...entry.value,
          entries: entry.value.entries.map((secretEntry) => ({
            ...secretEntry,
            value: classifySecretLeaf(
              secretEntry.value,
              logicalId,
              entry.key,
              secretEntry.key,
              diagnostics,
              sensitiveSpecPaths
            ),
          })),
        },
      };
    }),
  };
}

function inspectSensitiveSpecPaths(
  resources: Readonly<Record<string, KubernetesResource>>,
  specSchema: SchemaIR,
  diagnostics: PlanDiagnostic[]
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.kind !== 'Secret') continue;
    const lowered = lowerPlanValue(resource, { specSchema });
    diagnostics.push(
      ...lowered.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: `$.nodes.${logicalId}.desired${diagnostic.path?.slice(1) ?? ''}`,
      }))
    );
    if (lowered.value.kind !== 'object') continue;
    for (const entry of lowered.value.entries) {
      if (entry.key === 'data' || entry.key === 'stringData') {
        collectSensitiveSpecPaths(entry.value, paths);
      }
    }
  }
  return paths;
}

function redactConcreteSpecPath(
  value: PlanValue,
  segments: readonly string[],
  binding: string,
  index = 0
): PlanValue {
  if (index === segments.length) {
    switch (value.kind) {
      case 'reference':
      case 'expression':
      case 'template':
      case 'sensitive-binding':
      case 'sensitive-value':
      case 'external-input':
      case 'artifact-output':
      case 'omitted':
        return value;
      default:
        return { kind: 'sensitive-binding', binding };
    }
  }
  const segment = segments[index];
  if (!segment) return value;
  if (value.kind === 'object') {
    return {
      ...value,
      entries: value.entries.map((entry) =>
        entry.key === segment
          ? {
              ...entry,
              value: redactConcreteSpecPath(entry.value, segments, binding, index + 1),
            }
          : entry
      ),
    };
  }
  if (value.kind === 'array' && (segment === '$item' || /^\d+$/.test(segment))) {
    const indexes =
      segment === '$item' ? value.items.map((_, itemIndex) => itemIndex) : [Number(segment)];
    const selected = new Set(indexes);
    return {
      ...value,
      items: value.items.map((item, itemIndex) =>
        selected.has(itemIndex) ? redactConcreteSpecPath(item, segments, binding, index + 1) : item
      ),
    };
  }
  return value;
}

function redactSensitiveSpecValues(value: PlanValue, paths: ReadonlySet<string>): PlanValue {
  return [...paths]
    .sort()
    .reduce(
      (current, fieldPath) =>
        redactConcreteSpecPath(
          current,
          fieldPath.split('.').filter(Boolean),
          `spec/${fieldPath.replaceAll('.', '/')}`
        ),
      value
    );
}

function lifecyclePolicy(resource: KubernetesResource): LifecyclePolicy {
  const external = Reflect.get(resource, '__externalRef') === true;
  const scopes = getMetadataField(resource, 'scopes') ?? [];
  const legacyShared = getMetadataField(resource, 'lifecycle') === 'shared';
  const shared = scopes.length > 0 || legacyShared || external;
  return {
    creation: external ? 'require-existing' : 'create',
    management: external ? 'reference-only' : 'authoritative',
    deletion: shared ? 'retain' : 'delete',
    instancing:
      scopes.length > 0
        ? { kind: 'per-scope', key: lowerPlanValue([...scopes].sort().join('|')).value }
        : { kind: 'per-instance' },
    sharing: shared ? 'shareable' : 'exclusive',
  };
}

function buildResourceNodes(
  graph: DeploymentResourceGraph,
  diagnostics: PlanDiagnostic[],
  capturedResources: Readonly<Record<string, KubernetesResource>>,
  nestedStatusMappings: Readonly<Record<string, string>>,
  specSchema: SchemaIR,
  preserveCapturedDynamics = false
): {
  readonly nodes: PlanNode[];
  readonly edges: PlanEdge[];
  readonly canonicalizers: CanonicalizerManifestEntry[];
  readonly representationRequirements: RepresentationRequirement[];
  readonly sensitiveSpecPaths: ReadonlySet<string>;
} {
  const nodes: PlanNode[] = [];
  const graphIdToLogical = new Map<string, string>();
  const referenceIdToLogical = new Map<string, string>();
  const canonicalizers = new Map<string, CanonicalizerManifestEntry>();
  const representationRequirements: RepresentationRequirement[] = [];
  const sensitiveSpecPaths = new Set<string>(
    preserveCapturedDynamics
      ? inspectSensitiveSpecPaths(capturedResources, specSchema, diagnostics)
      : []
  );
  const capturedResourceByLogicalId = new Map<string, KubernetesResource>();
  for (const [captureId, resource] of Object.entries(capturedResources)) {
    capturedResourceByLogicalId.set(captureId, resource);
    const resourceId = getResourceId(resource);
    if (resourceId) capturedResourceByLogicalId.set(resourceId, resource);
  }
  const lower = (value: unknown) => lowerPlanValue(value, { specSchema });
  const lowerAnalyzedExpression = (value: unknown): PlanValue => {
    if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
      return {
        kind: 'expression',
        expression: expressionIR(value.slice(2, -1)),
      };
    }
    return lower(value).value;
  };

  const iterationDimensions = (
    dimensions: readonly Record<string, string>[],
    logicalId: string
  ): PlanIterationDimension[] => {
    const itemPathByVariable = new Map<string, string>();
    return dimensions.flatMap((dimension, index) => {
      const entries = Object.entries(dimension);
      const entry = entries[0];
      if (entries.length !== 1 || !entry) {
        diagnostics.push({
          code: 'PLAN_ITERATION_DIMENSION_INVALID',
          severity: 'error',
          message: `Iteration dimension ${index} on ${logicalId} must contain exactly one variable and collection expression.`,
          path: `$.nodes.${logicalId}.iteration[${index}]`,
        });
        return [];
      }
      const [variable, wrappedExpression] = entry;
      const expression =
        wrappedExpression.startsWith('${') && wrappedExpression.endsWith('}')
          ? wrappedExpression.slice(2, -1)
          : wrappedExpression;
      const collectionRoot = expression.split(/\.(?:filter|map)\s*\(/, 1)[0]?.trim();
      let itemPath: string | undefined;
      if (collectionRoot?.startsWith('schema.spec.')) {
        itemPath = `${collectionRoot.slice('schema.spec.'.length)}.$item`;
      } else if (collectionRoot) {
        const [parentVariable, ...suffix] = collectionRoot.split('.');
        const parentPath = parentVariable ? itemPathByVariable.get(parentVariable) : undefined;
        if (parentPath) {
          itemPath = `${parentPath}${suffix.length > 0 ? `.${suffix.join('.')}` : ''}.$item`;
        }
      }
      if (!itemPath) {
        diagnostics.push({
          code: 'PLAN_ITERATION_ITEM_PATH_UNRESOLVED',
          severity: 'error',
          message: `Iteration dimension ${variable} on ${logicalId} has no resolvable schema item path.`,
          path: `$.nodes.${logicalId}.iteration[${index}]`,
          details: { expression },
        });
        return [];
      }
      itemPathByVariable.set(variable, itemPath);
      return [
        {
          variable,
          collection: { kind: 'expression', expression: expressionIR(expression) },
          itemPath,
        },
      ];
    });
  };

  const appendResourceNode = (resource: KubernetesResource, fallbackId: string): void => {
    const logicalId = getResourceId(resource) ?? fallbackId;
    if (nodes.some((node) => node.id === logicalId)) return;
    referenceIdToLogical.set(logicalId, logicalId);
    const canonicalized = canonicalizeResource(resource, diagnostics);
    representationRequirements.push(
      ...factoryRepresentationRequirements(resource, logicalId, diagnostics)
    );
    canonicalized.canonicalizers.forEach((entry) => canonicalizers.set(entry.id, entry));
    const desired = lower(canonicalized.resource);
    diagnostics.push(
      ...desired.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: `$.nodes.${logicalId}.desired${diagnostic.path?.slice(1) ?? ''}`,
      }))
    );
    const iteration = iterationDimensions(getForEach(resource) ?? [], logicalId);
    const activation = (getMetadataField(resource, 'includeWhen') ?? []).map((condition) =>
      markNestedStatusReferences(lowerAnalyzedExpression(condition), nestedStatusMappings)
    );
    const readiness = (getMetadataField(resource, 'readyWhen') ?? []).map((condition) =>
      typeof condition === 'function'
        ? {
            kind: 'expression' as const,
            expression: expressionIR(
              convertReadyWhenCallbackToCel(
                condition as (...args: unknown[]) => unknown,
                iteration.length > 0 ? 'each' : logicalId
              )
            ),
          }
        : markNestedStatusReferences(lowerAnalyzedExpression(condition), nestedStatusMappings)
    );
    const templateOverrides = (getTemplateOverrides(resource) ?? []).map((override) => ({
      propertyPath: override.propertyPath,
      value: lowerAnalyzedExpression(override.celExpression),
    }));
    const evaluator = getReadinessEvaluator(resource);
    const readinessStrategy =
      getMetadataField(resource, 'readinessStrategy') ??
      (evaluator ? getPortableReadinessStrategy(evaluator) : undefined) ??
      (evaluator
        ? ({
            kind: 'runtime-binding',
            binding: `readiness:${logicalId}`,
            version: 1,
            classification: getRuntimeReadinessClassification(evaluator) ?? {
              reason: 'unclassified-evaluator',
              description:
                'This evaluator has not declared whether it can be reconstructed from canonical artifact data.',
            },
          } as const)
        : undefined);
    if (
      readinessStrategy?.kind === 'runtime-binding' &&
      readinessStrategy.classification?.reason === 'unclassified-evaluator'
    ) {
      diagnostics.push({
        code: 'PLAN_READINESS_EVALUATOR_UNCLASSIFIED',
        severity: 'error',
        message:
          `Readiness evaluator on ${logicalId} has no durable strategy or explicit runtime classification. ` +
          `Register deterministic evaluators with registerPortableReadinessEvaluator(), or mark process-local behavior with identifyRuntimeReadinessEvaluator().`,
        path: `$.nodes.${logicalId}.readinessStrategy`,
        details: { binding: readinessStrategy.binding },
      });
    }
    const capturedResource = preserveCapturedDynamics
      ? capturedResourceByLogicalId.get(logicalId)
      : undefined;
    const capturedDesired = capturedResource ? lower(capturedResource) : undefined;
    if (capturedDesired) {
      diagnostics.push(
        ...capturedDesired.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: `$.nodes.${logicalId}.capturedDesired${diagnostic.path?.slice(1) ?? ''}`,
        }))
      );
    }
    const mergedDesired = capturedDesired
      ? preserveCapturedDynamicValue(
          desired.value,
          markNestedStatusReferences(capturedDesired.value, nestedStatusMappings),
          sensitiveSpecPaths
        )
      : desired.value;
    const publicSecretPlaceholder =
      canonicalized.resource.kind === 'Secret' &&
      getMetadataField(resource, 'secretMaterial') === 'public-placeholder';
    if (publicSecretPlaceholder) {
      diagnostics.push({
        code: 'PLAN_PUBLIC_SECRET_PLACEHOLDER',
        severity: 'warning',
        message: `Secret ${logicalId} explicitly contains public placeholder material.`,
        path: `$.nodes.${logicalId}.desired`,
        details: { classification: 'public-placeholder' },
      });
    }
    const desiredValue = markNestedStatusReferences(
      canonicalized.resource.kind === 'Secret' && !publicSecretPlaceholder
        ? classifySecretValues(mergedDesired, logicalId, diagnostics, sensitiveSpecPaths)
        : mergedDesired,
      nestedStatusMappings
    );
    const requiredCapabilities = uniqueCapabilities([
      ...planValueCapabilities(desiredValue, logicalId),
      ...activation.flatMap((value) => planValueCapabilities(value, logicalId)),
      ...readiness.flatMap((value) => planValueCapabilities(value, logicalId)),
      ...(iteration.length > 0 ? [{ id: 'typekro.iteration', version: 1, nodeId: logicalId }] : []),
      ...(templateOverrides.length > 0
        ? [
            {
              id: 'typekro.template-overrides',
              version: 1,
              nodeId: logicalId,
            },
          ]
        : []),
    ]);
    nodes.push({
      id: logicalId,
      type: 'kubernetes-resource',
      identity: resourceIdentity(canonicalized.resource, specSchema),
      desired: desiredValue,
      lifecycle: lifecyclePolicy(resource),
      activation,
      readiness,
      ...(readinessStrategy ? { readinessStrategy } : {}),
      ...(iteration.length > 0 ? { iteration } : {}),
      ...(templateOverrides.length > 0 ? { templateOverrides } : {}),
      requiredCapabilities,
    });
  };

  for (const graphResource of graph.resources) {
    const logicalId = getResourceId(graphResource.manifest) ?? graphResource.id;
    graphIdToLogical.set(graphResource.id, logicalId);
    appendResourceNode(graphResource.manifest, graphResource.id);
  }

  // Direct materialization intentionally omits require-existing resources from
  // its apply graph. They remain semantic nodes, so recover them from capture
  // without treating them as deployable resources.
  for (const [captureId, resource] of Object.entries(capturedResources)) {
    if (Reflect.get(resource, '__externalRef') === true) {
      appendResourceNode(resource, captureId);
    }
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    const desired = node.desired
      ? markSensitiveSpecReferences(node.desired, sensitiveSpecPaths)
      : undefined;
    const activation = node.activation.map((value) =>
      markSensitiveSpecReferences(value, sensitiveSpecPaths)
    );
    const readiness = node.readiness.map((value) =>
      markSensitiveSpecReferences(value, sensitiveSpecPaths)
    );
    const iteration = node.iteration?.map((dimension) => ({
      ...dimension,
      collection: markSensitiveSpecReferences(dimension.collection, sensitiveSpecPaths),
    }));
    const templateOverrides = node.templateOverrides?.map((override) => ({
      ...override,
      value: markSensitiveSpecReferences(override.value, sensitiveSpecPaths),
    }));

    activation.forEach((value, conditionIndex) =>
      diagnoseSensitiveControlFlow(
        diagnostics,
        node.id,
        'activation',
        value,
        `$.nodes.${node.id}.activation[${conditionIndex}]`,
        sensitiveSpecPaths
      )
    );
    readiness.forEach((value, conditionIndex) =>
      diagnoseSensitiveControlFlow(
        diagnostics,
        node.id,
        'readiness',
        value,
        `$.nodes.${node.id}.readiness[${conditionIndex}]`,
        sensitiveSpecPaths
      )
    );
    iteration?.forEach((dimension, dimensionIndex) =>
      diagnoseSensitiveControlFlow(
        diagnostics,
        node.id,
        'iteration',
        dimension.collection,
        `$.nodes.${node.id}.iteration[${dimensionIndex}].collection`,
        sensitiveSpecPaths
      )
    );
    nodes[index] = {
      ...node,
      ...(desired ? { desired } : {}),
      activation,
      readiness,
      ...(iteration ? { iteration } : {}),
      ...(templateOverrides ? { templateOverrides } : {}),
      requiredCapabilities: uniqueCapabilities([
        ...node.requiredCapabilities,
        ...(desired ? planValueCapabilities(desired, node.id) : []),
        ...activation.flatMap((value) => planValueCapabilities(value, node.id)),
        ...readiness.flatMap((value) => planValueCapabilities(value, node.id)),
        ...(iteration ?? []).flatMap((dimension) =>
          planValueCapabilities(dimension.collection, node.id)
        ),
        ...(templateOverrides ?? []).flatMap((override) =>
          planValueCapabilities(override.value, node.id)
        ),
      ]),
    };
  }

  for (const node of nodes) {
    if (!node.identity) continue;
    const identityFields = [
      ['name', node.identity.name] as const,
      ...(node.identity.namespace ? ([['namespace', node.identity.namespace]] as const) : []),
    ];
    for (const [field, value] of identityFields) {
      const sensitiveReferences = sensitiveSpecReferences(value, sensitiveSpecPaths);
      if (sensitiveReferences.length === 0) continue;
      diagnostics.push({
        code: 'PLAN_SENSITIVE_IDENTITY',
        severity: 'error',
        message: `Resource ${node.id} ${field} derives from sensitive spec data and would expose it through Kubernetes identity.`,
        path: `$.nodes.${node.id}.identity.${field}`,
        details: { sensitivePath: sensitiveReferences.join(',') },
      });
    }
  }

  const edges: PlanEdge[] = [];
  for (const graphResource of graph.resources) {
    const dependent = graphIdToLogical.get(graphResource.id);
    if (!dependent) continue;
    for (const dependencyGraphId of graph.dependencyGraph.getDependencies(graphResource.id)) {
      const prerequisite = graphIdToLogical.get(dependencyGraphId);
      if (prerequisite) edges.push({ kind: 'existence', prerequisite, dependent });
    }
    const explicitReady = getMetadataField(graphResource.manifest, 'dependsOn') ?? [];
    for (const dependency of explicitReady) {
      const prerequisite = referenceIdToLogical.get(dependency.resourceId);
      if (prerequisite) edges.push({ kind: 'ready', prerequisite, dependent });
    }
  }
  for (const node of nodes) {
    if (!node.desired) continue;
    for (const reference of planValueReferences(node.desired)) {
      const producer = referenceIdToLogical.get(reference.resourceId);
      if (producer && producer !== node.id) {
        edges.push({ kind: 'output', producer, consumer: node.id, output: reference.fieldPath });
      }
    }
  }

  const uniqueEdges = [
    ...new Map(edges.map((edge) => [canonicalStringify(edge), edge])).values(),
  ].sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
  return {
    nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: uniqueEdges,
    canonicalizers: [...canonicalizers.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    representationRequirements: [...representationRequirements].sort((left, right) =>
      canonicalStringify(left).localeCompare(canonicalStringify(right))
    ),
    sensitiveSpecPaths,
  };
}

function closureNodes<TSpec extends KroCompatibleType>(
  capture: CapturedCompositionRuntime<TSpec>
): { readonly nodes: PlanNode[]; readonly capabilities: CapabilityRequirement[] } {
  const capability: CapabilityRequirement = {
    id: 'typekro.runtime-closure',
    version: 1,
    host: 'standalone',
    output: 'live',
  };
  return {
    nodes: capture.ir.compatibilityClosures.map((id) => ({
      id,
      type: 'compatibility-closure' as const,
      lifecycle: {
        creation: 'create' as const,
        management: 'cooperative' as const,
        deletion: 'retain' as const,
        instancing: { kind: 'per-instance' as const },
        sharing: 'exclusive' as const,
      },
      activation: [],
      readiness: [],
      requiredCapabilities: [{ ...capability, nodeId: id }],
    })),
    capabilities: capture.ir.compatibilityClosures.length > 0 ? [capability] : [],
  };
}

/**
 * Build the target-neutral graph from captured authoring templates. Concrete
 * direct materialization is an adapter concern and must not erase spec
 * references or specialize graph shape before KRO compilation.
 */
function symbolicResourceGraph<TSpec extends KroCompatibleType>(
  capture: CapturedCompositionRuntime<TSpec>,
  options: PlanOptions,
  aspectMode: 'direct' | 'kro'
): DeploymentResourceGraph {
  // Applying aspects to symbolic values preserves their authoring order and
  // keeps the resulting desired state in the semantic digest. KRO-specific
  // capability rejection remains a compiler responsibility.
  const resources = applyAspects(capture.ir.resources, {
    mode: aspectMode,
    aspects: options.aspects ?? [],
  });
  const deployable = Object.entries(resources).map(([logicalId, resource]) => {
    const manifest = { ...resource } as KubernetesResource & { id: string };
    Object.defineProperty(manifest, 'id', {
      value: logicalId,
      enumerable: false,
      configurable: true,
    });
    copyResourceMetadata(resource, manifest);
    setResourceId(manifest, getResourceId(resource) ?? logicalId);
    return manifest as unknown as DeployableK8sResource<Enhanced<unknown, unknown>>;
  });
  return {
    name: `${capture.ir.definition.name}-symbolic`,
    resources: deployable.map((manifest) => ({ id: manifest.id, manifest })),
    dependencyGraph: new DependencyResolver().buildDependencyGraph(deployable),
  };
}

function instanceName(spec: KroCompatibleType, fallback: string): PlanValue {
  if (spec && typeof spec === 'object') {
    const name = Reflect.get(spec, 'name');
    if (typeof name === 'string' && name.length > 0) return lowerPlanValue(name).value;
  }
  return lowerPlanValue(fallback).value;
}

function buildPlanOnce<TSpec extends KroCompatibleType>(
  capture: CapturedCompositionRuntime<TSpec>,
  spec: TSpec,
  options: PlanOptions,
  materializedGraph?: DeploymentResourceGraph,
  shouldValidateSpec = true,
  aspectMode: 'direct' | 'kro' = 'direct'
): DesiredStatePlan {
  const diagnostics: PlanDiagnostic[] = [];
  if (shouldValidateSpec) capture.validate(spec);
  diagnostics.push(...purityDiagnostics(capture.diagnosticSource));
  const plannedSpec = lowerPlanValue(spec);
  diagnostics.push(
    ...plannedSpec.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: `$.spec${diagnostic.path?.slice(1) ?? ''}`,
    }))
  );
  const identity = compositionIdentity(capture);
  const specSchema = schemaToIR(capture.ir.definition.specSchema, { strict: false });
  diagnostics.push(...specSchema.diagnostics);
  const inputs = inputManifest(options, diagnostics);
  const aspects = createAspectManifest(options.aspects);
  diagnostics.push(...aspects.diagnostics);
  const graph = materializedGraph ?? symbolicResourceGraph(capture, options, aspectMode);
  const resources = buildResourceNodes(
    graph,
    diagnostics,
    capture.ir.resources,
    capture.ir.nestedStatusMappings,
    specSchema,
    materializedGraph !== undefined
  );
  const status = buildStatusContract(
    capture,
    diagnostics,
    false,
    specSchema,
    resources.sensitiveSpecPaths
  );
  const semanticSpec = redactSensitiveSpecValues(plannedSpec.value, resources.sensitiveSpecPaths);
  const closures = closureNodes(capture);
  const capturedRequirements = capture.representationRequirements();
  diagnostics.push(...capturedRequirements.diagnostics);
  const representationRequirements = [
    ...capturedRequirements.requirements,
    ...resources.representationRequirements,
  ].sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
  representationRequirements.forEach((requirement, index) => {
    if (
      requirement.extension.length === 0 ||
      requirement.kind.length === 0 ||
      !Number.isSafeInteger(requirement.version) ||
      requirement.version < 1
    ) {
      diagnostics.push({
        code: 'PLAN_REPRESENTATION_REQUIREMENT_INVALID',
        severity: 'error',
        message: `Representation requirement ${index} must have a non-empty extension/kind and positive integer version.`,
        path: `$.representationRequirements[${index}]`,
      });
    }
  });
  const requiredCapabilities = uniqueCapabilities([
    ...resources.nodes.flatMap((node) => node.requiredCapabilities),
    ...closures.capabilities,
    ...inputs.flatMap((input): CapabilityRequirement[] => {
      if (input.kind === 'ordinary') return planValueCapabilities(input.value);
      if (input.kind === 'sensitive') {
        return [{ id: 'typekro.sensitive-materialization', version: 1 }];
      }
      return [
        {
          id: 'typekro.artifact-input',
          version: 1,
          host: 'alchemy' as const,
          output: 'live' as const,
        },
      ];
    }),
    ...Object.values(status.outputs).flatMap((value) => planValueCapabilities(value)),
    ...representationRequirements.map((requirement) => ({
      id: requirement.extension,
      version: requirement.version,
      target: requirement.target,
    })),
  ]);
  const durabilityReasons: PlanDiagnostic[] = [];
  if (identity.stability === 'preview-unstable') {
    durabilityReasons.push({
      code: 'PLAN_IDENTITY_PREVIEW_UNSTABLE',
      severity: 'warning',
      message: 'Composition has no explicit version or compiler-produced bundle digest.',
      path: '$.composition',
    });
  }
  if (!aspects.stable) durabilityReasons.push(...aspects.diagnostics);
  const canonicalizers = resources.canonicalizers;
  const semanticPayload = {
    version: 1,
    schemas: {
      specDigest: specSchema.digest,
      persistedStatusDigest: status.contract.persistedSchema.digest,
      hydratedStatusDigest: status.contract.hydratedSchema.digest,
    },
    instance: {
      composition: capture.ir.definition.name,
      name: instanceName(spec, capture.ir.definition.name),
    },
    spec: semanticSpec,
    nodes: [...resources.nodes, ...closures.nodes].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    edges: resources.edges,
    outputs: status.outputs,
    inputs,
    aspects: aspects.manifest,
    representationRequirements,
    canonicalizers,
    requiredCapabilities,
  };
  const semanticContentDigest = canonicalDigest(semanticPayload);
  const planIdentityDigest = canonicalDigest({ composition: identity, semanticContentDigest });
  return {
    version: 1,
    composition: identity,
    schemas: {
      irVersion: 1,
      spec: specSchema,
      specDigest: specSchema.digest,
      persistedStatusDigest: status.contract.persistedSchema.digest,
      hydratedStatusDigest: status.contract.hydratedSchema.digest,
    },
    status: status.contract,
    instance: semanticPayload.instance,
    spec: semanticSpec,
    nodes: semanticPayload.nodes,
    edges: resources.edges,
    outputs: status.outputs,
    inputs,
    aspects: aspects.manifest,
    representationRequirements,
    provenance: { canonicalizers },
    requiredCapabilities,
    durability: {
      cacheEligible: durabilityReasons.length === 0,
      provenanceEligible: durabilityReasons.length === 0,
      reasons: durabilityReasons,
    },
    inputDigest: canonicalDigest(inputs),
    aspectDigest: aspects.digest,
    semanticContentDigest,
    planIdentityDigest,
    diagnostics: [...diagnostics, ...durabilityReasons],
  };
}

/** Produce static inspection from the same capture used by planning. */
export function inspectCapturedComposition<TSpec extends KroCompatibleType>(
  capture: CapturedCompositionRuntime<TSpec>
): CompositionInspection {
  const diagnostics: PlanDiagnostic[] = [];
  diagnostics.push(...purityDiagnostics(capture.diagnosticSource));
  const specSchema = schemaToIR(capture.ir.definition.specSchema, { strict: false });
  diagnostics.push(...specSchema.diagnostics);
  const sensitiveSpecPaths = inspectSensitiveSpecPaths(
    capture.ir.resources,
    specSchema,
    diagnostics
  );
  const status = buildStatusContract(capture, diagnostics, false, specSchema, sensitiveSpecPaths);
  const potentialCapabilities = uniqueCapabilities([
    ...capture.ir.potentialCapabilities,
    ...(sensitiveSpecPaths.size > 0
      ? [{ id: 'typekro.sensitive-materialization', version: 1 }]
      : []),
  ]);
  return {
    version: 1,
    composition: compositionIdentity(capture),
    specSchema,
    status: status.contract,
    potentialCapabilities,
    diagnostics,
  };
}

/** Produce a deterministic semantic plan without contacting Kubernetes or providers. */
export function planCapturedComposition<TSpec extends KroCompatibleType>(
  capture: CapturedCompositionRuntime<TSpec>,
  spec: TSpec,
  options: PlanOptions = {}
): DesiredStatePlan {
  const first = buildPlanOnce(capture, spec, options);
  if (options.strict) {
    const second = buildPlanOnce(capture, spec, { ...options, strict: false });
    if (first.semanticContentDigest !== second.semanticContentDigest) {
      throw new SemanticPlanningError('Planning produced nondeterministic semantic content.', [
        {
          code: 'PLAN_NONDETERMINISTIC',
          severity: 'error',
          message: 'Two planning passes over identical declared inputs produced different digests.',
          path: '$',
          details: {
            firstDigest: first.semanticContentDigest,
            secondDigest: second.semanticContentDigest,
          },
        },
      ]);
    }
    const errors = first.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) {
      throw new SemanticPlanningError('Strict semantic planning rejected the composition.', errors);
    }
  }
  return first;
}

/** Build the shared symbolic plan used to compile a KRO graph definition. */
export function planCapturedTemplate<TSpec extends KroCompatibleType>(
  capture: CapturedCompositionRuntime<TSpec>,
  symbolicSpec: TSpec,
  options: PlanOptions = {}
): DesiredStatePlan {
  const first = buildPlanOnce(capture, symbolicSpec, options, undefined, false, 'kro');
  if (options.strict) {
    const second = buildPlanOnce(
      capture,
      symbolicSpec,
      { ...options, strict: false },
      undefined,
      false,
      'kro'
    );
    if (first.semanticContentDigest !== second.semanticContentDigest) {
      throw new SemanticPlanningError(
        'Template planning produced nondeterministic semantic content.',
        [
          {
            code: 'PLAN_NONDETERMINISTIC',
            severity: 'error',
            message: 'Two template-planning passes produced different semantic digests.',
            path: '$',
            details: {
              firstDigest: first.semanticContentDigest,
              secondDigest: second.semanticContentDigest,
            },
          },
        ]
      );
    }
    const errors = first.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) {
      throw new SemanticPlanningError(
        'Strict semantic template planning rejected the composition.',
        errors
      );
    }
  }
  return first;
}

/**
 * Plan an already materialized graph. This is the production bridge used by
 * factory facades so author code executes once per operation.
 */
export function planMaterializedComposition<TSpec extends KroCompatibleType>(
  capture: CapturedCompositionRuntime<TSpec>,
  spec: TSpec,
  graph: DeploymentResourceGraph,
  options: PlanOptions = {}
): DesiredStatePlan {
  const plan = buildPlanOnce(capture, spec, options, graph);
  if (options.strict) {
    const errors = plan.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) {
      throw new SemanticPlanningError('Strict semantic planning rejected the composition.', errors);
    }
  }
  return plan;
}
