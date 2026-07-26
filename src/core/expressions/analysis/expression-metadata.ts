import type { CelExpression, KubernetesRef } from '../../types/common.js';

export interface CelExpressionSourceLocation {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface CelExpressionAnalysisMetadata {
  readonly references: readonly KubernetesRef<unknown>[];
  readonly sourceLocation?: CelExpressionSourceLocation;
}

const analysisByExpression = new WeakMap<object, CelExpressionAnalysisMetadata>();

/** Attach analyzer-owned reference and source data without changing serialized CEL objects. */
export function setCelExpressionAnalysis(
  expression: CelExpression,
  metadata: CelExpressionAnalysisMetadata
): void {
  analysisByExpression.set(expression, metadata);
}

/** Read analyzer-owned metadata while the authoring expression remains in memory. */
export function getCelExpressionAnalysis(
  expression: object
): CelExpressionAnalysisMetadata | undefined {
  return analysisByExpression.get(expression);
}
