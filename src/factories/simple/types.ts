/**
 * Simple Factory Configuration Types
 *
 * This file contains type definitions for the simple factory functions.
 * These types provide clean, intuitive interfaces for creating common
 * Kubernetes resources with sensible defaults.
 */

import type {
  V1Container,
  V1EnvFromSource,
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

import type { V1ServiceSpec } from '../kubernetes/types.js';

/**
 * Configuration for creating a simple Deployment
 */
export interface DeploymentConfig {
  name: string;
  image: string;
  /** @default 1 */
  replicas?: number;
  namespace?: string;
  /** Container command override (replaces the image's ENTRYPOINT). */
  command?: string[];
  /** Container args (appended to command or the image's ENTRYPOINT). */
  args?: string[];
  /** Environment variables as key-value pairs. */
  env?: Record<string, string>;
  /**
   * Inject all keys from a Secret or ConfigMap as env vars.
   * Use `secretRef` or `configMapRef` per the Kubernetes spec.
   */
  envFrom?: V1EnvFromSource[];
  ports?: V1Container['ports'];
  resources?: V1ResourceRequirements;
  id?: string;
  volumeMounts?: V1VolumeMount[];
  volumes?: V1Volume[];
}

/**
 * Configuration for creating a simple StatefulSet
 */
export interface StatefulSetConfig {
  name: string;
  image: string;
  serviceName: string;
  /** @default 1 */
  replicas?: number;
  namespace?: string;
  env?: Record<string, string>;
  ports?: V1Container['ports'];
  volumeClaimTemplates?: V1PersistentVolumeClaim[];
  /** Custom resource ID for composition graph */
  id?: string;
}

/**
 * Configuration for creating a simple Job
 */
export interface JobConfig {
  name: string;
  image: string;
  namespace?: string;
  command?: string[];
  completions?: number;
  backoffLimit?: number;
  /** @default 'OnFailure' */
  restartPolicy?: 'OnFailure' | 'Never';
  /** Custom resource ID for composition graph */
  id?: string;
}

/**
 * Configuration for creating a simple CronJob
 */
export interface CronJobConfig {
  name: string;
  image: string;
  schedule: string;
  namespace?: string;
  command?: string[];
  /** Custom resource ID for composition graph */
  id?: string;
}

/**
 * Configuration for creating a simple Service
 */
export interface ServiceConfig {
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
export interface IngressConfig {
  name: string;
  namespace?: string;
  ingressClassName?: string;
  rules?: V1IngressRule[];
  tls?: V1IngressTLS[];
  annotations?: Record<string, string>;
  id?: string;
}

/**
 * Configuration for creating a simple NetworkPolicy
 */
export interface NetworkPolicyConfig {
  name: string;
  namespace?: string;
  podSelector: V1LabelSelector;
  policyTypes?: ('Ingress' | 'Egress')[];
  ingress?: V1NetworkPolicyIngressRule[];
  egress?: V1NetworkPolicyEgressRule[];
  id?: string;
}

/**
 * Configuration for creating a simple ConfigMap
 */
export interface ConfigMapConfig {
  name: string;
  namespace?: string;
  data: Record<string, string>;
  id?: string;
}

/**
 * Configuration for creating a simple Secret
 */
export interface SecretConfig {
  name: string;
  namespace?: string;
  stringData?: Record<string, string>;
  data?: Record<string, string>;
  id?: string; // Optional explicit resource ID
}

/**
 * Configuration for creating a simple PVC
 */
export interface PvcConfig {
  name: string;
  namespace?: string;
  size: string;
  storageClass?: string;
  /** @default ['ReadWriteOnce'] */
  accessModes?: ('ReadWriteOnce' | 'ReadOnlyMany' | 'ReadWriteMany')[];
  /** Optional resource ID for cross-resource references. Required when name uses schema references. */
  id?: string;
}

/**
 * Configuration for creating a simple HPA
 */
export interface HpaConfig {
  name: string;
  namespace?: string;
  target: { name: string; kind: string };
  minReplicas: number;
  maxReplicas: number;
  cpuUtilization?: number;
  /** Custom resource ID for composition graph */
  id?: string;
}

/**
 * Configuration for creating a simple DaemonSet
 */
export interface DaemonSetConfig {
  name: string;
  image: string;
  namespace?: string;
  env?: Record<string, string>;
  ports?: V1Container['ports'];
  resources?: V1ResourceRequirements;
  id?: string;
  volumeMounts?: V1VolumeMount[];
  volumes?: V1Volume[];
}

/**
 * Configuration for creating a simple PersistentVolume
 */
export interface PersistentVolumeConfig {
  name: string;
  size: string;
  storageClass?: string;
  /** @default ['ReadWriteOnce'] */
  accessModes?: ('ReadWriteOnce' | 'ReadOnlyMany' | 'ReadWriteMany')[];
  hostPath?: string;
  nfs?: {
    server: string;
    path: string;
  };
  /** @default 'Retain' */
  persistentVolumeReclaimPolicy?: 'Retain' | 'Recycle' | 'Delete';
  /** Custom resource ID for composition graph */
  id?: string;
}
