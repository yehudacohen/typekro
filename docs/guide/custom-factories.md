# Custom Factory Functions

While TypeKro provides comprehensive built-in factory functions, you can create custom factories for organization-specific patterns, complex resources, or specialized workflows. This guide shows you how to build reusable, type-safe factory functions.

## Understanding Factory Functions

Factory functions in TypeKro are functions that return Enhanced Kubernetes resources with:

- **Type safety** - Full TypeScript validation
- **Cross-resource references** - Ability to reference other resources
- **Status tracking** - Runtime status information
- **Consistent patterns** - Standardized configuration interfaces

```typescript
// Basic factory function signature
function customFactory(config: ConfigType): Enhanced<SpecType, StatusType> {
  return createResource({
    // Kubernetes resource definition
  });
}
```

## Basic Custom Factory

### Simple Custom Deployment Factory

```typescript
import { createResource } from 'typekro';
import type { V1Deployment, V1DeploymentStatus } from '@kubernetes/client-node';

interface CustomDeploymentConfig {
  name: string;
  image: string;
  replicas?: number;
  environment: 'development' | 'staging' | 'production';
  team: string;
  monitoring?: boolean;
}

export function customDeployment(
  config: CustomDeploymentConfig
): Enhanced<V1Deployment, V1DeploymentStatus> {
  const {
    name,
    image,
    replicas = 1,
    environment,
    team,
    monitoring = false
  } = config;

  return createResource({
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
  monitoring: true
});
```

## Advanced Custom Factories

### Multi-Resource Factory

Create factories that generate multiple related resources:

