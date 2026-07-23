import type { DeploymentResourceGraph } from '../types/deployment.js';
import type { KroCompatibleType } from '../types/schema.js';

import type {
  CapturedCompositionIR,
  CompositionInspection,
  DesiredStatePlan,
  PlanDiagnostic,
  PlanOptions,
  RepresentationRequirement,
} from './types.js';

/** Internal executable portion kept out of the serializable captured IR. */
export interface CapturedCompositionRuntime<TSpec extends KroCompatibleType> {
  readonly ir: CapturedCompositionIR;
  readonly diagnosticSource: string;
  readonly validate: (spec: TSpec) => void;
  readonly materialize: (spec: TSpec, options: PlanOptions) => DeploymentResourceGraph;
  readonly representationRequirements: () => {
    readonly requirements: readonly RepresentationRequirement[];
    readonly diagnostics: readonly PlanDiagnostic[];
  };
  readonly inspect: () => CompositionInspection;
  readonly plan: (spec: TSpec, options?: PlanOptions) => DesiredStatePlan;
  /** Build the shared symbolic template plan used by KRO RGD compilation. */
  readonly planTemplate: (options?: PlanOptions) => DesiredStatePlan;
  /** Lower a caller-supplied symbolic instance spec without treating proxies as concrete input. */
  readonly planSymbolic: (spec: TSpec, options?: PlanOptions) => DesiredStatePlan;
  /** Build a plan from an already materialized graph without replaying author code. */
  readonly planMaterialized: (
    spec: TSpec,
    graph: DeploymentResourceGraph,
    options?: PlanOptions
  ) => DesiredStatePlan;
}

const captures = new WeakMap<WeakKey, CapturedCompositionRuntime<KroCompatibleType>>();

/** Associate a graph or callable composition with its internal semantic capture. */
export function setCompositionCapture<TSpec extends KroCompatibleType>(
  target: WeakKey,
  capture: CapturedCompositionRuntime<TSpec>
): void {
  captures.set(target, capture as CapturedCompositionRuntime<KroCompatibleType>);
}

/** Copy capture identity when a graph is wrapped in a callable/proxy facade. */
export function copyCompositionCapture(source: WeakKey, target: WeakKey): boolean {
  const capture = captures.get(source);
  if (!capture) return false;
  captures.set(target, capture);
  return true;
}

/** Read internal capture data without exposing executable functions in public DTOs. */
export function getCompositionCapture(
  target: WeakKey
): CapturedCompositionRuntime<KroCompatibleType> | undefined {
  return captures.get(target);
}
