/**
 * KRO-facing core primitives shared by factories, compositions and tests.
 */

export {
  discoverLabelPropagationGuardSupport,
  DISABLE_LABEL_GUARD_ENV,
  LABEL_GUARD_ALTERNATIVES,
  LABEL_GUARD_API_VERSION_ENV,
  type LabelPropagationGuardCapability,
  type LabelPropagationGuardStatus,
  probeLabelPropagationGuardSupport,
  resetLabelPropagationGuardCapabilityCache,
  resolveLabelPropagationGuardCapability,
  setLabelPropagationGuardCapability,
} from './label-guard-capability.js';
export { isKroOwnershipLabel, KRO_OWNERSHIP_LABELS, type KroOwnershipLabel } from './labels.js';
