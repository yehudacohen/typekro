#!/usr/bin/env bun
// @ts-nocheck

/**
 * Nested Compositions Example with TypeKro
 * 
 * This example demonstrates TypeKro's powerful nested composition capabilities:
 * 1. Database composition (reusable component)
 * 2. Application composition that uses the database
 * 3. Full-stack composition that combines both
 * 4. Beautiful callable API with natural status references
 * 
 * Prerequisites:
 * - kubectl connected to a cluster
 * - TypeKro runtime deployed (run hello-world-simple.ts first)
 * 
 * Usage:
 *   bun run examples/nested-compositions.ts
 */

import { type } from 'arktype';
import { kubernetesComposition, simple } from '../src/index.js';

// =============================================================================
// REUSABLE DATABASE COMPOSITION
// =============================================================================

const DatabaseSpec = type({
  name: 'string',
  storage: 'string',
  'image?': 'string',
});

const DatabaseStatus = type({
  ready: 'boolean',
  host: 'string',
  port: 'number',
  connectionString: 'string',
  storageReady: 'boolean'
});

// Reusable database composition
const databaseComposition = kubernetesComposition(
  {
    name: 'database',
    apiVersion: 'examples.typekro.dev/v1alpha1',
    kind: 'Database',
    spec: DatabaseSpec,
    status: DatabaseStatus,
  },
  (spec) => {
    console.log(`🗄️  Creating database: ${spec.name}`);

    // Database deployment
    const db = simple.Deployment({
      name: `${spec.name}-db`,
      image: spec.image || 'postgres:13',
      id: 'database',
      env: {
        POSTGRES_DB: spec.name,
        POSTGRES_USER: 'user',
        POSTGRES_PASSWORD: 'password'
      }
    });

    // Database service
    const dbService = simple.Service({
      name: `${spec.name}-db`,
      ports: [{ port: 5432, targetPort: 5432 }],
      selector: { app: `${spec.name}-db` },
      id: 'dbService'
    });

    // Storage for the database
    const storage = simple.Pvc({
      name: `${spec.name}-storage`,
      size: spec.storage,
      accessModes: ['ReadWriteOnce']
    });

    return {
      ready: db.status.readyReplicas > 0 && dbService.status.ready,
      host: dbService.status.clusterIP || 'localhost',
      port: 5432,
      connectionString: `postgres://user:password@${dbService.status.clusterIP}:5432/${spec.name}`,
      storageReady: storage.status.phase === 'Bound'
    };
  }
);

// =============================================================================
// APPLICATION COMPOSITION THAT USES DATABASE
// =============================================================================

const AppWithDatabaseSpec = type({
  name: 'string',
  replicas: 'number',
  dbStorage: 'string',
  'image?': 'string',
});

const AppWithDatabaseStatus = type({
  ready: 'boolean',
  url: 'string',
  database: {
    ready: 'boolean',
    host: 'string',
    storageReady: 'boolean'
  },
  health: {
    app: 'boolean',
    database: 'boolean',
    service: 'boolean',
    overall: 'boolean'
  }
});

// Application composition that uses the database composition
const appWithDatabase = kubernetesComposition(
  {
    name: 'app-with-database',
    apiVersion: 'examples.typekro.dev/v1alpha1',
    kind: 'AppWithDatabase',
    spec: AppWithDatabaseSpec,
    status: AppWithDatabaseStatus,
  },
  (spec) => {
    console.log(`🚀 Creating application with database: ${spec.name}`);

    // ✨ Beautiful nested composition call - this is the magic!
    const database = databaseComposition({
      name: spec.name,
      storage: spec.dbStorage
    });

    // Application deployment that uses the database
    const app = simple.Deployment({
      name: spec.name,
      image: spec.image || 'node:16',
      replicas: spec.replicas,
      id: 'app',
      env: {
        // ✨ Natural status references - TypeScript autocomplete works!
        DATABASE_URL: database.status.connectionString,
        DATABASE_HOST: database.status.host,
        DATABASE_READY: database.status.ready ? 'true' : 'false'
      }
    });

    // Application service
    const appService = simple.Service({
      name: spec.name,
      ports: [{ port: 80, targetPort: 3000 }],
      selector: { app: spec.name },
      type: 'LoadBalancer',
      id: 'appService'
    });

    return {
      ready: app.status.readyReplicas >= spec.replicas && database.status.ready,
      url: `http://${appService.status?.loadBalancer?.ingress?.[0]?.ip || 'localhost'}`,
      database: {
        ready: database.status.ready,
        host: database.status.host,
        storageReady: database.status.storageReady
      },
      health: {
        app: app.status.readyReplicas >= spec.replicas,
        database: database.status.ready,
        service: appService.status.ready,
        overall: app.status.readyReplicas >= spec.replicas && database.status.ready && appService.status.ready
      }
    };
  }
);

// =============================================================================
// MULTI-LEVEL NESTED COMPOSITION
// =============================================================================

const FullStackSpec = type({
  name: 'string',
  environment: '"development" | "staging" | "production"',
  dbStorage: 'string',
  appReplicas: 'number',
});

