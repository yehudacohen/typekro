# Custom Factory Functions

While TypeKro provides comprehensive built-in factory functions, you can create custom factories for organization-specific patterns, complex resources, or specialized workflows. This guide shows you how to build reusable, type-safe factory functions using TypeKro's Enhanced type system.

## Understanding Factory Functions

Factory functions in TypeKro are functions that return Enhanced Kubernetes resources with:

- **Type safety** - Full TypeScript validation with magic proxy system
- **Cross-resource references** - Ability to reference other resources via proxy properties
- **Status tracking** - Runtime status information accessible through proxies
- **Automatic registration** - Resources are automatically registered in composition contexts
- **Readiness evaluation** - Built-in readiness checking with custom evaluator support

```typescript
import { createResource } from 'typekro';
import type { Enhanced } from 'typekro';

// Basic factory function signature
function customFactory(config: ConfigType): Enhanced<SpecType, StatusType> {
  return createResource({
    // Kubernetes resource definition
  });
}
```

### The Enhanced Type System

Enhanced resources are proxy objects that provide magic property access:

```typescript
const deployment = Deployment({ name: 'my-app', image: 'nginx:latest' });

// Direct property access (normal values)
console.log(deployment.metadata.name); // 'my-app'

// Cross-resource references (returns KubernetesRef)
const serviceRef = deployment.metadata.name; // Can be used in other resources
const statusRef = deployment.status.readyReplicas; // References for status builders
```

## Basic Custom Factory

### Simple Custom Deployment Factory

```typescript
import { createResource, type Enhanced } from 'typekro';
import type { V1Deployment, V1DeploymentSpec, V1DeploymentStatus } from '@kubernetes/client-node';

interface CustomDeploymentConfig {
  name: string;
  image: string;
  replicas?: number;
  environment: 'development' | 'staging' | 'production';
  team: string;
  monitoring?: boolean;
  id?: string; // Optional explicit resource ID
}

export function customDeployment(
  config: CustomDeploymentConfig
): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  const {
    name,
    image,
    replicas = 1,
    environment,
    team,
    monitoring = false,
    id
  } = config;

  return createResource({
    ...(id && { id }), // Optional explicit ID for dependency tracking
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      labels: {
        app: name,
        team,
        environment,
        'managed-by': 'typekro',
        ...(monitoring && { 'monitoring.enabled': 'true' })
      },
      annotations: {
        'typekro.io/created-by': 'custom-deployment-factory',
        'typekro.io/team': team,
        'typekro.io/environment': environment
      }
    },
    spec: {
      replicas,
      selector: {
        matchLabels: { app: name }
      },
      template: {
        metadata: {
          labels: {
            app: name,
            team,
            environment
          }
        },
        spec: {
          containers: [{
            name,
            image,
            ports: [{ containerPort: 3000 }],
            
            // Environment-specific configuration
            resources: getResourcesByEnvironment(environment),
            
            // Standard environment variables
            env: [
              { name: 'NODE_ENV', value: environment },
              { name: 'TEAM', value: team },
              { name: 'APP_NAME', value: name }
            ],
            
            // Standard health checks
            livenessProbe: {
              httpGet: { path: '/health', port: 3000 },
              initialDelaySeconds: 30,
              periodSeconds: 10
            },
            readinessProbe: {
              httpGet: { path: '/ready', port: 3000 },
              initialDelaySeconds: 5,
              periodSeconds: 5
            },
            
            // Security context
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true
            }
          }],
          
          // Pod security context
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            fsGroup: 1000
          }
        }
      }
    }
  });
}

// Helper function for environment-specific resources
function getResourcesByEnvironment(environment: string) {
  const resourceConfigs = {
    development: {
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '200m', memory: '512Mi' }
    },
    staging: {
      requests: { cpu: '200m', memory: '512Mi' },
      limits: { cpu: '500m', memory: '1Gi' }
    },
    production: {
      requests: { cpu: '500m', memory: '1Gi' },
      limits: { cpu: '1000m', memory: '2Gi' }
    }
  };
  
  return resourceConfigs[environment] || resourceConfigs.development;
}
```

