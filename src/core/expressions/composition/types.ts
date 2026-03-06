/**
 * Shared Types for Composition Integration
 *
 * Pure type definitions shared across the composition integration modules.
 */

import type { KubernetesRef } from '../../types/common.js';
import type { KroCompatibleType, MagicAssignableShape } from '../../types/serialization.js';

/**
 * Analysis result for imperative composition functions
 */
export interface CompositionAnalysisResult<TStatus extends KroCompatibleType> {
  /** The analyzed status shape with conversion metadata */
  statusShape: MagicAssignableShape<TStatus>;
  /** KubernetesRef objects found in the composition */
  kubernetesRefs: KubernetesRef<unknown>[];
  /** Resources referenced by the composition */
  referencedResources: string[];
  /** Whether the composition requires CEL conversion */
  requiresCelConversion: boolean;
  /** Conversion metadata for debugging */
  conversionMetadata: {
    expressionsAnalyzed: number;
    kubernetesRefsDetected: number;
    celExpressionsGenerated: number;
  };
}

/**
 * Composition pattern types
 */
export type CompositionPattern = 'imperative' | 'declarative';

/**
 * Pattern-specific analysis configuration
 */
export interface PatternAnalysisConfig {
  pattern: CompositionPattern;
  allowSideEffects: boolean;
  trackResourceCreation: boolean;
  validateScope: boolean;
  convertTocel: boolean;
}
