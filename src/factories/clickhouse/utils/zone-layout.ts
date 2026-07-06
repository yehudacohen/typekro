/**
 * Zone-pinned CHI layout compilation.
 *
 * WHY THIS EXISTS: the clickhouse-operator's own `podDistribution` supports
 * ONLY the `kubernetes.io/hostname` topologyKey (Altinity/clickhouse-operator
 * issue #772), so per-ZONE spreading cannot be expressed operator-natively.
 * On EKS this matters operationally: EBS volumes are ZONAL, so a replica pod
 * rescheduled into another AZ strands its PVC and the pod wedges Pending
 * (we hit exactly this in production). The fix the operator DOES support is a
 * per-replica `layout.replicas:` list where each replica's pod template pins
 * one zone via nodeAffinity on `topology.kubernetes.io/zone` — this module
 * compiles that layout deterministically.
 *
 * These helpers are pure (no resource construction) and unit-tested directly.
 */

import type { ChiClusterLayoutReplica, ChiPodTemplate } from '../types.js';

/** Standard Kubernetes zone topology label. */
export const ZONE_TOPOLOGY_KEY = 'topology.kubernetes.io/zone';

/**
 * Assign one zone per replica index, round-robin.
 *
 * When `replicaCount > zones.length`, zones repeat in order:
 * replicas=5, zones=[a,b,c] → [a, b, c, a, b].
 *
 * @param replicaCount - Number of replicas per shard
 * @param zones - Non-empty list of availability zones
 * @returns Zone for each replica index (length === replicaCount)
 */
export function assignZonesRoundRobin(
  replicaCount: number,
  zones: readonly string[]
): string[] {
  if (zones.length === 0) {
    throw new Error('assignZonesRoundRobin requires at least one zone');
  }
  if (!Number.isInteger(replicaCount) || replicaCount < 1) {
    throw new Error(
      `assignZonesRoundRobin requires a positive integer replica count, got ${replicaCount}`
    );
  }

  return Array.from({ length: replicaCount }, (_, index) => {
    const zone = zones[index % zones.length];
    if (zone === undefined) {
      throw new Error(`Zone assignment failed for replica ${index}`);
    }
    return zone;
  });
}

/**
 * Deterministic pod template name for a zone-pinned template.
 *
 * Zone names are DNS-safe label values, so embedding them keeps the template
 * name valid and self-describing (e.g. `clickhouse-us-east-2a`).
 */
export function zonePodTemplateName(baseName: string, zone: string): string {
  return `${baseName}-${zone}`;
}

/**
 * Explicit required nodeAffinity pinning a pod to one zone.
 *
 * Emitted as a plain PodSpec affinity (rather than the operator's
 * `podTemplate.zone` sugar) so the pinning is visible verbatim in the
 * rendered CHI and doesn't depend on operator-side template expansion.
 */
export function zoneNodeAffinity(zone: string): Record<string, unknown> {
  return {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              {
                key: ZONE_TOPOLOGY_KEY,
                operator: 'In',
                values: [zone],
              },
            ],
          },
        ],
      },
    },
  };
}

/** Result of compiling a zone-pinned per-replica cluster layout. */
export interface ZonePinnedLayout {
  /**
   * Replica-first layout entries — one per replica, each referencing its
   * zone's pod template. Emitted INSTEAD of `replicasCount` (the replica
   * list itself defines the replica count).
   */
  replicas: ChiClusterLayoutReplica[];
  /**
   * One pod template per DISTINCT assigned zone. Replicas sharing a zone
   * (replicaCount > zones.length) share the template.
   */
  podTemplates: ChiPodTemplate[];
}

/**
 * Compile the per-replica zone-pinned layout for a CHI cluster.
 *
 * @param options.replicaCount - Replicas per shard
 * @param options.zones - Availability zones to round-robin replicas across
 * @param options.podTemplateBaseName - Base name for generated pod templates
 * @param options.podSpec - Shared PodSpec (containers etc.); the zone
 *   nodeAffinity is merged in per template
 */
export function compileZonePinnedLayout(options: {
  replicaCount: number;
  zones: readonly string[];
  podTemplateBaseName: string;
  podSpec: Record<string, unknown>;
}): ZonePinnedLayout {
  const { replicaCount, zones, podTemplateBaseName, podSpec } = options;
  const assignments = assignZonesRoundRobin(replicaCount, zones);
  const distinctZones = [...new Set(assignments)];

  const podTemplates: ChiPodTemplate[] = distinctZones.map((zone) => ({
    name: zonePodTemplateName(podTemplateBaseName, zone),
    spec: {
      ...podSpec,
      affinity: zoneNodeAffinity(zone),
    },
  }));

  const replicas: ChiClusterLayoutReplica[] = assignments.map((zone) => ({
    templates: { podTemplate: zonePodTemplateName(podTemplateBaseName, zone) },
  }));

  return { replicas, podTemplates };
}
