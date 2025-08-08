/**
 * Types specific to the composition module
 *
 * This file contains type definitions that are used exclusively
 * by the composition functions for creating simplified Kubernetes resources.
 */

import type {
  V1Container,
  V1IngressRule,
  V1IngressTLS,
  V1LabelSelector,
  V1NetworkPolicyEgressRule,
  V1NetworkPolicyIngressRule,
  V1PersistentVolumeClaim,
  V1ResourceRequirements,
  V1ServicePort,
  V1Volume,
  V1VolumeMount,
} from '@kubernetes/client-node';

import type {
  V1DeploymentSpec,
  V1DeploymentStatus,
  V1ServiceSpec,
  V1ServiceStatus,
} from '../../factories/kubernetes/types.js';
import type { Enhanced } from '../types.js';

/**
 * Configuration for creating a simple deployment
 */
export interface SimpleDeploymentConfig {
  name: string;
  image: string;
  replicas?: number;
  namespace?: string;
  env?: Record<string, string>;
  ports?: V1Container['ports'];
  resources?: V1ResourceRequirements;
  id?: string;
  volumeMounts?: V1VolumeMount[];
  volumes?: V1Volume[];
}
/**
 * Configuration for creating a simple StatefulSet
 */
export interface SimpleStatefulSetConfig {
  name: string;
  image: string;
  serviceName: string;
  replicas?: number;
  namespace?: string;
  env?: Record<string, string>;
  ports?: V1Container['ports'];
  volumeClaimTemplates?: V1PersistentVolumeClaim[];
}

/**
 * Configuration for creating a simple Job
 */
export interface SimpleJobConfig {
  name: string;
  image: string;
  namespace?: string;
  command?: string[];
  completions?: number;
  backoffLimit?: number;
  restartPolicy?: 'OnFailure' | 'Never';
}

/**
 * Configuration for creating a simple CronJob
 */
export interface SimpleCronJobConfig {
  name: string;
  image: string;
  schedule: string;
  namespace?: string;
  command?: string[];
}

/**
 * Configuration for creating a simple ConfigMap
 */
export interface SimpleConfigMapConfig {
  name: string;
  namespace?: string;
  data: Record<string, string>;
  id?: string;
}

/**
 * Configuration for creating a simple Secret
 */
export interface SimpleSecretConfig {
  name: string;
  namespace?: string;
  stringData: Record<string, string>;
}

/**
 * Configuration for creating a simple PVC
 */
export interface SimplePvcConfig {
  name: string;
  namespace?: string;
  size: string;
  storageClass?: string;
  accessModes?: ('ReadWriteOnce' | 'ReadOnlyMany' | 'ReadWriteMany')[];
}

/**
 * Configuration for creating a simple HPA
 */
export interface SimpleHpaConfig {
  name: string;
  namespace?: string;
  target: { name: string; kind: string };
  minReplicas: number;
  maxReplicas: number;
  cpuUtilization?: number;
}

/**
 * Configuration for creating a simple Service
 */
export interface SimpleServiceConfig {
  name: string;
  selector: Record<string, string>;
  ports: V1ServicePort[];
  namespace?: string;
  type?: V1ServiceSpec['type'];
  id?: string;
}

/**
 * Configuration for creating a simple Ingress
 */
export interface SimpleIngressConfig {
  name: string;
  namespace?: string;
  ingressClassName?: string;
  rules?: V1IngressRule[];
  tls?: V1IngressTLS[];
  annotations?: Record<string, string>;
}

/**
 * Configuration for creating a simple NetworkPolicy
 */
export interface SimpleNetworkPolicyConfig {
  name: string;
  namespace?: string;
  podSelector: V1LabelSelector;
  policyTypes?: ('Ingress' | 'Egress')[];
  ingress?: V1NetworkPolicyIngressRule[];
  egress?: V1NetworkPolicyEgressRule[];
}

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
