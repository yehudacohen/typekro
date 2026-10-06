export { mapVpaConfigToHelmValues } from './helm-values-mapper.js';
export {
  findVpaAutoscalerConflicts,
  type VpaValidationIssue,
  validateVerticalPodAutoscalerSpec,
  validateVpaBootstrapConfig,
} from './validation.js';
