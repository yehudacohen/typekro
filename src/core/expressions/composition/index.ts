/**
 * Composition Integration for JavaScript to CEL Expression Conversion
 *
 * Re-exports from the decomposed composition integration modules:
 * - types.ts: Pure type definitions (CompositionAnalysisResult, CompositionPattern, etc.)
 * - scope-manager.ts: MagicProxyScopeManager and NestedCompositionScope
 * - context-tracker.ts: CompositionContextTracker
 * - expression-analyzer.ts: CompositionExpressionAnalyzer
 * - integration-hooks.ts: CompositionIntegrationHooks and compositionUsesKubernetesRefs
 */

// Context Tracking
export { CompositionContextTracker } from './context-tracker.js';
// Expression Analysis
export { CompositionExpressionAnalyzer } from './expression-analyzer.js';
// Integration Hooks
export { CompositionIntegrationHooks, compositionUsesKubernetesRefs } from './integration-hooks.js';
// Scope Management
export type { NestedCompositionScope } from './scope-manager.js';
export { MagicProxyScopeManager } from './scope-manager.js';
// Types
export type {
  CompositionAnalysisResult,
  CompositionPattern,
  PatternAnalysisConfig,
} from './types.js';
