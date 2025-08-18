import { createResource } from '../../shared.js';
import type { Enhanced } from '../../../core/types/index.js';
import type { KustomizationSpec, KustomizationStatus } from '../../../core/types/yaml.js';
import { kustomizationReadinessEvaluator } from './readiness-evaluators.js';

export interface KustomizationConfig {
  name: string;
  namespace?: string;
  interval?: string;
  source: {
    kind: 'GitRepository' | 'Bucket' | 'OCIRepository';
    name: string;
    namespace?: string;
  };
  path?: string; // Path within the source repository
  patches?: Array<{
    target?: {
      group?: string;
      version?: string;
      kind?: string;
      name?: string;
      namespace?: string;
      labelSelector?: string;
      annotationSelector?: string;
    };
    patch: string | Record<string, any>;
    options?: {
      allowNameChange?: boolean;
      allowKindChange?: boolean;
    };
  }>;
  images?: Array<{
    name: string;
    newName?: string;
    newTag?: string;
    digest?: string;
  }>;
  replicas?: Array<{
    name: string;
    count: number;
  }>;
  patchesStrategicMerge?: string[];
  patchesJson6902?: Array<{
    target: {
      group?: string;
      version?: string;
      kind: string;
      name: string;
      namespace?: string;
    };
    path: string;
  }>;
  id?: string;
}

/**
 * Deploy Kubernetes manifests using Flux CD's Kustomization
 * 
 * Creates a Kustomization resource that integrates with TypeKro's magic proxy system,
 * allowing schema references and CEL expressions in patches and configurations.
 * 
 * @param config - Configuration for the Kustomization
 * 
 * @example
 * Basic Kustomization:
 * ```typescript
 * kustomization({
 *   name: 'webapp-config',
 *   source: {
 *     kind: 'GitRepository',
 *     name: 'webapp-repo'
 *   },
 *   path: './overlays/production'
 * })
 * ```
 * 
 * @example
 * With TypeKro schema references in patches:
 * ```typescript
 * kustomization({
 *   name: 'webapp-config',
 *   namespace: 'production',
 *   source: {
 *     kind: 'GitRepository',
 *     name: 'webapp-repo'
 *   },
 *   path: './base',
 *   patches: [{
 *     target: {
 *       kind: 'Deployment',
 *       name: 'webapp'
 *     },
 *     patch: {
 *       spec: {
 *         replicas: schema.spec.replicas, // TypeKro reference
 *         template: {
 *           spec: {
 *             containers: [{
 *               name: 'webapp',
 *               image: schema.spec.image,
 *               env: [{
 *                 name: 'DATABASE_URL',
 *                 value: database.status.connectionString // Cross-resource reference
 *               }]
 *             }]
 *           }
 *         }
 *       }
 *     }
 *   }],
 *   images: [{
 *     name: 'webapp',
 *     newTag: schema.spec.version
 *   }]
 * })
 * ```
 * 
 * @example
 * With strategic merge patches:
 * ```typescript
 * kustomization({
 *   name: 'webapp-patches',
 *   source: {
 *     kind: 'GitRepository',
 *     name: 'webapp-repo'
 *   },
 *   path: './base',
 *   patchesStrategicMerge: [
 *     'deployment-patch.yaml',
 *     'service-patch.yaml'
 *   ]
 * })
 * ```
 */
export function kustomization(config: KustomizationConfig) {
  const resource = createResource({
    ...(config.id && { id: config.id }),
    apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
    kind: 'Kustomization',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: {
      interval: config.interval || '5m',
      sourceRef: config.source,
      path: config.path || './',
      patches: config.patches,
      images: config.images,
      replicas: config.replicas,
      patchesStrategicMerge: config.patchesStrategicMerge,
      patchesJson6902: config.patchesJson6902,
      prune: true,
      wait: true,
      timeout: '10m',
    },
  });

  // Add custom readiness evaluator
  return resource.withReadinessEvaluator(kustomizationReadinessEvaluator);
}