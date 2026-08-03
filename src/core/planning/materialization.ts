import { evaluate } from 'cel-js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../constants/brands.js';
import { TypeKroError } from '../errors.js';

import type { ExpressionReferenceIR, PlanValue } from './types.js';
import {
  KRO_ARTIFACT_BINDINGS_SPEC_FIELD,
  kroArtifactOutputField,
  kroArtifactRequirementField,
} from './values.js';

/** Explicit bindings supplied after pure planning and before artifact execution. */
export interface PlanMaterializationBindings {
  readonly spec?: unknown;
  /**
   * Live Kubernetes resources keyed by their canonical composition resource id.
   *
   * Ordinary direct artifact materialization omits this map and preserves
   * resource references for the deployment engine. Composition-output
   * materialization supplies it after Alchemy has reconciled the complete
   * resource graph, allowing the exact same PlanValue to hydrate a concrete
   * result without re-running the authoring closure.
   */
  readonly resources?: Readonly<Record<string, unknown>>;
  readonly sensitive?: Readonly<Record<string, unknown>>;
  readonly externalInputs?: Readonly<Record<string, unknown>>;
  readonly artifactOutputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Portable iterator variables available while expanding a direct artifact. */
  readonly locals?: Readonly<Record<string, unknown>>;
  /** Canonical schema `$item` paths bound by the current iteration coordinates. */
  readonly iterationItems?: Readonly<Record<string, unknown>>;
  /** Concrete producer ids selected for references from the current artifact instance. */
  readonly resourceIds?: Readonly<Record<string, string>>;
}

/** Explicit policy and named values for plaintext static-YAML materialization. */
export interface StaticYamlMaterializationOptions {
  /** Acknowledges that returned YAML may contain plaintext sensitive values. */
  readonly allowSensitiveMaterialization?: true;
  /** Values for explicit `sensitiveValue(binding)` references. */
  readonly sensitiveBindings?: Readonly<Record<string, unknown>>;
}

/**
 * Prepare the plaintext-only binding map used by static YAML. Canonical plans
 * and artifact records remain binding-only; this helper is called only at the
 * final serialization boundary.
 */
export function resolveStaticYamlSensitiveBindings(
  requiredBindings: readonly string[],
  capturedBindings: Readonly<Record<string, unknown>>,
  options: StaticYamlMaterializationOptions | undefined,
  context: string,
  containsSensitiveValue = false
): Readonly<Record<string, unknown>> {
  const required = [...new Set(requiredBindings)].sort();
  if (required.length === 0 && !containsSensitiveValue) return {};
  if (options?.allowSensitiveMaterialization !== true) {
    throw new TypeKroError(
      `${context} contains sensitive values and requires explicit plaintext materialization.`,
      'SENSITIVE_YAML_MATERIALIZATION_REQUIRED',
      { bindings: required, containsSensitiveValue }
    );
  }

  const resolved: Record<string, unknown> = { ...capturedBindings };
  for (const [binding, value] of Object.entries(options.sensitiveBindings ?? {})) {
    if (Object.hasOwn(resolved, binding) && !Object.is(resolved[binding], value)) {
      throw new TypeKroError(
        `${context} received conflicting values for sensitive binding ${binding}.`,
        'SENSITIVE_BINDING_CONFLICT',
        { binding }
      );
    }
    resolved[binding] = value;
  }
  const missing = required.filter((binding) => !Object.hasOwn(resolved, binding));
  if (missing.length > 0) {
    throw new TypeKroError(
      `${context} is missing sensitive materialization bindings: ${missing.join(', ')}.`,
      'SENSITIVE_BINDING_UNRESOLVED',
      { bindings: missing }
    );
  }
  return Object.fromEntries(required.map((binding) => [binding, resolved[binding]]));
}

function isSensitiveBindingDescriptor(
  value: unknown
): value is { readonly kind: 'sensitive-binding'; readonly binding: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'kind') === 'sensitive-binding' &&
    typeof Reflect.get(value, 'binding') === 'string'
  );
}

