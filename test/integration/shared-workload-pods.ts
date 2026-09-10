/**
 * Pod-selection rules shared by the integration suites' ground-truth checks.
 *
 * A suite that reads `listNamespacedPod` and judges whatever comes back is
 * judging the NAMESPACE, not the workloads it deployed. That is wrong in both
 * directions: a Job pod dragged into a "must be Running" bar fails a check it
 * was never meant to answer, and a bar applied to an empty selection passes
 * without asserting anything at all.
 *
 * These functions hold the selection rules, and nothing else. They take plain
 * objects rather than a client, so `test/unit/workload-pods.test.ts` can pin
 * the rules in the normal unit run instead of only when a cluster happens to
 * be available.
 */

/** The subset of `V1OwnerReference` these rules read. */
interface OwnerReferenceLike {
  readonly kind?: string;
  readonly uid: string;
}

/** The subset of `V1ObjectMeta` these rules read. */
interface MetadataLike {
  readonly uid?: string;
  readonly name?: string;
  readonly creationTimestamp?: Date;
  readonly deletionTimestamp?: Date;
  readonly ownerReferences?: readonly OwnerReferenceLike[];
}

/** Any namespaced Kubernetes object. */
export interface ObjectLike {
  readonly metadata?: MetadataLike;
}

/** A Pod, as far as these rules are concerned. */
export interface PodLike extends ObjectLike {
  readonly status?: { readonly phase?: string };
}

function createdAt(resource: ObjectLike): number {
  return new Date(resource.metadata?.creationTimestamp ?? 0).getTime();
}

function uidsOf(resources: readonly ObjectLike[]): Set<string> {
  return new Set(resources.flatMap((resource) => resource.metadata?.uid ?? []));
}

function ownerRefs(resource: ObjectLike): readonly OwnerReferenceLike[] {
  return resource.metadata?.ownerReferences ?? [];
}

/**
 * The pods of the LONG-RUNNING workloads in `deployments` and `statefulSets`.
 *
 * Selection is by ownerReference **UID**, resolved through the ReplicaSets a
 * Deployment owns, rather than by owner KIND. Kind-matching is what lets an
 * unrelated pod drift into the set — every Deployment in the namespace looks
 * alike to it, including one some other actor created — and it cannot tell a
 * live ReplicaSet from a superseded one. Terminating pods are excluded: a pod
 * with a `deletionTimestamp` is on its way out and is not evidence about the
 * workload's health.
 *
 * The caller is responsible for asserting that the workloads themselves are
 * the expected ones. This function cannot tell an empty namespace from a
 * missing deployment, and returning `[]` for both is exactly why a count
 * assertion belongs on the Deployments and StatefulSets, not only on the pods.
 */
export function selectLongRunningPods<P extends PodLike>(input: {
  pods: readonly P[];
  deployments: readonly ObjectLike[];
  statefulSets: readonly ObjectLike[];
  replicaSets: readonly ObjectLike[];
}): P[] {
  const deploymentUids = uidsOf(input.deployments);
  const ownerUids = new Set([
    ...input.replicaSets
      .filter((replicaSet) => ownerRefs(replicaSet).some((o) => deploymentUids.has(o.uid)))
      .flatMap((replicaSet) => replicaSet.metadata?.uid ?? []),
    ...uidsOf(input.statefulSets),
  ]);

  return input.pods.filter(
    (pod) =>
      pod.metadata?.deletionTimestamp === undefined &&
      ownerRefs(pod).some((owner) => ownerUids.has(owner.uid))
  );
}

/** One run of a Job: when it was created, and the verdict of its newest pod. */
export interface JobRun {
  /** The Job's name, for a legible assertion failure. */
  readonly jobName: string | undefined;
  readonly createdAt: number;
  /** Phase of the job's NEWEST pod — its latest attempt. */
  readonly phase: string | undefined;
}

/** A pod phase that will not change again. */
function isTerminal(run: JobRun): boolean {
  return run.phase === 'Succeeded' || run.phase === 'Failed';
}

/**
 * Group Job runs under the CronJob that scheduled them.
 *
 * Two layers of history have to be collapsed before a Job pod means anything:
 *
 * - A Job's pods are its ATTEMPTS. Only the newest speaks for the run; an
 *   earlier attempt failing is precisely what `backoffLimit` exists to allow.
 * - A CronJob's Jobs are its RUNS, and `failedJobsHistoryLimit` keeps failed
 *   ones ON PURPOSE. A run that fired before its dependencies were serving is
 *   retained history, not a verdict on the deployment under test.
 *
 * A Job with no owning CronJob is its own group, so a one-shot Job is judged
 * on its own. Jobs whose pods have already been garbage-collected contribute
 * no run — there is nothing left to judge them by.
 *
 * @returns Runs by owner UID, each list newest-first.
 */
export function groupJobRunsByOwner(
  pods: readonly PodLike[],
  jobs: readonly ObjectLike[]
): Map<string, JobRun[]> {
  const latestAttempt = new Map<string, PodLike>();
  for (const pod of pods) {
    const jobUid = ownerRefs(pod).find((owner) => owner.kind === 'Job')?.uid;
    if (jobUid === undefined) continue;
    const current = latestAttempt.get(jobUid);
    if (current === undefined || createdAt(pod) >= createdAt(current)) {
      latestAttempt.set(jobUid, pod);
    }
  }

  const runsByOwner = new Map<string, JobRun[]>();
  for (const job of jobs) {
    const jobUid = job.metadata?.uid;
    if (jobUid === undefined) continue;
    const attempt = latestAttempt.get(jobUid);
    if (attempt === undefined) continue;
    const ownerUid = ownerRefs(job).find((owner) => owner.kind === 'CronJob')?.uid ?? jobUid;
    const runs = runsByOwner.get(ownerUid) ?? [];
    runs.push({
      jobName: job.metadata?.name,
      createdAt: createdAt(job),
      phase: attempt.status?.phase,
    });
    runsByOwner.set(ownerUid, runs);
  }

  for (const runs of runsByOwner.values()) {
    runs.sort((a, b) => b.createdAt - a.createdAt);
  }
  return runsByOwner;
}

/**
 * The most recent run that reached a terminal phase, or `undefined` if none
 * has.
 *
 * Runs still `Pending` or `Running` are skipped rather than judged: a
 * minute-level CronJob usually has one in flight, and failing a check because
 * a run has not finished yet would make the check a race. `undefined` means
 * the workload has not completed a run at all, which a caller should treat as
 * a failed assertion rather than as a pass — it is the vacuous case.
 */
export function latestCompletedRun(runs: readonly JobRun[]): JobRun | undefined {
  return [...runs].sort((a, b) => b.createdAt - a.createdAt).find(isTerminal);
}
