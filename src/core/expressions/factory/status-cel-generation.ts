/**
 * Status CEL Generation — Status context-specific CEL expression generation
 *
 * Extracted from status-builder-analyzer.ts. Contains methods for generating
 * CEL expressions with status-specific transformations, including null-safety,
 * hydration handling, field categorization, and type inference.
 */

import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { OptionalityContext } from '../magic-proxy/optionality-handler.js';
import type {
  FieldAvailabilityEstimate,
  StatusFieldCategory,
  StatusFieldHandlingInfo,
  StatusHandlingStrategy,
} from './status-builder-types.js';

// ── Static value conversion ──────────────────────────────────────────

/**
 * Convert static values (no KubernetesRef objects) to CEL expressions
 */
export function convertStaticValueToCel(value: unknown): CelExpression {
  let celExpression: string;
  let type: string;

  if (typeof value === 'string') {
    celExpression = `"${value.replace(/"/g, '\\"')}"`;
    type = 'string';
  } else if (typeof value === 'number') {
    celExpression = String(value);
    type = 'number';
  } else if (typeof value === 'boolean') {
    celExpression = String(value);
    type = 'boolean';
  } else if (value === null) {
    celExpression = 'null';
    type = 'null';
  } else if (value === undefined) {
    celExpression = 'null';
    type = 'null';
  } else if (Array.isArray(value)) {
    const elements = value.map((item) => convertStaticValueToCel(item).expression);
    celExpression = `[${elements.join(', ')}]`;
    type = 'array';
  } else if (typeof value === 'object') {
    const properties = Object.entries(value).map(([key, val]) => {
      const convertedVal = convertStaticValueToCel(val);
      return `"${key}": ${convertedVal.expression}`;
    });
    celExpression = `{${properties.join(', ')}}`;
    type = 'object';
  } else {
    celExpression = String(value);
    type = 'unknown';
  }

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: celExpression,
    type,
  } as CelExpression;
}

/**
 * Create a CelExpression for a static value
 */
export function createStaticCelExpression(value: string): CelExpression {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: value,
  } as CelExpression;
}

// ── Fallback CEL generation ──────────────────────────────────────────

/**
 * Generate fallback status CEL expression
 */
export function generateFallbackStatusCel(kubernetesRef: KubernetesRef<unknown>): CelExpression {
  const isSchemaRef = kubernetesRef.resourceId === '__schema__';
  const basePath = isSchemaRef
    ? `schema.${kubernetesRef.fieldPath}`
    : `resources.${kubernetesRef.resourceId}.${kubernetesRef.fieldPath}`;

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: basePath,
    type: 'unknown',
  } as CelExpression;
}

// ── Advanced CEL generation ──────────────────────────────────────────

/**
 * Generate advanced status context CEL with full feature support
 */
export function generateStatusContextCelWithAdvancedFeatures(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): CelExpression {
  const isSchemaRef = kubernetesRef.resourceId === '__schema__';
  const fieldPath = kubernetesRef.fieldPath || '';

  // Build base CEL expression
  let baseCelExpression: string;
  if (isSchemaRef) {
    baseCelExpression = `schema.${fieldPath}`;
  } else {
    baseCelExpression = `resources.${kubernetesRef.resourceId}.${fieldPath}`;
  }

  // Determine status-specific handling requirements
  const statusHandlingInfo = analyzeStatusFieldHandlingRequirements(kubernetesRef, context);

  // Apply status-specific transformations
  const finalExpression = applyStatusContextTransformations(
    baseCelExpression,
    statusHandlingInfo,
    context
  );

  // Infer the result type based on the field path and context
  const resultType = inferStatusFieldType(kubernetesRef);

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: finalExpression,
    type: resultType,
    metadata: {
      isStatusContext: true,
      requiresHydration: statusHandlingInfo.requiresHydration,
      isOptional: statusHandlingInfo.isOptional,
      handlingStrategy: statusHandlingInfo.strategy,
    },
  } as CelExpression;
}

// ── Field handling requirements ──────────────────────────────────────

/**
 * Analyze status field handling requirements
 */
export function analyzeStatusFieldHandlingRequirements(
  kubernetesRef: KubernetesRef<unknown>,
  _context: OptionalityContext
): StatusFieldHandlingInfo {
  const fieldPath = kubernetesRef.fieldPath || '';
  const isSchemaRef = kubernetesRef.resourceId === '__schema__';
  const isStatusField = fieldPath.startsWith('status.');

  // Determine if this field requires hydration
  const requiresHydration = !isSchemaRef && isStatusField;

  // Determine if this field is optional in status context
  const isOptional = isFieldOptionalInStatusContext(kubernetesRef);

  // Determine handling strategy
  let strategy: StatusHandlingStrategy;
  if (requiresHydration && isOptional) {
    strategy = 'hydration-with-null-safety';
  } else if (requiresHydration) {
    strategy = 'hydration-required';
  } else if (isOptional) {
    strategy = 'null-safety-only';
  } else {
    strategy = 'direct-access';
  }

  // Determine priority for status field evaluation
  const priority = calculateStatusFieldPriority(kubernetesRef);

  return {
    kubernetesRef,
    requiresHydration,
    isOptional,
    strategy,
    priority,
    fieldCategory: categorizeStatusField(fieldPath),
    expectedAvailability: estimateFieldAvailability(kubernetesRef),
  };
}

// ── Status context transformations ───────────────────────────────────

/**
 * Apply status context-specific transformations to CEL expression
 */
