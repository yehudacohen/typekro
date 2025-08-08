import type { V1CronJob } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource, processPodSpec } from '../../shared.js';

export type V1CronJobSpec = NonNullable<V1CronJob['spec']>;
export type V1CronJobStatus = NonNullable<V1CronJob['status']>;

export function cronJob(resource: V1CronJob): Enhanced<V1CronJobSpec, V1CronJobStatus> {
  if (resource.spec?.jobTemplate.spec?.template.spec) {
    const processed = processPodSpec(resource.spec.jobTemplate.spec.template.spec);
    if (processed) {
      resource.spec.jobTemplate.spec.template.spec = processed;
    }
  }
  return createResource({
    ...resource,
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: resource.metadata ?? { name: 'unnamed-cronjob' },
  });
}