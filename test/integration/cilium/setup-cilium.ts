/**
 * Cilium Setup for Integration Tests
 * 
 * This module handles installing Cilium using our bootstrap composition
 * before running the networking integration tests.
 */

import type * as k8s from '@kubernetes/client-node';
import { ciliumBootstrap } from '../../../src/factories/cilium/compositions/cilium-bootstrap.js';
import { getIntegrationTestKubeConfig } from '../shared-kubeconfig.js';
import { createBunCompatibleApiextensionsV1Api } from '../../../src/core/kubernetes/bun-api-client.js';

const _CILIUM_NAMESPACE = 'kube-system';
const FLUX_NAMESPACE = 'flux-system';

/**
 * Install Cilium using our bootstrap composition
 */
export async function setupCilium(): Promise<void> {
  console.log('🚀 Installing Cilium using TypeKro bootstrap composition...');

  const kubeConfig = getIntegrationTestKubeConfig();

  try {
    // Create a factory for deploying Cilium
    const factory = ciliumBootstrap.factory('direct', {
      kubeConfig,
      namespace: FLUX_NAMESPACE,
      waitForReady: true,
    });

    // Deploy Cilium with basic configuration
    const ciliumInstance = await factory.deploy({
      name: 'cilium',
      cluster: {
        name: 'typekro-e2e-test',
        id: 1,
      },
      version: '1.18.1',
      networking: {
        kubeProxyReplacement: 'strict',
        routingMode: 'tunnel',
      },
      observability: {
        hubbleEnabled: true,
      },
    });

    console.log('✅ Cilium installed successfully!');
    console.log(`📊 Cilium status: ${JSON.stringify(ciliumInstance.status, null, 2)}`);

    // Wait a bit for Cilium to fully initialize
    console.log('⏳ Waiting for Cilium to fully initialize...');
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds

    console.log('✅ Cilium setup complete!');

  } catch (error) {
    console.error('❌ Failed to install Cilium:', error);
    throw error;
  }
}

/**
 * Check if Cilium is already installed
 */
export async function isCiliumInstalled(): Promise<boolean> {
  try {
    const kubeConfig = getIntegrationTestKubeConfig();
    const k8sApi = createBunCompatibleApiextensionsV1Api(kubeConfig);

    // Check if Cilium CRDs exist
    const crds = await k8sApi.listCustomResourceDefinition();
    const ciliumCRDs = crds.items.filter((crd: k8s.V1CustomResourceDefinition) =>
      crd.metadata?.name?.includes('cilium.io')
    );

    return ciliumCRDs.length > 0;
  } catch (error) {
    console.warn('Could not check if Cilium is installed:', error);
    return false;
  }
}

/**
 * Setup Cilium if not already installed
 */
export async function ensureCiliumInstalled(): Promise<void> {
  const installed = await isCiliumInstalled();

  if (installed) {
    console.log('✅ Cilium is already installed, skipping setup');
    return;
  }

  await setupCilium();
}