/**
 * CEL Expression Validator for Kro Compatibility
 *
 * This module validates CEL expressions to ensure they comply with Kro's requirements:
 * 1. Status fields must reference actual resources (not hardcoded strings)
 * 2. Resource IDs must be camelCase
 * 3. All referenced resources must exist in the ResourceGraphDefinition
 */

import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import {
  celRootReferences,
  kubernetesMarkerReferences,
  type CelRootReference,
} from '../../utils/cel-resource-identifiers.js';
import { remapVariableNames } from '../composition/nested-status-cel.js';
import { getMetadataField, getResourceId } from '../metadata/index.js';
import { isStaticExpression, lookupNestedExpression } from '../serialization/cel-references.js';
import type { KubernetesResource } from '../types.js';

export interface StatusResourceIdentityContext {
  readonly resourceIds: ReadonlySet<string>;
  readonly resourceAliases: ReadonlyMap<string, string>;
  readonly ambiguousResourceAliases: ReadonlyMap<string, readonly string[]>;
}

export function getNestedCompositionIds(
  statusMappings: Readonly<Record<string, unknown>>
): ReadonlySet<string> {
  const descriptor = Object.getOwnPropertyDescriptor(statusMappings, '__nestedCompositionFns');
  return descriptor?.value instanceof Map
    ? new Set(
        [...descriptor.value.keys()].filter((value): value is string => typeof value === 'string')
      )
    : new Set();
}

function deriveResourceIdAliases(resourceId: string): string[] {
  const aliases: string[] = [];
  for (const match of resourceId.matchAll(/\d+/g)) {
    const suffix = resourceId.slice((match.index ?? 0) + match[0].length);
    if (suffix && /^[A-Z]/.test(suffix)) {
      aliases.push(suffix.charAt(0).toLowerCase() + suffix.slice(1));
    }
  }
  return aliases;
}

/**
 * Build the canonical resource identity set used by status planning,
 * serialization, and client-side hydration.
 */
export function createStatusResourceIdentityContext(
  resources: Readonly<Record<string, KubernetesResource>>
): StatusResourceIdentityContext {
  const resourceIds = new Set<string>();
  const resourceAliases = new Map<string, string>();
  const identityOwners = new Map<string, { canonicalId: string; resourceKey: string }>();
  const ambiguousResourceAliases = new Map<string, Set<string>>();

  const registerIdentity = (
    identity: string,
    canonicalId: string,
    resourceKey: string
  ): void => {
    const ambiguousOwners = ambiguousResourceAliases.get(identity);
    if (ambiguousOwners) {
      ambiguousOwners.add(canonicalId);
      resourceIds.add(identity);
      return;
    }
    const existing = identityOwners.get(identity);
    if (existing && existing.canonicalId !== canonicalId) {
      ambiguousResourceAliases.set(identity, new Set([existing.canonicalId, canonicalId]));
      resourceAliases.delete(identity);
      resourceIds.add(identity);
      return;
    }
    identityOwners.set(identity, { canonicalId, resourceKey });
    resourceIds.add(identity);
    resourceAliases.set(identity, canonicalId);
  };

  for (const [resourceKey, resource] of Object.entries(resources)) {
    const resourceId = getResourceId(resource) ?? resourceKey;
    registerIdentity(resourceKey, resourceId, resourceKey);
    registerIdentity(resourceId, resourceId, resourceKey);

    for (const alias of new Set([
      ...deriveResourceIdAliases(resourceKey),
      ...deriveResourceIdAliases(resourceId),
      ...(getMetadataField(resource, 'resourceAliases') ?? []),
    ])) {
      registerIdentity(alias, resourceId, resourceKey);
    }
  }

  return {
    resourceIds,
    resourceAliases,
    ambiguousResourceAliases: new Map(
      [...ambiguousResourceAliases].map(([identity, owners]) => [identity, [...owners]])
    ),
  };
}

export interface CelValidationError {
  field: string;
  expression: string;
  error: string;
  suggestion?: string;
  /** Machine-readable finding category (used by strict CEL diagnostics). */
  code?: 'unknown-resource' | 'ambiguous-resource' | 'sensitive-status';
  /** The unresolved resource id, when code is 'unknown-resource'. */
  referencedResource?: string;
}

