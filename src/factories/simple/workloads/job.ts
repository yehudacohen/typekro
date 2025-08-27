/**
 * Simple Job Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes Job resources with sensible defaults.
 */

import type { Enhanced } from '../../../core/types.js';
import type { V1JobSpec, V1JobStatus } from '../../kubernetes/types.js';
import { job } from '../../kubernetes/workloads/job.js';
import type { JobConfig } from '../types.js';

/**
 * Creates a simple Job with sensible defaults
 *
 * @param config - Configuration for the job
 * @returns Enhanced Job resource
 */
export function Job(config: JobConfig): Enhanced<V1JobSpec, V1JobStatus> {
  return job({
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
      ...(config.completions && { completions: config.completions }),
      ...(config.backoffLimit !== undefined && { backoffLimit: config.backoffLimit }),
      template: {
        metadata: { labels: { app: config.name } },
        spec: {
          restartPolicy: config.restartPolicy || 'OnFailure',
          containers: [
            {
              name: config.name,
              image: config.image,
              ...(config.command && { command: config.command }),
            },
          ],
        },
      },
    },
  });
}
