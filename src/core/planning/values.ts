import { parse } from 'cel-js';
import {
  isCelExpression,
  isKubernetesRef,
  isMixedTemplate,
  isResourceReference,
} from '../../utils/type-guards.js';
import {
  CEL_EXPRESSION_BRAND,
  KUBERNETES_REF_MARKER_SOURCE,
  SCHEMA_REFERENCE_OPTIONAL_BRAND,
} from '../constants/brands.js';
import { TypeKroError } from '../errors.js';
import { getCelExpressionAnalysis } from '../expressions/analysis/expression-metadata.js';
import { CelEvaluator } from '../references/cel-evaluator.js';
import type { CelEvaluationContext } from '../types/references.js';

import { canonicalDigest, canonicalStringify } from './canonical.js';
import type {
  ArtifactOutputRef,
  ArtifactOutputUse,
  ExpressionIR,
  ExpressionReferenceIR,
  ExternalInputRef,
  PlanDiagnostic,
  PlanSourceLocation,
  PlanTemplateSegment,
  PlanValue,
  PlanValueLoweringResult,
  SchemaIR,
  SchemaNodeIR,
  SensitiveValueRef,
} from './types.js';

const SENSITIVE_INPUT_BRAND = Symbol.for('typekro.planning.sensitive-input');
const EXTERNAL_INPUT_BRAND = Symbol.for('typekro.planning.external-input');
const ARTIFACT_OUTPUT_BRAND = Symbol.for('typekro.planning.artifact-output');
const PLAN_EXPRESSION_BRAND = Symbol.for('typekro.planning.expression');

type SensitiveValueInput = SensitiveValueRef & { readonly [SENSITIVE_INPUT_BRAND]: true };
type ExternalInput = ExternalInputRef & { readonly [EXTERNAL_INPUT_BRAND]: true };
type ArtifactOutput<T> = ArtifactOutputRef & T & { readonly [ARTIFACT_OUTPUT_BRAND]: true };
type ExpressionValueInput = {
  readonly kind: 'expression';
  readonly expression: ExpressionIR;
  readonly [PLAN_EXPRESSION_BRAND]: true;
};

/** Detect an explicit planning value embedded in an otherwise ordinary value tree. */
export function containsExplicitPlanValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (
    isBranded(value, PLAN_EXPRESSION_BRAND) ||
    isBranded(value, SENSITIVE_INPUT_BRAND) ||
    isBranded(value, EXTERNAL_INPUT_BRAND) ||
    isBranded(value, ARTIFACT_OUTPUT_BRAND)
  ) {
    return true;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).some((child) => containsExplicitPlanValue(child, seen));
}

/** Declare an opaque sensitive binding without embedding its plaintext value. */
export function sensitiveValue(binding: string, version?: string): SensitiveValueInput {
  if (binding.length === 0) {
    throw new TypeKroError(
      'Sensitive binding names must not be empty.',
      'PLAN_INVALID_SENSITIVE_BINDING'
    );
  }
  return Object.freeze({
    kind: 'sensitive-binding' as const,
    binding,
    ...(version !== undefined ? { version } : {}),
    [SENSITIVE_INPUT_BRAND]: true as const,
  });
}

/** Reference a declared external planning input from a value tree. */
export function externalInput(name: string): ExternalInput {
  if (name.length === 0) {
    throw new TypeKroError(
      'External input names must not be empty.',
      'PLAN_INVALID_EXTERNAL_INPUT'
    );
  }
  return Object.freeze({
    kind: 'external-input' as const,
    name,
    [EXTERNAL_INPUT_BRAND]: true as const,
  });
}

/**
 * Reference an output of a declared artifact requirement.
 *
 * Artifact producers most commonly return strings such as image digests, so the authoring value
 * defaults to `string`. Callers may select another direct-mode value type explicitly.
 */
export function artifactOutput<T = string>(
  requirementId: string,
  output: string
): ArtifactOutput<T> {
  if (requirementId.length === 0 || output.length === 0) {
    throw new TypeKroError(
      'Artifact output references require non-empty requirement and output names.',
      'PLAN_INVALID_ARTIFACT_OUTPUT'
    );
  }
  return Object.freeze({
    kind: 'artifact-output' as const,
    requirementId,
    output,
    [ARTIFACT_OUTPUT_BRAND]: true as const,
  }) as ArtifactOutput<T>;
}

function artifactBindingKey(prefix: 'r' | 'o', value: string): string {
  return `${prefix}_${canonicalDigest(value).replace(/[^a-zA-Z0-9]/g, '')}`;
}

