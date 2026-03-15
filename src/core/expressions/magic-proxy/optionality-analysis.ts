/**
 * Core optionality analysis functions for KubernetesRef objects.
 *
 * These standalone functions determine whether KubernetesRef objects
 * require null-safety handling based on Enhanced type behavior
 * and field hydration timing.
 */

import { extractResourceReferences } from '../../../utils/type-guards.js';
import type { KubernetesRef } from '../../types/common.js';
import type { OptionalityAnalysisResult, OptionalityContext } from './optionality-types.js';

/**
 * Analyze a single KubernetesRef for optionality requirements
 */
export function analyzeKubernetesRefOptionality(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): OptionalityAnalysisResult {
  const isSchemaReference = kubernetesRef.resourceId === '__schema__';
  const fieldPath = kubernetesRef.fieldPath || '';

  // Enhanced types appear non-optional at compile time but may be undefined at runtime
  const potentiallyUndefined = isPotentiallyUndefinedAtRuntime(kubernetesRef, context);
  const requiresNullSafety = potentiallyUndefined && (context.conservativeNullSafety ?? true);

  // Check if optional chaining was used in the original expression
  const hasOptionalChaining = hasOptionalChainingInExpression(kubernetesRef, context);

  const confidence = calculateOptionalityConfidence(kubernetesRef, context);
  const reason = determineOptionalityReason(kubernetesRef, context);

  const suggestedCelPattern = requiresNullSafety
    ? generateSuggestedCelPattern(kubernetesRef, context)
    : undefined;

  return {
    kubernetesRef,
    potentiallyUndefined,
    requiresNullSafety,
    hasOptionalChaining,
    fieldPath,
    resourceId: kubernetesRef.resourceId,
    isSchemaReference,
    confidence,
    reason,
    suggestedCelPattern,
  };
}

/**
 * Determine if a KubernetesRef is potentially undefined at runtime
 */
export function isPotentiallyUndefinedAtRuntime(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): boolean {
  // Schema references are generally available, but some schema fields might be optional
  if (kubernetesRef.resourceId === '__schema__') {
    return isSchemaFieldPotentiallyUndefined(kubernetesRef, context);
  }

  // Resource status fields are potentially undefined during field hydration
  if (kubernetesRef.fieldPath?.startsWith('status.')) {
    return isStatusFieldPotentiallyUndefined(kubernetesRef, context);
  }

  // Resource spec fields might be optional
  if (kubernetesRef.fieldPath?.startsWith('spec.')) {
    return isSpecFieldPotentiallyUndefined(kubernetesRef, context);
  }

  // Resource metadata fields are generally available but some might be optional
  if (kubernetesRef.fieldPath?.startsWith('metadata.')) {
    return isMetadataFieldPotentiallyUndefined(kubernetesRef, context);
  }

  // Check hydration state if available
  if (context.hydrationStates) {
    const stateKey = `${kubernetesRef.resourceId}:${kubernetesRef.fieldPath}`;
    const state = context.hydrationStates.get(stateKey);

    if (state) {
      return !state.isHydrated || state.hydrationFailed;
    }
  }

  // Conservative approach: assume potentially undefined for Enhanced types
  return true;
}

/**
 * Check if a schema field is potentially undefined
 */
export function isSchemaFieldPotentiallyUndefined(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): boolean {
  const fieldPath = kubernetesRef.fieldPath || '';

  // Common optional schema fields
  const commonOptionalFields = [
    'metadata.labels',
    'metadata.annotations',
    'metadata.namespace',
    'spec.replicas',
    'spec.resources',
    'spec.nodeSelector',
    'spec.tolerations',
    'spec.affinity',
  ];

  // Check if this is a commonly optional field
  if (commonOptionalFields.some((optional) => fieldPath.startsWith(optional))) {
    return true;
  }

  // Check for array access which might be undefined
  if (fieldPath.includes('[') || fieldPath.includes('.length')) {
    return true;
  }

  // Schema fields are generally available, but be conservative
  return context.conservativeNullSafety ?? true;
}

/**
 * Check if a status field is potentially undefined
 */
