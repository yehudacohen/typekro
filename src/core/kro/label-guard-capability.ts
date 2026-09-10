/**
 * Whether — and at which group version — the KRO label-propagation guard can be
 * installed on the target cluster.
 *
 * `MutatingAdmissionPolicy` is beta from Kubernetes 1.34
 * (`admissionregistration.k8s.io/v1beta1`) and GA from 1.36
 * (`admissionregistration.k8s.io/v1`); the two group versions never overlap on
 * a given server, and nothing below 1.34 serves the kind at all. So the group
 * version is **never assumed**. It is resolved from the cluster or the guard is
 * not emitted:
 *
 * 1. `TYPEKRO_DISABLE_LABEL_GUARD` — break-glass, nothing is emitted.
 * 2. `TYPEKRO_LABEL_GUARD_API_VERSION` — an explicit pin, used verbatim. This
 *    is what an offline `toYaml()` render or a GitOps pipeline uses.
 * 3. A capability resolved against the cluster this build **explicitly** names.
 *    The direct deployment path resolves it and publishes the target for the
 *    duration of the deploy; a caller building outside a deployment probes and
 *    then wraps the build in `withLabelPropagationGuardCapability()`. Either
 *    way the cluster is carried by an `AsyncLocalStorage` scope, so the graph
 *    is built at the version *that* API server serves and concurrent builds for
 *    different clusters cannot see each other's answer.
 * 4. Otherwise — no pin and no cluster to ask — the guard is **skipped with a
 *    warning**. A composition built with no cluster knowledge does not get to
 *    guess a GA API that a 1.34 cluster would reject, taking the whole runtime
 *    bootstrap down with it.
 *
 * A skip is reported with the reason that actually applies: the cluster does
 * not serve `MutatingAdmissionPolicy`, or discovery against it failed, or no
 * cluster was named. The three are not interchangeable — telling a user their
 * 1.36 cluster is too old because a probe hit an RBAC error sends them to fix
 * the wrong thing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type * as k8s from '@kubernetes/client-node';
import type { MutatingAdmissionPolicyApiVersion } from '../../factories/kubernetes/admission/mutating-admission-policy.js';
import { MUTATING_ADMISSION_POLICY_API_VERSIONS } from '../../factories/kubernetes/admission/mutating-admission-policy.js';
import {
  type ApiGroupDiscovery,
  type ClusterCapabilityRequirement,
  clusterIdentity,
  getCachedClusterCapability,
  getCurrentDeployTarget,
  kubeConfigApiGroupDiscovery,
  registerDeployTimeCapability,
  resetClusterCapabilityCache,
  resolveClusterCapability,
} from '../kubernetes/api-capability.js';
import { getComponentLogger } from '../logging/index.js';

const logger = getComponentLogger('kro-label-guard');

/**
 * Break-glass: set to `1`/`true` to build the runtime bootstrap without the
 * guard on a cluster where the policy misbehaves. There is deliberately no
 * config option — the guard is a floor, not a feature.
 */
export const DISABLE_LABEL_GUARD_ENV = 'TYPEKRO_DISABLE_LABEL_GUARD';

/**
 * Pin the group version the guard is rendered at, e.g.
 * `admissionregistration.k8s.io/v1beta1` for a 1.34/1.35 cluster. Needed when
 * rendering YAML or an RGD offline, where no cluster can be asked.
 */
export const LABEL_GUARD_API_VERSION_ENV = 'TYPEKRO_LABEL_GUARD_API_VERSION';

/** The cluster capability the guard depends on. */
export const LABEL_GUARD_CAPABILITY: ClusterCapabilityRequirement = {
  id: 'kro-label-propagation-guard',
  group: 'admissionregistration.k8s.io',
  kind: 'MutatingAdmissionPolicy',
  // Bare versions, GA first, derived from the factory's group-version list so
  // the two cannot drift.
  versions: MUTATING_ADMISSION_POLICY_API_VERSIONS.map(
    (apiVersion) => apiVersion.split('/')[1] ?? apiVersion
  ),
};

// Resolved by the direct deployment path before it re-executes a composition,
// so a bootstrap deployed to a live cluster renders the guard at the group
// version that cluster actually serves.
registerDeployTimeCapability(LABEL_GUARD_CAPABILITY);

export type LabelPropagationGuardStatus = 'active' | 'unavailable';

export type LabelPropagationGuardCapability =
  | { status: 'active'; apiVersion: MutatingAdmissionPolicyApiVersion }
  | { status: 'unavailable'; reason: string };

/**
 * What a caller should do instead when the guard cannot be installed. Kept as
 * one string so the warning, the docs and the error text cannot drift apart.
 */
