# Comprehensive Setup Guide

This guide covers advanced TypeKro setup, deployment options, and comprehensive examples for production use.

## Advanced Installation Options

### Development Environment Setup

Install TypeKro with development dependencies:

::: code-group

```bash [bun]
bun add typekro
bun add -d @types/node typescript@latest
```

```bash [npm]
npm install typekro
npm install -D @types/node typescript@latest
```

```bash [yarn]
yarn add typekro
yarn add -D @types/node typescript@latest
```

```bash [pnpm]
pnpm add typekro
pnpm add -D @types/node typescript@latest
```

:::

### TypeScript Configuration

Create a `tsconfig.json` for optimal TypeKro development:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Full-Stack Web Application Example

Create a realistic multi-service application with database and configuration:

```typescript
import { type } from 'arktype';
import { 
  kubernetesComposition,
  Cel
} from 'typekro';
import { 
  ConfigMap, 
  Deployment, 
  Service, 
  Ingress 
} from 'typekro/simple';

// Define your application's interface
const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"'
});

const WebAppStatus = type({
  url: 'string',
  phase: 'string',
  readyReplicas: 'number',
  databaseReady: 'boolean'
});

// Create your resource graph with imperative composition
export const webAppGraph = kubernetesComposition(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  (spec) => {
    // Configuration - auto-registers when created
    const config = ConfigMap({
      name: Cel.template('%s-config', spec.name),
      data: {
        LOG_LEVEL: spec.environment === 'production' ? 'info' : 'debug',
        DATABASE_URL: 'postgresql://postgres:5432/webapp'
      }
    });

    // Database - auto-registers when created
    const database = Deployment({
      name: Cel.template('%s-db', spec.name),
      image: 'postgres:15',
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'password'
      },
      ports: [{ containerPort: 5432 }]
    });

    // Database service - auto-registers when created
    const dbService = Service({
      name: Cel.template('%s-db-service', spec.name),
      selector: { app: Cel.template('%s-db', spec.name) },
      ports: [{ port: 5432, targetPort: 5432 }]
    });

    // Web application - auto-registers when created
    const app = Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      env: {
        NODE_ENV: spec.environment,
        // Reference the database service using CEL template
        DATABASE_HOST: Cel.template('%s.%s.svc.cluster.local', 
          dbService.metadata.name, 
          dbService.metadata.namespace
        )
      },
      ports: [{ containerPort: 3000 }]
    });

    // Web service - auto-registers when created
    const webService = Service({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'LoadBalancer'
    });

    // Return status with CEL expressions and resource references
    return {
      url: Cel.expr<string>(
        webService.status.loadBalancer.ingress,
        '.size() > 0 ? "http://" + ',
        webService.status.loadBalancer.ingress[0].ip,
        ' : "pending"'
      ),
      phase: Cel.expr<string>(app.status.readyReplicas, ' > 0 ? "ready" : "pending"'),
      readyReplicas: app.status.readyReplicas,
      databaseReady: Cel.expr<boolean>(database.status.readyReplicas, ' > 0')
    };
  }
);
```

## Advanced Patterns

### Environment-Specific Configuration

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const config = spec.environment === 'production' 
    ? { replicas: 5, resources: { cpu: '500m', memory: '1Gi' } }
    : { replicas: 1, resources: { cpu: '100m', memory: '256Mi' } };

  const deployment = Deployment({
    name: spec.name,
    image: spec.image,
    replicas: config.replicas,
    resources: config.resources
  });

  return {
    ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0')
  };
});
```

### Cross-Resource References

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const database = Deployment({
    name: 'db',
    image: 'postgres:15'
  });

  const dbService = Service({
    name: 'db-service',
    selector: { app: 'db' },
    ports: [{ port: 5432 }]
  });

  const app = Deployment({ 
    name: spec.name, 
    image: spec.image 
  });
  
  // Only create ingress in production
  const ingress = spec.environment === 'production'
    ? Ingress({
        name: Cel.template('%s-ingress', spec.name),
        host: Cel.template('%s.example.com', spec.name),
        serviceName: Cel.template('%s-service', spec.name)
      })
    : null;

  return {
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    hasIngress: spec.environment === 'production'
  };
});
```

## Bootstrap TypeKro Runtime (Optional)

For advanced orchestration with KRO mode and HelmRelease resources:

```typescript
// bootstrap.ts
import { typeKroRuntimeBootstrap } from 'typekro';

async function setupTypeKroRuntime() {
  // Create the bootstrap composition
  const bootstrap = typeKroRuntimeBootstrap({
    namespace: 'flux-system',      // Namespace for Flux controllers
    fluxVersion: 'v2.4.0',         // Flux CD version
    kroVersion: '0.3.0'            // KRO version
  });

  // Deploy using direct mode
  const factory = bootstrap.factory('direct', {
    namespace: 'flux-system',
    waitForReady: true,            // Wait for all components to be ready
    timeout: 300000               // 5 minute timeout
  });

  console.log('Bootstrapping TypeKro runtime...');
  const result = await factory.deploy({
    namespace: 'flux-system'
  });

  console.log('Bootstrap complete!', result.status);
}

setupTypeKroRuntime().catch(console.error);
```

