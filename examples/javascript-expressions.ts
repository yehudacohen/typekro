/**
 * JavaScript Expressions Example
 * 
 * This example demonstrates TypeKro's automatic JavaScript-to-CEL conversion.
 * You can write natural JavaScript expressions and TypeKro automatically
 * converts them to CEL expressions when they contain resource or schema references.
 */

import { type } from 'arktype';
import { toResourceGraph, Cel } from '../src/index.js';
import * as simple from '../src/factories/simple/index.js';

// Define comprehensive schemas
const FullStackAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"',
  features: {
    database: 'boolean',
    redis: 'boolean',
    monitoring: 'boolean'
  },
  scaling: {
    minReplicas: 'number',
    maxReplicas: 'number',
    targetCPU: 'number'
  }
});

const FullStackAppStatus = type({
  // Simple boolean expressions
  ready: 'boolean',
  healthy: 'boolean',
  
  // String expressions with templates
  url: 'string',
  phase: 'string',
  
  // Numeric expressions
  replicas: 'number',
  utilizationPercent: 'number',
  
  // Complex nested objects
  components: {
    webapp: 'boolean',
    database: 'boolean',
    redis: 'boolean',
    loadBalancer: 'boolean'
  },
  
  // Arrays and computed values
  endpoints: 'string[]',
  
  // Environment-specific values
  environment: 'string',
  
  // Health metrics
  health: {
    overall: 'string',
    database: 'string',
    redis: 'string',
    uptime: 'string'
  }
});

