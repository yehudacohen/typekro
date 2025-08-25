/**
 * Complete web application example using the new TypeKro API with separate ResourceBuilder and StatusBuilder
 */

import { type } from 'arktype';
import { Cel, toResourceGraph } from '../src/index.js';
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

// Complete Web Application Resource Graph
export const completeWebApp = toResourceGraph(
  {
    name: 'complete-webapp',
    apiVersion: 'webapp.example.com/v1',
    kind: 'CompleteWebApp',
    spec: CompleteWebAppSpecSchema,
    status: CompleteWebAppStatusSchema,
  },
  (schema) => ({
    // Database deployment
    database: Deployment({
      name: Cel.template('%s-db', schema.spec.name),
      image: schema.spec.databaseImage,
      replicas: 1,
      ports: [{ containerPort: 5432 }],
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'webapp',
        POSTGRES_PASSWORD: 'secret',
      },
    }),

    // Database service
    dbService: Service({
      name: Cel.template('%s-db-service', schema.spec.name),
      selector: { app: Cel.template('%s-db', schema.spec.name) },
      ports: [{ port: 5432, targetPort: 5432 }],
    }),

    // Web application deployment
    webApp: Deployment({
      name: schema.spec.name,
      image: schema.spec.webImage,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        NODE_ENV: schema.spec.environment,
        DATABASE_URL: Cel.template(
          'postgresql://webapp:secret@%s-db-service:5432/webapp',
          schema.spec.name
        ),
      },
    }),

    // Web service
    webService: Service({
      name: Cel.template('%s-service', schema.spec.name),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
    }),

    // Ingress for external access
    ingress: Ingress({
      name: Cel.template('%s-ingress', schema.spec.name),
      rules: [
        {
          host: schema.spec.hostname,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: Cel.template('%s-service', schema.spec.name),
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
          secretName: Cel.template('%s-tls', schema.spec.name),
          hosts: [schema.spec.hostname],
        },
      ],
    }),

    // Network policy for security
    webNetworkPolicy: NetworkPolicy({
      name: Cel.template('%s-web-policy', schema.spec.name),
      podSelector: { matchLabels: { app: schema.spec.name } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{ namespaceSelector: {} }],
          ports: [{ protocol: 'TCP', port: 3000 }],
        },
      ],
    }),

    // Database network policy
    dbNetworkPolicy: NetworkPolicy({
      name: Cel.template('%s-db-policy', schema.spec.name),
      podSelector: { matchLabels: { app: Cel.template('%s-db', schema.spec.name) } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { app: schema.spec.name } } }],
          ports: [{ protocol: 'TCP', port: 5432 }],
        },
      ],
    }),
  }),
  (schema, resources) => ({
    url: Cel.template('https://%s', schema.spec.hostname),
    ready: Cel.expr<boolean>(
      resources.database.status.readyReplicas,
      ' >= 1 && ',
      resources.webApp.status.readyReplicas,
      ' >= ',
      schema.spec.replicas
    ),
    phase: Cel.expr<'pending' | 'running' | 'failed'>(
      resources.database.status.readyReplicas,
      ' > 0 && ',
      resources.webApp.status.readyReplicas,
      ' >= ',
      resources.webApp.status.replicas,
      ' ? "running" : "failed"'
    ),
    databaseReady: Cel.expr<boolean>(resources.database.status.readyReplicas, ' >= 1'),
    webReady: Cel.expr<boolean>(
      resources.webApp.status.readyReplicas,
      ' >= ',
      schema.spec.replicas
    ),
  })
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
