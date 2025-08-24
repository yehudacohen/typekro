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
  kubernetesComposition, 
  simpleDeployment, 
  simpleService,
  Cel
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
  phase: '"pending" | "running" | "failed"',
  readyReplicas: 'number'
});

// Create the resource graph with imperative composition
export const simpleWebApp = kubernetesComposition(
  {
    name: 'simple-webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  (spec) => {
    // Resources auto-register when created - no explicit builders needed!
    const deployment = simpleDeployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      ports: [{ containerPort: 80 }],
      
      // Environment-specific resource limits
      resources: spec.environment === 'production' 
        ? { cpu: '500m', memory: '1Gi' }
        : { cpu: '100m', memory: '256Mi' }
    });

    const service = simpleService({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }],
      
      // LoadBalancer in production, ClusterIP elsewhere
      type: spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
    });

    // Return status with CEL expressions and resource references
    return {
      url: spec.environment === 'production'
        ? Cel.expr<string>(
            service.status.loadBalancer.ingress, '.size() > 0 ? "http://" + ',
            service.status.loadBalancer.ingress[0].ip, ' : "pending"'
          )
        : Cel.template('http://%s', service.status.clusterIP),
      phase: Cel.expr<'pending' | 'running' | 'failed'>(
        deployment.status.readyReplicas, ' == ', deployment.spec.replicas, ' ? "running" : "pending"'
      ),
      readyReplicas: deployment.status.readyReplicas
    };
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
  const factory = simpleWebApp.factory('direct', {
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
  const status = await factory.getStatus(instance);
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

// Generate ResourceGraphDefinition for Kro
const rgdYaml = simpleWebApp.toYaml();
writeFileSync('webapp-definition.yaml', rgdYaml);

// Generate production instance
const prodInstanceYaml = simpleWebApp.toYaml({
  metadata: { name: 'production-webapp', namespace: 'production' },
  spec: {
    name: 'production-webapp',
    image: 'nginx:1.24',
    replicas: 5,
    environment: 'production'
  }
});
writeFileSync('webapp-production.yaml', prodInstanceYaml);

// Generate development instance
const devInstanceYaml = simpleWebApp.toYaml({
  metadata: { name: 'dev-webapp', namespace: 'development' },
  spec: {
    name: 'dev-webapp',
    image: 'nginx:latest',
    replicas: 1,
    environment: 'development'
  }
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
const instance = await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  environment: 'production'
});

// ❌ This causes a TypeScript error
const invalidInstance = await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: '3',  // Error: string not assignable to number
  environment: 'prod'  // Error: not a valid environment
});
```

### 2. Environment-Specific Configuration

Resources adapt based on the environment using natural JavaScript conditionals:

```typescript
// Production gets more resources
resources: spec.environment === 'production' 
  ? { cpu: '500m', memory: '1Gi' }
  : { cpu: '100m', memory: '256Mi' }

// Production gets LoadBalancer, others get ClusterIP
type: spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
```

### 3. Status Builder

The status builder uses CEL expressions to reflect the actual state of your deployment:

```typescript
// StatusBuilder function - maps resource status to your custom status
(schema, resources) => ({
  url: schema.spec.environment === 'production'
    ? Cel.expr<string>(resources.service.status.loadBalancer.ingress[0].ip, ' != "" ? "http://" + ', resources.service.status.loadBalancer.ingress[0].ip, ' : "pending"')
    : Cel.template('http://%s', resources.service.spec.clusterIP),
  phase: Cel.expr<'pending' | 'running' | 'failed'>(resources.deployment.status.readyReplicas, ' == ', resources.deployment.spec.replicas, ' ? "running" : "pending"'),
  readyReplicas: resources.deployment.status.readyReplicas
})
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

const composition = kubernetesComposition(definition, (spec) => {
  const config = simpleConfigMap({
    name: Cel.template('%s-config', spec.name),
    data: {
      'nginx.conf': Cel.template(`
        server {
          listen 80;
          location / {
            return 200 'Hello from %s!';
          }
        }
      `, spec.name)
    }
  });
  
  const deployment = simpleDeployment({
    name: spec.name,
    image: spec.image,
    volumeMounts: [{
      name: 'config',
      mountPath: '/etc/nginx/conf.d'
    }],
    volumes: [{
      name: 'config',
      configMap: { name: config.metadata.name }
    }]
  });

  return {
    ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
    configName: config.metadata.name
  };
});
```

### Add Ingress

```typescript
import { simpleIngress } from 'typekro';

const composition = kubernetesComposition(definition, (spec) => {
  const deployment = simpleDeployment({ name: spec.name, image: spec.image });
  const service = simpleService({ name: Cel.template('%s-service', spec.name), selector: { app: spec.name } });
  
  // Only create ingress in production
  const ingress = spec.environment === 'production' 
    ? simpleIngress({
        name: Cel.template('%s-ingress', spec.name),
        rules: [{
          host: Cel.template('%s.example.com', spec.name),
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
    : null;

  return {
    ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
    hasIngress: spec.environment === 'production'
  };
});
```

## Advanced Pattern: Composition of Compositions

One powerful feature of imperative composition is the ability to nest and combine compositions:

```typescript
// Database composition
const database = kubernetesComposition(
  {
    name: 'database',
    apiVersion: 'example.com/v1alpha1',
    kind: 'Database',
    spec: type({ name: 'string', image: 'string' }),
    status: type({ ready: 'boolean', host: 'string' })
  },
  (spec) => {
    const postgres = simpleDeployment({
      name: spec.name,
      image: spec.image,
      ports: [{ containerPort: 5432 }]
    });

    const service = simpleService({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 5432, targetPort: 5432 }]
    });

    return {
      ready: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0'),
      host: service.status.clusterIP
    };
  }
);

// Full-stack composition that uses the database
const fullStack = kubernetesComposition(
  {
    name: 'fullstack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStack',
    spec: type({ 
      appName: 'string', 
      appImage: 'string', 
      dbImage: 'string' 
    }),
    status: type({ 
      ready: 'boolean', 
      appReady: 'boolean', 
      dbReady: 'boolean' 
    })
  },
  (spec) => {
    // Use the database composition - resources are automatically merged
    const db = database.withSpec({
      name: Cel.template('%s-db', spec.appName),
      image: spec.dbImage
    });

    // Create the app that depends on the database
    const app = simpleDeployment({
      name: spec.appName,
      image: spec.appImage,
      env: {
        DATABASE_HOST: db.status.host  // Reference the database status
      }
    });

    return {
      ready: Cel.expr<boolean>(db.status.ready, ' && ', app.status.readyReplicas, ' > 0'),
      appReady: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
      dbReady: db.status.ready
    };
  }
);
```

This demonstrates how compositions can be nested and combined, with resources and status automatically merged across composition boundaries.

## Next Steps

Now that you understand the basics, try these examples:

- **[Database Integration](./database.md)** - Add a PostgreSQL database
- **[Microservices](./microservices.md)** - Multiple interconnected services
- **[Multi-Environment](./multi-environment.md)** - Deploy across environments

Or explore advanced topics:

- **[Imperative Composition Guide](../guide/imperative-composition.md)** - Deep dive into composition patterns
- **[Cross-Resource References](../guide/cross-references.md)** - Connect resources dynamically
- **[CEL Expressions](../guide/cel-expressions.md)** - Add runtime logic
- **[Custom Factory Functions](../guide/custom-factories.md)** - Build your own factories