export const LABEL_GUARD_ALTERNATIVES =
  'Use the operator-side propagation filter where the operator has one ' +
  '(configure it from KRO_OWNERSHIP_LABELS), or isolate the CR in its own ' +
  'single-kind ResourceGraphDefinition via singleton() so the prune sweep ' +
  'never lists the operator-created kinds.';

/** The reason reported when nothing resolved the group version. */
export const LABEL_GUARD_UNRESOLVED_REASON =
  'the MutatingAdmissionPolicy group version was not resolved against a cluster ' +
  `(no live deployment target and no ${LABEL_GUARD_API_VERSION_ENV})`;

/**
 * A capability scoped to one build.
 *
 * This is the supported way to carry a probe result into a build:
 * {@link withLabelPropagationGuardCapability} runs the build inside it, and two
 * concurrent builds for different clusters each see their own. Same mechanism
 * as the deploy target — `AsyncLocalStorage`, not a module variable — so
 * nothing can bleed from one build into the next.
 */
const SCOPED_CAPABILITY = new AsyncLocalStorage<LabelPropagationGuardCapability>();

/**
 * A process-wide asserted capability, used when a caller knows the answer and
 * there is no cluster to ask — an offline render, or a test.
 *
 * This one really is a module global, and it is kept that way deliberately:
 * it exists for the "set it once for the whole process" case (a CLI that has
 * decided the group version before it builds anything), which is exactly what a
 * scope cannot express. That makes it a leak path by construction — it outlives
 * any single build — so it is only ever written by an explicit
 * {@link setLabelPropagationGuardCapability} call, never by a probe, and
 * {@link resetLabelGuardCapabilityCache} clears it for tests. Prefer
 * {@link withLabelPropagationGuardCapability}, which outranks it.
 */
let assertedCapability: LabelPropagationGuardCapability | undefined;

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function parseApiVersionEnv(
  value: string | undefined
): MutatingAdmissionPolicyApiVersion | undefined {
  if (!value) return undefined;
  const match = MUTATING_ADMISSION_POLICY_API_VERSIONS.find((known) => known === value);
  if (!match) {
    logger.warn(
      `Ignoring ${LABEL_GUARD_API_VERSION_ENV}: not a group version that serves MutatingAdmissionPolicy`,
      { value, supported: [...MUTATING_ADMISSION_POLICY_API_VERSIONS] }
    );
    return undefined;
  }
  return match;
}

function asGuardApiVersion(apiVersion: string): MutatingAdmissionPolicyApiVersion | undefined {
  return MUTATING_ADMISSION_POLICY_API_VERSIONS.find((known) => known === apiVersion);
}

/**
 * Resolve the guard's capability for the cluster this build targets.
 *
 * Order: break-glass env var, explicit group-version env var, a capability
 * scoped to this build, the process-wide asserted capability, the capability
 * resolved for the current deploy target, then **skip**. There is no assumed
 * group version at the end of the chain — that is what makes the guard safe on
 * a cluster below 1.36 rather than an apply failure for the whole bootstrap.
 *
 * Every cluster-derived answer comes from an explicitly scoped target. There is
 * no ambient "last cluster anyone probed" fallback: a build that names no
 * cluster gets no cluster's answer, rather than silently inheriting one from an
 * unrelated probe elsewhere in the process.
 */
export function resolveLabelPropagationGuardCapability(): LabelPropagationGuardCapability {
  if (isTruthyEnv(process.env[DISABLE_LABEL_GUARD_ENV])) {
    return {
      status: 'unavailable',
      reason: `disabled by ${DISABLE_LABEL_GUARD_ENV}`,
    };
  }

  const pinned = parseApiVersionEnv(process.env[LABEL_GUARD_API_VERSION_ENV]);
  if (pinned) {
    return { status: 'active', apiVersion: pinned };
  }

  const scoped = SCOPED_CAPABILITY.getStore();
  if (scoped) {
    return scoped;
  }

  if (assertedCapability) {
    return assertedCapability;
  }

  const clusterId = getCurrentDeployTarget();
  if (clusterId) {
    const resolved = getCachedClusterCapability(LABEL_GUARD_CAPABILITY, clusterId);
    if (resolved?.status === 'served') {
      const apiVersion = asGuardApiVersion(resolved.apiVersion);
      if (apiVersion) return { status: 'active', apiVersion };
    }
    if (resolved?.status === 'unserved' || resolved?.status === 'unknown') {
      // Both are `unavailable`, but the reason strings differ: `unserved` says
      // the cluster does not serve the kind, `unknown` says discovery failed.
      // Collapsing them here is what made the guard claim a 1.36 cluster was
      // too old whenever a probe hit an RBAC or network error.
      return { status: 'unavailable', reason: resolved.reason };
    }
  }

  return { status: 'unavailable', reason: LABEL_GUARD_UNRESOLVED_REASON };
}

