import type { TutorialStep } from './types';

export const tutorialSteps: TutorialStep[] = [
  {
    id: 'typescript-experience',
    title: 'Write Kubernetes in Pure TypeScript',
    description: 'Full IDE support, type safety, and refactoring - no YAML in sight',
    codeExample: {
      language: 'typescript',
      code: `import { type } from 'arktype';
import { kubernetesComposition, simpleDeployment, simpleService, Cel } from 'typekro';

const webApp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: type({ 
      name: 'string', 
      image: 'string',
      environment: '"dev" | "staging" | "prod"' 
    }),
    status: type({ ready: 'boolean', url: 'string', replicas: 'number' })
  },
  (spec) => {
    // Resources auto-register when created - no explicit builders!
    const deployment = simpleDeployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.environment === 'prod' ? 3 : 1,
      labels: { app: spec.name, env: spec.environment }
    });
    
    const service = simpleService({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    });

    // Return status with CEL expressions and resource references
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      url: Cel.template('http://%s', service.status.clusterIP),
      replicas: deployment.status.readyReplicas
    };
  }
);

// Deploy directly - no .toResourceGraph() needed!
const factory = await webApp.factory('direct');
await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  environment: 'staging'
});`,
      highlights: [
        'Imperative composition',
        'Auto-registration',
        'CEL expressions',
        'Direct deployment',
      ],
    },
    explanation:
      'This is what modern Kubernetes configuration should feel like. Write infrastructure code naturally with imperative composition - resources auto-register when created, and you return status directly.',
    nextSteps: [
      {
        text: 'Try TypeKro Now',
        url: '/guide/getting-started',
        type: 'primary',
      },
    ],
  },
  {
    id: 'deployment-strategies',
    title: 'Three Deployment Strategies',
    description: 'Direct deployment, KRO orchestration, or GitOps workflows',
    codeBlocks: [
      {
        title: '1. Direct Deployment',
        example: {
          language: 'typescript',
          code: `const directFactory = await webApp.factory('direct', { namespace: 'dev' });
await directFactory.deploy({ 
  name: 'dev-app', 
  image: 'nginx:latest',
  environment: 'dev' 
});`,
          highlights: ['Instant deployment', 'Development environments'],
        },
      },
      {
        title: '2. KRO Orchestration',
        example: {
          language: 'typescript',
          code: `const kroFactory = await webApp.factory('kro', { namespace: 'staging' });
await kroFactory.deploy({ 
  name: 'staging-app',
  image: 'myapp:v1.2.3', 
  environment: 'staging' 
});`,
          highlights: ['Runtime dependencies', 'Advanced orchestration'],
        },
      },
      {
        title: '3. GitOps Workflows',
        example: {
          language: 'typescript',
          code: `// Generate ResourceGraphDefinition YAML
const rgdYaml = webApp.toYaml();
writeFileSync('k8s/webapp-rgd.yaml', rgdYaml);

// Generate instance YAML
const instanceYaml = webApp.toYaml({
  name: 'prod-app',
  image: 'myapp:v2.0.0',
  environment: 'prod'
});
writeFileSync('k8s/webapp-instance.yaml', instanceYaml);`,
          highlights: ['YAML generation', 'ArgoCD/Flux integration'],
        },
      },
    ],
    explanation:
      'TypeKro adapts to your deployment strategy. Use direct deployment for rapid development, KRO orchestration for advanced runtime dependencies, or generate YAML for GitOps workflows.',
    nextSteps: [
      {
        text: 'Deployment Guide',
        url: '/guide/deployment/',
        type: 'secondary',
      },
    ],
  },
  {
    id: 'alchemy-integration',
    title: 'Integrate with Multi-Cloud Infrastructure',
    description: 'Unified TypeScript for cloud resources and Kubernetes workloads',
    codeExample: {
      language: 'typescript',
      code: `import alchemy from 'alchemy';
import { Bucket, Function as Lambda } from 'alchemy/aws';
import { kubernetesComposition, simpleDeployment, type, Cel } from 'typekro';

const app = await alchemy('cloud-native-app');

await app.run(async () => {
  // Create cloud resources within alchemy scope
  const uploadBucket = await Bucket('app-uploads');
  const apiFunction = await Lambda('api-handler', {
    code: './functions/api.js',
    environment: { BUCKET_NAME: uploadBucket.name }
  });

  // Create Kubernetes resources that reference cloud resources
  const cloudApp = kubernetesComposition(
    {
      name: 'cloud-app',
      apiVersion: 'example.com/v1alpha1',
      kind: 'CloudApp',
      spec: type({ name: 'string', replicas: 'number' }),
      status: type({ ready: 'boolean' })
    },
    (spec) => {
      const app = simpleDeployment({
        name: spec.name,
        image: 'myapp:latest',
        replicas: spec.replicas,
        env: {
          API_URL: apiFunction.url,
          UPLOAD_BUCKET: uploadBucket.name
        }
      });

      return {
        ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0')
      };
    }
  );

  // Deploy unified infrastructure
  const factory = await cloudApp.factory('direct', { 
    namespace: 'production', 
    alchemyScope: app 
  });
  await factory.deploy({ name: 'webapp', replicas: 3 });
});`,
      highlights: [
        'Unified TypeScript',
        'Cloud + Kubernetes',
        'Cross-platform references',
        'Type-safe integration',
      ],
    },
    explanation:
      'Alchemy integration enables unified infrastructure management across cloud providers and Kubernetes. Write everything in TypeScript with type-safe references between cloud resources and Kubernetes workloads.',
    nextSteps: [
      {
        text: 'Alchemy Documentation',
        url: 'https://alchemy.run',
        type: 'secondary',
      },
    ],
  },
  {
    id: 'arktype-schemas',
    title: 'Define Your Application Schema',
    description: 'Type-safe schema definitions with ArkType runtime validation',
    codeExample: {
      language: 'typescript',
      code: `import { type } from 'arktype';

// Define your application's specification schema
const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  port: 'number%1',
  environment: '"dev" | "staging" | "prod"'
});

// Define the status schema for runtime information
const WebAppStatus = type({
  url: 'string',
  ready: 'boolean',
  deployedReplicas: 'number',
  healthScore: 'number'
});

// Schemas provide both compile-time TypeScript types
// AND runtime validation for deployment values
const validSpec = WebAppSpec({ 
  name: 'my-app', 
  image: 'nginx:latest',
  replicas: 3,
  port: 80,
  environment: 'prod'
});

// This would fail at runtime with detailed error
const invalidSpec = WebAppSpec({ 
  name: 'my-app',
  replicas: -1,
  environment: 'production'
});`,
      highlights: [
        'Runtime validation',
        'Compile-time types',
        'Detailed error messages',
        'Enum validation',
      ],
    },
    explanation:
      'ArkType provides runtime type validation with TypeScript inference. This ensures your infrastructure definitions are type-safe at both compile time and runtime.',
    nextSteps: [
      {
        text: 'Learn More About ArkType',
        url: 'https://arktype.io',
        type: 'secondary',
      },
    ],
  },
  {
    id: 'composition-nesting',
    title: 'Compose and Nest Infrastructure Components',
    description: 'Build complex systems by combining smaller, reusable compositions',
    codeExample: {
      language: 'typescript',
      code: `import { type } from 'arktype';
import { kubernetesComposition, simpleDeployment, simpleService, Cel } from 'typekro';

// Reusable database composition
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
    spec: type({ appName: 'string', appImage: 'string', dbImage: 'string' }),
    status: type({ ready: 'boolean', appReady: 'boolean', dbReady: 'boolean' })
  },
  (spec) => {
    // Nest the database composition - resources automatically merge
    const db = database.withSpec({
      name: Cel.template('%s-db', spec.appName),
      image: spec.dbImage
    });

    const app = simpleDeployment({
      name: spec.appName,
      image: spec.appImage,
      env: {
        DATABASE_HOST: db.status.host  // Cross-composition reference
      }
    });

    return {
      ready: Cel.expr<boolean>(db.status.ready, ' && ', app.status.readyReplicas, ' > 0'),
      appReady: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
      dbReady: db.status.ready
    };
  }
);`,
      highlights: [
        'Reusable compositions',
        'Automatic resource merging',
        'Cross-composition references',
        'Nested status objects',
      ],
    },
    explanation:
      'Build complex infrastructure by composing smaller, focused components. Resources and status automatically merge across composition boundaries, enabling powerful patterns like microservices architectures.',
    nextSteps: [
      {
        text: 'Composition Guide',
        url: '/guide/imperative-composition',
        type: 'secondary',
      },
    ],
  },
  {
    id: 'kro-powered',
    title: 'Powered by Kubernetes Resource Orchestrator',
    description: 'Imperative composition compiles to KRO ResourceGraphDefinitions with CEL expressions',
    codeExample: {
      language: 'yaml',
      code: `# That imperative TypeScript compiles to this KRO ResourceGraphDefinition:

apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: webapp
spec:
  schema:
    apiVersion: example.com/v1alpha1
    kind: WebApp
    spec:
      name: string
      image: string
      environment: string
    status:
      ready: boolean
      url: string
      replicas: number
  resources:
    - id: webapp-deployment-1
      template:
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: \${schema.spec.name}
          labels:
            app: \${schema.spec.name}
            env: \${schema.spec.environment}
        spec:
          replicas: \${schema.spec.environment == "prod" ? 3 : 1}
          selector:
            matchLabels:
              app: \${schema.spec.name}
          template:
            metadata:
              labels:
                app: \${schema.spec.name}
            spec:
              containers:
                - name: \${schema.spec.name}
                  image: \${schema.spec.image}
                  ports:
                    - containerPort: 80
    - id: webapp-service-1
      template:
        apiVersion: v1
        kind: Service
        metadata:
          name: \${schema.spec.name}-service
        spec:
          selector:
            app: \${schema.spec.name}
          ports:
            - port: 80
              targetPort: 80
  status:
    ready: \${webapp-deployment-1.status.readyReplicas > 0}
    url: \${webapp-service-1.status.clusterIP}
    replicas: \${webapp-deployment-1.status.readyReplicas}`,
      highlights: [
        'Auto-generated IDs',
        'CEL status expressions',
        'Runtime dependencies',
        'GitOps ready',
      ],
    },
    explanation:
      'KRO (Kubernetes Resource Orchestrator) enables advanced resource orchestration with runtime dependencies and CEL expressions. TypeKro generates KRO-compatible YAML that works with any GitOps workflow.',
    nextSteps: [
      {
        text: 'KRO Documentation',
        url: 'https://kro.run',
        type: 'secondary',
      },
      {
        text: 'Get Started Now',
        url: '/guide/getting-started',
        type: 'primary',
      },
    ],
  },
];

export const tutorialConfig = {
  steps: tutorialSteps,
  settings: {
    autoPlayInterval: 5000,
    enableKeyboardNavigation: true,
    enableSwipeNavigation: true,
    showProgressBar: true,
    theme: 'auto' as const,
  },
  analytics: {
    trackStepViews: true,
    trackCompletions: true,
    trackDropoffs: true,
  },
};