function collectSensitiveBindings(
  value: PlanValue,
  concrete: unknown,
  bindings: Record<string, unknown>,
  path: string
): void {
  switch (value.kind) {
    case 'sensitive-binding': {
      // An explicit sensitiveValue(binding) has no materialized bytes in the
      // concrete spec. It remains unresolved until a caller supplies that
      // named binding through an operational resolver.
      if (isSensitiveBindingDescriptor(concrete) && concrete.binding === value.binding) {
        return;
      }
      if (Object.hasOwn(bindings, value.binding) && !Object.is(bindings[value.binding], concrete)) {
        throw new PlanMaterializationError(
          `Sensitive binding ${value.binding} resolved to conflicting values.`,
          path,
          { binding: value.binding }
        );
      }
      bindings[value.binding] = concrete;
      return;
    }
    case 'sensitive-value':
      collectSensitiveBindings(value.value, concrete, bindings, `${path}.value`);
      return;
    case 'array': {
      const items = Array.isArray(concrete) ? concrete : [];
      value.items.forEach((item, index) =>
        collectSensitiveBindings(item, items[index], bindings, `${path}[${index}]`)
      );
      return;
    }
    case 'object': {
      const record =
        concrete && typeof concrete === 'object' && !Array.isArray(concrete)
          ? (concrete as Record<string, unknown>)
          : {};
      value.entries.forEach((entry) =>
        collectSensitiveBindings(entry.value, record[entry.key], bindings, `${path}.${entry.key}`)
      );
      return;
    }
    default:
      return;
  }
}

/**
 * Extract ephemeral values for sensitive binding identities already present in
 * a canonical value. The returned envelope is deliberately separate from the
 * PlanValue and must never be encoded into a plan or artifact bundle.
 */
export function collectPlanValueSensitiveBindings(
  value: PlanValue,
  concrete: unknown,
  path = '$'
): Readonly<Record<string, unknown>> {
  const bindings: Record<string, unknown> = {};
  collectSensitiveBindings(value, concrete, bindings, path);
  return bindings;
}

/** Return the stable sensitive binding identities referenced by a PlanValue. */
export function planValueSensitiveBindingNames(value: PlanValue): readonly string[] {
  const names = new Set<string>();
  const visit = (current: PlanValue): void => {
    switch (current.kind) {
      case 'sensitive-binding':
        names.add(current.binding);
        return;
      case 'sensitive-value':
        visit(current.value);
        return;
      case 'array':
        current.items.forEach(visit);
        return;
      case 'object':
        current.entries.forEach((entry) => visit(entry.value));
        return;
      default:
        return;
    }
  };
  visit(value);
  return [...names].sort();
}

/** Whether a canonical value contains tainted data that can be resolved from ordinary bindings. */
export function planValueContainsSensitiveValue(value: PlanValue): boolean {
  switch (value.kind) {
    case 'sensitive-value':
      return true;
    case 'array':
      return value.items.some(planValueContainsSensitiveValue);
    case 'object':
      return value.entries.some((entry) => planValueContainsSensitiveValue(entry.value));
    default:
      return false;
  }
}

/** Rewrite binding identities without resolving or exposing their values. */
export function mapPlanValueSensitiveBindings(
  value: PlanValue,
  mapBinding: (binding: string) => string
): PlanValue {
  switch (value.kind) {
    case 'sensitive-binding':
      return { ...value, binding: mapBinding(value.binding) };
    case 'sensitive-value':
      return { ...value, value: mapPlanValueSensitiveBindings(value.value, mapBinding) };
    case 'array':
      return {
        ...value,
        items: value.items.map((item) => mapPlanValueSensitiveBindings(item, mapBinding)),
      };
    case 'object':
      return {
        ...value,
        entries: value.entries.map((entry) => ({
          ...entry,
          value: mapPlanValueSensitiveBindings(entry.value, mapBinding),
        })),
      };
    default:
      return value;
  }
}

export class PlanMaterializationError extends TypeKroError {
  constructor(message: string, path: string, details: Record<string, unknown> = {}) {
    super(message, 'PLAN_MATERIALIZATION_FAILED', { path, ...details });
    this.name = 'PlanMaterializationError';
  }
}

const OMIT = Symbol('typekro.plan.omit');

function cloneEvaluationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneEvaluationValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      cloneEvaluationValue(child),
    ])
  );
}