// Create the resource graph with comprehensive JavaScript expressions
export const fullStackApp = toResourceGraph(
  {
    name: 'fullstack-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStackApp',
    spec: FullStackAppSpec,
    status: FullStackAppStatus,
  },
  
  // Resource builder with JavaScript expressions
  (schema) => {
    const resources: any = {};

    // Main application deployment
    resources.webapp = simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        // Static values (no conversion needed)
        NODE_ENV: schema.spec.environment,
        PORT: '3000',
        
        // JavaScript template literals (automatically converted to CEL)
        APP_NAME: `${schema.spec.name}-${schema.spec.environment}`,
        
        // Conditional expressions (automatically converted to CEL)
        LOG_LEVEL: schema.spec.environment === 'production' ? 'warn' : 'debug',
        
        // Complex template with multiple references
        DATABASE_URL: schema.spec.features.database 
          ? `postgres://user:pass@${resources.database?.status.podIP}:5432/${schema.spec.name}`
          : 'sqlite:///tmp/app.db',
          
        // Conditional with fallback
        REDIS_URL: schema.spec.features.redis 
          ? `redis://${resources.redis?.status.podIP || 'localhost'}:6379`
          : '',
          
        // Arithmetic expressions (converted to strings for env vars)
        MAX_CONNECTIONS: `${schema.spec.scaling.maxReplicas * 10}`,
        WORKER_THREADS: `${schema.spec.replicas > 4 ? 4 : schema.spec.replicas}`
      }
    });

    // Service for the webapp
    resources.webappService = simple.Service({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: schema.spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
    });

    // Conditional database
    if (schema.spec.features.database) {
      resources.database = simple.Deployment({
        name: `${schema.spec.name}-db`,
        image: 'postgres:15',
        env: {
          POSTGRES_DB: schema.spec.name,
          POSTGRES_USER: 'user',
          POSTGRES_PASSWORD: 'password'
        },
        ports: [{ containerPort: 5432 }]
      });

      resources.databaseService = simple.Service({
        name: `${schema.spec.name}-db-service`,
        selector: { app: `${schema.spec.name}-db` },
        ports: [{ port: 5432, targetPort: 5432 }]
      });
    }

    // Conditional Redis
    if (schema.spec.features.redis) {
      resources.redis = simple.Deployment({
        name: `${schema.spec.name}-redis`,
        image: 'redis:7',
        ports: [{ containerPort: 6379 }]
      });

      resources.redisService = simple.Service({
        name: `${schema.spec.name}-redis-service`,
        selector: { app: `${schema.spec.name}-redis` },
        ports: [{ port: 6379, targetPort: 6379 }]
      });
    }

    return resources;
  },
  
  // Status builder with comprehensive JavaScript expressions
  // All of these are automatically converted to CEL expressions
  (schema, resources) => ({
    // ✅ Simple boolean expressions
    ready: resources.webapp.status.readyReplicas > 0 && 
           (!schema.spec.features.database || resources.database?.status.readyReplicas > 0) &&
           (!schema.spec.features.redis || resources.redis?.status.readyReplicas > 0),
           
    healthy: resources.webapp.status.readyReplicas === schema.spec.replicas,

    // ✅ Template literals with interpolation
    url: resources.webappService.status?.loadBalancer?.ingress?.[0]?.ip
      ? `https://${resources.webappService.status.loadBalancer.ingress[0].ip}`
      : resources.webappService.status?.clusterIP
        ? `http://${resources.webappService.status.clusterIP}`
        : 'pending',

    // ✅ Complex conditional expressions
    phase: resources.webapp.status.readyReplicas === 0 
      ? 'stopped'
      : resources.webapp.status.readyReplicas < schema.spec.replicas
        ? 'scaling'
        : resources.webapp.status.readyReplicas === schema.spec.replicas
          ? 'ready'
          : 'overscaled',

    // ✅ Direct resource references
    replicas: resources.webapp.status.readyReplicas,

    // ✅ Arithmetic expressions
    utilizationPercent: (resources.webapp.status.readyReplicas / schema.spec.replicas) * 100,

    // ✅ Complex nested objects with JavaScript expressions
    components: {
      webapp: resources.webapp.status.readyReplicas > 0,
      database: schema.spec.features.database 
        ? resources.database?.status.readyReplicas > 0 
        : true,
      redis: schema.spec.features.redis 
        ? resources.redis?.status.readyReplicas > 0 
        : true,
      loadBalancer: resources.webappService.status?.loadBalancer?.ingress?.length > 0
    },

    // ✅ Array expressions (for simple cases)
    endpoints: [
      resources.webappService.status?.loadBalancer?.ingress?.[0]?.ip || 'pending',
      // For complex array operations, use explicit CEL:
      // Cel.map(resources.webappService.status.loadBalancer.ingress, 'item.ip')
    ],

    // ✅ Direct schema references (no conversion needed)
    environment: schema.spec.environment,

    // ✅ Complex health object with nested expressions
    health: {
      // Conditional string expressions
      overall: resources.webapp.status.readyReplicas > 0 && 
               (!schema.spec.features.database || resources.database?.status.readyReplicas > 0) &&
               (!schema.spec.features.redis || resources.redis?.status.readyReplicas > 0)
        ? 'healthy' 
        : 'unhealthy',

      // Optional chaining with fallbacks
      database: schema.spec.features.database
        ? resources.database?.status.conditions?.find((c: any) => c.type === 'Available')?.status === 'True'
          ? 'connected'
          : 'disconnected'
        : 'disabled',

      redis: schema.spec.features.redis
        ? resources.redis?.status.readyReplicas > 0 ? 'connected' : 'disconnected'
        : 'disabled',

      // Template with complex logic
      uptime: resources.webapp.metadata?.creationTimestamp
        ? `Running since ${resources.webapp.metadata.creationTimestamp}`
        : 'Not started'
    }
  })
);

