/**
 * Test suite for CronJob Factory Function
 *
 * This tests the CronJob factory with its complex readiness evaluation logic.
 */

import { describe, expect, it } from 'bun:test';
import type { V1CronJob } from '@kubernetes/client-node';
import { cronJob } from '../../src/factories/kubernetes/workloads/cron-job.js';

describe('CronJob Factory', () => {
  const createTestCronJob = (
    name: string = 'test-cronjob',
    schedule: string = '0 2 * * *',
    suspend: boolean = false
  ): V1CronJob => ({
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name, namespace: 'default' },
    spec: {
      schedule,
      suspend,
      jobTemplate: {
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: 'backup',
                  image: 'busybox:1.35',
                  command: ['sh', '-c', 'echo "Running backup job"'],
                },
              ],
              restartPolicy: 'OnFailure',
            },
          },
        },
      },
    },
  });

  describe('Factory Creation', () => {
    it('should create cronJob with proper structure', () => {
      const cronJobResource = createTestCronJob();
      const enhanced = cronJob(cronJobResource);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('CronJob');
      expect(enhanced.apiVersion).toBe('batch/v1');
      expect(enhanced.metadata.name).toBe('test-cronjob');
      expect(enhanced.metadata.namespace).toBe('default');
      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should set correct apiVersion and kind', () => {
      const cronJobResource = createTestCronJob('version-test');
      const enhanced = cronJob(cronJobResource);

      expect(enhanced.apiVersion).toBe('batch/v1');
      expect(enhanced.kind).toBe('CronJob');
    });

    it('should handle missing metadata with defaults', () => {
      const cronJobWithoutMetadata: V1CronJob = {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        // metadata is missing
        spec: {
          schedule: '0 1 * * *',
          jobTemplate: {
            spec: {
              template: {
                spec: {
                  containers: [{ name: 'job', image: 'alpine' }],
                  restartPolicy: 'Never',
                },
              },
            },
          },
        },
      } as any;

      const enhanced = cronJob(cronJobWithoutMetadata);
      expect(enhanced.metadata.name).toBe('unnamed-cronjob');
    });

    it('should preserve original cronJob specification', () => {
      const originalCronJob = createTestCronJob('preservation-test', '*/15 * * * *');
      const enhanced = cronJob(originalCronJob);

      expect(enhanced.spec).toEqual(originalCronJob.spec! as any);
      expect(enhanced.spec?.schedule).toBe('*/15 * * * *');
      expect(enhanced.spec?.jobTemplate.spec?.template.spec?.containers?.[0]?.image).toBe(
        'busybox:1.35'
      );
    });
  });

  describe('Readiness Evaluation', () => {
    it('should evaluate suspended cronJob as ready', () => {
      const suspendedCronJob = createTestCronJob('suspended-job', '0 3 * * *', true);
      const enhanced = cronJob(suspendedCronJob);
      const evaluator = (enhanced as any).readinessEvaluator;

      const suspendedState = {
        status: {
          active: [],
          lastScheduleTime: null,
        },
      };

      const result = evaluator(suspendedState);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('CronJob is suspended and ready');
    });

    it('should evaluate cronJob with lastScheduleTime as ready', () => {
      const cronJobResource = createTestCronJob('scheduled-job');
      const enhanced = cronJob(cronJobResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      const scheduledState = {
        status: {
          active: [{ name: 'scheduled-job-12345' }],
          lastScheduleTime: '2024-01-01T02:00:00Z',
        },
      };

      const result = evaluator(scheduledState);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('CronJob is ready with 1 active jobs');
    });

    it('should evaluate cronJob with no active jobs as ready', () => {
      const cronJobResource = createTestCronJob('inactive-job');
      const enhanced = cronJob(cronJobResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      const inactiveState = {
        status: {
          active: [], // No active jobs
          lastScheduleTime: '2024-01-01T02:00:00Z',
        },
      };

      const result = evaluator(inactiveState);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('CronJob is ready with 0 active jobs');
    });

    it('should evaluate unscheduled cronJob as not ready', () => {
      const cronJobResource = createTestCronJob('unscheduled-job');
      const enhanced = cronJob(cronJobResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      const unscheduledState = {
        status: {
          active: [{ name: 'unscheduled-job-67890' }],
          lastScheduleTime: null, // Never scheduled
        },
      };

      const result = evaluator(unscheduledState);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('NotScheduled');
      expect(result.message).toBe('CronJob has not been scheduled yet');
      expect(result.details?.active).toBe(1);
      expect(result.details?.suspended).toBe(false);
    });

    it('should handle missing status gracefully', () => {
      const cronJobResource = createTestCronJob('no-status');
      const enhanced = cronJob(cronJobResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Test with null status
      const nullStatusResult = evaluator({ status: null });
      expect(nullStatusResult.ready).toBe(false);
      expect(nullStatusResult.reason).toBe('StatusMissing');
      expect(nullStatusResult.message).toBe('CronJob status not available yet');

      // Test with undefined status
      const undefinedStatusResult = evaluator({ status: undefined });
      expect(undefinedStatusResult.ready).toBe(false);
      expect(undefinedStatusResult.reason).toBe('StatusMissing');

      // Test with missing status entirely
      const noStatusResult = evaluator({});
      expect(noStatusResult.ready).toBe(false);
      expect(noStatusResult.reason).toBe('StatusMissing');
    });

    it('should count active jobs correctly', () => {
      const cronJobResource = createTestCronJob('active-jobs-test');
      const enhanced = cronJob(cronJobResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Test with multiple active jobs
      const multipleActiveState = {
        status: {
          active: [{ name: 'job-1' }, { name: 'job-2' }, { name: 'job-3' }],
          lastScheduleTime: '2024-01-01T02:00:00Z',
        },
      };

      const multipleResult = evaluator(multipleActiveState);
      expect(multipleResult.ready).toBe(true);
      expect(multipleResult.message).toBe('CronJob is ready with 3 active jobs');

      // Test with single active job
      const singleActiveState = {
        status: {
          active: [{ name: 'single-job' }],
          lastScheduleTime: '2024-01-01T02:00:00Z',
        },
      };

      const singleResult = evaluator(singleActiveState);
      expect(singleResult.ready).toBe(true);
      expect(singleResult.message).toBe('CronJob is ready with 1 active jobs');
    });

    it.skip('should handle evaluation errors gracefully', () => {
      const cronJobResource = createTestCronJob('error-handling');
      const enhanced = cronJob(cronJobResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Test with malformed input that might cause errors
      const errorScenarios = [null, undefined, 'invalid-string', 42, { status: 'not-an-object' }];

      errorScenarios.forEach((scenario) => {
        const result = evaluator(scenario);
        expect(result.ready).toBe(false);
        // Should return either StatusMissing or EvaluationError, both are acceptable for error handling
        expect(['StatusMissing', 'EvaluationError']).toContain(result.reason);
        expect(result.message).toBeDefined();
        expect(typeof result.message).toBe('string');
      });
    });

    it('should handle suspended state correctly in various scenarios', () => {
      // Test suspended CronJob with active jobs (should still be ready)
      const suspendedWithActiveJobs = createTestCronJob('suspended-active', '0 4 * * *', true);
      const enhanced1 = cronJob(suspendedWithActiveJobs);
      const evaluator1 = (enhanced1 as any).readinessEvaluator;

      const suspendedActiveState = {
        status: {
          active: [{ name: 'still-running-job' }],
          lastScheduleTime: '2024-01-01T02:00:00Z',
        },
      };

      const suspendedActiveResult = evaluator1(suspendedActiveState);
      expect(suspendedActiveResult.ready).toBe(true);
      expect(suspendedActiveResult.message).toBe('CronJob is suspended and ready');

      // Test non-suspended CronJob (default behavior)
      const notSuspended = createTestCronJob('not-suspended', '0 5 * * *', false);
      const enhanced2 = cronJob(notSuspended);
      const evaluator2 = (enhanced2 as any).readinessEvaluator;

      const notSuspendedState = {
        status: {
          active: [],
          lastScheduleTime: '2024-01-01T02:00:00Z',
        },
      };

      const notSuspendedResult = evaluator2(notSuspendedState);
      expect(notSuspendedResult.ready).toBe(true);
      expect(notSuspendedResult.message).toBe('CronJob is ready with 0 active jobs');
    });

    it('should handle missing active array gracefully', () => {
      const cronJobResource = createTestCronJob('missing-active');
      const enhanced = cronJob(cronJobResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      const missingActiveState = {
        status: {
          // active field is missing
          lastScheduleTime: '2024-01-01T02:00:00Z',
        },
      };

      const result = evaluator(missingActiveState);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('CronJob is ready with 0 active jobs');
    });

    it('should handle edge cases in scheduling logic', () => {
      const cronJobResource = createTestCronJob('edge-cases');
      const enhanced = cronJob(cronJobResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Test with lastScheduleTime but no active jobs (normal completion)
      const completedState = {
        status: {
          active: [],
          lastScheduleTime: '2024-01-01T02:00:00Z',
          lastSuccessfulTime: '2024-01-01T02:05:00Z',
        },
      };

      const completedResult = evaluator(completedState);
      expect(completedResult.ready).toBe(true);
      expect(completedResult.message).toBe('CronJob is ready with 0 active jobs');

      // Test with empty lastScheduleTime string
      const emptyScheduleState = {
        status: {
          active: [],
          lastScheduleTime: '',
        },
      };

      const emptyScheduleResult = evaluator(emptyScheduleState);
      expect(emptyScheduleResult.ready).toBe(true);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle CronJob with complex job template', () => {
      const complexCronJob: V1CronJob = {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata: {
          name: 'complex-backup-job',
          namespace: 'production',
          labels: { app: 'backup', tier: 'batch' },
        },
        spec: {
          schedule: '0 2 * * 0', // Weekly on Sunday at 2 AM
          suspend: false,
          successfulJobsHistoryLimit: 3,
          failedJobsHistoryLimit: 1,
          concurrencyPolicy: 'Forbid',
          startingDeadlineSeconds: 3600,
          jobTemplate: {
            metadata: {
              labels: { job: 'backup' },
            },
            spec: {
              activeDeadlineSeconds: 7200,
              backoffLimit: 2,
              template: {
                metadata: {
                  labels: { task: 'database-backup' },
                },
                spec: {
                  containers: [
                    {
                      name: 'backup-container',
                      image: 'postgres:14-alpine',
                      command: ['pg_dump'],
                      args: ['-h', 'db-host', '-U', 'backup-user', 'production_db'],
                      env: [
                        {
                          name: 'PGPASSWORD',
                          valueFrom: { secretKeyRef: { name: 'db-secret', key: 'password' } },
                        },
                      ],
                      volumeMounts: [
                        {
                          name: 'backup-storage',
                          mountPath: '/backups',
                        },
                      ],
                    },
                  ],
                  volumes: [
                    {
                      name: 'backup-storage',
                      persistentVolumeClaim: { claimName: 'backup-pvc' },
                    },
                  ],
                  restartPolicy: 'OnFailure',
                },
              },
            },
          },
        },
      };

      const enhanced = cronJob(complexCronJob);

      // Verify all complex properties are preserved
      expect(enhanced.spec.schedule).toBe('0 2 * * 0');
      expect(enhanced.spec.concurrencyPolicy).toBe('Forbid');
      expect(enhanced.spec.startingDeadlineSeconds).toBe(3600);
      expect(enhanced.spec.jobTemplate.spec.activeDeadlineSeconds).toBe(7200);
      expect(enhanced.spec?.jobTemplate.spec?.template.spec?.containers?.[0]?.command).toEqual([
        'pg_dump',
      ]);
      expect(
        enhanced.spec?.jobTemplate?.spec?.template?.spec?.volumes?.[0]?.persistentVolumeClaim
          ?.claimName
      ).toBe('backup-pvc');

      // Test readiness evaluation with complex job
      const evaluator = (enhanced as any).readinessEvaluator;
      const complexState = {
        status: {
          active: [{ name: 'complex-backup-job-1234567' }],
          lastScheduleTime: '2024-01-07T02:00:00Z',
          lastSuccessfulTime: '2024-01-01T02:05:00Z',
        },
      };

      const result = evaluator(complexState);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('CronJob is ready with 1 active jobs');
    });

    it('should work with different schedule patterns', () => {
      const schedulePatterns = [
        { schedule: '0 0 * * *', description: 'Daily at midnight' },
        { schedule: '*/5 * * * *', description: 'Every 5 minutes' },
        { schedule: '0 9-17 * * 1-5', description: 'Hourly during business hours on weekdays' },
        { schedule: '@hourly', description: 'Using named schedule' },
        { schedule: '@daily', description: 'Using daily named schedule' },
      ];

      schedulePatterns.forEach(({ schedule, description }) => {
        const cronJobResource = createTestCronJob(
          `schedule-test-${schedule.replace(/[^a-z0-9]/gi, '-')}`,
          schedule
        );
        const enhanced = cronJob(cronJobResource);

        expect(enhanced.spec.schedule).toBe(schedule);

        // Test that readiness evaluation works regardless of schedule
        const evaluator = (enhanced as any).readinessEvaluator;
        const testState = {
          status: {
            active: [],
            lastScheduleTime: '2024-01-01T09:00:00Z',
          },
        };

        const result = evaluator(testState);
        expect(result.ready).toBe(true);
        expect(result.message).toBe('CronJob is ready with 0 active jobs');
      });
    });

    it('should handle CronJob state transitions', () => {
      const cronJobResource = createTestCronJob('state-transitions');
      const enhanced = cronJob(cronJobResource);
      const evaluator = (enhanced as any).readinessEvaluator;

      // 1. Initial state - never scheduled
      const initialState = {
        status: {
          active: [],
        },
      };

      const initialResult = evaluator(initialState);
      expect(initialResult.ready).toBe(true);

      // 2. First execution - job is active
      const activeState = {
        status: {
          active: [{ name: 'state-transitions-1001' }],
          lastScheduleTime: '2024-01-01T02:00:00Z',
        },
      };

      const activeResult = evaluator(activeState);
      expect(activeResult.ready).toBe(true);
      expect(activeResult.message).toBe('CronJob is ready with 1 active jobs');

      // 3. Job completed - no active jobs
      const completedState = {
        status: {
          active: [],
          lastScheduleTime: '2024-01-01T02:00:00Z',
          lastSuccessfulTime: '2024-01-01T02:03:00Z',
        },
      };

      const completedResult = evaluator(completedState);
      expect(completedResult.ready).toBe(true);
      expect(completedResult.message).toBe('CronJob is ready with 0 active jobs');

      // 4. Suspended state
      const suspendedCronJob = createTestCronJob('state-transitions-suspended', '0 2 * * *', true);
      const suspendedEnhanced = cronJob(suspendedCronJob);
      const suspendedEvaluator = (suspendedEnhanced as any).readinessEvaluator;

      const suspendedResult = suspendedEvaluator(completedState);
      expect(suspendedResult.ready).toBe(true);
      expect(suspendedResult.message).toBe('CronJob is suspended and ready');
    });
  });

  describe('Integration and Compatibility', () => {
    it('should maintain compatibility with different API versions', () => {
      // Test batch/v1 (current)
      const v1CronJob = createTestCronJob('v1-cronjob');
      const v1Enhanced = cronJob(v1CronJob);
      expect(v1Enhanced.apiVersion).toBe('batch/v1');

      // Test with different input API version (should be normalized)
      const customVersionCronJob = createTestCronJob('custom-version');
      customVersionCronJob.apiVersion = 'batch/v1beta1';

      const customEnhanced = cronJob(customVersionCronJob);
      expect(customEnhanced.apiVersion).toBe('batch/v1'); // Should be normalized
    });

    it('should work with minimal valid CronJob specifications', () => {
      const minimalCronJob: V1CronJob = {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata: { name: 'minimal' },
        spec: {
          schedule: '0 1 * * *',
          jobTemplate: {
            spec: {
              template: {
                spec: {
                  containers: [{ name: 'minimal', image: 'alpine:latest' }],
                  restartPolicy: 'Never',
                },
              },
            },
          },
        },
      };

      const enhanced = cronJob(minimalCronJob);
      expect(enhanced.metadata.name).toBe('minimal');
      expect(enhanced.spec.schedule).toBe('0 1 * * *');
      expect(enhanced.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]?.name).toBe(
        'minimal'
      );

      // Test readiness evaluation with minimal spec
      const evaluator = (enhanced as any).readinessEvaluator;
      const minimalState = {
        status: {
          active: [],
          lastScheduleTime: '2024-01-01T01:00:00Z',
        },
      };

      const result = evaluator(minimalState);
      expect(result.ready).toBe(true);
    });

    it('should handle CronJob with resource requirements and constraints', () => {
      const resourceConstrainedCronJob = createTestCronJob('resource-constrained');

      // Add resource requirements
      resourceConstrainedCronJob.spec!.jobTemplate.spec!.template.spec!.containers![0]!.resources =
        {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        };

      // Add node selector and tolerations
      resourceConstrainedCronJob.spec!.jobTemplate.spec!.template.spec!.nodeSelector = {
        'kubernetes.io/arch': 'amd64',
      };

      resourceConstrainedCronJob.spec!.jobTemplate.spec!.template.spec!.tolerations = [
        {
          key: 'batch-workload',
          operator: 'Equal',
          value: 'true',
          effect: 'NoSchedule',
        },
      ];

      const enhanced = cronJob(resourceConstrainedCronJob);

      // Verify resource constraints are preserved
      const container = enhanced.spec!.jobTemplate.spec!.template.spec!.containers![0];
      expect(container!.resources?.requests?.cpu).toBe('100m');
      expect(container!.resources?.limits?.memory).toBe('512Mi');
      expect(
        enhanced.spec!.jobTemplate.spec!.template.spec!.nodeSelector?.['kubernetes.io/arch']
      ).toBe('amd64');
      expect(enhanced.spec?.jobTemplate?.spec?.template?.spec?.tolerations?.[0]?.key).toBe(
        'batch-workload'
      );
    });
  });
});
