#!/usr/bin/env bun

/**
 * E2E Test Setup Script
 * Creates a kind cluster and bootstraps TypeKro using the bootstrap resource graph
 */

import { execSync } from 'node:child_process';
import * as k8s from '@kubernetes/client-node';

// Test configuration
const CLUSTER_NAME = 'typekro-e2e-test';
const NAMESPACE = 'typekro-test';

async function setupE2EEnvironment() {
  console.log('🚀 Setting up end-to-end test environment...');

  // Clean up any existing cluster
  try {
    execSync(`kind delete cluster --name ${CLUSTER_NAME}`, { stdio: 'pipe' });
  } catch {
    // Expected if cluster doesn't exist
  }

  // Create new kind cluster
  console.log('📦 Creating kind cluster...');
  execSync(`kind create cluster --name ${CLUSTER_NAME} --wait 300s`, {
    stdio: 'inherit',
    timeout: 300000,
  });

  // Bootstrap TypeKro runtime
  console.log('🚀 Bootstrapping TypeKro runtime...');
  const { typeKroRuntimeBootstrap } = await import('../src/core/composition/typekro-runtime/index.js');

  const bootstrap = typeKroRuntimeBootstrap({
    namespace: 'flux-system',
    fluxVersion: 'v2.4.0',
    kroVersion: '0.3.0'
  });

  // Create factory with built-in event monitoring
  const factory = await bootstrap.factory('direct', {
    namespace: 'default',
    skipTLSVerify: true,
    timeout: 300000,
    waitForReady: true,
    eventMonitoring: {
      enabled: true,
      eventTypes: ['Warning', 'Error', 'Normal'],
      includeChildResources: true
    },
    progressCallback: (event) => {
      console.log(`📡 ${event.type}: ${event.message}`);
    }
  });

  // Deploy TypeKro runtime
  await factory.deploy({ namespace: 'flux-system' });

  // Create test namespace
  const { getKubeConfig } = await import('../src/core/kubernetes/client-provider.js');
  const kc = getKubeConfig({ skipTLSVerify: true });
  const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

  try {
    await k8sApi.createNamespace({
      metadata: { name: NAMESPACE },
    });
  } catch {
    // Namespace might already exist
  }

  // Install Cilium for networking tests
  console.log('🌐 Setting up Cilium for networking tests...');
  try {
    const { ensureCiliumInstalled } = await import('../test/integration/cilium/setup-cilium.js');
    await ensureCiliumInstalled();
    console.log('✅ Cilium setup complete!');
  } catch (error) {
    console.warn('⚠️  Cilium setup failed, networking tests may not work:', error);
    // Don't fail the entire setup if Cilium fails
  }

  console.log('✅ E2E environment ready!');
}

// Run the setup if this script is executed directly
if (import.meta.main) {
  setupE2EEnvironment().catch((error) => {
    console.error('❌ Setup failed:', error);
    process.exit(1);
  }).then(() => {
    // Explicitly exit after successful completion
    process.exit(0);
  });
}

export { setupE2EEnvironment };
