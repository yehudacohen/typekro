/**
 * Imperative Composition Pattern Examples
 *
 * This file demonstrates the kubernetesComposition API for creating
 * TypeKro resource graphs with natural composition patterns.
 */

import { type } from 'arktype';
import { Deployment, Service, ConfigMap, Ingress } from '../src/factories/simple/index.js';
import { Cel, kubernetesComposition } from '../src/index.js';

// =============================================================================
// Example 1: Simple Web Application
// =============================================================================

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  hostname: 'string',
});

const WebAppStatus = type({
  ready: 'boolean',
  replicas: 'number',
  url: 'string',
});

const simpleWebApp = kubernetesComposition(
  {
    name: 'simple-webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  // Single composition function: takes spec, returns status
  (spec) => {
    const deployment = Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      id: 'deployment', // Required for schema references
    });

    const _service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 8080 }],
      id: 'service', // Required for schema references
    });

    // Return status - resources are auto-captured
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' == ', spec.replicas),
      replicas: deployment.status.readyReplicas,
      url: `https://${spec.hostname}`,
    };
  }
);

// =============================================================================
// Example 2: Full-Stack Application with Database
// =============================================================================

const FullStackSpec = type({
  appName: 'string',
  appImage: 'string',
  dbName: 'string',
  hostname: 'string',
  replicas: 'number',
});

const FullStackStatus = type({
  phase: 'string',
  databaseReady: 'boolean',
  applicationReady: 'boolean',
  url: 'string',
  totalReplicas: 'number',
});

const fullStackApp = kubernetesComposition(
  {
    name: 'full-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStack',
    spec: FullStackSpec,
    status: FullStackStatus,
  },
  (spec) => {
    // Database tier
    const postgres = Deployment({
      name: 'postgres',
      image: 'postgres:13',
      env: {
        POSTGRES_DB: spec.dbName,
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'secret',
      },
      id: 'postgres', // Required for schema references
    });

    const _postgresService = Service({
      name: 'postgres-service',
      selector: { app: 'postgres' },
      ports: [{ port: 5432 }],
      id: 'postgresService', // Required for schema references
    });

    // Application tier
    const app = Deployment({
      name: spec.appName,
      image: spec.appImage,
      replicas: spec.replicas,
      env: {
        DATABASE_URL: Cel.template('postgres://app:secret@postgres-service:5432/%s', spec.dbName),
      },
      id: 'app', // Required for schema references
    });

    const _appService = Service({
      name: 'app-service',
      selector: { app: spec.appName },
      ports: [{ port: 80, targetPort: 8080 }],
      id: 'appService', // Required for schema references
    });

    const _ingress = Ingress({
      name: 'app-ingress',
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
                    name: 'app-service',
                    port: { number: 80 },
                  },
                },
              },
            ],
          },
        },
      ],
      id: 'ingress', // Required for schema references
    });

    // Return status
    return {
      phase: Cel.expr<string>(
        postgres.status.readyReplicas,
        ' > 0 && ',
        app.status.readyReplicas,
        ' > 0 ? "Ready" : "Pending"'
      ),
      databaseReady: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0'),
      applicationReady: Cel.expr<boolean>(app.status.readyReplicas, ' == ', spec.replicas),
      url: `https://${spec.hostname}`,
      totalReplicas: Cel.expr<number>(
        postgres.status.readyReplicas,
        ' + ',
        app.status.readyReplicas
      ),
    };
  }
);

// =============================================================================
// Example 3: Configuration-Driven Application
// =============================================================================

const ConfigAppSpec = type({
  name: 'string',
  image: 'string',
  config: {
    database: {
      host: 'string',
      port: 'number',
    },
    features: {
      enableAuth: 'boolean',
      enableMetrics: 'boolean',
    },
  },
});

const ConfigAppStatus = type({
  ready: 'boolean',
  configHash: 'string',
});

const configDrivenApp = kubernetesComposition(
  {
    name: 'config-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'ConfigApp',
    spec: ConfigAppSpec,
    status: ConfigAppStatus,
  },
  (spec) => {
    const appConfig = ConfigMap({
      name: Cel.template('%s-config', spec.name),
      data: {
        'database.host': spec.config.database.host,
        'database.port': spec.config.database.port.toString(),
        'features.auth': spec.config.features.enableAuth.toString(),
        'features.metrics': spec.config.features.enableMetrics.toString(),
      },
      id: 'appConfig', // Required for schema references
    });

    const deployment = Deployment({
      name: spec.name,
      image: spec.image,
      env: {
        CONFIG_PATH: '/etc/config',
      },
      volumes: [
        {
          name: 'config',
          configMap: { name: Cel.template('%s-config', spec.name) },
        },
      ],
      volumeMounts: [
        {
          name: 'config',
          mountPath: '/etc/config',
        },
      ],
      id: 'deployment', // Required for schema references
    });

    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      configHash: appConfig.metadata.resourceVersion || 'unknown',
    };
  }
);

// =============================================================================
// Usage Examples
// =============================================================================

console.log('=== TypeKro kubernetesComposition Examples ===\n');

console.log('1. Simple Web App:');
console.log(simpleWebApp.toYaml());

console.log('\n2. Full-Stack App:');
console.log(fullStackApp.toYaml());

console.log('\n3. Config-Driven App:');
console.log(configDrivenApp.toYaml());

export { simpleWebApp, fullStackApp, configDrivenApp };
