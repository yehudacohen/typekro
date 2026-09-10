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
 * 3. A capability resolved against the cluster this deployment targets. The
 *    direct deployment path resolves it before it re-executes the composition,
 *    so the graph is built at the version the API server actually serves.
 * 4. Otherwise — no pin and no cluster to ask — the guard is **skipped with a
 *    warning**. A composition built with no cluster knowledge does not get to
 *    guess a GA API that a 1.34 cluster would reject, taking the whole runtime
 *    bootstrap down with it.
 */

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
 * An explicitly asserted capability, used when a caller knows the answer and
 * there is no cluster to ask — an offline render, or a test. Deliberately
 * cluster-independent: the caller asserted it, so it is not a probe result and
 * is not subject to the per-cluster cache.
 */
let assertedCapability: LabelPropagationGuardCapability | undefined;

/**
 * The cluster {@link probeLabelPropagationGuardSupport} last ran against, used
 * as the deploy target when no deployment has published one. Lets the documented
 * "probe, then build" flow work at the top level of a script.
 */
let lastProbedClusterId: string | undefined;

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
 * Order: break-glass env var, explicit group-version env var, an explicitly
 * asserted capability, the capability resolved for the current deploy target,
 * then **skip**. There is no assumed group version at the end of the chain —
 * that is what makes the guard safe on a cluster below 1.36 rather than an
 * apply failure for the whole bootstrap.
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

  if (assertedCapability) {
    return assertedCapability;
  }

  const clusterId = getCurrentDeployTarget() ?? lastProbedClusterId;
  if (clusterId) {
    const resolved = getCachedClusterCapability(LABEL_GUARD_CAPABILITY, clusterId);
    if (resolved?.status === 'served') {
      const apiVersion = asGuardApiVersion(resolved.apiVersion);
      if (apiVersion) return { status: 'active', apiVersion };
    }
    if (resolved?.status === 'unserved') {
      return { status: 'unavailable', reason: resolved.reason };
    }
  }

  return { status: 'unavailable', reason: LABEL_GUARD_UNRESOLVED_REASON };
}

/**
 * Resolve the guard's capability against a cluster and cache it under that
 * cluster's identity, so a subsequent build targeting the same cluster renders
 * the guard at the served group version.
 *
 * The direct deployment path calls this before it re-executes the composition.
 * Callers who build a graph outside a deployment (an RGD render aimed at a
 * known cluster) can call it themselves and then build.
 */
export async function probeLabelPropagationGuardSupport(
  kubeConfig: k8s.KubeConfig,
  options: { discovery?: ApiGroupDiscovery; refresh?: boolean } = {}
): Promise<LabelPropagationGuardCapability> {
  const capability = await discoverLabelPropagationGuardSupport(kubeConfig, options);
  const clusterId = clusterIdentity(kubeConfig);
  if (clusterId) {
    lastProbedClusterId = clusterId;
  }
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

  return { status: 'unavailable', reason: resolution.reason };
}

/**
 * Reset every cached capability answer and the asserted override. Test seam.
 *
 * Clears the whole per-cluster cache rather than one cluster's entry: a test
 * that has finished with one fake cluster has finished with all of them.
 */
export function resetLabelGuardCapabilityCache(): void {
  assertedCapability = undefined;
  lastProbedClusterId = undefined;
  resetClusterCapabilityCache();
}

/** @deprecated Use {@link resetLabelGuardCapabilityCache}. */
export const resetLabelPropagationGuardCapabilityCache = resetLabelGuardCapabilityCache;

/**
 * Assert the capability directly, for an offline build that knows the answer
 * and for tests. Overrides cluster resolution; `undefined` clears the assertion.
 */
export function setLabelPropagationGuardCapability(
  capability: LabelPropagationGuardCapability | undefined
): void {
  assertedCapability = capability;
}