/** Stable KRO instance-spec field for one artifact requirement. */
export function kroArtifactRequirementField(requirementId: string): string {
  return artifactBindingKey('r', requirementId);
}

/** Stable KRO instance-spec field for one artifact output. */
export function kroArtifactOutputField(output: string): string {
  return artifactBindingKey('o', output);
}

/**
 * Find every cross-provider artifact output used by a canonical value or artifact DTO.
 * Sensitivity follows the nearest `sensitive-value` envelope so durable hosts can redact
 * only the outputs that actually carry secret material.
 */
export function collectArtifactOutputUses(value: unknown): readonly ArtifactOutputUse[] {
  const uses = new Map<string, ArtifactOutputUse>();
  const visit = (current: unknown, sensitive: boolean, seen: WeakMap<object, boolean>): void => {
    if (!current || typeof current !== 'object') return;
    const priorSensitivity = seen.get(current);
    if (priorSensitivity === true || priorSensitivity === sensitive) return;
    seen.set(current, sensitive);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, sensitive, seen));
      return;
    }
    const record = current as Record<string, unknown>;
    if (
      record.kind === 'artifact-output' &&
      typeof record.requirementId === 'string' &&
      typeof record.output === 'string'
    ) {
      const key = `${record.requirementId}\u0000${record.output}`;
      const prior = uses.get(key);
      uses.set(key, {
        requirementId: record.requirementId,
        output: record.output,
        sensitive: sensitive || prior?.sensitive === true,
      });
      return;
    }
    const nestedSensitive = sensitive || record.kind === 'sensitive-value';
    Object.values(record).forEach((entry) => visit(entry, nestedSensitive, seen));
  };
  visit(value, false, new WeakMap());
  return [...uses.values()].sort((left, right) =>
    canonicalStringify(left).localeCompare(canonicalStringify(right))
  );
}

/** Embed a portable or target-constrained expression in a PlanValue tree. */
export function planExpression(expression: ExpressionIR): ExpressionValueInput {
  return Object.freeze({
    kind: 'expression' as const,
    expression,
    [PLAN_EXPRESSION_BRAND]: true as const,
  });
}

function isBranded(value: unknown, brand: symbol): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && Reflect.get(value, brand) === true;
}

interface CelTokenLike {
  readonly image?: unknown;
  readonly startLine?: unknown;
  readonly startColumn?: unknown;
}

function tokenImage(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof Reflect.get(value, 'image') === 'string'
    ? (Reflect.get(value, 'image') as string)
    : undefined;
}

