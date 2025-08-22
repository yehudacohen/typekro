# GitOps Workflows

GitOps is a operational framework that uses Git as the single source of truth for declarative infrastructure and applications. TypeKro generates GitOps-ready YAML that works seamlessly with ArgoCD, Flux, and other GitOps tools.

## GitOps with TypeKro

TypeKro enables GitOps by:

- **Generating deterministic YAML** - Same input always produces identical output
- **Supporting KRO ResourceGraphDefinitions** - Advanced orchestration via GitOps
- **Enabling environment promotion** - Consistent deployments across environments
- **Providing type-safe configuration** - Catch errors before deployment

```typescript
// TypeScript source (checked into Git)
const webApp = toResourceGraph(/* ... */);

// Generated YAML (automatically created)
const yaml = webApp.toYaml(productionConfig);

// GitOps controller deploys to cluster
```

## Basic GitOps Setup

### Prerequisites: GitOps Controller

Before setting up TypeKro GitOps workflows, you need a GitOps controller in your cluster. TypeKro works with any GitOps tool, but provides native bootstrap support for Flux CD:

#### Option 1: Bootstrap with TypeKro (Recommended for Flux CD)

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

async function setupFluxGitOps() {
  const bootstrap = typeKroRuntimeBootstrap({
    namespace: 'flux-system',
    fluxVersion: 'v2.4.0',
    kroVersion: '0.3.0'
  });

  const factory = bootstrap.factory('direct', {
    namespace: 'flux-system',
    waitForReady: true
  });

  await factory.deploy({ namespace: 'flux-system' });
  console.log('Flux CD ready for GitOps!');
}
```

#### Option 2: Manual Installation

```bash
# Flux CD
flux install

# ArgoCD  
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

### Repository Structure

```
my-app/
├── src/                    # TypeScript source
│   ├── graphs/
│   │   ├── webapp.ts
│   │   └── database.ts
│   └── configs/
│       ├── development.ts
│       ├── staging.ts
│       └── production.ts
├── deploy/                 # Generated YAML
│   ├── definitions/        # ResourceGraphDefinitions
│   │   ├── webapp-rgd.yaml
│   │   └── database-rgd.yaml
│   └── instances/          # Environment instances
│       ├── development/
│       ├── staging/
│       └── production/
├── scripts/
│   └── generate-yaml.ts    # YAML generation script
└── .github/
    └── workflows/
        └── deploy.yml      # CI/CD workflow
```

### YAML Generation Script

```typescript
// scripts/generate-yaml.ts
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { webAppGraph } from '../src/graphs/webapp.js';
import { databaseGraph } from '../src/graphs/database.js';
import * as configs from '../src/configs/index.js';

const graphs = { webAppGraph, databaseGraph };
const environments = ['development', 'staging', 'production'];

async function generateYaml() {
  // Create directories
  mkdirSync('deploy/definitions', { recursive: true });
  environments.forEach(env => {
    mkdirSync(Cel.template("deploy/instances/%s", env), { recursive: true });
  });

  // Generate ResourceGraphDefinitions
  Object.entries(graphs).forEach(([name, graph]) => {
    const rgdYaml = graph.toYaml();
    writeFileSync(Cel.template("deploy/definitions/%s-rgd.yaml", name), rgdYaml);
    console.log(Cel.template("Generated %s ResourceGraphDefinition", name));
  });

  // Generate environment instances
  environments.forEach(env => {
    const config = configs[env];
    
    Object.entries(graphs).forEach(([name, graph]) => {
      const instanceYaml = graph.toYaml(config[name]);
      writeFileSync(Cel.template("deploy/instances/%s/%s.yaml", env, name), instanceYaml);
      console.log(Cel.template("Generated %s instance for %s", name, env));
    });
  });

  console.log('✅ All YAML files generated');
}

generateYaml().catch(console.error);
```

### Environment Configurations

```typescript
// src/configs/production.ts
export const production = {
  webAppGraph: {
    name: 'webapp-prod',
    image: 'myapp:v1.2.0',
    replicas: 5,
    environment: 'production',
    domain: 'example.com'
  },
  
  databaseGraph: {
    name: 'database-prod',
    size: '100Gi',
    storageClass: 'fast-ssd',
    backupEnabled: true
  }
};

// src/configs/staging.ts
export const staging = {
  webAppGraph: {
    name: 'webapp-staging',
    image: 'myapp:v1.2.0-rc1',
    replicas: 2,
    environment: 'staging',
    domain: 'staging.example.com'
  },
  
  databaseGraph: {
    name: 'database-staging',
    size: '20Gi',
    storageClass: 'standard',
    backupEnabled: false
  }
};
```

