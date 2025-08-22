/**
 * Complete web application example using the new TypeKro API with separate ResourceBuilder and StatusBuilder
 */

import { type } from 'arktype';
import {
  Cel,
  simpleDeployment,
  simpleIngress,
  simpleNetworkPolicy,
  simpleService,
  toResourceGraph,
} from '../src/index.js';

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
  databaseReady: 'boolean',
  webAppReady: 'boolean',
  ingressReady: 'boolean',
  url: 'string',
  totalReplicas: 'number',
  readyReplicas: 'number',
});

// Create the complete web application resource graph
const completeWebappGraph = toResourceGraph(
  {
    name: 'complete-webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'CompleteWebApp',
    spec: CompleteWebAppSpecSchema,
    status: CompleteWebAppStatusSchema,
  },
  // ResourceBuilder function - defines all the Kubernetes resources
  (schema) => {
    // Define common labels for consistency
    const dbLabels = { app: 'postgres-db' };
    const webLabels = { app: schema.spec.name };

    return {
      database: simpleDeployment({
        name: 'postgres-db',
        image: schema.spec.databaseImage,

        env: {
          POSTGRES_DB: 'webapp',
          POSTGRES_USER: 'webapp',
          POSTGRES_PASSWORD: 'secure-password',
        },
        ports: [{ name: 'postgres', containerPort: 5432 }],
      }),

      databaseService: simpleService({
        name: 'postgres-service',
        selector: dbLabels,
        ports: [{ name: 'postgres', port: 5432, targetPort: 5432 }],
      }),

      webapp: simpleDeployment({
        name: schema.spec.name,
        image: schema.spec.webImage,
        replicas: schema.spec.replicas,

        env: {
          DATABASE_HOST: 'postgres-service', // Service name for internal DNS
          DATABASE_PORT: '5432',
          NODE_ENV: schema.spec.environment,
        },
        ports: [{ name: 'http', containerPort: 80 }],
      }),

      webappService: simpleService({
        name: 'webapp-service',
        selector: webLabels,
        ports: [{ name: 'http', port: 80, targetPort: 80 }],
      }),

      webappIngress: simpleIngress({
        name: 'webapp-ingress',
        ingressClassName: 'nginx',
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
                      name: 'webapp-service',
                      port: { name: 'http' },
                    },
                  },
                },
              ],
            },
          },
        ],
        tls: [{ hosts: [schema.spec.hostname], secretName: 'webapp-tls' }],
      }),

      webappNetworkPolicy: simpleNetworkPolicy({
        name: 'webapp-netpol',
        podSelector: { matchLabels: webLabels },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [{ namespaceSelector: { matchLabels: { name: 'ingress-nginx' } } }],
            ports: [{ protocol: 'TCP', port: 80 }],
          },
        ],
      }),

      databaseNetworkPolicy: simpleNetworkPolicy({
        name: 'database-netpol',
        podSelector: { matchLabels: dbLabels },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: webLabels } }],
            ports: [{ protocol: 'TCP', port: 5432 }],
          },
        ],
      }),
    };
  },
  // StatusBuilder function - defines how status fields map to resource status
  (schema, resources) => ({
    databaseReady: Cel.expr<boolean>(resources.database.status.readyReplicas, ' > 0'),
    webAppReady: Cel.expr<boolean>(
      resources.webapp.status.readyReplicas,
      ' == ',
      resources.webapp.spec.replicas
    ),
    ingressReady: Cel.expr<boolean>(
      resources.webappIngress.status.loadBalancer.ingress.length,
      ' > 0'
    ),
    url: Cel.template('https://%s', schema.spec.hostname),
    totalReplicas: resources.webapp.spec.replicas,
    readyReplicas: resources.webapp.status.readyReplicas,
  })
);

// Generate Kro YAML for the complete stack
const kroYaml = completeWebappGraph.toYaml();

console.log(
  'Generated Complete Web Application Stack:\n=========================================\n',
  kroYaml
);