This bootstrap process:
1. **Creates namespaces**: `flux-system` and `kro` 
2. **Installs Flux CD**: Controllers for GitOps and Helm management
3. **Installs KRO**: Via HelmRelease for advanced orchestration
4. **Waits for readiness**: Ensures all components are operational

## Deployment Strategies

### Option 1: Direct Deployment

Deploy directly to your Kubernetes cluster for rapid development:

```typescript
// deploy.ts
import { webAppGraph } from './webapp.js';

async function deployApp() {
  // Create a direct deployment factory
  const factory = webAppGraph.factory('direct', {
    namespace: 'development'
  });

  // Deploy your application
  const instance = await factory.deploy({
    name: 'my-webapp',
    image: 'nginx:latest',
    replicas: 2,
    environment: 'development'
  });

  console.log('Deployed successfully!');
  console.log('Status:', await factory.getStatus());
}

deployApp().catch(console.error);
```

### Option 2: Generate GitOps YAML

Generate YAML files for your GitOps workflow:

```typescript
// generate-yaml.ts
import { writeFileSync } from 'fs';
import { webAppGraph } from './webapp.js';

// Generate ResourceGraphDefinition YAML
const rgdYaml = webAppGraph.toYaml();
writeFileSync('webapp-rgd.yaml', rgdYaml);

// Generate instance YAML
const instanceYaml = webAppGraph.toYaml({
  name: 'my-webapp',
  image: 'nginx:latest',
  replicas: 3,
  environment: 'production'
});
writeFileSync('webapp-instance.yaml', instanceYaml);

console.log('YAML files generated!');
```

Deploy with kubectl or GitOps tools:

```bash
kubectl apply -f webapp-rgd.yaml
kubectl apply -f webapp-instance.yaml
```

### Option 3: KRO Integration

Use the KRO controller for advanced reconciliation:

```typescript
// kro-deploy.ts
import { webAppGraph } from './webapp.js';

async function deployWithKro() {
  const factory = webAppGraph.factory('kro', {
    namespace: 'production'
  });

  await factory.deploy({
    name: 'production-webapp',
    image: 'myapp:v1.2.3',
    replicas: 5,
    environment: 'production'
  });

  console.log('Deployed with KRO controller!');
}

deployWithKro().catch(console.error);
```

## IDE Configuration

### VS Code Setup

Install the TypeScript extension and create `.vscode/settings.json`:

```json
{
  "typescript.preferences.includePackageJsonAutoImports": "on",
  "typescript.suggest.autoImports": true,
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

### Package.json Scripts

Add helpful scripts to your `package.json`:

```json
{
  "scripts": {
    "type-check": "tsc --noEmit",
    "build": "tsc",
    "dev": "bun run --watch deploy.ts",
    "deploy": "bun run deploy.ts",
    "generate": "bun run generate-yaml.ts"
  }
}
```

## Verification and Monitoring

### Basic Verification

```bash
# Check pods
kubectl get pods -n development

# Check services
kubectl get services -n development

# Check your custom resource (if using KRO)
kubectl get webapp -n development

# Get detailed status
kubectl describe webapp my-webapp -n development
```

### Advanced Monitoring

```bash
# Watch for changes
kubectl get pods -w

# Stream logs
kubectl logs -f deployment/my-webapp

# Check events
kubectl get events --sort-by=.metadata.creationTimestamp
```

## Troubleshooting

### Common Issues

**TypeScript compilation errors:**
```bash
# Ensure TypeScript version compatibility
bun add -d typescript@latest

# Check your tsconfig.json module resolution
```

**kubectl connection issues:**
```bash
# Verify cluster connectivity
kubectl cluster-info

# Check current context
kubectl config current-context
```

**Resource deployment failures:**
```bash
# Check resource events
kubectl get events

# Examine pod logs
kubectl logs deployment/my-app

# Check resource status
kubectl describe deployment my-app
```

**Module resolution errors:**
Make sure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true
  }
}
```

## What's Next?

Now that you have a comprehensive setup, explore these advanced topics:

- **[Factory Functions](./factories.md)** - Master TypeKro's building blocks
- **[Magic Proxy System](./magic-proxy.md)** - TypeKro's unique architecture
- **[External References](./external-references.md)** - Cross-composition coordination
- **[Advanced Architecture](./architecture.md)** - Deep technical understanding

Need more help? Check our [Troubleshooting Guide](./troubleshooting.md) or [open an issue](https://github.com/yehudacohen/typekro/issues) on GitHub.