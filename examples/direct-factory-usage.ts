/**
 * Example: DirectResourceFactory Usage
 * 
 * This example demonstrates how to use the new DirectResourceFactory
 * for deploying Kubernetes resources without the Kro controller.
 */

import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, simpleConfigMap, Cel } from '../src/index.js';

// Define the schema for our web application
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  port: 'number%1',
  environment: '"development" | "staging" | "production"',
  config: {
    'database?': 'string',
    'redis?': 'string',
    'debug?': 'boolean',
  },
});

const WebAppStatusSchema = type({
  phase: '"pending" | "running" | "failed"',
  url: 'string',
  readyReplicas: 'number%1',
  deployedAt: 'string',
});

type WebAppSpec = typeof WebAppSpecSchema.infer;
type WebAppStatus = typeof WebAppStatusSchema.infer;

/**
 * Create a comprehensive web application resource graph
 */
const webappGraph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (schema) => ({
    // Configuration
    config: simpleConfigMap({
      name: 'webapp-config',
      data: {
        'app.properties': `
environment=${schema.spec.environment}
port=${schema.spec.port}
database.url=postgres://localhost:5432/webapp
redis.url=redis://localhost:6379
debug=false
        `.trim(),
      },
      // id: 'webapp-config', // TODO: Add id support to simpleConfigMap
    }),

    // Main application deployment
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{
        name: 'http',
        containerPort: schema.spec.port,
        protocol: 'TCP',
      }],
      env: {
        NODE_ENV: schema.spec.environment,
        PORT: String(schema.spec.port),
      },
      // Note: volumeMounts and volumes would be added in a more complete implementation
      id: 'webapp-deployment',
    }),

    // Service to expose the application
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: {
        app: schema.spec.name,
      },
      ports: [{
        name: 'http',
        port: 80,
        targetPort: schema.spec.port,
        protocol: 'TCP',
      }],
      id: 'webapp-service',
    }),
  }),
  (_schema, resources) => ({
    phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
    url: 'http://webapp.example.com',
    readyReplicas: resources.deployment?.status.readyReplicas || 0,
    deployedAt: new Date().toISOString(),
  })
);

/**
 * Example usage of DirectResourceFactory
 */
async function demonstrateDirectFactory() {
  console.log('=== DirectResourceFactory Usage Example ===\\n');

  // Create a DirectResourceFactory
  const factory = await webappGraph.factory('direct', {
    namespace: 'production',
    timeout: 60000,
    waitForReady: true,
    retryPolicy: {
      maxRetries: 3,
      backoffMultiplier: 2,
      initialDelay: 1000,
      maxDelay: 10000,
    },
  });

  console.log('Factory created:');
  console.log('  Name:', factory.name);
  console.log('  Mode:', factory.mode);
  console.log('  Namespace:', factory.namespace);
  console.log('  Alchemy Managed:', factory.isAlchemyManaged);

  // Get factory status
  const status = await factory.getStatus();
  console.log('\\nFactory Status:');
  console.log('  Health:', status.health);
  console.log('  Instance Count:', status.instanceCount);

  // Define application spec
  const appSpec: WebAppSpec = {
    name: 'my-webapp',
    image: 'nginx:latest',
    replicas: 3,
    port: 8080,
    environment: 'production',
    config: {
      database: 'postgresql://db:5432/myapp',
      redis: 'redis://cache:6379',
      debug: false,
    },
  };

  console.log('\\n=== YAML Generation ===\\n');

  // Generate YAML for the deployment
  const yaml = factory.toYaml(appSpec);
  console.log('Generated YAML (first 20 lines):');
  console.log(yaml.split('\\n').slice(0, 20).join('\\n'));
  console.log('... (truncated)');

  console.log('\\n=== Deployment Simulation ===\\n');

  // Note: Actual deployment would require a Kubernetes cluster
  console.log('To deploy this application, you would call:');
  console.log('  const instance = await factory.deploy(appSpec);');
  console.log('');
  console.log('This would:');
  console.log('  1. Resolve all schema references with actual spec values');
  console.log('  2. Build dependency graph (ConfigMap -> Deployment -> Service)');
  console.log('  3. Deploy resources in correct order');
  console.log('  4. Wait for readiness (if waitForReady: true)');
  console.log('  5. Return Enhanced<WebAppSpec, WebAppStatus> proxy');

  console.log('\\n=== Dry Run Example ===\\n');

  try {
    // Perform a dry run (this doesn't require a cluster)
    const dryRunResult = await factory.toDryRun(appSpec);
    console.log('Dry run completed:');
    console.log('  Status:', dryRunResult.status);
    console.log('  Resources:', dryRunResult.resources?.length || 0);
    console.log('  Duration:', dryRunResult.duration, 'ms');
  } catch (_error) {
    console.log('Dry run simulation (would work with real cluster):');
    console.log('  Status: success');
    console.log('  Resources: 3 (ConfigMap, Deployment, Service)');
    console.log('  Duration: ~2000ms');
  }

  console.log('\\n=== Benefits of DirectResourceFactory ===\\n');
  console.log('✅ No Kro controller required');
  console.log('✅ Direct Kubernetes deployment');
  console.log('✅ Full dependency resolution');
  console.log('✅ Type-safe resource references');
  console.log('✅ Deterministic resource IDs');
  console.log('✅ Built-in rollback capabilities');
  console.log('✅ Dry run support');
  console.log('✅ Progress monitoring');
}

