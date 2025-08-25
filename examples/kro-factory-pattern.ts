/**
 * Kro Factory Pattern Example
 *
 * This example demonstrates how to use the Kro Factory Pattern to create
 * typed ResourceGraphDefinitions with external reference composition using
 * the builder function approach with ArkType schemas.
 */

import { type } from 'arktype';
import { Deployment, Service, Pvc } from '../src/factories/simple/index.js';
import {
  Cel,
  externalRef,
  
  toResourceGraph,
} from '../src/index.js';

// =============================================================================
// 1. DEFINE ARKTYPE SCHEMAS FOR DATABASE CRD
// =============================================================================

const DatabaseSpecSchema = type({
  name: 'string',
  storage: 'string',
  version: 'string',
});

const DatabaseStatusSchema = type({
  connectionString: 'string',
  host: 'string',
  port: 'number%1', // integer
  ready: 'boolean',
});

// Infer TypeScript types from ArkType schemas
type DatabaseSpec = typeof DatabaseSpecSchema.infer;
type DatabaseStatus = typeof DatabaseStatusSchema.infer;

// =============================================================================
// 2. DEFINE ARKTYPE SCHEMAS FOR WEBAPP CRD
// =============================================================================

const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1', // integer
});

const WebAppStatusSchema = type({
  url: 'string',
  replicas: 'number%1', // integer
  ready: 'boolean',
});

// Infer TypeScript types from ArkType schemas
type WebAppSpec = typeof WebAppSpecSchema.infer;
type WebAppStatus = typeof WebAppStatusSchema.infer;

// =============================================================================
// 3. CREATE DATABASE FACTORY USING BUILDER FUNCTION
// =============================================================================

const databaseFactory = toResourceGraph(
  {
    name: 'database-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'Database',
    spec: DatabaseSpecSchema,
    status: DatabaseStatusSchema,
  },
  (_schema) => ({
    deployment: Deployment({
      name: 'database-deployment',
      image: 'postgres:13', // Simplified for now
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

    service: Service({
      name: 'database-service',
      selector: { app: 'database' },
      ports: [{ port: 5432, targetPort: 5432 }],
    }),

    pvc: Pvc({
      name: 'database-storage',
      size: '10Gi', // Simplified for now
      accessModes: ['ReadWriteOnce'],
    }),
  }),
  (_schema, _resources) => ({
    connectionString: 'postgres://webapp:secure-password@database-service:5432/webapp',
    host: 'database-service',
    port: 5432,
    ready: true,
  })
);

// =============================================================================
// 4. CREATE WEBAPP FACTORY WITH EXTERNAL DATABASE DEPENDENCY
// =============================================================================

const webappFactory = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (schema) => {
    // External reference to a database instance
    const database = externalRef<DatabaseSpec, DatabaseStatus>(
      'example.com/v1alpha1',
      'Database',
      'production-database'
    );

    return {
      database, // Include the external reference in the resource graph

      deployment: Deployment({
        name: 'webapp-deployment',
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        env: {
          // Reference external database status
          DATABASE_URL: database.status.connectionString,
          DATABASE_HOST: database.status.host,
          DATABASE_PORT: Cel.string(database.status.port), // Convert number to string for env var
          NODE_ENV: 'production',
        },
        ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
        resources: {
          requests: { cpu: '50m', memory: '128Mi' },
          limits: { cpu: '200m', memory: '256Mi' },
        },
      }),

      service: Service({
        name: 'webapp-service',
        selector: { app: 'webapp' },
        ports: [{ port: 80, targetPort: 3000 }],
        type: 'LoadBalancer',
      }),
    };
  },
  (_schema, resources) => ({
    url: 'http://webapp.example.com',
    replicas: resources.deployment?.status.readyReplicas || 0,
    ready: true,
  })
);

// =============================================================================
// 5. DEMONSTRATE FACTORY USAGE
// =============================================================================

console.log('=== Database ResourceGraphDefinition ===');
console.log(databaseFactory.toYaml());

console.log('\n=== WebApp ResourceGraphDefinition (with external reference) ===');
console.log(webappFactory.toYaml());

// =============================================================================
// 6. DEMONSTRATE CRD INSTANCE CREATION (Note: getInstance not yet implemented)
// =============================================================================

console.log('\n=== CRD Instance Creation (Conceptual) ===');

// Note: getInstance functionality is not yet implemented in the current version
// This shows what the API will look like when completed

console.log('Database instance would be created with:');
console.log('databaseFactory.getInstance({');
console.log('  name: "myapp-db",');
console.log('  storage: "20Gi",');
console.log('  version: "14"');
console.log('});');

console.log('\nWebApp instance would be created with:');
console.log('webappFactory.getInstance({');
console.log('  name: "myapp-web",');
console.log('  image: "myapp:latest",');
console.log('  replicas: 5');
console.log('});');

// When implemented, these would return Enhanced proxies with type-safe access:
// const databaseInstance = databaseFactory.getInstance({ ... });
// const webappInstance = webappFactory.getInstance({ ... });

// =============================================================================
// 7. DEMONSTRATE TYPE SAFETY
// =============================================================================

console.log('\n=== Type Safety Demonstration ===');

// Schema proxy provides type-safe access during factory definition
console.log('Schema proxy provides type-safe references:');
console.log('- schema.spec.name creates KubernetesRef<string>');
console.log('- schema.spec.replicas creates KubernetesRef<number>');
console.log('- schema.status.connectionString creates KubernetesRef<string>');

// These would be compile-time errors in the factory builder:
// schema.spec.nonExistentField; // ❌ Property doesn't exist on DatabaseSpec
// schema.status.invalidField;   // ❌ Property doesn't exist on DatabaseStatus

// ArkType provides runtime validation:
console.log('\nArkType schemas provide runtime validation:');
console.log(
  '- DatabaseSpecSchema validates: name (string), storage (string), version (optional string)'
);
console.log(
  '- WebAppSpecSchema validates: name (string), image (string), replicas (optional number)'
);

console.log('\n✅ Full type safety from schema definition to resource creation!');

// =============================================================================
// 8. DEMONSTRATE COMPOSITION
// =============================================================================

console.log('\n=== Composition Example ===');

// Define ArkType schema for monitoring
const MonitoringSpecSchema = type({
  interval: 'string',
  enabled: 'boolean',
});

const MonitoringStatusSchema = type({
  healthy: 'boolean',
  lastCheck: 'string',
});

// Create a monitoring factory that references both database and webapp
const monitoringFactory = toResourceGraph(
  {
    name: 'monitoring-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'Monitoring',
    spec: MonitoringSpecSchema,
    status: MonitoringStatusSchema,
  },
  (_schema) => {
    const database = externalRef<DatabaseSpec, DatabaseStatus>(
      'example.com/v1alpha1',
      'Database',
      'production-database'
    );

    const webapp = externalRef<WebAppSpec, WebAppStatus>(
      'example.com/v1alpha1',
      'WebApp',
      'production-webapp'
    );

    return {
      database,
      webapp,

      deployment: Deployment({
        name: 'monitoring-deployment',
        image: 'prometheus:latest',
        env: {
          DB_MONITOR_URL: database.status.connectionString,
          WEB_MONITOR_URL: webapp.status.url,
          SCRAPE_INTERVAL: '30s',
        },
      }),
    };
  },
  (_schema, _resources) => ({
    healthy: true,
    lastCheck: new Date().toISOString(),
  })
);

console.log('Monitoring ResourceGraphDefinition with multiple external references:');
console.log(monitoringFactory.toYaml());

console.log('\n🎉 Kro Factory Pattern example completed successfully!');
