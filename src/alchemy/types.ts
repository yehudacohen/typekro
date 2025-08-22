/**
 * Alchemy Integration Types
 *
 * This module provides type definitions for alchemy integration
 * with TypeKro resources.
 */

import type { Resource as AlchemyResource } from 'alchemy';
import type { KubernetesClientConfig } from '../core/kubernetes/client-provider.js';
import type { DeploymentOptions } from '../core/types/deployment.js';
import type { Enhanced } from '../core/types/kubernetes.js';

/**
 * Centralized deployment interface that abstracts deployment logic
 */
export interface TypeKroDeployer {
  /**
   * Deploy a TypeKro resource to Kubernetes
   */
  deploy<T extends Enhanced<any, any>>(resource: T, options: DeploymentOptions): Promise<T>;

  /**
   * Delete a TypeKro resource from Kubernetes
   */
  delete<T extends Enhanced<any, any>>(resource: T, options: DeploymentOptions): Promise<void>;
}

/**
 * Serializable kubeConfig options that can be passed through Alchemy
 * This is now a re-export of the centralized KubernetesClientConfig
 */
export type SerializableKubeConfigOptions = KubernetesClientConfig;

/**
 * Properties for creating or updating a TypeKro resource through alchemy
 */
export interface TypeKroResourceProps<T extends Enhanced<any, any>> {
  /**
   * The TypeKro Enhanced resource to deploy
   */
  resource: T;

  /**
   * The namespace to deploy the resource to
   */
  namespace: string;

  /**
   * The deployment strategy to use
   */
  deploymentStrategy: 'direct' | 'kro';

  /**
   * Serializable kubeConfig options
   */
  kubeConfigOptions?: SerializableKubeConfigOptions;

  /**
   * Optional deployment options
   */
  options?: {
    waitForReady?: boolean;
    timeout?: number;
  };
}

/**
 * Alchemy resource state structure
 */
export interface AlchemyResourceState {
  kind?: string;
  resource?: any;
  ready?: boolean;
  [key: string]: unknown;
}

/**
 * Output returned after TypeKro resource deployment through alchemy
 * Following alchemy pattern: interface name matches exported resource name
 */
export interface TypeKroResource<T extends Enhanced<any, any>> extends AlchemyResource<string> {
  /**
   * The original TypeKro resource
   */
  resource: T;

  /**
   * The namespace the resource was deployed to
   */
  namespace: string;

  /**
   * The deployed resource with live status from the cluster
   */
  deployedResource: T;

  /**
   * Whether the resource is ready and available
   */
  ready: boolean;

  /**
   * Deployment timestamp
   */
  deployedAt: number;
}