const FullStackStatus = type({
  ready: 'boolean',
  environment: 'string',
  components: {
    app: 'boolean',
    database: 'boolean'
  },
  endpoints: {
    app: 'string',
    database: 'string'
  }
});

// Full-stack composition that uses the app-with-database composition
const fullStackApp = kubernetesComposition(
  {
    name: 'fullstack-app',
    apiVersion: 'examples.typekro.dev/v1alpha1',
    kind: 'FullStackApp',
    spec: FullStackSpec,
    status: FullStackStatus,
  },
  (spec) => {
    console.log(`🌟 Creating full-stack application: ${spec.name} (${spec.environment})`);

    // ✨ Multi-level nesting - composition calling another composition!
    const appStack = appWithDatabase({
      name: `${spec.name}-${spec.environment}`,
      replicas: spec.appReplicas,
      dbStorage: spec.dbStorage,
      image: spec.environment === 'production' ? 'node:18-alpine' : 'node:16'
    });

    // Environment-specific configuration
    const configMap = simple.ConfigMap({
      name: `${spec.name}-config`,
      data: {
        ENVIRONMENT: spec.environment,
        LOG_LEVEL: spec.environment === 'production' ? 'warn' : 'debug',
        // ✨ Reference nested composition status in config
        DATABASE_HOST: appStack.status.database.host
      },
      id: 'config'
    });

    return {
      ready: appStack.status.ready && configMap.metadata.name !== undefined,
      environment: spec.environment,
      components: {
        app: appStack.status.health.app,
        database: appStack.status.health.database
      },
      endpoints: {
        app: appStack.status.url,
        database: appStack.status.database.host
      }
    };
  }
);

// =============================================================================
// DEPLOYMENT DEMO
// =============================================================================

async function deployNestedCompositionsDemo() {
  console.log('🌟 Starting Nested Compositions TypeKro Demo');
  console.log('============================================');
  console.log('');

  try {
    // Deploy the full-stack application (which includes nested compositions)
    console.log('🚀 Deploying Full-Stack Application with Nested Compositions...');
    
    const fullStackFactory = await fullStackApp.factory('kro', {
      namespace: 'default',
      skipTLSVerify: true,
      timeout: 300000,
      waitForReady: true,
      eventMonitoring: {
        enabled: true,
        eventTypes: ['Warning', 'Error', 'Normal'],
        includeChildResources: true
      },
      progressCallback: (event) => {
        console.log(`📡 FullStack: ${event.message}`);
      }
    });

    const instance = await fullStackFactory.deploy({
      name: 'demo-app',
      environment: 'development',
      dbStorage: '5Gi',
      appReplicas: 2
    });

    console.log('✅ Full-Stack Application deployed successfully!');
    console.log('');

    // Show the beautiful nested status
    console.log('📊 Application Status:');
    console.log(`   Ready: ${instance.status.ready}`);
    console.log(`   Environment: ${instance.status.environment}`);
    console.log(`   Components:`);
    console.log(`     App: ${instance.status.components.app}`);
    console.log(`     Database: ${instance.status.components.database}`);
    console.log(`   Endpoints:`);
    console.log(`     App: ${instance.status.endpoints.app}`);
    console.log(`     Database: ${instance.status.endpoints.database}`);
    console.log('');

    // Demonstrate standalone composition usage (with warning)
    console.log('🔧 Demonstrating Standalone Composition Usage...');
    console.log('(This will show a warning since it\'s called outside composition context)');
    
    const standaloneDb = databaseComposition({
      name: 'standalone-db',
      storage: '1Gi'
    });
    
    console.log(`✅ Standalone database created: ${standaloneDb.__compositionId}`);
    console.log('');

    console.log('🎊 Nested Compositions Demo Finished Successfully!');
    console.log('===============================================');
    console.log('📋 What was deployed:');
    console.log('  ✅ Full-Stack Application (nested composition)');
    console.log('    ├── App with Database (nested composition)');
    console.log('    │   ├── Database (nested composition)');
    console.log('    │   │   ├── PostgreSQL Deployment');
    console.log('    │   │   ├── Database Service');
    console.log('    │   │   └── Storage PVC');
    console.log('    │   ├── Application Deployment');
    console.log('    │   └── Application Service');
    console.log('    └── Environment ConfigMap');
    console.log('');
    console.log('🔍 To inspect:');
    console.log('  kubectl get resourcegraphdefinition');
    console.log('  kubectl get pods,services,pvc');
    console.log('  kubectl describe resourcegraphdefinition fullstack-app');
    console.log('');
    console.log('🧹 To clean up:');
    console.log('  kubectl delete resourcegraphdefinition fullstack-app');

  } catch (error) {
    console.error('❌ Deployment failed:', error);
    process.exit(1);
  }
}

// Run the demo if this script is executed directly
if (import.meta.main) {
  deployNestedCompositionsDemo().catch((error) => {
    console.error('❌ Demo failed:', error);
    process.exit(1);
  });
}

export { 
  deployNestedCompositionsDemo, 
  databaseComposition, 
  appWithDatabase, 
  fullStackApp 
};