// Example usage demonstrating both factory patterns
export async function demonstrateJavaScriptExpressions() {
  const spec = {
    name: 'my-app',
    image: 'nginx:latest',
    replicas: 3,
    environment: 'production' as const,
    features: {
      database: true,
      redis: true,
      monitoring: false
    },
    scaling: {
      minReplicas: 1,
      maxReplicas: 10,
      targetCPU: 70
    }
  };

  // Direct factory - JavaScript expressions evaluated with resolved dependencies
  console.log('=== Direct Factory Pattern ===');
  const directFactory = await fullStackApp.factory('direct', { namespace: 'production' });
  const directResult = await directFactory.deploy(spec);
  console.log('Direct deployment result:', directResult);

  // Kro factory - JavaScript expressions converted to CEL for runtime evaluation
  console.log('=== Kro Factory Pattern ===');
  const kroFactory = await fullStackApp.factory('kro', { namespace: 'production' });
  const kroResult = await kroFactory.deploy(spec);
  console.log('Kro deployment result:', kroResult);

  // Generate YAML to see the CEL expressions
  console.log('=== Generated YAML ===');
  const yaml = await kroFactory.toYaml();
  console.log(yaml);
}

// Advanced example showing explicit CEL for unsupported JavaScript patterns
export const advancedExample = toResourceGraph(
  {
    name: 'advanced-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'AdvancedApp',
    spec: type({ name: 'string', replicas: 'number' }),
    status: type({ 
      ready: 'boolean', 
      podNames: 'string[]',
      healthyPods: 'number',
      summary: 'string'
    }),
  },
  (schema) => ({
    deployment: simple.Deployment({
      name: schema.spec.name,
      image: 'nginx:latest',
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 80 }]
    })
  }),
  (schema, resources) => ({
    // ✅ JavaScript expressions for simple cases
    ready: resources.deployment.status.readyReplicas > 0,

    // ✅ Use explicit CEL for complex list operations (escape hatch)
    podNames: Cel.expr<string[]>('resources.deployment.status.pods.map(item, item.metadata.name)'),

    // ✅ Complex list operations still require explicit CEL (escape hatch)
    healthyPods: Cel.expr<number>(
      'size(resources.deployment.status.pods.filter(p, p.status.phase == "Running"))'
    ),

    // ✅ Mix JavaScript and CEL as needed
    summary: `${schema.spec.name} has ${resources.deployment.status.readyReplicas} ready pods`
  })
);

// Performance comparison example
export function performanceComparison() {
  console.log('=== Performance Comparison ===');
  
  // Static values - no conversion overhead
  const _staticStatus = {
    environment: 'production',
    version: '1.0.0',
    enabled: true
  };
  
  // JavaScript expressions - converted to CEL only when containing references
  const _dynamicStatus = (schema: any, resources: any) => ({
    // No conversion - static values
    staticField: 'unchanged',
    
    // Converted to CEL - contains resource reference
    ready: resources.deployment.status.readyReplicas > 0,
    
    // Converted to CEL - contains schema reference
    name: schema.spec.name,
    
    // No conversion - pure JavaScript computation
    timestamp: Date.now(),
    
    // Converted to CEL - mixed static and dynamic
    url: `https://${resources.service.status.clusterIP}/api/v1`
  });
  
  console.log('TypeKro optimizes by only converting expressions with resource/schema references');
}

// Migration example from manual CEL to JavaScript
export function migrationExample() {
  console.log('=== Migration from Manual CEL ===');
  
  // Before: Manual CEL expressions (legacy approach - DON'T DO THIS)
  const _beforeStatus = (_schema: any, resources: any) => ({
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' > 0'),
    url: Cel.template('https://%s', resources.service.status.clusterIP),
    phase: Cel.expr(
      resources.deployment.status.readyReplicas, 
      ' > 0 ? "running" : "pending"'
    )
  });
  
  // After: Natural JavaScript expressions (modern approach)
  const _afterStatus = (_schema: any, resources: any) => ({
    // ✨ Natural JavaScript - automatically converted to CEL
    ready: resources.deployment.status.readyReplicas > 0,
    url: `https://${resources.service.status.clusterIP}`,
    phase: resources.deployment.status.readyReplicas > 0 ? 'running' : 'pending'
  });
  
  console.log('Migration is straightforward - replace CEL with natural JavaScript');
}

// Run examples if this file is executed directly
if (import.meta.main) {
  await demonstrateJavaScriptExpressions();
  performanceComparison();
  migrationExample();
}