export function isStatusFieldPotentiallyUndefined(
  kubernetesRef: KubernetesRef<unknown>,
  _context: OptionalityContext
): boolean {
  const fieldPath = kubernetesRef.fieldPath || '';

  // Status fields are almost always potentially undefined during hydration
  const alwaysUndefinedStatusFields = [
    'status.conditions',
    'status.loadBalancer',
    'status.ingress',
    'status.podIP',
    'status.hostIP',
    'status.phase',
    'status.readyReplicas',
    'status.availableReplicas',
    'status.observedGeneration',
  ];

  // Check if this is a field that's commonly undefined
  if (alwaysUndefinedStatusFields.some((field) => fieldPath.startsWith(field))) {
    return true;
  }

  // All status fields are potentially undefined during field hydration
  return true;
}

/**
 * Check if a spec field is potentially undefined
 */
export function isSpecFieldPotentiallyUndefined(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): boolean {
  const fieldPath = kubernetesRef.fieldPath || '';

  // Common optional spec fields
  const commonOptionalSpecFields = [
    'spec.replicas',
    'spec.resources',
    'spec.nodeSelector',
    'spec.tolerations',
    'spec.affinity',
    'spec.volumes',
    'spec.volumeMounts',
    'spec.env',
    'spec.ports',
    'spec.selector',
  ];

  // Check if this is a commonly optional spec field
  if (commonOptionalSpecFields.some((optional) => fieldPath.startsWith(optional))) {
    return true;
  }

  // Check for array access
  if (fieldPath.includes('[') || fieldPath.includes('.length')) {
    return true;
  }

  // Most spec fields are required, but be conservative for Enhanced types
  return context.conservativeNullSafety ?? false;
}

/**
 * Check if a metadata field is potentially undefined
 */
export function isMetadataFieldPotentiallyUndefined(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): boolean {
  const fieldPath = kubernetesRef.fieldPath || '';

  // Common optional metadata fields
  const commonOptionalMetadataFields = [
    'metadata.labels',
    'metadata.annotations',
    'metadata.namespace',
    'metadata.ownerReferences',
    'metadata.finalizers',
  ];

  // Check if this is a commonly optional metadata field
  if (commonOptionalMetadataFields.some((optional) => fieldPath.startsWith(optional))) {
    return true;
  }

  // Core metadata fields like name and uid are generally available
  const coreMetadataFields = [
    'metadata.name',
    'metadata.uid',
    'metadata.creationTimestamp',
    'metadata.generation',
  ];

  if (coreMetadataFields.some((core) => fieldPath.startsWith(core))) {
    return false;
  }

  // Be conservative for other metadata fields
  return context.conservativeNullSafety ?? true;
}

/**
 * Check if optional chaining was used in the original expression
 */
export function hasOptionalChainingInExpression(
  _kubernetesRef: KubernetesRef<unknown>,
  _context: OptionalityContext
): boolean {
  // This would need to be determined from the original expression AST
  // For now, return false as a placeholder
  return false;
}

/**
 * Calculate confidence level for optionality analysis
 */
export function calculateOptionalityConfidence(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): number {
  let confidence = 0.8; // Base confidence

  // Higher confidence for schema references
  if (kubernetesRef.resourceId === '__schema__') {
    confidence += 0.1;
  }

  // Lower confidence for status fields (more likely to be undefined)
  if (kubernetesRef.fieldPath?.startsWith('status.')) {
    confidence -= 0.2;
  }

  // Higher confidence if we have hydration state information
  if (context.hydrationStates) {
    confidence += 0.1;
  }

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Determine the reason for optionality determination
 */
export function determineOptionalityReason(
  kubernetesRef: KubernetesRef<unknown>,
  _context: OptionalityContext
): string {
  if (kubernetesRef.resourceId === '__schema__') {
    return 'Schema reference - generally available';
  }

  if (kubernetesRef.fieldPath?.startsWith('status.')) {
    return 'Status field - potentially undefined during field hydration';
  }

  return 'Enhanced type - appears non-optional at compile time but may be undefined at runtime';
}

/**
 * Generate suggested CEL pattern for null-safety
 */
export function generateSuggestedCelPattern(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): string {
  const resourcePath =
    kubernetesRef.resourceId === '__schema__'
      ? `schema.${kubernetesRef.fieldPath}`
      : `resources.${kubernetesRef.resourceId}.${kubernetesRef.fieldPath}`;

  if (context.generateHasChecks) {
    return `has(${resourcePath}) && ${resourcePath}`;
  }

  if (context.useKroConditionals) {
    return `${resourcePath}?`;
  }

  return resourcePath;
}

/**
 * Delegate to canonical implementation in type-guards.ts
 */
export function extractKubernetesRefsFromExpression(value: unknown): KubernetesRef<unknown>[] {
  return extractResourceReferences(value);
}
