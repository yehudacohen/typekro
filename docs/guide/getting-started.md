# Getting Started

This guide will help you install TypeKro and create your first type-safe Kubernetes infrastructure.

## Prerequisites

Before you begin, make sure you have:

- **Node.js 18+** or **Bun** installed
- **TypeScript 5.0+** in your project
- **kubectl** configured to access a Kubernetes cluster (for direct deployment)
- Basic familiarity with **Kubernetes** and **TypeScript**

::: tip KRO Mode Requirements
If you plan to use **KRO mode** for advanced orchestration with runtime dependencies, you can install the Kubernetes Resource Orchestrator (KRO) controller using TypeKro's bootstrap composition:

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

// Bootstrap TypeKro runtime with Flux and KRO
const bootstrap = typeKroRuntimeBootstrap({
  namespace: 'flux-system',
  fluxVersion: 'v2.4.0',
  kroVersion: '0.3.0'
});

const factory = await bootstrap.factory('direct', {
  namespace: 'flux-system',
  waitForReady: true,
  timeout: 300000
});

await factory.deploy({ namespace: 'flux-system' });
```

Alternatively, you can still use kubectl directly:
```bash
kubectl apply -f https://github.com/awslabs/kro/releases/latest/download/kro.yaml
```

**Direct mode** works without KRO and is perfect for getting started. Learn more about [KRO installation](https://kro.run/docs/getting-started/Installation/).
:::

## Installation

Install TypeKro using your preferred package manager:

::: code-group

```bash [bun]
bun add typekro
bun add -d @types/node
```

```bash [npm]
npm install typekro
npm install -D @types/node
```

```bash [yarn]
yarn add typekro
yarn add -D @types/node
```

```bash [pnpm]
pnpm add typekro
pnpm add -D @types/node
```

:::

## Your First Resource Graph

Let's create a simple web application with a database. Create a new file called `webapp.ts`:

```typescript
import { type } from 'arktype';
import { 
  toResourceGraph, 
  simpleDeployment, 
  simpleService,
  simpleConfigMap 
} from 'typekro';

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
  readyReplicas: 'number'
});

// Create your resource graph
export const webAppGraph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  // ResourceBuilder function
  (schema) => ({
    // Configuration
    config: simpleConfigMap({
      name: `${schema.spec.name}-config`,
      data: {
        LOG_LEVEL: schema.spec.environment === 'production' ? 'info' : 'debug',
        DATABASE_URL: 'postgresql://postgres:5432/webapp'
      }
    }),

    // Database
    database: simpleDeployment({
      name: `${schema.spec.name}-db`,
      image: 'postgres:15',
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'password'
      },
      ports: [{ containerPort: 5432 }]
    }),

    // Database service
    dbService: simpleService({
      name: `${schema.spec.name}-db-service`,
      selector: { app: `${schema.spec.name}-db` },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),

    // Web application
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      env: {
        NODE_ENV: schema.spec.environment,
        // Reference the database service
        DATABASE_HOST: `${dbService.metadata.name}.${dbService.metadata.namespace}.svc.cluster.local`
      },
      ports: [{ containerPort: 3000 }]
    }),

    // Web service
    webService: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'LoadBalancer'
    })
  }),
  // StatusBuilder function
  (schema, resources) => ({
    url: Cel.expr<string>(resources.webService.status.loadBalancer.ingress[0].ip, ' != "" ? "http://" + ', resources.webService.status.loadBalancer.ingress[0].ip, ' : "pending"'),
    phase: Cel.expr<'pending' | 'running' | 'ready'>(resources.app.status.readyReplicas, ' > 0 ? "ready" : "pending"'),
    readyReplicas: resources.app.status.readyReplicas
  })
);
```

## Bootstrap TypeKro Runtime (Optional)

If you want to use KRO mode or work with HelmRelease resources, you can bootstrap the complete TypeKro runtime environment using the built-in bootstrap composition:

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
  const factory = await bootstrap.factory('direct', {
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

## Deployment Options

TypeKro offers multiple deployment strategies. Choose the one that fits your workflow:

### Option 1: Direct Deployment

Deploy directly to your Kubernetes cluster for rapid development:

```typescript
// deploy.ts
import { webAppGraph } from './webapp.js';

async function deployApp() {
  // Create a direct deployment factory
  const factory = await webAppGraph.factory('direct', {
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

Run the deployment:

```bash
bun run deploy.ts
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

The generated YAML can be committed to Git and deployed via ArgoCD, Flux, or kubectl:

```bash
kubectl apply -f webapp-rgd.yaml
kubectl apply -f webapp-instance.yaml
```

### Option 3: Kro Integration

Use the Kro controller for advanced reconciliation:

```typescript
// kro-deploy.ts
import { webAppGraph } from './webapp.js';

async function deployWithKro() {
  const factory = await webAppGraph.factory('kro', {
    namespace: 'production'
  });

  await factory.deploy({
    name: 'production-webapp',
    image: 'myapp:v1.2.3',
    replicas: 5,
    environment: 'production'
  });

  console.log('Deployed with Kro controller!');
}

deployWithKro().catch(console.error);
```

## Verify Your Deployment

Check that your resources are running:

```bash
# Check pods
kubectl get pods -n development

# Check services
kubectl get services -n development

# Check your custom resource (if using Kro)
kubectl get webapp -n development
```

## IDE Integration

TypeKro provides excellent IDE support. Make sure your editor is configured for TypeScript:

### VS Code

Install the TypeScript extension and create a `.vscode/settings.json`:

```json
{
  "typescript.preferences.includePackageJsonAutoImports": "on",
  "typescript.suggest.autoImports": true,
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

### Type Checking

Add a type-check script to your `package.json`:

```json
{
  "scripts": {
    "type-check": "tsc --noEmit",
    "build": "tsc",
    "deploy": "bun run deploy.ts"
  }
}
```

## Next Steps

Now that you have TypeKro installed and working, explore these topics:

- **[Factory Functions](./factory-functions.md)** - Learn about the built-in resource factories
- **[Cross-Resource References](./cross-references.md)** - Connect resources dynamically
- **[CEL Expressions](./cel-expressions.md)** - Add runtime logic to your infrastructure
- **[Examples](../examples/)** - See real-world TypeKro applications

## Troubleshooting

### Common Issues

**TypeScript errors about missing types:**
```bash
# Make sure you have the latest TypeScript
bun add -d typescript@latest
```

**kubectl connection errors:**
```bash
# Verify your cluster connection
kubectl cluster-info
```

**Module resolution errors:**
```bash
# Ensure your tsconfig.json has proper module resolution
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true
  }
}
```

Need more help? Check our [Troubleshooting Guide](./troubleshooting.md) or [open an issue](https://github.com/yehudacohen/typekro/issues) on GitHub.