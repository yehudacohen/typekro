/**
 * Resource Readiness Checking
 *
 * Handles checking if Kubernetes resources are ready after deployment
 */

import type * as k8s from '@kubernetes/client-node';
import type { DeploymentEvent, DeploymentOptions, ReadinessConfig } from '../types/deployment.js';
import { ResourceReadinessTimeoutError } from '../types/deployment.js';
import type {
  DeployedResource,
  DeploymentResource,
  DaemonSetStatus as K8sDaemonSetStatus,
  DeploymentSpec as K8sDeploymentSpec,
  DeploymentStatus as K8sDeploymentStatus,
  GenericResourceStatus as K8sGenericResourceStatus,
  HPAStatus as K8sHPAStatus,
  IngressStatus as K8sIngressStatus,
  JobSpec as K8sJobSpec,
  JobStatus as K8sJobStatus,
  PodStatus as K8sPodStatus,
  PVCStatus as K8sPVCStatus,
  ServiceSpec as K8sServiceSpec,
  ServiceStatus as K8sServiceStatus,
  StatefulSetSpec as K8sStatefulSetSpec,
  StatefulSetStatus as K8sStatefulSetStatus,
} from '../types.js';

export class ResourceReadinessChecker {
  constructor(private k8sApi: k8s.KubernetesObjectApi) {}

  /**
   * Wait for a resource to be ready using polling
   */
  async waitForResourceReady(
    deployedResource: DeployedResource,
    options: DeploymentOptions,
    emitEvent: (event: DeploymentEvent) => void
  ): Promise<void> {
    // Skip polling for resources that are immediately ready
    if (this.isImmediatelyReady(deployedResource.kind)) {
      emitEvent({
        type: 'progress',
        resourceId: deployedResource.id,
        message: `${deployedResource.kind}/${deployedResource.name} is ready after 0ms`,
        timestamp: new Date(),
      });
      return;
    }

    const readinessConfig = this.getReadinessConfig(options);
    await this.waitForResourceReadyWithPolling(
      deployedResource,
      options,
      readinessConfig,
      emitEvent
    );
  }

  /**
   * Check if a resource type is immediately ready when created
   */
  private isImmediatelyReady(kind: string): boolean {
    return ['ConfigMap', 'Secret', 'CronJob'].includes(kind);
  }

  /**
   * Wait for resource readiness using polling
   */
  private async waitForResourceReadyWithPolling(
    deployedResource: DeployedResource,
    _options: DeploymentOptions,
    readinessConfig: ReadinessConfig,
    emitEvent: (event: DeploymentEvent) => void
  ): Promise<void> {
    const startTime = Date.now();
    let attempt = 0;

    emitEvent({
      type: 'progress',
      resourceId: deployedResource.id,
      message: `Polling for ${deployedResource.kind}/${deployedResource.name} to be ready`,
      timestamp: new Date(),
    });

    while (Date.now() - startTime < readinessConfig.timeout) {
      attempt++;

      try {
        const { body: currentResource } = await this.k8sApi.read({
          apiVersion: deployedResource.manifest.apiVersion,
          kind: deployedResource.kind,
          metadata: {
            name: deployedResource.name,
            namespace: deployedResource.namespace,
          },
        });

        if (this.isResourceReady(currentResource)) {
          emitEvent({
            type: 'progress',
            resourceId: deployedResource.id,
            message: `${deployedResource.kind}/${deployedResource.name} is ready after ${Date.now() - startTime}ms`,
            timestamp: new Date(),
          });
          return;
        }

        // Emit progress update
        if (attempt % readinessConfig.progressInterval === 0) {
          emitEvent({
            type: 'progress',
            resourceId: deployedResource.id,
            message: `Still waiting for ${deployedResource.kind}/${deployedResource.name} (attempt ${attempt})`,
            timestamp: new Date(),
          });
        }

        // Wait before next check with exponential backoff
        const delay = Math.min(
          readinessConfig.initialDelay * readinessConfig.backoffMultiplier ** (attempt - 1),
          readinessConfig.maxDelay
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        // Log error but continue polling
        if (attempt % readinessConfig.progressInterval === 0) {
          emitEvent({
            type: 'progress',
            resourceId: deployedResource.id,
            message: `Error checking readiness for ${deployedResource.kind}/${deployedResource.name}: ${error}`,
            timestamp: new Date(),
          });
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, readinessConfig.errorRetryDelay));
      }
    }

    throw new ResourceReadinessTimeoutError(deployedResource, readinessConfig.timeout);
  }

