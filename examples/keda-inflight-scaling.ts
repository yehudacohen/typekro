/**
 * KEDA: scale an API on in-flight requests per pod, with a latency backstop.
 *
 *  1. `kedaBootstrap` installs the operator, metrics API server and webhooks.
 *  2. The `checkout` Deployment leaves `spec.replicas` unset, so a redeploy
 *     never resets the count KEDA's HPA chose. It has no HPA of its own: KEDA
 *     creates and owns one.
 *  3. A `ScaledObject` with two Prometheus triggers:
 *     - `inflight` (AverageValue): the HPA divides the total by the replica
 *       count, so the target is 20 in-flight requests per pod;
 *     - `latency` (Value): p95 latency against 300ms, not divided by pods.
 *     The HPA computes a replica count for each trigger and takes the
 *     largest, so latency adds pods when requests are slow even while the
 *     in-flight count looks fine.
 *  4. `checkoutScalingWithFormula` is the same intent as one composite metric
 *     through `scalingModifiers`.
 *
 * Run: `bun run build:examples` typechecks this file.
 */

import type { KubeConfig } from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../src/core/composition/imperative.js';
import { kedaBootstrap } from '../src/factories/keda/compositions/keda-bootstrap.js';
import { kedaActive, kedaReady } from '../src/factories/keda/resources/readiness.js';
import { scaledObject } from '../src/factories/keda/resources/scaled-object.js';
import type { KedaTrigger } from '../src/factories/keda/types.js';
import { deployment } from '../src/factories/kubernetes/workloads/deployment.js';

const PROMETHEUS = 'http://prometheus-operated.monitoring.svc:9090';

/** Total requests in flight across all checkout pods. */
const inflightRequests: KedaTrigger = {
  type: 'prometheus',
  name: 'inflight',
  metadata: {
    serverAddress: PROMETHEUS,
    query: 'sum(http_server_active_requests{service="checkout"})',
    // AverageValue (the default): 20 per pod.
    threshold: '20',
    // Below 1 in-flight request the trigger counts as inactive.
    activationThreshold: '1',
  },
};

/** p95 latency in seconds over the last two minutes. */
const p95Latency: KedaTrigger = {
  type: 'prometheus',
  name: 'latency',
  metricType: 'Value',
  metadata: {
    serverAddress: PROMETHEUS,
    query:
      'histogram_quantile(0.95, sum(rate(http_server_request_duration_seconds_bucket{service="checkout"}[2m])) by (le))',
    threshold: '0.3',
  },
};

/** The checkout API and its ScaledObject. */
export const checkoutScaling = kubernetesComposition(
  {
    name: 'checkout-scaling',
    kind: 'CheckoutScaling',
    spec: type({ image: 'string', maxReplicas: 'number.integer' }),
    status: type({ ready: 'boolean', active: 'boolean', hpa: 'string' }),
  },
  (spec) => {
    const checkout = deployment({
      metadata: { name: 'checkout', labels: { app: 'checkout' } },
      spec: {
        selector: { matchLabels: { app: 'checkout' } },
        template: {
          metadata: { labels: { app: 'checkout' } },
          spec: {
            containers: [
              {
                name: 'checkout',
                image: spec.image,
                ports: [{ containerPort: 8080 }],
                resources: { requests: { cpu: '250m', memory: '256Mi' } },
              },
            ],
          },
        },
      },
      id: 'checkout',
    });

    const scaler = scaledObject({
      name: 'checkout',
      spec: {
        // The resource itself, so the ScaledObject is applied after it: KEDA's
        // webhook rejects one whose target does not exist yet.
        scaleTargetRef: checkout,
        minReplicaCount: 2,
        maxReplicaCount: spec.maxReplicas,
        pollingInterval: 15,
        // If Prometheus is unreachable for 3 polls, hold 6 replicas.
        fallback: { failureThreshold: 3, replicas: 6 },
        advanced: {
          horizontalPodAutoscalerConfig: {
            behavior: {
              // Scale up fast, scale down slowly.
              scaleUp: { stabilizationWindowSeconds: 0 },
              scaleDown: {
                stabilizationWindowSeconds: 300,
                policies: [{ type: 'Percent', value: 25, periodSeconds: 60 }],
              },
            },
          },
        },
        triggers: [inflightRequests, p95Latency],
      },
      id: 'checkoutScaler',
    });

    return {
      ready: kedaReady(scaler),
      active: kedaActive(scaler),
      hpa: scaler.status.hpaName,
    };
  }
);

/**
 * The same with one composite metric: in-flight requests per pod, scaled up
 * by half while p95 latency is above 300ms. The formula sees each trigger's
 * raw value (`inflight` is the total, not per pod); the `target` applies to
 * the result as an AverageValue.
 */
export const checkoutScalingWithFormula = kubernetesComposition(
  {
    name: 'checkout-scaling-formula',
    kind: 'CheckoutScalingFormula',
    spec: type({ maxReplicas: 'number.integer' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const scaler = scaledObject({
      name: 'checkout',
      spec: {
        scaleTargetRef: { name: 'checkout' },
        minReplicaCount: 2,
        maxReplicaCount: spec.maxReplicas,
        advanced: {
          scalingModifiers: {
            formula: 'latency > 0.3 ? inflight * 1.5 : inflight',
            target: '20',
            metricType: 'AverageValue',
          },
        },
        triggers: [inflightRequests, p95Latency],
      },
      id: 'checkoutScaler',
    });
    return { ready: kedaReady(scaler) };
  }
);

/** Install KEDA, then the API. */
export async function deployCheckout(kubeConfig: KubeConfig) {
  await kedaBootstrap
    .factory('direct', { namespace: 'flux-system', waitForReady: true, kubeConfig })
    .deploy({
      name: 'keda',
      operator: { replicas: 2, podDisruptionBudget: { maxUnavailable: 1 } },
      metricsServer: { replicas: 2, podDisruptionBudget: { maxUnavailable: 1 } },
    });

  return checkoutScaling
    .factory('direct', { namespace: 'shop', waitForReady: true, kubeConfig })
    .deploy({ image: 'registry.example.com/checkout:1.8.2', maxReplicas: 30 });
}
