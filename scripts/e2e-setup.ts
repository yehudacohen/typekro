#!/usr/bin/env bun

/**
 * E2E Test Setup Script
 * Creates a kind cluster and bootstraps TypeKro using the bootstrap resource graph
 */

console.log('🔍 DEBUG: Script starting...');

import { execSync } from 'node:child_process';

console.log('🔍 DEBUG: execSync imported');

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

console.log('🔍 DEBUG: fs functions imported');

import { join } from 'node:path';

console.log('🔍 DEBUG: path.join imported');

console.log('🔍 DEBUG: About to import Kubernetes client...');

import * as k8s from '@kubernetes/client-node';

console.log('🔍 DEBUG: Kubernetes client imported');

// Test configuration
const CLUSTER_NAME = 'typekro-e2e-test';
const NAMESPACE = 'typekro-test';

async function setupE2EEnvironment() {
  console.log('🚀 Setting up end-to-end test environment...');

  // Check if Docker is running
  console.log('🔍 STEP 1: Checking if Docker is running...');
  try {
    console.log('  - Running docker info command...');
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    console.log('✅ STEP 1: Docker is running');
  } catch (error) {
    console.error('❌ STEP 1: Docker check failed:', error);
    throw new Error('Docker is not running or not responding. Please start Docker and try again.');
  }

  // Check if kind is available
  console.log('🔍 STEP 2: Checking if kind is available...');
  try {
    console.log('  - Running kind version command...');
    execSync('kind version', { stdio: 'pipe', timeout: 5000 });
    console.log('✅ STEP 2: Kind is available');
  } catch (error) {
    console.error('❌ STEP 2: Kind check failed:', error);
    throw new Error('Kind is not installed or not in PATH. Install from: https://kind.sigs.k8s.io/docs/user/quick-start/#installation');
  }

  // Clean up any existing cluster
  console.log('🔍 STEP 3: Attempting to clean up any existing cluster...');
  try {
    console.log('  - Attempting to delete cluster (will fail silently if none exists)...');
    execSync(`kind delete cluster --name ${CLUSTER_NAME}`, { stdio: 'pipe' });
  } catch (_error) {
    // Expected if cluster doesn't exist
  }
  console.log('🧹 STEP 3: Cleaned up existing cluster');

  // Create new kind cluster
  console.log('📦 STEP 4: Creating kind cluster...');
  try {
    console.log('  - Running kind create cluster command (this may take several minutes)...');
    execSync(`kind create cluster --name ${CLUSTER_NAME} --wait 300s`, {
      stdio: 'inherit',
      timeout: 300000, // 5 minutes
    });
    console.log('✅ STEP 4: Kind cluster created successfully');
  } catch (error) {
    console.error('❌ STEP 4: Kind cluster creation failed:', error);
    throw error;
  }

  // Bootstrap TypeKro runtime using the bootstrap resource graph
  console.log('🚀 STEP 5: Bootstrapping TypeKro runtime...');

  // Set trace log level for detailed debugging
  process.env.LOG_LEVEL = 'trace';

  const { typeKroRuntimeBootstrap } = await import('../src/core/composition/typekro-runtime/index.js');

  try {
    // Create the bootstrap resource graph
    console.log('📋 Creating TypeKro runtime bootstrap...');
    const bootstrap = typeKroRuntimeBootstrap({
      namespace: 'flux-system',
      fluxVersion: 'v2.4.0', 
      kroVersion: '0.3.0'
    });

    console.log('🏭 Creating bootstrap factory...');
    
    // Create direct factory with appropriate timeouts
    const factory = await bootstrap.factory('direct', {
      namespace: 'default',
      skipTLSVerify: true,
      timeout: 300000, // 5 minutes total timeout
      waitForReady: true // Rely on HelmRelease readiness evaluator
    });

    console.log('🚀 Deploying TypeKro runtime components...');
    
    // Deploy and await completion - this handles CRDs, Flux, and Kro via HelmRelease
    const result = await factory.deploy({
      namespace: 'flux-system'
    });

    console.log('✅ TypeKro runtime bootstrap completed!');
    console.log('📊 Bootstrap result:', result);
  } catch (error) {
    console.error('❌ TypeKro runtime bootstrap failed:', error);
    throw error;
  }

  // Create test namespace
  console.log('📁 STEP 6: Creating test namespace...');
  const { getKubeConfig } = await import('../src/core/kubernetes/client-provider.js');
  const kc = getKubeConfig({ skipTLSVerify: true });
  const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

  try {
    await k8sApi.createNamespace({
      metadata: { name: NAMESPACE },
    });
    console.log('✅ Test namespace created');
  } catch (_error) {
    console.log('⚠️  Test namespace might already exist, continuing...');
  }

  console.log('🎉 End-to-end test environment ready!');
  console.log(`🔗 Cluster: ${CLUSTER_NAME}`);
  console.log(`📁 Test namespace: ${NAMESPACE}`);
  console.log('');
  console.log('You can now:');
  console.log('  kubectl get pods -n flux-system      # Check Flux controllers');
  console.log('  kubectl get pods -n kro               # Check Kro controller');
  console.log(`  kubectl get pods -n ${NAMESPACE}      # Check test resources`);
  console.log('  kubectl get resourcegraphdefinitions  # Check RGDs');
  console.log('  kubectl get helmreleases -A           # Check HelmReleases');
  console.log('');
  console.log('Run the cleanup script when done: bun run scripts/e2e-cleanup.ts');
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
