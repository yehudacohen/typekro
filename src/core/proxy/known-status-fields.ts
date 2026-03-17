/**
 * Known status fields for standard Kubernetes resource kinds
 *
 * Used by the proxy's status property access trap to detect typos at runtime
 * when debug mode is enabled. Only fires for known K8s kinds — CRDs and
 * cross-composition references have unknown kinds, so no false positives.
 *
 * @see ROADMAP.md Phase 2.12
 */

import { levenshteinDistance } from '../../utils/string.js';

/**
 * Map of Kubernetes kind → known status field names.
 *
 * These are the fields defined by the standard Kubernetes API for each kind.
 * Only includes kinds with meaningful status fields; kinds like ConfigMap
 * and Secret that have no status are omitted (no warning needed for them).
 */
const KNOWN_STATUS_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Workloads
  Deployment: [
    'replicas',
    'readyReplicas',
    'availableReplicas',
    'updatedReplicas',
    'unavailableReplicas',
    'conditions',
    'observedGeneration',
    'collisionCount',
  ],
  StatefulSet: [
    'replicas',
    'readyReplicas',
    'currentReplicas',
    'updatedReplicas',
    'currentRevision',
    'updateRevision',
    'collisionCount',
    'conditions',
    'observedGeneration',
    'availableReplicas',
  ],
  DaemonSet: [
    'desiredNumberScheduled',
    'numberReady',
    'numberAvailable',
    'numberMisscheduled',
    'numberUnavailable',
    'updatedNumberScheduled',
    'currentNumberScheduled',
    'collisionCount',
    'conditions',
    'observedGeneration',
  ],
  ReplicaSet: [
    'replicas',
    'readyReplicas',
    'availableReplicas',
    'fullyLabeledReplicas',
    'conditions',
    'observedGeneration',
  ],
  Job: [
    'succeeded',
    'failed',
    'active',
    'completionTime',
    'startTime',
    'conditions',
    'completedIndexes',
    'ready',
    'uncountedTerminatedPods',
  ],
  CronJob: ['lastScheduleTime', 'lastSuccessfulTime', 'active'],

  // Core
  Pod: [
    'phase',
    'conditions',
    'containerStatuses',
    'initContainerStatuses',
    'ephemeralContainerStatuses',
    'hostIP',
    'podIP',
    'podIPs',
    'startTime',
    'message',
    'reason',
    'nominatedNodeName',
    'qosClass',
  ],
  Namespace: ['phase', 'conditions'],
  Node: [
    'conditions',
    'addresses',
    'allocatable',
    'capacity',
    'daemonEndpoints',
    'images',
    'nodeInfo',
    'phase',
    'volumesAttached',
    'volumesInUse',
  ],
  Service: ['loadBalancer', 'conditions'],

  // Networking
  Ingress: ['loadBalancer', 'observedGeneration'],

  // Storage
  PersistentVolumeClaim: [
    'phase',
    'accessModes',
    'capacity',
    'conditions',
    'allocatedResources',
    'allocatedResourceStatuses',
  ],
  PersistentVolume: ['phase', 'message', 'reason', 'lastPhaseTransitionTime'],

  // Autoscaling
  HorizontalPodAutoscaler: [
    'currentReplicas',
    'desiredReplicas',
    'currentMetrics',
    'conditions',
    'observedGeneration',
    'lastScaleTime',
  ],

  // Policy
  PodDisruptionBudget: [
    'currentHealthy',
    'desiredHealthy',
    'expectedPods',
    'disruptionsAllowed',
    'disruptedPods',
    'observedGeneration',
    'conditions',
  ],
};

/**
 * Maximum Levenshtein distance to consider a field name as a typo.
 * 2 catches common typos like readyReplica→readyReplicas, reedyReplicas→readyReplicas.
 */
const MAX_TYPO_DISTANCE = 2;

/**
 * Check if a status field access looks like a typo of a known field.
 *
 * Returns the closest known field name if the accessed property:
 * 1. Is NOT already a known field for the kind
 * 2. Has a Levenshtein distance ≤ MAX_TYPO_DISTANCE to a known field
 * 3. The kind is in the KNOWN_STATUS_FIELDS registry
 *
 * Returns `null` if no typo is detected (either valid field, unknown kind,
 * or no close match found).
 */
export function detectStatusFieldTypo(kind: string, accessedField: string): string | null {
  const knownFields = KNOWN_STATUS_FIELDS[kind];
  if (!knownFields) {
    // Unknown kind (CRD, cross-composition) — no false positives
    return null;
  }

  if (knownFields.length === 0) {
    // Kind has no status fields (ConfigMap, Secret) — no warning
    return null;
  }

  // Check if the field is known
  if (knownFields.includes(accessedField)) {
    return null;
  }

  // Find the closest known field
  let bestMatch: string | null = null;
  let bestDistance = MAX_TYPO_DISTANCE + 1;

  for (const knownField of knownFields) {
    const distance = levenshteinDistance(accessedField, knownField);
    if (distance <= MAX_TYPO_DISTANCE && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = knownField;
    }
  }

  return bestMatch;
}

/**
 * Get the list of known status fields for a kind.
 * Returns undefined for unknown kinds.
 */
export function getKnownStatusFields(kind: string): readonly string[] | undefined {
  return KNOWN_STATUS_FIELDS[kind];
}