function parsedExpressionReferences(expression: string): {
  readonly references: ExpressionReferenceIR[];
  readonly sourceLocation?: PlanSourceLocation;
} {
  const references = new Map<string, ExpressionReferenceIR>();
  const parsed = parse(expression);
  if (!parsed.isSuccess) return { references: [] };
  let firstToken: CelTokenLike | undefined;
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (!firstToken && typeof Reflect.get(value, 'image') === 'string') {
      firstToken = value as CelTokenLike;
    }
    if (Reflect.get(value, 'name') === 'identifierExpression') {
      const children = Reflect.get(value, 'children');
      if (children && typeof children === 'object') {
        const roots = Reflect.get(children, 'Identifier');
        const root = Array.isArray(roots) ? tokenImage(roots[0]) : undefined;
        const dots = Reflect.get(children, 'identifierDotExpression');
        const segments = Array.isArray(dots)
          ? dots.flatMap((dot) => {
              if (!dot || typeof dot !== 'object') return [];
              const dotChildren = Reflect.get(dot, 'children');
              if (!dotChildren || typeof dotChildren !== 'object') return [];
              const identifiers = Reflect.get(dotChildren, 'Identifier');
              const image = Array.isArray(identifiers) ? tokenImage(identifiers[0]) : undefined;
              return image ? [image] : [];
            })
          : [];
        if (root === 'schema' && segments[0] === 'spec') {
          const fieldPath = segments.slice(1).join('.');
          references.set(`spec:${fieldPath}`, { source: 'spec', fieldPath });
        } else if (
          root &&
          (segments[0] === 'spec' || segments[0] === 'status' || segments[0] === 'metadata')
        ) {
          const fieldPath = segments.join('.');
          references.set(`resource:${root}:${fieldPath}`, {
            source: 'resource',
            resourceId: root,
            fieldPath,
          });
        }
      }
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(parsed.cst);
  const startLine = firstToken?.startLine;
  const startColumn = firstToken?.startColumn;
  const sourceLocation =
    typeof startLine === 'number' && typeof startColumn === 'number'
      ? { line: startLine, column: startColumn }
      : undefined;
  return {
    references: [...references.values()].sort((left, right) =>
      canonicalStringify(left).localeCompare(canonicalStringify(right))
    ),
    ...(sourceLocation ? { sourceLocation } : {}),
  };
}

/** Create canonical expression IR from emitted CEL. */
export function expressionIR(
  expression: string,
  options: {
    readonly language?: ExpressionIR['language'];
    readonly sensitivity?: ExpressionIR['sensitivity'];
    readonly references?: readonly ExpressionReferenceIR[];
    readonly sourceLocation?: PlanSourceLocation;
  } = {}
): ExpressionIR {
  if (expression.trim().length === 0) {
    throw new TypeKroError('Expression IR cannot be empty.', 'PLAN_INVALID_EXPRESSION');
  }
  const parsed =
    options.references || options.sourceLocation
      ? undefined
      : parsedExpressionReferences(expression);
  return {
    version: 1,
    language: options.language ?? 'portable-cel',
    expression,
    references: options.references ?? parsed?.references ?? [],
    sensitivity: options.sensitivity ?? 'public',
    ...(options.sourceLocation
      ? { sourceLocation: options.sourceLocation }
      : parsed?.sourceLocation
        ? { sourceLocation: parsed.sourceLocation }
        : {}),
  };
}

function unsupportedDiagnostic(path: string, value: unknown): PlanDiagnostic {
  const constructorName =
    value !== null && typeof value === 'object' && typeof value.constructor?.name === 'string'
      ? value.constructor.name
      : undefined;
  const runtimeType =
    constructorName && constructorName !== 'Object'
      ? `${typeof value} (${constructorName} class instance)`
      : typeof value;
  return {
    code: 'PLAN_VALUE_UNSUPPORTED',
    severity: 'error',
    message: `Value at ${path} has unsupported runtime type ${runtimeType}.`,
    path,
  };
}

function isOptionalReferencePath(fieldPath: string): boolean {
  return fieldPath.split('.').some((segment) => segment.startsWith('?'));
}

function normalizeSchemaReferencePath(fieldPath: string): string {
  return fieldPath
    .split('.')
    .map((segment) => (segment.startsWith('?') ? segment.slice(1) : segment))
    .join('.');
}

function isOptionalSchemaReference(value: object, fieldPath: string): boolean {
  return (
    Reflect.get(value, SCHEMA_REFERENCE_OPTIONAL_BRAND) === true ||
    isOptionalReferencePath(fieldPath)
  );
}

interface SchemaPathResult {
  readonly recognized: boolean;
  readonly optional: boolean;
}

function schemaPathSegments(fieldPath: string): string[] {
  const normalized = fieldPath.startsWith('spec.') ? fieldPath.slice('spec.'.length) : fieldPath;
  return normalized
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith('?') ? segment.slice(1) : segment));
}

function inspectSchemaPath(
  node: SchemaNodeIR,
  segments: readonly string[],
  index = 0
): SchemaPathResult {
  if (index >= segments.length) return { recognized: true, optional: false };
  if (node.kind === 'union') {
    const variants = node.variants.map((variant) => inspectSchemaPath(variant, segments, index));
    const recognized = variants.some((result) => result.recognized);
    return {
      recognized,
      optional: recognized && variants.some((result) => !result.recognized || result.optional),
    };
  }
  const segment = segments[index];
  if (!segment) return { recognized: false, optional: false };
  if (node.kind === 'array') {
    if (segment !== '$item' && !/^\d+$/.test(segment)) {
      return { recognized: false, optional: false };
    }
    return inspectSchemaPath(node.items, segments, index + 1);
  }
  if (node.kind !== 'object') return { recognized: false, optional: false };
  const property = node.properties.find((candidate) => candidate.name === segment);
  if (!property) return { recognized: false, optional: false };
  const child = inspectSchemaPath(property.schema, segments, index + 1);
  return {
    recognized: child.recognized,
    optional: !property.required || child.optional,
  };
}

function schemaReferenceIsOptional(schema: SchemaIR, fieldPath: string): boolean {
  const result = inspectSchemaPath(schema.root, schemaPathSegments(fieldPath));
  return result.recognized && result.optional;
}

