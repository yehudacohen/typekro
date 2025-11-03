import type { CertManagerBootstrapConfig, CertManagerHelmValues } from '../types.js';

/**
 * Maps CertManagerBootstrapConfig to cert-manager Helm values
 * 
 * This function transforms the TypeKro configuration interface into the format
 * expected by the official cert-manager Helm chart.
 * 
 * @param config - The cert-manager bootstrap configuration
 * @returns Helm values object for the cert-manager chart
 */
export function mapCertManagerConfigToHelmValues(config: CertManagerBootstrapConfig): CertManagerHelmValues {
  const helmValues: Partial<CertManagerHelmValues> = {
    // Installation configuration
    ...(config.installCRDs !== undefined && { installCRDs: config.installCRDs }),
    
    // Global configuration
    ...(config.global && { global: config.global }),
    
    // Replica configuration
    ...(config.replicaCount !== undefined && { replicaCount: config.replicaCount }),
    
    // Deployment strategy
    ...(config.strategy && { strategy: config.strategy }),
    
    // Controller configuration
    ...(config.controller && { 
      controller: {
        // Only include fields that cert-manager Helm chart supports
        ...(config.controller.image && { image: config.controller.image }),
        ...(config.controller.resources && { resources: config.controller.resources }),
        ...(config.controller.nodeSelector && { nodeSelector: config.controller.nodeSelector }),
        ...(config.controller.tolerations && { tolerations: config.controller.tolerations }),
        ...(config.controller.affinity && { affinity: config.controller.affinity }),
        ...(config.controller.securityContext && { securityContext: config.controller.securityContext }),
        ...(config.controller.containerSecurityContext && { containerSecurityContext: config.controller.containerSecurityContext }),
        ...(config.controller.volumes && { volumes: config.controller.volumes }),
        ...(config.controller.volumeMounts && { volumeMounts: config.controller.volumeMounts }),
        ...(config.controller.extraArgs && { extraArgs: config.controller.extraArgs }),
        ...(config.controller.env && { env: config.controller.env }),
        ...(config.controller.serviceAccount && { serviceAccount: config.controller.serviceAccount }),
      }
    }),
    
    // Webhook configuration
    ...(config.webhook && { webhook: config.webhook }),
    
    // CA Injector configuration
    ...(config.cainjector && { cainjector: config.cainjector }),
    
    // ACME solver configuration
    ...(config.acmesolver && { acmesolver: config.acmesolver }),
    
    // Startup API check configuration
    ...(config.startupapicheck && { startupapicheck: config.startupapicheck }),
    
    // Monitoring configuration
    ...(config.prometheus && { prometheus: config.prometheus }),
    
    // Custom values override
    ...(config.customValues || {}),
  };

  // Remove undefined values to keep the Helm values clean
  return removeUndefinedValues(helmValues) as CertManagerHelmValues;
}

/**
 * Validates cert-manager Helm values for common configuration issues
 * 
 * @param values - The Helm values to validate
 * @returns Array of validation warnings/errors
 */
export function validateCertManagerHelmValues(values: CertManagerHelmValues): string[] {
  const warnings: string[] = [];

  // Check CRD installation
  if (values.installCRDs === false) {
    warnings.push('installCRDs is set to false. Ensure CRDs are installed separately before deploying cert-manager.');
  }

  // Check webhook configuration
  if (values.webhook?.enabled === false) {
    warnings.push('Webhook is disabled. This may cause issues with certificate validation and mutation.');
  }

  // Check CA injector configuration
  if (values.cainjector?.enabled === false) {
    warnings.push('CA injector is disabled. This may cause issues with CA bundle injection.');
  }

  // Check resource requirements
  if (!values.resources?.requests) {
    warnings.push('No resource requests specified. Consider setting CPU and memory requests for better scheduling.');
  }

  // Check replica count for webhook
  if (values.webhook?.enabled !== false && values.webhook?.replicaCount === 1) {
    warnings.push('Webhook is running with only 1 replica. Consider increasing for high availability.');
  }

  // Check monitoring configuration
  if (values.prometheus?.enabled && !values.prometheus?.servicemonitor?.enabled) {
    warnings.push('Prometheus is enabled but ServiceMonitor is disabled. Metrics may not be scraped.');
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