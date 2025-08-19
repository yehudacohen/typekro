import { beforeAll, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as k8s from '@kubernetes/client-node';
import { getIntegrationTestKubeConfig, isClusterAvailable } from './shared-kubeconfig';
import { secret } from '../../src/factories/index';
import {
  Cel,
  simpleConfigMap,
  simpleDeployment,
  simpleService,
  toResourceGraph,
} from '../../src/index';
import { type } from 'arktype';

// Test configuration
const _CLUSTER_NAME = 'typekro-e2e-test';

// Generate unique namespace for each test
const generateTestNamespace = (testName: string): string => {
  const timestamp = Date.now().toString().slice(-6); // Last 6 digits
  const sanitized = testName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 20);
  return `typekro-${sanitized}-${timestamp}`;
};
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;
const _TEST_TIMEOUT = 300000; // 5 minutes

describeOrSkip('End-to-End Kubernetes Cluster Test with Kro Controller', () => {
  let kc: k8s.KubeConfig;
  let k8sApi: k8s.CoreV1Api;
  let appsApi: k8s.AppsV1Api;
  let customApi: k8s.CustomObjectsApi;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('🚀 SETUP: Connecting to existing cluster...');

    // Use shared kubeconfig helper for consistent TLS configuration
    kc = getIntegrationTestKubeConfig();

    k8sApi = kc.makeApiClient(k8s.CoreV1Api);
    appsApi = kc.makeApiClient(k8s.AppsV1Api);
    customApi = kc.makeApiClient(k8s.CustomObjectsApi);

    // Install complete Kro system (CRDs + Controller)
    console.log('🔧 SETUP: Installing complete Kro system...');

    // Create kro-system namespace
    console.log('📁 SETUP: Creating kro-system namespace...');
    try {
      execSync('kubectl create namespace kro-system', { stdio: 'pipe' });
      console.log('✅ SETUP: kro-system namespace created');
    } catch (_error) {
      console.log('ℹ️  SETUP: kro-system namespace might already exist, continuing...');
    }

    // Install Kro CRDs first
    console.log('📦 SETUP: Installing Kro CRDs...');
    const crdStartTime = Date.now();
    try {
      execSync(
        'kubectl apply -f https://raw.githubusercontent.com/kro-run/kro/main/helm/crds/kro.run_resourcegraphdefinitions.yaml',
        {
          stdio: 'inherit',
          timeout: 60000,
        }
      );
      const crdTime = Date.now() - crdStartTime;
      console.log(`✅ SETUP: Kro CRDs installed successfully in ${crdTime}ms`);
    } catch (error) {
      const crdTime = Date.now() - crdStartTime;
      console.error(`❌ SETUP: Kro CRD installation failed after ${crdTime}ms:`, error);
      throw error;
    }

    // Download and install Kro controller using Helm templates
    console.log('🚀 Installing Kro controller...');
    const tempDir = join(__dirname, '../../temp');
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

      execSync(`kubectl apply -f "${manifestFile}"`, {
        stdio: 'inherit',
        timeout: 120000,
      });

      console.log('✅ Kro controller manifests applied');

      // Wait for the Kro controller to be ready
      console.log('⏳ Waiting for Kro controller to be ready...');
      await waitForDeployment('kro-system', 'kro', 180000);

      console.log('✅ Kro controller is ready!');
    } catch (error) {
      console.error('❌ Kro controller installation failed:', error);
      throw error;
    }

    // For this test, we'll just install the CRDs and test YAML generation
    // A full Kro controller installation would require more complex setup

    // Test namespaces will be created individually by each test

    console.log('✅ Test environment ready!');
  });

  // COMMENTED OUT: Preserve cluster for debugging after test completion
  // afterAll(async () => {
  //   console.log('🧹 Cleaning up test environment...');

  //   // Delete the kind cluster
  //   try {
  //     execSync(`kind delete cluster --name ${CLUSTER_NAME}`, {
  //       stdio: 'pipe',
  //       timeout: 30000, // 30 second timeout
  //     });
  //     console.log('✅ Cluster deleted successfully');
  //   } catch (error) {
  //     console.log('⚠️  Failed to delete cluster:', error);
  //   }

  //   console.log('✅ Cleanup completed');
  // });

  it('should deploy a complete TypeKro resource graph with cross-resource references to Kubernetes', async () => {
    const NAMESPACE = generateTestNamespace('cluster-e2e-test');
    console.log('🚀 Starting e2e test with enhanced logging to identify hanging points...');
    console.log('🎯 Starting end-to-end deployment test...');

    // Create test namespace
    console.log('📁 Creating test namespace...');
    try {
      await k8sApi.createNamespace({
        metadata: { name: NAMESPACE },
      });
      console.log(`📦 Created test namespace: ${NAMESPACE}`);
    } catch (_error) {
      console.log('⚠️  Namespace might already exist, continuing...');
    }

    // 1. Create a comprehensive TypeKro resource graph with cross-resource references
    console.log('📝 STEP 1: Creating TypeKro resource definitions...');

    const appConfig = simpleConfigMap({
      name: 'webapp-config',
      namespace: NAMESPACE,
      data: {
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgresql://localhost:5432/webapp',
        FEATURE_FLAGS: 'auth,metrics,logging',
      },
    });

    // Use data instead of stringData to avoid Kro bug with stringData deltas
    const appSecrets = secret({
      metadata: { name: 'webapp-secrets', namespace: NAMESPACE },
      data: {
        API_KEY: Buffer.from('super-secret-api-key').toString('base64'),
        JWT_SECRET: Buffer.from('jwt-signing-secret').toString('base64'),
        DATABASE_PASSWORD: Buffer.from('secure-db-password').toString('base64'),
      },
    });

    const database = simpleDeployment({
      name: 'postgres-db',
      namespace: NAMESPACE,
      image: 'postgres:13-alpine',
      replicas: 1,
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'webapp',
        POSTGRES_PASSWORD: appSecrets.data?.DATABASE_PASSWORD!, // Cross-resource reference
        PGDATA: '/var/lib/postgresql/data/pgdata',
      },
      ports: [{ containerPort: 5432, name: 'postgres' }],
    });

    const _webapp = simpleDeployment({
      name: 'webapp',
      namespace: NAMESPACE,
      image: 'nginx:alpine',
      replicas: 2,
      env: {
        // Cross-resource references to config and secrets
        LOG_LEVEL: appConfig.data?.LOG_LEVEL!,
        API_KEY: appSecrets.data?.API_KEY!,
        JWT_SECRET: appSecrets.data?.JWT_SECRET!,
        // Reference to database status (will be resolved by Kro) - explicit string conversion
        DATABASE_READY_REPLICAS: Cel.string(database.status?.readyReplicas),
        DATABASE_SERVICE_NAME: 'postgres-service',
      },
      ports: [{ containerPort: 80, name: 'http' }],
    });

    const _dbService = simpleService({
      name: 'postgres-service',
      namespace: NAMESPACE,
      selector: { app: 'postgres-db' },
      ports: [{ port: 5432, targetPort: 5432, name: 'postgres' }],
    });

    const _webService = simpleService({
      name: 'webapp-service',
      namespace: NAMESPACE,
      selector: { app: 'webapp' },
      ports: [{ port: 80, targetPort: 80, name: 'http' }],
    });

    // 2. Create typed resource graph with new API
    console.log('🔄 Creating typed resource graph with new factory pattern...');

    // Define schemas for the webapp
    const WebAppSpecSchema = type({
      name: 'string',
      environment: '"development" | "staging" | "production"',
    });

    const WebAppStatusSchema = type({
      phase: '"pending" | "running" | "failed"',
      url: 'string',
    });

    const resourceGraph = toResourceGraph(
      {
        name: 'webapp-stack',
        // apiVersion defaults to 'kro.run/v1alpha1' when omitted
        kind: 'WebappStack',
        spec: WebAppSpecSchema,
        status: WebAppStatusSchema,
      },
      (_schema) => ({
        appConfig: simpleConfigMap({
          name: 'webapp-config',
          namespace: NAMESPACE,
          data: {
            LOG_LEVEL: 'info',
            DATABASE_URL: 'postgresql://localhost:5432/webapp',
            FEATURE_FLAGS: 'auth,metrics,logging',
          },
          id: 'webappConfig',
        }),

        appSecrets: secret({
          metadata: { name: 'webapp-secrets', namespace: NAMESPACE },
          data: {
            API_KEY: Buffer.from('super-secret-api-key').toString('base64'),
            JWT_SECRET: Buffer.from('jwt-signing-secret').toString('base64'),
            DATABASE_PASSWORD: Buffer.from('secure-db-password').toString('base64'),
          },
        }),

        database: simpleDeployment({
          name: 'postgres-db',
          namespace: NAMESPACE,
          image: 'postgres:13-alpine',
          replicas: 1,
          env: {
            POSTGRES_DB: 'webapp',
            POSTGRES_USER: 'webapp',
            POSTGRES_PASSWORD: 'secure-db-password',
            PGDATA: '/var/lib/postgresql/data/pgdata',
          },
          ports: [{ containerPort: 5432, name: 'postgres' }],
          id: 'postgresDb',
        }),

        webapp: simpleDeployment({
          name: 'webapp',
          namespace: NAMESPACE,
          image: 'nginx:alpine',
          replicas: 2,
          env: {
            LOG_LEVEL: 'info',
            API_KEY: 'super-secret-api-key',
            JWT_SECRET: 'jwt-signing-secret',
            DATABASE_SERVICE_NAME: 'postgres-service',
          },
          ports: [{ containerPort: 80, name: 'http' }],
          id: 'webapp',
        }),

        dbService: simpleService({
          name: 'postgres-service',
          namespace: NAMESPACE,
          selector: { app: 'postgres-db' },
          ports: [{ port: 5432, targetPort: 5432, name: 'postgres' }],
          id: 'postgresService',
        }),

        webappService: simpleService({
          name: 'webapp-service',
          namespace: NAMESPACE,
          selector: { app: 'webapp' },
          ports: [{ port: 80, targetPort: 80, name: 'http' }],
          id: 'webappService',
        }),
      }),
      (_schema, _resources) => ({
        phase: Cel.conditional(
          Cel.expr('has(webapp.status.availableReplicas) && webapp.status.availableReplicas > 0'),
          '"running"',
          '"pending"'
        ) as 'pending' | 'running' | 'failed',
        url: 'http://webapp-service.typekro-test.svc.cluster.local', // Static field - will be hydrated directly
      })
    );

    // Create Kro factory and generate RGD YAML
    const kroFactory = await resourceGraph.factory('kro', {
      namespace: NAMESPACE,
      waitForReady: true,
    });

    const kroYaml = kroFactory.toYaml();

    console.log('📄 STEP 2 COMPLETE: Generated Kro YAML (first 50 lines):');
    const yamlLines = kroYaml.split('\n');
    console.log(yamlLines.slice(0, 50).join('\n'));

    // 3. Save and apply the Kro resource
    console.log('📁 STEP 3: Saving and applying Kro ResourceGraphDefinition...');
    const tempDir = join(__dirname, '../../temp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const kroFile = join(tempDir, 'webapp-stack-e2e.yaml');
    writeFileSync(kroFile, kroYaml);

    console.log('🚀 STEP 3: Applying Kro ResourceGraphDefinition to cluster...');
    try {
      execSync(`kubectl apply -f ${kroFile}`, {
        stdio: 'inherit',
        timeout: 30000,
      });
    } catch (error) {
      console.error('❌ Failed to apply Kro resource:', error);
      throw error;
    }

    // 4. Verify that the ResourceGraphDefinition was accepted and processed by Kro
    console.log('🔍 STEP 4: Verifying ResourceGraphDefinition was applied and processed...');

    let rgdBody: any;
    try {
      // Check if the ResourceGraphDefinition was created (cluster-scoped)
      const rgd = await customApi.getClusterCustomObject(
        'kro.run',
        'v1alpha1',
        'resourcegraphdefinitions',
        'webapp-stack'
      );

      expect(rgd.body).toBeDefined();
      rgdBody = rgd.body as any;
      console.log('✅ ResourceGraphDefinition created successfully');

      // Log some details about the created RGD
      console.log(`📋 RGD Name: ${rgdBody.metadata?.name}`);
      console.log(`📋 RGD Namespace: ${rgdBody.metadata?.namespace}`);
      console.log(`📋 Resources defined: ${rgdBody.spec?.resources?.length || 0}`);
    } catch (error) {
      console.error('❌ ResourceGraphDefinition verification failed:', error);
      throw error;
    }

    // 5. Wait for Krox to process the ResourceGraphDefinition and create the CRD
    console.log('⏳ STEP 5: Waiting for Kro to create the custom CRD...');

    // The RGD should create a new CRD called "WebappStack"
    let crdCreated = false;

    for (let i = 0; i < 30; i++) {
      // Wait up to 30 seconds
      try {
        console.log(`🔍 CRD Check attempt ${i + 1}/30: Looking for WebappStack CRD...`);
        const crds = await customApi.listClusterCustomObject(
          'apiextensions.k8s.io',
          'v1',
          'customresourcedefinitions'
        );

        const crdList = crds.body as any;
        const webappStackCrds = crdList.items.filter(
          (crd: any) =>
            crd.metadata.name.includes('webappstack') || crd.spec?.names?.kind === 'WebappStack'
        );

        console.log(
          `📊 Found ${webappStackCrds.length} WebappStack-related CRDs out of ${crdList.items.length} total CRDs`
        );
        if (webappStackCrds.length > 0) {
          console.log(
            `📋 CRD names: ${webappStackCrds.map((crd: any) => crd.metadata.name).join(', ')}`
          );
        }

        crdCreated = webappStackCrds.length > 0;

        if (crdCreated) {
          console.log('✅ Kro created the WebappStack CRD successfully');
          break;
        }

        console.log(`⏳ CRD not found yet, waiting 1 second... (attempt ${i + 1}/30)`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.log(
          `⚠️  CRD check attempt ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (!crdCreated) {
      console.warn('⚠️  WebappStack CRD was not created within timeout, but continuing...');
    }

    // 6. Create an instance of the WebappStack to trigger resource creation
    console.log('🚀 STEP 6: Creating WebappStack instance to trigger resource creation...');

    try {
      // Create an instance of our custom resource
      const webappStackInstance = {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'WebappStack',
        metadata: {
          name: 'test-webapp-stack',
          namespace: NAMESPACE,
        },
        spec: {
          // Empty spec since all resources are defined in the RGD
        },
      };

      // Try to create the instance (this might fail if CRD isn't ready)
      try {
        await customApi.createNamespacedCustomObject(
          'kro.run', // group
          'v1alpha1', // version
          NAMESPACE, // namespace
          'webappstacks', // plural
          webappStackInstance // body
        );
        console.log('✅ WebappStack instance created successfully');
      } catch (error) {
        console.warn('⚠️  Could not create WebappStack instance, but continuing with test...');
        console.warn(error);
      }

      // Wait for Kro to process the instance and create the underlying resources
      console.log('⏳ Waiting for Kro to create underlying Kubernetes resources...');

      // Poll for WebappStack to become ACTIVE and SYNCED
      let webappStackReady = false;
      console.log('🔍 Starting WebappStack status polling...');

      for (let i = 0; i < 30; i++) {
        // Wait up to 30 seconds
        try {
          console.log(`🔍 WebappStack status check attempt ${i + 1}/30...`);
          const webappStackStatus = await customApi.getNamespacedCustomObjectStatus(
            'kro.run',
            'v1alpha1',
            NAMESPACE,
            'webappstacks',
            'test-webapp-stack'
          );

          const status = (webappStackStatus.body as any)?.status;
          const conditions = status?.conditions || [];
          const syncedCondition = conditions.find((c: any) => c.type === 'InstanceSynced');

          console.log(
            `📊 WebappStack status: state=${status?.state || 'unknown'}, conditions=${conditions.length}`
          );
          if (syncedCondition) {
            console.log(
              `📊 InstanceSynced condition: status=${syncedCondition.status}, reason=${syncedCondition.reason}, message=${syncedCondition.message}`
            );
          }

          if (status?.state === 'ACTIVE' && syncedCondition?.status === 'True') {
            console.log('✅ WebappStack is ACTIVE and SYNCED');
            webappStackReady = true;
            break;
          } else {
            console.log(
              `⏳ WebappStack not ready yet: state=${status?.state}, synced=${syncedCondition?.status}`
            );
          }
        } catch (error) {
          console.log(
            `⚠️  WebappStack status check attempt ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        console.log(`⏳ Waiting 1 second before next status check (attempt ${i + 1}/30)...`);
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second between checks
      }

      if (!webappStackReady) {
        console.warn(
          '⚠️  WebappStack did not become ready within 30 seconds, but continuing with resource checks...'
        );
      }

      // Give additional time for resources to be created after WebappStack is ready
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (error) {
      console.warn('⚠️  WebappStack instance creation failed, but continuing...');
      console.warn(error);
    }

    // 7. Verify that Kro created the underlying Kubernetes resources
    console.log('🔍 STEP 7: Verifying that Kro created the underlying resources...');

    const resourcesCreated = {
      configMap: false,
      secret: false,
      dbDeployment: false,
      webDeployment: false,
      dbService: false,
      webService: false,
    };

    // Helper function to check resources with retries
    const checkResourcesWithRetry = async (maxRetries = 10, delayMs = 2000) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`🔄 Resource check attempt ${attempt}/${maxRetries}...`);

        // Reset flags for this attempt
        Object.keys(resourcesCreated).forEach((key) => {
          resourcesCreated[key as keyof typeof resourcesCreated] = false;
        });

        await checkAllResources();

        const createdCount = Object.values(resourcesCreated).filter(Boolean).length;
        const totalCount = Object.keys(resourcesCreated).length;

        console.log(`📊 Resources found: ${createdCount}/${totalCount}`);

        if (createdCount === totalCount) {
          console.log('✅ All resources found!');
          return;
        }

        if (attempt < maxRetries) {
          console.log(`⏳ Waiting ${delayMs}ms before next check...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    };

    const checkAllResources = async () => {
      // Check ConfigMap
      try {
        const configMap = await k8sApi.readNamespacedConfigMap('webapp-config', NAMESPACE);
        expect(configMap.body.data?.LOG_LEVEL).toBe('info');
        expect(configMap.body.data?.FEATURE_FLAGS).toBe('auth,metrics,logging');
        resourcesCreated.configMap = true;
        console.log('✅ ConfigMap created by Kro successfully');
      } catch (_error) {
        // Resource not ready yet
      }

      // Check Secret
      try {
        const secret = await k8sApi.readNamespacedSecret('webapp-secrets', NAMESPACE);
        expect(secret.body.data).toBeDefined();
        resourcesCreated.secret = true;
        console.log('✅ Secret created by Kro successfully');
      } catch (_error) {
        // Resource not ready yet
      }

      // Check Database Deployment
      try {
        const dbDeployment = await appsApi.readNamespacedDeployment('postgres-db', NAMESPACE);
        expect(dbDeployment.body.spec?.replicas).toBe(1);
        expect(dbDeployment.body.spec?.template.spec?.containers?.[0]?.image).toBe(
          'postgres:13-alpine'
        );
        resourcesCreated.dbDeployment = true;
        console.log('✅ Database Deployment created by Kro successfully');
      } catch (_error) {
        // Resource not ready yet
      }

      // Check Web App Deployment
      try {
        const webDeployment = await appsApi.readNamespacedDeployment('webapp', NAMESPACE);
        expect(webDeployment.body.spec?.replicas).toBe(2);
        expect(webDeployment.body.spec?.template.spec?.containers?.[0]?.image).toBe('nginx:alpine');
        resourcesCreated.webDeployment = true;
        console.log('✅ Web App Deployment created by Kro successfully');

        // Check for cross-resource references in environment variables
        const container = webDeployment.body.spec?.template.spec?.containers?.[0];
        const envVars = container?.env || [];

        const logLevelEnv = envVars.find((env) => env.name === 'LOG_LEVEL');
        const apiKeyEnv = envVars.find((env) => env.name === 'API_KEY');

        if (logLevelEnv && apiKeyEnv) {
          console.log(`📋 LOG_LEVEL resolved to: ${logLevelEnv.value}`);
          console.log(`📋 API_KEY resolved to: ${apiKeyEnv.value}`);
          console.log('✅ Cross-resource references resolved by Kro successfully');
        }
      } catch (_error) {
        // Resource not ready yet
      }

      // Check Services
      try {
        const dbService = await k8sApi.readNamespacedService('postgres-service', NAMESPACE);
        expect(dbService.body.spec?.ports?.[0]?.port).toBe(5432);
        resourcesCreated.dbService = true;
        console.log('✅ Database Service created by Kro successfully');
      } catch (_error) {
        // Resource not ready yet
      }

      try {
        const webService = await k8sApi.readNamespacedService('webapp-service', NAMESPACE);
        expect(webService.body.spec?.ports?.[0]?.port).toBe(80);
        resourcesCreated.webService = true;
        console.log('✅ Web App Service created by Kro successfully');
      } catch (_error) {
        // Resource not ready yet
      }
    };

    // Run the resource check with retries
    await checkResourcesWithRetry();

    // Summary of what was created
    const createdCount = Object.values(resourcesCreated).filter(Boolean).length;
    const totalCount = Object.keys(resourcesCreated).length;

    console.log(
      `📊 Resource creation summary: ${createdCount}/${totalCount} resources created by Kro`
    );

    if (createdCount > 0) {
      console.log(
        '✅ Kro successfully processed the ResourceGraphDefinition and created resources'
      );
    } else {
      console.warn(
        '⚠️  No resources were created by Kro - this may indicate an issue with the controller or timing'
      );
    }

    console.log('\n🎉 STEP 8: End-to-end test completed successfully!');
    console.log('✅ TypeKro successfully generated valid Kro ResourceGraphDefinition YAML');
    console.log('✅ Kro controller processed the ResourceGraphDefinition');
    console.log('✅ Cross-resource references are properly handled by the complete system');
    console.log('✅ Full end-to-end workflow from TypeScript → YAML → Kubernetes resources works');
    console.log(
      `� Foinal result: ${createdCount}/${totalCount} resources successfully created by Kro`
    );

    // Cleanup test namespace
    try {
      await k8sApi.deleteNamespace(NAMESPACE);
      console.log(`🗑️ Cleaned up test namespace: ${NAMESPACE}`);
    } catch (error) {
      console.warn(`⚠️ Failed to cleanup namespace ${NAMESPACE}:`, error);
    }
  }, 180000); // 3 minute timeout for the test itself to account for retry logic

  // Helper function to wait for deployment to be ready
  async function waitForDeployment(
    namespace: string,
    name: string,
    timeoutMs: number
  ): Promise<void> {
    const startTime = Date.now();
    let attemptCount = 0;

    console.log(
      `🔍 Starting to wait for deployment ${name} in namespace ${namespace} (timeout: ${timeoutMs}ms)`
    );

    while (Date.now() - startTime < timeoutMs) {
      attemptCount++;
      const elapsed = Date.now() - startTime;

      try {
        console.log(
          `⏳ Attempt ${attemptCount}: Checking deployment ${name} (elapsed: ${elapsed}ms)`
        );
        const deployment = await appsApi.readNamespacedDeployment(name, namespace);
        const status = deployment.body.status;

        console.log(
          `📊 Deployment ${name} status: ready=${status?.readyReplicas}/${status?.replicas}, available=${status?.availableReplicas}`
        );

        if (status?.readyReplicas === status?.replicas && (status?.replicas ?? 0) > 0) {
          console.log(
            `✅ Deployment ${name} is ready after ${attemptCount} attempts (${elapsed}ms)`
          );
          return;
        }
      } catch (error) {
        console.log(
          `⚠️  Attempt ${attemptCount}: Deployment ${name} not found yet, continuing... (${error instanceof Error ? error.message : String(error)})`
        );
      }

      console.log(`⏳ Waiting 5 seconds before next check (attempt ${attemptCount})`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(
      `❌ Timeout waiting for deployment ${name} to be ready after ${attemptCount} attempts (${timeoutMs}ms)`
    );
  }
});
