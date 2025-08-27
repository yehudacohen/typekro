/**
 * Complete web application example using TypeKro's kubernetesComposition pattern
 * Demonstrates advanced status builders and CEL expressions
 */

import { type } from 'arktype';
import { Cel, kubernetesComposition } from '../src/index.js';
import { Deployment, Service, Ingress, NetworkPolicy } from '../src/factories/simple/index.js';

// Define the schema for our complete web application
const CompleteWebAppSpecSchema = type({
  name: 'string',
  databaseImage: 'string',
  webImage: 'string',
  replicas: 'number',
  hostname: 'string',
  environment: 'string',
});

const CompleteWebAppStatusSchema = type({
  url: 'string',
  ready: 'boolean',
  phase: '"pending" | "running" | "failed"',
  databaseReady: 'boolean',
  webReady: 'boolean',
});

// Complete Web Application Composition
export const completeWebApp = kubernetesComposition(
  {
    name: 'complete-webapp',
    apiVersion: 'webapp.example.com/v1',
    kind: 'CompleteWebApp',
    spec: CompleteWebAppSpecSchema,
    status: CompleteWebAppStatusSchema,
  },
  (spec) => {
    // Database deployment
    const database = Deployment({
      name: Cel.template('%s-db', spec.name),
      image: spec.databaseImage,
      replicas: 1,
      ports: [{ containerPort: 5432 }],
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'webapp',
        POSTGRES_PASSWORD: 'secret',
      },
      id: 'database',
    });

    // Database service
    const _dbService = Service({
      name: Cel.template('%s-db-service', spec.name),
      selector: { app: Cel.template('%s-db', spec.name) },
      ports: [{ port: 5432, targetPort: 5432 }],
      id: 'dbService',
    });

    // Web application deployment
    const webApp = Deployment({
      name: spec.name,
      image: spec.webImage,
      replicas: spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        NODE_ENV: spec.environment,
        DATABASE_URL: Cel.template(
          'postgresql://webapp:secret@%s-db-service:5432/webapp',
          spec.name
        ),
      },
      id: 'webApp',
    });

    // Web service
    const _webService = Service({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      id: 'webService',
    });

    // Ingress for external access
    const _ingress = Ingress({
      name: Cel.template('%s-ingress', spec.name),
      rules: [
        {
          host: spec.hostname,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: Cel.template('%s-service', spec.name),
                    port: { number: 80 },
                  },
                },
              },
            ],
          },
        },
      ],
      tls: [
        {
          secretName: Cel.template('%s-tls', spec.name),
          hosts: [spec.hostname],
        },
      ],
      id: 'ingress',
    });

    // Network policy for security
    const _webNetworkPolicy = NetworkPolicy({
      name: Cel.template('%s-web-policy', spec.name),
      podSelector: { matchLabels: { app: spec.name } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{ namespaceSelector: {} }],
          ports: [{ protocol: 'TCP', port: 3000 }],
        },
      ],
      id: 'webNetworkPolicy',
    });

    // Database network policy
    const _dbNetworkPolicy = NetworkPolicy({
      name: Cel.template('%s-db-policy', spec.name),
      podSelector: { matchLabels: { app: Cel.template('%s-db', spec.name) } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { app: spec.name } } }],
          ports: [{ protocol: 'TCP', port: 5432 }],
        },
      ],
      id: 'dbNetworkPolicy',
    });

    // Return status (resources are auto-captured)
    return {
      url: Cel.template('https://%s', spec.hostname),
      ready: Cel.expr<boolean>(
        database.status.readyReplicas,
        ' >= 1 && ',
        webApp.status.readyReplicas,
        ' >= ',
        spec.replicas
      ),
      phase: Cel.expr<'pending' | 'running' | 'failed'>(
        database.status.readyReplicas,
        ' > 0 && ',
        webApp.status.readyReplicas,
        ' >= ',
        webApp.status.replicas,
        ' ? "running" : "failed"'
      ),
      databaseReady: Cel.expr<boolean>(database.status.readyReplicas, ' >= 1'),
      webReady: Cel.expr<boolean>(
        webApp.status.readyReplicas,
        ' >= ',
        spec.replicas
      ),
    };
  }
);

// Example usage
async function main() {
  console.log('🚀 Complete WebApp Example');
  console.log('===========================');

  const _result = completeWebApp.toYaml();

  console.log('✅ Complete WebApp resource graph created!');
  console.log('   - Database with PostgreSQL');
  console.log('   - Web application deployment');
  console.log('   - Services for internal communication');
  console.log('   - Ingress for external access');
  console.log('   - Network policies for security');
  console.log('   - Cross-resource references with CEL expressions');
  console.log('\n🔧 Resource Graph Details:');
  console.log(`   - Name: complete-webapp`);
  console.log(`   - API Version: webapp.example.com/v1`);
  console.log(`   - Kind: CompleteWebApp`);
}

// Run example if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
