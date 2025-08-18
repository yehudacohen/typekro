# Simple Web Application

This example demonstrates the basics of TypeKro by creating a simple web application with a service. It's perfect for understanding core concepts like resource graphs, factory functions, and deployment strategies.

## What You'll Build

- A web application deployment running nginx
- A service to expose the application
- Type-safe configuration with environment variants

## Complete Example

```typescript
import { type } from 'arktype';
import { 
  toResourceGraph, 
  simpleDeployment, 
  simpleService 
} from 'typekro';

// Define the application interface
const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"'
});

const WebAppStatus = type({
  url: 'string',
  phase: 'string',
  readyReplicas: 'number'
});

// Create the resource graph
export const simpleWebApp = toResourceGraph(
  'simple-webapp',
  (schema) => ({
    // Web application deployment
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 80 }],
      
      // Environment-specific resource limits
      resources: schema.spec.environment === 'production' 
        ? { cpu: '500m', memory: '1Gi' }
        : { cpu: '100m', memory: '256Mi' }
    }),

    // Service to expose the application
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 80 }],
      
      // LoadBalancer in production, ClusterIP elsewhere
      type: schema.spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
    })
  }),
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
    statusMappings: {
      url: schema.spec.environment === 'production'
        ? `http://${service.status.loadBalancer.ingress[0].ip}`
        : `http://${service.spec.clusterIP}`,
      phase: deployment.status.phase,
      readyReplicas: deployment.status.readyReplicas
    }
  }
);
```

## Deployment Options

### Option 1: Direct Deployment

Perfect for development and testing:

```typescript
// deploy-direct.ts
import { simpleWebApp } from './simple-webapp.js';

async function deployDirect() {
  const factory = await simpleWebApp.factory('direct', {
    namespace: 'development'
  });

  const instance = await factory.deploy({
    name: 'my-webapp',
    image: 'nginx:latest',
    replicas: 2,
    environment: 'development'
  });

  console.log('✅ Deployed successfully!');
  
  // Check deployment status
  const status = await factory.getStatus();
  console.log('📊 Status:', status);
}

deployDirect().catch(console.error);
```

### Option 2: Generate YAML

For GitOps workflows:

```typescript
// generate-yaml.ts
import { writeFileSync } from 'fs';
import { simpleWebApp } from './simple-webapp.js';

// Generate ResourceGraphDefinition
const rgdYaml = simpleWebApp.toYaml();
writeFileSync('webapp-definition.yaml', rgdYaml);

// Generate production instance
const prodInstanceYaml = simpleWebApp.toYaml({
  name: 'production-webapp',
  image: 'nginx:1.24',
  replicas: 5,
  environment: 'production'
});
writeFileSync('webapp-production.yaml', prodInstanceYaml);

// Generate development instance
const devInstanceYaml = simpleWebApp.toYaml({
  name: 'dev-webapp',
  image: 'nginx:latest',
  replicas: 1,
  environment: 'development'
});
writeFileSync('webapp-development.yaml', devInstanceYaml);

console.log('📄 YAML files generated!');
```

Deploy with kubectl:

```bash
kubectl apply -f webapp-definition.yaml
kubectl apply -f webapp-production.yaml
```

## Key Concepts Demonstrated

### 1. Type-Safe Configuration

The `WebAppSpec` type ensures your configuration is valid:

```typescript
// ✅ This works
await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  environment: 'production'
});

// ❌ This causes a TypeScript error
await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: '3',  // Error: string not assignable to number
  environment: 'prod'  // Error: not a valid environment
});
```

### 2. Environment-Specific Configuration

Resources adapt based on the environment:

```typescript
// Production gets more resources
resources: schema.spec.environment === 'production' 
  ? { cpu: '500m', memory: '1Gi' }
  : { cpu: '100m', memory: '256Mi' }

// Production gets LoadBalancer, others get ClusterIP
type: schema.spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
```

### 3. Status Mapping

The status reflects the actual state of your deployment:

```typescript
statusMappings: {
  url: schema.spec.environment === 'production'
    ? `http://${service.status.loadBalancer.ingress[0].ip}`
    : `http://${service.spec.clusterIP}`,
  phase: deployment.status.phase,
  readyReplicas: deployment.status.readyReplicas
}
```

## Testing Your Deployment

### Verify Resources

```bash
# Check pods
kubectl get pods -l app=my-webapp

# Check service
kubectl get service my-webapp-service

# Check your custom resource (if using Kro)
kubectl get webapp my-webapp -o yaml
```

### Access Your Application

For development (ClusterIP):
```bash
kubectl port-forward service/my-webapp-service 8080:80
curl http://localhost:8080
```

For production (LoadBalancer):
```bash
kubectl get service my-webapp-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
curl http://<EXTERNAL-IP>
```

## Variations and Extensions

### Add Health Checks

```typescript
const deployment = simpleDeployment({
  name: schema.spec.name,
  image: schema.spec.image,
  replicas: schema.spec.replicas,
  ports: [{ containerPort: 80 }],
  
  // Add health checks
  livenessProbe: {
    httpGet: { path: '/', port: 80 },
    initialDelaySeconds: 30,
    periodSeconds: 10
  },
  readinessProbe: {
    httpGet: { path: '/', port: 80 },
    initialDelaySeconds: 5,
    periodSeconds: 5
  }
});
```

### Add ConfigMap

```typescript
import { simpleConfigMap } from 'typekro';

const resources = {
  config: simpleConfigMap({
    name: `${schema.spec.name}-config`,
    data: {
      'nginx.conf': `
        server {
          listen 80;
          location / {
            return 200 'Hello from ${schema.spec.name}!';
          }
        }
      `
    }
  }),
  
  deployment: simpleDeployment({
    name: schema.spec.name,
    image: schema.spec.image,
    volumeMounts: [{
      name: 'config',
      mountPath: '/etc/nginx/conf.d'
    }],
    volumes: [{
      name: 'config',
      configMap: { name: config.metadata.name }
    }]
  })
};
```

### Add Ingress

```typescript
import { simpleIngress } from 'typekro';

// Only in production
...(schema.spec.environment === 'production' && {
  ingress: simpleIngress({
    name: `${schema.spec.name}-ingress`,
    rules: [{
      host: `${schema.spec.name}.example.com`,
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
    }]
  })
})
```

## Next Steps

Now that you understand the basics, try these examples:

- **[Database Integration](./database.md)** - Add a PostgreSQL database
- **[Microservices](./microservices.md)** - Multiple interconnected services
- **[Multi-Environment](./multi-environment.md)** - Deploy across environments

Or explore advanced topics:

- **[Cross-Resource References](../guide/cross-references.md)** - Connect resources dynamically
- **[CEL Expressions](../guide/cel-expressions.md)** - Add runtime logic
- **[Custom Factory Functions](../guide/custom-factories.md)** - Build your own factories