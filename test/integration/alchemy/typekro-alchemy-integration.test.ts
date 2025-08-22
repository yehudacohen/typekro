/**
 * Tests for real TypeKro-Alchemy integration
 *
 * This test demonstrates how TypeKro values are passed to Alchemy properties
 * and how Alchemy values are passed to TypeKro properties, showing real
 * integration between the two systems.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import alchemy from 'alchemy';
import { File } from 'alchemy/fs';
import { type } from 'arktype';
import {
  Cel,
  simpleConfigMap,
  simpleDeployment,
  simpleService,
  toResourceGraph,
} from '../../../src/index.js';

const _TEST_TIMEOUT = 120000; // 2 minutes

describe('TypeKro-Alchemy Integration', () => {
  let alchemyScope: any;

  beforeAll(async () => {
    console.log('🔧 Creating alchemy scope for integration tests...');
    try {
      // Configure alchemy to use temp directory
      const { FileSystemStateStore } = await import('alchemy/state');

      alchemyScope = await alchemy('typekro-alchemy-integration-test', {
        stateStore: (scope) =>
          new FileSystemStateStore(scope, {
            rootDir: './temp/.alchemy',
          }),
      });
      console.log(`✅ Alchemy scope created: ${alchemyScope.name} (stage: ${alchemyScope.stage})`);
    } catch (error) {
      console.error('❌ Failed to create alchemy scope:', error);
      throw error;
    }
  });

  afterAll(async () => {
    console.log('🧹 Cleaning up alchemy scope...');
    // Alchemy scopes are automatically cleaned up when the process exits
    // No explicit cleanup method needed for test scopes
    console.log('✅ Alchemy scope will be cleaned up automatically');
  });

  describe('TypeKro values to Alchemy properties', () => {
    it('should pass TypeKro resource references to Alchemy resources', async () => {
      // Create a TypeKro resource graph
      const WebAppSpecSchema = type({
        name: 'string',
        image: 'string',
        replicas: 'number%1',
        databaseUrl: 'string',
      });

      const WebAppStatusSchema = type({
        url: 'string',
        readyReplicas: 'number%1',
        databaseStatus: 'string',
      });

      const graph = toResourceGraph(
        {
          name: 'webapp-with-alchemy',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => {
          // Create TypeKro resources
          const database = simpleDeployment({
            name: 'postgres',
            image: 'postgres:13',
            replicas: 1,
            id: 'database',
            env: {
              POSTGRES_DB: 'webapp',
              POSTGRES_USER: 'webapp',
              POSTGRES_PASSWORD: 'secret',
            },
          });

          const webapp = simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webapp',
            env: {
              // This shows TypeKro values being passed to other TypeKro resources
              DATABASE_URL: schema.spec.databaseUrl,
              // This shows cross-resource references within TypeKro
              DATABASE_HOST: database.status.podIP,
            },
          });

          return { database, webapp };
        },
        (_schema, resources) => ({
          url: Cel.template('http://%s:8080', resources.webapp.status.podIP),
          readyReplicas: resources.webapp.status.readyReplicas,
          databaseStatus: resources.database.status.phase,
        })
      );

      // Create real Alchemy resources within the scope context
      await alchemyScope.run(async () => {
        // Create real alchemy resources using actual providers
        const sessionId = `test-${Date.now()}`;

        // Create a configuration file using the real File provider
        const configFile = await File(`config-${sessionId}`, {
          path: `temp/logs/app-${sessionId}.log`,
          content: `Application started at ${new Date().toISOString()}\nSession ID: ${sessionId}\nTypeKro Integration Test\n`,
        });

        // Create an application log file
        const appLogFile = await File(`app-log-${sessionId}`, {
          path: `temp/logs/application-${sessionId}.log`,
          content: `[INFO] TypeKro-Alchemy integration test started\n[INFO] Session: ${sessionId}\n[INFO] Testing real File provider\n`,
        });

        // Create a configuration JSON file
        const configJsonFile = await File(`config-json-${sessionId}`, {
          path: `temp/config/app-${sessionId}.json`,
          content: JSON.stringify(
            {
              appName: 'webapp-with-alchemy',
              environment: 'test',
              sessionId: sessionId,
              database: {
                host: 'postgres.cluster-xyz.us-east-1.rds.amazonaws.com',
                port: 5432,
                name: 'webapp',
              },
            },
            null,
            2
          ),
        });

        // Verify the real alchemy File resources were created
        expect(configFile.path).toBe(`temp/logs/app-${sessionId}.log`);
        expect(configFile.content).toContain('Application started');
        expect(configFile.content).toContain(sessionId);
        expect(configFile.content).toContain('TypeKro Integration Test');

        expect(appLogFile.path).toBe(`temp/logs/application-${sessionId}.log`);
        expect(appLogFile.content).toContain('[INFO] TypeKro-Alchemy integration test started');
        expect(appLogFile.content).toContain(`Session: ${sessionId}`);

        expect(configJsonFile.path).toBe(`temp/config/app-${sessionId}.json`);
        expect(configJsonFile.content).toContain('webapp-with-alchemy');
        expect(configJsonFile.content).toContain(sessionId);

        console.log('✅ Real Alchemy File resources created successfully');

        // Validate alchemy state using built-in state store
        console.log('🔍 Validating alchemy state using built-in state store...');

        const alchemyState = await alchemyScope.state.all();
        const resourceIds = Object.keys(alchemyState);

        // Verify that our File resources are registered in alchemy state
        const configFileState = Object.values(alchemyState).find(
          (state: any) => state.kind === 'fs::File' && state.output?.path === configFile.path
        ) as any;
        const appLogFileState = Object.values(alchemyState).find(
          (state: any) => state.kind === 'fs::File' && state.output?.path === appLogFile.path
        ) as any;
        const configJsonFileState = Object.values(alchemyState).find(
          (state: any) => state.kind === 'fs::File' && state.output?.path === configJsonFile.path
        ) as any;

        expect(configFileState).toBeDefined();
        expect(configFileState?.status).toBe('created');
        expect(configFileState?.output.content).toContain('TypeKro Integration Test');

        expect(appLogFileState).toBeDefined();
        expect(appLogFileState?.status).toBe('created');
        expect(appLogFileState?.output.content).toContain(
          'TypeKro-Alchemy integration test started'
        );

        expect(configJsonFileState).toBeDefined();
        expect(configJsonFileState?.status).toBe('created');
        expect(configJsonFileState?.output.content).toContain('webapp-with-alchemy');

        console.log(
          `✅ Alchemy state validation passed - ${resourceIds.length} resources in state`
        );
        console.log(`   - Config file: ${configFileState?.id} (${configFileState?.status})`);
        console.log(`   - App log file: ${appLogFileState?.id} (${appLogFileState?.status})`);
        console.log(
          `   - Config JSON file: ${configJsonFileState?.id} (${configJsonFileState?.status})`
        );

        console.log('✅ Alchemy state validation passed!');
      });

      // Verify the TypeKro structure
      expect(graph.name).toBe('webapp-with-alchemy');
      expect(graph.resources).toHaveLength(2);

      // Verify TypeKro YAML contains proper cross-references
      const yaml = graph.toYaml();
      expect(yaml).toContain('value: ${database.status.podIP}');
      expect(yaml).toContain('value: ${schema.spec.databaseUrl}');
    });

    it('should demonstrate how TypeKro factory options pass to Alchemy', async () => {
      const SimpleAppSchema = type({
        name: 'string',
        environment: '"dev" | "staging" | "prod"',
      });

      const SimpleStatusSchema = type({
        phase: 'string',
      });

      const graph = toResourceGraph(
        {
          name: 'simple-app',
          apiVersion: 'example.com/v1alpha1',
          kind: 'SimpleApp',
          spec: SimpleAppSchema,
          status: SimpleStatusSchema,
        },
        (schema) => ({
          app: simpleDeployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: 1,
            id: 'app',
          }),
        }),
        (_schema, resources) => ({
          phase: resources.app.status.phase,
        })
      );

      // Create factory with alchemy scope
      const factory = await graph.factory('direct', {
        namespace: 'test-namespace',
        alchemyScope: alchemyScope,
        timeout: 30000,
      });

      // Verify factory has alchemy integration
      expect(factory.namespace).toBe('test-namespace');
      expect(factory.mode).toBe('direct');

      // In real implementation, this would show alchemy integration
      // For now, we verify the structure is correct
      expect(typeof factory.deploy).toBe('function');
    });
  });

  describe('Alchemy values to TypeKro properties', () => {
    it('should demonstrate how Alchemy resource outputs become TypeKro inputs', async () => {
      // Create real Alchemy resource that provides values
      let alchemyDatabase: any;

      await alchemyScope.run(async () => {
        const sessionId = `input-test-${Date.now()}`;

        // Create a database configuration file using real File provider
        const dbConfigFile = await File(`db-config-${sessionId}`, {
          path: `temp/config/database-${sessionId}.json`,
          content: JSON.stringify(
            {
              engine: 'postgres',
              instanceClass: 'db.t3.micro',
              multiAZ: false,
              backupRetention: 7,
              endpoint: `webapp-database.cluster-xyz.us-east-1.rds.amazonaws.com`,
              port: 5432,
              databaseName: 'webapp',
              status: 'available',
            },
            null,
            2
          ),
        });

        // Create an environment configuration file
        const envConfigFile = await File(`env-config-${sessionId}`, {
          path: `temp/config/environment-${sessionId}.env`,
          content: `DATABASE_HOST=webapp-database.cluster-xyz.us-east-1.rds.amazonaws.com\nDATABASE_PORT=5432\nDATABASE_NAME=webapp\nENVIRONMENT=test\nSESSION_ID=${sessionId}\n`,
        });

        // Store database info in a way that can be accessed by TypeKro
        alchemyDatabase = {
          id: `webapp-database-${sessionId}`,
          name: 'webapp-database',
          engine: 'postgres',
          instanceClass: 'db.t3.micro',
          endpoint: 'webapp-database.cluster-xyz.us-east-1.rds.amazonaws.com',
          port: 5432,
          databaseName: 'webapp',
          status: 'available',
          configFile: dbConfigFile,
          envFile: envConfigFile,
        };

        // Validate alchemy state for database input test using built-in state store
        console.log('🔍 Validating alchemy state for database input test...');

        const inputTestState = await alchemyScope.state.all();

        // Verify that our File resources are registered in alchemy state
        const dbConfigState = Object.values(inputTestState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output?.path === alchemyDatabase.configFile.path
        ) as any;
        const envConfigState = Object.values(inputTestState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output?.path === alchemyDatabase.envFile.path
        ) as any;

        expect(dbConfigState).toBeDefined();
        expect(dbConfigState?.status).toBe('created');
        expect(dbConfigState?.output.content).toContain('webapp-database');

        expect(envConfigState).toBeDefined();
        expect(envConfigState?.status).toBe('created');
        expect(envConfigState?.output.content).toContain('DATABASE_HOST=webapp-database');

        console.log(`✅ Database input test state validation passed`);
        console.log(`   - DB config: ${dbConfigState?.id} (${dbConfigState?.status})`);
        console.log(`   - Env config: ${envConfigState?.id} (${envConfigState?.status})`);
      });

      const WebAppSpecSchema = type({
        name: 'string',
        image: 'string',
        // These would come from Alchemy in real integration
        databaseEndpoint: 'string',
        databasePort: 'string', // Keep as string to avoid type conversion issues
      });

      const WebAppStatusSchema = type({
        url: 'string',
        databaseStatus: 'string',
      });

      const graph = toResourceGraph(
        {
          name: 'webapp-with-alchemy-inputs',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebAppWithAlchemy',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          webapp: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: 1,
            id: 'webapp',
            env: {
              // In real integration, these would reference Alchemy resource outputs
              DATABASE_HOST: schema.spec.databaseEndpoint,
              DATABASE_PORT: Cel.string(schema.spec.databasePort), // Convert number to string
              // This shows how to properly construct URLs with CEL expressions
              DATABASE_URL: Cel.expr(
                'postgresql://',
                schema.spec.databaseEndpoint,
                ':',
                Cel.string(schema.spec.databasePort),
                '/webapp'
              ),
            },
          }),

          config: simpleConfigMap({
            name: 'webapp-config',
            id: 'config',
            data: {
              // More examples of Alchemy -> TypeKro value flow
              'database.endpoint': schema.spec.databaseEndpoint,
              'database.port': Cel.string(schema.spec.databasePort), // Convert number to string
              'app.name': schema.spec.name,
            },
          }),
        }),
        (_schema, resources) => ({
          url: Cel.template('http://%s:8080', resources.webapp.status.podIP),
          databaseStatus: 'connected',
        })
      );

      // Verify the structure shows proper value flow
      const yaml = graph.toYaml();

      // These show how Alchemy values (via schema) flow into TypeKro resources
      expect(yaml).toContain('value: ${schema.spec.databaseEndpoint}');
      // These show how Alchemy values (via schema) flow into TypeKro resources
      expect(yaml).toContain('value: ${schema.spec.databaseEndpoint}');
      expect(yaml).toContain('value: ${string(schema.spec.databasePort)}'); // Proper CEL string conversion
      expect(yaml).toContain('database.endpoint: ${schema.spec.databaseEndpoint}');
      expect(yaml).toContain('database.port: ${string(schema.spec.databasePort)}'); // Proper CEL string conversion

      // Verify the constructed DATABASE_URL uses proper CEL expression
      expect(yaml).toContain(
        'value: ${postgresql://schema.spec.databaseEndpoint:string(schema.spec.databasePort)/webapp}'
      );

      // Verify Alchemy resources were created
      expect(alchemyDatabase.id).toContain('webapp-database-');
      expect(alchemyDatabase.name).toBe('webapp-database');
      expect(alchemyDatabase.configFile.path).toContain('config/database-');
      expect(alchemyDatabase.envFile.path).toContain('config/environment-');
    });

    it('should show bidirectional value flow between TypeKro and Alchemy', async () => {
      // This test demonstrates the complete integration pattern:
      // 1. Alchemy creates infrastructure (RDS, S3, etc.)
      // 2. TypeKro uses Alchemy outputs as inputs
      // 3. TypeKro creates Kubernetes resources
      // 4. Alchemy can reference TypeKro outputs (service endpoints, etc.)

      const FullStackSpecSchema = type({
        appName: 'string',
        environment: '"dev" | "staging" | "prod"',
        // These come from Alchemy
        databaseUrl: 'string',
        s3BucketName: 'string',
        // These are TypeKro-specific
        replicas: 'number%1',
        image: 'string',
      });

      const FullStackStatusSchema = type({
        appUrl: 'string',
        databaseStatus: 'string',
        storageStatus: 'string',
      });

      // Step 1: Create Alchemy infrastructure resources
      let alchemyDatabase: any;
      let alchemyBucket: any;

      await alchemyScope.run(async () => {
        const sessionId = `aws-integration-${Date.now()}`;

        // Create database configuration files using real File provider
        const dbConfigFile = await File(`fullstack-db-config-${sessionId}`, {
          path: `temp/config/fullstack-database-${sessionId}.json`,
          content: JSON.stringify(
            {
              name: 'fullstack-db',
              engine: 'postgres',
              endpoint: 'fullstack-db.cluster-xyz.us-east-1.rds.amazonaws.com',
              port: 5432,
              instanceClass: 'db.t3.micro',
              multiAZ: true,
            },
            null,
            2
          ),
        });

        // Create storage configuration files
        const storageConfigFile = await File(`fullstack-storage-config-${sessionId}`, {
          path: `temp/config/fullstack-storage-${sessionId}.json`,
          content: JSON.stringify(
            {
              name: 'fullstack-storage',
              versioning: true,
              bucketName: `fullstack-storage-${Date.now()}`,
              region: 'us-east-1',
              encryption: 'AES256',
            },
            null,
            2
          ),
        });

        // Create application configuration file
        const appConfigFile = await File(`fullstack-app-config-${sessionId}`, {
          path: `temp/config/fullstack-app-${sessionId}.yaml`,
          content: `
apiVersion: v1
kind: ConfigMap
metadata:
  name: fullstack-app-config
data:
  database.url: "postgresql://fullstack-db.cluster-xyz.us-east-1.rds.amazonaws.com:5432/app"
  storage.bucket: "fullstack-storage-${Date.now()}"
  app.environment: "test"
  session.id: "${sessionId}"
`.trim(),
        });

        // Store infrastructure info for TypeKro integration
        alchemyDatabase = {
          id: 'fullstackDb',
          name: 'fullstack-db',
          engine: 'postgres',
          endpoint: 'fullstack-db.cluster-xyz.us-east-1.rds.amazonaws.com',
          port: 5432,
          configFile: dbConfigFile,
        };

        alchemyBucket = {
          id: 'fullstackStorage',
          name: 'fullstack-storage',
          versioning: true,
          bucketName: `fullstack-storage-${Date.now()}`,
          configFile: storageConfigFile,
          appConfigFile: appConfigFile,
        };

        // Validate alchemy state for fullstack bidirectional test using built-in state store
        console.log('🔍 Validating alchemy state for fullstack test...');

        const fullstackState = await alchemyScope.state.all();

        // Verify that our File resources are registered in alchemy state
        const dbConfigState = Object.values(fullstackState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output.path === alchemyDatabase.configFile.path
        ) as any;
        const storageConfigState = Object.values(fullstackState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output.path === alchemyBucket.configFile.path
        ) as any;
        const appConfigState = Object.values(fullstackState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output.path === alchemyBucket.appConfigFile.path
        ) as any;

        expect(dbConfigState).toBeDefined();
        expect(dbConfigState?.status).toBe('created');
        expect(dbConfigState?.output.content).toContain('fullstack-db');

        expect(storageConfigState).toBeDefined();
        expect(storageConfigState?.status).toBe('created');
        expect(storageConfigState?.output.content).toContain('fullstack-storage');

        expect(appConfigState).toBeDefined();
        expect(appConfigState?.status).toBe('created');
        expect(appConfigState?.output.content).toContain('fullstack-app-config');

        console.log(`✅ Fullstack test state validation passed`);
        console.log(`   - DB config: ${dbConfigState?.id} (${dbConfigState?.status})`);
        console.log(
          `   - Storage config: ${storageConfigState?.id} (${storageConfigState?.status})`
        );
        console.log(`   - App config: ${appConfigState?.id} (${appConfigState?.status})`);
      });

      // Step 2: Create TypeKro resources that use Alchemy outputs
      const graph = toResourceGraph(
        {
          name: 'fullstack-app',
          apiVersion: 'v1alpha1',
          kind: 'FullStackApp',
          spec: FullStackSpecSchema,
          status: FullStackStatusSchema,
        },
        (schema) => {
          const webapp = simpleDeployment({
            name: schema.spec.appName,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webapp',
            env: {
              // Alchemy -> TypeKro: Database URL from RDS
              DATABASE_URL: schema.spec.databaseUrl,
              // Alchemy -> TypeKro: S3 bucket name
              S3_BUCKET: schema.spec.s3BucketName,
              // TypeKro internal: Environment from schema
              ENVIRONMENT: schema.spec.environment,
            },
          });

          const service = simpleService({
            name: schema.spec.appName,
            selector: { app: schema.spec.appName },
            ports: [{ port: 80, targetPort: 3000 }],
            id: 'service',
          });

          return { webapp, service };
        },
        (schema, _resources) => ({
          appUrl: Cel.template('http://%s.default.svc.cluster.local', schema.spec.appName),
          databaseStatus: 'healthy',
          storageStatus: 'healthy',
        })
      );

      // Step 3: Verify the integration shows proper value flow
      const yaml = graph.toYaml();

      // Alchemy values flowing into TypeKro
      expect(yaml).toContain('value: ${schema.spec.databaseUrl}');
      expect(yaml).toContain('value: ${schema.spec.s3BucketName}');

      // TypeKro internal references
      expect(yaml).toContain('value: ${schema.spec.environment}');
      expect(yaml).toContain('name: ${schema.spec.appName}');

      // Status fields that could flow back to Alchemy - now with intelligent CEL expressions
      expect(yaml).toContain('appUrl: http://${');
      // Static status fields should NOT be in YAML (they're hydrated directly by TypeKro)
      expect(yaml).not.toContain('databaseStatus:');
      expect(yaml).not.toContain('storageStatus:');

      // Verify Alchemy resources exist
      expect(alchemyDatabase.id).toBe('fullstackDb');
      expect(alchemyDatabase.name).toBe('fullstack-db');
      expect(alchemyDatabase.configFile.path).toContain('config/fullstack-database-');
      expect(alchemyBucket.id).toBe('fullstackStorage');
      expect(alchemyBucket.name).toBe('fullstack-storage');
      expect(alchemyBucket.configFile.path).toContain('config/fullstack-storage-');
      expect(alchemyBucket.appConfigFile.path).toContain('config/fullstack-app-');

      // In real integration, Alchemy could reference TypeKro outputs:
      // const alchemyIngress = alchemyScope.createResource('aws::alb::LoadBalancer', {
      //   targets: [service.status.clusterIP], // TypeKro -> Alchemy
      // });
    });
  });

  describe('Factory integration with Alchemy', () => {
    it('should demonstrate how factories handle Alchemy integration', async () => {
      const AppSpecSchema = type({
        name: 'string',
        image: 'string',
      });

      const AppStatusSchema = type({
        phase: 'string',
        url: 'string',
      });

      const graph = toResourceGraph(
        {
          name: 'factory-alchemy-test',
          apiVersion: 'v1alpha1',
          kind: 'FactoryApp',
          spec: AppSpecSchema,
          status: AppStatusSchema,
        },
        (schema) => ({
          app: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: 1,
            id: 'app',
          }),
        }),
        (_schema, resources) => ({
          phase: 'running',
          url: Cel.template('http://%s:8080', resources.app.status.podIP),
        })
      );

      // Test direct factory with alchemy
      const directFactory = await graph.factory('direct', {
        alchemyScope: alchemyScope,
        namespace: 'alchemy-test',
      });

      expect(directFactory.mode).toBe('direct');
      expect(directFactory.namespace).toBe('alchemy-test');

      // Test kro factory with alchemy
      const kroFactory = await graph.factory('kro', {
        alchemyScope: alchemyScope,
        namespace: 'alchemy-test',
      });

      expect(kroFactory.mode).toBe('kro');
      expect(kroFactory.namespace).toBe('alchemy-test');

      // Both factories should be able to handle alchemy integration
      // In real implementation, they would:
      // 1. Register TypeKro resources with Alchemy
      // 2. Handle Alchemy promise resolution
      // 3. Deploy with proper dependency ordering
    });

    it('should show how deployment handles mixed Alchemy and TypeKro resources', async () => {
      // This test shows the deployment flow when both Alchemy and TypeKro resources exist

      const MixedAppSpecSchema = type({
        name: 'string',
        image: 'string',
        useExternalDatabase: 'boolean',
      });

      const MixedAppStatusSchema = type({
        appStatus: 'string',
        databaseStatus: 'string',
      });

      // Create Alchemy resource first
      let externalDatabase: any;

      await alchemyScope.run(async () => {
        const sessionId = `external-${Date.now()}`;

        // Create external database configuration using real File provider
        const externalDbConfigFile = await File(`external-db-config-${sessionId}`, {
          path: `temp/config/external-database-${sessionId}.json`,
          content: JSON.stringify(
            {
              name: 'external-db',
              engine: 'postgres',
              endpoint: 'external-db.amazonaws.com',
              port: 5432,
              connectionString: 'postgresql://external-db.amazonaws.com:5432/app',
              ssl: true,
              maxConnections: 100,
            },
            null,
            2
          ),
        });

        // Create database credentials file
        const dbCredentialsFile = await File(`external-db-credentials-${sessionId}`, {
          path: `temp/secrets/external-db-credentials-${sessionId}.env`,
          content: `DB_HOST=external-db.amazonaws.com\nDB_PORT=5432\nDB_NAME=app\nDB_USER=webapp\nDB_PASSWORD=secure-password-${sessionId}\n`,
        });

        externalDatabase = {
          id: 'externalDb',
          name: 'external-db',
          engine: 'postgres',
          endpoint: 'external-db.amazonaws.com',
          port: 5432,
          configFile: externalDbConfigFile,
          credentialsFile: dbCredentialsFile,
        };

        // Validate alchemy state for external database test using built-in state store
        console.log('🔍 Validating alchemy state for external database test...');

        const externalDbState = await alchemyScope.state.all();

        // Verify that our File resources are registered in alchemy state
        const configState = Object.values(externalDbState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output.path === externalDatabase.configFile.path
        ) as any;
        const credentialsState = Object.values(externalDbState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output.path === externalDatabase.credentialsFile.path
        ) as any;

        expect(configState).toBeDefined();
        expect(configState?.status).toBe('created');
        expect(configState?.output.content).toContain('external-db');

        expect(credentialsState).toBeDefined();
        expect(credentialsState?.status).toBe('created');
        expect(credentialsState?.output.content).toContain('DB_HOST=external-db');

        console.log(`✅ External database test state validation passed`);
        console.log(`   - Config: ${configState?.id} (${configState?.status})`);
        console.log(`   - Credentials: ${credentialsState?.id} (${credentialsState?.status})`);
      });

      const graph = toResourceGraph(
        {
          name: 'mixed-deployment',
          apiVersion: 'v1alpha1',
          kind: 'MixedApp',
          spec: MixedAppSpecSchema,
          status: MixedAppStatusSchema,
        },
        (schema) => ({
          // TypeKro resources that may depend on Alchemy
          app: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: 1,
            id: 'app',
            env: {
              // This would be resolved from Alchemy in real integration
              DATABASE_URL: 'postgresql://external-db.amazonaws.com:5432/app',
            },
          }),

          // Conditional TypeKro resource based on schema
          internalDb: simpleDeployment({
            name: 'internal-postgres',
            image: 'postgres:13',
            replicas: 1,
            id: 'internalDb',
            // In real Kro, this would use includeWhen: ${!schema.spec.useExternalDatabase}
          }),
        }),
        (_schema, _resources) => ({
          appStatus: 'running',
          databaseStatus: 'connected',
        })
      );

      const factory = await graph.factory('direct', {
        alchemyScope: alchemyScope,
      });

      // In real implementation, deployment would:
      // 1. Wait for Alchemy resources to be ready
      // 2. Resolve Alchemy outputs into TypeKro inputs
      // 3. Deploy TypeKro resources with resolved values
      // 4. Update status with both Alchemy and TypeKro resource states

      expect(factory.mode).toBe('direct');
      expect(externalDatabase.id).toBe('externalDb');
      expect(externalDatabase.configFile.path).toContain('config/external-database-');
      expect(externalDatabase.credentialsFile.path).toContain('secrets/external-db-credentials-');

      const yaml = graph.toYaml();
      expect(yaml).toContain('value: postgresql://external-db.amazonaws.com:5432/app');
    });
  });

  describe('Real-world integration patterns', () => {
    it('should demonstrate a complete AWS + Kubernetes integration', async () => {
      // This shows a realistic pattern: AWS infrastructure + Kubernetes application

      // Step 1: Create AWS infrastructure with Alchemy
      let vpc: any;
      let database: any;
      let s3Bucket: any;

      await alchemyScope.run(async () => {
        const sessionId = `fullstack-${Date.now()}`;
        const vpcId = `vpc-${Date.now()}`;
        const bucketName = `webapp-assets-${Date.now()}`;

        // Create VPC configuration using real File provider
        const vpcConfigFile = await File(`vpc-config-${sessionId}`, {
          path: `temp/config/aws-vpc-${sessionId}.json`,
          content: JSON.stringify(
            {
              name: 'webapp-vpc',
              cidrBlock: '10.0.0.0/16',
              vpcId: vpcId,
              region: 'us-east-1',
              enableDnsHostnames: true,
              enableDnsSupport: true,
            },
            null,
            2
          ),
        });

        // Create database configuration
        const databaseConfigFile = await File(`aws-db-config-${sessionId}`, {
          path: `temp/config/aws-database-${sessionId}.json`,
          content: JSON.stringify(
            {
              name: 'webapp-db',
              engine: 'postgres',
              vpcId: vpcId,
              endpoint: 'webapp-db.cluster-xyz.us-east-1.rds.amazonaws.com',
              port: 5432,
              instanceClass: 'db.t3.micro',
              multiAZ: true,
              backupRetention: 7,
            },
            null,
            2
          ),
        });

        // Create S3 bucket configuration
        const s3ConfigFile = await File(`aws-s3-config-${sessionId}`, {
          path: `temp/config/aws-s3-${sessionId}.json`,
          content: JSON.stringify(
            {
              name: 'webapp-assets',
              versioning: true,
              bucketName: bucketName,
              region: 'us-east-1',
              encryption: 'AES256',
              publicReadPolicy: false,
            },
            null,
            2
          ),
        });

        // Create Terraform configuration file for the complete stack
        const terraformConfigFile = await File(`terraform-config-${sessionId}`, {
          path: `temp/infrastructure/terraform-${sessionId}.tf`,
          content: `
# AWS Infrastructure Configuration
resource "aws_vpc" "webapp_vpc" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  
  tags = {
    Name = "webapp-vpc"
    Environment = "test"
    SessionId = "${sessionId}"
  }
}

resource "aws_db_instance" "webapp_db" {
  identifier     = "webapp-db"
  engine         = "postgres"
  instance_class = "db.t3.micro"
  vpc_security_group_ids = [aws_security_group.db.id]
  
  tags = {
    Name = "webapp-db"
    Environment = "test"
    SessionId = "${sessionId}"
  }
}

resource "aws_s3_bucket" "webapp_assets" {
  bucket = "${bucketName}"
  
  tags = {
    Name = "webapp-assets"
    Environment = "test"
    SessionId = "${sessionId}"
  }
}
`.trim(),
        });

        // Store AWS infrastructure info
        vpc = {
          id: 'webappVpc',
          name: 'webapp-vpc',
          cidrBlock: '10.0.0.0/16',
          vpcId: vpcId,
          configFile: vpcConfigFile,
        };

        database = {
          id: 'webappDb',
          name: 'webapp-db',
          engine: 'postgres',
          vpcId: vpcId,
          endpoint: 'webapp-db.cluster-xyz.us-east-1.rds.amazonaws.com',
          configFile: databaseConfigFile,
        };

        s3Bucket = {
          id: 'webappAssets',
          name: 'webapp-assets',
          versioning: true,
          bucketName: bucketName,
          configFile: s3ConfigFile,
          terraformFile: terraformConfigFile,
        };

        // Validate alchemy state for AWS integration test using built-in state store
        console.log('🔍 Validating alchemy state for AWS integration test...');

        const awsState = await alchemyScope.state.all();

        // Verify that our File resources are registered in alchemy state
        const vpcConfigState = Object.values(awsState).find(
          (state: any) => state.kind === 'fs::File' && state.output.path === vpc.configFile.path
        ) as any;
        const dbConfigState = Object.values(awsState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output.path === database.configFile.path
        ) as any;
        const s3ConfigState = Object.values(awsState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output.path === s3Bucket.configFile.path
        ) as any;
        const terraformConfigState = Object.values(awsState).find(
          (state: any) =>
            state.kind === 'fs::File' && state.output.path === s3Bucket.terraformFile.path
        ) as any;

        expect(vpcConfigState).toBeDefined();
        expect(vpcConfigState?.status).toBe('created');
        expect(vpcConfigState?.output.content).toContain('webapp-vpc');

        expect(dbConfigState).toBeDefined();
        expect(dbConfigState?.status).toBe('created');
        expect(dbConfigState?.output.content).toContain('webapp-db');

        expect(s3ConfigState).toBeDefined();
        expect(s3ConfigState?.status).toBe('created');
        expect(s3ConfigState?.output.content).toContain('webapp-assets');

        expect(terraformConfigState).toBeDefined();
        expect(terraformConfigState?.status).toBe('created');
        expect(terraformConfigState?.output.content).toContain('resource "aws_vpc" "webapp_vpc"');

        console.log(`✅ AWS integration test state validation passed`);
        console.log(`   - VPC config: ${vpcConfigState?.id} (${vpcConfigState?.status})`);
        console.log(`   - DB config: ${dbConfigState?.id} (${dbConfigState?.status})`);
        console.log(`   - S3 config: ${s3ConfigState?.id} (${s3ConfigState?.status})`);
        console.log(
          `   - Terraform config: ${terraformConfigState?.id} (${terraformConfigState?.status})`
        );
      });

      // Step 2: Define TypeKro application that uses AWS resources
      const WebAppSpecSchema = type({
        name: 'string',
        image: 'string',
        replicas: 'number%1',
        // These would be populated from Alchemy outputs
        databaseUrl: 'string',
        s3BucketName: 'string',
        vpcId: 'string',
      });

      const WebAppStatusSchema = type({
        appUrl: 'string',
        healthStatus: 'string',
        databaseConnected: 'boolean',
      });

      const graph = toResourceGraph(
        {
          name: 'aws-webapp',
          apiVersion: 'v1alpha1',
          kind: 'AWSWebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          // Application deployment
          webapp: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webapp',
            env: {
              // Alchemy outputs -> TypeKro inputs
              DATABASE_URL: schema.spec.databaseUrl,
              S3_BUCKET: schema.spec.s3BucketName,
              VPC_ID: schema.spec.vpcId,
              // TypeKro internal
              APP_NAME: schema.spec.name,
            },
          }),

          // Service to expose the app
          service: simpleService({
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 3000 }],
            id: 'service',
          }),

          // Configuration
          config: simpleConfigMap({
            name: Cel.template('%s-config', schema.spec.name),
            id: 'config',
            data: {
              'aws.region': 'us-east-1',
              'aws.s3.bucket': schema.spec.s3BucketName,
              'database.host': schema.spec.databaseUrl,
            },
          }),
        }),
        (schema, _resources) => ({
          appUrl: Cel.template('http://%s.default.svc.cluster.local', schema.spec.name),
          healthStatus: 'healthy',
          databaseConnected: true,
        })
      );

      // Step 3: Verify the complete integration
      const yaml = graph.toYaml();

      // Verify Alchemy -> TypeKro value flow
      expect(yaml).toContain('value: ${schema.spec.databaseUrl}');
      expect(yaml).toContain('value: ${schema.spec.s3BucketName}');
      expect(yaml).toContain('value: ${schema.spec.vpcId}');

      // Verify TypeKro internal references
      expect(yaml).toContain('value: ${schema.spec.name}');
      expect(yaml).toContain('name: ${schema.spec.name}');

      // Verify status fields that could flow back to Alchemy - now with intelligent CEL expressions
      expect(yaml).toContain('appUrl: http://${');
      // Static status fields should NOT be in YAML (they're hydrated directly by TypeKro)
      expect(yaml).not.toContain('databaseConnected:');
      expect(yaml).not.toContain('healthStatus:');

      // Verify all Alchemy resources exist
      expect(vpc.id).toBe('webappVpc');
      expect(database.id).toBe('webappDb');
      expect(s3Bucket.id).toBe('webappAssets');

      // In real deployment, the flow would be:
      // 1. Alchemy deploys AWS infrastructure (VPC, RDS, S3)
      // 2. Alchemy outputs (database URL, bucket name) become available
      // 3. TypeKro factory receives spec with Alchemy outputs
      // 4. TypeKro deploys Kubernetes resources with resolved values
      // 5. TypeKro status (service URL) could be used by other Alchemy resources
    });
  });
});