export interface CelValidationResult {
  isValid: boolean;
  errors: CelValidationError[];
  warnings: CelValidationError[];
}

/**
 * Validates that a resource ID follows camelCase convention required by Kro
 */
export function validateResourceId(id: string): { isValid: boolean; error?: string } {
  // Check if it's camelCase (starts with lowercase, no hyphens, no underscores)
  const camelCaseRegex = /^[a-z][a-zA-Z0-9]*$/;

  if (!camelCaseRegex.test(id)) {
    let suggestion = id;

    // Convert kebab-case to camelCase
    if (id.includes('-')) {
      suggestion = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    }

    // Convert dot.case to camelCase
    if (id.includes('.')) {
      suggestion = id.replace(/\.([a-z])/g, (_, letter: string) => letter.toUpperCase());
    }

    // Convert snake_case to camelCase
    if (id.includes('_')) {
      suggestion = id.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    }

    // Ensure first letter is lowercase
    suggestion = suggestion.charAt(0).toLowerCase() + suggestion.slice(1);

    return {
      isValid: false,
      error: `Resource ID '${id}' is not valid. Kro requires camelCase IDs. Suggested: '${suggestion}'`,
    };
  }

  return { isValid: true };
}

/**
 * Determines if a status field value requires Kro resolution.
 *
 * A value requires KRO resolution iff, after transitively resolving any
 * nested-composition references through `nestedStatusCel`, it depends on
 * at least one real-resource reference. Schema refs and literal values — at any depth,
 * including the far side of nested composition references — are static
 * and hydrated by the TypeKro runtime at deploy time.
 *
 * Dynamic (KRO resolves):
 *   - status.*             — only available after deployment
 *   - spec.*               — may include controller/defaulted or externalRef fields
 *   - metadata.uid         — assigned by API server
 *   - metadata.creationTimestamp / resourceVersion / generation
 *   - explicit CEL naming a known graph resource, including kind-specific
 *     top-level fields such as ConfigMap data or Secret stringData
 *
 * Static (TypeKro resolves at deploy time):
 *   - __schema__ refs       — resolved against the CR spec
 *   - metadata.name / namespace / labels / annotations (composition-set)
 *   - Literal values        — emitted as-is
 *   - Nested composition refs whose inner analyzed expression is itself
 *     fully static (transitive check)
 */