function applySchemaReferenceOptionality(value: PlanValue, schema: SchemaIR): PlanValue {
  switch (value.kind) {
    case 'sensitive-value':
      return {
        ...value,
        value: applySchemaReferenceOptionality(value.value, schema),
      };
    case 'reference':
      return value.source === 'spec' &&
        value.optional !== true &&
        schemaReferenceIsOptional(schema, value.fieldPath)
        ? { ...value, optional: true }
        : value;
    case 'template':
      return {
        ...value,
        segments: value.segments.map((segment) =>
          segment.kind === 'reference' &&
          segment.source === 'spec' &&
          segment.optional !== true &&
          schemaReferenceIsOptional(schema, segment.fieldPath)
            ? { ...segment, optional: true as const }
            : segment
        ),
      };
    case 'array':
      return {
        ...value,
        items: value.items.map((item) => applySchemaReferenceOptionality(item, schema)),
      };
    case 'object':
      return {
        ...value,
        entries: value.entries.map((entry) => ({
          ...entry,
          value: applySchemaReferenceOptionality(entry.value, schema),
        })),
      };
    default:
      return value;
  }
}

function markerReference(
  resourceId: string,
  fieldPath: string
): PlanTemplateSegment & {
  readonly kind: 'reference';
} {
  const optional = isOptionalReferencePath(fieldPath);
  return resourceId === '__schema__'
    ? {
        kind: 'reference',
        source: 'spec',
        fieldPath: normalizeSchemaReferencePath(
          fieldPath.startsWith('spec.') ? fieldPath.slice('spec.'.length) : fieldPath
        ),
        ...(optional ? { optional: true as const } : {}),
      }
    : {
        kind: 'reference',
        source: 'resource',
        resourceId,
        fieldPath,
        ...(optional ? { optional: true as const } : {}),
      };
}

function markerPlanValue(value: string): PlanValue | undefined {
  const full = new RegExp(`^${KUBERNETES_REF_MARKER_SOURCE}$`).exec(value);
  if (full?.[1] && full[2]) {
    const reference = markerReference(full[1], full[2]);
    return {
      kind: 'template',
      segments: [reference],
    };
  }
  const matches = [...value.matchAll(new RegExp(KUBERNETES_REF_MARKER_SOURCE, 'g'))];
  if (matches.length === 0) return undefined;
  const segments: PlanTemplateSegment[] = [];
  let offset = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    if (index > offset) segments.push({ kind: 'literal', value: value.slice(offset, index) });
    const resourceId = match[1];
    const fieldPath = match[2];
    if (!resourceId || !fieldPath) return undefined;
    segments.push(markerReference(resourceId, fieldPath));
    offset = index + match[0].length;
  }
  if (offset < value.length) segments.push({ kind: 'literal', value: value.slice(offset) });
  return { kind: 'template', segments };
}

function analyzerExpressionOptions(value: object): {
  readonly references?: readonly ExpressionReferenceIR[];
  readonly sourceLocation?: PlanSourceLocation;
} {
  const analysis = getCelExpressionAnalysis(value);
  if (!analysis) return {};
  const references = analysis.references.map((reference): ExpressionReferenceIR => {
    if (reference.resourceId === '__schema__') {
      return {
        source: 'spec',
        fieldPath: reference.fieldPath.startsWith('spec.')
          ? reference.fieldPath.slice('spec.'.length)
          : reference.fieldPath,
      };
    }
    return {
      source: 'resource',
      resourceId: reference.resourceId,
      fieldPath: reference.fieldPath,
    };
  });
  return {
    references,
    ...(analysis.sourceLocation ? { sourceLocation: analysis.sourceLocation } : {}),
  };
}

function mixedTemplatePlanValue(value: { expression: string }): PlanValue {
  const segments: PlanTemplateSegment[] = [];
  const pattern = /\$\{([^{}]+)\}/g;
  let offset = 0;
  let match: RegExpExecArray | null = pattern.exec(value.expression);
  while (match) {
    const index = match.index;
    if (index > offset) {
      segments.push({ kind: 'literal', value: value.expression.slice(offset, index) });
    }
    const expression = match[1];
    if (!expression) return { kind: 'expression', expression: expressionIR(value.expression) };
    segments.push({ kind: 'expression', expression: expressionIR(expression) });
    offset = index + match[0].length;
    match = pattern.exec(value.expression);
  }
  if (segments.length === 0) {
    return { kind: 'expression', expression: expressionIR(value.expression) };
  }
  if (offset < value.expression.length) {
    segments.push({ kind: 'literal', value: value.expression.slice(offset) });
  }
  return { kind: 'template', segments };
}

