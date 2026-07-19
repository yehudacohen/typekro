import type { HarborRegistryConfig, OciRegistryConfig } from './types.js';

/**
 * Configure Harbor as an OCI transport. Harbor API lifecycle (projects and robot accounts) remains
 * in the Harbor integration rather than leaking into this generic registry boundary.
 */
export function harbor(config: HarborRegistryConfig): OciRegistryConfig {
  const { project, ...registry } = config;
  return { type: 'oci', ...registry, repositoryPrefix: project };
}
