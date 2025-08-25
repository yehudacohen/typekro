/**
 * Simple Workload Factories
 * 
 * This module provides simplified factory functions for creating common
 * Kubernetes workload resources with sensible defaults.
 */

export { Deployment } from './deployment.js';
export { StatefulSet } from './stateful-set.js';
export { Job } from './job.js';
export { CronJob } from './cron-job.js';
export { DaemonSet } from './daemon-set.js';