interface MutableLoweringState {
  readonly diagnostics: PlanDiagnostic[];
  readonly seen: WeakSet<object>;
  sensitive: boolean;
}

function lowerValue(
  value: unknown,
  path: string,
  state: MutableLoweringState,
  expressionLanguage: ExpressionIR['language']
): PlanValue {
  if (value === undefined) return { kind: 'omitted' };
  if (typeof value === 'string') {
    return markerPlanValue(value) ?? { kind: 'literal', value };
  }
  if (value === null || typeof value === 'boolean') {
    return { kind: 'literal', value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      state.diagnostics.push(unsupportedDiagnostic(path, value));
      return { kind: 'omitted' };
    }
    return { kind: 'literal', value: Object.is(value, -0) ? 0 : value };
  }
  if (isKubernetesRef(value)) {
    if (value.resourceId === '__schema__') {
      const sourceFieldPath = value.fieldPath.startsWith('spec.')
        ? value.fieldPath.slice('spec.'.length)
        : value.fieldPath;
      const fieldPath = normalizeSchemaReferencePath(sourceFieldPath);
      return {
        kind: 'reference',
        source: 'spec',
        fieldPath,
        ...(isOptionalSchemaReference(value, sourceFieldPath) ? { optional: true as const } : {}),
      };
    }
    return {
      kind: 'reference',
      source: 'resource',
      resourceId: value.resourceId,
      fieldPath: value.fieldPath,
      ...((value as { __nestedComposition?: boolean }).__nestedComposition === true
        ? { nestedComposition: true as const }
        : {}),
    };
  }
  if (isResourceReference(value)) {
    if (value.resourceId === '__schema__') {
      const sourceFieldPath = value.fieldPath.startsWith('spec.')
        ? value.fieldPath.slice('spec.'.length)
        : value.fieldPath;
      const fieldPath = normalizeSchemaReferencePath(sourceFieldPath);
      return {
        kind: 'reference',
        source: 'spec',
        fieldPath,
        ...(isOptionalSchemaReference(value, sourceFieldPath) ? { optional: true as const } : {}),
      };
    }
    return {
      kind: 'reference',
      source: 'resource',
      resourceId: value.resourceId,
      fieldPath: value.fieldPath,
      ...((value as { __nestedComposition?: boolean }).__nestedComposition === true
        ? { nestedComposition: true as const }
        : {}),
    };
  }
  if (isMixedTemplate(value) || (isCelExpression(value) && value.__isTemplate === true)) {
    return mixedTemplatePlanValue(value);
  }
  if (isCelExpression(value)) {
    return {
      kind: 'expression',
      expression: expressionIR(value.expression, {
        language: expressionLanguage,
        ...analyzerExpressionOptions(value),
      }),
    };
  }
  if (isBranded(value, PLAN_EXPRESSION_BRAND)) {
    const expression = Reflect.get(value, 'expression');
    if (!expression || typeof expression !== 'object') {
      state.diagnostics.push(unsupportedDiagnostic(path, value));
      return { kind: 'omitted' };
    }
    const loweredExpression = expression as ExpressionIR;
    if (loweredExpression.sensitivity === 'sensitive') state.sensitive = true;
    return { kind: 'expression', expression: loweredExpression };
  }
  if (isBranded(value, SENSITIVE_INPUT_BRAND)) {
    const binding = Reflect.get(value, 'binding');
    const version = Reflect.get(value, 'version');
    if (typeof binding !== 'string') {
      state.diagnostics.push(unsupportedDiagnostic(path, value));
      return { kind: 'omitted' };
    }
    state.sensitive = true;
    return {
      kind: 'sensitive-binding',
      binding,
      ...(typeof version === 'string' ? { version } : {}),
    };
  }
  if (isBranded(value, EXTERNAL_INPUT_BRAND)) {
    const name = Reflect.get(value, 'name');
    if (typeof name !== 'string') {
      state.diagnostics.push(unsupportedDiagnostic(path, value));
      return { kind: 'omitted' };
    }
    return { kind: 'external-input', name };
  }
  if (isBranded(value, ARTIFACT_OUTPUT_BRAND)) {
    const requirementId = Reflect.get(value, 'requirementId');
    const output = Reflect.get(value, 'output');
    if (typeof requirementId !== 'string' || typeof output !== 'string') {
      state.diagnostics.push(unsupportedDiagnostic(path, value));
      return { kind: 'omitted' };
    }
    return { kind: 'artifact-output', requirementId, output };
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      state.diagnostics.push({
        code: 'PLAN_VALUE_CIRCULAR',
        severity: 'error',
        message: `Circular array encountered at ${path}.`,
        path,
      });
      return { kind: 'omitted' };
    }
    state.seen.add(value);
    const items = value.map((item, index) =>
      lowerValue(item, `${path}[${index}]`, state, expressionLanguage)
    );
    state.seen.delete(value);
    return { kind: 'array', items };
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      state.diagnostics.push(unsupportedDiagnostic(path, value));
      return { kind: 'omitted' };
    }
    if (state.seen.has(value)) {
      state.diagnostics.push({
        code: 'PLAN_VALUE_CIRCULAR',
        severity: 'error',
        message: `Circular object encountered at ${path}.`,
        path,
      });
      return { kind: 'omitted' };
    }
    state.seen.add(value);
    const entries = Object.keys(value)
      .sort()
      .map((key) => ({
        key,
        value: lowerValue(
          Reflect.get(value, key),
          path === '$' ? `$.${key}` : `${path}.${key}`,
          state,
          expressionLanguage
        ),
      }));
    state.seen.delete(value);
    return { kind: 'object', entries };
  }
  state.diagnostics.push(unsupportedDiagnostic(path, value));
  return { kind: 'omitted' };
}