### Using the Custom Factory

```typescript
import { customDeployment } from './factories/custom-deployment.js';

const myApp = customDeployment({
  name: 'user-service',
  image: 'myregistry/user-service:v1.2.0',
  replicas: 3,
  environment: 'production',
  team: 'backend',
  monitoring: true,
  id: 'userService' // Explicit ID for cross-resource references
});

// The Enhanced resource can be referenced in other resources
const service = Service({
  name: myApp.metadata.name, // Cross-resource reference
  selector: myApp.spec.selector.matchLabels, // Reference to deployment's labels
});
```

## Using Custom Factories in Compositions

Custom factories create **single resources**. To use them in compositions alongside other resources:

```typescript
import { type } from 'arktype';
import { kubernetesComposition, Cel } from 'typekro';
import { customDeployment } from './custom-deployment.js';
import { Service, ConfigMap } from 'typekro/simple';

// Define the composition schema
const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"',
  team: 'string'
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string',
  deploymentReady: 'boolean'
});

// Create a composition that uses custom factories
export const webAppComposition = kubernetesComposition(
  {
    name: 'web-application',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  (spec) => {
    // Use your custom factory for the deployment
    const app = customDeployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      environment: spec.environment,
      team: spec.team,
      monitoring: spec.environment === 'production'
    });

    // Use built-in factories for other resources
    const configMap = ConfigMap({
      name: Cel.template('%s-config', spec.name),
      data: {
        'app.env': spec.environment,
        'app.team': spec.team
      }
    });

    const service = Service({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    });

    // Status is computed from the resources created within the composition
    return {
      ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
      url: Cel.template('http://%s', service.status.clusterIP),
      deploymentReady: Cel.expr<boolean>(app.status.readyReplicas, ' >= ', spec.replicas)
    };
  }
);
```

## Advanced Custom Factory Patterns

### Factory with Custom Readiness Evaluation

```typescript
import { createResource, type ResourceStatus, type ReadinessEvaluator } from 'typekro';
import type { V1StatefulSet, V1StatefulSetSpec, V1StatefulSetStatus } from '@kubernetes/client-node';

interface DatabaseConfig {
  name: string;
  image: string;
  storage: string;
  storageClass?: string;
  replicas?: number;
  environment: string;
  id?: string;
}

// Custom readiness evaluator
const databaseReadinessEvaluator: ReadinessEvaluator = (liveResource: V1StatefulSet): ResourceStatus => {
  const status = liveResource.status;
  const replicas = liveResource.spec?.replicas || 1;
  
  if (!status) {
    return { ready: false, reason: 'NoStatus', message: 'StatefulSet status not available' };
  }

  if (status.readyReplicas === replicas && status.currentReplicas === replicas) {
    return { ready: true, reason: 'AllReplicasReady', message: `All ${replicas} database replicas are ready` };
  }

  return {
    ready: false,
    reason: 'ReplicasNotReady',
    message: `Database replicas not ready: ${status.readyReplicas || 0}/${replicas}`
  };
};

export function postgresDatabase(
  config: DatabaseConfig
): Enhanced<V1StatefulSetSpec, V1StatefulSetStatus> {
  const { name, image, storage, storageClass, replicas = 1, environment, id } = config;

  return createResource({
    ...(id && { id }),
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name,
      labels: {
        app: name,
        component: 'database',
        environment,
        'managed-by': 'typekro'
      }
    },
    spec: {
      serviceName: name,
      replicas,
      selector: {
        matchLabels: { app: name, component: 'database' }
      },
      template: {
        metadata: {
          labels: { app: name, component: 'database', environment }
        },
        spec: {
          containers: [{
            name: 'postgres',
            image,
            ports: [{ containerPort: 5432 }],
            env: [
              { name: 'POSTGRES_DB', value: name },
              { name: 'POSTGRES_USER', value: 'app' },
              { name: 'POSTGRES_PASSWORD', value: 'changeme' }
            ],
            volumeMounts: [{
              name: 'data',
              mountPath: '/var/lib/postgresql/data'
            }],
            resources: getResourcesByEnvironment(environment)
          }]
        }
      },
      volumeClaimTemplates: [{
        metadata: {
          name: 'data',
          labels: { app: name, component: 'database' }
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: {
            requests: { storage }
          },
          ...(storageClass && { storageClassName: storageClass })
        }
      }]
    }
  }).withReadinessEvaluator(databaseReadinessEvaluator);
}
```