function ensureEvaluationPath(root: Record<string, unknown>, fieldPath: string): void {
  const parts = fieldPath.split('.').filter(Boolean);
  const leaf = parts.pop();
  if (!leaf) return;
  let current = root;
  for (const part of parts) {
    const child = current[part];
    if (!child || typeof child !== 'object' || Array.isArray(child)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  if (!Object.hasOwn(current, leaf)) current[leaf] = null;
}

function evaluatePortableExpression(
  expression: string,
  bindings: PlanMaterializationBindings,
  path: string,
  references: readonly ExpressionReferenceIR[] = []
): unknown {
  try {
    const missingPresencePaths = new Set<string>();
    let executable = expression.replace(
      /\bhas\(schema\.spec\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\)/g,
      (_match, fieldPath: string) => {
        const missing =
          readPath(bindings.spec, fieldPath, path, true, bindings.iterationItems) === OMIT;
        if (missing) missingPresencePaths.add(fieldPath);
        return missing ? 'false' : 'true';
      }
    );
    const clonedSpec = cloneEvaluationValue(bindings.spec);
    const specContext =
      clonedSpec && typeof clonedSpec === 'object' && !Array.isArray(clonedSpec)
        ? (clonedSpec as Record<string, unknown>)
        : {};
    for (const reference of references) {
      if (reference.source !== 'spec') continue;
      const guarded = [...missingPresencePaths].some(
        (fieldPath) =>
          reference.fieldPath === fieldPath || reference.fieldPath.startsWith(`${fieldPath}.`)
      );
      if (guarded) ensureEvaluationPath(specContext, reference.fieldPath);
    }
    const context: Record<string, unknown> = {
      ...(bindings.resources ?? {}),
      schema: { spec: specContext },
      ...(bindings.locals ?? {}),
    };
    Object.entries(bindings.iterationItems ?? {})
      .sort(([left], [right]) => right.length - left.length)
      .forEach(([itemPath, item], index) => {
        const variable = `__typekro_item_${index}`;
        executable = executable.split(`schema.spec.${itemPath}`).join(variable);
        context[variable] = item;
      });
    return evaluate(executable, context, {
      string: (value: unknown) => String(value),
      int: (value: unknown) => Number.parseInt(String(value), 10),
      double: (value: unknown) => Number.parseFloat(String(value)),
      size: (value: unknown) =>
        Array.isArray(value) || typeof value === 'string'
          ? value.length
          : value && typeof value === 'object'
            ? Object.keys(value).length
            : 0,
      has: (value: unknown) => value !== undefined && value !== null,
      // KRO uses dyn() for static type widening. Portable direct execution
      // preserves the same expression and therefore treats it as runtime
      // identity, matching the direct/schema CEL evaluators.
      dyn: (value: unknown) => value,
      concat: (...values: unknown[]) => values.join(''),
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PlanMaterializationError(
      `Portable expression could not be evaluated at ${path}: ${expression}`,
      path,
      {
        expression,
        error: reason,
      }
    );
  }
}

function readPath(
  root: unknown,
  fieldPath: string,
  path: string,
  optional = false,
  iterationItems: Readonly<Record<string, unknown>> = {}
): unknown | typeof OMIT {
  const normalizedPath = fieldPath
    .split('.')
    .filter((part) => part.length > 0)
    .map((part) => (part.startsWith('?') ? part.slice(1) : part))
    .join('.');
  const itemBinding = Object.entries(iterationItems)
    .filter(
      ([itemPath]) => normalizedPath === itemPath || normalizedPath.startsWith(`${itemPath}.`)
    )
    .sort(([left], [right]) => right.length - left.length)[0];
  const parts = itemBinding
    ? normalizedPath.slice(itemBinding[0].length).replace(/^\./, '').split('.').filter(Boolean)
    : normalizedPath.split('.').filter(Boolean);
  if (itemBinding) root = itemBinding[1];
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      if (optional) return OMIT;
      throw new PlanMaterializationError(
        `Declared spec reference ${fieldPath} is not present in materialization input.`,
        path,
        { fieldPath }
      );
    }
    current = Reflect.get(current, part);
  }
  return current;
}

function runtimeReference(
  resourceId: string,
  fieldPath: string,
  options: { readonly nestedComposition?: true } = {}
): object {
  const marker = `__KUBERNETES_REF_${resourceId}_${fieldPath}__`;
  const reference = (() => marker) as unknown as Record<PropertyKey, unknown>;
  Object.assign(reference, {
    resourceId,
    fieldPath,
    ...(options.nestedComposition ? { __nestedComposition: true as const } : {}),
  });
  Object.defineProperties(reference, {
    toString: { value: () => marker, enumerable: false },
    valueOf: { value: () => marker, enumerable: false },
    [Symbol.toPrimitive]: {
      value: (hint: string) => (hint === 'number' ? Number.NaN : marker),
      enumerable: false,
    },
  });
  Object.defineProperty(reference, KUBERNETES_REF_BRAND, {
    value: true,
    enumerable: false,
  });
  return reference;
}

function runtimeExpression(expression: string, template = false): object {
  const value = { expression, ...(template ? { __isTemplate: true as const } : {}) };
  Object.defineProperty(value, CEL_EXPRESSION_BRAND, { value: true, enumerable: false });
  return value;
}

function markerString(
  source: 'spec' | 'resource',
  resourceId: string | undefined,
  fieldPath: string
): string {
  const id = source === 'spec' ? '__schema__' : resourceId;
  if (!id)
    throw new PlanMaterializationError(`Template resource reference has no producer id.`, '$');
  const path =
    source === 'spec' && !fieldPath.startsWith('spec.') ? `spec.${fieldPath}` : fieldPath;
  return `__KUBERNETES_REF_${id}_${path}__`;
}

function materialize(
  value: PlanValue,
  bindings: PlanMaterializationBindings,
  path: string
): unknown | typeof OMIT {
  switch (value.kind) {
    case 'literal':
      return value.value;
    case 'omitted':
      return OMIT;
    case 'array':
      return value.items.map((item, index) => {
        const child = materialize(item, bindings, `${path}[${index}]`);
        return child === OMIT ? undefined : child;
      });
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const entry of value.entries) {
        const child = materialize(entry.value, bindings, `${path}.${entry.key}`);
        if (child !== OMIT) result[entry.key] = child;
      }
      return result;
    }
    case 'reference':
      if (value.source === 'spec') {
        if (bindings.spec === undefined) {
          throw new PlanMaterializationError(
            `Spec binding is required to resolve ${value.fieldPath}.`,
            path,
            { fieldPath: value.fieldPath }
          );
        }
        return readPath(
          bindings.spec,
          value.fieldPath,
          path,
          value.optional === true,
          bindings.iterationItems
        );
      }
      if (!value.resourceId) {
        throw new PlanMaterializationError(`Resource reference has no producer id.`, path);
      }
      if (Object.hasOwn(bindings.resources ?? {}, value.resourceId)) {
        return readPath(
          bindings.resources?.[value.resourceId],
          value.fieldPath,
          path,
          value.optional === true
        );
      }
      if (bindings.resources !== undefined) {
        if (value.optional === true) return OMIT;
        throw new PlanMaterializationError(
          `Required resource binding ${value.resourceId} is not present in materialization input.`,
          path,
          { resourceId: value.resourceId, fieldPath: value.fieldPath }
        );
      }
      return runtimeReference(
        bindings.resourceIds?.[value.resourceId] ?? value.resourceId,
        value.fieldPath,
        {
          ...(value.nestedComposition ? { nestedComposition: true } : {}),
        }
      );
    case 'expression':
      if (value.expression.language !== 'portable-cel') {
        throw new PlanMaterializationError(
          `Raw CEL cannot be materialized for direct execution.`,
          path,
          { language: value.expression.language }
        );
      }
      if (bindings.resources !== undefined) {
        const missingResource = value.expression.references.find(
          (reference) =>
            reference.source === 'resource' &&
            (!reference.resourceId ||
              !Object.hasOwn(bindings.resources ?? {}, reference.resourceId))
        );
        if (missingResource) {
          throw new PlanMaterializationError(
            `Required resource binding ${missingResource.resourceId ?? '<unknown>'} is not present in materialization input.`,
            path,
            {
              resourceId: missingResource.resourceId ?? '<unknown>',
              fieldPath: missingResource.fieldPath,
              expression: value.expression.expression,
            }
          );
        }
      }
      if (
        value.expression.references.some((reference) => reference.source === 'resource') &&
        bindings.resources === undefined
      ) {
        return runtimeExpression(value.expression.expression);
      }
      if (
        bindings.spec === undefined &&
        value.expression.references.some((reference) => reference.source === 'spec')
      ) {
        throw new PlanMaterializationError(
          `Spec binding is required to evaluate ${value.expression.expression}.`,
          path,
          { expression: value.expression.expression }
        );
      }
      return evaluatePortableExpression(
        value.expression.expression,
        bindings,
        path,
        value.expression.references
      );
    case 'template': {
      let hasRuntimeExpression = false;
      const renderedSegments: string[] = [];
      for (const segment of value.segments) {
        if (segment.kind === 'literal') {
          renderedSegments.push(segment.value);
          continue;
        }
        if (segment.kind === 'expression') {
          const resourceReferences = segment.expression.references.filter(
            (reference) => reference.source === 'resource'
          );
          const specReferences = segment.expression.references.filter(
            (reference) => reference.source === 'spec'
          );
          if (bindings.resources !== undefined) {
            const missingResource = resourceReferences.find(
              (reference) =>
                !reference.resourceId ||
                !Object.hasOwn(bindings.resources ?? {}, reference.resourceId)
            );
            if (missingResource) {
              throw new PlanMaterializationError(
                `Required resource binding ${missingResource.resourceId ?? '<unknown>'} is not present in materialization input.`,
                path,
                {
                  resourceId: missingResource.resourceId ?? '<unknown>',
                  fieldPath: missingResource.fieldPath,
                  expression: segment.expression.expression,
                }
              );
            }
          }
          const canEvaluate =
            segment.expression.language === 'portable-cel' &&
            (resourceReferences.length === 0 || bindings.resources !== undefined) &&
            (specReferences.length === 0 || bindings.spec !== undefined);
          if (canEvaluate) {
            renderedSegments.push(
              String(
                evaluatePortableExpression(
                  segment.expression.expression,
                  bindings,
                  path,
                  segment.expression.references
                )
              )
            );
            continue;
          }
          hasRuntimeExpression = true;
          renderedSegments.push(`\${${segment.expression.expression}}`);
          continue;
        }
        if (segment.source === 'spec' && bindings.spec !== undefined) {
          const resolved = readPath(
            bindings.spec,
            segment.fieldPath,
            path,
            segment.optional === true,
            bindings.iterationItems
          );
          if (resolved === OMIT) return OMIT;
          renderedSegments.push(String(resolved));
          continue;
        }
        if (
          segment.source === 'resource' &&
          segment.resourceId &&
          Object.hasOwn(bindings.resources ?? {}, segment.resourceId)
        ) {
          const resolved = readPath(
            bindings.resources?.[segment.resourceId],
            segment.fieldPath,
            path,
            segment.optional === true
          );
          if (resolved === OMIT) return OMIT;
          renderedSegments.push(String(resolved));
          continue;
        }
        if (segment.source === 'resource' && bindings.resources !== undefined) {
          if (segment.optional === true) return OMIT;
          throw new PlanMaterializationError(
            `Required resource binding ${segment.resourceId ?? '<unknown>'} is not present in materialization input.`,
            path,
            {
              resourceId: segment.resourceId ?? '<unknown>',
              fieldPath: segment.fieldPath,
            }
          );
        }
        renderedSegments.push(
          markerString(
            segment.source,
            segment.resourceId
              ? (bindings.resourceIds?.[segment.resourceId] ?? segment.resourceId)
              : undefined,
            segment.fieldPath
          )
        );
      }
      const rendered = renderedSegments.join('');
      return hasRuntimeExpression ? runtimeExpression(rendered, true) : rendered;
    }
    case 'sensitive-binding': {
      if (!Object.hasOwn(bindings.sensitive ?? {}, value.binding)) {
        throw new PlanMaterializationError(
          `Sensitive binding ${value.binding} was not supplied.`,
          path,
          { binding: value.binding }
        );
      }
      return bindings.sensitive?.[value.binding];
    }
    case 'sensitive-value':
      return materialize(value.value, bindings, `${path}.value`);
    case 'external-input': {
      if (!Object.hasOwn(bindings.externalInputs ?? {}, value.name)) {
        throw new PlanMaterializationError(`External input ${value.name} was not supplied.`, path, {
          input: value.name,
        });
      }
      return bindings.externalInputs?.[value.name];
    }
    case 'artifact-output': {
      const outputs = bindings.artifactOutputs?.[value.requirementId];
      if (!outputs || !Object.hasOwn(outputs, value.output)) {
        throw new PlanMaterializationError(
          `Artifact output ${value.requirementId}.${value.output} was not supplied.`,
          path,
          { requirementId: value.requirementId, output: value.output }
        );
      }
      return outputs[value.output];
    }
  }
}

