/**
 * Whether — and at which group version — the KRO label-propagation guard can be
 * installed on the target cluster.
 *
 * `MutatingAdmissionPolicy` is beta from Kubernetes 1.34
 * (`admissionregistration.k8s.io/v1beta1`) and GA from 1.36
 * (`admissionregistration.k8s.io/v1`), and the two group versions do not
 * overlap on a given server. A composition is built synchronously and has no
 * cluster connection, so the group version has to be resolved before the graph
 * is rendered rather than discovered while it is applied.
 */

import type * as k8s from '@kubernetes/client-node';
import type { MutatingAdmissionPolicyApiVersion } from '../../factories/kubernetes/admission/mutating-admission-policy.js';
import { MUTATING_ADMISSION_POLICY_API_VERSIONS } from '../../factories/kubernetes/admission/mutating-admission-policy.js';
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
 * rendering YAML or an RGD offline, where no probe can run.
 */
export const LABEL_GUARD_API_VERSION_ENV = 'TYPEKRO_LABEL_GUARD_API_VERSION';

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

let probedCapability: LabelPropagationGuardCapability | undefined;

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

/**
 * Resolve the guard's capability at build time.
 *
 * Order: break-glass env var, explicit group-version env var, a cached
 * {@link probeLabelPropagationGuardSupport} result, then the GA group version.
 * The last step is what makes the guard always-on: a bootstrap built with no
 * cluster knowledge still renders it.
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

  if (probedCapability) {
    return probedCapability;
  }

  return { status: 'active', apiVersion: 'admissionregistration.k8s.io/v1' };
}

/**
 * Ask a cluster which `MutatingAdmissionPolicy` group version it serves and
 * cache the answer for subsequent {@link resolveLabelPropagationGuardCapability}
 * calls in this process.
 *
 * Call this before building `typeKroRuntimeBootstrap()` when the target cluster
 * may predate 1.34; without it the bootstrap assumes the GA group version.
 */
export async function probeLabelPropagationGuardSupport(
  kubeConfig: k8s.KubeConfig
): Promise<LabelPropagationGuardCapability> {
  const capability = await discoverLabelPropagationGuardSupport(kubeConfig);
  probedCapability = capability;
  if (capability.status === 'unavailable') {
    logger.warn(
      `KRO label-propagation guard unavailable: ${capability.reason}. ${LABEL_GUARD_ALTERNATIVES}`
    );
  }
  return capability;
}

/** Probe without touching the cache. */
export async function discoverLabelPropagationGuardSupport(
  kubeConfig: k8s.KubeConfig
): Promise<LabelPropagationGuardCapability> {
  const { CustomObjectsApi } = await import('@kubernetes/client-node');
  const api = kubeConfig.makeApiClient(CustomObjectsApi);

  for (const apiVersion of MUTATING_ADMISSION_POLICY_API_VERSIONS) {
    const version = apiVersion.split('/')[1] ?? '';
    // Listing the collection is the definitive test. Asking discovery for the
    // group version is not enough: 1.32 and 1.33 serve
    // `admissionregistration.k8s.io/v1` for webhook configurations while not
    // serving MutatingAdmissionPolicy at all.
    try {
      await api.listClusterCustomObject({
        group: 'admissionregistration.k8s.io',
        version,
        plural: 'mutatingadmissionpolicies',
      });
      return { status: 'active', apiVersion };
    } catch (error) {
      logger.debug('MutatingAdmissionPolicy is not served at this group version', {
        apiVersion,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    status: 'unavailable',
    reason:
      'the cluster does not serve MutatingAdmissionPolicy ' +
      '(Kubernetes < 1.34, or the API group is disabled)',
  };
}

/** Reset the cached probe result. Test seam. */
export function resetLabelPropagationGuardCapabilityCache(): void {
  probedCapability = undefined;
}

/** Seed the cache directly. Test seam and an escape hatch for offline builds. */
export function setLabelPropagationGuardCapability(
  capability: LabelPropagationGuardCapability | undefined
): void {
  probedCapability = capability;
}
