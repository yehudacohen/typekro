import type { TutorialStep } from './types';

export const tutorialSteps: TutorialStep[] = [
  {
    id: 'arktype-schemas',
    title: 'Define Your Application Schema',
    description: 'Start with type-safe schema definitions using ArkType',
    codeExample: {
      language: 'typescript',
      code: `import { type } from 'arktype';

// Define your application's specification schema
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  port: 'number%1'
});

// Define the status schema for runtime information
const WebAppStatusSchema = type({
  url: 'string',
  ready: 'boolean',
  deployedReplicas: 'number'
});`,
      highlights: ['Type safety', 'Runtime validation', 'IntelliSense support']
    },
    explanation: 'ArkType provides runtime type validation with TypeScript inference. This ensures your infrastructure definitions are type-safe at both compile time and runtime, giving you excellent developer experience with IntelliSense and catching errors early.',
    nextSteps: [
      {
        text: 'Learn More About ArkType',
        url: 'https://arktype.io',
        type: 'secondary'
      }
    ]
  },
  {
    id: 'resource-graph',
    title: 'Compose Your Infrastructure',
    description: 'Build Kubernetes resources using factory functions',
    codeExample: {
      language: 'typescript',
      code: `import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

const webAppGraph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema
  },
  // Resource builder function
  (schema) => ({
    // Create a deployment with cross-references
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: schema.spec.port }]
    }),
    
    // Create a service that references the deployment
    service: simpleService({
      name: \`\${schema.spec.name}-service\`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: schema.spec.port }]
    })
  }),
  // Status builder function
  (schema, resources) => ({
    url: \`\${schema.spec.name}-service\`,
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' > 0'),
    deployedReplicas: resources.deployment.status.readyReplicas
  })
);`,
      highlights: ['Factory functions', 'Cross-resource references', 'Status builder', 'CEL expressions']
    },
    explanation: 'Factory functions provide a clean, composable way to build Kubernetes resources. Cross-resource references are automatically resolved, and the entire graph is type-safe. This approach scales from simple applications to complex multi-service architectures.',
    nextSteps: [
      {
        text: 'Factory Functions Guide',
        url: '/guide/factory-functions',
        type: 'secondary'
      }
    ]
  },
  {
    id: 'kro-yaml-generation',
    title: 'Generate KRO ResourceGraphDefinition',
    description: 'Export KRO ResourceGraphDefinitions for GitOps workflows',
    codeExample: {
      language: 'typescript',
      code: `// Generate KRO ResourceGraphDefinition YAML directly from the graph
const kroYaml = webAppGraph.toYaml();

console.log(kroYaml);
// Output: KRO ResourceGraphDefinition YAML
// apiVersion: kro.run/v1alpha1
// kind: ResourceGraphDefinition
// metadata:
//   name: webapp-stack
//   namespace: default
// spec:
//   schema:
//     apiVersion: v1alpha1
//     kind: WebApp
//     spec:
//       name: string
//       image: string
//       replicas: integer
//       port: integer
//     status:
//       url: \${schema.spec.name}-service
//       ready: \${deployment.status.readyReplicas > 0}
//       deployedReplicas: \${deployment.status.readyReplicas}
//   resources:
//     - id: deployment
//       template:
//         apiVersion: apps/v1
//         kind: Deployment
//         metadata:
//           name: \${schema.spec.name}
//           labels:
//             app: \${schema.spec.name}
//         spec:
//           replicas: \${schema.spec.replicas}
//           selector:
//             matchLabels:
//               app: \${schema.spec.name}
//           template:
//             metadata:
//               labels:
//                 app: \${schema.spec.name}
//             spec:
//               containers:
//               - name: \${schema.spec.name}
//                 image: \${schema.spec.image}
//                 ports:
//                 - containerPort: \${schema.spec.port}
//     - id: service
//       template:
//         apiVersion: v1
//         kind: Service
//         metadata:
//           name: \${schema.spec.name}-service
//         spec:
//           selector:
//             app: \${schema.spec.name}
//           ports:
//           - port: 80
//             targetPort: \${schema.spec.port}`,
      highlights: ['toYaml() method', 'ResourceGraphDefinition', 'CEL expressions', 'Schema references']
    },
    explanation: 'The resource graph\'s `toYaml()` method generates a complete ResourceGraphDefinition that can be committed to git and deployed through your GitOps workflow. KRO controller uses CEL expressions to template resources based on instance specifications, providing powerful GitOps workflows with type safety.',
    nextSteps: [
      {
        text: 'KRO Documentation',
        url: 'https://github.com/awslabs/kro',
        type: 'secondary'
      }
    ]
  },
  {
    id: 'direct-deployment',
    title: 'Deploy Directly to Kubernetes',
    description: 'Skip YAML generation and deploy resources immediately',
    codeExample: {
      language: 'typescript',
      code: `// Create a direct deployment factory
const directFactory = await webAppGraph.factory('direct', { 
  namespace: 'production' 
});

// Deploy your application directly
const instance = await directFactory.create({
  name: 'my-webapp',
  image: 'nginx:latest',
  replicas: 3,
  port: 80
});

// TypeKro handles dependency resolution and deployment order
console.log('Deployed:', instance.status);
// { url: 'http://my-webapp-service.production.svc.cluster.local', ready: true }`,
      highlights: ['No kubectl required', 'Automatic dependency resolution', 'Immediate deployment']
    },
    explanation: 'Direct deployment bypasses YAML generation entirely. TypeKro connects to your Kubernetes cluster, resolves dependencies automatically, and deploys resources in the correct order. Perfect for development environments and automated deployments.',
    nextSteps: [
      {
        text: 'Direct Deployment Guide',
        url: '/guide/getting-started#direct-deployment',
        type: 'secondary'
      }
    ]
  },
  {
    id: 'kro-deployment',
    title: 'Deploy with KRO Controller',
    description: 'Create custom resource instances that KRO manages automatically',
    codeExample: {
      language: 'typescript',
      code: `// Install KRO controller first:
// kubectl apply -f https://github.com/awslabs/kro/releases/latest/download/kro.yaml

// Create a KRO factory for operator-style deployment
const kroFactory = await webAppGraph.factory('kro', { 
  namespace: 'production' 
});

// Deploy the ResourceGraphDefinition (once per factory)
await kroFactory.deploy();

// Create instances as custom resources
const instance = await kroFactory.create({
  name: 'my-webapp',
  image: 'nginx:latest',
  replicas: 3,
  port: 80
});

// Or apply the YAML manually with kubectl:
const instanceYaml = \`apiVersion: example.com/v1alpha1
kind: WebApp
metadata:
  name: my-webapp
  namespace: production
spec:
  name: my-webapp
  image: nginx:latest
  replicas: 3
  port: 80\`;

// kubectl apply -f webapp-instance.yaml

// KRO controller automatically creates the Deployment and Service
console.log('Instance ready:', instance.status.ready);
console.log('App URL:', instance.status.url);`,
      highlights: ['ResourceGraphDefinition deployment', 'Custom resource instances', 'Automatic reconciliation']
    },
    explanation: 'The KRO factory first deploys the ResourceGraphDefinition, then creates custom resource instances. The KRO controller watches these instances and automatically creates the underlying Kubernetes resources (Deployments, Services, etc.) based on the templates defined in the ResourceGraphDefinition.',
    nextSteps: [
      {
        text: 'KRO Controller Guide',
        url: '/guide/getting-started#kro-controller',
        type: 'secondary'
      },
      {
        text: 'Install KRO',
        url: 'https://github.com/awslabs/kro',
        type: 'secondary'
      }
    ]
  },
  {
    id: 'alchemy-integration',
    title: 'Integrate with Alchemy',
    description: 'Advanced resource management and deployment strategies',
    codeExample: {
      language: 'typescript',
      code: `import alchemy from 'alchemy';

// Set up Alchemy scope for resource management
const alchemyScope = await alchemy('my-webapp-project', {
  stateStore: (scope) => new FileSystemStateStore(scope, { 
    rootDir: './alchemy-state' 
  })
});

// Create direct factory with Alchemy integration
const alchemyFactory = await webAppGraph.factory('direct', {
  namespace: 'production',
  alchemyScope: alchemyScope,
  kubeConfig: kc,
  waitForReady: true,
  timeout: 60000
});

// Deploy with Alchemy resource tracking
await alchemyScope.run(async () => {
  const instance = await alchemyFactory.deploy({
    name: 'my-webapp',
    image: 'nginx:latest',
    replicas: 3,
    port: 80
  });

  // Alchemy tracks individual Kubernetes resources
  const alchemyState = await alchemyScope.state.all();
  const kubernetesResources = Object.values(alchemyState)
    .filter((state: any) => state.kind.startsWith('kubernetes::'));
  
  console.log(\`Tracked resources: \${kubernetesResources.length}\`);
  // Each Deployment, Service, ConfigMap is tracked individually
});`,
      highlights: ['Resource state tracking', 'Individual resource management', 'Advanced lifecycle control']
    },
    explanation: 'Alchemy integration provides advanced resource lifecycle management with individual resource tracking, state management, and sophisticated deployment strategies. Perfect for production environments requiring fine-grained control over resource lifecycles.',
    nextSteps: [
      {
        text: 'Alchemy Integration Guide',
        url: '/guide/getting-started#alchemy-integration',
        type: 'secondary'
      },
      {
        text: 'Get Started Now',
        url: '/guide/getting-started',
        type: 'primary'
      }
    ]
  }
];

export const tutorialConfig = {
  steps: tutorialSteps,
  settings: {
    autoPlayInterval: 5000,
    enableKeyboardNavigation: true,
    enableSwipeNavigation: true,
    showProgressBar: true,
    theme: 'auto' as const
  },
  analytics: {
    trackStepViews: true,
    trackCompletions: true,
    trackDropoffs: true
  }
};