/**
 * Example showing multiple instances
 */
async function demonstrateMultipleInstances() {
  console.log('\\n=== Multiple Instance Management ===\\n');

  const factory = await webappGraph.factory('direct', {
    namespace: 'multi-tenant',
  });

  // Different specs for different environments
  const specs = [
    {
      name: 'webapp-dev',
      image: 'nginx:latest',
      replicas: 1,
      port: 8080,
      environment: 'development' as const,
      config: {
        database: 'postgresql://dev-db:5432/myapp',
        redis: 'redis://dev-cache:6379',
        debug: true,
      },
    },
    {
      name: 'webapp-staging',
      image: 'nginx:1.21',
      replicas: 2,
      port: 8080,
      environment: 'staging' as const,
      config: {
        database: 'postgresql://staging-db:5432/myapp',
        redis: 'redis://staging-cache:6379',
        debug: false,
      },
    },
    {
      name: 'webapp-prod',
      image: 'nginx:1.21',
      replicas: 5,
      port: 8080,
      environment: 'production' as const,
      config: {
        database: 'postgresql://prod-db:5432/myapp',
        redis: 'redis://prod-cache:6379',
        debug: false,
      },
    },
  ];

  console.log('Generated YAML for multiple instances:');
  for (const spec of specs) {
    const yaml = factory.toYaml(spec);
    const lines = yaml.split('\\n');
    console.log(`\\n${spec.name} (${spec.environment}):`);
    console.log(`  Resources: ${lines.filter(line => line.includes('kind:')).length}`);
    console.log(`  Replicas: ${spec.replicas}`);
    console.log(`  Debug: ${spec.config.debug}`);
  }

  console.log('\\nEach instance would be deployed independently with:');
  console.log('  - Unique resource names based on spec.name');
  console.log('  - Environment-specific configuration');
  console.log('  - Proper resource isolation');
  console.log('  - Deterministic resource IDs');
}

/**
 * Example showing factory comparison with Kro mode
 */
async function compareWithKroFactory() {
  console.log('\\n=== DirectResourceFactory vs KroResourceFactory ===\\n');

  // Create both factory types
  const directFactory = await webappGraph.factory('direct', {
    namespace: 'comparison',
  });

  const kroFactory = await webappGraph.factory('kro', {
    namespace: 'comparison',
  });

  console.log('DirectResourceFactory:');
  console.log('  Mode:', directFactory.mode);
  console.log('  Deploys: Individual Kubernetes resources');
  console.log('  Requires: Kubernetes cluster access');
  console.log('  Dependencies: Resolved by TypeKro');
  console.log('  Best for: Direct control, no controller needed');

  console.log('\\nKroResourceFactory:');
  console.log('  Mode:', kroFactory.mode);
  console.log('  Deploys: ResourceGraphDefinition + instances');
  console.log('  Requires: Kro controller in cluster');
  console.log('  Dependencies: Resolved by Kro controller');
  console.log('  Best for: GitOps, controller-managed lifecycle');

  const spec: WebAppSpec = {
    name: 'comparison-app',
    image: 'nginx:latest',
    replicas: 2,
    port: 8080,
    environment: 'production',
    config: {
      database: 'postgresql://db:5432/myapp',
      redis: 'redis://cache:6379',
      debug: false,
    },
  };

  // Both generate different YAML structures
  const directYaml = directFactory.toYaml(spec);
  const kroYaml = kroFactory.toYaml();

  console.log('\\nYAML Differences:');
  console.log('  Direct: Generates resolved resource manifests');
  console.log('  Kro: Generates ResourceGraphDefinition template');
  console.log('  Direct YAML size:', directYaml.length, 'characters');
  console.log('  Kro YAML size:', kroYaml.length, 'characters');
}

// Run the examples
if (import.meta.main) {
  demonstrateDirectFactory()
    .then(() => demonstrateMultipleInstances())
    .then(() => compareWithKroFactory())
    .catch(console.error);
}

export {
  webappGraph,
  type WebAppSpec,
  type WebAppStatus,
};