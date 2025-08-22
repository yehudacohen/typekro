/**
 * Kubernetes Networking Resource Factories
 *
 * This module provides factory functions for Kubernetes networking resources
 * including Services, Ingresses, NetworkPolicies, Endpoints, etc.
 */

export { endpointSlice } from './endpoint-slice.js';
export { endpoints } from './endpoints.js';
export { ingress } from './ingress.js';
export { ingressClass } from './ingress-class.js';
export { networkPolicy } from './network-policy.js';
export { service } from './service.js';
