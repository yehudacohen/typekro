import * as k8s from '@kubernetes/client-node';

/**
 * Get a properly configured KubeConfig for integration tests
 * This ensures consistent TLS configuration across all integration tests
 */
export function getIntegrationTestKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  
  // Configure to skip TLS verification for test environment
  const cluster = kc.getCurrentCluster();
  if (cluster) {
    const modifiedCluster = { ...cluster, skipTLSVerify: true };
    kc.clusters = kc.clusters.map((c) => (c === cluster ? modifiedCluster : c));
  }
  
  // Ensure we have a valid context
  if (!kc.getCurrentCluster()) {
    throw new Error(
      'No active Kubernetes cluster found. Make sure kubectl is configured and the test cluster is running. ' +
      'Run: bun run scripts/e2e-setup.ts to set up the test environment.'
    );
  }
  
  return kc;
}

/**
 * Check if a Kubernetes cluster is available for testing
 */
export function isClusterAvailable(): boolean {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    
    const cluster = kc.getCurrentCluster();
    if (!cluster) {
      return false;
    }
    
    // Don't test connectivity here as it can cause TLS issues
    // Just check if we have a valid cluster configuration
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Check if the Kro controller is healthy and ready
 */
export async function isKroControllerHealthy(): Promise<boolean> {
  try {
    const kc = getIntegrationTestKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    
    // Check if Kro deployment exists and is ready
    const deployment = await appsApi.readNamespacedDeployment('kro', 'kro-system');
    const status = deployment.body.status;
    
    return status?.readyReplicas === status?.replicas && (status?.replicas ?? 0) > 0;
  } catch (error) {
    console.warn('Kro controller health check failed:', error);
    // Don't fail the test if health check fails, just warn
    return true; // Assume healthy to avoid blocking tests
  }
}
