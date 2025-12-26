# Alchemy Integration

TypeKro integrates with [Alchemy](https://alchemy.run) to provide a unified TypeScript experience for managing cloud and Kubernetes resources together.

## What is Alchemy?

Alchemy is an infrastructure-as-TypeScript tool for deploying to cloud providers (AWS, Cloudflare, etc.). TypeKro's integration lets you:

- Create cloud resources (S3 buckets, Lambda functions) alongside Kubernetes workloads
- Reference cloud resource outputs in Kubernetes deployments
- Manage the entire stack with a single TypeScript codebase

## Quick Example

```typescript
import alchemy from 'alchemy';
import { Bucket } from 'alchemy/aws';
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';
import { type } from 'arktype';

// Create an Alchemy scope
const app = await alchemy('my-app');

// Create cloud resources
const bucket = await Bucket('uploads', {
  bucketName: 'my-app-uploads'
});

// Define Kubernetes composition
const webapp = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string', image: 'string' }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    env: {
      BUCKET_NAME: bucket.name,      // Reference cloud resource
      BUCKET_ARN: bucket.arn
    }
  });
  return { ready: deploy.status.readyReplicas > 0 };
});

// Deploy with Alchemy scope
await app.run(async () => {
  const factory = webapp.factory('direct', { 
    namespace: 'production',
    alchemyScope: app  // Pass the Alchemy scope
  });
  await factory.deploy({ name: 'web', image: 'nginx' });
});
```

## The alchemyScope Option

Pass an Alchemy scope to factory deployment to enable cloud-Kubernetes integration:

```typescript
const factory = webapp.factory('direct', {
  namespace: 'default',
  alchemyScope: app  // Alchemy scope from alchemy('app-name')
});
```

When `alchemyScope` is provided:
- Resources are tracked in Alchemy's state store
- Cloud resource outputs can be referenced in Kubernetes manifests
- Deployments are coordinated across cloud and Kubernetes

## Cloud-First Pattern

Create cloud resources first, then reference them in Kubernetes:

```typescript
import alchemy from 'alchemy';
import { Bucket, SQSQueue } from 'alchemy/aws';
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';

const app = await alchemy('worker-app');

// 1. Create cloud resources
const queue = await SQSQueue('tasks', { queueName: 'task-queue' });
const bucket = await Bucket('results', { bucketName: 'task-results' });

// 2. Define Kubernetes workload that uses them
const worker = kubernetesComposition({
  name: 'worker',
  apiVersion: 'example.com/v1',
  kind: 'Worker',
  spec: type({ replicas: 'number' }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  const deploy = Deployment({
    id: 'worker',
    name: 'task-worker',
    image: 'worker:latest',
    replicas: spec.replicas,
    env: {
      QUEUE_URL: queue.url,        // SQS queue URL
      BUCKET_NAME: bucket.name,    // S3 bucket name
      AWS_REGION: 'us-east-1'
    }
  });
  return { ready: deploy.status.readyReplicas > 0 };
});

// 3. Deploy everything
await app.run(async () => {
  const factory = worker.factory('direct', { alchemyScope: app });
  await factory.deploy({ replicas: 3 });
});
```

## K8s-First Pattern

Deploy Kubernetes workloads that create cloud resources on demand:

```typescript
import alchemy from 'alchemy';
import { Function } from 'alchemy/aws';
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';

const app = await alchemy('api-app');

// 1. Create Lambda function for async processing
const processor = await Function('processor', {
  functionName: 'async-processor',
  runtime: 'nodejs20.x',
  handler: 'index.handler',
  code: { zipFile: './processor.zip' }
});

// 2. Kubernetes API that invokes the Lambda
const api = kubernetesComposition({
  name: 'api',
  apiVersion: 'example.com/v1',
  kind: 'API',
  spec: type({ name: 'string' }),
  status: type({ ready: 'boolean', processorUrl: 'string' })
}, (spec) => {
  const deploy = Deployment({
    id: 'api',
    name: spec.name,
    image: 'api:latest',
    env: {
      PROCESSOR_ARN: processor.arn,
      PROCESSOR_URL: processor.functionUrl || ''
    }
  });
  
  return {
    ready: deploy.status.readyReplicas > 0,
    processorUrl: processor.functionUrl || 'pending'
  };
});

await app.run(async () => {
  const factory = api.factory('direct', { alchemyScope: app });
  await factory.deploy({ name: 'my-api' });
});
```

## Unified TypeScript Experience

TypeKro + Alchemy provides:

- **Single Language**: Define cloud and Kubernetes resources in TypeScript
- **Type Safety**: Full autocomplete and type checking across the stack
- **Coordinated Deployment**: Resources deploy in the correct order
- **State Management**: Alchemy tracks all resources for updates and cleanup

```typescript
// Everything is TypeScript - no YAML, no HCL, no CloudFormation
const app = await alchemy('fullstack');

// Cloud resources
const db = await RDSInstance('db', { engine: 'postgres' });
const cache = await ElastiCacheCluster('cache', { engine: 'redis' });

// Kubernetes workloads
const api = kubernetesComposition({ /* ... */ }, (spec) => {
  return Deployment({
    id: 'api',
    name: 'api',
    image: 'api:latest',
    env: {
      DATABASE_URL: db.endpoint,
      REDIS_URL: cache.endpoint
    }
  });
});
```

## Without Alchemy

If you don't need cloud resources, TypeKro works standalone:

```typescript
// No alchemyScope needed for pure Kubernetes
const factory = webapp.factory('direct', { namespace: 'default' });
await factory.deploy({ name: 'app', image: 'nginx' });
```

## Next Steps

- [Deployment Modes](/guide/deployment-modes) - Direct vs Kro deployment
- [Custom Integrations](/advanced/custom-integrations) - Create custom factories
- [Examples](/examples/basic-webapp) - See more patterns
