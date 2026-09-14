/**
 * Unit tests for the integration suites' pod-selection rules.
 *
 * These rules decide WHICH pods a ground-truth assertion judges, so getting
 * them wrong does not surface as a wrong answer — it surfaces as a check that
 * fails on history it should have ignored, or one that passes while asserting
 * over nothing. The bugs they guard against, both live ones:
 *
 * - selecting pods by owner KIND, which dragged Job pods into a "must be
 *   Running" bar and could not tell a live ReplicaSet from a superseded one;
 * - holding every Job pod in the namespace to `Succeeded`, which fails on the
 *   runs and retry attempts a CronJob's `failedJobsHistoryLimit` and
 *   `backoffLimit` retain by design.
 */
import { describe, expect, it } from 'bun:test';

import {
  groupJobRunsByOwner,
  latestCompletedRun,
  type ObjectLike,
  type PodLike,
  selectLongRunningPods,
} from '../integration/shared-workload-pods.js';

/** Seconds since an arbitrary epoch, so ordering is easy to read. */
function at(seconds: number): Date {
  return new Date(1_700_000_000_000 + seconds * 1_000);
}

function workload(uid: string, name: string, ownerUid?: string): ObjectLike {
  return {
    metadata: {
      uid,
      name,
      creationTimestamp: at(0),
      ...(ownerUid === undefined
        ? {}
        : { ownerReferences: [{ kind: 'Deployment', uid: ownerUid }] }),
    },
  };
}

function pod(options: {
  name: string;
  ownerKind: string;
  ownerUid: string;
  phase?: string;
  createdAt?: number;
  deleting?: boolean;
}): PodLike {
  return {
    metadata: {
      uid: `pod-${options.name}`,
      name: options.name,
      creationTimestamp: at(options.createdAt ?? 0),
      ownerReferences: [{ kind: options.ownerKind, uid: options.ownerUid }],
      ...(options.deleting === true ? { deletionTimestamp: at(1) } : {}),
    },
    status: { phase: options.phase ?? 'Running' },
  };
}

describe('selectLongRunningPods', () => {
  const deployment = workload('dep-1', 'app');
  const replicaSet = workload('rs-1', 'app-abc', 'dep-1');
  const statefulSet = workload('sts-1', 'mongodb');

  const appPod = pod({ name: 'app-abc-1', ownerKind: 'ReplicaSet', ownerUid: 'rs-1' });
  const mongoPod = pod({ name: 'mongodb-0', ownerKind: 'StatefulSet', ownerUid: 'sts-1' });

  it('selects the pods of the given Deployments and StatefulSets', () => {
    const selected = selectLongRunningPods({
      pods: [appPod, mongoPod],
      deployments: [deployment],
      statefulSets: [statefulSet],
      replicaSets: [replicaSet],
    });

    expect(selected.map((p) => p.metadata?.name)).toEqual(['app-abc-1', 'mongodb-0']);
  });

  it('excludes Job pods, which is the whole point of not matching on owner kind', () => {
    const jobPod = pod({
      name: 'team-bootstrap-1-xyz',
      ownerKind: 'Job',
      ownerUid: 'job-1',
      phase: 'Succeeded',
    });

    const selected = selectLongRunningPods({
      pods: [appPod, jobPod],
      deployments: [deployment],
      statefulSets: [],
      replicaSets: [replicaSet],
    });

    expect(selected.map((p) => p.metadata?.name)).toEqual(['app-abc-1']);
  });

  it('excludes a pod owned by a ReplicaSet of some OTHER Deployment', () => {
    const strayPod = pod({ name: 'stray-1', ownerKind: 'ReplicaSet', ownerUid: 'rs-other' });

    const selected = selectLongRunningPods({
      pods: [appPod, strayPod],
      deployments: [deployment],
      statefulSets: [],
      replicaSets: [replicaSet, workload('rs-other', 'stray', 'dep-other')],
    });

    expect(selected.map((p) => p.metadata?.name)).toEqual(['app-abc-1']);
  });

  it('excludes a terminating pod', () => {
    const dying = pod({
      name: 'app-abc-old',
      ownerKind: 'ReplicaSet',
      ownerUid: 'rs-1',
      deleting: true,
    });

    const selected = selectLongRunningPods({
      pods: [appPod, dying],
      deployments: [deployment],
      statefulSets: [],
      replicaSets: [replicaSet],
    });

    expect(selected.map((p) => p.metadata?.name)).toEqual(['app-abc-1']);
  });

  it('returns nothing when the workloads are absent — the vacuous case a caller must catch', () => {
    expect(
      selectLongRunningPods({
        pods: [appPod, mongoPod],
        deployments: [],
        statefulSets: [],
        replicaSets: [],
      })
    ).toEqual([]);
  });
});

