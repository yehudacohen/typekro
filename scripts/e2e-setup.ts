#!/usr/bin/env bun
/**
 * E2E Test Setup Script
 * Creates a kind cluster and installs the complete Kro system for testing
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
    throw new Error(
      'kind is required for integration tests. Install it from https://kind.sigs.k8s.io/docs/user/quick-start/'
    );
  }

  // Delete existing cluster if it exists (skip check, just try to delete)
  console.log('🔍 STEP 3: Attempting to clean up any existing cluster...');
  try {
    console.log('  - Attempting to delete cluster (will fail silently if none exists)...');
    execSync(`kind delete cluster --name ${CLUSTER_NAME}`, { stdio: 'pipe', timeout: 15000 });
    console.log('🧹 STEP 3: Cleaned up existing cluster');
  } catch (_error) {
    console.log('ℹ️  STEP 3: No existing cluster to clean up (or delete failed quickly)');
  }

  // Create kind cluster
  console.log('📦 STEP 4: Creating kind cluster...');
  try {
    console.log('  - Running kind create cluster command (this may take several minutes)...');
    execSync(`kind create cluster --name ${CLUSTER_NAME} --wait 5m`, {
      stdio: 'inherit',
      timeout: 300000,
    });
    console.log('✅ STEP 4: Kind cluster created successfully');
  } catch (error) {
    console.error('❌ STEP 4: Kind cluster creation failed:', error);
    throw new Error(`Failed to create kind cluster: ${error}`);
  }

  // Set up kubectl context
  execSync(`kind export kubeconfig --name ${CLUSTER_NAME}`, { stdio: 'pipe' });

  // Initialize Kubernetes client
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  // Configure to skip TLS verification for test environment
  const cluster = kc.getCurrentCluster();
  if (cluster) {
    // Create a new cluster object with skipTLSVerify set to true
    const modifiedCluster = { ...cluster, skipTLSVerify: true };
    kc.clusters = kc.clusters.map((c) => (c === cluster ? modifiedCluster : c));
  }

  const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

  // Install complete Kro system (CRDs + Controller)
  console.log('🔧 Installing complete Kro system...');

  // Create kro-system namespace
  try {
    execSync('kubectl create namespace kro-system', { stdio: 'pipe' });
  } catch (_error) {
    console.log('⚠️  kro-system namespace might already exist, continuing...');
  }

  // Install Kro CRDs first
  console.log('📦 Installing Kro CRDs...');
  try {
    execSync(
      'kubectl apply -f https://raw.githubusercontent.com/kro-run/kro/main/helm/crds/kro.run_resourcegraphdefinitions.yaml',
      {
        stdio: 'inherit',
        timeout: 60000,
      }
    );
    console.log('✅ Kro CRDs installed successfully');
  } catch (error) {
    console.error('❌ Kro CRD installation failed:', error);
    throw error;
  }

  // Download and install Kro controller using Helm templates
  console.log('🚀 Installing Kro controller...');
  const tempDir = join(__dirname, '../temp');
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  try {
    // Download the Helm chart files
    const helmFiles = [
      'Chart.yaml',
      'values.yaml',
      'templates/_helpers.tpl',
      'templates/serviceaccount.yaml',
      'templates/cluster-role.yaml',
      'templates/cluster-role-binding.yaml',
      'templates/deployment.yaml',
      'templates/metrics-service.yaml',
    ];

    const helmDir = join(tempDir, 'kro-helm');
    if (!existsSync(helmDir)) {
      mkdirSync(helmDir, { recursive: true });
    }
    if (!existsSync(join(helmDir, 'templates'))) {
      mkdirSync(join(helmDir, 'templates'), { recursive: true });
    }

    for (const file of helmFiles) {
      const url = `https://raw.githubusercontent.com/kro-run/kro/main/helm/${file}`;
      const filePath = join(helmDir, file);
      console.log(`📥 Downloading ${file}...`);
      try {
        execSync(`curl -s -f -m 30 -o "${filePath}" "${url}"`, {
          timeout: 35000,
          stdio: 'pipe',
        });
        console.log(`✅ Downloaded ${file}`);
      } catch (error) {
        console.error(`❌ Failed to download ${file}: ${error}`);
        throw new Error(
          `Failed to download Helm chart file ${file}. Check internet connection and GitHub availability.`
        );
      }
    }

    // Template the Helm chart with appropriate values for testing
    // Try the release version first, then fall back to dev version
    let helmManifests: string;
    try {
      console.log('🔄 Trying release image: ghcr.io/kro-run/kro/controller:0.3.0');
      helmManifests = execSync(
        `helm template kro "${helmDir}" --namespace kro-system --set image.repository=ghcr.io/kro-run/kro/controller --set image.tag=0.3.0`,
        {
          encoding: 'utf8',
          timeout: 60000,
        }
      );
    } catch (_error) {
      console.log(
        '⚠️  Release image failed, trying dev image: ghcr.io/kro-run/kro/controller:dev-91d2ec1'
      );
      helmManifests = execSync(
        `helm template kro "${helmDir}" --namespace kro-system --set image.repository=ghcr.io/kro-run/kro/controller --set image.tag=dev-91d2ec1`,
        {
          encoding: 'utf8',
          timeout: 60000,
        }
      );
    }

    // Save and apply the manifests
    const manifestFile = join(tempDir, 'kro-controller.yaml');
    writeFileSync(manifestFile, helmManifests);

    // Apply manifests with better error handling
    try {
      execSync(`kubectl apply -f "${manifestFile}"`, {
        stdio: 'inherit',
        timeout: 120000,
      });
      console.log('✅ Kro controller manifests applied');
    } catch (error) {
      console.error('❌ Failed to apply Kro controller manifests:', error);
      // Try to apply individual resources as fallback
      console.log('🔄 Trying to apply resources individually...');
      try {
        const resources = helmManifests.split('---').filter(r => r.trim());
        for (const resource of resources) {
          if (resource.trim()) {
            const tempFile = join(tempDir, `kro-resource-${Date.now()}.yaml`);
            writeFileSync(tempFile, resource);
            try {
              execSync(`kubectl apply -f "${tempFile}"`, { stdio: 'pipe' });
            } catch (applyError) {
              console.warn('⚠️  Failed to apply individual resource:', applyError);
            }
          }
        }
        console.log('✅ Kro controller resources applied (with some warnings)');
      } catch (fallbackError) {
        console.error('❌ Fallback application also failed:', fallbackError);
        throw error; // Throw original error
      }
    }

    // Wait for the Kro controller to be ready
    console.log('⏳ Waiting for Kro controller to be ready...');
    await waitForDeployment('kro-system', 'kro', 180000);

    console.log('✅ Kro controller is ready!');
  } catch (error) {
    console.error('❌ Kro controller installation failed:', error);
    throw error;
  }

  // Create test namespace
  console.log('📁 Creating test namespace...');
  try {
    await k8sApi.createNamespace({
      metadata: { name: NAMESPACE },
    });
  } catch (_error) {
    console.log('⚠️  Namespace might already exist, continuing...');
  }

  console.log('✅ Test environment ready!');
  console.log(`🔗 Cluster: ${CLUSTER_NAME}`);
  console.log(`📁 Test namespace: ${NAMESPACE}`);
  console.log('');
  console.log('You can now:');
  console.log(`  kubectl get pods -n kro-system  # Check Kro controller`);
  console.log(`  kubectl get pods -n ${NAMESPACE}  # Check test resources`);
  console.log(`  kubectl get resourcegraphdefinitions  # Check RGDs`);
  console.log('');
  console.log('Run the cleanup script when done: bun run scripts/e2e-cleanup.ts');
}

// Helper function to wait for deployment to be ready
async function waitForDeployment(
  namespace: string,
  name: string,
  timeoutMs: number
): Promise<void> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const cluster = kc.getCurrentCluster();
  if (cluster) {
    // Create a new cluster object with skipTLSVerify set to true
    const modifiedCluster = { ...cluster, skipTLSVerify: true };
    kc.clusters = kc.clusters.map((c) => (c === cluster ? modifiedCluster : c));
  }
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const deployment = await appsApi.readNamespacedDeployment(name, namespace);
      const status = deployment.body.status;

      if (status?.readyReplicas === status?.replicas && (status?.replicas ?? 0) > 0) {
        console.log(`✅ Deployment ${name} is ready`);
        return;
      }
    } catch (_error) {
      // Deployment might not exist yet, continue waiting
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`Timeout waiting for deployment ${name} to be ready`);
}

// Run the setup if this script is executed directly
if (import.meta.main) {
  setupE2EEnvironment().catch((error) => {
    console.error('❌ Setup failed:', error);
    process.exit(1);
  });
}
