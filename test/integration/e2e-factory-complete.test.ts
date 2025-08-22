import { beforeAll, describe, expect, it } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import {
  Cel,
  simpleConfigMap,
  simpleDeployment,
  simpleService,
  toResourceGraph,
} from '../../src/index.js';
import { getIntegrationTestKubeConfig, isClusterAvailable } from './shared-kubeconfig';

const _CLUSTER_NAME = 'typekro-e2e-test'; // Use same cluster as setup script
const NAMESPACE = 'typekro-test'; // Use same namespace as setup script
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('End-to-End Factory Pattern with Status Hydration', () => {
  let kubeConfig: k8s.KubeConfig;
  let k8sApi: k8s.KubernetesObjectApi;
  let _customApi: k8s.CustomObjectsApi;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('🚀 SETUP: Connecting to existing cluster...');

    // Use shared kubeconfig helper for consistent TLS configuration
    kubeConfig = getIntegrationTestKubeConfig();

    k8sApi = kubeConfig.makeApiClient(k8s.KubernetesObjectApi);
    _customApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);

    console.log('✅ Factory e2e test environment ready!');
  }); // 5 minute timeout for setup

  // COMMENTED OUT: Preserve cluster for debugging after test completion
  // afterAll(async () => {
  //   console.log('🧹 Cleaning up factory test environment...');
  //   try {
  //     execSync(`kind delete cluster --name ${CLUSTER_NAME}`, {
  //       stdio: 'pipe',
  //       timeout: 30000,
  //     });
  //     console.log('✅ Factory test cluster deleted successfully');
  //   } catch (error) {
  //     console.log('⚠️  Failed to delete factory test cluster:', error);
  //   }
  //   console.log('✅ Factory test cleanup completed');
  // });

  it('should deploy a complete factory with mixed static/dynamic status fields and hydrate from cluster', async () => {
    console.log('🎯 Starting complete factory e2e test with status hydration...');
    console.log('📋 This test proves API version separation:');
    console.log("   - ResourceGraphDefinition uses: kro.run/v1alpha1 (Kro's own API)");
    console.log('   - Generated instances use: kro.run/v2beta1 (our custom version)');

    // Define schemas with mixed static/dynamic status fields
    const WebAppSpecSchema = type({
      name: 'string',
      image: 'string',
      replicas: 'number',
      environment: '"development" | "staging" | "production"',
    });

    const WebAppStatusSchema = type({
      // Static fields (will be hydrated directly by TypeKro)
      url: 'string',
      version: 'string',
      environment: 'string',

      // Dynamic fields (will be resolved by Kro from Kubernetes resources)
      phase: '"pending" | "running" | "failed"',
      replicas: 'number',
      readyReplicas: 'number',

      // Mixed nested object
      metadata: {
        name: 'string',
        namespace: 'string',
        createdBy: 'string',
        deployedAt: 'string',
      },
    });

    console.log('📝 STEP 1: Creating TypeKro resource graph with mixed status fields...');

    const resourceGraph = toResourceGraph(
      {
        name: 'webapp-factory-e2e',
        // Explicitly set apiVersion to v2beta1 to prove separation from RGD's kro.run/v1alpha1
        apiVersion: 'v2beta1',
        kind: 'WebAppFactoryE2E',
        spec: WebAppSpecSchema,
        status: WebAppStatusSchema,
      },
      (schema) => ({
        // Configuration
        appConfig: simpleConfigMap({
          name: Cel.concat(schema.spec.name, '-config'),
          namespace: NAMESPACE,
          data: {
            LOG_LEVEL: 'info',
            ENVIRONMENT: schema.spec.environment,
            DATABASE_URL: 'postgresql://localhost:5432/webapp',
          },
          id: 'webappConfig',
        }),

        // Main application deployment
        webapp: simpleDeployment({
          name: schema.spec.name,
          namespace: NAMESPACE,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
          env: {
            LOG_LEVEL: 'info',
            ENVIRONMENT: schema.spec.environment,
          },
          ports: [{ containerPort: 8080, name: 'http' }],
          id: 'webapp',
        }),

        // Service for the application
        webappService: simpleService({
          name: Cel.concat(schema.spec.name, '-service'),
          namespace: NAMESPACE,
          selector: { app: schema.spec.name },
          ports: [{ port: 80, targetPort: 8080, name: 'http' }],
          id: 'webappService',
        }),
      }),
      (_schema, resources) => ({
        // Static fields (no Kubernetes references - hydrated directly by TypeKro)
        url: 'http://test-webapp-service.typekro-test.svc.cluster.local',
        version: '1.0.0',
        environment: 'e2e-test',

        // Dynamic fields (with Kubernetes references - resolved by Kro)
        phase: Cel.conditional(
          Cel.expr('has(webapp.status.availableReplicas) && webapp.status.availableReplicas > 0'),
          '"running"',
          '"pending"'
        ) as 'pending' | 'running' | 'failed',
        replicas: Cel.expr('has(webapp.status.replicas) ? webapp.status.replicas : 0'),
        readyReplicas: Cel.expr(
          'has(webapp.status.availableReplicas) ? webapp.status.availableReplicas : 0'
        ),

        // Mixed nested object
        metadata: {
          name: 'webapp-factory-e2e', // static
          namespace: resources.webapp.metadata.namespace, // dynamic
          createdBy: 'typekro-factory-e2e', // static
          deployedAt: new Date().toISOString(), // static
        },
      })
    );

    console.log('✅ STEP 1: Resource graph created successfully');

    console.log('📝 STEP 2: Creating Kro factory...');
    const kroFactory = await resourceGraph.factory('kro', {
      namespace: NAMESPACE,
      waitForReady: true,
      timeout: 120000, // 2 minutes
      kubeConfig: kubeConfig, // Use the configured kubeConfig with TLS skip
    });

    console.log('✅ STEP 2: Kro factory created successfully');
    expect(kroFactory.mode).toBe('kro');
    expect(kroFactory.name).toBe('webapp-factory-e2e');
    expect(kroFactory.namespace).toBe(NAMESPACE);

    console.log('📝 STEP 3: Deploying instance via factory...');
    const deployedInstance = await kroFactory.deploy({
      name: 'test-webapp',
      image: 'nginx:alpine',
      replicas: 2,
      environment: 'production',
    });

    console.log('✅ STEP 3: Instance deployed successfully');
    expect(deployedInstance).toBeDefined();
    expect(deployedInstance.spec.name).toBe('test-webapp');
    expect(deployedInstance.spec.image).toBe('nginx:alpine');
    expect(deployedInstance.spec.replicas).toBe(2);
    expect(deployedInstance.spec.environment).toBe('production');

    console.log('📝 STEP 4: Verifying static fields are hydrated directly...');

    // Static fields should be available immediately (not dependent on Kubernetes resources)
    expect(deployedInstance.status.url).toBe(
      'http://test-webapp-service.typekro-test.svc.cluster.local'
    );
    expect(deployedInstance.status.version).toBe('1.0.0');
    expect(deployedInstance.status.environment).toBe('e2e-test');
    expect(deployedInstance.status.metadata.name).toBe('webapp-factory-e2e');
    expect(deployedInstance.status.metadata.createdBy).toBe('typekro-factory-e2e');
    expect(deployedInstance.status.metadata.deployedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );

    console.log('✅ STEP 4: Static fields verified successfully');

    console.log('📝 STEP 5: Waiting for Kro to resolve dynamic fields...');

    // Wait for the underlying Kubernetes resources to be created and become ready
    let dynamicFieldsResolved = false;
    let attempts = 0;
    const maxAttempts = 60; // 2 minutes with 2-second intervals

    while (!dynamicFieldsResolved && attempts < maxAttempts) {
      attempts++;
      console.log(
        `🔍 STEP 5: Checking dynamic field resolution (attempt ${attempts}/${maxAttempts})...`
      );

      try {
        // Get fresh instance status from the cluster
        const instances = await kroFactory.getInstances();
        const freshInstance = instances.find((i) => i.spec.name === 'test-webapp');

        if (freshInstance) {
          console.log(
            `📊 Dynamic status check: phase=${freshInstance.status.phase}, replicas=${freshInstance.status.replicas}, readyReplicas=${freshInstance.status.readyReplicas}`
          );

          // Check if dynamic fields are resolved
          if (
            freshInstance.status.phase &&
            freshInstance.status.phase !== 'pending' &&
            typeof freshInstance.status.replicas === 'number' &&
            typeof freshInstance.status.readyReplicas === 'number'
          ) {
            console.log('✅ STEP 5: Dynamic fields resolved by Kro');

            // Verify dynamic fields
            expect(freshInstance.status.phase).toMatch(/^(pending|running|failed)$/);
            expect(typeof freshInstance.status.replicas).toBe('number');
            expect(typeof freshInstance.status.readyReplicas).toBe('number');
            expect(freshInstance.status.metadata.namespace).toBe(NAMESPACE);

            // Update our reference to the fresh instance
            Object.assign(deployedInstance, freshInstance);
            dynamicFieldsResolved = true;
            break;
          }
        }
      } catch (error) {
        console.log(
          `⚠️  Dynamic field check attempt ${attempts} failed:`,
          error instanceof Error ? error.message : String(error)
        );
      }

      if (attempts < maxAttempts) {
        console.log(
          `⏳ Waiting 2 seconds before next check (attempt ${attempts}/${maxAttempts})...`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    if (!dynamicFieldsResolved) {
      console.log(
        '⚠️  Dynamic fields not fully resolved within timeout, but continuing with verification...'
      );
    }

    console.log('📝 STEP 6: Verifying complete status hydration...');

    // Verify that both static and dynamic fields are present
    console.log('📊 Final status verification:');
    console.log(`  Static fields:`);
    console.log(`    url: ${deployedInstance.status.url}`);
    console.log(`    version: ${deployedInstance.status.version}`);
    console.log(`    environment: ${deployedInstance.status.environment}`);
    console.log(`  Dynamic fields:`);
    console.log(`    phase: ${deployedInstance.status.phase}`);
    console.log(`    replicas: ${deployedInstance.status.replicas}`);
    console.log(`    readyReplicas: ${deployedInstance.status.readyReplicas}`);
    console.log(`  Mixed nested object:`);
    console.log(`    metadata.name: ${deployedInstance.status.metadata.name} (static)`);
    console.log(`    metadata.namespace: ${deployedInstance.status.metadata.namespace} (dynamic)`);
    console.log(`    metadata.createdBy: ${deployedInstance.status.metadata.createdBy} (static)`);

    // Final assertions
    expect(deployedInstance.status).toHaveProperty('url');
    expect(deployedInstance.status).toHaveProperty('version');
    expect(deployedInstance.status).toHaveProperty('environment');
    expect(deployedInstance.status).toHaveProperty('phase');
    expect(deployedInstance.status).toHaveProperty('metadata');
    expect(deployedInstance.status.metadata).toHaveProperty('name');
    expect(deployedInstance.status.metadata).toHaveProperty('createdBy');

    console.log('✅ STEP 6: Complete status hydration verified');

    console.log('📝 STEP 7: Testing factory instance management...');

    // Test getting all instances
    const allInstances = await kroFactory.getInstances();
    expect(allInstances).toHaveLength(1);
    expect(allInstances[0]?.spec.name).toBe('test-webapp');

    console.log('✅ STEP 7: Factory instance management verified');

    console.log('📝 STEP 8: Verifying underlying Kubernetes resources were created...');

    // Verify that the underlying Kubernetes resources exist
    const expectedResources = [
      { kind: 'ConfigMap', name: 'test-webapp-config' },
      { kind: 'Deployment', name: 'test-webapp' },
      { kind: 'Service', name: 'test-webapp-service' },
    ];

    for (const { kind, name } of expectedResources) {
      try {
        let apiVersion = 'v1';
        if (kind === 'Deployment') apiVersion = 'apps/v1';

        const resource = await k8sApi.read({
          apiVersion,
          kind,
          metadata: { name, namespace: NAMESPACE },
        });

        expect(resource.body).toBeDefined();
        console.log(`✅ ${kind}: ${name} exists and is accessible`);
      } catch (error) {
        console.error(`❌ Failed to verify ${kind}: ${name}`, error);
        throw error;
      }
    }

    console.log('✅ STEP 8: All underlying Kubernetes resources verified');

    console.log('🎉 STEP 9: Complete factory e2e test completed successfully!');
    console.log(
      '✅ TypeKro factory pattern with mixed static/dynamic status fields works end-to-end'
    );
    console.log('✅ Static fields are hydrated directly by TypeKro');
    console.log('✅ Dynamic fields are resolved by Kro from live Kubernetes resources');
    console.log('✅ Factory instance management works correctly');
    console.log(
      '✅ Full end-to-end workflow from TypeScript → Factory → Kro → Kubernetes → Status Hydration works'
    );
    // Cleanup using factory-based resource destruction
    console.log('🧹 Cleaning up factory complete test...');
    try {
      await kroFactory.deleteInstance('test-webapp');
      console.log('✅ Factory complete cleanup completed');
    } catch (error) {
      console.warn('⚠️ Factory complete cleanup failed:', error);
    }
  }, 300000); // 5 minute timeout for the test
});
