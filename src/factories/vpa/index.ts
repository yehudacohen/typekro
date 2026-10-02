/**
 * Vertical Pod Autoscaler: a Flux bootstrap for the recommender, updater and
 * admission controller, plus a typed `VerticalPodAutoscaler`
 * (`autoscaling.k8s.io/v1`) factory.
 *
 * @see docs/api/vpa/index.md
 * @see https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler
 */
export * from './compositions/index.js';
export * from './constants.js';
export * from './resources/index.js';
export * from './types.js';
export * from './utils/index.js';