/** Convert a canonical PlanValue into the runtime value consumed by existing executors. */
export function materializePlanValue(
  value: PlanValue,
  bindings: PlanMaterializationBindings = {},
  path = '$'
): unknown {
  const result = materialize(value, bindings, path);
  return result === OMIT ? undefined : result;
}

/**
 * Hydrate a composition's canonical output map from concrete bindings.
 *
 * This is deliberately a planning/runtime seam rather than an Alchemy helper:
 * TypeKro owns the meaning of PlanValue, while deployment backends own how
 * live resources and provider outputs become available. Keeping the evaluator
 * here guarantees direct factories, KRO status, and Alchemy composition
 * outputs share one authored expression contract.
 */
export function materializePlanOutputs(
  outputs: Readonly<Record<string, PlanValue>>,
  bindings: PlanMaterializationBindings = {}
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.keys(outputs)
      .sort()
      .map((name) => [
        name,
        materializePlanValue(outputs[name] as PlanValue, bindings, `$.outputs.${name}`),
      ])
  );
}

/**
 * Resolve an activation condition when all of its inputs are available before
 * deployment. `undefined` means the condition depends on runtime resource
 * state and must remain attached to the artifact.
 */
export function evaluatePlanActivation(
  value: PlanValue,
  bindings: PlanMaterializationBindings = {},
  path = '$'
): boolean | undefined {
  if (value.kind === 'expression') {
    if (value.expression.language !== 'portable-cel') {
      throw new PlanMaterializationError(
        'Raw CEL activation cannot be evaluated for direct execution.',
        path,
        { language: value.expression.language }
      );
    }
    if (value.expression.references.some((reference) => reference.source === 'resource')) {
      return undefined;
    }
    if (bindings.spec === undefined && value.expression.references.length > 0) {
      throw new PlanMaterializationError('Spec binding is required to evaluate activation.', path, {
        expression: value.expression.expression,
      });
    }
    const result = evaluatePortableExpression(
      value.expression.expression,
      bindings,
      path,
      value.expression.references
    );
    if (typeof result !== 'boolean') {
      throw new PlanMaterializationError(
        'Activation expression did not evaluate to a boolean.',
        path,
        { expression: value.expression.expression, resultType: typeof result }
      );
    }
    return result;
  }

  if ((value.kind === 'reference' && value.source === 'resource') || value.kind === 'template') {
    return undefined;
  }

  const result = materialize(value, bindings, path);
  if (result === OMIT || result === undefined || result === null) return false;
  if (typeof result !== 'boolean') {
    throw new PlanMaterializationError('Activation value did not materialize to a boolean.', path, {
      resultType: typeof result,
    });
  }
  return result;
}

