/**
 * Imperative Composition Pattern Examples
 * 
 * This file demonstrates the new kubernetesComposition API - the recommended
 * approach for creating TypeKro resource graphs with natural, imperative JavaScript.
 */

import { type } from 'arktype';
import {
  kubernetesComposition,
  simpleDeployment,
  simpleService,
  simpleConfigMap,
  simpleIngress,
  Cel,
} from '../src/index.js';

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
  (spec) => {
    // Resources auto-register when called - no explicit resource builders needed!
    const deployment = simpleDeployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
    });

    const service = simpleService({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 8080 }],
    });

    // Return status with CEL expressions and resource references
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' == ', spec.replicas),
      replicas: deployment.status.readyReplicas,
      url: Cel.template('https://%s', spec.hostname),
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
    const postgres = simpleDeployment({
      name: 'postgres',
      image: 'postgres:13',
      env: {
        POSTGRES_DB: spec.dbName,
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'secret',
      },
    });

    const postgresService = simpleService({
      name: 'postgres-service',
      selector: { app: 'postgres' },
      ports: [{ port: 5432 }],
    });

    // Application tier
    const app = simpleDeployment({
      name: spec.appName,
      image: spec.appImage,
      replicas: spec.replicas,
      env: {
        DATABASE_URL: Cel.template(
          'postgres://app:secret@%s:5432/%s',
          postgresService.metadata.name,
          spec.dbName
        ),
      },
    });

    const appService = simpleService({
      name: 'app-service',
      selector: { app: spec.appName },
      ports: [{ port: 80, targetPort: 8080 }],
    });

    const ingress = simpleIngress({
      name: 'app-ingress',
      rules: [{
        host: spec.hostname,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: {
                name: 'app-service',
                port: { number: 80 }
              }
            }
          }]
        }
      }],
    });

    // Return comprehensive status using CEL expressions
    return {
      phase: Cel.expr<string>(
        postgres.status.readyReplicas, ' > 0 && ',
        app.status.readyReplicas, ' > 0 ? "Ready" : "Pending"'
      ),
      databaseReady: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0'),
      applicationReady: Cel.expr<boolean>(app.status.readyReplicas, ' == ', spec.replicas),
      url: Cel.template('https://%s', spec.hostname),
      totalReplicas: Cel.expr<number>(postgres.status.readyReplicas, ' + ', app.status.readyReplicas),
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
    // Create configuration
    const appConfig = simpleConfigMap({
      name: `${spec.name}-config`,
      data: {
        'database.host': spec.config.database.host,
        'database.port': spec.config.database.port.toString(),
        'features.auth': spec.config.features.enableAuth.toString(),
        'features.metrics': spec.config.features.enableMetrics.toString(),
      },
    });

    // Application deployment that uses the config
    const deployment = simpleDeployment({
      name: spec.name,
      image: spec.image,
      env: {
        CONFIG_PATH: '/etc/config',
      },
      volumes: [
        {
          name: 'config',
          configMap: { name: appConfig.metadata.name || 'config' },
        },
      ],
      volumeMounts: [
        {
          name: 'config',
          mountPath: '/etc/config',
        },
      ],
    });

    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      configHash: appConfig.metadata.resourceVersion || 'unknown',
    };
  }
);

// =============================================================================
// Example 4: Microservices Architecture
// =============================================================================

const MicroservicesSpec = type({
  services: {
    frontend: {
      image: 'string',
      replicas: 'number',
    },
    api: {
      image: 'string',
      replicas: 'number',
    },
    worker: {
      image: 'string',
      replicas: 'number',
    },
  },
  hostname: 'string',
});

const MicroservicesStatus = type({
  ready: 'boolean',
  servicesReady: {
    frontend: 'boolean',
    api: 'boolean',
    worker: 'boolean',
  },
  totalReplicas: 'number',
  url: 'string',
});

