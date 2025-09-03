/**
 * Basic web application example using TypeKro's kubernetesComposition pattern
 */

import { type } from 'arktype';
import { kubernetesComposition } from '../src/index.js';
import { Deployment, Service, Ingress, Job } from '../src/factories/simple/index.js';

// Define the schema for our WebApp stack
const WebAppSpecSchema = type({
  name: 'string',
  databaseImage: 'string',
  webImage: 'string',
  replicas: 'number',
  hostname: 'string',
  environment: 'string',
});

const WebAppStatusSchema = type({
  url: 'string',
  ready: 'boolean',
});

// Complete Web Application Composition
const webApp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  // Single composition function: takes spec, returns status, resources auto-captured
  (spec) => {
    // Database deployment - auto-registered
    const database = Deployment({
      name: `${spec.name}-db`,
      image: spec.databaseImage,
      ports: [{ containerPort: 5432 }],
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'webapp',
        POSTGRES_PASSWORD: 'secret',
      },
      id: 'database', // Required for schema references
    });

    // Database service - auto-registered
    const _dbService = Service({
      name: `${spec.name}-db-service`,
      selector: { app: `${spec.name}-db` },
      ports: [{ port: 5432, targetPort: 5432 }],
      id: 'dbService', // Required for schema references
    });

    // Web application deployment - auto-registered
    const webDeployment = Deployment({
      name: spec.name,
      image: spec.webImage,
      replicas: spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        NODE_ENV: spec.environment,
        // ✨ JavaScript template literal - automatically converted to CEL
        DATABASE_URL: `postgresql://webapp:secret@${spec.name}-db-service:5432/webapp`,
      },
      id: 'webDeployment', // Required for schema references
    });

    // Web service - auto-registered
    const _webService = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      id: 'webService', // Required for schema references
    });

    // Ingress for external access - auto-registered
    const _ingress = Ingress({
      name: `${spec.name}-ingress`,
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
                    name: `${spec.name}-service`,
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

    // Database migration job - auto-registered
    const _migration = Job({
      name: `${spec.name}-migration`,
      image: spec.webImage,
      command: ['npm', 'run', 'migrate']
    });

    // Return status (resources are auto-captured)
    // ✨ Natural JavaScript expressions - automatically converted to CEL
    return {
      url: `https://${spec.hostname}`,
      ready: webDeployment.status.readyReplicas >= spec.replicas && database.status.readyReplicas > 0,
    };
  }
);

// Example usage
console.log('=== Basic WebApp Example ===');
console.log(webApp.toYaml());

export { webApp };
