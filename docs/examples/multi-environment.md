# Multi-Environment

Environment-specific configurations.

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const EnvAppSpec = type({
  name: 'string',
  image: 'string',
  environment: '"development" | "staging" | "production"',
  replicas: 'number'
});

const EnvAppStatus = type({
  ready: 'boolean',
  env: 'string'
});

export const envApp = kubernetesComposition({
  name: 'env-app',
  apiVersion: 'example.com/v1alpha1',
  kind: 'EnvApp',
  spec: EnvAppSpec,
  status: EnvAppStatus,
}, (spec) => {
  const deploy = Deployment({
    id: 'deploy',
    name: `${spec.environment}-${spec.name}`,
    image: spec.image,
    replicas: spec.replicas,
    ports: [{ containerPort: 3000 }],
    env: { 
      NODE_ENV: spec.environment, 
      LOG_LEVEL: spec.environment === 'production' ? 'warn' : 'debug' 
    },
    resources: spec.environment === 'production'
      ? { limits: { cpu: '500m', memory: '512Mi' } }
      : { limits: { cpu: '100m', memory: '128Mi' } }
  });

  Service({
    id: 'svc',
    name: `${spec.environment}-${spec.name}-svc`,
    selector: { app: `${spec.environment}-${spec.name}` },
    ports: [{ port: 80, targetPort: 3000 }],
    type: spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
  });

  return {
    ready: deploy.status.readyReplicas >= spec.replicas,
    env: spec.environment
  };
});
```

## Deploy to Multiple Environments

```typescript
const configs = [
  { name: 'api', image: 'api:latest', environment: 'development' as const, replicas: 1 },
  { name: 'api', image: 'api:v1.2.0', environment: 'staging' as const, replicas: 2 },
  { name: 'api', image: 'api:v1.2.0', environment: 'production' as const, replicas: 5 }
];

for (const config of configs) {
  const factory = envApp.factory('direct', { namespace: config.environment });
  await factory.deploy(config);
}
```

## Key Concepts

- **Environment parametrization**: Single composition, multiple environments
- **Conditional resources**: Different resource limits per environment
- **Service types**: LoadBalancer for production, ClusterIP for dev
- **Naming conventions**: Environment prefix prevents conflicts

## Next Steps

- [Custom CRDs](./custom-crd.md) - Create reusable factory functions
- [Basic WebApp](./basic-webapp.md) - Start with simpler patterns