```typescript
interface WebApplicationConfig {
  name: string;
  image: string;
  replicas: number;
  environment: string;
  team: string;
  database?: {
    enabled: boolean;
    size?: string;
    storageClass?: string;
  };
  ingress?: {
    enabled: boolean;
    hostname?: string;
    tls?: boolean;
  };
}

interface WebApplicationResources {
  deployment: Enhanced<V1Deployment, V1DeploymentStatus>;
  service: Enhanced<V1Service, V1ServiceStatus>;
  configMap: Enhanced<V1ConfigMap, {}>;
  database?: Enhanced<V1StatefulSet, V1StatefulSetStatus>;
  databaseService?: Enhanced<V1Service, V1ServiceStatus>;
  storage?: Enhanced<V1PersistentVolumeClaim, V1PersistentVolumeClaimStatus>;
  ingress?: Enhanced<V1Ingress, V1IngressStatus>;
}

export function webApplication(
  config: WebApplicationConfig
): WebApplicationResources {
  const { name, image, replicas, environment, team, database, ingress } = config;
  
  // Configuration ConfigMap
  const configMap = createResource({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: `${name}-config`,
      labels: { app: name, team, environment }
    },
    data: {
      'app.properties': `
        app.name=${name}
        app.environment=${environment}
        app.team=${team}
        logging.level=${environment === 'production' ? 'INFO' : 'DEBUG'}
      `,
      'features.json': JSON.stringify({
        database: database?.enabled || false,
        monitoring: environment === 'production',
        debugging: environment !== 'production'
      })
    }
  });

  // Main application deployment
  const deployment = createResource({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      labels: { app: name, team, environment }
    },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name, team, environment } },
        spec: {
          containers: [{
            name,
            image,
            ports: [{ containerPort: 3000 }],
            env: [
              { name: 'CONFIG_PATH', value: '/etc/config' },
              ...(database?.enabled ? [
                { name: 'DATABASE_HOST', value: `${name}-database-service` },
                { name: 'DATABASE_PORT', value: '5432' }
              ] : [])
            ],
            volumeMounts: [{
              name: 'config',
              mountPath: '/etc/config'
            }],
            resources: getResourcesByEnvironment(environment)
          }],
          volumes: [{
            name: 'config',
            configMap: { name: configMap.metadata.name }
          }]
        }
      }
    }
  });

  // Service for the application
  const service = createResource({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${name}-service`,
      labels: { app: name, team, environment }
    },
    spec: {
      selector: { app: name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'ClusterIP'
    }
  });

  const resources: WebApplicationResources = {
    deployment,
    service,
    configMap
  };

  // Optional database
  if (database?.enabled) {
    const storage = createResource({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: `${name}-database-storage`,
        labels: { app: name, component: 'database', team, environment }
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: { storage: database.size || '10Gi' }
        },
        ...(database.storageClass && {
          storageClassName: database.storageClass
        })
      }
    });

    const databaseDeployment = createResource({
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: {
        name: `${name}-database`,
        labels: { app: name, component: 'database', team, environment }
      },
      spec: {
        serviceName: `${name}-database-service`,
        replicas: 1,
        selector: { matchLabels: { app: name, component: 'database' } },
        template: {
          metadata: { labels: { app: name, component: 'database', team, environment } },
          spec: {
            containers: [{
              name: 'postgres',
              image: 'postgres:15',
              ports: [{ containerPort: 5432 }],
              env: [
                { name: 'POSTGRES_DB', value: name },
                { name: 'POSTGRES_USER', value: 'app' },
                { name: 'POSTGRES_PASSWORD', value: 'password' }  // Use secrets in production
              ],
              volumeMounts: [{
                name: 'data',
                mountPath: '/var/lib/postgresql/data'
              }]
            }],
            volumes: [{
              name: 'data',
              persistentVolumeClaim: { claimName: storage.metadata.name }
            }]
          }
        }
      }
    });

    const databaseService = createResource({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: `${name}-database-service`,
        labels: { app: name, component: 'database', team, environment }
      },
      spec: {
        selector: { app: name, component: 'database' },
        ports: [{ port: 5432, targetPort: 5432 }],
        type: 'ClusterIP'
      }
    });

    resources.database = databaseDeployment;
    resources.databaseService = databaseService;
    resources.storage = storage;
  }

  // Optional ingress
  if (ingress?.enabled) {
    const ingressResource = createResource({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: `${name}-ingress`,
        labels: { app: name, team, environment },
        annotations: {
          'nginx.ingress.kubernetes.io/rewrite-target': '/',
          ...(ingress.tls && {
            'cert-manager.io/cluster-issuer': 'letsencrypt-prod'
          })
        }
      },
      spec: {
        rules: [{
          host: ingress.hostname || `${name}.${environment}.example.com`,
          http: {
            paths: [{
              path: '/',
              pathType: 'Prefix',
              backend: {
                service: {
                  name: service.metadata.name,
                  port: { number: 80 }
                }
              }
            }]
          }
        }],
        ...(ingress.tls && {
          tls: [{
            secretName: `${name}-tls`,
            hosts: [ingress.hostname || `${name}.${environment}.example.com`]
          }]
        })
      }
    });

    resources.ingress = ingressResource;
  }

  return resources;
}
```

### Typed Factory with Status

```typescript
import type { Enhanced } from 'typekro';

interface MonitoringStackConfig {
  name: string;
  namespace: string;
  prometheus: {
    retention: string;
    storage: string;
    storageClass?: string;
  };
  grafana: {
    adminPassword: string;
    plugins?: string[];
  };
  alertmanager?: {
    enabled: boolean;
    webhookUrl?: string;
  };
}

interface MonitoringStackStatus {
  prometheusReady: boolean;
  grafanaReady: boolean;
  alertmanagerReady: boolean;
  dashboardUrl: string;
  metricsEndpoint: string;
}