### Configurable Factory with Validation

```typescript
import { createResource, type Enhanced } from 'typekro';
import type { V1Service, V1ServiceSpec, V1ServiceStatus } from '@kubernetes/client-node';

interface ServiceConfig {
  name: string;
  selector: Record<string, string>;
  ports: Array<{
    port: number;
    targetPort?: number | string;
    protocol?: 'TCP' | 'UDP';
    name?: string;
  }>;
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName';
  sessionAffinity?: 'ClientIP' | 'None';
  loadBalancerSourceRanges?: string[];
  id?: string;
}

function validateServiceConfig(config: ServiceConfig): void {
  if (!config.name || config.name.length < 1 || config.name.length > 63) {
    throw new Error('Service name must be 1-63 characters');
  }

  if (!config.selector || Object.keys(config.selector).length === 0) {
    throw new Error('Service selector cannot be empty');
  }

  if (!config.ports || config.ports.length === 0) {
    throw new Error('Service must have at least one port');
  }

  for (const port of config.ports) {
    if (port.port < 1 || port.port > 65535) {
      throw new Error(`Invalid port: ${port.port}. Must be 1-65535`);
    }
  }
}

export function customService(
  config: ServiceConfig
): Enhanced<V1ServiceSpec, V1ServiceStatus> {
  // Validate configuration
  validateServiceConfig(config);

  const {
    name,
    selector,
    ports,
    type = 'ClusterIP',
    sessionAffinity = 'None',
    loadBalancerSourceRanges,
    id
  } = config;

  return createResource({
    ...(id && { id }),
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      labels: {
        'managed-by': 'typekro',
        'service-type': type.toLowerCase()
      },
      annotations: {
        'typekro.io/created-by': 'custom-service-factory'
      }
    },
    spec: {
      selector,
      type,
      sessionAffinity,
      ports: ports.map(port => ({
        port: port.port,
        targetPort: port.targetPort || port.port,
        protocol: port.protocol || 'TCP',
        ...(port.name && { name: port.name })
      })),
      ...(loadBalancerSourceRanges && { loadBalancerSourceRanges })
    }
  });
}
```

## Factory Composition Patterns

### Environment-Specific Factory

