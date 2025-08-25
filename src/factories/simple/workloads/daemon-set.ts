/**
 * Simple DaemonSet Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes DaemonSet resources with sensible defaults.
 */

import type { V1EnvVar } from '@kubernetes/client-node';

import { daemonSet } from '../../kubernetes/workloads/daemon-set.js';
import type {
  V1DaemonSetSpec,
  V1DaemonSetStatus,
} from '../../kubernetes/workloads/daemon-set.js';
import type { Enhanced } from '../../../core/types.js';
import type { DaemonSetConfig } from '../types.js';

/**
 * Creates a simple DaemonSet with sensible defaults
 *
 * @param config - Configuration for the daemon set
 * @returns Enhanced DaemonSet resource
 */
export function DaemonSet(
  config: DaemonSetConfig
): Enhanced<V1DaemonSetSpec, V1DaemonSetStatus> {
  const env: V1EnvVar[] = config.env
    ? Object.entries(config.env).map(([name, value]) => ({ name, value }))
    : [];

  return daemonSet({
    ...(config.id && { id: config.id }),
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
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
              ...(config.resources && { resources: config.resources }),
              ...(config.volumeMounts && { volumeMounts: config.volumeMounts }),
            },
          ],
          ...(config.volumes && { volumes: config.volumes }),
        },
      },
    },
  });
}