export function monitoringStack(
  config: MonitoringStackConfig
): {
  prometheus: Enhanced<V1StatefulSet, V1StatefulSetStatus>;
  prometheusSvc: Enhanced<V1Service, V1ServiceStatus>;
  grafana: Enhanced<V1Deployment, V1DeploymentStatus>;
  grafanaSvc: Enhanced<V1Service, V1ServiceStatus>;
  alertmanager?: Enhanced<V1Deployment, V1DeploymentStatus>;
} {
  const { name, namespace, prometheus: promConfig, grafana: grafanaConfig, alertmanager } = config;

  // Prometheus StatefulSet
  const prometheus = createResource({
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: `${name}-prometheus`,
      namespace,
      labels: { app: `${name}-prometheus`, component: 'monitoring' }
    },
    spec: {
      serviceName: `${name}-prometheus`,
      replicas: 1,
      selector: { matchLabels: { app: `${name}-prometheus` } },
      template: {
        metadata: { labels: { app: `${name}-prometheus` } },
        spec: {
          containers: [{
            name: 'prometheus',
            image: 'prom/prometheus:latest',
            ports: [{ containerPort: 9090 }],
            args: [
              '--config.file=/etc/prometheus/prometheus.yml',
              '--storage.tsdb.path=/prometheus/',
              `--storage.tsdb.retention.time=${promConfig.retention}`,
              '--web.console.libraries=/etc/prometheus/console_libraries',
              '--web.console.templates=/etc/prometheus/consoles',
              '--web.enable-lifecycle'
            ],
            volumeMounts: [
              { name: 'prometheus-config', mountPath: '/etc/prometheus' },
              { name: 'prometheus-storage', mountPath: '/prometheus' }
            ],
            resources: {
              requests: { cpu: '200m', memory: '1Gi' },
              limits: { cpu: '500m', memory: '2Gi' }
            }
          }],
          volumes: [{
            name: 'prometheus-config',
            configMap: { name: `${name}-prometheus-config` }
          }]
        }
      },
      volumeClaimTemplates: [{
        metadata: { name: 'prometheus-storage' },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: promConfig.storage } },
          ...(promConfig.storageClass && {
            storageClassName: promConfig.storageClass
          })
        }
      }]
    }
  });

  // Prometheus Service
  const prometheusSvc = createResource({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${name}-prometheus`,
      namespace,
      labels: { app: `${name}-prometheus` }
    },
    spec: {
      selector: { app: `${name}-prometheus` },
      ports: [{ port: 9090, targetPort: 9090 }],
      type: 'ClusterIP'
    }
  });

  // Grafana Deployment
  const grafana = createResource({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: `${name}-grafana`,
      namespace,
      labels: { app: `${name}-grafana`, component: 'monitoring' }
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: `${name}-grafana` } },
      template: {
        metadata: { labels: { app: `${name}-grafana` } },
        spec: {
          containers: [{
            name: 'grafana',
            image: 'grafana/grafana:latest',
            ports: [{ containerPort: 3000 }],
            env: [
              { name: 'GF_SECURITY_ADMIN_PASSWORD', value: grafanaConfig.adminPassword },
              { name: 'GF_INSTALL_PLUGINS', value: grafanaConfig.plugins?.join(',') || '' }
            ],
            volumeMounts: [
              { name: 'grafana-storage', mountPath: '/var/lib/grafana' },
              { name: 'grafana-config', mountPath: '/etc/grafana/provisioning' }
            ],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '200m', memory: '512Mi' }
            }
          }],
          volumes: [
            { name: 'grafana-storage', emptyDir: {} },
            { name: 'grafana-config', configMap: { name: `${name}-grafana-config` } }
          ]
        }
      }
    }
  });

  // Grafana Service
  const grafanaSvc = createResource({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${name}-grafana`,
      namespace,
      labels: { app: `${name}-grafana` }
    },
    spec: {
      selector: { app: `${name}-grafana` },
      ports: [{ port: 3000, targetPort: 3000 }],
      type: 'ClusterIP'
    }
  });

  const result: any = {
    prometheus,
    prometheusSvc,
    grafana,
    grafanaSvc
  };

  // Optional Alertmanager
  if (alertmanager?.enabled) {
    const alertmanagerDeployment = createResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: `${name}-alertmanager`,
        namespace,
        labels: { app: `${name}-alertmanager`, component: 'monitoring' }
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: `${name}-alertmanager` } },
        template: {
          metadata: { labels: { app: `${name}-alertmanager` } },
          spec: {
            containers: [{
              name: 'alertmanager',
              image: 'prom/alertmanager:latest',
              ports: [{ containerPort: 9093 }],
              args: [
                '--config.file=/etc/alertmanager/alertmanager.yml',
                '--storage.path=/alertmanager'
              ],
              volumeMounts: [{
                name: 'alertmanager-config',
                mountPath: '/etc/alertmanager'
              }]
            }],
            volumes: [{
              name: 'alertmanager-config',
              configMap: { name: `${name}-alertmanager-config` }
            }]
          }
        }
      }
    });

    result.alertmanager = alertmanagerDeployment;
  }

  return result;
}
```

## Factory Patterns

### Composition Pattern

```typescript
// Base factory for common functionality
function baseApplication(config: BaseApplicationConfig) {
  return {
    deployment: createResource({
      // Common deployment configuration
    }),
    service: createResource({
      // Common service configuration
    })
  };
}

