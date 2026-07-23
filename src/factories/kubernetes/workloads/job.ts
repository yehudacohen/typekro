import type { V1Job } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import {
  identifyPortableReadinessEvaluator,
  registerPortableReadinessStrategy,
} from '../../../core/readiness/portable-strategies.js';
import {
  optionalReadinessNumber,
  optionalReadinessString,
  readinessConfiguration,
  readinessLiteral,
} from '../../../core/readiness/strategy-configuration.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1JobSpec = NonNullable<V1Job['spec']>;
export type V1JobStatus = NonNullable<V1Job['status']>;

const JOB_READINESS_STRATEGY = 'typekro.readiness.kubernetes.job';
const JOB_READINESS_REVISION = '1';

interface JobReadinessDefaults {
  readonly expectedCompletions: number | undefined;
  readonly parallelism: number | undefined;
  readonly completionMode: string | undefined;
  readonly backoffLimit: number | undefined;
}

function createJobReadinessEvaluator(
  defaults: JobReadinessDefaults
): (liveResource: unknown) => ResourceStatus {
  const evaluator = (input: unknown): ResourceStatus => {
    let expectedCompletions = defaults.expectedCompletions ?? 1;
    let parallelism = defaults.parallelism ?? 1;
    let completionMode = defaults.completionMode ?? 'NonIndexed';

    try {
      const liveResource = input as V1Job;
      expectedCompletions = defaults.expectedCompletions ?? liveResource.spec?.completions ?? 1;
      parallelism = defaults.parallelism ?? liveResource.spec?.parallelism ?? 1;
      completionMode = defaults.completionMode ?? liveResource.spec?.completionMode ?? 'NonIndexed';
      const backoffLimit = defaults.backoffLimit ?? liveResource.spec?.backoffLimit;
      const status = liveResource.status;

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

      if (failed > 0 && backoffLimit !== undefined && failed > backoffLimit) {
        return {
          ready: false,
          reason: 'JobFailed',
          message: `Job failed: ${failed} failed pods exceed backoff limit of ${backoffLimit}`,
          details: {
            expectedCompletions,
            succeeded,
            failed,
            active,
            backoffLimit,
            completionMode,
          },
        };
      }

      const ready = succeeded === expectedCompletions;
      if (ready) {
        return {
          ready: true,
          message:
            completionMode === 'Indexed'
              ? `Job (Indexed) completed: ${succeeded}/${expectedCompletions} completions succeeded`
              : `Job completed: ${succeeded}/${expectedCompletions} completions succeeded`,
        };
      }

      return {
        ready: false,
        reason: 'JobInProgress',
        message:
          completionMode === 'Indexed'
            ? `Job (Indexed) in progress: ${succeeded}/${expectedCompletions} completions succeeded, ${active} active, ${failed} failed`
            : `Job in progress: ${succeeded}/${expectedCompletions} completions succeeded, ${active} active, ${failed} failed`,
        details: {
          expectedCompletions,
          succeeded,
          failed,
          active,
          parallelism,
          completionMode,
        },
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Job readiness: ${ensureError(error).message}`,
        details: {
          expectedCompletions,
          parallelism,
          completionMode,
          error: ensureError(error).message,
        },
      };
    }
  };

  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: JOB_READINESS_STRATEGY,
    revision: JOB_READINESS_REVISION,
    configuration: readinessConfiguration({
      backoffLimit:
        defaults.backoffLimit === undefined ? undefined : readinessLiteral(defaults.backoffLimit),
      completionMode:
        defaults.completionMode === undefined
          ? undefined
          : readinessLiteral(defaults.completionMode),
      expectedCompletions:
        defaults.expectedCompletions === undefined
          ? undefined
          : readinessLiteral(defaults.expectedCompletions),
      parallelism:
        defaults.parallelism === undefined ? undefined : readinessLiteral(defaults.parallelism),
    }),
  });
}

registerPortableReadinessStrategy(JOB_READINESS_STRATEGY, JOB_READINESS_REVISION, (configuration) =>
  createJobReadinessEvaluator({
    backoffLimit: optionalReadinessNumber(configuration, 'backoffLimit'),
    completionMode: optionalReadinessString(configuration, 'completionMode'),
    expectedCompletions: optionalReadinessNumber(configuration, 'expectedCompletions'),
    parallelism: optionalReadinessNumber(configuration, 'parallelism'),
  })
);

/**
 * Creates a Kubernetes Job resource with completion-based readiness evaluation.
 *
 * @param resource - The Job specification conforming to the Kubernetes V1Job API.
 * @returns An Enhanced Job resource that tracks readiness based on successful completions, supporting both Indexed and NonIndexed completion modes.
 * @example
 * const migrate = job({
 *   metadata: { name: 'db-migrate' },
 *   spec: { template: { spec: { containers: [{ name: 'migrate', image: 'migrate:latest' }], restartPolicy: 'Never' } } },
 * });
 */
export function job(resource: V1Job & { id?: string }): Enhanced<V1JobSpec, V1JobStatus> {
  // Capture configuration in closure for Job-specific readiness logic
  const defaults: JobReadinessDefaults = {
    expectedCompletions:
      typeof resource.spec?.completions === 'number' ? resource.spec.completions : undefined,
    parallelism:
      typeof resource.spec?.parallelism === 'number' ? resource.spec.parallelism : undefined,
    completionMode:
      typeof resource.spec?.completionMode === 'string' ? resource.spec.completionMode : undefined,
    backoffLimit:
      typeof resource.spec?.backoffLimit === 'number' ? resource.spec.backoffLimit : undefined,
  };

  return createResource({
    ...resource,
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: resource.metadata ?? { name: 'unnamed-job' },
  }).withReadinessEvaluator(createJobReadinessEvaluator(defaults));
}
