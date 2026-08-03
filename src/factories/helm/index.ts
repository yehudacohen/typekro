/**
 * Helm factory functions
 *
 * Uses explicit exports to control public API surface.
 * The deprecated `simpleHelmChart` is intentionally re-exported
 * for backward compatibility — prefer `simple.HelmChart()` instead.
 */

export type { HelmReleaseConfig } from './helm-release.js';
// helm-release.ts
export { helmRelease, simpleHelmChart } from './helm-release.js';
export type {
  HelmRepositoryConfig,
  HelmRepositorySpec,
  HelmRepositoryStatus,
} from './helm-repository.js';
// helm-repository.ts
export { createHelmRepositoryReadinessEvaluator, helmRepository } from './helm-repository.js';

// readiness-evaluators.ts
export {
  createComprehensiveHelmReadinessEvaluator,
  createHelmRevisionReadinessEvaluator,
  createHelmTestReadinessEvaluator,
  createHelmTimeoutReadinessEvaluator,
  createLabeledHelmReleaseEvaluator,
  helmReleaseReadinessEvaluator,
} from './readiness-evaluators.js';

// status.ts
export type { HelmReleaseConditionSummary, HelmReleasePhase } from './status.js';
export { helmReleaseConditionSummary } from './status.js';

// types.ts
export type {
  HelmReleasePostRenderer,
  HelmReleasePostRendererImage,
  HelmReleasePostRendererPatch,
  HelmReleasePostRendererPatchTarget,
  HelmReleaseSpec,
  HelmReleaseStatus,
  HelmReleaseValuesFromSource,
} from './types.js';
