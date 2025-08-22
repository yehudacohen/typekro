import type { V1Job } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1JobSpec = NonNullable<V1Job['spec']>;
export type V1JobStatus = NonNullable<V1Job['status']>;

export function job(resource: V1Job): Enhanced<V1JobSpec, V1JobStatus> {
  // Capture configuration in closure for Job-specific readiness logic
  const expectedCompletions = resource.spec?.completions || 1;
  const parallelism = resource.spec?.parallelism || 1;
  const completionMode = resource.spec?.completionMode || 'NonIndexed';

  return createResource({
    ...resource,
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: resource.metadata ?? { name: 'unnamed-job' },
  }).withReadinessEvaluator((liveResource: V1Job) => {
    try {
      const status = liveResource.status;

      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'Job status not available yet',
          details: { expectedCompletions, parallelism, completionMode },
        };
      }

      const succeeded = status.succeeded || 0;
      const failed = status.failed || 0;
      const active = status.active || 0;

      // Check for job failure conditions
      if (failed > 0 && resource.spec?.backoffLimit && failed > resource.spec.backoffLimit) {
        return {
          ready: false,
          reason: 'JobFailed',
          message: `Job failed: ${failed} failed pods exceed backoff limit of ${resource.spec.backoffLimit}`,
          details: {
            expectedCompletions,
            succeeded,
            failed,
            active,
            backoffLimit: resource.spec.backoffLimit,
            completionMode,
          },
        };
      }

      // Job readiness depends on completion mode
      if (completionMode === 'Indexed') {
        // For indexed jobs, we need all completions to succeed
        const ready = succeeded === expectedCompletions;

        if (ready) {
          return {
            ready: true,
            message: `Job (Indexed) completed: ${succeeded}/${expectedCompletions} completions succeeded`,
          };
        } else {
          return {
            ready: false,
            reason: 'JobInProgress',
            message: `Job (Indexed) in progress: ${succeeded}/${expectedCompletions} completions succeeded, ${active} active, ${failed} failed`,
            details: {
              expectedCompletions,
              succeeded,
              failed,
              active,
              parallelism,
              completionMode,
            },
          };
        }
      } else {
        // NonIndexed mode: job is ready when succeeded count matches expected completions
        const ready = succeeded === expectedCompletions;

        if (ready) {
          return {
            ready: true,
            message: `Job completed: ${succeeded}/${expectedCompletions} completions succeeded`,
          };
        } else {
          return {
            ready: false,
            reason: 'JobInProgress',
            message: `Job in progress: ${succeeded}/${expectedCompletions} completions succeeded, ${active} active, ${failed} failed`,
            details: {
              expectedCompletions,
              succeeded,
              failed,
              active,
              parallelism,
              completionMode,
            },
          };
        }
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Job readiness: ${error}`,
        details: { expectedCompletions, parallelism, completionMode, error: String(error) },
      };
    }
  });
}