function requiresKroResolution(
  value: unknown,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>,
  nestedCompositionIds: ReadonlySet<string> = new Set()
): boolean {
  const localResourceIds = resourceIds ? Array.from(resourceIds) : [];
  const preserveVariables = new Set<string>();
  if (nestedStatusCel) {
    for (const key of Object.keys(nestedStatusCel)) {
      const match = key.match(/^__nestedStatus:([^:]+):/);
      const id = match?.[1];
      if (id && !resourceIds?.has(id)) {
        preserveVariables.add(id);
      }
    }
  }

  if (isKubernetesRef(value)) {
    // Schema refs — always static.
    if (value.resourceId === '__schema__') {
      return false;
    }
    if (typeof value.fieldPath !== 'string') return false;

    // Nested composition refs — look up the inner analyzed expression
    // and classify it transitively. If the inner resolves to something
    // that depends only on schema refs and literals, this outer ref is
    // also static.
    const isNestedComp = (value as { __nestedComposition?: boolean }).__nestedComposition === true;
    if (isNestedComp && nestedStatusCel) {
      const fieldName = value.fieldPath.replace(/^status\./, '');
      const innerExpr = resourceIds?.has(value.resourceId)
        ? lookupNestedExpression(value.resourceId, fieldName, nestedStatusCel, false)
        : lookupNestedExpression(value.resourceId, fieldName, nestedStatusCel);
      if (innerExpr !== undefined) {
        return !isStaticExpression(innerExpr, nestedStatusCel, resourceIds, true);
      }
      // Nested ref with no entry in the table is conservatively dynamic. Do not
      // log during classification: later analysis may still recover an alias.
      // Final validation reports an unresolved ref structurally if it survives.
      return true;
    }

    // Direct resource refs — status.*, spec.*, and generated metadata.* are dynamic,
    // composition-set metadata.* is static.
    const fieldPath = value.fieldPath;
    if (fieldPath.startsWith('status.')) return true;
    if (fieldPath.startsWith('spec.')) return true;
    if (fieldPath.startsWith('metadata.')) {
      const staticMetadataFields = [
        'metadata.name',
        'metadata.namespace',
        'metadata.labels',
        'metadata.annotations',
      ];
      return !staticMetadataFields.some((f) => fieldPath === f || fieldPath.startsWith(`${f}.`));
    }
    return false;
  }

  if (isCelExpression(value)) {
    const normalizedExpression =
      localResourceIds.length > 0
        ? remapVariableNames(value.expression, localResourceIds, preserveVariables)
        : value.expression;
    const referencesNestedComposition = [...nestedCompositionIds].some((id) =>
      new RegExp(`(^|[^\\w$])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.`).test(
        normalizedExpression
      )
    );
    return !isStaticExpression(
      normalizedExpression,
      nestedStatusCel,
      resourceIds,
      referencesNestedComposition
    );
  }

  // Strings potentially containing __KUBERNETES_REF__ markers from
  // template literals. Classify transitively: a marker string referencing
  // only schema fields (and literal text) is static even though it
  // contains markers.
  if (typeof value === 'string') {
    if (!value.includes('__KUBERNETES_REF_')) return false;
    const normalizedValue =
      localResourceIds.length > 0
        ? remapVariableNames(value, localResourceIds, preserveVariables)
        : value;
    const referencesNestedComposition = [...nestedCompositionIds].some(
      (id) =>
        normalizedValue.includes(`__KUBERNETES_REF_${id}_`) ||
        new RegExp(`(^|[^\\w$])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.`).test(
          normalizedValue
        )
    );
    return !isStaticExpression(
      normalizedValue,
      nestedStatusCel,
      resourceIds,
      referencesNestedComposition
    );
  }

  if (Array.isArray(value)) {
    return value.some((v) =>
      requiresKroResolution(v, nestedStatusCel, resourceIds, nestedCompositionIds)
    );
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).some((v) =>
      requiresKroResolution(v, nestedStatusCel, resourceIds, nestedCompositionIds)
    );
  }

  return false;
}

/**
 * Separates a nested object into static and dynamic parts.
 *
 * Classification is transitive over nested-composition references when a
 * `nestedStatusCel` lookup table is provided.
 */
function separateNestedObject(
  obj: Record<string, unknown>,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>,
  nestedCompositionIds: ReadonlySet<string> = new Set()
): {
  staticPart: Record<string, unknown>;
  dynamicPart: Record<string, unknown>;
  hasStatic: boolean;
  hasDynamic: boolean;
} {
  const staticPart: Record<string, unknown> = {};
  const dynamicPart: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !isKubernetesRef(value) &&
      !isCelExpression(value)
    ) {
      const nested = separateNestedObject(
        value as Record<string, unknown>,
        nestedStatusCel,
        resourceIds,
        nestedCompositionIds
      );

      if (nested.hasStatic) {
        staticPart[key] = nested.staticPart;
      }
      if (nested.hasDynamic) {
        dynamicPart[key] = nested.dynamicPart;
      }
    } else if (requiresKroResolution(value, nestedStatusCel, resourceIds, nestedCompositionIds)) {
      dynamicPart[key] = value;
    } else {
      staticPart[key] = value;
    }
  }

  return {
    staticPart,
    dynamicPart,
    hasStatic: Object.keys(staticPart).length > 0,
    hasDynamic: Object.keys(dynamicPart).length > 0,
  };
}

/**
 * Separate status mappings into static fields (hydrated locally by TypeKro)
 * and dynamic fields (emitted as CEL for KRO).
 *
 * When `nestedStatusCel` is provided, classification is transitive — a
 * nested composition reference whose target is a schema-only / literal
 * expression is classified as static even though the reference itself
 * looks like `<id>.status.<field>`. This is the key mechanism that
 * satisfies the "depth-agnostic staticness" invariant for nested
 * compositions.
 *
 * If `nestedStatusCel` is not explicitly passed, the function falls back
 * to reading `statusMappings.__nestedStatusCel` (which is where the
 * composition context attaches the table via Reflect.set), so existing
 * callers continue to work without explicit plumbing.
 */
