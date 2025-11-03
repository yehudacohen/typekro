import type { APISixBootstrapConfig, APISixHelmValues } from '../types.js';

/**
 * Maps APISixBootstrapConfig to APISix Helm values
 * 
 * This function transforms the TypeKro configuration interface into the format
 * expected by the official APISix Helm chart.
 * 
 * @param config - The APISix bootstrap configuration
 * @returns Helm values object for the APISix chart
 */
export function mapAPISixConfigToHelmValues(config: APISixBootstrapConfig): APISixHelmValues {
  const helmValues: Partial<APISixHelmValues> = {
    // Installation configuration
    ...(config.installCRDs !== undefined && { installCRDs: config.installCRDs }),
    
    // Global configuration
    ...(config.global && { global: config.global }),
    
    // Replica configuration
    ...(config.replicaCount !== undefined && { replicaCount: config.replicaCount }),
    
    // Gateway configuration
    ...(config.gateway && { gateway: config.gateway }),
    
    // Ingress Controller configuration
    ...(config.ingressController && { 
      ingressController: {
        // Only include fields that APISix Helm chart supports
        ...(config.ingressController.enabled !== undefined && { enabled: config.ingressController.enabled }),
        ...(config.ingressController.image && { image: config.ingressController.image }),
        ...(config.ingressController.resources && { resources: config.ingressController.resources }),
        ...(config.ingressController.nodeSelector && { nodeSelector: config.ingressController.nodeSelector }),
        ...(config.ingressController.tolerations && { tolerations: config.ingressController.tolerations }),
        ...(config.ingressController.affinity && { affinity: config.ingressController.affinity }),
        ...(config.ingressController.securityContext && { securityContext: config.ingressController.securityContext }),
        ...(config.ingressController.containerSecurityContext && { containerSecurityContext: config.ingressController.containerSecurityContext }),
        ...(config.ingressController.extraArgs && { extraArgs: config.ingressController.extraArgs }),
        ...(config.ingressController.env && { env: config.ingressController.env }),
        ...(config.ingressController.config && { config: config.ingressController.config }),
      }
    }),
    
    // APISix configuration
    ...(config.apisix && { apisix: config.apisix }),
    
    // Dashboard configuration
    ...(config.dashboard && { dashboard: config.dashboard }),
    
    // etcd configuration
    ...(config.etcd && { etcd: config.etcd }),
    
    // Service Account configuration
    ...(config.serviceAccount && { serviceAccount: config.serviceAccount }),
    
    // RBAC configuration
    ...(config.rbac && { rbac: config.rbac }),
    
    // Custom values override
    ...(config.customValues || {}),
  };

  // Remove undefined values to keep the Helm values clean
  return removeUndefinedValues(helmValues) as APISixHelmValues;
}

/**
 * Validates APISix Helm values for common configuration issues
 * 
 * @param values - The Helm values to validate
 * @returns Array of validation warnings/errors
 */
export function validateAPISixHelmValues(values: APISixHelmValues): string[] {
  const warnings: string[] = [];

  // Check ingress controller configuration
  if (values.ingressController?.enabled === false) {
    warnings.push('Ingress controller is disabled. This will prevent ingress resources from being processed.');
  }

  // Check gateway configuration
  if (!values.gateway?.http?.enabled && !values.gateway?.https?.enabled) {
    warnings.push('Both HTTP and HTTPS are disabled on the gateway. Consider enabling at least one.');
  }

  // Check etcd configuration
  if (values.etcd?.enabled === false) {
    warnings.push('etcd is disabled. Ensure you have an external etcd cluster configured.');
  }

  // Check resource requirements
  if (!values.apisix?.resources?.requests) {
    warnings.push('No resource requests specified for APISix. Consider setting CPU and memory requests for better scheduling.');
  }

  // Check ingress class configuration
  if (values.ingressController?.enabled && !values.ingressController?.config?.kubernetes?.ingressClass) {
    warnings.push('No ingress class specified. Consider setting ingressClass for proper ingress handling.');
  }

  return warnings;
}

/**
 * Recursively removes undefined values from an object
 * 
 * @param obj - The object to clean
 * @returns The object with undefined values removed
 */
function removeUndefinedValues(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(removeUndefinedValues).filter(item => item !== undefined);
  }

  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = removeUndefinedValues(value);
      if (cleanedValue !== undefined) {
        cleaned[key] = cleanedValue;
      }
    }
    return cleaned;
  }

  return obj;
}