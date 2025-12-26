# Networking API

Factory functions for Kubernetes networking resources.

## Quick Reference

| Factory | Description | Key Status Field |
|---------|-------------|------------------|
| `Service()` | Expose applications | `status.clusterIP` |
| `Ingress()` | HTTP routing | `status.loadBalancer` |
| `NetworkPolicy()` | Pod network isolation | N/A |

## Service()

```typescript
import { Service } from 'typekro/simple';

const svc = Service({
  id: 'svc',
  name: 'my-app',
  selector: { app: 'my-app' },
  ports: [{ port: 80, targetPort: 8080 }],
  type: 'ClusterIP'  // or 'NodePort', 'LoadBalancer'
});

// Status reference
return { endpoint: svc.status.clusterIP };
```

### Service Types

- **ClusterIP**: Internal cluster access (default)
- **NodePort**: External access via node ports
- **LoadBalancer**: External access via cloud load balancer

## Ingress()

```typescript
import { Ingress } from 'typekro/simple';

const ingress = Ingress({
  id: 'ingress',
  name: 'my-app',
  host: 'app.example.com',
  serviceName: 'my-app',
  servicePort: 80,
  path: '/',
  ingressClassName: 'nginx',
  tls: true
});

// Status reference
return { url: `https://${ingress.status.loadBalancer.ingress[0].hostname}` };
```

## NetworkPolicy()

```typescript
import { NetworkPolicy } from 'typekro/simple';

const policy = NetworkPolicy({
  id: 'policy',
  name: 'allow-web',
  podSelector: { app: 'web' },
  ingress: [{
    from: [{ podSelector: { tier: 'frontend' } }],
    ports: [{ port: 80, protocol: 'TCP' }]
  }]
});
```

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service, Ingress } from 'typekro/simple';

const webapp = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string', host: 'string' }),
  status: type({ ready: 'boolean', url: 'string' })
}, (spec) => {
  const deploy = Deployment({
    id: 'deploy',
    name: spec.name,
    image: 'nginx',
    ports: [{ containerPort: 80 }]
  });

  const svc = Service({
    id: 'svc',
    name: spec.name,
    selector: { app: spec.name },
    ports: [{ port: 80, targetPort: 80 }]
  });

  Ingress({
    id: 'ingress',
    name: spec.name,
    host: spec.host,
    serviceName: spec.name,
    servicePort: 80
  });

  return {
    ready: deploy.status.readyReplicas > 0,
    url: `https://${spec.host}`
  };
});
```

## Next Steps

- [Workloads](./workloads.md) - Deployment, StatefulSet
- [Config](./config.md) - ConfigMap, Secret
