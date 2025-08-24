/**
 * Basic web application example using TypeKro's imperative composition pattern
 */

import { type } from 'arktype';
import { kubernetesComposition, simpleDeployment, simpleJob, simpleService, Cel } from '../src/index.js';

// Define the schema for our WebApp stack
const WebAppSpecSchema = type({
  name: 'string',
  databaseImage: 'string',
  webImage: 'string',
  replicas: 'number',
  environment: 'string',
});

const WebAppStatusSchema = type({
  databaseReady: 'boolean',
  webAppReady: 'boolean',
  totalReplicas: 'number',
  readyReplicas: 'number',
  url: 'string',
});

// Create the resource graph using imperative composition
const webappGraph = kubernetesComposition(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (spec) => {
    // Resources auto-register when created - no explicit builders needed!
    const database = simpleDeployment({
      name: 'postgres-db',
      image: spec.databaseImage,
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'webapp',
        POSTGRES_PASSWORD: 'secure-password',
      },
      ports: [{ name: 'postgres', containerPort: 5432, protocol: 'TCP' }],
      resources: {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
    });

    const migration = simpleJob({
      name: 'db-migration',
      image: 'migrate/migrate',
      command: [
        'migrate',
        '-path',
        '/migrations',
        '-database',
        'postgres://webapp:secure-password@postgres-db:5432/webapp?sslmode=disable',
        'up',
      ],
      completions: 1,
      backoffLimit: 3,
    });

    // Migration job is created but not referenced in status
    void migration;

    const webapp = simpleDeployment({
      name: spec.name,
      image: spec.webImage,
      replicas: spec.replicas,
      env: {
        DATABASE_PORT: '5432',
        NODE_ENV: spec.environment,
      },
      ports: [{ name: 'http', containerPort: 80, protocol: 'TCP' }],
      resources: {
        requests: { cpu: '50m', memory: '128Mi' },
        limits: { cpu: '200m', memory: '256Mi' },
      },
    });

    const webappService = simpleService({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }],
      type: 'ClusterIP'
    });

    // Return status with CEL expressions and resource references
    return {
      databaseReady: Cel.expr<boolean>(database.status.readyReplicas, ' > 0'),
      webAppReady: Cel.expr<boolean>(webapp.status.readyReplicas, ' >= ', spec.replicas),
      totalReplicas: webapp.spec.replicas,
      readyReplicas: webapp.status.readyReplicas,
      url: Cel.template('http://%s', webappService.status.clusterIP),
    };
  }
);



// =============================================================================
// USAGE EXAMPLES
// =============================================================================

async function demonstrateUsage() {
  console.log('=== TypeKro Basic WebApp Example ===\n');

  console.log('1. Generate YAML:');
  const yaml = webappGraph.toYaml();
  console.log('Generated YAML length:', yaml.length, 'characters');

  console.log('\n2. Deployment Example:');
  try {
    const factory = webappGraph.factory('direct', { namespace: 'development' });
    const instance = await factory.deploy({
      name: 'my-webapp',
      databaseImage: 'postgres:15',
      webImage: 'nginx:latest',
      replicas: 2,
      environment: 'development'
    });
    console.log('Deployed instance:', instance.metadata.name);
  } catch (error) {
    console.log('Deployment would happen with real cluster connection');
  }
}

// Run examples if this file is executed directly
if (import.meta.main) {
  demonstrateUsage().catch(console.error);
}

export { webappGraph };

console.log('\n✅ WebApp resource graphs created successfully!');
