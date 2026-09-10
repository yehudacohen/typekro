/**
 * KRO-facing core primitives shared by factories, compositions and tests.
 */

export {
  DISABLE_LABEL_GUARD_ENV,
  discoverLabelPropagationGuardSupport,
  LABEL_GUARD_ALTERNATIVES,
  LABEL_GUARD_API_VERSION_ENV,
  LABEL_GUARD_CAPABILITY,
  LABEL_GUARD_UNRESOLVED_REASON,
  type LabelPropagationGuardCapability,
  type LabelPropagationGuardStatus,
  probeLabelPropagationGuardSupport,
  resetLabelGuardCapabilityCache,
  resetLabelPropagationGuardCapabilityCache,
  resolveLabelPropagationGuardCapability,
  setLabelPropagationGuardCapability,
} from './label-guard-capability.js';
export { isKroOwnershipLabel, KRO_OWNERSHIP_LABELS, type KroOwnershipLabel } from './labels.js';