export function separateStatusFields(
  statusMappings: Record<string, unknown>,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>,
  nestedCompositionIds: ReadonlySet<string> = getNestedCompositionIds(statusMappings)
): {
  staticFields: Record<string, unknown>;
  dynamicFields: Record<string, unknown>;
} {
  const staticFields: Record<string, unknown> = {};
  const dynamicFields: Record<string, unknown> = {};

  // Handle null/undefined inputs
  if (!statusMappings || typeof statusMappings !== 'object') {
    return { staticFields, dynamicFields };
  }

  // Fallback: pick up the nested status CEL table from the statusMappings
  // object itself. The composition context attaches it via Reflect.set as
  // a non-enumerable property, so we need getOwnPropertyDescriptor to see it.
  if (!nestedStatusCel) {
    const descriptor = Object.getOwnPropertyDescriptor(statusMappings, '__nestedStatusCel');
    if (descriptor?.value && typeof descriptor.value === 'object') {
      nestedStatusCel = descriptor.value as Record<string, string>;
    }
  }

  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    // Internal metadata fields are not user-facing status.
    if (fieldName.startsWith('__')) continue;

    if (
      typeof fieldValue === 'object' &&
      fieldValue !== null &&
      !Array.isArray(fieldValue) &&
      !isKubernetesRef(fieldValue) &&
      !isCelExpression(fieldValue)
    ) {
      // Handle nested objects that might have mixed static/dynamic fields
      const { staticPart, dynamicPart, hasStatic, hasDynamic } = separateNestedObject(
        fieldValue as Record<string, unknown>,
        nestedStatusCel,
        resourceIds,
        nestedCompositionIds
      );

      if (hasStatic) {
        staticFields[fieldName] = staticPart;
      }
      if (hasDynamic) {
        dynamicFields[fieldName] = dynamicPart;
      }
    } else if (
      requiresKroResolution(fieldValue, nestedStatusCel, resourceIds, nestedCompositionIds)
    ) {
      dynamicFields[fieldName] = fieldValue;
    } else {
      staticFields[fieldName] = fieldValue;
    }
  }

  return { staticFields, dynamicFields };
}

/**
 * Validates CEL expressions in dynamic status fields to ensure they reference actual resources
 */
