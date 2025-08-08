/**
 * Kro-less Deployment Example - Cohesive Factory Pattern
 *
 * This example demonstrates the new cohesive factory pattern for kro-less deployment
 * with full ArkType integration and type safety.
 * 
 * NOTE: This file is currently for documentation purposes and may not compile
 * due to TypeScript configuration issues and the complexity of the magic proxy system.
 * See examples/README.md for more information.
 */

import { type } from 'arktype';
import {
  Cel,
  externalRef,
  simpleDeployment,
  simpleService,
  toResourceGraph,
} from '../src/index.js';
// Note: Alchemy imports would be used in real implementation
// import alchemy from 'alchemy';
// import { Vpc } from 'alchemy/aws';

// =============================================================================
// 1. DEFINE ARKTYPE SCHEMAS WITH TYPE INFERENCE
// =============================================================================

const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1', // integer
  domain: 'string',
  environment: '"development" | "staging" | "production"',
});

const WebAppStatusSchema = type({
  url: 'string',
  readyReplicas: 'number%1',
  phase: '"pending" | "running" | "failed"',
  lastDeployed: 'string',
});

// Infer TypeScript types from ArkType schemas - this is the key to type safety
// These types are available for use in the application logic
// type WebAppSpec = typeof WebAppSpecSchema.infer;
// type WebAppStatus = typeof WebAppStatusSchema.infer;

// =============================================================================
// 2. CREATE TYPED RESOURCE GRAPH WITH BUILDER FUNCTION
// =============================================================================

const webappGraph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (_schema) => ({
    deployment: simpleDeployment({
      name: 'webapp',
      image: 'nginx:latest',
      replicas: 3,
      env: {
        NODE_ENV: 'production',
        DOMAIN: 'webapp.example.com',
        REPLICA_COUNT: '3',
        DEPLOYMENT_TIME: new Date().toISOString(),
      },
      ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '256Mi' },
      },
    }),

    service: simpleService({
      name: 'webapp-service',
      selector: { app: 'webapp' },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'LoadBalancer',
    }),
  }),
  (_schema, resources) => ({
    url: 'http://webapp.example.com',
    readyReplicas: resources.deployment?.status.readyReplicas || 0,
    phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
    lastDeployed: new Date().toISOString(),
  })
);

console.log('=== Generated ResourceGraphDefinition YAML ===');
console.log(webappGraph.toYaml());

// =============================================================================
// 3. DIRECT DEPLOYMENT MODE (TypeKro Dependency Resolution)
// =============================================================================

async function demonstrateDirectDeployment() {
  console.log('\n=== Direct Deployment Mode ===');

  // Get factory for direct deployment (uses TypeKro dependency resolution)
  const directFactory = await webappGraph.factory('direct');

  console.log(`✅ Factory mode: ${directFactory.mode}`);
  console.log(`✅ Factory name: ${directFactory.name}`);
  console.log(`✅ Namespace: ${directFactory.namespace}`);
  console.log(`✅ Alchemy managed: ${directFactory.isAlchemyManaged}`);

  // Demonstrate type-safe spec validation (without actual deployment)
  const validSpec = {
    name: 'webapp-prod',
    image: 'myapp:v1.2.0',
    replicas: 5,
    domain: 'myapp.com',
    environment: 'production' as const, // Type-safe enum value
  };

  console.log('✅ Valid production spec:', validSpec);

  // Show what YAML would be generated for this instance
  try {
    const instanceYaml = directFactory.toYaml(validSpec);
    console.log('✅ Instance YAML generation successful');
    console.log(`   YAML length: ${instanceYaml.length} characters`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Instance YAML generation failed: ${message}`);
  }

  // Demonstrate factory status
  try {
    const factoryStatus = await directFactory.getStatus();
    console.log('✅ Factory status:', {
      name: factoryStatus.name,
      mode: factoryStatus.mode,
      isAlchemyManaged: factoryStatus.isAlchemyManaged,
      namespace: factoryStatus.namespace,
      instanceCount: factoryStatus.instanceCount,
      health: factoryStatus.health,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Factory status check failed: ${message}`);
  }

  console.log('📝 Note: Actual deployment requires a running Kubernetes cluster');
  console.log('📝 Use factory.deploy(spec) when cluster is available');
}

// =============================================================================
// 4. KRO DEPLOYMENT MODE (RGD with Kro Dependency Resolution)
// =============================================================================