  /**
   * Get readiness configuration with defaults
   */
  private getReadinessConfig(options: DeploymentOptions): ReadinessConfig {
    return {
      timeout: options.timeout || 300000, // 5 minutes default
      initialDelay: 1000, // 1 second
      maxDelay: 10000, // 10 seconds max
      backoffMultiplier: 1.5,
      errorRetryDelay: 2000, // 2 seconds on error
      progressInterval: 5, // Emit progress every 5 attempts
    };
  }

  /**
   * Type-safe field extraction from Kubernetes objects
   */
  private extractFieldFromK8sObject(obj: k8s.KubernetesObject, field: string): unknown {
    return (obj as Record<string, unknown>)[field];
  }

  /**
   * Type-safe status extraction
   */
  private getResourceStatus<T = K8sGenericResourceStatus>(
    resource: DeploymentResource
  ): T | undefined {
    if ('status' in resource && 'spec' in resource) {
      // Our KubernetesResource type - status is unknown, explicit typing needed
      return resource.status as T | undefined;
    }
    // k8s.KubernetesObject - dynamic field access needed
    return this.extractFieldFromK8sObject(resource, 'status') as T | undefined;
  }

  /**
   * Type-safe spec extraction
   */
  private getResourceSpec<T = unknown>(resource: DeploymentResource): T | undefined {
    if ('spec' in resource && 'status' in resource) {
      // Our KubernetesResource type - spec is unknown, explicit typing needed
      return resource.spec as T | undefined;
    }
    // k8s.KubernetesObject - dynamic field access needed
    return this.extractFieldFromK8sObject(resource, 'spec') as T | undefined;
  }

  /**
   * Check if a resource is ready based on its kind and status
   */
  isResourceReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus(resource);
    if (!status) {
      return false;
    }

