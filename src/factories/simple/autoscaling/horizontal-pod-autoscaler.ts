/**
 * Simple HPA Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes HorizontalPodAutoscaler resources with sensible defaults.
 */

import type { Enhanced } from '../../../core/types.js';
import { horizontalPodAutoscaler } from '../../kubernetes/autoscaling/horizontal-pod-autoscaler.js';
import type { V2HpaSpec, V2HpaStatus } from '../../kubernetes/types.js';
import type { HpaConfig } from '../types.js';

/**
 * Creates a simple HPA with sensible defaults
 *
 * @param config - Configuration for the horizontal pod autoscaler
 * @returns Enhanced HorizontalPodAutoscaler resource
 */
export function Hpa(config: HpaConfig): Enhanced<V2HpaSpec, V2HpaStatus> {
  const metrics = [];

  if (config.cpuUtilization) {
    metrics.push({
      type: 'Resource',
      resource: {
        name: 'cpu',
        target: {
          type: 'Utilization',
          averageUtilization: config.cpuUtilization,
        },
      },
    });
  }

  return horizontalPodAutoscaler({
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: config.target.kind,
        name: config.target.name,
      },
      minReplicas: config.minReplicas,
      maxReplicas: config.maxReplicas,
      ...(metrics.length > 0 && { metrics }),
    },
  });
}
