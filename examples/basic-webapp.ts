/**
 * Basic web application example using the new TypeKro API with separate ResourceBuilder and StatusBuilder
 */

import { type } from 'arktype';
import {
  toResourceGraph,
  simpleDeployment,
  simpleJob,
} from '../src/index.js';

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

// Create the resource graph using the new API
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
    database: simpleDeployment({
      name: 'postgres-db',
      image: schema.spec.databaseImage,
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
    }),

    migration: simpleJob({
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
    }),

    webapp: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.webImage,
      replicas: schema.spec.replicas,
      env: {
        DATABASE_PORT: '5432',
        NODE_ENV: schema.spec.environment,
      },
      ports: [{ name: 'http', containerPort: 80, protocol: 'TCP' }],
      resources: {
        requests: { cpu: '50m', memory: '128Mi' },
        limits: { cpu: '200m', memory: '256Mi' },
      },
    }),
  }),
  // StatusBuilder function - defines how status fields map to resource status
  (_schema, resources) => ({
    databaseReady: true, // Simple boolean value - CEL expressions are handled at serialization
    webAppReady: true, // Simple boolean value
    totalReplicas: resources.webapp?.spec.replicas || 0,
    readyReplicas: resources.webapp?.status.readyReplicas || 0,
    url: 'http://webapp.example.com', // Simple string value
  })
);

// Generate Kro YAML
const kroYaml = webappGraph.toYaml();

console.log(
  'Generated Kro ResourceGraphDefinition:\n=====================================\n',
  kroYaml
);

// Note: Resource validation would be done on actual Kubernetes resources
console.log('\n✅ WebApp resource graph created successfully!');