## CI/CD Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/deploy.yml
name: Deploy Application

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  generate-yaml:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        
      - name: Install dependencies
        run: bun install
        
      - name: Type check
        run: bun run typecheck
        
      - name: Generate YAML
        run: bun run generate-yaml
        
      - name: Validate YAML
        run: |
          for file in deploy/**/*.yaml; do
            kubectl apply --dry-run=client -f "$file"
          done
          
      - name: Commit generated YAML
        if: github.ref == 'refs/heads/main'
        run: |
          git config --local user.email "action@github.com"
          git config --local user.name "GitHub Action"
          git add deploy/
          git diff --staged --quiet || git commit -m "Update generated YAML [skip ci]"
          git push

  deploy-staging:
    needs: generate-yaml
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup kubectl
        uses: azure/setup-kubectl@v3
        
      - name: Deploy to staging
        run: |
          kubectl apply -f deploy/definitions/
          kubectl apply -f deploy/instances/staging/
          
      - name: Wait for deployment
        run: |
          kubectl wait --for=condition=ready webapp/webapp-staging --timeout=300s

  deploy-production:
    needs: generate-yaml
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup kubectl
        uses: azure/setup-kubectl@v3
        
      - name: Deploy to production
        run: |
          kubectl apply -f deploy/definitions/
          kubectl apply -f deploy/instances/production/
          
      - name: Wait for deployment
        run: |
          kubectl wait --for=condition=ready webapp/webapp-prod --timeout=600s
```

### GitLab CI Pipeline

```yaml
# .gitlab-ci.yml
stages:
  - validate
  - generate
  - deploy

variables:
  KUBECONFIG: /tmp/kubeconfig

validate:
  stage: validate
  image: node:18
  script:
    - npm install -g bun
    - bun install
    - bun run typecheck
    - bun run lint
  
generate-yaml:
  stage: generate
  image: node:18
  script:
    - npm install -g bun
    - bun install
    - bun run generate-yaml
    - kubectl apply --dry-run=client -f deploy/
  artifacts:
    paths:
      - deploy/
    expire_in: 1 hour

deploy-staging:
  stage: deploy
  image: bitnami/kubectl:latest
  dependencies:
    - generate-yaml
  script:
    - echo "$KUBE_CONFIG" | base64 -d > $KUBECONFIG
    - kubectl apply -f deploy/definitions/
    - kubectl apply -f deploy/instances/staging/
    - kubectl wait --for=condition=ready webapp/webapp-staging --timeout=300s
  environment:
    name: staging
    url: https://webapp-staging.example.com
  only:
    - develop

deploy-production:
  stage: deploy
  image: bitnami/kubectl:latest
  dependencies:
    - generate-yaml
  script:
    - echo "$KUBE_CONFIG" | base64 -d > $KUBECONFIG
    - kubectl apply -f deploy/definitions/
    - kubectl apply -f deploy/instances/production/
    - kubectl wait --for=condition=ready webapp/webapp-prod --timeout=600s
  environment:
    name: production
    url: https://webapp.example.com
  when: manual
  only:
    - main
```

## Helm Integration with GitOps

TypeKro supports Helm chart deployment through Flux CD's HelmRelease resources, enabling type-safe Helm values with schema references.

### HelmRelease with TypeKro

```typescript
import { type } from 'arktype';
import { toResourceGraph, helmRelease, helmRepository, Cel } from 'typekro';

const HelmAppSpec = type({
  name: 'string',
  replicas: 'number',
  domain: 'string',
  environment: '"development" | "staging" | "production"'
});

