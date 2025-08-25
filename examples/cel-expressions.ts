/**
 * CEL Expression Examples
 *
 * This example demonstrates how to use CEL expressions for complex runtime
 * evaluations while maintaining type safety with KubernetesRef types.
 */

import { Deployment, Service } from '../src/factories/simple/index.js';
import { Cel, serializeResourceGraphToYaml } from '../src/index.js';
// Create base resources
const database = Deployment({
  name: 'postgres',
  image: 'postgres:13',
  replicas: 1,
  env: {
    POSTGRES_DB: 'webapp',
    POSTGRES_USER: 'webapp',
    POSTGRES_PASSWORD: 'secure-password',
  },
});

const webapp = Deployment({
  name: 'webapp',
  image: 'nginx:latest',
  replicas: 3,
  env: {
    // Simple reference using CEL to handle potential undefined
    DATABASE_HOST: Cel.expr<string>`${database.metadata.name} || "postgres"`,
    DATABASE_PORT: '5432',

    // CEL escape hatch for complex expressions
    DATABASE_STATUS: Cel.conditional<string>(
      database.status.readyReplicas,
      "'ready'",
      "'not-ready'"
    ),

    // Complex mathematical expression (converted to string for env var)
    SCALING_FACTOR: Cel.string(Cel.min(Cel.expr(database.status.readyReplicas, ' * 2'), 10)),

    // String interpolation with conditions
    CONNECTION_STRING: Cel.expr<string>(
      database.status.readyReplicas,
      " > 0 ? 'postgres://webapp:secure-password@' + ",
      database.metadata.name,
      " + ':5432/webapp' : 'sqlite://fallback.db'"
    ),

    // Template-based approach
    STATUS_MESSAGE: Cel.template(
      'Database %s has %s ready replicas',
      database.metadata.name,
      database.status.readyReplicas
    ),
  },
});

const _service = Service({
  name: 'webapp-service',
  selector: { app: 'webapp' },
  ports: [{ port: 80, targetPort: 80 }],
});

// Generate and display the Kro resource graph
if (import.meta.main) {
  const yaml = serializeResourceGraphToYaml('webapp-with-cel', {
    database,
    webapp,
    _service,
  });

  console.log('CEL Expression Example:');
  console.log('=====================');
  console.log(yaml);
}

export { database, webapp, _service as service };
