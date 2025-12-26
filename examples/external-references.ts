/**
 * External References Example - Both Explicit and Implicit Patterns
 *
 * This example demonstrates TypeKro's patterns for cross-composition references:
 * 
 * 1. EXPLICIT externalRef() - for resources created outside TypeKro (Helm, kubectl, etc.)
 * 2. IMPLICIT magic proxy (intra-composition) - for resource references within the same composition
 * 3. IMPLICIT magic proxy (cross-composition) - for accessing resources from other compositions
 */

import { type } from 'arktype';
import { kubernetesComposition, externalRef } from '../src/index.js';
import { Deployment, Service, } from '../src/factories/simple/index.js';

// =============================================================================
// 1. Database Composition (managed by Database Team)
// =============================================================================

const DatabaseSpec = type({
  engine: 'string',
  version: 'string',
});

const DatabaseStatus = type({
  connectionString: 'string',
  ready: 'boolean',
});

const databaseComposition = kubernetesComposition(
  {
    name: 'database',
    apiVersion: 'data.company.com/v1alpha1',
    kind: 'Database',
    spec: DatabaseSpec,
    status: DatabaseStatus,
  },
  (spec) => {
    const database = Deployment({
      name: 'postgres-db',
      image: `${spec.engine}:${spec.version}`, // ✨ Natural JavaScript template literal
      env: {
        POSTGRES_DB: 'appdb',
        POSTGRES_USER: 'appuser',
        POSTGRES_PASSWORD: 'secure-password',
      },
      ports: [{ containerPort: 5432 }],
      id: 'database',
    });

    const _service = Service({
      name: 'database-service',
      selector: { app: 'postgres-db' },
      ports: [{ port: 5432, targetPort: 5432 }],
      id: 'databaseService',
    });

    return {
      connectionString: 'postgresql://appuser:secure-password@database-service:5432/appdb',
      ready: database.status.readyReplicas > 0, // ✨ Natural JavaScript expression
    };
  }
);

// =============================================================================
// 2. Cache Layer Composition (managed by Platform Team)
// =============================================================================

const CacheSpec = type({
  engine: '"redis" | "memcached"',
  replicas: 'number',
  memory: 'string',
});

const CacheStatus = type({
  endpoint: 'string',
  ready: 'boolean',
});

const _cacheComposition = kubernetesComposition(
  {
    name: 'cache',
    apiVersion: 'platform.company.com/v1alpha1',
    kind: 'Cache',
    spec: CacheSpec,
    status: CacheStatus,
  },
  (spec) => {
    const cache = Deployment({
      name: 'cache-server',
      image: `${spec.engine}:alpine`, // ✨ Natural JavaScript template literal
      replicas: spec.replicas,
      resources: {
        limits: { memory: spec.memory },
        requests: { memory: spec.memory }
      },
      ports: [{ containerPort: 6379 }],
      id: 'cache',
    });

    const service = Service({
      name: 'cache-service',
      selector: { app: 'cache-server' },
      ports: [{ port: 6379, targetPort: 6379 }],
      id: 'cacheService',
    });

    return {
      endpoint: `${service.spec.clusterIP}:6379`, // ✨ Natural JavaScript template literal
      ready: cache.status.readyReplicas > 0, // ✨ Natural JavaScript expression
    };
  }
);

// =============================================================================
// 3. Application Composition - Shows BOTH Reference Patterns
// =============================================================================

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  features: {
    caching: 'boolean',
    monitoring: 'boolean',
  },
});

const WebAppStatus = type({
  ready: 'boolean',
  cacheConnected: 'boolean',
  databaseConnected: 'boolean',
  url: 'string',
});

const webAppComposition = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'apps.company.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  (spec) => {
    // 🔗 PATTERN 1: EXPLICIT externalRef() for resources created outside TypeKro
    // This references a legacy PostgreSQL database managed by Helm/kubectl
    const legacyDatabase = externalRef(
      'v1',
      'Service',
      'legacy-postgres-service',
      'databases'
    );

    // 🪄 PATTERN 2: IMPLICIT magic proxy references (within same composition)
    // The magic proxy automatically converts resource.status.field to KubernetesRef objects
    const cache = Deployment({
      name: 'cache-server',
      image: 'redis:alpine',
      replicas: 1,
      ports: [{ containerPort: 6379 }],
      id: 'cache',
    });

    const cacheService = Service({
      name: 'cache-service',
      selector: { app: 'cache-server' },
      ports: [{ port: 6379, targetPort: 6379 }],
      id: 'cacheService',
    });

    const app = Deployment({
      name: 'webapp',
      image: spec.image,
      replicas: spec.replicas,
      env: {
        // EXPLICIT external reference (resource created outside TypeKro)
        DATABASE_URL: `postgres://user:pass@${legacyDatabase.spec.clusterIP}:5432/db`, // ✨ Natural JavaScript template literal

        // IMPLICIT magic proxy references (resources within THIS composition)  
        // TypeKro's magic proxy automatically converts these to CEL expressions
        CACHE_HOST: cacheService.spec.clusterIP,      // ← Becomes CEL expression automatically!
        CACHE_PORT: '6379',
        CACHE_READY: `${cache.status.readyReplicas}`,      // ✨ Natural JavaScript template literal

        NODE_ENV: 'production',
      },
      ports: [{ containerPort: 3000 }],
      id: 'app',
    });

    const _appService = Service({
      name: 'webapp-service',
      selector: { app: 'webapp' },
      ports: [{ port: 80, targetPort: 3000 }],
      id: 'appService',
    });

    return {
      ready: app.status.readyReplicas > 0, // ✨ Natural JavaScript expression
      cacheConnected: cache.status.readyReplicas > 0, // ✨ Natural JavaScript expression
      databaseConnected: true, // External database assumed connected
      url: `http://${_appService.spec.clusterIP}`, // ✨ Natural JavaScript template literal
    };
  }
);