export function validateStatusCelExpressions(
  statusMappings: Record<string, unknown>,
  resources: Record<string, KubernetesResource>,
  options: { readonly enforceSensitiveStatus?: boolean } = {}
): CelValidationResult {
  const errors: CelValidationError[] = [];
  const warnings: CelValidationError[] = [];
  const identityContext = createStatusResourceIdentityContext(resources);
  const resourceIds = new Set(identityContext.resourceIds);
  const resourcesByCanonicalId = new Map<string, KubernetesResource>();
  for (const [resourceKey, resource] of Object.entries(resources)) {
    resourcesByCanonicalId.set(getResourceId(resource) ?? resourceKey, resource);
  }
  const preserveVariables = new Set<string>();
  const nestedDescriptor = Object.getOwnPropertyDescriptor(statusMappings, '__nestedStatusCel');
  const nestedStatusCelForValidation =
    nestedDescriptor?.value && typeof nestedDescriptor.value === 'object'
      ? (nestedDescriptor.value as Record<string, string>)
      : undefined;
  if (nestedStatusCelForValidation) {
    for (const key of Object.keys(nestedStatusCelForValidation)) {
      const match = key.match(/^__nestedStatus:([^:]+):/);
      const id = match?.[1];
      if (id && !resourceIds.has(id)) {
        preserveVariables.add(id);
      }
    }
  }

  const nestedCompositionIds = getNestedCompositionIds(statusMappings);

  function isSensitiveSecretField(resourceId: string, fieldPath: string): boolean {
    const canonicalId = identityContext.resourceAliases.get(resourceId) ?? resourceId;
    const resource = resourcesByCanonicalId.get(canonicalId);
    const topLevelField = fieldPath.split('.')[0];
    return (
      resource?.kind === 'Secret' &&
      getMetadataField(resource, 'secretMaterial') !== 'public-placeholder' &&
      (fieldPath === '' || topLevelField === 'data' || topLevelField === 'stringData')
    );
  }

  function expressionReferences(
    expression: string
  ): readonly Pick<CelRootReference, 'root' | 'segments'>[] {
    return [...kubernetesMarkerReferences(expression), ...celRootReferences(expression)];
  }

  function findSensitiveReference(expression: string): string | undefined {
    const sensitiveReference = expressionReferences(expression).find((reference) =>
      isSensitiveSecretField(reference.root, reference.segments.join('.'))
    );
    return sensitiveReference
      ? `${sensitiveReference.root}${
          sensitiveReference.segments.length > 0
            ? `.${sensitiveReference.segments.join('.')}`
            : ''
        }`
      : undefined;
  }

  function findAmbiguousReference(value: unknown): string | undefined {
    if (isKubernetesRef(value)) {
      return identityContext.ambiguousResourceAliases.has(value.resourceId)
        ? value.resourceId
        : undefined;
    }
    if (isCelExpression(value)) {
      return expressionReferences(value.expression).find((reference) =>
        identityContext.ambiguousResourceAliases.has(reference.root)
      )?.root;
    }
    if (
      typeof value === 'string' &&
      (value.includes('__KUBERNETES_REF_') || value.includes('${'))
    ) {
      return expressionReferences(value).find((reference) =>
        identityContext.ambiguousResourceAliases.has(reference.root)
      )?.root;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const ambiguousReference = findAmbiguousReference(item);
        if (ambiguousReference) return ambiguousReference;
      }
    } else if (value && typeof value === 'object') {
      for (const nestedValue of Object.values(value)) {
        const ambiguousReference = findAmbiguousReference(nestedValue);
        if (ambiguousReference) return ambiguousReference;
      }
    }
    return undefined;
  }

  function validateSensitivity(fieldName: string, value: unknown): void {
    let sensitiveExpression: string | undefined;
    if (isKubernetesRef(value)) {
      if (isSensitiveSecretField(value.resourceId, value.fieldPath)) {
        sensitiveExpression = `${value.resourceId}.${value.fieldPath}`;
      }
    } else if (isCelExpression(value)) {
      sensitiveExpression = findSensitiveReference(value.expression);
    } else if (
      typeof value === 'string' &&
      (value.includes('__KUBERNETES_REF_') || value.includes('${'))
    ) {
      sensitiveExpression = findSensitiveReference(value);
    } else if (value && typeof value === 'object') {
      for (const [key, nestedValue] of Object.entries(value)) {
        validateSensitivity(`${fieldName}.${key}`, nestedValue);
      }
    }
    if (sensitiveExpression) {
      const referencedResource = sensitiveExpression.split('.')[0];
      errors.push({
        field: fieldName,
        expression: sensitiveExpression,
        error: `Status field '${fieldName}' derives from sensitive Secret data and cannot be projected`,
        suggestion:
          'Project a non-sensitive readiness or identity field instead of Secret data/stringData',
        code: 'sensitive-status',
        ...(referencedResource ? { referencedResource } : {}),
      });
    }
  }

  if (options.enforceSensitiveStatus !== false) {
    for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
      if (!fieldName.startsWith('__')) {
        validateSensitivity(fieldName, fieldValue);
      }
    }
  }

  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    if (fieldName.startsWith('__')) continue;
    const ambiguousReference = findAmbiguousReference(fieldValue);
    if (!ambiguousReference) continue;
    const owners = identityContext.ambiguousResourceAliases.get(ambiguousReference) ?? [];
    errors.push({
      field: fieldName,
      expression: ambiguousReference,
      error:
        `Status resource identity '${ambiguousReference}' is ambiguous between resources ` +
        owners.map((owner) => `'${owner}'`).join(' and '),
      suggestion: 'Reference an unambiguous canonical resource id',
      code: 'ambiguous-resource',
      referencedResource: ambiguousReference,
    });
  }

  // Separate static and dynamic fields using the same graph identities as serialization.
  const { staticFields, dynamicFields } = separateStatusFields(
    statusMappings,
    nestedStatusCelForValidation,
    resourceIds,
    nestedCompositionIds
  );

  /**
   * Scan a (remapped) expression for direct resource references (`id.status.` / `id.spec.` /
   * `id.metadata.`) whose root is not a known resource, schema, CEL lambda variable, or preserved
   * nested-composition handle. Shared by the two validation passes below.
   */
  function scanUnknownReferences(
    expression: string
  ): Array<{ referencedId: string; matchedRef: string }> {
    // Extract CEL lambda variable names to exclude them from resource ID checks.
    // CEL macros like .all(v, body), .exists(v, body), .map(v, body), .filter(v, body)
    // introduce lambda variables that should not be treated as resource IDs.
    const lambdaVarPattern = /\.(?:all|exists|map|filter)\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,/g;
    const lambdaVars = new Set<string>();
    let lambdaMatch: RegExpExecArray | null = lambdaVarPattern.exec(expression);
    while (lambdaMatch !== null) {
      if (lambdaMatch[1]) lambdaVars.add(lambdaMatch[1]);
      lambdaMatch = lambdaVarPattern.exec(expression);
    }
    // Also add 'each' as it's a Kro readyWhen keyword for forEach collections
    lambdaVars.add('each');

    const findings: Array<{ referencedId: string; matchedRef: string }> = [];
    const directResourceRefPattern = /\b([a-zA-Z][a-zA-Z0-9]*)\.(status|spec|metadata)\./g;
    let directMatch: RegExpExecArray | null = directResourceRefPattern.exec(expression);
    while (directMatch !== null) {
      const referencedId = directMatch[1] ?? '';
      if (
        referencedId !== 'schema' &&
        !resourceIds.has(referencedId) &&
        !lambdaVars.has(referencedId) &&
        !preserveVariables.has(referencedId)
      ) {
        findings.push({ referencedId, matchedRef: directMatch[0] ?? '' });
      }
      directMatch = directResourceRefPattern.exec(expression);
    }
    return findings;
  }

  // Only validate dynamic fields that will be sent to Kro
  function validateExpression(fieldName: string, value: unknown): void {
    if (isKubernetesRef(value)) {
      const isNestedComposition =
        (value as { __nestedComposition?: boolean }).__nestedComposition === true;
      if (!isNestedComposition) return;

      const nestedField = value.fieldPath.replace(/^status\./, '');
      const nestedExpression = nestedStatusCelForValidation
        ? resourceIds.has(value.resourceId)
          ? lookupNestedExpression(
              value.resourceId,
              nestedField,
              nestedStatusCelForValidation,
              false
            )
          : lookupNestedExpression(value.resourceId, nestedField, nestedStatusCelForValidation)
        : undefined;
      if (nestedExpression === undefined) {
        warnings.push({
          field: fieldName,
          expression: `${value.resourceId}.${value.fieldPath}`,
          error: `Nested composition reference '${value.resourceId}.${value.fieldPath}' has no final status-expression mapping`,
          suggestion:
            'Use a supported nested-composition assignment shape or expose the referenced status field directly',
          code: 'unknown-resource',
          referencedResource: value.resourceId,
        });
      }
    } else if (isCelExpression(value)) {
      const idList = Array.from(resourceIds).filter((id): id is string => typeof id === 'string');

      // PASS 1 — mirror the serializer's variable remapping EXACTLY (single-resource fallback
      // included) so anything the serializer will successfully resolve doesn't false-positive.
      // These findings gate LENIENT composition validation, so this pass must stay byte-identical
      // to the historical behavior.
      const expression = remapVariableNames(value.expression, idList, preserveVariables);
      const lenientFindings = scanUnknownReferences(expression);
      for (const { referencedId, matchedRef } of lenientFindings) {
        // Check if this specific reference is a cross-composition status access.
        // Cross-composition references (e.g., `otherComposition.status.ready`) are valid
        // even if the referenced composition is not a registered resource in THIS graph.
        // We only suppress the error when the SPECIFIC unresolved reference accesses .status.,
        // not when .status. appears anywhere in the expression.
        const isCrossCompositionRef =
          matchedRef.includes('.status.') && !matchedRef.includes('.spec.');
        if (isCrossCompositionRef) {
          warnings.push({
            field: fieldName,
            expression,
            error: `Reference '${referencedId}' is not a registered resource — treating as cross-composition reference`,
            suggestion: `If this is not a cross-composition reference, check that resource '${referencedId}' is created in the composition`,
            code: 'unknown-resource',
            referencedResource: referencedId,
          });
        } else {
          errors.push({
            field: fieldName,
            expression,
            error: `Referenced resource '${referencedId}' does not exist`,
            suggestion: `Available resources: ${Array.from(resourceIds).join(', ')}`,
            code: 'unknown-resource',
            referencedResource: referencedId,
          });
        }
      }

      // PASS 2 — the same scan WITHOUT the named-variable single-resource fallback. A name that is
      // unknown here but resolved in pass 1 was bound purely by "there's only one resource here"
      // guesswork — in a one-resource graph that guesswork would otherwise blind validation to a
      // genuinely nonexistent reference (`nosuchresource.status.ready` silently validating as
      // `deployment.status.ready`). Reported as WARNINGS (never errors — lenient serialization still
      // resolves them via the fallback) carrying code 'unknown-resource', which the strict factory
      // gate (`strictCelDiagnostics` / TYPEKRO_STRICT_CEL) escalates to a serialization failure.
      const strictExpression = remapVariableNames(value.expression, idList, preserveVariables, {
        namedVariableSingleResourceFallback: false,
      });
      if (strictExpression !== expression) {
        const alreadyReported = new Set(lenientFindings.map((f) => f.referencedId));
        for (const { referencedId } of scanUnknownReferences(strictExpression)) {
          if (alreadyReported.has(referencedId)) continue;
          alreadyReported.add(referencedId);
          warnings.push({
            field: fieldName,
            expression: strictExpression,
            error: `Reference '${referencedId}' resolves only via the single-resource fallback (bound to '${idList[0]}') — not a provable resource reference`,
            suggestion: `Reference the resource by its id ('${idList[0]}'), or check that '${referencedId}' names a resource created in this composition`,
            code: 'unknown-resource',
            referencedResource: referencedId,
          });
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      // Recursively validate nested objects
      for (const [key, nestedValue] of Object.entries(value)) {
        validateExpression(`${fieldName}.${key}`, nestedValue);
      }
    }
  }

  // Only validate dynamic fields
  for (const [fieldName, fieldValue] of Object.entries(dynamicFields)) {
    validateExpression(fieldName, fieldValue);
  }

  const staticFieldNames = Object.keys(staticFields);

  if (staticFieldNames.length > 0) {
    warnings.push({
      field: 'status',
      expression: '',
      error: `Static fields (${staticFieldNames.join(', ')}) will be hydrated directly, not sent to Kro`,
      suggestion: 'This is normal behavior for fields without Kubernetes references',
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates all resource IDs in a resource collection
 */
export function validateResourceIds(
  resources: Record<string, KubernetesResource>
): CelValidationResult {
  const errors: CelValidationError[] = [];

  for (const [key, resource] of Object.entries(resources)) {
    if (resource.id) {
      const validation = validateResourceId(resource.id);
      if (!validation.isValid) {
        errors.push({
          field: `resources.${key}.id`,
          expression: resource.id,
          error: validation.error ?? 'Unknown CEL validation error',
        });
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings: [],
  };
}

/**
 * Comprehensive validation for a complete ResourceGraphDefinition
 */
export function validateResourceGraphDefinition(
  resources: Record<string, KubernetesResource>,
  statusMappings?: Record<string, unknown>
): CelValidationResult {
  const resourceIdValidation = validateResourceIds(resources);
  const statusValidation = statusMappings
    ? validateStatusCelExpressions(statusMappings, resources, {
        // Graph construction must remain available to semantic planning, which
        // independently taints and diagnoses sensitive projections. The legacy
        // KRO serializer enforces this boundary immediately before YAML emission.
        enforceSensitiveStatus: false,
      })
    : { isValid: true, errors: [], warnings: [] };

  return {
    isValid: resourceIdValidation.isValid && statusValidation.isValid,
    errors: [...resourceIdValidation.errors, ...statusValidation.errors],
    warnings: [...resourceIdValidation.warnings, ...statusValidation.warnings],
  };
}