function materializeKro(value: PlanValue, path: string): unknown | typeof OMIT {
  switch (value.kind) {
    case 'literal':
      return value.value;
    case 'omitted':
      return OMIT;
    case 'array':
      return value.items.map((item, index) => {
        const child = materializeKro(item, `${path}[${index}]`);
        return child === OMIT ? undefined : child;
      });
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const entry of value.entries) {
        const child = materializeKro(entry.value, `${path}.${entry.key}`);
        if (child !== OMIT) result[entry.key] = child;
      }
      return result;
    }
    case 'reference':
      return value.source === 'spec'
        ? runtimeReference('__schema__', `spec.${value.fieldPath}`)
        : value.resourceId
          ? runtimeReference(value.resourceId, value.fieldPath, {
              ...(value.nestedComposition ? { nestedComposition: true } : {}),
            })
          : (() => {
              throw new PlanMaterializationError(
                'KRO resource reference has no producer id.',
                path
              );
            })();
    case 'expression':
      return runtimeExpression(value.expression.expression);
    case 'template': {
      const rendered = value.segments
        .map((segment) => {
          if (segment.kind === 'literal') return segment.value;
          if (segment.kind === 'expression') return `\${${segment.expression.expression}}`;
          return markerString(segment.source, segment.resourceId, segment.fieldPath);
        })
        .join('');
      return value.segments.some((segment) => segment.kind === 'expression')
        ? runtimeExpression(rendered, true)
        : rendered;
    }
    case 'sensitive-binding':
      throw new PlanMaterializationError(
        `Sensitive binding ${value.binding} cannot be embedded in a shared KRO graph.`,
        path,
        { binding: value.binding }
      );
    case 'sensitive-value':
      return materializeKro(value.value, `${path}.value`);
    case 'external-input':
      throw new PlanMaterializationError(
        `External input ${value.name} cannot be embedded in a shared KRO graph.`,
        path,
        { input: value.name }
      );
    case 'artifact-output':
      return runtimeReference(
        '__schema__',
        `spec.${KRO_ARTIFACT_BINDINGS_SPEC_FIELD}.${kroArtifactRequirementField(value.requirementId)}.${kroArtifactOutputField(value.output)}`
      );
  }
}

/** Rehydrate symbolic PlanValue records for the established KRO serializer. */
export function materializePlanValueForKro(value: PlanValue, path = '$'): unknown {
  const result = materializeKro(value, path);
  return result === OMIT ? undefined : result;
}
