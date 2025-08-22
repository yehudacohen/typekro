import type { V1CronJob } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1CronJobSpec = NonNullable<V1CronJob['spec']>;
export type V1CronJobStatus = NonNullable<V1CronJob['status']>;

export function cronJob(resource: V1CronJob): Enhanced<V1CronJobSpec, V1CronJobStatus> {
  return createResource({
    ...resource,
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: resource.metadata ?? { name: 'unnamed-cronjob' },
  }).withReadinessEvaluator((liveResource: V1CronJob) => {
    try {
      const status = liveResource.status;

      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'CronJob status not available yet',
        };
      }

      // CronJob is ready when it exists and has been scheduled
      // We consider it ready if it has a lastScheduleTime or if it's suspended
      const lastScheduleTime = status.lastScheduleTime;
      const active = status.active || [];
      const suspended = resource.spec?.suspend || false;

      if (suspended) {
        return {
          ready: true,
          message: 'CronJob is suspended and ready',
        };
      }

      if (lastScheduleTime || active.length === 0) {
        return {
          ready: true,
          message: `CronJob is ready with ${active.length} active jobs`,
        };
      }

      return {
        ready: false,
        reason: 'NotScheduled',
        message: 'CronJob has not been scheduled yet',
        details: { active: active.length, suspended },
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating CronJob readiness: ${error}`,
        details: { error: String(error) },
      };
    }
  });
}