const helmApp = toResourceGraph(
  {
    name: 'helm-webapp',
    apiVersion: 'helm.example.com/v1',
    kind: 'HelmWebApp',
    spec: HelmAppSpec,
    status: type({ ready: 'boolean', url: 'string' })
  },
  (schema) => {
    // Create Helm repository first
    const repository = helmRepository({
      name: 'bitnami',
      url: 'https://charts.bitnami.com/bitnami',
      interval: '10m'
    });
    
    // Create HelmRelease using simple factory
    const nginx = simpleHelmChart(
      schema.spec.name,
      repository.spec.url,  // Reference repository URL by field  
      'nginx',
      {
        // Type-safe values with schema references
        replicaCount: schema.spec.replicas,
        image: {
          tag: Cel.conditional(
            schema.spec.environment === 'production',
            '1.21-alpine',
            'latest'
          )
        },
        service: {
          type: 'ClusterIP'
        },
        ingress: {
          enabled: true,
          hostname: schema.spec.domain,
          tls: schema.spec.environment === 'production'
        }
      }
    );

    return { repository, nginx };
  },
  (schema, resources) => ({
    ready: Cel.expr(resources.nginx.status.conditions, '[?@.type=="Ready"].status == "True"'),
    url: Cel.template('https://%s', schema.spec.domain)
  })
);

// Generate GitOps-ready YAML
const factory = helmApp.factory('kro', { namespace: 'flux-system' });
const yaml = factory.toYaml();
writeFileSync('deploy/helm-webapp.yaml', yaml);
```

### Multi-Chart Application

```typescript
const microservicesApp = toResourceGraph(
  {
    name: 'microservices',
    apiVersion: 'platform.example.com/v1',
    kind: 'MicroservicesApp',
    spec: type({
      name: 'string',
      environment: 'string',
      monitoring: 'boolean'
    }),
    status: type({ ready: 'boolean' })
  },
  (schema) => {
    // Create repositories first
    const bitnamiRepo = helmRepository({
      name: 'bitnami',
      url: 'https://charts.bitnami.com/bitnami',
      interval: '10m'
    });
    
    // Create database using simple factory
    const postgres = simpleHelmChart(
      Cel.template('%s-postgres', schema.spec.name),
      bitnamiRepo.spec.url,  // Reference repository URL by field
      'postgresql',
      {
        auth: {
          database: schema.spec.name,
          username: 'app'
        },
        primary: {
          persistence: {
            size: Cel.conditional(
              schema.spec.environment === 'production',
              '50Gi',
              '10Gi'
            )
          }
        }
      }
    );
    
    // Create redis cache using simple factory
    const redis = simpleHelmChart(
      Cel.template('%s-redis', schema.spec.name),
      bitnamiRepo.spec.url,  // Reference repository URL by field
      'redis',
      {
        auth: { enabled: false },
        replica: {
          replicaCount: Cel.conditional(
            schema.spec.environment === 'production',
            3,
            1
          )
        }
      }
    );
    
    const result = { bitnamiRepo, postgres, redis };
    
    // Add monitoring if enabled
    if (schema.spec.monitoring) {
      const prometheusRepo = helmRepository({
        name: 'prometheus-community',
        url: 'https://prometheus-community.github.io/helm-charts',
        interval: '10m'
      });
      
      const prometheus = simpleHelmChart(
        'prometheus',
        prometheusRepo.spec.url,  // Reference repository URL by field
        'kube-prometheus-stack',
        {
          prometheus: {
            prometheusSpec: {
              retention: '30d'
            }
          }
        }
      );
      
      return { ...result, prometheusRepo, prometheus };
    }
    
    return result;
  },
  (schema, resources) => ({
    ready: Cel.expr(
      resources.postgres.status.conditions, '[?@.type=="Ready"].status == "True" && ',
      resources.redis.status.conditions, '[?@.type=="Ready"].status == "True"'
    )
  })
);
```

### Flux CD Deployment Structure

```
k8s/
├── infrastructure/
│   ├── sources/
│   │   ├── bitnami-repository.yaml
│   │   └── prometheus-repository.yaml
│   └── helm-releases/
│       ├── postgres-release.yaml
│       ├── redis-release.yaml
│       └── monitoring-release.yaml
├── applications/
│   └── microservices-rgd.yaml
└── instances/
    ├── development/
    ├── staging/
    └── production/
```

## ArgoCD Integration

### Application Configuration

```yaml
# argocd/webapp-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: webapp
  namespace: argocd
spec:
  project: default
  
  source:
    repoURL: https://github.com/myorg/myapp
    targetRevision: HEAD
    path: deploy/instances/production
    
  destination:
    server: https://kubernetes.default.svc
    namespace: production
    
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas  # Allow HPA to manage replicas
```

### App of Apps Pattern

```yaml
# argocd/app-of-apps.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp-apps
  namespace: argocd
spec:
  project: default
  
  source:
    repoURL: https://github.com/myorg/myapp
    targetRevision: HEAD
    path: argocd/apps
    
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
    
  syncPolicy:
    automated:
      prune: true
      selfHeal: true