// Specialized factories that extend the base
export function webApplication(config: WebApplicationConfig) {
  const base = baseApplication(config);
  
  return {
    ...base,
    ingress: createResource({
      // Web-specific ingress configuration
    })
  };
}

export function apiApplication(config: ApiApplicationConfig) {
  const base = baseApplication(config);
  
  return {
    ...base,
    serviceMonitor: createResource({
      // API-specific monitoring configuration
    })
  };
}
```

### Builder Pattern

```typescript
export class ApplicationBuilder {
  private config: Partial<ApplicationConfig> = {};
  
  name(name: string): ApplicationBuilder {
    this.config.name = name;
    return this;
  }
  
  image(image: string): ApplicationBuilder {
    this.config.image = image;
    return this;
  }
  
  replicas(replicas: number): ApplicationBuilder {
    this.config.replicas = replicas;
    return this;
  }
  
  environment(env: string): ApplicationBuilder {
    this.config.environment = env;
    return this;
  }
  
  withDatabase(config?: DatabaseConfig): ApplicationBuilder {
    this.config.database = { enabled: true, ...config };
    return this;
  }
  
  withIngress(hostname?: string): ApplicationBuilder {
    this.config.ingress = { enabled: true, hostname };
    return this;
  }
  
  withMonitoring(): ApplicationBuilder {
    this.config.monitoring = true;
    return this;
  }
  
  build(): WebApplicationResources {
    if (!this.config.name || !this.config.image) {
      throw new Error('Name and image are required');
    }
    
    return webApplication(this.config as ApplicationConfig);
  }
}

// Usage
const app = new ApplicationBuilder()
  .name('user-service')
  .image('myregistry/user-service:v1.0.0')
  .replicas(3)
  .environment('production')
  .withDatabase({ size: '50Gi', storageClass: 'fast-ssd' })
  .withIngress('users.example.com')
  .withMonitoring()
  .build();
```

### Plugin Pattern

```typescript
interface ApplicationPlugin {
  name: string;
  apply(resources: any, config: any): any;
}

class MonitoringPlugin implements ApplicationPlugin {
  name = 'monitoring';
  
  apply(resources: any, config: any) {
    return {
      ...resources,
      serviceMonitor: createResource({
        apiVersion: 'monitoring.coreos.com/v1',
        kind: 'ServiceMonitor',
        metadata: {
          name: `${config.name}-monitor`,
          labels: { app: config.name }
        },
        spec: {
          selector: { matchLabels: { app: config.name } },
          endpoints: [{ port: 'metrics' }]
        }
      })
    };
  }
}

class LoggingPlugin implements ApplicationPlugin {
  name = 'logging';
  
  apply(resources: any, config: any) {
    // Add logging sidecar to deployment
    const deployment = { ...resources.deployment };
    deployment.spec.template.spec.containers.push({
      name: 'fluentd',
      image: 'fluentd:latest',
      // Fluentd configuration
    });
    
    return {
      ...resources,
      deployment
    };
  }
}