```typescript
interface EnvironmentConfig {
  resources: {
    requests: { cpu: string; memory: string };
    limits: { cpu: string; memory: string };
  };
  replicas: number;
  healthCheck: {
    initialDelaySeconds: number;
    periodSeconds: number;
  };
}

const environmentConfigs: Record<string, EnvironmentConfig> = {
  development: {
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '200m', memory: '256Mi' }
    },
    replicas: 1,
    healthCheck: {
      initialDelaySeconds: 10,
      periodSeconds: 30
    }
  },
  staging: {
    resources: {
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '500m', memory: '1Gi' }
    },
    replicas: 2,
    healthCheck: {
      initialDelaySeconds: 15,
      periodSeconds: 15
    }
  },
  production: {
    resources: {
      requests: { cpu: '500m', memory: '1Gi' },
      limits: { cpu: '1000m', memory: '2Gi' }
    },
    replicas: 3,
    healthCheck: {
      initialDelaySeconds: 30,
      periodSeconds: 10
    }
  }
};

export function environmentAwareApp(config: {
  name: string;
  image: string;
  environment: 'development' | 'staging' | 'production';
  team: string;
  id?: string;
}): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  const envConfig = environmentConfigs[config.environment];
  
  return createResource({
    ...(config.id && { id: config.id }),
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: config.name,
      labels: {
        app: config.name,
        team: config.team,
        environment: config.environment
      }
    },
    spec: {
      replicas: envConfig.replicas,
      selector: {
        matchLabels: { app: config.name }
      },
      template: {
        metadata: {
          labels: { app: config.name, team: config.team, environment: config.environment }
        },
        spec: {
          containers: [{
            name: config.name,
            image: config.image,
            resources: envConfig.resources,
            livenessProbe: {
              httpGet: { path: '/health', port: 8080 },
              initialDelaySeconds: envConfig.healthCheck.initialDelaySeconds,
              periodSeconds: envConfig.healthCheck.periodSeconds
            },
            readinessProbe: {
              httpGet: { path: '/ready', port: 8080 },
              initialDelaySeconds: 5,
              periodSeconds: 5
            }
          }]
        }
      }
    }
  });
}
```

### Template-Based Factory

```typescript
interface MicroserviceConfig {
  name: string;
  image: string;
  port: number;
  team: string;
  environment: string;
  monitoring?: {
    metrics?: boolean;
    tracing?: boolean;
    logging?: boolean;
  };
  id?: string;
}

export function microservice(
  config: MicroserviceConfig
): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  const {
    name,
    image,
    port,
    team,
    environment,
    monitoring = {},
    id
  } = config;

  const labels = {
    app: name,
    team,
    environment,
    'service-type': 'microservice'
  };

  const annotations: Record<string, string> = {
    'typekro.io/factory': 'microservice',
    'typekro.io/team': team
  };

  // Add monitoring annotations
  if (monitoring.metrics) annotations['prometheus.io/scrape'] = 'true';
  if (monitoring.metrics) annotations['prometheus.io/port'] = port.toString();
  if (monitoring.tracing) annotations['jaeger.io/inject'] = 'true';

  return createResource({
    ...(id && { id }),
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      labels,
      annotations
    },
    spec: {
      replicas: environment === 'production' ? 3 : 1,
      selector: {
        matchLabels: { app: name }
      },
      template: {
        metadata: {
          labels,
          annotations: {
            ...annotations,
            // Service mesh injection
            'istio.io/inject': environment === 'production' ? 'true' : 'false'
          }
        },
        spec: {
          containers: [{
            name,
            image,
            ports: [{ containerPort: port }],
            env: [
              { name: 'PORT', value: port.toString() },
              { name: 'ENVIRONMENT', value: environment },
              { name: 'TEAM', value: team },
              { name: 'SERVICE_NAME', value: name }
            ],
            resources: getResourcesByEnvironment(environment),
            livenessProbe: {
              httpGet: { path: '/health', port },
              initialDelaySeconds: 30,
              periodSeconds: 10
            },
            readinessProbe: {
              httpGet: { path: '/ready', port },
              initialDelaySeconds: 5,
              periodSeconds: 5
            }
          }]
        }
      }
    }
  });
}
```

## Best Practices

### 1. Single Resource Responsibility

Each factory function should create **exactly one Kubernetes resource**:

```typescript
// ✅ Good: Single resource factory
export function customDeployment(config: DeploymentConfig): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  return createResource({
    // Single deployment resource
  });
}

// ❌ Avoid: Multi-resource factories (use compositions instead)
export function webApplication(config: Config) {
  return {
    deployment: createResource({...}),
    service: createResource({...}),
    ingress: createResource({...})
  }; // This pattern doesn't work with TypeKro's Enhanced system
}
```

### 2. Use TypeScript Strictly

