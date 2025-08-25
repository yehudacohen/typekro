/**
 * Types specific to the composition module
 *
 * This file contains type definitions that are used exclusively
 * by the composition functions for creating simplified Kubernetes resources.
 */

import type {
  V1DeploymentSpec,
  V1DeploymentStatus,
  V1ServiceSpec,
  V1ServiceStatus,
} from '../../factories/kubernetes/types.js';
import type { Enhanced } from '../types.js';

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