function pluggableApplication(
  config: ApplicationConfig,
  plugins: ApplicationPlugin[] = []
): any {
  let resources = webApplication(config);
  
  for (const plugin of plugins) {
    resources = plugin.apply(resources, config);
  }
  
  return resources;
}

// Usage
const app = pluggableApplication(config, [
  new MonitoringPlugin(),
  new LoggingPlugin()
]);
```

## Testing Custom Factories

### Unit Testing

```typescript
// __tests__/custom-deployment.test.ts
import { describe, it, expect } from 'bun:test';
import { customDeployment } from '../factories/custom-deployment.js';

describe('customDeployment', () => {
  it('should create a deployment with correct labels', () => {
    const result = customDeployment({
      name: 'test-app',
      image: 'test:latest',
      environment: 'development',
      team: 'platform'
    });
    
    expect(result.metadata.labels).toEqual({
      app: 'test-app',
      team: 'platform',
      environment: 'development',
      'managed-by': 'typekro'
    });
  });
  
  it('should set environment-specific resources', () => {
    const prodApp = customDeployment({
      name: 'prod-app',
      image: 'app:v1.0.0',
      environment: 'production',
      team: 'backend'
    });
    
    const container = prodApp.spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe('500m');
    expect(container.resources.limits.memory).toBe('2Gi');
  });
  
  it('should enable monitoring when requested', () => {
    const monitoredApp = customDeployment({
      name: 'monitored-app',
      image: 'app:latest',
      environment: 'production',
      team: 'backend',
      monitoring: true
    });
    
    expect(monitoredApp.metadata.labels['monitoring.enabled']).toBe('true');
  });
});
```

### Integration Testing

```typescript
// __tests__/web-application.integration.test.ts
import { describe, it, expect } from 'bun:test';
import { toResourceGraph } from 'typekro';
import { webApplication } from '../factories/web-application.js';

describe('webApplication integration', () => {
  it('should create a complete web application stack', () => {
    const config = {
      name: 'test-webapp',
      image: 'webapp:latest',
      replicas: 2,
      environment: 'staging',
      team: 'frontend',
      database: { enabled: true, size: '10Gi' },
      ingress: { enabled: true, hostname: 'test.example.com' }
    };
    
    const resources = webApplication(config);
    
    // Check all resources are created
    expect(resources.deployment).toBeDefined();
    expect(resources.service).toBeDefined();
    expect(resources.configMap).toBeDefined();
    expect(resources.database).toBeDefined();
    expect(resources.databaseService).toBeDefined();
    expect(resources.storage).toBeDefined();
    expect(resources.ingress).toBeDefined();
    
    // Check database connection configuration
    const appContainer = resources.deployment.spec.template.spec.containers[0];
    const dbHostEnv = appContainer.env.find(e => e.name === 'DATABASE_HOST');
    expect(dbHostEnv?.value).toBe('test-webapp-database-service');
  });
  
  it('should work with toResourceGraph', () => {
    const webAppGraph = toResourceGraph(
      {
        name: 'webapp-stack',
        apiVersion: 'example.com/v1alpha1',
        kind: 'WebApp',
        spec: WebAppSpec,
        status: WebAppStatus,
      },
      (schema) => webApplication({
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        environment: schema.spec.environment,
        team: schema.spec.team,
        database: { enabled: true }
      }),
      (schema, resources) => ({
        ready: resources.deployment.status.readyReplicas > 0,
        url: `http://${resources.service.spec.clusterIP}`
      })
    );
    
    expect(webAppGraph).toBeDefined();
    expect(typeof webAppGraph.toYaml).toBe('function');
  });
});
```

## Publishing Custom Factories

### Package Structure

```
my-typekro-factories/
├── src/
│   ├── factories/
│   │   ├── web-application.ts
│   │   ├── monitoring-stack.ts
│   │   └── index.ts
│   └── types/
│       └── index.ts
├── __tests__/
│   ├── web-application.test.ts
│   └── monitoring-stack.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

