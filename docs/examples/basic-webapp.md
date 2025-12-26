# Basic WebApp

Deployment + Service + Ingress in under 50 lines.

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service, Ingress } from 'typekro/simple';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  hostname: 'string'
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string'
});

export const webapp = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1alpha1',
  kind: 'WebApp',
  spec: WebAppSpec,
  status: WebAppStatus,
}, (spec) => {
  const deploy = Deployment({
    id: 'deploy',
    name: spec.name,
    image: spec.image,
    replicas: spec.replicas,
    ports: [{ containerPort: 3000 }]
  });

  Service({
    id: 'svc',
    name: `${spec.name}-svc`,
    selector: { app: spec.name },
    ports: [{ port: 80, targetPort: 3000 }]
  });

  Ingress({
    id: 'ing',
    name: `${spec.name}-ingress`,
    host: spec.hostname,
    serviceName: `${spec.name}-svc`,
    servicePort: 80
  });

  return {
    ready: deploy.status.readyReplicas >= spec.replicas,
    url: `https://${spec.hostname}`
  };
});
```

## Deploy

```typescript
const factory = webapp.factory('direct', { namespace: 'production' });
await factory.deploy({ 
  name: 'my-app', 
  image: 'nginx:latest', 
  replicas: 3, 
  hostname: 'app.example.com' 
});
```

## Key Concepts

- **Imperative composition**: Resources auto-register when created inside the composition function
- **Schema references**: `spec.name` becomes CEL at runtime
- **JavaScript expressions**: `deploy.status.readyReplicas >= spec.replicas` converts to CEL
- **Template literals**: `` `${spec.name}-svc` `` generates dynamic names
- **Resource IDs**: The `id` field enables cross-resource references in status

## Next Steps

- [Database Integration](./database-app.md) - Add cross-resource references
- [Helm Integration](./helm-integration.md) - Use existing Helm charts
