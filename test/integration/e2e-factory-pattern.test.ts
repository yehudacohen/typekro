import { beforeAll, describe, expect, it } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { Cel, secret, simple, toResourceGraph } from '../../src/index';
import { getIntegrationTestKubeConfig, isClusterAvailable } from './shared-kubeconfig';

// Test configuration
const _CLUSTER_NAME = 'typekro-e2e-test';
const BASE_NAMESPACE = 'typekro-factory-pattern';

// Generate unique namespace for each test
const generateTestNamespace = (testName: string): string => {
  const timestamp = Date.now().toString().slice(-6); // Last 6 digits
  const sanitized = testName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 20);
  return `${BASE_NAMESPACE}-${sanitized}-${timestamp}`;
};

// Check if cluster is available
const clusterAvailable = isClusterAvailable();

const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('End-to-End Factory Pattern Test', () => {
  let kc: k8s.KubeConfig;
  let k8sApi: k8s.CoreV1Api;
  let appsApi: k8s.AppsV1Api;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('🚀 SETUP: Connecting to existing cluster...');

    // Use shared kubeconfig helper for consistent TLS configuration
    kc = getIntegrationTestKubeConfig();

    k8sApi = kc.makeApiClient(k8s.CoreV1Api);
    appsApi = kc.makeApiClient(k8s.AppsV1Api);

    // Note: Individual test namespaces will be created per test for better isolation

    console.log('✅ Test environment ready!');
  });

  // Helper function to create and cleanup test namespace
  const withTestNamespace = async <T>(
    testName: string,
    testFn: (namespace: string) => Promise<T>
  ): Promise<T> => {
    const namespace = generateTestNamespace(testName);

    try {
      // Create namespace
      await k8sApi.createNamespace({ metadata: { name: namespace } });
      console.log(`📦 Created test namespace: ${namespace}`);

      // Run test
      const result = await testFn(namespace);

      return result;
    } finally {
      // Cleanup namespace
      try {
        await k8sApi.deleteNamespace(namespace);
        console.log(`🗑️ Cleaned up test namespace: ${namespace}`);
      } catch (error) {
        console.warn(`⚠️ Failed to cleanup namespace ${namespace}:`, error);
      }
    }
  };

  it('should deploy using factory pattern with proper type safety and field separation', async () => {
    await withTestNamespace('factory-pattern', async (testNamespace) => {
      console.log('🚀 Starting factory pattern e2e test...');

      // 1. Create a comprehensive TypeKro resource graph
      console.log('📝 STEP 1: Creating TypeKro resource graph...');

      const WebAppSpecSchema = type({
        name: 'string',
        environment: '"development" | "production" | "staging"',
      });

      const WebAppStatusSchema = type({
        phase: '"pending" | "running" | "failed"',
        url: 'string',
        readyReplicas: 'number',
      });

      const resourceGraph = toResourceGraph(
        {
          name: 'webapp-factory-test',
          apiVersion: 'v1alpha1',
          kind: 'WebappFactoryTest',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (_schema) => ({
          appConfig: simple.ConfigMap({
            name: 'webapp-factory-config',
            data: {
              LOG_LEVEL: 'info',
              DATABASE_URL: 'postgresql://localhost:5432/webapp',
              FEATURE_FLAGS: 'auth,metrics,logging',
            },
            id: 'webappConfig',
          }),

          appSecrets: secret(
            Object.assign(
              {
                metadata: { name: 'webapp-factory-secrets' },
                data: {
                  API_KEY: Buffer.from('super-secret-api-key').toString('base64'),
                  JWT_SECRET: Buffer.from('jwt-signing-secret').toString('base64'),
                  DATABASE_PASSWORD: Buffer.from('secure-db-password').toString('base64'),
                },
              },
              { id: 'webappSecrets' }
            )
          ),

          webapp: simple.Deployment({
            name: 'webapp-factory',
            image: 'nginx:alpine',
            replicas: 2,
            env: {
              LOG_LEVEL: 'info',
              API_KEY: 'super-secret-api-key',
              JWT_SECRET: 'jwt-signing-secret',
            },
            ports: [{ containerPort: 80, name: 'http' }],
            id: 'webapp',
          }),

          webappService: simple.Service({
            name: 'webapp-factory-service',
            selector: { app: 'webapp-factory' },
            ports: [{ port: 80, targetPort: 80, name: 'http' }],
            id: 'webappService',
          }),
        }),
        (_schema, resources) => ({
          // Dynamic field - resolved by Kro
          phase: Cel.conditional(
            Cel.expr(resources.webapp.status.readyReplicas, ' > 0'),
            '"running"',
            '"pending"'
          ) as 'pending' | 'running' | 'failed',

          // Static field - hydrated directly by TypeKro
          url: 'http://webapp-factory-service',

          // Dynamic field - resolved by Kro
          readyReplicas: Cel.expr(resources.webapp.status.readyReplicas) as number,
        })
      );

      // 2. Create Kro factory with proper kubeConfig
      console.log('📝 STEP 2: Creating Kro factory...');

      const kroFactory = await resourceGraph.factory('kro', {
        namespace: testNamespace,
        waitForReady: true,
        kubeConfig: kc, // Pass the configured kubeConfig with TLS settings
      });

      // 3. Deploy using the factory pattern
      console.log('🚀 STEP 3: Deploying using factory.deploy()...');

      const deploymentResult = await kroFactory.deploy({
        name: 'test-webapp-factory',
        environment: 'development' as const,
      });

      // 4. Verify type safety and field separation
      console.log('✅ STEP 4: Verifying type safety and field separation...');

      // Test that the result is properly typed
      expect(deploymentResult.metadata.name).toBeDefined();
      expect(deploymentResult.spec.name).toBe('test-webapp-factory');
      expect(deploymentResult.spec.environment).toBe('development');

      // Test static field (should be hydrated directly)
      expect(deploymentResult.status.url).toBe('http://webapp-factory-service');

      // Test dynamic fields (should be resolved by Kro)
      expect(['pending', 'running', 'failed']).toContain(deploymentResult.status.phase);
      expect(typeof deploymentResult.status.readyReplicas).toBe('number');

      console.log('📊 Deployment result:');
      console.log(`  Name: ${deploymentResult.metadata.name}`);
      console.log(`  Environment: ${deploymentResult.spec.environment}`);
      console.log(`  Phase: ${deploymentResult.status.phase}`);
      console.log(`  URL: ${deploymentResult.status.url}`);
      console.log(`  Ready Replicas: ${deploymentResult.status.readyReplicas}`);

      // 5. Verify underlying resources were created
      console.log('🔍 STEP 5: Verifying underlying resources...');

      const expectedResources = [
        { kind: 'ConfigMap', name: 'webapp-factory-config' },
        { kind: 'Secret', name: 'webapp-factory-secrets' },
        { kind: 'Deployment', name: 'webapp-factory' },
        { kind: 'Service', name: 'webapp-factory-service' },
      ];

      let resourcesFound = 0;
      for (const resource of expectedResources) {
        try {
          switch (resource.kind) {
            case 'ConfigMap': {
              const configMap = await k8sApi.readNamespacedConfigMap(resource.name, testNamespace);
              expect(configMap.body.data?.LOG_LEVEL).toBe('info');
              console.log(`✅ ${resource.kind}: ${resource.name}`);
              resourcesFound++;
              break;
            }
            case 'Secret':
              await k8sApi.readNamespacedSecret(resource.name, testNamespace);
              console.log(`✅ ${resource.kind}: ${resource.name}`);
              resourcesFound++;
              break;
            case 'Deployment': {
              const deployment = await appsApi.readNamespacedDeployment(
                resource.name,
                testNamespace
              );
              expect(deployment.body.spec?.replicas).toBe(2);
              console.log(`✅ ${resource.kind}: ${resource.name}`);
              resourcesFound++;
              break;
            }
            case 'Service': {
              const service = await k8sApi.readNamespacedService(resource.name, testNamespace);
              expect(service.body.spec?.ports?.[0]?.port).toBe(80);
              console.log(`✅ ${resource.kind}: ${resource.name}`);
              resourcesFound++;
              break;
            }
          }
        } catch (error) {
          console.log(`❌ ${resource.kind}: ${resource.name} not found - ${error}`);
        }
      }

      console.log(`📊 Resources found: ${resourcesFound}/${expectedResources.length}`);
      expect(resourcesFound).toBe(expectedResources.length);

      // 6. Test factory instance management
      console.log('🔍 STEP 6: Testing factory instance management...');

      const instances = await kroFactory.getInstances();
      expect(instances.length).toBeGreaterThan(0);

      const factoryStatus = await kroFactory.getStatus();
      expect(factoryStatus.mode).toBe('kro');
      expect(factoryStatus.name).toBe('webapp-factory-test');

      console.log(`📊 Factory status: ${factoryStatus.mode} mode, ${instances.length} instances`);

      console.log('🎉 STEP 7: Factory pattern test completed successfully!');
      console.log('✅ Factory.deploy() works with proper type safety');
      console.log('✅ Static fields are hydrated directly by TypeKro');
      console.log('✅ Dynamic fields are resolved by Kro');
      console.log('✅ Instance management methods work correctly');
      console.log('✅ All underlying Kubernetes resources were created');

      // Cleanup using factory-based resource destruction
      console.log('🧹 Cleaning up deployed resources...');
      try {
        await kroFactory.deleteInstance('test-webapp-factory');
        console.log('✅ Factory cleanup completed');
      } catch (error) {
        console.warn('⚠️ Factory cleanup failed:', error);
      }
    });
  }, 180000);
});
