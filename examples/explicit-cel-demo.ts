/**
 * Demonstration of explicit CEL type conversions
 *
 * This example shows how to use Cel.string() for explicit type conversions
 * instead of relying on implicit magic conversions.
 */

import { Cel } from '../src/core/references/index.js';
import { serializeResourceGraphToYaml, simpleConfigMap, simpleDeployment, simpleSecret } from '../src/index';

// Create a database deployment
const database = simpleDeployment({
  name: 'postgres-db',
  namespace: 'demo',
  image: 'postgres:13-alpine',
  replicas: 1,
  env: {
    POSTGRES_DB: 'webapp',
    POSTGRES_USER: 'webapp',
    POSTGRES_PASSWORD: 'secure-password',
  },
  ports: [{ containerPort: 5432, name: 'postgres' }],
});

// Create configuration
const appConfig = simpleConfigMap({
  name: 'app-config',
  namespace: 'demo',
  data: {
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://localhost:5432/webapp',
  },
});

// Create secrets
const appSecrets = simpleSecret({
  name: 'app-secrets',
  namespace: 'demo',
  stringData: {
    API_KEY: 'super-secret-key',
    JWT_SECRET: 'jwt-signing-secret',
  },
});

// Create webapp deployment with explicit CEL conversions
const webapp = simpleDeployment({
  name: 'webapp',
  namespace: 'demo',
  image: 'nginx:alpine',
  replicas: 2,
  env: {
    // ✅ String references work directly (non-null assertion since we know data exists)
    LOG_LEVEL: appConfig.data!.LOG_LEVEL!,
    API_KEY: appSecrets.data!.API_KEY!,

    // ✅ Explicit conversion for numeric values
    DATABASE_READY_REPLICAS: Cel.string(database.status.readyReplicas),
    DATABASE_REPLICAS: Cel.string(database.status.replicas),

    // ✅ Explicit conversion for other numeric fields
    OBSERVED_GENERATION: Cel.string(database.status.observedGeneration),

    // ❌ This would cause a TypeScript compile error:
    // DATABASE_READY_REPLICAS: database.status.readyReplicas, // KubernetesRef<number> not assignable to EnvVarValue
  },
  ports: [{ containerPort: 80, name: 'http' }],
});

// Generate the Kro ResourceGraphDefinition
const kroYaml = serializeResourceGraphToYaml(
  'explicit-cel-demo',
  {
    database,
    appConfig,
    appSecrets,
    webapp,
  },
  { namespace: 'demo' }
);

console.log('Generated Kro YAML with explicit CEL conversions:');
console.log('='.repeat(50));
console.log(kroYaml);

// The generated YAML will contain:
// - ${database.status.readyReplicas} for basic references
// - ${string(database.status.readyReplicas)} for explicit string conversions
