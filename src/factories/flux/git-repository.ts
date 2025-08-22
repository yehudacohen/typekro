import type { Enhanced } from '../../core/types/index.js';
import { createResource } from '../shared.js';

export interface GitRepositorySpec {
  url: string;
  ref?: {
    branch?: string;
    tag?: string;
    commit?: string;
  };
  interval: string;
  secretRef?: {
    name: string;
  };
}

export interface GitRepositoryStatus {
  observedGeneration?: number;
  conditions?: Array<{
    type: string;
    status: 'True' | 'False' | 'Unknown';
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
  }>;
  artifact?: {
    path: string;
    url: string;
    revision: string;
    checksum: string;
    lastUpdateTime: string;
  };
}

export interface GitRepositoryConfig {
  name: string;
  namespace?: string;
  url: string;
  ref?: {
    branch?: string;
    tag?: string;
    commit?: string;
  };
  interval: string;
  secretRef?: {
    name: string;
  };
  id?: string;
}

/**
 * Create a GitRepository resource for Flux CD
 *
 * @param config - Configuration for the GitRepository
 *
 * @example
 * ```typescript
 * gitRepository({
 *   name: 'webapp-source',
 *   url: 'https://github.com/example/webapp-manifests',
 *   ref: { branch: 'main' },
 *   interval: '5m'
 * })
 * ```
 */
export function gitRepository(
  config: GitRepositoryConfig
): Enhanced<GitRepositorySpec, GitRepositoryStatus> {
  return createResource({
    ...(config.id && { id: config.id }),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'GitRepository',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: {
      url: config.url,
      ref: config.ref,
      interval: config.interval,
      secretRef: config.secretRef,
    },
  });
}
