/**
 * Cilium Gateway API and Ingress CRD Factory Functions
 *
 * This module provides factory functions for Cilium networking resources:
 * - CiliumIngressClass
 * - CiliumIngress
 * - CiliumGatewayClassConfig (TODO)
 * - CiliumEnvoyConfig (TODO)
 * - CiliumClusterwideEnvoyConfig (TODO)
 */

import { createResource } from '../../shared.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';

/**
 * CiliumIngressClass configuration options
 */
export interface CiliumIngressClassConfig {
  name: string;
  default?: boolean;
  id?: string;
}

/**
 * CiliumIngress configuration options
 */
export interface CiliumIngressConfig {
  name: string;
  namespace?: string;
  ingressClassName?: string;
  annotations?: Record<string, string>;

  // High-level simplified configuration
  host?: string;
  serviceName?: string;
  servicePort?: number | string;
  tlsSecretName?: string;
  path?: string;
  pathType?: 'Prefix' | 'Exact' | 'ImplementationSpecific';

  // Low-level detailed configuration
  rules?: Array<{
    host?: string;
    http?: {
      paths: Array<{
        path?: string;
        pathType?: 'Prefix' | 'Exact' | 'ImplementationSpecific';
        backend: {
          service: {
            name: string;
            port: {
              number?: number;
              name?: string;
            };
          };
        };
      }>;
    };
  }>;
  tls?: Array<{
    hosts?: string[];
    secretName?: string;
  }>;
  id?: string;
}

/**
 * Creates a CiliumIngressClass resource
 *
 * IngressClass is a standard Kubernetes resource (networking.k8s.io/v1)
 * used to specify which Ingress controller should handle the Ingress resources.
 */
export function CiliumIngressClass(config: CiliumIngressClassConfig): KubernetesResource {
  const metadata: { name: string; annotations?: Record<string, string> } = {
    name: config.name,
  };

  if (config.default) {
    metadata.annotations = {
      'ingressclass.kubernetes.io/is-default-class': 'true',
    };
  }

  return createResource({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'IngressClass',
    metadata,
    spec: {
      controller: 'cilium.io/ingress-controller',
    },
    id: config.id || `ciliumIngressClass-${config.name}`,
  }).withReadinessEvaluator(() => ({
    ready: true,
    message: 'IngressClass is ready when created (configuration resource)',
  }));
}

/**
 * Creates a CiliumIngress (standard Kubernetes Ingress) resource
 *
 * Ingress is a standard Kubernetes resource (networking.k8s.io/v1)
 * that provides HTTP/HTTPS routing to services.
 */
export function CiliumIngress(config: CiliumIngressConfig): KubernetesResource {
  const metadata: { name: string; namespace?: string; annotations?: Record<string, string> } = {
    name: config.name,
  };

  if (config.namespace) {
    metadata.namespace = config.namespace;
  }

  if (config.annotations) {
    metadata.annotations = config.annotations;
  }

  // Build rules from high-level config if provided, otherwise use explicit rules
  let rules = config.rules;
  if (!rules && config.host && config.serviceName && config.servicePort) {
    const portConfig =
      typeof config.servicePort === 'number'
        ? { number: config.servicePort }
        : { name: config.servicePort };

    rules = [
      {
        host: config.host,
        http: {
          paths: [
            {
              path: config.path || '/',
              pathType: config.pathType || 'Prefix',
              backend: {
                service: {
                  name: config.serviceName,
                  port: portConfig,
                },
              },
            },
          ],
        },
      },
    ];
  }

  // Build TLS from high-level config if provided, otherwise use explicit tls
  let tls = config.tls;
  if (!tls && config.tlsSecretName && config.host) {
    tls = [
      {
        hosts: [config.host],
        secretName: config.tlsSecretName,
      },
    ];
  }

  return createResource({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata,
    spec: {
      ingressClassName: config.ingressClassName,
      rules,
      tls,
    },
    id: config.id || `ciliumIngress-${config.name}`,
  }).withReadinessEvaluator((resource) => {
    // Ingress is ready when it has at least one load balancer IP/hostname
    const status = (resource as any).status;
    const hasLoadBalancer = status?.loadBalancer?.ingress?.length > 0;

    return {
      ready: hasLoadBalancer,
      message: hasLoadBalancer
        ? 'Ingress has load balancer endpoint'
        : 'Waiting for load balancer endpoint',
    };
  });
}

// TODO: Implement in future tasks
// - CiliumGatewayClassConfig
// - CiliumEnvoyConfig
// - CiliumClusterwideEnvoyConfig
