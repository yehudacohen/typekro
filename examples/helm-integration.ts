/**
 * Helm Integration Example
 *
 * This example demonstrates TypeKro's Helm integration capabilities using
 * the helmRelease() function and simple.HelmChart() factory.
 * Shows how to leverage existing Helm charts with TypeKro's magic proxy system.
 */

import { type } from 'arktype';
import { Cel, kubernetesComposition } from '../src/index.js';
import { helmRelease } from '../src/factories/helm/helm-release.js';
import { ConfigMap, Secret } from '../src/factories/simple/index.js';

// =============================================================================
// Example 1: Basic Helm Chart Integration
// =============================================================================

const DatabaseSpec = type({
  name: 'string',
  size: 'string',
  password: 'string',
  replicas: 'number',
});

const DatabaseStatus = type({
  ready: 'boolean',
  phase: '"Pending" | "Installing" | "Ready" | "Failed"',
  endpoint: 'string',
});

// Helm-based database composition using PostgreSQL chart
const databaseComposition = kubernetesComposition(
  {
    name: 'database',
    apiVersion: 'data.company.com/v1alpha1',
    kind: 'Database',
    spec: DatabaseSpec,
    status: DatabaseStatus,
  },
  (spec) => {
    // Create secret for database credentials
    const dbSecret = Secret({
      name: 'postgres-secret',
      stringData: {
        password: spec.password,
        'postgres-password': spec.password,
      },
    });

    // Deploy PostgreSQL using Helm chart with TypeKro schema references
    const postgres = helmRelease({
      name: spec.name,
      namespace: 'databases',
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'postgresql',
        version: '12.1.9',
      },
      values: {
        // Reference schema values directly in Helm chart values
        auth: {
          existingSecret: dbSecret.metadata.name,
          database: spec.name,
        },
        primary: {
          persistence: {
            size: spec.size,
          },
          resources: {
            requests: {
              memory: '256Mi',
              cpu: '250m',
            },
          },
        },
        // Use schema references for replica configuration
        readReplicas: {
          // ✨ JavaScript expression - automatically converted to CEL
          replicaCount: spec.replicas - 1, // Primary + replicas
        },
      },
      id: 'postgres',
    });

    // ✨ Natural JavaScript expressions - automatically converted to CEL
    return {
      ready: postgres.status.phase === 'Ready',
      phase: postgres.status.phase === 'Ready' ? 'Ready' : 'Installing',
      endpoint: `${spec.name}-postgresql.databases.svc.cluster.local`,
    };
  }
);

// =============================================================================
// Example 2: Complex Multi-Chart Application
// =============================================================================

const WebAppSpec = type({
  name: 'string',
  domain: 'string',
  replicas: 'number',
  database: {
    size: 'string',
    password: 'string',
  },
  redis: {
    enabled: 'boolean',
    replicas: 'number',
  },
});

const WebAppStatus = type({
  ready: 'boolean',
  databaseReady: 'boolean',
  redisReady: 'boolean',
  url: 'string',
});

// Complex application using multiple Helm charts
const webAppComposition = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'apps.company.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  (spec) => {
    // Application configuration
    const _appConfig = ConfigMap({
      name: 'app-config',
      data: {
        // ✨ JavaScript template literals - automatically converted to CEL
        'database.host': `${spec.name}-postgresql.default.svc.cluster.local`,
        'database.port': '5432',
        'database.name': spec.name,
        'redis.enabled': spec.redis.enabled.toString(),
        'redis.host': `${spec.name}-redis-master.default.svc.cluster.local`,
        'app.domain': spec.domain,
      },
      id: 'appConfig',
    });

    // Database credentials secret
    const dbSecret = Secret({
      name: 'database-credentials',
      stringData: {
        password: spec.database.password,
        'postgres-password': spec.database.password,
      },
    });

    // PostgreSQL using Helm chart
    const database = helmRelease({
      name: `${spec.name}-db`,
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'postgresql',
        version: '12.1.9',
      },
      values: {
        auth: {
          existingSecret: dbSecret.metadata.name,
          database: spec.name,
        },
        primary: {
          persistence: {
            size: spec.database.size,
          },
        },
      },
      id: 'database',
    });

    // Conditional Redis deployment using CEL expressions
    const redis = helmRelease({
      name: `${spec.name}-redis`,
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'redis',
        version: '17.4.3',
      },
      values: {
        auth: {
          enabled: false, // Simplified for demo
        },
        replica: {
          replicaCount: spec.redis.replicas,
        },
        master: {
          persistence: {
            enabled: true,
            size: '8Gi',
          },
        },
      },
      id: 'redis',
    });

    // NGINX Ingress Controller using Helm chart
    const nginx = helmRelease({
      name: 'nginx-ingress',
      chart: {
        repository: 'https://kubernetes.github.io/ingress-nginx',
        name: 'ingress-nginx',
        version: '4.4.2',
      },
      values: {
        controller: {
          service: {
            type: 'LoadBalancer',
          },
          config: {
            'server-tokens': 'false',
            'ssl-redirect': 'true',
          },
        },
      },
      id: 'nginx',
    });

    // ✨ Natural JavaScript expressions - automatically converted to CEL
    return {
      ready: database.status.phase === 'Ready' && 
             redis.status.phase === 'Ready' && 
             nginx.status.phase === 'Ready',
      databaseReady: database.status.phase === 'Ready',
      redisReady: spec.redis.enabled ? redis.status.phase === 'Ready' : true,
      url: `https://${spec.domain}`,
    };
  }
);

