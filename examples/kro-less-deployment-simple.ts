/**
 * Simple Kro-less Deployment Example
 *
 * This example demonstrates the basic usage of the new toResourceGraph API
 * with proper type safety and working code.
 *
 * NOTE: Factory creation works without a cluster, but actual deployment
 * requires a running Kubernetes cluster. The example shows factory creation
 * and YAML generation which work without cluster connectivity.
 */

import { type } from 'arktype';
import { Deployment, Service } from '../src/factories/simple/index.js';
import { toResourceGraph, Cel } from '../src/index.js';
// =============================================================================
// 1. DEFINE ARKTYPE SCHEMAS
// =============================================================================

const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"',
});

const WebAppStatusSchema = type({
  url: 'string',
  readyReplicas: 'number',
  phase: '"pending" | "running" | "failed"',
});

// =============================================================================
// 2. CREATE TYPED RESOURCE GRAPH
// =============================================================================

const webappGraph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  // ResourceBuilder function - defines the Kubernetes resources
  (schema) => ({
    deployment: Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      env: {
        NODE_ENV: schema.spec.environment,
      },
      ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
      id: 'webappDeployment', // Required for schema references (camelCase)
    }),

    service: Service({
      name: 'webapp-service',
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'LoadBalancer',
      id: 'webappService', // Required for deterministic IDs (camelCase)
    }),
  }),
  // StatusBuilder function - defines how status fields map to resource status
  (_schema, resources) => ({
    url: resources.service?.status.loadBalancer?.ingress?.[0]?.hostname || 'http://pending',
    readyReplicas: resources.deployment?.status.readyReplicas || 0,
    phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`, // CEL expression value
  })
);

// =============================================================================
// 3. DEMONSTRATE BASIC FUNCTIONALITY
// =============================================================================

async function demonstrateBasicUsage() {
  console.log('=== Basic toResourceGraph Usage ===');

  // Generate ResourceGraphDefinition YAML
  console.log('Generated YAML:');
  const yaml = webappGraph.toYaml();
  console.log(yaml);

  // Verify graph properties
  console.log(`\nGraph name: ${webappGraph.name}`);
  console.log(`Resources count: ${webappGraph.resources.length}`);
  console.log(`Has schema: ${!!webappGraph.schema}`);

  // Test factory creation (works but requires Kubernetes cluster for deployment)
  try {
    const directFactory = await webappGraph.factory('direct');
    console.log('✅ Direct factory created successfully');
    console.log(`   Mode: ${directFactory.mode}`);
    console.log(`   Name: ${directFactory.name}`);
    console.log(`   Namespace: ${directFactory.namespace}`);
    console.log(`   Alchemy managed: ${directFactory.isAlchemyManaged}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Direct factory creation failed: ${message}`);
  }

  try {
    const kroFactory = await webappGraph.factory('kro');
    console.log('✅ Kro factory created successfully');
    console.log(`   Mode: ${kroFactory.mode}`);
    console.log(`   RGD Name: ${kroFactory.rgdName}`);
    console.log(`   Has schema: ${!!kroFactory.schema}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Kro factory creation failed: ${message}`);
  }
}

// =============================================================================
// 4. DEMONSTRATE TYPE SAFETY
// =============================================================================

function demonstrateTypeSafety() {
  console.log('\n=== Type Safety Demonstration ===');

  // Valid spec that would pass ArkType validation
  const validSpec = {
    name: 'my-webapp',
    image: 'nginx:latest',
    replicas: 3,
    environment: 'production' as const,
  };

  console.log('Valid spec:', validSpec);

  // The following would be compile-time errors:

  // ❌ Invalid environment value
  // const invalidSpec = {
  //   name: 'my-webapp',
  //   image: 'nginx:latest',
  //   replicas: 3,
  //   environment: 'invalid', // ❌ Not in union type
  // };

  // ❌ Wrong type for replicas
  // const invalidSpec2 = {
  //   name: 'my-webapp',
  //   image: 'nginx:latest',
  //   replicas: 'three', // ❌ Should be number
  //   environment: 'production',
  // };

  console.log('✅ Type safety enforced at compile time');
  console.log('✅ ArkType provides runtime validation');
}

// =============================================================================
// 5. DEMONSTRATE FACTORY OPTIONS
// =============================================================================

async function demonstrateFactoryOptions() {
  console.log('\n=== Factory Options Demonstration ===');

  const factoryOptions = {
    namespace: 'production',
    timeout: 30000,
    waitForReady: true,
    retryPolicy: {
      maxRetries: 3,
      backoffMultiplier: 2,
      initialDelay: 1000,
      maxDelay: 10000,
    },
  };

  console.log('Factory options:', factoryOptions);

  try {
    const factory = await webappGraph.factory('direct', factoryOptions);
    console.log('✅ Factory with options created successfully');
    console.log(`   Namespace: ${factory.namespace}`);
    console.log(`   Timeout configured: ${factoryOptions.timeout}ms`);
    console.log(`   Wait for ready: ${factoryOptions.waitForReady}`);
    console.log(`   Max retries: ${factoryOptions.retryPolicy?.maxRetries}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Factory with options failed: ${message}`);
  }
}

// =============================================================================
// 6. RUN ALL DEMONSTRATIONS
// =============================================================================

async function runDemonstrations() {
  try {
    await demonstrateBasicUsage();
    demonstrateTypeSafety();
    await demonstrateFactoryOptions();

    console.log('\n🎉 All demonstrations completed successfully!');
    console.log('\n📋 Key Features Demonstrated:');
    console.log('✅ ArkType schema integration');
    console.log('✅ Type-safe resource graph creation');
    console.log('✅ YAML generation for ResourceGraphDefinition');
    console.log('✅ Factory pattern with mode selection');
    console.log('✅ Compile-time type safety');
    console.log('✅ Schema proxy integration');
  } catch (error) {
    console.error('❌ Demonstration failed:', error);
  }
}

// Run the demonstration
runDemonstrations();
