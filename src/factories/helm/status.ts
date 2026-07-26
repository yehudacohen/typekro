import { TypeKroError } from '../../core/errors.js';
import { hasResourceMetadata } from '../../core/metadata/index.js';
import { Cel } from '../../core/references/cel.js';
import type { Enhanced, RefOrValue } from '../../core/types.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from './types.js';

export type HelmReleasePhase = 'Ready' | 'Installing' | 'Failed';

export interface HelmReleaseConditionSummary {
  ready: boolean;
  failed: boolean;
  phase: HelmReleasePhase;
}

type HelmReleaseResource = Enhanced<HelmReleaseSpec, HelmReleaseStatus>;

function assertHelmReleaseResource(
  release: HelmReleaseResource,
  index: number
): asserts release is HelmReleaseResource {
  if (
    release === null ||
    typeof release !== 'object' ||
    release.kind !== 'HelmRelease' ||
    !release.apiVersion?.startsWith('helm.toolkit.fluxcd.io/') ||
    !hasResourceMetadata(release)
  ) {
    throw new TypeKroError(
      `helmReleaseConditionSummary argument ${index + 1} must be a HelmRelease resource created by TypeKro.`,
      'HELM_STATUS_INVALID_INPUT',
      { argumentIndex: index }
    );
  }
}

function releaseConditionCheck(
  release: HelmReleaseResource,
  status: 'True' | 'False'
): RefOrValue<boolean> {
  return Cel.expr<boolean>(
    'has(',
    release.status.observedGeneration,
    ') && ',
    release.status.observedGeneration,
    ' >= ',
    release.metadata.generation,
    ' && has(',
    release.status.conditions,
    ') && ',
    release.status.conditions,
    `.exists(c, c.type == "Ready" && c.status == "${status}" && (has(c.observedGeneration) ? c.observedGeneration >= `,
    release.metadata.generation,
    ' : true))'
  );
}

function joinConditionChecks(
  releases: readonly HelmReleaseResource[],
  status: 'True' | 'False',
  operator: ' && ' | ' || '
) {
  const parts: RefOrValue<unknown>[] = [];
  releases.forEach((release, index) => {
    if (index > 0) parts.push(operator);
    parts.push(releaseConditionCheck(release, status));
  });
  return Cel.expr<boolean>(...parts);
}

/**
 * Derive a consistent status summary from one or more Flux HelmRelease
 * resources. Every release must be Ready for the aggregate to be Ready;
 * one explicitly false Ready condition from the current generation makes the
 * aggregate Failed. Stale conditions from a previous generation are ignored.
 */
export function helmReleaseConditionSummary(
  ...releases: readonly [HelmReleaseResource, ...HelmReleaseResource[]]
): HelmReleaseConditionSummary {
  releases.forEach(assertHelmReleaseResource);
  const ready = joinConditionChecks(releases, 'True', ' && ');
  const failed = joinConditionChecks(releases, 'False', ' || ');
  const phase = Cel.expr<HelmReleasePhase>(
    failed,
    ' ? "Failed" : (',
    ready,
    ' ? "Ready" : "Installing")'
  );

  return { ready, failed, phase };
}