describe('groupJobRunsByOwner', () => {
  const cronJobUid = 'cron-1';
  const job = (uid: string, name: string, createdAt: number): ObjectLike => ({
    metadata: {
      uid,
      name,
      creationTimestamp: at(createdAt),
      ownerReferences: [{ kind: 'CronJob', uid: cronJobUid }],
    },
  });

  it('judges a Job by its NEWEST pod, ignoring earlier backoff attempts', () => {
    const runs = groupJobRunsByOwner(
      [
        pod({ name: 'r1-a', ownerKind: 'Job', ownerUid: 'job-1', phase: 'Failed', createdAt: 10 }),
        pod({
          name: 'r1-b',
          ownerKind: 'Job',
          ownerUid: 'job-1',
          phase: 'Succeeded',
          createdAt: 20,
        }),
      ],
      [job('job-1', 'bootstrap-1', 10)]
    );

    expect(runs.get(cronJobUid)).toEqual([
      { jobName: 'bootstrap-1', createdAt: at(10).getTime(), phase: 'Succeeded' },
    ]);
  });

  it('groups every run of one CronJob together, newest first', () => {
    const runs = groupJobRunsByOwner(
      [
        pod({ name: 'r1', ownerKind: 'Job', ownerUid: 'job-1', phase: 'Failed', createdAt: 10 }),
        pod({ name: 'r2', ownerKind: 'Job', ownerUid: 'job-2', phase: 'Succeeded', createdAt: 70 }),
      ],
      [job('job-1', 'bootstrap-1', 10), job('job-2', 'bootstrap-2', 70)]
    );

    expect(runs.get(cronJobUid)?.map((run) => run.jobName)).toEqual([
      'bootstrap-2',
      'bootstrap-1',
    ]);
  });

  it('gives a Job with no owning CronJob its own group', () => {
    const standalone: ObjectLike = {
      metadata: { uid: 'job-solo', name: 'migrate', creationTimestamp: at(5) },
    };
    const runs = groupJobRunsByOwner(
      [
        pod({
          name: 'migrate-a',
          ownerKind: 'Job',
          ownerUid: 'job-solo',
          phase: 'Succeeded',
          createdAt: 5,
        }),
      ],
      [standalone]
    );

    expect([...runs.keys()]).toEqual(['job-solo']);
  });

  it('ignores a Job whose pods have been garbage-collected', () => {
    expect(groupJobRunsByOwner([], [job('job-1', 'bootstrap-1', 10)]).size).toBe(0);
  });

  it('ignores pods that belong to no Job at all', () => {
    const runs = groupJobRunsByOwner(
      [pod({ name: 'app-1', ownerKind: 'ReplicaSet', ownerUid: 'rs-1' })],
      []
    );

    expect(runs.size).toBe(0);
  });
});

describe('latestCompletedRun', () => {
  const run = (createdAt: number, phase: string | undefined) => ({
    jobName: `job-${createdAt}`,
    createdAt,
    phase,
  });

  it('ignores older FAILED runs once a later one succeeded — the retained history', () => {
    // The bug this pins: three retained failures from before the dependency
    // was serving used to fail the assertion the successful run satisfies.
    expect(
      latestCompletedRun([run(10, 'Failed'), run(20, 'Failed'), run(30, 'Succeeded')])?.phase
    ).toBe('Succeeded');
  });

  it('reports a FAILED latest run, so a currently-failing workload still fails', () => {
    expect(
      latestCompletedRun([run(10, 'Succeeded'), run(40, 'Failed')])
    ).toEqual(run(40, 'Failed'));
  });

  it('skips a run still in flight and judges the newest FINISHED one', () => {
    expect(
      latestCompletedRun([run(50, 'Running'), run(40, 'Succeeded'), run(10, 'Failed')])?.createdAt
    ).toBe(40);
  });

  it('reports undefined when nothing has completed — the vacuous case', () => {
    expect(latestCompletedRun([run(10, 'Pending'), run(20, 'Running')])).toBeUndefined();
    expect(latestCompletedRun([])).toBeUndefined();
  });
});
