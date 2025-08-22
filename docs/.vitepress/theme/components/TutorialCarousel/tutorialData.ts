import type { TutorialStep } from './types';

export const tutorialSteps: TutorialStep[] = [
  {
    id: 'typescript-experience',
    title: 'Write Kubernetes in Pure TypeScript',
    description: 'Full IDE support, type safety, and refactoring - no YAML in sight',
    codeExample: {
      language: 'typescript',
      code: `import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService } from 'typekro';

const deploymentService = toResourceGraph(
  {
    name: 'deployment-service',
    apiVersion: 'example.com/v1alpha1',
    kind: 'DeploymentService',
    spec: type({ 
      name: 'string', 
      environment: '"dev" | "staging" | "prod"' 
    }),
    status: type({ ready: 'boolean', url: 'string' })
  },
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: 'nginx',
      replicas: schema.spec.environment === 'prod' ? 3 : 1,
      labels: { app: 'deployment', env: schema.spec.environment }
    }),
    
    service: simpleService({
      name: schema.spec.name,
      selector: { app: 'deployment' },
      ports: [{ port: 80, targetPort: 80 }]
    })
  })
);

await deploymentService.factory('direct').deploy({
  name: 'my-app',
  environment: 'staging'
});`,
      highlights: [
        'Type-safe schemas',
        'IDE autocomplete',
        'Cross-resource references',
        'Instant deployment',
      ],
    },
    explanation:
      'This is what modern Kubernetes configuration should feel like. Write infrastructure in TypeScript with the same developer experience you get for application code.',
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
          code: `const directFactory = deploymentService.factory('direct', { namespace: 'dev' });
await directFactory.deploy({ name: 'dev-app', environment: 'dev' });`,
          highlights: ['Instant deployment', 'Development environments'],
        },
      },
      {
        title: '2. KRO Orchestration',
        example: {
          language: 'typescript',
          code: `const kroFactory = deploymentService.factory('kro', { namespace: 'staging' });
await kroFactory.deploy({ name: 'app-1', environment: 'staging' });`,
          highlights: ['Runtime dependencies', 'Advanced orchestration'],
        },
      },
      {
        title: '3. GitOps Workflows',
        example: {
          language: 'typescript',
          code: `const gitopsFactory = deploymentService.factory('kro', { namespace: 'production' });
const yaml = gitopsFactory.toYaml();
writeFileSync('k8s/deployment-service.yaml', yaml);`,
          highlights: ['YAML generation', 'ArgoCD/Flux integration'],
        },
      },
    ],
    explanation:
      'TypeKro adapts to your deployment strategy. Use direct deployment for development, KRO orchestration for advanced runtime dependencies, or generate YAML for GitOps workflows.',
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
import { toResourceGraph, simpleDeployment, type } from 'typekro';

const app = await alchemy('cloud-native-app');

await app.run(async () => {
  // Create cloud resources within alchemy scope
  const uploadBucket = await Bucket('app-uploads');
  const apiFunction = await Lambda('api-handler', {
    code: './functions/api.js',
    environment: { BUCKET_NAME: uploadBucket.name }
  });

  // Create Kubernetes resources that reference cloud resources
  const cloudApp = toResourceGraph(
    {
      name: 'cloud-app',
      spec: type({ name: 'string', replicas: 'number' }),
      status: type({ ready: 'boolean' })
    },
    (schema) => ({
      app: simpleDeployment({
        name: schema.spec.name,
        image: 'myapp:latest',
        env: {
          API_URL: apiFunction.url,
          UPLOAD_BUCKET: uploadBucket.name
        }
      })
    })
  );

  // Deploy unified infrastructure
  const factory = cloudApp.factory('direct', { 
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
    id: 'kro-powered',
    title: 'Powered by Kubernetes Resource Orchestrator',
    description: 'TypeKro compiles to KRO ResourceGraphDefinitions with CEL expressions',
    codeExample: {
      language: 'yaml',
      code: `# That TypeScript compiles to this KRO ResourceGraphDefinition:

apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: deployment-service
spec:
  schema:
    apiVersion: v1alpha1
    kind: DeploymentService
    spec:
      name: string
      environment: string
    status:
      ready: boolean
      url: string
  resources:
    - id: deployment
      template:
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: \${schema.spec.name}
          labels:
            app: deployment
            env: \${schema.spec.environment}
        spec:
          replicas: \${schema.spec.environment == "prod" ? 3 : 1}
          selector:
            matchLabels:
              app: deployment
          template:
            metadata:
              labels:
                app: deployment
            spec:
              containers:
                - name: \${schema.spec.name}
                  image: nginx
                  ports:
                    - containerPort: 80
    - id: service
      template:
        apiVersion: v1
        kind: Service
        metadata:
          name: \${schema.spec.name}
        spec:
          selector:
            app: deployment
          ports:
            - port: 80
              targetPort: 80`,
      highlights: [
        'KRO ResourceGraphDefinition',
        'CEL expressions',
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
