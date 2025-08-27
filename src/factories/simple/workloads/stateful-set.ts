/**
 * Simple StatefulSet Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes StatefulSet resources with sensible defaults.
 */

import type { V1EnvVar } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types.js';
import type { V1StatefulSetSpec, V1StatefulSetStatus } from '../../kubernetes/types.js';
import { statefulSet } from '../../kubernetes/workloads/stateful-set.js';
import type { StatefulSetConfig } from '../types.js';

/**
 * Creates a simple StatefulSet with sensible defaults
 *
 * @param config - Configuration for the stateful set
 * @returns Enhanced StatefulSet resource
 */
export function StatefulSet(
  config: StatefulSetConfig
): Enhanced<V1StatefulSetSpec, V1StatefulSetStatus> {
  const env: V1EnvVar[] = config.env
    ? Object.entries(config.env).map(([name, value]) => ({ name, value }))
    : [];

  return statefulSet({
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
      serviceName: config.serviceName,
      replicas: config.replicas || 1,
      selector: { matchLabels: { app: config.name } },
      template: {
        metadata: { labels: { app: config.name } },
        spec: {
          containers: [
            {
              name: config.name,
              image: config.image,
              ...(env.length > 0 && { env }),
              ...(config.ports && { ports: config.ports }),
            },
          ],
        },
      },
      ...(config.volumeClaimTemplates && {
        volumeClaimTemplates: config.volumeClaimTemplates,
      }),
    },
  });
}
