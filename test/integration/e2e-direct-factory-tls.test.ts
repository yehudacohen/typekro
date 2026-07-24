import { beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { simple, toResourceGraph } from '../../src/index.js';
import {
  createCoreV1ApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from './shared-kubeconfig';

// Generate unique namespace for each test
const generateTestNamespace = (testName: string): string => {
  const sanitized = testName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 20);
  return `typekro-${sanitized}-${crypto.randomUUID().slice(0, 8)}`;
};

const clusterAvailable = await isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('DirectResourceFactory TLS Fix Test', () => {
  let kc: k8s.KubeConfig;

  beforeAll(() => {
    // Use shared kubeconfig helper for consistent TLS configuration
    kc = getIntegrationTestKubeConfig();
  });

  it('should deploy resources directly without TLS certificate errors', async () => {
    const NAMESPACE = generateTestNamespace('tls-direct-deploy');
    console.log('🧪 Testing DirectResourceFactory with TLS skip configuration...');

    const namespaceLease = await createTestNamespace(NAMESPACE, kc);
    const k8sApi = createCoreV1ApiClient(kc);

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
        testConfig: simple.ConfigMap({
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

    let testError: unknown;
    try {
      // Deploy the resources
      const instance = await factory.deploy({ name: 'tls-test-instance' });

      // Verify the instance was created
      expect(instance).toBeDefined();
      expect(instance.spec.name).toBe('tls-test-instance');

      console.log('✅ DirectResourceFactory deployed successfully without TLS errors');

      // Verify the ConfigMap was actually created in the cluster
      const configMap = await k8sApi.readNamespacedConfigMap({
        name: 'tls-test-config',
        namespace: NAMESPACE,
      });

      expect(configMap.data?.TEST_VALUE).toBe('direct-factory-works');
      expect(configMap.data?.TIMESTAMP).toBeDefined();

      console.log('✅ ConfigMap was created successfully in the cluster');
    } catch (error) {
      testError = error;
    }

    const cleanupErrors: unknown[] = [];
    try {
      await deleteTestFactoryInstanceAndRecoverNamespaces(factory, 'tls-test-instance', [], kc);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await deleteTestNamespaceAndWait(namespaceLease, kc);
    } catch (error) {
      cleanupErrors.push(error);
    }
    const failures = [...(testError !== undefined ? [testError] : []), ...cleanupErrors];
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Direct TLS integration did not complete safely');
    }
  }, 900000);
});