    switch (resource.kind) {
      case 'Deployment':
        return this.isDeploymentReady(resource);

      case 'Service':
        return this.isServiceReady(resource);

      case 'Pod':
        return this.isPodReady(resource);

      case 'Job':
        return this.isJobReady(resource);

      case 'StatefulSet':
        return this.isStatefulSetReady(resource);

      case 'DaemonSet':
        return this.isDaemonSetReady(resource);

      case 'ReplicaSet':
        return this.isReplicaSetReady(resource);

      case 'ConfigMap':
      case 'Secret':
        return true; // ConfigMaps and Secrets are ready when created

      case 'PersistentVolumeClaim':
        return this.isPVCReady(resource);

      case 'Ingress':
        return this.isIngressReady(resource);

      case 'HorizontalPodAutoscaler':
        return this.isHPAReady(resource);

      case 'CronJob':
        return true; // CronJobs are ready when created

      default:
        // For unknown resource types, check for common readiness patterns
        return this.isGenericResourceReady(resource);
    }
  }

  /**
   * Check if a Deployment is ready
   */
  private isDeploymentReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sDeploymentStatus>(resource);
    const spec = this.getResourceSpec<K8sDeploymentSpec>(resource);

    if (!status) return false;

    // Check if deployment has the expected number of replicas
    const expectedReplicas = spec?.replicas || status.replicas || 1;
    const readyReplicas = status.readyReplicas || 0;

    // Basic check: ready replicas match expected replicas
    if (readyReplicas !== expectedReplicas) {
      return false;
    }

    // Additional checks if available
    if (status.availableReplicas !== undefined) {
      const availableReplicas = status.availableReplicas;
      if (availableReplicas !== expectedReplicas) {
        return false;
      }
    }

    // Check for unavailable replicas
    if (status.unavailableReplicas && status.unavailableReplicas > 0) {
      return false;
    }

    return true;
  }

  /**
   * Check if a Service is ready
   */
  private isServiceReady(resource: DeploymentResource): boolean {
    const spec = this.getResourceSpec<K8sServiceSpec>(resource);

    // LoadBalancer services need an external IP
    if (spec?.type === 'LoadBalancer') {
      const status = this.getResourceStatus<K8sServiceStatus>(resource);
      return !!(status?.loadBalancer?.ingress && status.loadBalancer.ingress.length > 0);
    }

    // Other service types are ready when created
    return true;
  }

  /**
   * Check if a Pod is ready
   */
  private isPodReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sPodStatus>(resource);

    if (!status) return false;

    // Pod must be in Running phase
    if (status.phase !== 'Running') {
      return false;
    }

    // Check container readiness
    const containerStatuses = status.containerStatuses || [];
    return containerStatuses.every((container) => container.ready === true);
  }

  /**
   * Check if a Job is ready
   */
  private isJobReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sJobStatus>(resource);
    const spec = this.getResourceSpec<K8sJobSpec>(resource);

    const completions = spec?.completions || 1;
    const succeeded = status?.succeeded || 0;

    return succeeded >= completions;
  }

  /**
   * Check if a StatefulSet is ready
   */
  private isStatefulSetReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sStatefulSetStatus>(resource);
    const spec = this.getResourceSpec<K8sStatefulSetSpec>(resource);

    const expectedReplicas = spec?.replicas || 1;
    const readyReplicas = status?.readyReplicas || 0;

    return readyReplicas === expectedReplicas;
  }

  /**
   * Check if a DaemonSet is ready
   */
  private isDaemonSetReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sDaemonSetStatus>(resource);

    const desiredNumberScheduled = status?.desiredNumberScheduled || 0;
    const numberReady = status?.numberReady || 0;

    return numberReady === desiredNumberScheduled && desiredNumberScheduled > 0;
  }

  /**
   * Check if a ReplicaSet is ready
   */
  private isReplicaSetReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sStatefulSetStatus>(resource);
    const spec = this.getResourceSpec<{ replicas?: number }>(resource);

    const expectedReplicas = spec?.replicas || 1;
    const readyReplicas = status?.readyReplicas || 0;

    return readyReplicas === expectedReplicas;
  }

  /**
   * Check if a PersistentVolumeClaim is ready
   */
  private isPVCReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sPVCStatus>(resource);
    return status?.phase === 'Bound';
  }

  /**
   * Check if an Ingress is ready
   */
  private isIngressReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sIngressStatus>(resource);

    // Ingress is ready when it has load balancer ingress
    return !!(status?.loadBalancer?.ingress && status.loadBalancer.ingress.length > 0);
  }

  /**
   * Check if a HorizontalPodAutoscaler is ready
   */
  private isHPAReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sHPAStatus>(resource);

    // HPA is ready when it can read metrics
    return status?.currentReplicas !== undefined;
  }

  /**
   * Generic readiness check for unknown resource types
   */
  private isGenericResourceReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sGenericResourceStatus>(resource);

    // Check for common readiness indicators
    if (status?.conditions) {
      const readyCondition = status.conditions.find((c) => c.type === 'Ready');
      if (readyCondition) {
        return readyCondition.status === 'True';
      }

      // Check for Available condition
      const availableCondition = status.conditions.find((c) => c.type === 'Available');
      if (availableCondition) {
        return availableCondition.status === 'True';
      }
    }

    // If no specific conditions, assume ready if status exists
    return true;
  }
}