---
# argocd/apps/webapp.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: webapp-production
spec:
  project: default
  source:
    repoURL: https://github.com/myorg/myapp
    targetRevision: HEAD
    path: deploy/instances/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true

---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: webapp-staging
spec:
  project: default
  source:
    repoURL: https://github.com/myorg/myapp
    targetRevision: HEAD
    path: deploy/instances/staging
  destination:
    server: https://kubernetes.default.svc
    namespace: staging
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Flux CD Integration

### Flux Repository Structure

```
flux-config/
├── clusters/
│   ├── production/
│   │   └── webapp-kustomization.yaml
│   └── staging/
│       └── webapp-kustomization.yaml
├── sources/
│   └── webapp-source.yaml
└── kustomizations/
    ├── webapp-production.yaml
    └── webapp-staging.yaml
```

### Flux Source Configuration

```yaml
# flux-config/sources/webapp-source.yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: GitRepository
metadata:
  name: webapp
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/myorg/myapp
  ref:
    branch: main
  secretRef:
    name: webapp-git-auth
```

### Flux Kustomization

```yaml
# flux-config/kustomizations/webapp-production.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1beta2
kind: Kustomization
metadata:
  name: webapp-production
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: webapp
  path: "./deploy/instances/production"
  prune: true
  wait: true
  timeout: 10m
  targetNamespace: production
  
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: webapp-prod
      namespace: production
      
  dependsOn:
    - name: webapp-definitions
```

### Environment-Specific Overlays

```yaml
# deploy/instances/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../definitions/webapp-rgd.yaml
  - webapp.yaml

patchesStrategicMerge:
  - patches/production-patches.yaml

images:
  - name: myapp
    newTag: v1.2.0
```

## Multi-Environment Promotion

### Environment Promotion Workflow

```typescript
// scripts/promote.ts
import { readFileSync, writeFileSync } from 'fs';
import { load, dump } from 'js-yaml';

interface PromotionConfig {
  sourceEnv: string;
  targetEnv: string;
  imageTag?: string;
  configOverrides?: Record<string, any>;
}

async function promoteEnvironment(config: PromotionConfig) {
  const { sourceEnv, targetEnv, imageTag, configOverrides } = config;
  
  console.log(Cel.template("Promoting from %s to %s", sourceEnv, targetEnv));
  
  // Read source environment configuration
  const sourceConfig = JSON.parse(
    readFileSync(Cel.template("src/configs/%s.json", sourceEnv), 'utf8')
  );
  
  // Create target configuration
  const targetConfig = {
    ...sourceConfig,
    ...configOverrides,
    ...(imageTag && { image: imageTag })
  };
  
  // Generate YAML for target environment
  const yaml = webAppGraph.toYaml(targetConfig);
  writeFileSync(Cel.template("deploy/instances/%s/webapp.yaml", targetEnv), yaml);
  
  console.log(Cel.template("✅ Promoted to %s", targetEnv));
  
  // Optional: Create pull request
  if (process.env.CREATE_PR === 'true') {
    await createPromotionPR(sourceEnv, targetEnv, imageTag);
  }
}

// Usage
promoteEnvironment({
  sourceEnv: 'staging',
  targetEnv: 'production',
  imageTag: 'v1.2.0',
  configOverrides: {
    replicas: 5,
    resources: {
      cpu: '1000m',
      memory: '2Gi'
    }
  }
});
```

### Automated Promotion Pipeline

```yaml
# .github/workflows/promote.yml
name: Promote Environment

on:
  workflow_dispatch:
    inputs:
      source_env:
        description: 'Source environment'
        required: true
        default: 'staging'
        type: choice
        options:
          - staging
          - production
      target_env:
        description: 'Target environment'
        required: true
        default: 'production'
        type: choice
        options:
          - staging
          - production
      image_tag:
        description: 'Image tag to promote'
        required: true
        type: string

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          
      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        
      - name: Install dependencies
        run: bun install
        
      - name: Promote environment
        run: |
          bun run promote \
            --source=${{ github.event.inputs.source_env }} \
            --target=${{ github.event.inputs.target_env }} \
            --image-tag=${{ github.event.inputs.image_tag }}
            
      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v5
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          commit-message: |
            Promote ${{ github.event.inputs.source_env }} to ${{ github.event.inputs.target_env }}
            
            Image: ${{ github.event.inputs.image_tag }}
          title: 'Promote to ${{ github.event.inputs.target_env }}'
          body: |
            ## Environment Promotion
            
            - **Source**: ${{ github.event.inputs.source_env }}
            - **Target**: ${{ github.event.inputs.target_env }}
            - **Image**: ${{ github.event.inputs.image_tag }}
            
            This PR promotes the configuration from ${{ github.event.inputs.source_env }} to ${{ github.event.inputs.target_env }}.
          branch: promote-${{ github.event.inputs.target_env }}-${{ github.run_id }}
```