export function applyStatusContextTransformations(
  baseCelExpression: string,
  handlingInfo: StatusFieldHandlingInfo,
  context: OptionalityContext
): string {
  let transformedExpression = baseCelExpression;

  switch (handlingInfo.strategy) {
    case 'hydration-with-null-safety':
      transformedExpression = applyHydrationWithNullSafety(baseCelExpression, context);
      break;

    case 'hydration-required':
      transformedExpression = applyHydrationRequired(baseCelExpression, handlingInfo);
      break;

    case 'null-safety-only':
      transformedExpression = applyNullSafetyOnly(baseCelExpression, context);
      break;

    case 'direct-access':
      // No transformation needed
      break;
  }

  return transformedExpression;
}

/**
 * Apply hydration with null-safety transformation
 */
export function applyHydrationWithNullSafety(
  baseCelExpression: string,
  context: OptionalityContext
): string {
  if (context.useKroConditionals) {
    // Use Kro's conditional operators
    return baseCelExpression.replace(/\./g, '?.');
  } else if (context.generateHasChecks) {
    // Use has() checks
    const pathParts = baseCelExpression.split('.');
    const hasChecks: string[] = [];

    for (let i = 0; i < pathParts.length; i++) {
      const partialPath = pathParts.slice(0, i + 1).join('.');
      hasChecks.push(`has(${partialPath})`);
    }

    return `${hasChecks.join(' && ')} && ${baseCelExpression}`;
  }

  return baseCelExpression;
}

/**
 * Apply hydration required transformation
 */
export function applyHydrationRequired(
  baseCelExpression: string,
  handlingInfo: StatusFieldHandlingInfo
): string {
  // For hydration required fields, we might want to add readiness checks
  if (handlingInfo.fieldCategory === 'readiness-indicator') {
    return `${baseCelExpression} != null && ${baseCelExpression}`;
  }

  return baseCelExpression;
}

/**
 * Apply null-safety only transformation
 */
export function applyNullSafetyOnly(
  baseCelExpression: string,
  context: OptionalityContext
): string {
  if (context.generateHasChecks) {
    return `has(${baseCelExpression}) && ${baseCelExpression}`;
  }

  return baseCelExpression;
}

// ── Field optionality / priority / categorization ────────────────────

/**
 * Check if a field is optional in status context
 */
export function isFieldOptionalInStatusContext(kubernetesRef: KubernetesRef<unknown>): boolean {
  const fieldPath = kubernetesRef.fieldPath || '';

  // Status fields are generally optional during hydration
  if (fieldPath.startsWith('status.')) {
    return true;
  }

  // Some spec fields might be optional
  const optionalSpecFields = [
    'spec.replicas',
    'spec.resources',
    'spec.nodeSelector',
    'spec.tolerations',
  ];

  if (optionalSpecFields.some((field) => fieldPath.startsWith(field))) {
    return true;
  }

  // Metadata fields like labels and annotations are optional
  const optionalMetadataFields = ['metadata.labels', 'metadata.annotations', 'metadata.namespace'];

  if (optionalMetadataFields.some((field) => fieldPath.startsWith(field))) {
    return true;
  }

  return false;
}

/**
 * Calculate priority for status field evaluation
 */
export function calculateStatusFieldPriority(kubernetesRef: KubernetesRef<unknown>): number {
  const fieldPath = kubernetesRef.fieldPath || '';

  // Higher priority (lower number) for critical status fields
  if (fieldPath.includes('ready') || fieldPath.includes('available')) {
    return 1;
  }

  if (fieldPath.startsWith('status.conditions')) {
    return 2;
  }

  if (fieldPath.startsWith('status.')) {
    return 3;
  }

  if (fieldPath.startsWith('spec.')) {
    return 4;
  }

  if (fieldPath.startsWith('metadata.')) {
    return 5;
  }

  return 10; // Default priority
}

/**
 * Categorize status field type
 */
export function categorizeStatusField(fieldPath: string): StatusFieldCategory {
  if (fieldPath.includes('ready') || fieldPath.includes('available')) {
    return 'readiness-indicator';
  }

  if (fieldPath.includes('conditions')) {
    return 'condition-status';
  }

  if (fieldPath.includes('replicas')) {
    return 'replica-status';
  }

  if (fieldPath.includes('loadBalancer') || fieldPath.includes('ingress')) {
    return 'network-status';
  }

  if (fieldPath.includes('phase') || fieldPath.includes('state')) {
    return 'lifecycle-status';
  }

  return 'general-status';
}

/**
 * Estimate field availability timing
 */
export function estimateFieldAvailability(
  kubernetesRef: KubernetesRef<unknown>
): FieldAvailabilityEstimate {
  const fieldPath = kubernetesRef.fieldPath || '';

  if (kubernetesRef.resourceId === '__schema__') {
    return 'immediate';
  }

  if (fieldPath.startsWith('metadata.')) {
    return 'immediate';
  }

  if (fieldPath.startsWith('spec.')) {
    return 'immediate';
  }

  if (fieldPath.includes('ready') || fieldPath.includes('available')) {
    return 'delayed';
  }

  if (fieldPath.includes('loadBalancer') || fieldPath.includes('ingress')) {
    return 'very-delayed';
  }

  return 'delayed';
}

/**
 * Infer the type of a status field
 */
export function inferStatusFieldType(kubernetesRef: KubernetesRef<unknown>): string {
  const fieldPath = kubernetesRef.fieldPath || '';

  if (fieldPath.includes('replicas') || fieldPath.includes('count')) {
    return 'number';
  }

  if (fieldPath.includes('ready') || fieldPath.includes('available')) {
    return 'boolean';
  }

  if (fieldPath.includes('conditions')) {
    return 'array';
  }

  if (fieldPath.includes('phase') || fieldPath.includes('state')) {
    return 'string';
  }

  if (fieldPath.includes('ip') || fieldPath.includes('IP')) {
    return 'string';
  }

  return 'unknown';
}
