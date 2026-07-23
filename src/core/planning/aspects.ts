import { resolveFactoryTargetId } from '../aspects/targets.js';
import type { AnyAspectDefinition, AspectTarget } from '../aspects/types.js';

import { canonicalDigest } from './canonical.js';
import type { AspectManifestEntry, PlanDiagnostic, PlanValue } from './types.js';
import { lowerPlanValue } from './values.js';

export interface AspectManifestResult {
  readonly manifest: readonly AspectManifestEntry[];
  readonly digest: string;
  readonly diagnostics: readonly PlanDiagnostic[];
  readonly stable: boolean;
}

function targetDescriptor(target: AspectTarget): string | undefined {
  if (typeof target === 'function') return resolveFactoryTargetId(target);
  if (target && typeof target === 'object' && target.kind === 'target-group') return target.id;
  return undefined;
}

function aspectConfiguration(
  definition: AnyAspectDefinition,
  order: number,
  diagnostics: PlanDiagnostic[]
): { readonly id: string; readonly configuration: PlanValue; readonly stable: boolean } {
  const rawTargets = Array.isArray(definition.target) ? definition.target : [definition.target];
  const targets: string[] = [];
  let stable = true;
  rawTargets.forEach((target, targetIndex) => {
    const descriptor = targetDescriptor(target as AspectTarget);
    if (descriptor === undefined) {
      stable = false;
      diagnostics.push({
        code: 'PLAN_ASPECT_IDENTITY_UNSTABLE',
        severity: 'error',
        message: `Aspect ${order} target ${targetIndex} has no stable TypeKro target identity.`,
        path: `$.aspects[${order}].target[${targetIndex}]`,
      });
      targets.push(`unresolved-${targetIndex}`);
    } else {
      targets.push(descriptor);
    }
  });

  const rawConfiguration = {
    targets,
    surface: definition.surface,
    cardinality: definition.cardinality,
    ...(definition.selector !== undefined ? { selector: definition.selector } : {}),
  };
  const lowered = lowerPlanValue(rawConfiguration, { strict: false });
  diagnostics.push(
    ...lowered.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: `$.aspects[${order}]${diagnostic.path?.slice(1) ?? ''}`,
    }))
  );
  if (lowered.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) stable = false;
  const surfaceKind =
    definition.surface &&
    typeof definition.surface === 'object' &&
    typeof Reflect.get(definition.surface, 'kind') === 'string'
      ? String(Reflect.get(definition.surface, 'kind'))
      : 'unknown';
  return {
    id: `typekro.aspect/${targets.join('+')}/${surfaceKind}`,
    configuration: lowered.value,
    stable,
  };
}

/** Build the ordered, canonical aspect manifest used by planning and digests. */
export function createAspectManifest(
  aspects: readonly AnyAspectDefinition[] = []
): AspectManifestResult {
  const diagnostics: PlanDiagnostic[] = [];
  let stable = true;
  const manifest = aspects.map((definition, order) => {
    const descriptor = aspectConfiguration(definition, order, diagnostics);
    if (!descriptor.stable) stable = false;
    return {
      id: descriptor.id,
      revision: '1',
      configuration: descriptor.configuration,
      order,
    };
  });
  return {
    manifest,
    digest: canonicalDigest(manifest),
    diagnostics,
    stable,
  };
}
