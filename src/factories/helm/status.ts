import { Cel } from '../../core/references/cel.js';
import type { RefOrValue } from '../../core/types.js';

export type HelmReleasePhase = 'Ready' | 'Installing' | 'Failed';

export interface HelmReleaseConditionSummary {
  ready: boolean;
  failed: boolean;
  phase: HelmReleasePhase;
}

function joinConditionChecks(
  conditions: readonly RefOrValue<unknown>[],
  status: 'True' | 'False',
  operator: ' && ' | ' || '
) {
  const parts: RefOrValue<unknown>[] = [];
  conditions.forEach((condition, index) => {
    if (index > 0) parts.push(operator);
    parts.push(condition, `.exists(c, c.type == "Ready" && c.status == "${status}")`);
  });
  return Cel.expr<boolean>(...parts);
}

/**
 * Derive a consistent status summary from one or more Flux HelmRelease
 * condition lists. Every release must be Ready for the aggregate to be Ready;
 * one explicitly false Ready condition makes the aggregate Failed.
 */
export function helmReleaseConditionSummary(
  ...conditions: readonly [RefOrValue<unknown>, ...RefOrValue<unknown>[]]
): HelmReleaseConditionSummary {
  const ready = joinConditionChecks(conditions, 'True', ' && ');
  const failed = joinConditionChecks(conditions, 'False', ' || ');
  const phase = Cel.expr<HelmReleasePhase>(
    failed,
    ' ? "Failed" : (',
    ready,
    ' ? "Ready" : "Installing")'
  );

  return { ready, failed, phase };
}
