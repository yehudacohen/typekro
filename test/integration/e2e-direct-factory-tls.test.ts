import { beforeAll, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as k8s from '@kubernetes/client-node';
import { toResourceGraph, simpleConfigMap } from '../../src/index.js';
import { type } from 'arktype';

// Test configuration
const CLUSTER_NAME = 'typekro-e2e-test';

// Generate unique namespace for each test
const generateTestNamespace = (testName: string): string => {
  const timestamp = Date.now().toString().slice(-6); // Last 6 digits
  const sanitized = testName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
  return `typekro-${sanitized}-${timestamp}`;
};

// Check if cluster is available
let isClusterAvailable = false;
try {
  execSync(`kind get clusters | grep ${CLUSTER_NAME}`, {
    stdio: 'pipe',
    timeout: 10000,
  });
  isClusterAvailable = true;
} catch (_error) {
  console.log(
    `⚠️  Skipping e2e test: Test cluster '${CLUSTER_NAME}' not found. Run: bun run scripts/e2e-setup.ts`
  );
}

const describeOrSkip = isClusterAvailable ? describe : describe.skip;

describeOrSkip('DirectResourceFactory TLS Fix Test', () => {
  let kc: k8s.KubeConfig;

  beforeAll(() => {
    // Initialize Kubernetes client with TLS skip
    kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    // Configure to skip TLS verification for test environment
    const cluster = kc.getCurrentCluster();
    if (cluster) {
      const modifiedCluster = { ...cluster, skipTLSVerify: true };
      kc.clusters = kc.clusters.map((c) => (c === cluster ? modifiedCluster : c));
    }
  });

  it('should deploy resources directly without TLS certificate errors', async () => {
    const NAMESPACE = generateTestNamespace('tls-direct-deploy');
    console.log('🧪 Testing DirectResourceFactory with TLS skip configuration...');

    // Create test namespace
    const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
    try {
      await k8sApi.createNamespace({ metadata: { name: NAMESPACE } });
      console.log(`📦 Created test namespace: ${NAMESPACE}`);
    } catch (error) {
      console.warn(`⚠️ Namespace ${NAMESPACE} might already exist:`, error);
    }

    // Create a simple resource graph
    const resourceGraph = toResourceGraph(
      {
        name: 'tls-test',
        apiVersion: 'v1alpha1',
        kind: 'TlsTest',
        spec: type({ name: 'string' }),
        status: type({ phase: 'string' }),
      },
      (_schema) => ({
        testConfig: simpleConfigMap({
          name: 'tls-test-config',
          data: {
            TEST_VALUE: 'direct-factory-works',
            TIMESTAMP: new Date().toISOString(),
          },
        }),
      }),
      (_schema, _resources) => ({
        phase: 'running',
      })
    );

    // Create DirectResourceFactory with the configured kubeConfig
    const factory = await resourceGraph.factory('direct', {
      namespace: NAMESPACE,
      waitForReady: false,
      timeout: 30000,
      kubeConfig: kc, // Pass the TLS-skip configured kubeConfig
    });

    // Deploy the resources
    const instance = await factory.deploy({ name: 'tls-test-instance' });

    // Verify the instance was created
    expect(instance).toBeDefined();
    expect(instance.spec.name).toBe('tls-test-instance');

    console.log('✅ DirectResourceFactory deployed successfully without TLS errors');

    // Verify the ConfigMap was actually created in the cluster
    const configMap = await k8sApi.readNamespacedConfigMap('tls-test-config', NAMESPACE);
    
    expect(configMap.body.data?.TEST_VALUE).toBe('direct-factory-works');
    expect(configMap.body.data?.TIMESTAMP).toBeDefined();

    console.log('✅ ConfigMap was created successfully in the cluster');

    // Clean up (best effort)
    try {
      await factory.deleteInstance('tls-test-instance');
      console.log('✅ Resources cleaned up successfully');
    } catch (error) {
      console.warn('⚠️ Cleanup failed (this is expected for this test):', error);
      // Clean up manually
      try {
        await k8sApi.deleteNamespacedConfigMap('tls-test-config', NAMESPACE);
        console.log('✅ Manual cleanup successful');
      } catch (manualError) {
        console.warn('⚠️ Manual cleanup also failed:', manualError);
      }
    }

    // Clean up namespace
    try {
      await k8sApi.deleteNamespace(NAMESPACE);
      console.log(`🗑️ Cleaned up test namespace: ${NAMESPACE}`);
    } catch (error) {
      console.warn(`⚠️ Failed to cleanup namespace ${NAMESPACE}:`, error);
    }
  }, 60000);
});