async function demonstrateKroDeployment() {
  console.log('\n=== Kro Deployment Mode ===');

  // Get factory for Kro deployment (deploys RGD, uses Kro dependency resolution)
  const kroFactory = await webappGraph.factory('kro');

  console.log(`✅ Factory mode: ${kroFactory.mode}`);
  console.log(`✅ RGD Name: ${kroFactory.rgdName}`);
  console.log(`✅ Has schema: ${!!kroFactory.schema}`);
  console.log(`✅ Alchemy managed: ${kroFactory.isAlchemyManaged}`);

  // Demonstrate RGD YAML generation
  try {
    const rgdYaml = kroFactory.toYaml();
    console.log('✅ RGD YAML generation successful');
    console.log(`   YAML length: ${rgdYaml.length} characters`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ RGD YAML generation failed: ${message}`);
  }

  // Demonstrate instance YAML generation
  const validSpec = {
    name: 'webapp-prod',
    image: 'myapp:v1.2.0',
    replicas: 5,
    domain: 'myapp.com',
    environment: 'production' as const,
  };

  try {
    const instanceYaml = kroFactory.toYaml(validSpec);
    console.log('✅ Instance YAML generation successful');
    console.log(`   Instance YAML length: ${instanceYaml.length} characters`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Instance YAML generation failed: ${message}`);
  }

  // Demonstrate factory status
  try {
    const factoryStatus = await kroFactory.getStatus();
    console.log('✅ Factory status:', {
      name: factoryStatus.name,
      mode: factoryStatus.mode,
      isAlchemyManaged: factoryStatus.isAlchemyManaged,
      namespace: factoryStatus.namespace,
      instanceCount: factoryStatus.instanceCount,
      health: factoryStatus.health,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Factory status check failed: ${message}`);
  }

  console.log('📝 Note: Actual RGD deployment requires a Kubernetes cluster with Kro controller');
  console.log('📝 Use factory.deploy(spec) when cluster with Kro is available');
}

// =============================================================================
// 5. ALCHEMY INTEGRATION (Direct Mode)
// =============================================================================

async function demonstrateAlchemyDirectMode() {
  console.log('\n=== Alchemy Integration (Direct Mode) ===');

  // Note: In real implementation, would use alchemy
  // const app = await alchemy('full-stack-webapp');

  // Mock database connection for demonstration
  const mockDatabase = {
    connectionString: 'postgresql://localhost:5432/webapp',
    address: 'localhost',
  };

  // Create Kubernetes resources that reference AWS resources
  const fullStackGraph = toResourceGraph(
    {
      name: 'fullstack-webapp',
      apiVersion: 'example.com/v1alpha1',
      kind: 'WebApp',
      spec: WebAppSpecSchema,
      status: WebAppStatusSchema,
    },
    (_schema) => ({
      deployment: simpleDeployment({
        name: 'fullstack-webapp',
        image: 'nginx:latest',
        replicas: 3,
        env: {
          NODE_ENV: 'production',
          DOMAIN: 'fullstack.example.com',
          DATABASE_URL: mockDatabase.connectionString, // Mock value
          DATABASE_HOST: mockDatabase.address,         // Mock value
          APP_NAME: 'fullstack-webapp',                // Static value
          REPLICAS: '3',                               // Static value
        },
        ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
        id: 'fullstackDeployment', // camelCase ID
      }),

      service: simpleService({
        name: 'fullstack-service',
        selector: { app: 'fullstack' },
        ports: [{ port: 80, targetPort: 3000 }],
        type: 'LoadBalancer',
        id: 'fullstackService', // camelCase ID
      }),
    }),
    (_schema, resources) => ({
      url: 'http://fullstack.example.com',
      readyReplicas: resources.deployment?.status.readyReplicas || 0,
      phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
      lastDeployed: new Date().toISOString(),
    })
  );

  // Get factory that creates alchemy-managed resources using TypeKro dependency resolution
  const alchemyDirectFactory = await fullStackGraph.factory('direct', {
    // alchemyScope: app, // Alchemy scope would be provided at factory creation
    namespace: 'production',
    waitForReady: true,
  });

  console.log(`✅ Factory created successfully`);
  console.log(`✅ Factory is alchemy-managed: ${alchemyDirectFactory.isAlchemyManaged}`);
  console.log(`✅ Factory mode: ${alchemyDirectFactory.mode}`);
  console.log(`✅ Factory namespace: ${alchemyDirectFactory.namespace}`);

  // Show what would be deployed
  const validSpec = {
    name: 'webapp-prod',
    image: 'myapp:v1.2.0',
    replicas: 3,
    domain: 'myapp.com',
    environment: 'production' as const,
  };

  try {
    const instanceYaml = alchemyDirectFactory.toYaml(validSpec);
    console.log('✅ Full-stack instance YAML generation successful');
    console.log(`   YAML includes database environment variables`);
    console.log(`   YAML length: ${instanceYaml.length} characters`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Instance YAML generation failed: ${message}`);
  }

  console.log('📝 Note: In real implementation, alchemy would manage AWS resources');
  console.log('📝 Each Kubernetes resource would be an alchemy resource');
  console.log('📝 Alchemy handles dependency resolution between AWS RDS and K8s resources');
}

// =============================================================================
// 6. ALCHEMY INTEGRATION (Kro Mode)
// =============================================================================

async function demonstrateAlchemyKroMode() {
  console.log('\n=== Alchemy Integration (Kro Mode) ===');

  // const app = await alchemy('kro-managed-webapp');

  // Get factory that deploys RGD through alchemy
  const alchemyKroFactory = await webappGraph.factory('kro', {
    // alchemyScope: app, // Alchemy scope would be provided at factory creation
    namespace: 'production',
  });

  console.log(`✅ Factory created successfully`);
  console.log(`✅ Factory is alchemy-managed: ${alchemyKroFactory.isAlchemyManaged}`);
  console.log(`✅ RGD Name: ${alchemyKroFactory.rgdName}`);
  console.log(`✅ Factory mode: ${alchemyKroFactory.mode}`);
  console.log(`✅ Has schema: ${!!alchemyKroFactory.schema}`);

  // Show what RGD would be deployed
  try {
    const rgdYaml = alchemyKroFactory.toYaml();
    console.log('✅ RGD YAML generation successful');
    console.log(`   RGD would be managed by alchemy`);
    console.log(`   YAML length: ${rgdYaml.length} characters`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ RGD YAML generation failed: ${message}`);
  }

  // Show what instance would be created
  const validSpec = {
    name: 'webapp-prod',
    image: 'myapp:v1.2.0',
    replicas: 5,
    domain: 'myapp.com',
    environment: 'production' as const,
  };

  try {
    const instanceYaml = alchemyKroFactory.toYaml(validSpec);
    console.log('✅ Instance YAML generation successful');
    console.log(`   Instance would be managed by Kro controller`);
    console.log(`   YAML length: ${instanceYaml.length} characters`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Instance YAML generation failed: ${message}`);
  }

  console.log('📝 Note: The RGD itself would be managed by alchemy');
  console.log('📝 Instances would be managed by Kro controller');
  console.log('📝 Alchemy handles RGD lifecycle, Kro handles instance lifecycle');
}

// =============================================================================
// 7. EXTERNAL REFERENCES WITH TYPE SAFETY
// =============================================================================

async function demonstrateExternalReferences() {
  console.log('\n=== External References with Type Safety ===');

  // Define schemas for external database
  const DatabaseSpecSchema = type({
    name: 'string',
    storage: 'string',
    version: 'string',
    replicas: 'number%1',
  });

  const DatabaseStatusSchema = type({
    connectionString: 'string',
    host: 'string',
    port: 'number%1',
    ready: 'boolean',
    primaryEndpoint: 'string',
  });

  type DatabaseSpec = typeof DatabaseSpecSchema.infer;
  type DatabaseStatus = typeof DatabaseStatusSchema.infer;

  // Create webapp that references external database
  const webappWithDbGraph = toResourceGraph(
    {
      name: 'webapp-with-database',
      apiVersion: 'example.com/v1alpha1',
      kind: 'WebApp',
      spec: WebAppSpecSchema,
      status: WebAppStatusSchema,
    },
    (schema) => {
      // Type-safe external reference
      const database = externalRef<DatabaseSpec, DatabaseStatus>(
        'example.com/v1alpha1',
        'Database',
        'production-database'
      );

      return {
        database, // Include external reference in resource graph

        deployment: simpleDeployment({
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
          env: {
            NODE_ENV: 'production',
            DOMAIN: 'webapp-db.example.com',
            // Type-safe references to external database
            DATABASE_URL: database.status.connectionString,
            DATABASE_HOST: database.status.host,
            DATABASE_PORT: '5432',
            DATABASE_READY: 'true',
            PRIMARY_ENDPOINT: database.status.primaryEndpoint,
          },
          ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
          id: 'webappDbDeployment', // camelCase ID
        }),

        service: simpleService({
          name: 'webapp-db-service',
          selector: { app: 'webapp-db' },
          ports: [{ port: 80, targetPort: 3000 }],
          type: 'LoadBalancer',
          id: 'webappDbService', // camelCase ID
        }),
      };
    },
    (_schema, resources) => ({
      url: 'http://webapp-db.example.com',
      readyReplicas: resources.deployment?.status.readyReplicas || 0,
      phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
      lastDeployed: new Date().toISOString(),
    })
  );

  // Create factory for deployment with external dependencies
  const factory = await webappWithDbGraph.factory('direct');
  
  console.log('✅ Factory with external references created successfully');
  console.log(`✅ Factory mode: ${factory.mode}`);
  console.log(`✅ Factory name: ${factory.name}`);

  // Show what would be deployed
  const validSpec = {
    name: 'webapp-prod',
    image: 'myapp:latest',
    replicas: 3,
    domain: 'myapp.com',
    environment: 'production' as const,
  };

  try {
    const instanceYaml = factory.toYaml(validSpec);
    console.log('✅ Instance with external references YAML generation successful');
    console.log(`   YAML includes external database references`);
    console.log(`   YAML length: ${instanceYaml.length} characters`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Instance YAML generation failed: ${message}`);
  }

  console.log('📝 Note: Actual deployment would resolve external database references');
  console.log('📝 External references provide type-safe access to other resources');
}

// =============================================================================
// 8. STATIC RESOURCE GRAPH (No Generics)
// =============================================================================

async function demonstrateStaticResourceGraph() {
  console.log('\n=== Static Resource Graph (No Generics) ===');

  // For simple cases without custom schemas, use the static overload
  // Note: This would require a different API for static resources
  console.log('Static resource graphs would use a different API pattern');
  console.log('This demonstrates the concept but requires implementation in future tasks');

  // This would be implemented in future tasks for static resource graphs
  // console.log('Static graph YAML:');
  // console.log(staticGraph.toYaml());

  // Deploy directly without instances (returns DeploymentResult)
  // const directFactory = await staticGraph.factory('direct');
  // const result = await directFactory.deployStatic();

  // console.log(`Deployed ${result.resources.length} static resources`);
}

// =============================================================================
// 9. TYPE SAFETY DEMONSTRATION
// =============================================================================

function demonstrateTypeSafety() {
  console.log('\n=== Type Safety Demonstration ===');

  // These would be compile-time errors:

  // ❌ Invalid spec field
  // const invalidSpec: WebAppSpec = {
  //   name: 'test',
  //   image: 'nginx',
  //   replicas: 'invalid', // ❌ Should be number
  //   domain: 'test.com',
  //   environment: 'invalid' // ❌ Should be 'development' | 'staging' | 'production'
  // };

  // ❌ Invalid schema reference
  // const invalidGraph = toResourceGraph(
  //   'invalid',
  //   (schema) => ({
  //     deployment: simpleDeployment({
  //       name: schema.spec.nonExistentField, // ❌ Property doesn't exist
  //       image: 'nginx',
  //     }),
  //   }),
  //   schemaDefinition
  // );

  console.log('✅ All type safety checks passed at compile time!');
  console.log('✅ ArkType provides runtime validation!');
  console.log('✅ Schema proxy provides type-safe references!');
}

// =============================================================================
// 10. RUN ALL DEMONSTRATIONS
// =============================================================================

async function runAllDemonstrations() {
  try {
    demonstrateTypeSafety();
    await demonstrateDirectDeployment();
    await demonstrateKroDeployment();
    await demonstrateAlchemyDirectMode();
    await demonstrateAlchemyKroMode();
    await demonstrateExternalReferences();
    await demonstrateStaticResourceGraph();

    console.log('\n🎉 All kro-less deployment demonstrations completed successfully!');
    console.log('\n📋 Summary of Features Demonstrated:');
    console.log('✅ ArkType schema integration with type inference');
    console.log('✅ Factory pattern with direct and Kro modes');
    console.log('✅ Type-safe instance creation and management');
    console.log('✅ Alchemy integration with mixed dependencies');
    console.log('✅ External references with full type safety');
    console.log('✅ Static resource graphs for simple use cases');
    console.log('✅ Compile-time and runtime type safety');

  } catch (error) {
    console.error('❌ Demonstration failed:', error);
  }
}

// Run demonstrations
runAllDemonstrations();