```typescript
// ✅ Define strict interfaces
interface StrictConfig {
  name: string;
  image: string;
  replicas: number;
  environment: 'dev' | 'staging' | 'prod';
}

// ✅ Use proper Enhanced types
function typedFactory(
  config: StrictConfig
): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  return createResource({
    // Implementation with proper typing
  });
}

// ❌ Avoid any types
function untypedFactory(config: any): any {
  // This breaks TypeKro's type safety
}
```

### 3. Provide Sensible Defaults

```typescript
export function factoryWithDefaults(config: Config) {
  const defaults = {
    replicas: 1,
    resources: {
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '500m', memory: '512Mi' }
    },
    healthChecks: true
  };
  
  const finalConfig = { ...defaults, ...config };
  
  return createResource({
    // Use finalConfig for complete configuration
  });
}
```

### 4. Validate Configuration

```typescript
function validateConfig(config: Config): Config {
  if (!config.name || config.name.length < 3) {
    throw new Error('Name must be at least 3 characters');
  }
  
  if (config.replicas < 1 || config.replicas > 100) {
    throw new Error('Replicas must be between 1 and 100');
  }
  
  return config;
}

export function validatedFactory(config: Config) {
  const validConfig = validateConfig(config);
  return createResource({
    // Use validConfig
  });
}
```

### 5. Support Custom IDs

```typescript
export function factory(config: Config & { id?: string }) {
  return createResource({
    ...(config.id && { id: config.id }), // Optional explicit ID
    // Rest of resource definition
  });
}
```

### 6. Use Readiness Evaluators

```typescript
const customReadinessEvaluator = (liveResource: V1Deployment): ResourceStatus => {
  const status = liveResource.status;
  const expectedReplicas = liveResource.spec?.replicas || 1;
  
  if (status?.readyReplicas === expectedReplicas) {
    return { ready: true, reason: 'AllReady', message: `All ${expectedReplicas} replicas ready` };
  }
  
  return { 
    ready: false, 
    reason: 'NotReady', 
    message: `${status?.readyReplicas || 0}/${expectedReplicas} replicas ready` 
  };
};

export function factoryWithReadiness(config: Config) {
  return createResource({
    // Resource definition
  }).withReadinessEvaluator(customReadinessEvaluator);
}
```

## What's Next?

Now that you understand custom factories, explore more advanced TypeKro patterns:

### Next: [CEL Expressions →](./cel-expressions.md)
Learn how to create dynamic status expressions using CEL.

**In this learning path:**
- ✅ Your First App - Built your first TypeKro application
- ✅ Factory Functions - Mastered resource creation  
- ✅ Magic Proxy System - TypeKro's unique reference system
- ✅ Custom Factories - Created reusable factory functions
- 🎯 **Next**: CEL Expressions - Dynamic status computation
- **Coming**: External References - Cross-composition coordination

## Quick Reference

### Basic Custom Factory Pattern
```typescript
import { createResource, type Enhanced } from 'typekro';

export function customFactory(
  config: ConfigType
): Enhanced<SpecType, StatusType> {
  return createResource({
    ...(config.id && { id: config.id }),
    apiVersion: 'apps/v1',
    kind: 'ResourceKind',
    metadata: {
      name: config.name,
      // metadata
    },
    spec: {
      // resource specification
    }
  });
}
```

### With Custom Readiness
```typescript
const evaluator = (resource: ResourceType): ResourceStatus => {
  // Custom readiness logic
  return { ready: true, reason: 'Ready', message: 'Resource is ready' };
};

export function factoryWithReadiness(config: ConfigType) {
  return createResource({
    // resource definition
  }).withReadinessEvaluator(evaluator);
}
```

### Using in Compositions
```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const resource = customFactory({
    name: spec.name,
    // configuration from spec
  });

  return {
    ready: Cel.expr<boolean>(resource.status.readyReplicas, ' > 0')
  };
});
```

Ready to create dynamic status? Continue to [CEL Expressions →](./cel-expressions.md)