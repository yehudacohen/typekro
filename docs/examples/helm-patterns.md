# Helm Integration Patterns

Common Helm chart integration patterns with TypeKro.

## Basic Helm Release

```typescript
import { type } from 'arktype';
import { toResourceGraph, helmRelease, Cel } from 'typekro';

const HelmAppSpec = type({
  name: 'string',
  chartVersion: 'string',
  replicas: 'number',
  hostname: 'string'
});

export const helmApp = toResourceGraph(
  {
    name: 'helm-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'HelmApp',
    spec: HelmAppSpec
  },
  (schema) => ({
    release: helmRelease({
      name: schema.spec.name,
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'nginx',
        version: schema.spec.chartVersion
      },
      values: {
        replicaCount: schema.spec.replicas,
        ingress: {
          enabled: true,
          hostname: schema.spec.hostname
        }
      }
    })
  }),
  (schema, resources) => ({
    phase: resources.release.status.phase,
    ready: Cel.expr<boolean>(resources.release.status.phase, ' == "Ready"'),
    url: Cel.template('https://%s', schema.spec.hostname)
  })
);
```

## Multi-Chart Application

```typescript
export const helmStack = toResourceGraph(
  {
    name: 'helm-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'HelmStack',
    spec: type({
      name: 'string',
      environment: 'string'
    })
  },
  (schema) => ({
    // Database chart
    database: helmRelease({
      name: Cel.template('%s-db', schema.spec.name),
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'postgresql'
      },
      values: {
        auth: {
          database: schema.spec.name,
          username: 'app'
        }
      }
    }),

    // Application chart  
    app: helmRelease({
      name: schema.spec.name,
      chart: {
        repository: 'https://charts.company.com',
        name: 'webapp'
      },
      values: {
        database: {
          host: Cel.template('%s-db-postgresql', schema.spec.name),
          port: 5432
        },
        environment: schema.spec.environment
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr<boolean>(`
      resources.database.status.phase == "Ready" && 
      resources.app.status.phase == "Ready"
    `)
  })
);
```

## Key Patterns

- **Chart Dependencies**: Database deployed before application
- **Value Templating**: Using schema references in Helm values
- **Status Aggregation**: Overall readiness from multiple charts