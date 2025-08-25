/**
 * Simple CronJob Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes CronJob resources with sensible defaults.
 */

import { cronJob } from '../../kubernetes/workloads/cron-job.js';
import type { V1CronJobSpec, V1CronJobStatus } from '../../kubernetes/types.js';
import type { Enhanced } from '../../../core/types.js';
import type { CronJobConfig } from '../types.js';

/**
 * Creates a simple CronJob with sensible defaults
 *
 * @param config - Configuration for the cron job
 * @returns Enhanced CronJob resource
 */
export function CronJob(
  config: CronJobConfig
): Enhanced<V1CronJobSpec, V1CronJobStatus> {
  return cronJob({
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
      schedule: config.schedule,
      jobTemplate: {
        spec: {
          template: {
            metadata: { labels: { app: config.name } },
            spec: {
              restartPolicy: 'OnFailure',
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
      },
    },
  });
}