### Package Configuration

```json
// package.json
{
  "name": "@myorg/typekro-factories",
  "version": "1.0.0",
  "description": "Custom TypeKro factory functions for MyOrg",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist/**/*"
  ],
  "scripts": {
    "build": "tsc",
    "test": "bun test",
    "prepublishOnly": "bun run build && bun run test"
  },
  "peerDependencies": {
    "typekro": "^1.0.0",
    "@kubernetes/client-node": "^0.20.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  },
  "keywords": [
    "typekro",
    "kubernetes",
    "infrastructure-as-code",
    "typescript"
  ]
}
```

### Documentation

```markdown
# @myorg/typekro-factories

Custom TypeKro factory functions for MyOrg applications.

## Installation

```bash
bun add @myorg/typekro-factories
```

## Usage

```typescript
import { webApplication, monitoringStack } from '@myorg/typekro-factories';

const app = webApplication({
  name: 'my-app',
  image: 'myregistry/my-app:v1.0.0',
  environment: 'production',
  team: 'backend'
});
```

## Factories

### webApplication

Creates a complete web application with optional database and ingress.

**Configuration:**
- `name` (string) - Application name
- `image` (string) - Container image
- `environment` (string) - Environment name
- `team` (string) - Team name
- `database` (optional) - Database configuration
- `ingress` (optional) - Ingress configuration

### monitoringStack

Creates a monitoring stack with Prometheus and Grafana.

**Configuration:**
- `name` (string) - Stack name
- `prometheus` (object) - Prometheus configuration
- `grafana` (object) - Grafana configuration
```

## Best Practices

### 1. Use TypeScript Strictly

```typescript
// ✅ Define strict interfaces
interface StrictConfig {
  name: string;
  image: string;
  replicas: number;
  environment: 'dev' | 'staging' | 'prod';
}

// ✅ Use generic types
function typedFactory<T extends BaseConfig>(
  config: T
): Enhanced<V1Deployment, V1DeploymentStatus> {
  // Implementation
}
```

### 2. Provide Sensible Defaults

```typescript
// ✅ Merge with defaults
function factoryWithDefaults(config: Config) {
  const defaults = {
    replicas: 1,
    resources: { cpu: '100m', memory: '256Mi' },
    healthChecks: true
  };
  
  const finalConfig = { ...defaults, ...config };
  // Use finalConfig
}
```

### 3. Validate Configuration

```typescript
// ✅ Validate inputs
function validateConfig(config: Config): Config {
  if (!config.name || config.name.length < 3) {
    throw new Error('Name must be at least 3 characters');
  }
  
  if (config.replicas < 1 || config.replicas > 100) {
    throw new Error('Replicas must be between 1 and 100');
  }
  
  return config;
}
```

### 4. Document Thoroughly

```typescript
/**
 * Creates a production-ready web application deployment
 * 
 * @param config - Application configuration
 * @param config.name - Application name (3-63 characters, DNS-1123 compliant)
 * @param config.image - Container image with tag
 * @param config.replicas - Number of replicas (1-100)
 * @param config.environment - Deployment environment
 * @returns Enhanced deployment resource with typed status
 * 
 * @example
 * ```typescript
 * const app = webApplication({
 *   name: 'user-service',
 *   image: 'myregistry/user-service:v1.0.0',
 *   replicas: 3,
 *   environment: 'production'
 * });
 * ```
 */
export function webApplication(config: WebApplicationConfig) {
  // Implementation
}
```

## Next Steps

- **[Type Safety](./type-safety.md)** - Ensure your factories are type-safe
- **[Performance](./performance.md)** - Optimize factory performance
- **[Testing](./troubleshooting.md)** - Test and debug custom factories
- **[Examples](../examples/)** - See complete custom factory examples