/**
 * Kro Deployment Engine
 * 
 * This module provides deployment capabilities for Kro-based resources,
 * including ResourceGraphDefinitions and custom resource instances.
 */

import type { Enhanced } from '../../core/types/kubernetes.js';
import type { DeploymentOptions } from '../../core/types/deployment.js';
import { KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';

/**
 * Engine for deploying resources through the Kro controller
 */
export class KroDeploymentEngine {
  private kubeConfig: KubeConfig;
  private k8sApi: KubernetesObjectApi;

  constructor(kubeConfig?: KubeConfig) {
    this.kubeConfig = kubeConfig || new KubeConfig();
    if (!kubeConfig) {
      this.kubeConfig.loadFromDefault();
    }
    this.k8sApi = KubernetesObjectApi.makeApiClient(this.kubeConfig);
  }

  /**
   * Deploy a TypeKro Enhanced resource using Kro controller
   */
  async deployResource<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<T> {
    const namespace = options.namespace || 'default';
    
    try {
      // Apply the resource to the cluster
      await this.k8sApi.create({
        ...resource,
        metadata: {
          ...resource.metadata,
          namespace,
        },
      });
      
      // Wait for readiness if requested
      if (options.waitForReady) {
        await this.waitForResourceReady(resource, namespace, options.timeout || 300000);
      }
      
      // Return the resource (in a real implementation, this would have updated status)
      return resource;
    } catch (error: any) {
      if (error.statusCode === 409) {
        // Resource already exists, update it
        await this.k8sApi.patch({
          ...resource,
          metadata: {
            ...resource.metadata,
            namespace,
          },
        });
        
        if (options.waitForReady) {
          await this.waitForResourceReady(resource, namespace, options.timeout || 300000);
        }
        
        return resource;
      } else {
        throw new Error(`Failed to deploy ${resource.kind}/${resource.metadata?.name}: ${error.message}`);
      }
    }
  }

  /**
   * Delete a TypeKro Enhanced resource
   */
  async deleteResource<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<void> {
    const namespace = options.namespace || 'default';
    
    try {
      await this.k8sApi.delete({
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        metadata: {
          name: resource.metadata?.name,
          namespace,
        },
      } as any);
    } catch (error: any) {
      if (error.statusCode !== 404) {
        throw new Error(`Failed to delete ${resource.kind}/${resource.metadata?.name}: ${error.message}`);
      }
      // Resource already deleted, ignore 404
    }
  }

  /**
   * Deploy a ResourceGraphDefinition to the cluster
   */
  async deployResourceGraphDefinition(
    rgdManifest: any,
    namespace: string
  ): Promise<any> {
    try {
      const rgd = {
        ...rgdManifest,
        metadata: {
          ...rgdManifest.metadata,
          namespace,
        },
      };
      
      await this.k8sApi.create(rgd);
      
      // Wait for RGD to be ready
      await this.waitForRGDReady(rgd.metadata.name, namespace);
      
      return rgd;
    } catch (error: any) {
      if (error.statusCode === 409) {
        // RGD already exists, that's fine
        return rgdManifest;
      } else {
        throw new Error(`Failed to deploy ResourceGraphDefinition: ${error.message}`);
      }
    }
  }

  /**
   * Deploy a custom resource instance
   */
  async deployCustomResourceInstance(
    instanceManifest: any,
    namespace: string
  ): Promise<any> {
    try {
      const instance = {
        ...instanceManifest,
        metadata: {
          ...instanceManifest.metadata,
          namespace,
        },
      };
      
      await this.k8sApi.create(instance);
      
      // Wait for instance to be ready
      await this.waitForInstanceReady(
        instance.metadata.name,
        instance.apiVersion,
        instance.kind,
        namespace
      );
      
      return instance;
    } catch (error: any) {
      if (error.statusCode === 409) {
        // Instance already exists, update it
        const instance = {
          ...instanceManifest,
          metadata: {
            ...instanceManifest.metadata,
            namespace,
          },
        };
        
        await this.k8sApi.patch(instance);
        
        await this.waitForInstanceReady(
          instance.metadata.name,
          instance.apiVersion,
          instance.kind,
          namespace
        );
        
        return instance;
      } else {
        throw new Error(`Failed to deploy custom resource instance: ${error.message}`);
      }
    }
  }

  /**
   * Wait for a resource to be ready
   */
  private async waitForResourceReady<T extends Enhanced<any, any>>(
    resource: T,
    namespace: string,
    timeout: number
  ): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const response = await this.k8sApi.read({
          apiVersion: resource.apiVersion,
          kind: resource.kind,
          metadata: {
            name: resource.metadata?.name,
            namespace,
          },
        } as any);
        
        const liveResource = response.body as any;
        
        // Check if resource has a ready status
        if (liveResource.status?.ready === true || 
            liveResource.status?.phase === 'ready' ||
            liveResource.status?.conditions?.some((c: any) => 
              c.type === 'Ready' && c.status === 'True'
            )) {
          return;
        }
        
        // Check for failure conditions
        if (liveResource.status?.phase === 'failed' ||
            liveResource.status?.conditions?.some((c: any) => 
              c.type === 'Failed' && c.status === 'True'
            )) {
          throw new Error(`Resource ${resource.kind}/${resource.metadata?.name} failed to deploy`);
        }
      } catch (error: any) {
        if (error.statusCode !== 404) {
          throw error;
        }
        // Resource not found yet, continue waiting
      }
      
      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`Timeout waiting for ${resource.kind}/${resource.metadata?.name} to be ready after ${timeout}ms`);
  }

  /**
   * Wait for ResourceGraphDefinition to be ready
   */
  private async waitForRGDReady(name: string, namespace: string): Promise<void> {
    const timeout = 60000; // 1 minute timeout for RGD
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const response = await this.k8sApi.read({
          apiVersion: 'kro.run/v1alpha1',
          kind: 'ResourceGraphDefinition',
          metadata: { name, namespace },
        } as any);
        
        const rgd = response.body as any;
        
        if (rgd.status?.phase === 'ready') {
          return;
        }
        
        if (rgd.status?.phase === 'failed') {
          throw new Error(`ResourceGraphDefinition ${name} failed: ${rgd.status?.message || 'Unknown error'}`);
        }
      } catch (error: any) {
        if (error.statusCode !== 404) {
          throw error;
        }
        // RGD not found yet, continue waiting
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`Timeout waiting for ResourceGraphDefinition ${name} to be ready after ${timeout}ms`);
  }

  /**
   * Wait for custom resource instance to be ready
   */
  private async waitForInstanceReady(
    name: string,
    apiVersion: string,
    kind: string,
    namespace: string
  ): Promise<void> {
    const timeout = 300000; // 5 minute timeout for instances
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const response = await this.k8sApi.read({
          apiVersion,
          kind,
          metadata: { name, namespace },
        } as any);
        
        const instance = response.body as any;
        
        // Check if instance has meaningful status
        if (instance.status && Object.keys(instance.status).length > 0) {
          // Check for ready condition
          if (instance.status.ready === true ||
              instance.status.phase === 'ready' ||
              instance.status.conditions?.some((c: any) => 
                c.type === 'Ready' && c.status === 'True'
              )) {
            return;
          }
          
          // Check for failure
          if (instance.status.phase === 'failed' ||
              instance.status.conditions?.some((c: any) => 
                c.type === 'Failed' && c.status === 'True'
              )) {
            throw new Error(`Instance ${kind}/${name} failed: ${instance.status?.message || 'Unknown error'}`);
          }
        }
      } catch (error: any) {
        if (error.statusCode !== 404) {
          throw error;
        }
        // Instance not found yet, continue waiting
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`Timeout waiting for ${kind}/${name} to be ready after ${timeout}ms`);
  }
}