## Configuration Management

### Environment-Specific Values

```typescript
// src/configs/base.ts
export const baseConfig = {
  image: 'myapp:latest',
  ports: [{ containerPort: 3000 }],
  env: {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info'
  }
};

// src/configs/environments.ts
import { baseConfig } from './base.js';

export const environments = {
  development: {
    ...baseConfig,
    replicas: 1,
    resources: {
      cpu: '100m',
      memory: '256Mi'
    },
    env: {
      ...baseConfig.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug'
    }
  },
  
  staging: {
    ...baseConfig,
    replicas: 2,
    resources: {
      cpu: '200m',
      memory: '512Mi'
    },
    env: {
      ...baseConfig.env,
      NODE_ENV: 'staging'
    }
  },
  
  production: {
    ...baseConfig,
    replicas: 5,
    resources: {
      cpu: '500m',
      memory: '1Gi'
    },
    env: {
      ...baseConfig.env,
      NODE_ENV: 'production'
    }
  }
};
```

### Secret Management

```typescript
// External Secrets Operator integration
const externalSecret = {
  apiVersion: 'external-secrets.io/v1beta1',
  kind: 'ExternalSecret',
  metadata: {
    name: 'app-secrets',
    namespace: 'production'
  },
  spec: {
    refreshInterval: '1h',
    secretStoreRef: {
      name: 'vault-backend',
      kind: 'SecretStore'
    },
    target: {
      name: 'app-secrets',
      creationPolicy: 'Owner'
    },
    data: [
      {
        secretKey: 'database-password',
        remoteRef: {
          key: 'secret/database',
          property: 'password'
        }
      },
      {
        secretKey: 'api-key',
        remoteRef: {
          key: 'secret/external-api',
          property: 'key'
        }
      }
    ]
  }
};

// Use in TypeKro graph
const secureApp = toResourceGraph(
  definition,
  (schema) => ({
    externalSecret,  // Include external secret
    
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      
      envFrom: [{
        secretRef: { name: 'app-secrets' }
      }]
    })
  }),
  statusBuilder
);
```

## Monitoring GitOps Deployments

### Deployment Status Tracking