/** Lower an authoring/runtime value into canonical PlanValue form. */
export function lowerPlanValue(
  value: unknown,
  options: {
    readonly expressionLanguage?: ExpressionIR['language'];
    readonly specSchema?: SchemaIR;
    readonly strict?: boolean;
  } = {}
): PlanValueLoweringResult {
  const state: MutableLoweringState = {
    diagnostics: [],
    seen: new WeakSet<object>(),
    sensitive: false,
  };
  const loweredValue = lowerValue(value, '$', state, options.expressionLanguage ?? 'portable-cel');
  const lowered = options.specSchema
    ? applySchemaReferenceOptionality(loweredValue, options.specSchema)
    : loweredValue;
  if (options.strict && state.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new TypeKroError(
      `Plan value lowering failed: ${state.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`,
      'PLAN_VALUE_LOWERING_FAILED',
      { diagnostics: state.diagnostics }
    );
  }
  return {
    value: lowered,
    diagnostics: state.diagnostics,
    sensitivity: state.sensitive ? 'sensitive' : 'public',
  };
}

function assertSensitiveSourceContainsNoLiteral(value: PlanValue, path: string): void {
  switch (value.kind) {
    case 'literal':
      throw new TypeKroError(
        `Sensitive values cannot contain plaintext literals at ${path}.`,
        'PLAN_VALUE_DECODE_FAILED',
        { path }
      );
    case 'array':
      value.items.forEach((item, index) =>
        assertSensitiveSourceContainsNoLiteral(item, `${path}.items[${index}]`)
      );
      return;
    case 'object':
      value.entries.forEach((entry, index) =>
        assertSensitiveSourceContainsNoLiteral(entry.value, `${path}.entries[${index}].value`)
      );
      return;
    case 'sensitive-value':
      assertSensitiveSourceContainsNoLiteral(value.value, `${path}.value`);
      return;
    default:
      // Templates may contain public literal framing around symbolic segments.
      // Expressions and opaque bindings are validated by assertPlanValue().
      return;
  }
}

