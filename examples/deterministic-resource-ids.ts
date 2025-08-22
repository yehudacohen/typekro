/**
 * Example: Deterministic Resource ID Generation
 *
 * This example demonstrates how TypeKro generates consistent, deterministic IDs
 * for resources, which is essential for GitOps workflows and alchemy integration.
 */

import { type } from 'arktype';
import { Cel, simpleDeployment, simpleService, toResourceGraph } from '../src/index.js';
import { generateDeterministicResourceId } from '../src/utils/helpers.js';

// Define the schema for our web application
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  port: 'number%1',
});

const WebAppStatusSchema = type({
  phase: '"pending" | "running" | "failed"',
  url: 'string',
  readyReplicas: 'number%1',
});

type WebAppSpec = typeof WebAppSpecSchema.infer;
type WebAppStatus = typeof WebAppStatusSchema.infer;

/**
 * Example usage showing deterministic behavior
 */
async function demonstrateDeterministicIds() {
  console.log('=== Deterministic Resource ID Generation ===\\n');

  // Create the same resource graph multiple times
  const graph1 = toResourceGraph(
    {
      name: 'webapp-stack',
      apiVersion: 'example.com/v1alpha1',
      kind: 'WebApp',
      spec: WebAppSpecSchema,
      status: WebAppStatusSchema,
    },
    (schema) => ({
      deployment: simpleDeployment({
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        id: 'webapp-deployment', // Explicit ID
      }),
      service: simpleService({
        name: 'webapp-service',
        selector: { app: schema.spec.name },
        ports: [{ port: 80, targetPort: 8080 }],
        id: 'webapp-service', // Explicit ID
      }),
    }),
    (_schema, resources) => ({
      phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
      url: 'http://webapp.example.com',
      readyReplicas: resources.deployment?.status.readyReplicas || 0,
    })
  );

  const graph2 = toResourceGraph(
    {
      name: 'webapp-stack',
      apiVersion: 'example.com/v1alpha1',
      kind: 'WebApp',
      spec: WebAppSpecSchema,
      status: WebAppStatusSchema,
    },
    (schema) => ({
      deployment: simpleDeployment({
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        id: 'webapp-deployment', // Same explicit ID
      }),
      service: simpleService({
        name: 'webapp-service',
        selector: { app: schema.spec.name },
        ports: [{ port: 80, targetPort: 8080 }],
        id: 'webapp-service', // Same explicit ID
      }),
    }),
    (_schema, resources) => ({
      phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
      url: 'http://webapp.example.com',
      readyReplicas: resources.deployment?.status.readyReplicas || 0,
    })
  );

  // Both graphs should have identical resource IDs
  console.log('Graph 1 resource keys:', Object.keys(graph1.resources));
  console.log('Graph 2 resource keys:', Object.keys(graph2.resources));
  console.log(
    'Resource keys are identical:',
    JSON.stringify(Object.keys(graph1.resources)) === JSON.stringify(Object.keys(graph2.resources))
  );

  console.log('\\n=== Resource ID Consistency ===\\n');

  // Generate YAML multiple times - should be identical
  const yaml1 = graph1.toYaml();
  const yaml2 = graph2.toYaml();

  console.log('YAML outputs are identical:', yaml1 === yaml2);
  console.log('\\nFirst few lines of generated YAML:');
  console.log(yaml1.split('\\n').slice(0, 10).join('\\n'));

  console.log('\\n=== Factory Pattern with Deterministic IDs ===\\n');

  // Create factories - these should also be deterministic
  const directFactory1 = await graph1.factory('direct', { namespace: 'production' });
  const directFactory2 = await graph2.factory('direct', { namespace: 'production' });

  console.log('Factory 1 name:', directFactory1.name);
  console.log('Factory 2 name:', directFactory2.name);
  console.log('Factory names are identical:', directFactory1.name === directFactory2.name);

  console.log('\\n=== Benefits of Deterministic IDs ===\\n');
  console.log('✅ GitOps workflows: Same configuration always produces same resources');
  console.log('✅ Alchemy integration: Consistent resource identification across deployments');
  console.log('✅ State management: Reliable resource tracking and updates');
  console.log('✅ Debugging: Predictable resource names and relationships');
  console.log('✅ Testing: Reproducible test scenarios and assertions');
}

/**
 * Example showing ID generation strategies
 */
function demonstrateIdGeneration() {
  console.log('\\n=== ID Generation Strategies ===\\n');

  // Examples of deterministic ID generation
  const examples = [
    { kind: 'Deployment', name: 'my-app' },
    { kind: 'Service', name: 'my-app-service' },
    { kind: 'ConfigMap', name: 'app-config' },
    { kind: 'Secret', name: 'app-secrets' },
    { kind: 'PersistentVolumeClaim', name: 'data-storage' },
  ];

  console.log('Generated deterministic IDs:');
  for (const { kind, name } of examples) {
    const id = generateDeterministicResourceId(kind, name);
    console.log(`  ${kind} \"${name}\" -> \"${id}\"`);
  }

  console.log('\\nKey principles:');
  console.log('• IDs are generated from kind + name');
  console.log('• Same input always produces same output');
  console.log('• IDs are camelCase for consistency');
  console.log('• No random components or timestamps');

  console.log('\\n=== Alchemy Resource Configuration ===\\n');

  // Show how this applies to alchemy resource configuration
  const kubernetesResource = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'my-webapp',
      namespace: 'production',
    },
    spec: {
      replicas: 3,
      selector: {
        matchLabels: { app: 'my-webapp' },
      },
      template: {
        metadata: { labels: { app: 'my-webapp' } },
        spec: {
          containers: [
            {
              name: 'app',
              image: 'nginx:latest',
            },
          ],
        },
      },
    },
  };

  // This is how alchemy resources would be configured
  const alchemyConfig = {
    id: generateDeterministicResourceId(kubernetesResource.kind, kubernetesResource.metadata.name),
    type: kubernetesResource.kind, // Type matches Kubernetes kind
    config: kubernetesResource,
  };

  console.log('Alchemy resource configuration:');
  console.log('  ID:', alchemyConfig.id);
  console.log('  Type:', alchemyConfig.type);
  console.log('  Config: [Kubernetes resource object]');

  console.log('\\nThis ensures:');
  console.log('• Alchemy resources have consistent IDs');
  console.log('• Type field matches Kubernetes resource kind');
  console.log('• Same resource always gets same alchemy configuration');
}

// Run the examples
if (import.meta.main) {
  demonstrateDeterministicIds()
    .then(() => demonstrateIdGeneration())
    .catch(console.error);
}

export type { WebAppSpec, WebAppStatus };
