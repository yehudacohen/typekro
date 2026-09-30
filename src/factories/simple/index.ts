/**
 * Simple Factory Namespace
 *
 * This module provides a clean, organized namespace for simple factory functions
 * that create common Kubernetes resources with sensible defaults.
 *
 * Usage patterns:
 * - import { simple } from 'typekro'
 * - import { Deployment } from 'typekro/simple'
 * - import * as simple from 'typekro/simple'
 */

export { Hpa } from './autoscaling/index.js';
export { ConfigMap, Secret } from './config/index.js';
export { HelmChart } from './helm/index.js';
export { Ingress, NetworkPolicy, Service } from './networking/index.js';
export { PersistentVolume, Pvc } from './storage/index.js';
// Export types
export type * from './types.js';
// Export all individual functions for direct imports
export { CronJob, DaemonSet, Deployment, Job, StatefulSet } from './workloads/index.js';
export { YamlFile } from './yaml/index.js';

import { Hpa } from './autoscaling/index.js';
import { ConfigMap, Secret } from './config/index.js';
import { HelmChart } from './helm/index.js';
import { Ingress, NetworkPolicy, Service } from './networking/index.js';
import { PersistentVolume, Pvc } from './storage/index.js';
// Import all functions to create the simple namespace object
import { CronJob, DaemonSet, Deployment, Job, StatefulSet } from './workloads/index.js';
import { YamlFile } from './yaml/index.js';

/**
 * Simple namespace object containing all simple factory functions
 *
 * Usage: import { simple } from 'typekro'
 * Then: simple.Deployment({ name: 'app', image: 'nginx' })
 */
export const simple: {
  readonly Deployment: typeof Deployment;
  readonly StatefulSet: typeof StatefulSet;
  readonly Job: typeof Job;
  readonly CronJob: typeof CronJob;
  readonly DaemonSet: typeof DaemonSet;
  readonly Service: typeof Service;
  readonly Ingress: typeof Ingress;
  readonly NetworkPolicy: typeof NetworkPolicy;
  readonly ConfigMap: typeof ConfigMap;
  readonly Secret: typeof Secret;
  readonly Pvc: typeof Pvc;
  readonly PersistentVolume: typeof PersistentVolume;
  readonly Hpa: typeof Hpa;
  readonly HelmChart: typeof HelmChart;
  readonly YamlFile: typeof YamlFile;
} = {
  // Workloads
  Deployment,
  StatefulSet,
  Job,
  CronJob,
  DaemonSet,

  // Networking
  Service,
  Ingress,
  NetworkPolicy,

  // Config
  ConfigMap,
  Secret,

  // Storage
  Pvc,
  PersistentVolume,

  // Autoscaling
  Hpa,

  // Helm
  HelmChart,

  // YAML
  YamlFile,
} as const;
