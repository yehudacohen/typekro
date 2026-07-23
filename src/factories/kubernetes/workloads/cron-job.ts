import type { V1CronJob } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import {
  identifyPortableReadinessEvaluator,
  registerPortableReadinessStrategy,
} from '../../../core/readiness/portable-strategies.js';
import {
  optionalReadinessBoolean,
  readinessConfiguration,
  readinessLiteral,
} from '../../../core/readiness/strategy-configuration.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1CronJobSpec = NonNullable<V1CronJob['spec']>;
export type V1CronJobStatus = NonNullable<V1CronJob['status']>;

const CRON_JOB_READINESS_STRATEGY = 'typekro.readiness.kubernetes.cron-job';

function createCronJobReadinessEvaluator(staticSuspended?: boolean) {
  const evaluator = (liveResource: V1CronJob) => {
    try {
      const status = liveResource.status;
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'CronJob status not available yet',
        };
      }

      const active = status.active || [];
      const suspended = staticSuspended ?? liveResource.spec?.suspend ?? false;
      if (suspended) return { ready: true, message: 'CronJob is suspended and ready' };
      if (status.lastScheduleTime || active.length === 0) {
        return { ready: true, message: `CronJob is ready with ${active.length} active jobs` };
      }
      return {
        ready: false,
        reason: 'NotScheduled',
        message: 'CronJob has not been scheduled yet',
        details: { active: active.length, suspended },
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating CronJob readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message },
      };
    }
  };
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: CRON_JOB_READINESS_STRATEGY,
    revision: '1',
    configuration: readinessConfiguration({
      suspended: staticSuspended === undefined ? undefined : readinessLiteral(staticSuspended),
    }),
  });
}

registerPortableReadinessStrategy(CRON_JOB_READINESS_STRATEGY, '1', (configuration) =>
  createCronJobReadinessEvaluator(optionalReadinessBoolean(configuration, 'suspended'))
);

/**
 * Creates a Kubernetes CronJob resource with schedule-based readiness evaluation.
 *
 * @param resource - The CronJob specification conforming to the Kubernetes V1CronJob API.
 * @returns An Enhanced CronJob resource that is considered ready when it has been scheduled at least once, has no active jobs, or is suspended.
 * @example
 * const backup = cronJob({
 *   metadata: { name: 'nightly-backup' },
 *   spec: { schedule: '0 2 * * *', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'backup', image: 'backup:latest' }], restartPolicy: 'Never' } } } } },
 * });
 */
export function cronJob(
  resource: V1CronJob & { id?: string }
): Enhanced<V1CronJobSpec, V1CronJobStatus> {
  const staticSuspended =
    typeof resource.spec?.suspend === 'boolean' ? resource.spec.suspend : undefined;
  return createResource({
    ...resource,
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: resource.metadata ?? { name: 'unnamed-cronjob' },
  }).withReadinessEvaluator(createCronJobReadinessEvaluator(staticSuspended));
}
