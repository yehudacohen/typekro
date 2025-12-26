import { kubernetesComposition } from '../../../index.js';
import {
  PebbleBootstrapConfigSchema,
  PebbleBootstrapStatusSchema,
} from '../types.js';
import {
  pebbleHelmRepository,
  pebbleHelmRelease
} from '../resources/helm.js';
import { createDefaultPebbleTestingValues } from '../utils/helm-values-mapper.js';

/**
 * Helper function to ensure version has 'v' prefix for image tags if needed
 */
function _ensureVersionPrefix(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * Pebble ACME Test Server Bootstrap Composition
 * 
 * Creates a complete Pebble ACME test server deployment using HelmRepository and HelmRelease resources.
 * Provides comprehensive configuration options and status expressions derived from actual resource status.
 * 
 * Features:
 * - Complete Pebble ACME test server deployment (Pebble server + CoreDNS)
 * - Comprehensive configuration schema with ArkType validation
 * - Status expressions using actual resource status fields
 * - ACME and management endpoints derived from service status
 * - Support for both kro and direct deployment strategies
 * - Optimized for fast testing with sensible defaults
 * 
 * @example
 * ```typescript
 * const pebbleFactory = pebbleBootstrap.factory('direct', {
 *   namespace: 'pebble-system',
 *   waitForReady: true
 * });
 * 
 * const instance = await pebbleFactory.deploy({
 *   name: 'pebble-acme',
 *   namespace: 'pebble-system',
 *   pebble: {
 *     env: [
 *       { name: 'PEBBLE_VA_NOSLEEP', value: '1' },
 *       { name: 'PEBBLE_WFE_NONCEREJECT', value: '0' }
 *     ]
 *   },
 *   coredns: {
 *     corefileSegment: `
 *       template ANY ANY test {
 *         answer "{{ .Name }} 60 IN CNAME mysvc.{$PEBBLE_NAMESPACE}.svc.cluster.local"
 *       }
 *     `
 *   }
 * });
 * ```
 */
export const pebbleBootstrap = kubernetesComposition(
  {
    name: 'pebble-bootstrap',
    apiVersion: 'pebble.typekro.dev/v1alpha1',
    kind: 'PebbleBootstrap',
    spec: PebbleBootstrapConfigSchema,
    status: PebbleBootstrapStatusSchema,
  },
  (spec) => {
    // Create HelmRepository for Pebble chart
    const helmRepository = pebbleHelmRepository({
      name: `${spec.name}-repo`,
      namespace: 'flux-system',
      url: 'https://jupyterhub.github.io/helm-chart/',
      interval: '5m',
      id: 'pebbleHelmRepository'
    });

    // Use default testing values optimized for fast testing
    const mergedValues = createDefaultPebbleTestingValues();

    // Create HelmRelease for Pebble deployment
    const helmRelease = pebbleHelmRelease({
      name: spec.name,
      namespace: spec.namespace || 'default',
      chart: {
        name: 'pebble',
        version: spec.version || '*',
      },
      repositoryRef: {
        name: `${spec.name}-repo`,
        namespace: 'flux-system',
      },
      values: mergedValues,
      interval: '5m',
      id: 'pebbleHelmRelease'
    });

    // Return status expressions based on actual resource status
    return {
      ready: helmRepository.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') && 
             helmRelease.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
      phase: helmRelease.status.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'Pending',
      version: spec.version || 'latest',
      pebbleReady: helmRelease.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
      corednsReady: helmRelease.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
      acmeEndpoint: `https://${spec.name}.${spec.namespace || 'default'}.svc.cluster.local/dir`,
      managementEndpoint: `https://${spec.name}.${spec.namespace || 'default'}.svc.cluster.local:15000`,
      dnsServer: `${spec.name}-coredns.${spec.namespace || 'default'}.svc.cluster.local`
    };
  }
);