/**
 * Run `build` with `capability` as the guard's answer, for exactly that build.
 *
 * This is the explicit half of the "probe, then build" flow: the cluster is
 * carried by the scope rather than by a module global, so two concurrent builds
 * for two clusters cannot see each other's answer.
 *
 * ```typescript
 * const capability = await probeLabelPropagationGuardSupport(kubeConfig);
 * const runtime = withLabelPropagationGuardCapability(capability, () =>
 *   typeKroRuntimeBootstrap()
 * );
 * ```
 */
export function withLabelPropagationGuardCapability<T>(
  capability: LabelPropagationGuardCapability,
  build: () => T
): T {
  return SCOPED_CAPABILITY.run(capability, build);
}

/**
 * Resolve the guard's capability against a cluster and **return** it.
 *
 * The result is the caller's to carry: pass it to
 * {@link withLabelPropagationGuardCapability}, or scope the build with
 * `runWithDeployTarget(clusterId, build)`. Probing does not make this cluster
 * ambiently current for anything else in the process — that fallback existed
 * and was removed, because a probe of cluster A followed by an untargeted build
 * for cluster B rendered A's answer into B's graph.
 *
 * The direct deployment path calls this before it re-executes the composition.
 * Callers who build a graph outside a deployment (an RGD render aimed at a
 * known cluster) can call it themselves and then build inside the scope.
 */
export async function probeLabelPropagationGuardSupport(
  kubeConfig: k8s.KubeConfig,
  options: { discovery?: ApiGroupDiscovery; refresh?: boolean } = {}
): Promise<LabelPropagationGuardCapability> {
  const capability = await discoverLabelPropagationGuardSupport(kubeConfig, options);
  if (capability.status === 'unavailable') {
    logger.warn(
      `KRO label-propagation guard unavailable: ${capability.reason}. ${LABEL_GUARD_ALTERNATIVES}`
    );
  }
  return capability;
}

/**
 * Probe a cluster. Populates the per-cluster capability cache but does not make
 * that cluster the ambient deploy target.
 */
export async function discoverLabelPropagationGuardSupport(
  kubeConfig: k8s.KubeConfig,
  options: { discovery?: ApiGroupDiscovery; refresh?: boolean } = {}
): Promise<LabelPropagationGuardCapability> {
  const clusterId = clusterIdentity(kubeConfig);
  if (!clusterId) {
    return {
      status: 'unavailable',
      reason: 'the kubeconfig names no current cluster, so no capability could be resolved',
    };
  }

  const resolution = await resolveClusterCapability(LABEL_GUARD_CAPABILITY, {
    clusterId,
    discovery: options.discovery ?? kubeConfigApiGroupDiscovery(kubeConfig),
    ...(options.refresh !== undefined && { refresh: options.refresh }),
  });

  if (resolution.status === 'served') {
    const apiVersion = asGuardApiVersion(resolution.apiVersion);
    if (apiVersion) return { status: 'active', apiVersion };
    return {
      status: 'unavailable',
      reason: `the cluster serves MutatingAdmissionPolicy at an unsupported group version (${resolution.apiVersion})`,
    };
  }

  // `unserved` and `unknown` are both unavailable, and both carry a reason that
  // says which: the cluster does not serve the kind, or discovery failed.
  return { status: 'unavailable', reason: resolution.reason };
}

/**
 * Reset every cached capability answer and the process-wide asserted override.
 * Test seam.
 *
 * Clears the whole per-cluster cache rather than one cluster's entry: a test
 * that has finished with one fake cluster has finished with all of them. The
 * scoped capability needs no reset — it ends with its scope.
 */
export function resetLabelGuardCapabilityCache(): void {
  assertedCapability = undefined;
  resetClusterCapabilityCache();
}

/** @deprecated Use {@link resetLabelGuardCapabilityCache}. */
export const resetLabelPropagationGuardCapabilityCache = resetLabelGuardCapabilityCache;

/**
 * Assert the capability process-wide, for an offline build that knows the
 * answer and for tests. Overrides cluster resolution; `undefined` clears it.
 *
 * Prefer {@link withLabelPropagationGuardCapability} where the assertion covers
 * one build: it cannot outlive that build, whereas this value persists until it
 * is cleared and is therefore visible to everything built afterwards.
 */
export function setLabelPropagationGuardCapability(
  capability: LabelPropagationGuardCapability | undefined
): void {
  assertedCapability = capability;
}
