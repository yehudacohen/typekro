/**
 * Vertical Pod Autoscaler: recommend first, then let it act.
 *
 *  1. `vpaBootstrap` installs only the recommender. With no updater and no
 *     admission controller nothing is evicted or rewritten; VPAs only record
 *     recommendations.
 *  2. An `api` Deployment that already scales horizontally on CPU gets a
 *     recommend-only VPA (`vpaRecommendOnly`). Off mode is the safe way to
 *     combine a VPA with an HPA on the same resource.
 *  3. A `worker` Deployment with no HPA gets a VPA that applies
 *     recommendations in place, falling back to eviction, within bounds.
 *
 * Run: `bun run build:examples` typechecks this file.
 */

import type { KubeConfig } from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../src/core/composition/imperative.js';
import { horizontalPodAutoscaler } from '../src/factories/kubernetes/autoscaling/horizontal-pod-autoscaler.js';
import { Deployment } from '../src/factories/simple/workloads/deployment.js';
import { vpaBootstrap } from '../src/factories/vpa/compositions/vpa-bootstrap.js';
import { vpaRecommendationProvided } from '../src/factories/vpa/resources/readiness.js';
import {
  verticalPodAutoscaler,
  vpaRecommendOnly,
} from '../src/factories/vpa/resources/vertical-pod-autoscaler.js';

/** Two workloads and their autoscalers. */
export const rightsizedApp = kubernetesComposition(
  {
    name: 'rightsized-app',
    kind: 'RightsizedApp',
    spec: type({ image: 'string', workerMaxMemory: 'string' }),
    status: type({ recommended: 'boolean' }),
  },
  (spec) => {
    const api = Deployment({
      name: 'api',
      image: spec.image,
      replicas: 2,
      resources: { requests: { cpu: '250m', memory: '256Mi' } },
      id: 'api',
    });
    horizontalPodAutoscaler({
      metadata: { name: 'api' },
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api' },
        minReplicas: 2,
        maxReplicas: 10,
        metrics: [
          {
            type: 'Resource',
            resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } },
          },
        ],
      },
      id: 'apiHpa',
    });
    // Recommendations only: the HPA keeps sole control of the replica count.
    const apiVpa = vpaRecommendOnly(api, { id: 'apiVpa' });

    Deployment({
      name: 'worker',
      image: spec.image,
      replicas: 3,
      resources: { requests: { cpu: '500m', memory: '512Mi' } },
      id: 'worker',
    });
    const workerVpa = verticalPodAutoscaler({
      name: 'worker',
      spec: {
        targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'worker' },
        // Resize running pods without a restart where the node allows it.
        // Needs the updater and the admission controller installed.
        updatePolicy: { updateMode: 'InPlaceOrRecreate', minReplicas: 2 },
        resourcePolicy: {
          containerPolicies: [
            {
              containerName: '*',
              minAllowed: { cpu: '100m', memory: '128Mi' },
              maxAllowed: { cpu: '2', memory: spec.workerMaxMemory },
              controlledValues: 'RequestsOnly',
            },
          ],
        },
      },
      id: 'workerVpa',
    });

    return { recommended: vpaRecommendationProvided(apiVpa, workerVpa) };
  }
);

/** Install the recommender only, then the app. */
export async function deployRecommendOnly(kubeConfig: KubeConfig) {
  await vpaBootstrap
    .factory('direct', { namespace: 'flux-system', waitForReady: true, kubeConfig })
    .deploy({
      name: 'vpa',
      recommender: {
        resources: { requests: { cpu: '100m', memory: '600Mi' }, limits: { memory: '1Gi' } },
        // Recommend for the 95th percentile of CPU instead of the 90th.
        targetCpuPercentile: 0.95,
      },
      updater: { enabled: false },
      admissionController: { enabled: false },
    });

  // `waitForReady: false`: a VPA reports `RecommendationProvided` only after the
  // recommender has watched the pods for a while.
  return rightsizedApp
    .factory('direct', { namespace: 'default', waitForReady: false, kubeConfig })
    .deploy({ image: 'nginx:1.27', workerMaxMemory: '2Gi' });
}