// =============================================================================
// Usage Examples
// =============================================================================

console.log('🔗 External References Example');
console.log('===============================');

console.log('\n1️⃣  Database Composition YAML:');
console.log(databaseComposition.toYaml());

console.log('\n2️⃣  WebApp Composition YAML (references external database):');
console.log(webAppComposition.toYaml());

console.log('\n✅ Key Patterns Demonstrated:');
console.log('   🔗 EXPLICIT externalRef() - Reference resources created outside TypeKro');
console.log('   🪄 IMPLICIT magic proxy - Reference resources within the same composition');
console.log('   🎯 Type Safety - Full TypeScript support with IDE autocomplete');
console.log('   🚀 Deployment Flexibility - Same code works with Direct/KRO modes');

console.log('\n📝 Pattern Breakdown:');
console.log('   1. legacyDatabase = externalRef(...) - Explicit external reference');
console.log('   2. cache.status.readyReplicas - Implicit KubernetesRef via magic proxy');
console.log('   3. cacheService.spec.clusterIP - Implicit CEL expression via magic proxy');

console.log('\n🔄 Deployment Commands:');
console.log('   # Deploy database composition first');
console.log('   kubectl apply -f database.yaml');
console.log('   # Then deploy webapp (with external references)');
console.log('   kubectl apply -f webapp.yaml');

// ============================================================================
// 🌟 NEW: Cross-Composition Magic Proxy (TypeKro v2.0+)
// ============================================================================

/**
 * 🪄 PATTERN 3: Cross-Composition Magic Proxy
 * 
 * Access resources from other compositions using natural property access.
 * TypeKro automatically creates external references via the magic proxy system.
 */

const frontendComposition = kubernetesComposition(
  {
    name: 'frontend-composition',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FrontendComposition',
    spec: type({
      appName: 'string',
      image: 'string'
    }),
    status: type({
      ready: 'boolean',
      databaseConnected: 'boolean',
      cacheConnected: 'boolean',
    }),
  },
  (schema) => {
    // ✨ Cross-composition magic proxy in action!
    // Access resources from other compositions as if they were properties
    const dbRef = (databaseComposition as any).database;           // 🪄 Magic proxy creates external ref
    const cacheRef = (webAppComposition as any).cache;           // 🪄 Magic proxy creates external ref  
    const cacheServiceRef = (webAppComposition as any).cacheService; // 🪄 Magic proxy creates external ref

    return {
      // Create frontend resources that reference other compositions
      frontend: Deployment({
        name: 'frontend-app',  // Use static name to avoid KubernetesRef issues
        image: schema.image,
        env: {
          // Cross-composition references work seamlessly in environment variables
          DATABASE_URL: dbRef.status.connectionString,     // From databaseComposition
          CACHE_HOST: cacheServiceRef.spec.clusterIP,      // From webAppComposition  
          CACHE_PORT: '6379',
        }
      }),

      // Status builder can also use cross-composition references
      ready: true, // ✨ Natural JavaScript boolean
      databaseConnected: dbRef.status.ready,               // Cross-composition status check
      cacheConnected: cacheRef.status.readyReplicas,       // Cross-composition replica check
    };
  }
);

console.log('\n🎉 NEW FEATURE DEMO: Cross-Composition Magic Proxy');
console.log('====================================================');
console.log('✅ Cross-composition references work automatically!');
console.log('✅ No more manual externalRef() calls needed');
console.log('✅ Natural property access: databaseComposition.database');
console.log('✅ Full type safety and IDE support');
console.log('✅ Works with both regular and imperative compositions');

console.log('\n📝 Cross-Composition Pattern Examples:');
console.log('   • (databaseComposition as any).database - Access database resource');
console.log('   • (webAppComposition as any).cache - Access cache resource');
console.log('   • (webAppComposition as any).cacheService - Access service resource');

console.log('\n💡 Smart Key Matching:');
console.log('   • composition.database - Finds Deployment resources semantically');
console.log('   • composition.service - Finds Service resources');
console.log('   • composition["my-service"] - Handles kebab-case keys');
console.log('   • composition.Database - Case-insensitive matching');

export { databaseComposition, webAppComposition, frontendComposition };