function assertPlanValue(value: unknown, path: string): asserts value is PlanValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeKroError(`Invalid PlanValue at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', { path });
  }
  const kind = Reflect.get(value, 'kind');
  switch (kind) {
    case 'literal': {
      const literal = Reflect.get(value, 'value');
      if (
        literal !== null &&
        typeof literal !== 'string' &&
        typeof literal !== 'number' &&
        typeof literal !== 'boolean'
      ) {
        throw new TypeKroError(`Invalid literal at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', {
          path,
        });
      }
      if (typeof literal === 'number' && !Number.isFinite(literal)) {
        throw new TypeKroError(
          `Invalid non-finite literal at ${path}.`,
          'PLAN_VALUE_DECODE_FAILED',
          {
            path,
          }
        );
      }
      return;
    }
    case 'array': {
      const items = Reflect.get(value, 'items');
      if (!Array.isArray(items)) {
        throw new TypeKroError(`Invalid array at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', { path });
      }
      items.forEach((item, index) => assertPlanValue(item, `${path}.items[${index}]`));
      return;
    }
    case 'object': {
      const entries = Reflect.get(value, 'entries');
      if (!Array.isArray(entries)) {
        throw new TypeKroError(`Invalid object at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', { path });
      }
      let previousKey: string | undefined;
      entries.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object' || typeof Reflect.get(entry, 'key') !== 'string') {
          throw new TypeKroError(`Invalid object entry at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', {
            path,
          });
        }
        const key = Reflect.get(entry, 'key') as string;
        if (previousKey !== undefined && key <= previousKey) {
          throw new TypeKroError(
            `Object entries at ${path} must have unique, canonically sorted keys.`,
            'PLAN_VALUE_DECODE_FAILED',
            { path }
          );
        }
        previousKey = key;
        assertPlanValue(Reflect.get(entry, 'value'), `${path}.entries[${index}].value`);
      });
      return;
    }
    case 'reference':
      if (
        (Reflect.get(value, 'source') !== 'spec' && Reflect.get(value, 'source') !== 'resource') ||
        typeof Reflect.get(value, 'fieldPath') !== 'string' ||
        (Reflect.get(value, 'source') === 'resource' &&
          typeof Reflect.get(value, 'resourceId') !== 'string') ||
        (Reflect.get(value, 'source') === 'spec' &&
          Reflect.get(value, 'resourceId') !== undefined) ||
        (Reflect.get(value, 'optional') !== undefined && Reflect.get(value, 'optional') !== true) ||
        (Reflect.get(value, 'nestedComposition') !== undefined &&
          Reflect.get(value, 'nestedComposition') !== true) ||
        (Reflect.get(value, 'source') === 'spec' &&
          Reflect.get(value, 'nestedComposition') !== undefined)
      ) {
        throw new TypeKroError(`Invalid reference at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', {
          path,
        });
      }
      return;
    case 'expression': {
      const expression = Reflect.get(value, 'expression');
      if (
        !expression ||
        typeof expression !== 'object' ||
        Reflect.get(expression, 'version') !== 1 ||
        (Reflect.get(expression, 'language') !== 'portable-cel' &&
          Reflect.get(expression, 'language') !== 'raw-cel') ||
        typeof Reflect.get(expression, 'expression') !== 'string' ||
        (Reflect.get(expression, 'expression') as string).trim().length === 0 ||
        !Array.isArray(Reflect.get(expression, 'references')) ||
        (Reflect.get(expression, 'sensitivity') !== 'public' &&
          Reflect.get(expression, 'sensitivity') !== 'sensitive')
      ) {
        throw new TypeKroError(`Invalid expression at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', {
          path,
        });
      }
      for (const [index, reference] of Reflect.get(expression, 'references').entries()) {
        if (
          !reference ||
          typeof reference !== 'object' ||
          (Reflect.get(reference, 'source') !== 'spec' &&
            Reflect.get(reference, 'source') !== 'resource') ||
          typeof Reflect.get(reference, 'fieldPath') !== 'string' ||
          (Reflect.get(reference, 'source') === 'resource' &&
            typeof Reflect.get(reference, 'resourceId') !== 'string')
        ) {
          throw new TypeKroError(
            `Invalid expression reference at ${path}.expression.references[${index}].`,
            'PLAN_VALUE_DECODE_FAILED',
            { path }
          );
        }
      }
      const sourceLocation = Reflect.get(expression, 'sourceLocation');
      if (
        sourceLocation !== undefined &&
        (!sourceLocation ||
          typeof sourceLocation !== 'object' ||
          (Reflect.get(sourceLocation, 'file') !== undefined &&
            typeof Reflect.get(sourceLocation, 'file') !== 'string') ||
          (Reflect.get(sourceLocation, 'line') !== undefined &&
            typeof Reflect.get(sourceLocation, 'line') !== 'number') ||
          (Reflect.get(sourceLocation, 'column') !== undefined &&
            typeof Reflect.get(sourceLocation, 'column') !== 'number'))
      ) {
        throw new TypeKroError(
          `Invalid expression source location at ${path}.`,
          'PLAN_VALUE_DECODE_FAILED',
          { path }
        );
      }
      return;
    }
    case 'template': {
      const segments = Reflect.get(value, 'segments');
      if (!Array.isArray(segments) || segments.length === 0) {
        throw new TypeKroError(`Invalid template at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', {
          path,
        });
      }
      segments.forEach((segment, index) => {
        if (!segment || typeof segment !== 'object') {
          throw new TypeKroError(
            `Invalid template segment at ${path}.`,
            'PLAN_VALUE_DECODE_FAILED',
            {
              path,
            }
          );
        }
        if (Reflect.get(segment, 'kind') === 'literal') {
          if (typeof Reflect.get(segment, 'value') !== 'string') {
            throw new TypeKroError(
              `Invalid literal template segment at ${path}.segments[${index}].`,
              'PLAN_VALUE_DECODE_FAILED',
              { path }
            );
          }
          return;
        }
        if (Reflect.get(segment, 'kind') === 'expression') {
          const expression = Reflect.get(segment, 'expression');
          assertPlanValue({ kind: 'expression', expression }, `${path}.segments[${index}]`);
          return;
        }
        if (
          Reflect.get(segment, 'kind') !== 'reference' ||
          (Reflect.get(segment, 'source') !== 'spec' &&
            Reflect.get(segment, 'source') !== 'resource') ||
          typeof Reflect.get(segment, 'fieldPath') !== 'string' ||
          (Reflect.get(segment, 'source') === 'resource' &&
            typeof Reflect.get(segment, 'resourceId') !== 'string') ||
          (Reflect.get(segment, 'source') === 'spec' &&
            Reflect.get(segment, 'resourceId') !== undefined) ||
          (Reflect.get(segment, 'optional') !== undefined &&
            Reflect.get(segment, 'optional') !== true) ||
          (Reflect.get(segment, 'nestedComposition') !== undefined &&
            Reflect.get(segment, 'nestedComposition') !== true) ||
          (Reflect.get(segment, 'source') === 'spec' &&
            Reflect.get(segment, 'nestedComposition') !== undefined)
        ) {
          throw new TypeKroError(
            `Invalid reference template segment at ${path}.segments[${index}].`,
            'PLAN_VALUE_DECODE_FAILED',
            { path }
          );
        }
      });
      return;
    }
    case 'omitted':
      return;
    case 'sensitive-binding':
      if (
        typeof Reflect.get(value, 'binding') !== 'string' ||
        (Reflect.get(value, 'binding') as string).length === 0 ||
        (Reflect.get(value, 'version') !== undefined &&
          typeof Reflect.get(value, 'version') !== 'string')
      ) {
        throw new TypeKroError(
          `Invalid sensitive binding at ${path}.`,
          'PLAN_VALUE_DECODE_FAILED',
          {
            path,
          }
        );
      }
      return;
    case 'sensitive-value': {
      const wrapped = Reflect.get(value, 'value');
      if (!wrapped || typeof wrapped !== 'object') {
        throw new TypeKroError(`Invalid sensitive value at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', {
          path,
        });
      }
      assertPlanValue(wrapped, `${path}.value`);
      assertSensitiveSourceContainsNoLiteral(wrapped, `${path}.value`);
      return;
    }
    case 'external-input':
      if (
        typeof Reflect.get(value, 'name') !== 'string' ||
        (Reflect.get(value, 'name') as string).length === 0
      ) {
        throw new TypeKroError(`Invalid external input at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', {
          path,
        });
      }
      return;
    case 'artifact-output':
      if (
        typeof Reflect.get(value, 'requirementId') !== 'string' ||
        (Reflect.get(value, 'requirementId') as string).length === 0 ||
        typeof Reflect.get(value, 'output') !== 'string' ||
        (Reflect.get(value, 'output') as string).length === 0
      ) {
        throw new TypeKroError(`Invalid artifact output at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', {
          path,
        });
      }
      return;
    default:
      throw new TypeKroError(`Unknown PlanValue kind at ${path}.`, 'PLAN_VALUE_DECODE_FAILED', {
        path,
      });
  }
}

/** Canonically encode a PlanValue. */
export function encodePlanValue(value: PlanValue): string {
  return canonicalStringify(value);
}

/** Decode and structurally validate a PlanValue. */
export function decodePlanValue(encoded: string): PlanValue {
  const parsed: unknown = JSON.parse(encoded);
  assertPlanValue(parsed, '$');
  return parsed;
}

/** Emit the canonical CEL source consumed by the KRO frontend. */
export function emitExpressionCel(expression: ExpressionIR): string {
  return expression.expression;
}

/** Evaluate portable expression IR through the same CEL evaluator used by direct mode. */
export async function evaluateExpressionIR(
  expression: ExpressionIR,
  context: CelEvaluationContext
): Promise<unknown> {
  if (expression.language !== 'portable-cel') {
    throw new TypeKroError(
      'Raw CEL expression IR cannot be evaluated as a portable direct expression.',
      'PLAN_EXPRESSION_TARGET_UNSUPPORTED',
      { language: expression.language }
    );
  }
  return new CelEvaluator().evaluate(
    { [CEL_EXPRESSION_BRAND]: true, expression: expression.expression },
    context
  );
}
