/**
 * Kubernetes Admission Resource Factories
 *
 * This module provides factory functions for Kubernetes admission control resources
 * including MutatingWebhookConfigurations and ValidatingWebhookConfigurations.
 */

export {
  DEFAULT_KRO_SERVICE_ACCOUNT,
  LABEL_PROPAGATION_GUARD_JSON_PATCH_EXPRESSION,
  LABEL_PROPAGATION_GUARD_NAME,
  LABEL_PROPAGATION_GUARD_RESOURCE_RULES,
  type LabelPropagationGuard,
  labelPropagationGuard,
  type LabelPropagationGuardOptions,
  labelPropagationGuardPolicySpec,
  serviceAccountUsername,
} from './label-propagation-guard.js';
export {
  MUTATING_ADMISSION_POLICY_API_VERSIONS,
  type MutatingAdmissionPolicyApiVersion,
  type MutatingAdmissionPolicyBindingConfig,
  MutatingAdmissionPolicyBindingConfigSchema,
  mutatingAdmissionPolicyBinding,
  type MutatingAdmissionPolicyBindingSpec,
  MutatingAdmissionPolicyBindingSpecSchema,
  type MutatingAdmissionPolicyBindingStatus,
  type MutatingAdmissionPolicyConfig,
  MutatingAdmissionPolicyConfigSchema,
  mutatingAdmissionPolicy,
  type MutatingAdmissionPolicySpec,
  MutatingAdmissionPolicySpecSchema,
  type MutatingAdmissionPolicyStatus,
} from './mutating-admission-policy.js';
export { mutatingWebhookConfiguration } from './mutating-webhook-configuration.js';
export { validatingWebhookConfiguration } from './validating-webhook-configuration.js';
