/**
 * Web Service Composition
 *
 * Convenience factory that creates a paired Kubernetes Deployment + Service.
 * Moved from core/composition/ to factories/ to fix the core→factories
 * boundary violation — this is a factory-layer concern.
 */

import type { Enhanced } from '../../../core/types.js';
import type {
  V1DeploymentSpec,
  V1DeploymentStatus,
  V1ServiceSpec,
  V1ServiceStatus,
} from '../../kubernetes/types.js';
import { simple } from '../index.js';

/**
 * Configuration for creating a web service (deployment + service)
 */
export interface WebServiceConfig {
  name: string;
  image: string;
  namespace?: string;
  replicas?: number;
  port: number;
  targetPort?: number;
}

/**
 * Result of creating a web service component
 */
export interface WebServiceComponent {
  deployment: Enhanced<V1DeploymentSpec, V1DeploymentStatus>;
  service: Enhanced<V1ServiceSpec, V1ServiceStatus>;
}

/**
 * Creates a web service consisting of a Deployment and a Service.
 *
 * This is a convenience composition that wraps `simple.Deployment()` and
 * `simple.Service()` with sensible defaults for common web application patterns.
 */
export function createWebService(config: WebServiceConfig): WebServiceComponent {
  const labels = { app: config.name };

  const deployment = simple.Deployment({
    name: config.name,
    image: config.image,
    ...(config.namespace && { namespace: config.namespace }),
    ...(config.replicas && { replicas: config.replicas }),
    ports: [{ containerPort: config.targetPort ?? config.port }],
  });

  const service = simple.Service({
    name: config.name,
    selector: labels,
    ports: [{ port: config.port, targetPort: config.targetPort ?? config.port }],
    ...(config.namespace && { namespace: config.namespace }),
  });

  return { deployment, service };
}