// =============================================================================
// Example 3: Monitoring Stack with Helm
// =============================================================================

const MonitoringSpec = type({
  retention: 'string',
  storageSize: 'string',
  alertingEnabled: 'boolean',
});

const MonitoringStatus = type({
  prometheusReady: 'boolean',
  grafanaReady: 'boolean',
  alertmanagerReady: 'boolean',
});

// Monitoring stack using kube-prometheus-stack Helm chart
const monitoringComposition = kubernetesComposition(
  {
    name: 'monitoring',
    apiVersion: 'platform.company.com/v1alpha1',
    kind: 'Monitoring',
    spec: MonitoringSpec,
    status: MonitoringStatus,
  },
  (spec) => {
    // Deploy full monitoring stack using Helm
    const monitoring = helmRelease({
      name: 'monitoring-stack',
      namespace: 'monitoring',
      chart: {
        repository: 'https://prometheus-community.github.io/helm-charts',
        name: 'kube-prometheus-stack',
        version: '45.7.1',
      },
      values: {
        prometheus: {
          prometheusSpec: {
            retention: spec.retention,
            storageSpec: {
              volumeClaimTemplate: {
                spec: {
                  accessModes: ['ReadWriteOnce'],
                  resources: {
                    requests: {
                      storage: spec.storageSize,
                    },
                  },
                },
              },
            },
          },
        },
        grafana: {
          adminPassword: 'admin123', // In production, use proper secrets
          persistence: {
            enabled: true,
            size: '10Gi',
          },
        },
        alertmanager: {
          enabled: spec.alertingEnabled,
          alertmanagerSpec: {
            storage: {
              volumeClaimTemplate: {
                spec: {
                  accessModes: ['ReadWriteOnce'],
                  resources: {
                    requests: {
                      storage: '10Gi',
                    },
                  },
                },
              },
            },
          },
        },
      },
      id: 'monitoring',
    });

    return {
      prometheusReady: monitoring.status.phase === 'Ready', // ✨ Natural JavaScript expression
      grafanaReady: monitoring.status.phase === 'Ready', // ✨ Natural JavaScript expression
      alertmanagerReady: spec.alertingEnabled 
        ? monitoring.status.phase === 'Ready' 
        : true, // ✨ Natural JavaScript conditional expression
    };
  }
);

// =============================================================================
// Usage Examples and Demonstrations
// =============================================================================

console.log('⚙️  Helm Integration Example');
console.log('=============================');

console.log('\n1️⃣  Database Composition (PostgreSQL Helm Chart):');
console.log(databaseComposition.toYaml());

console.log('\n2️⃣  Complex WebApp (Multiple Helm Charts):');
console.log(webAppComposition.toYaml());

console.log('\n3️⃣  Monitoring Stack (kube-prometheus-stack):');
console.log(monitoringComposition.toYaml());

console.log('\n✅ Key Helm Integration Features:');
console.log('   📦 Leverage Existing Charts - Use thousands of community Helm charts');
console.log('   🔗 Schema References - TypeKro spec values directly in Helm values');
console.log('   🎯 Status Integration - HelmRelease status accessible via TypeKro proxy');
console.log('   🔄 Cross-Chart Dependencies - Reference resources across different charts');
console.log('   📋 Flux CD Compatible - Uses HelmRelease CRD for GitOps workflows');

console.log('\n🚀 Example Deployment Commands:');
console.log('   kubectl apply -f database.yaml');
console.log('   kubectl apply -f webapp.yaml');
console.log('   kubectl apply -f monitoring.yaml');

export { databaseComposition, webAppComposition, monitoringComposition };