const microservicesApp = kubernetesComposition(
  {
    name: 'microservices',
    apiVersion: 'example.com/v1alpha1',
    kind: 'Microservices',
    spec: MicroservicesSpec,
    status: MicroservicesStatus,
  },
  (spec) => {
    // Frontend service
    const frontend = simpleDeployment({
      name: 'frontend',
      image: spec.services.frontend.image,
      replicas: spec.services.frontend.replicas,
    });

    const frontendService = simpleService({
      name: 'frontend-service',
      selector: { app: 'frontend' },
      ports: [{ port: 80, targetPort: 3000 }],
    });

    // API service
    const api = simpleDeployment({
      name: 'api',
      image: spec.services.api.image,
      replicas: spec.services.api.replicas,
    });

    const apiService = simpleService({
      name: 'api-service',
      selector: { app: 'api' },
      ports: [{ port: 8080 }],
    });

    // Worker service
    const worker = simpleDeployment({
      name: 'worker',
      image: spec.services.worker.image,
      replicas: spec.services.worker.replicas,
    });

    // Ingress for external access
    const ingress = simpleIngress({
      name: 'microservices-ingress',
      rules: [{
        host: spec.hostname,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: {
                name: 'frontend-service',
                port: { number: 80 }
              }
            }
          }]
        }
      }],
    });

    return {
      ready: Cel.expr<boolean>(
        frontend.status.readyReplicas, ' == ', spec.services.frontend.replicas, ' && ',
        api.status.readyReplicas, ' == ', spec.services.api.replicas, ' && ',
        worker.status.readyReplicas, ' == ', spec.services.worker.replicas
      ),
      servicesReady: {
        frontend: Cel.expr<boolean>(frontend.status.readyReplicas, ' == ', spec.services.frontend.replicas),
        api: Cel.expr<boolean>(api.status.readyReplicas, ' == ', spec.services.api.replicas),
        worker: Cel.expr<boolean>(worker.status.readyReplicas, ' == ', spec.services.worker.replicas),
      },
      totalReplicas: Cel.expr<number>(
        frontend.status.readyReplicas, ' + ',
        api.status.readyReplicas, ' + ',
        worker.status.readyReplicas
      ),
      url: Cel.template('https://%s', spec.hostname),
    };
  }
);

// =============================================================================
// Usage Examples
// =============================================================================

async function demonstrateUsage() {
  console.log('=== TypeKro Imperative Composition Examples ===\n');

  // Example 1: Deploy simple web app with Kro
  console.log('1. Simple Web App (Kro deployment):');
  const kroFactory = await simpleWebApp.factory('kro');
  console.log('Generated Kro YAML:');
  console.log(kroFactory.toYaml());

  // Example 2: Deploy full-stack app directly
  console.log('\n2. Full-Stack App (Direct deployment):');
  const directFactory = await fullStackApp.factory('direct');
  console.log('Generated Direct YAML:');
  console.log(directFactory.toYaml({
    appName: 'my-fullstack',
    appImage: 'myapp:latest',
    dbName: 'webapp',
    hostname: 'myapp.example.com',
    replicas: 2,
  }));

  // Example 3: Deploy with specific instance
  console.log('\n3. Config-Driven App (Instance deployment):');
  try {
    const instance = await configDrivenApp.factory('kro').deploy({
      name: 'my-config-app',
      image: 'my-app:latest',
      config: {
        database: {
          host: 'postgres.default.svc.cluster.local',
          port: 5432,
        },
        features: {
          enableAuth: true,
          enableMetrics: false,
        },
      },
    });
    console.log('Deployed instance:', instance.metadata.name);
  } catch (error) {
    console.log('Deployment would happen with real cluster connection');
  }

  // Example 4: Generate YAML for microservices
  console.log('\n4. Microservices Architecture:');
  const microservicesYaml = microservicesApp.toYaml();
  console.log('Generated microservices YAML length:', microservicesYaml.length, 'characters');
}

// Run examples if this file is executed directly
if (import.meta.main) {
  demonstrateUsage().catch(console.error);
}

export {
  simpleWebApp,
  fullStackApp,
  configDrivenApp,
  microservicesApp,
};