```typescript
// scripts/check-deployment.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function checkDeploymentStatus(environment: string, timeout = 300) {
  console.log(Cel.template("Checking deployment status for %s", environment));
  
  try {
    // Check if resources are deployed
    const { stdout } = await execAsync(
      Cel.template("kubectl get webapp webapp-%s -o jsonpath", environment)='{.status.phase}'`
    );
    
    if (stdout.trim() === 'Running') {
      console.log(Cel.template("✅ %s deployment is running", environment));
      return true;
    }
    
    // Wait for deployment to be ready
    await execAsync(
      Cel.template("kubectl wait --for=condition=ready webapp/webapp-%s --timeout=%ds", environment, timeout)
    );
    
    console.log(Cel.template("✅ %s deployment is ready", environment));
    return true;
    
  } catch (error) {
    console.error(Cel.template("❌ %s deployment failed:", environment), error.message);
    
    // Get more details
    try {
      const { stdout: events } = await execAsync(
        Cel.template("kubectl get events --field-selector involvedObject.name=webapp-%s --sort-by=", environment).metadata.creationTimestamp`
      );
      console.log('Recent events:', events);
    } catch (eventError) {
      console.error('Could not fetch events:', eventError.message);
    }
    
    return false;
  }
}
```

### Health Monitoring

```typescript
// scripts/health-check.ts
async function performHealthCheck(environment: string) {
  const checks = [
    {
      name: 'Deployment Ready',
      check: async () => {
        const result = await execAsync(
          Cel.template("kubectl get deployment webapp-%s -o jsonpath", environment)='{.status.readyReplicas}'`
        );
        return parseInt(result.stdout) > 0;
      }
    },
    {
      name: 'Service Available',
      check: async () => {
        const result = await execAsync(
          Cel.template("kubectl get service webapp-%s-service -o jsonpath", environment)='{.spec.clusterIP}'`
        );
        return result.stdout.trim() !== '';
      }
    },
    {
      name: 'Application Responding',
      check: async () => {
        // Port-forward and check HTTP response
        const portForward = spawn('kubectl', [
          'port-forward',
          Cel.template("service/webapp-%s-service", environment),
          '8080:80'
        ]);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        try {
          const response = await fetch('http://localhost:8080/health');
          return response.ok;
        } catch {
          return false;
        } finally {
          portForward.kill();
        }
      }
    }
  ];
  
  const results = await Promise.all(
    checks.map(async ({ name, check }) => {
      try {
        const result = await check();
        console.log(Cel.template("%s %s", result ? "✅" : "❌", name));
        return { name, passed: result };
      } catch (error) {
        console.log(Cel.template("❌ %s: %s", name, error.message));
        return { name, passed: false, error: error.message };
      }
    })
  );
  
  const allPassed = results.every(r => r.passed);
  console.log(Cel.template("\n%s Overall health: %s", allPassed ? "✅" : "❌", allPassed ? "HEALTHY" : "UNHEALTHY"));
  
  return { healthy: allPassed, checks: results };
}
```

## Best Practices

### 1. Immutable Deployments

```typescript
// ✅ Generate deterministic YAML
const generateConfig = (environment: string, gitCommit: string) => ({
  name: Cel.template("webapp-%s", environment),
  image: Cel.template("myapp:%s", gitCommit),  // Use git commit as image tag
  replicas: environmentConfig[environment].replicas,
  
  labels: {
    environment,
    version: gitCommit,
    'managed-by': 'typekro'
  }
});
```

### 2. Configuration Validation

```typescript
// ✅ Validate configuration before deployment
import { type } from 'arktype';

const EnvironmentConfig = type({
  name: 'string>2',
  image: 'string',
  replicas: 'number>0',
  environment: '"development" | "staging" | "production"'
});

function validateConfig(config: unknown) {
  const result = EnvironmentConfig(config);
  if (result instanceof type.errors) {
    throw new Error(Cel.template("Invalid configuration: %s", result.summary));
  }
  return result;
}
```

### 3. Rollback Strategy

```typescript
// ✅ Implement rollback capability
async function rollback(environment: string, previousVersion: string) {
  console.log(Cel.template("Rolling back %s to %s", environment, previousVersion));
  
  // Update configuration to previous version
  const rollbackConfig = {
    ...environments[environment],
    image: Cel.template("myapp:%s", previousVersion)
  };
  
  // Generate and apply YAML
  const yaml = webAppGraph.toYaml(rollbackConfig);
  writeFileSync(Cel.template("deploy/instances/%s/webapp.yaml", environment), yaml);
  
  // Commit rollback
  await execAsync(`
    git add deploy/instances/${environment}/webapp.yaml
    git commit -m "Rollback ${environment} to ${previousVersion}"
    git push
  `);
}
```

### 4. Progressive Deployment

```typescript
// ✅ Use canary deployments for production
const productionDeployment = {
  strategy: 'canary',
  steps: [
    { weight: 10, duration: '5m' },   // 10% traffic for 5 minutes
    { weight: 50, duration: '10m' },  // 50% traffic for 10 minutes
    { weight: 100 }                   // Full traffic
  ]
};
```

## Troubleshooting GitOps

### Common Issues

**YAML generation fails:**
```bash
# Check TypeScript compilation
bun run typecheck

# Validate configuration
bun run validate-config

# Check for missing dependencies
bun install
```

**ArgoCD sync failures:**
```bash
# Check application status
kubectl get application webapp -n argocd

# View sync details
argocd app sync webapp --dry-run

# Check for resource conflicts
kubectl get events --sort-by=.metadata.creationTimestamp
```

**Flux reconciliation errors:**
```bash
# Check kustomization status
flux get kustomizations

# View reconciliation logs
flux logs --kind=Kustomization --name=webapp-production

# Force reconciliation
flux reconcile kustomization webapp-production
```

## Next Steps

- **[Type Safety](../type-safety.md)** - Ensure configuration correctness
- **[Performance](../performance.md)** - Optimize GitOps workflows  
- **[Troubleshooting](../troubleshooting.md)** - Debug GitOps deployment issues
- **[Examples](../../examples/)** - See complete GitOps examples