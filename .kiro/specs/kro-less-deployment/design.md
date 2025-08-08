# Kro-less Deployment Design (Cohesive & Elegant)

## Overview

The Kro-less deployment feature enables TypeKro to deploy resource graphs directly to Kubernetes clusters without requiring the Kro controller. This is achieved through a clean factory pattern with full type safety via ArkType schema integration.

## Core Architecture

### Clean API Design

```typescript
// 1. Create typed resource graph with definition-first API
const graph = toResourceGraph(
  { name: 'webapp', apiVersion: 'v1alpha1', kind: 'WebApp', spec: SpecSchema, status: StatusSchema },
  resourceBuilder,
  statusBuilder
);

// 2. Create factory with deployment strategy
const factory = await graph.factory(mode, options);

// 3. Deploy instances with full type safety
const instance = await factory.deploy(spec);
```

### Core Interfaces

```typescript
// Clean ResourceGraph - pure resource definition
interface ResourceGraph<TSpec = any, TStatus = any> {
  name: string;
  resources: KubernetesResource[];
  
  // Factory creation with mode and options
  factory<TMode extends 'kro' | 'direct'>(
    mode: TMode, 
    options?: FactoryOptions
  ): Promise<FactoryForMode<TMode, TSpec, TStatus>>;
  
  // Utility methods
  toYaml(): string;
  schema?: SchemaProxy<TSpec, TStatus>; // Only for typed graphs
}

// Factory options determine all deployment behavior
interface FactoryOptions {
  namespace?: string;
  timeout?: number;
  waitForReady?: boolean;
  retryPolicy?: RetryPolicy;
  progressCallback?: (event: DeploymentEvent) => void;
  
  // Alchemy integration - determines deployment target
  alchemyScope?: Scope;
}

// Unified factory interface - all modes implement this
interface ResourceFactory<TSpec, TStatus> {
  // Core deployment - single method handles all cases
  deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>>;
  
  // Instance management
  getInstances(): Promise<Enhanced<TSpec, TStatus>[]>;
  deleteInstance(name: string): Promise<void>;
  getStatus(): Promise<FactoryStatus>;
  
  // Metadata
  readonly mode: 'kro' | 'direct';
  readonly name: string;
  readonly namespace: string;
  readonly isAlchemyManaged: boolean;
}

// Mode-specific factories extend the base interface
interface DirectResourceFactory<TSpec, TStatus> extends ResourceFactory<TSpec, TStatus> {
  mode: 'direct';
  
  // Direct-specific features
  rollback(): Promise<RollbackResult>;
  toDryRun(spec: TSpec): Promise<DeploymentResult>;
  toYaml(spec: TSpec): string; // Generate instance deployment YAML
}

interface KroResourceFactory<TSpec, TStatus> extends ResourceFactory<TSpec, TStatus> {
  mode: 'kro';
  
  // Kro-specific features
  readonly rgdName: string;
  getRGDStatus(): Promise<RGDStatus>;
  toYaml(): string; // Generate RGD YAML (no args needed)
  toYaml(spec: TSpec): string; // Generate CRD instance YAML
  
  // Schema proxy for type-safe instance creation
  schema: SchemaProxy<TSpec, TStatus>;
}

// Type mapping for factory selection
type FactoryForMode<TMode, TSpec, TStatus> = 
  TMode extends 'kro' ? KroResourceFactory<TSpec, TStatus> :
  TMode extends 'direct' ? DirectResourceFactory<TSpec, TStatus> :
  never;
```

## User Experience Examples

### Example 1: Complete Typed Workflow

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from '@yehudacohen/typekro';

// 1. Define ArkType schemas with automatic type inference
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1', // integer
  domain: 'string',
  environment: '"development" | "staging" | "production"',
});

const WebAppStatusSchema = type({
  url: 'string',
  readyReplicas: 'number%1',
  phase: '"pending" | "running" | "failed"',
});

// 2. Infer TypeScript types from ArkType schemas
type WebAppSpec = typeof WebAppSpecSchema.infer;
type WebAppStatus = typeof WebAppStatusSchema.infer;

// 3. Create typed resource graph using builder functions
const webappGraph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  // Resource builder function
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      env: {
        NODE_ENV: schema.spec.environment,
        DOMAIN: schema.spec.domain,
        REPLICA_COUNT: Cel.string(schema.spec.replicas),
      },
      ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
    }),

    service: simpleService({
      name: Cel.expr(schema.spec.name, '-service'),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'LoadBalancer',
    }),
  }),
  
  // Status builder function - receives resources from above
  (schema, resources) => ({
    url: resources.service.status.loadBalancer.ingress[0].hostname,
    readyReplicas: resources.deployment.status.availableReplicas,
    phase: Cel.conditional(
      resources.deployment.status.readyReplicas,
      Cel.expr(resources.deployment.status.replicas, ' ? "ready" : "pending"')
    ),
  })
);

// 4. Generate ResourceGraphDefinition YAML
console.log(webappGraph.toYaml());
```

### Example 2: Direct Deployment (TypeKro Dependency Resolution)

```typescript
// Create factory for direct deployment
const directFactory = await webappGraph.factory('direct', {
  namespace: 'production',
  waitForReady: true,
  timeout: 300000,
});

console.log(`Factory mode: ${directFactory.mode}`);
console.log(`Alchemy managed: ${directFactory.isAlchemyManaged}`);

// Deploy instances with full type safety
const prodInstance = await directFactory.deploy({
  name: 'webapp-prod',
  image: 'myapp:v1.2.0',
  replicas: 5,
  domain: 'myapp.com',
  environment: 'production',
});

const stagingInstance = await directFactory.deploy({
  name: 'webapp-staging',
  image: 'myapp:latest',
  replicas: 2,
  domain: 'staging.myapp.com',
  environment: 'staging',
});

// Type-safe access to instance status
console.log(`Production URL: ${prodInstance.status.url}`);
console.log(`Ready replicas: ${prodInstance.status.readyReplicas}`);
console.log(`Phase: ${prodInstance.status.phase}`);

// Instance management
const allInstances = await directFactory.getInstances();
console.log(`Managing ${allInstances.length} instances`);

// Cleanup
await directFactory.deleteInstance('webapp-staging');

// Direct-specific features
const dryRun = await directFactory.toDryRun({
  name: 'webapp-test',
  image: 'myapp:test',
  replicas: 1,
  domain: 'test.myapp.com',
  environment: 'development',
});

console.log(`Dry run would deploy ${dryRun.resources.length} resources`);
```

### Example 3: Kro Deployment (RGD with Kro Dependency Resolution)

```typescript
// Create factory for Kro deployment
const kroFactory = await webappGraph.factory('kro', {
  namespace: 'production',
  waitForReady: true,
});

console.log(`Factory mode: ${kroFactory.mode}`);
console.log(`RGD Name: ${kroFactory.rgdName}`);

// Deploy instances from the RGD
const prodInstance = await kroFactory.deploy({
  name: 'webapp-prod',
  image: 'myapp:v1.2.0',
  replicas: 5,
  domain: 'myapp.com',
  environment: 'production',
});

// Kro-specific features
const rgdStatus = await kroFactory.getRGDStatus();
console.log(`RGD Status: ${rgdStatus.phase}`);

// Type-safe access through schema proxy
console.log(`Schema available: ${!!kroFactory.schema}`);
```

### Example 4: Alchemy Integration (Direct Mode)

```typescript
import alchemy from 'alchemy';
import { RdsInstance } from 'alchemy/aws';

const app = await alchemy('full-stack-app');

// Create AWS RDS instance
const database = await RdsInstance('database', {
  instanceClass: 'db.t3.micro',
  engine: 'postgres',
  dbName: 'webapp'
});

// Create Kubernetes resources that reference AWS resources
const fullStackGraph = toResourceGraph(
  'fullstack-app',
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      env: {
        // Mix of alchemy promises and schema references
        DATABASE_URL: database.connectionString, // Alchemy promise
        APP_NAME: schema.spec.name,              // Schema reference
        REPLICAS: Cel.string(schema.spec.replicas), // CEL expression
      },
    }),
    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
    }),
  }),
  schemaDefinition
);

// Create alchemy-managed factory
const alchemyFactory = await fullStackGraph.factory('direct', {
  alchemyScope: app, // Alchemy integration configured here
  namespace: 'production',
  waitForReady: true,
});

console.log(`Factory is alchemy-managed: ${alchemyFactory.isAlchemyManaged}`);

// Single deploy() method handles alchemy automatically
// This will create TWO alchemy resources:
// 1. app.run('kubernetes::Deployment', deploymentLogic)
// 2. app.run('kubernetes::Service', serviceLogic)
const prodInstance = await alchemyFactory.deploy({
  name: 'webapp-prod',
  image: 'myapp:v1.2.0',
  replicas: 3,
  domain: 'myapp.com',
  environment: 'production',
});

console.log(`Production URL: ${prodInstance.status.url}`);
```

### Example 5: Alchemy Integration (Kro Mode)

```typescript
const app = await alchemy('kro-managed-app');

// Create alchemy-managed Kro factory
const alchemyKroFactory = await webappGraph.factory('kro', {
  alchemyScope: app,
  namespace: 'production',
});

console.log(`Factory is alchemy-managed: ${alchemyKroFactory.isAlchemyManaged}`);
console.log(`RGD Name: ${alchemyKroFactory.rgdName}`);

// Deploy - This will create TWO alchemy resources:
// 1. app.run('kro::ResourceGraphDefinition', rgdLogic) - deployed once
// 2. app.run('kro::WebApp', instanceLogic) - deployed per instance
const prodInstance = await alchemyKroFactory.deploy({
  name: 'webapp-prod',
  image: 'myapp:v1.2.0',
  replicas: 5,
  domain: 'myapp.com',
  environment: 'production',
});

console.log(`Production URL: ${prodInstance.status.url}`);
```

### Example 6: External References with Type Safety

```typescript
import { externalRef } from '@yehudacohen/typekro';

// Define schemas for external database
const DatabaseSpecSchema = type({
  name: 'string',
  storage: 'string',
  version: 'string',
});

const DatabaseStatusSchema = type({
  connectionString: 'string',
  host: 'string',
  port: 'number%1',
  ready: 'boolean',
});

type DatabaseSpec = typeof DatabaseSpecSchema.infer;
type DatabaseStatus = typeof DatabaseStatusSchema.infer;

// Create webapp that references external database
const webappWithDbGraph = toResourceGraph(
  'webapp-with-db',
  (schema) => {
    // Type-safe external reference
    const database = externalRef<DatabaseSpec, DatabaseStatus>(
      'example.com/v1alpha1',
      'Database',
      'production-database'
    );

    return {
      database, // Include external reference in resource graph

      deployment: simpleDeployment({
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        env: {
          // Type-safe references to external database
          DATABASE_URL: database.status.connectionString,
          DATABASE_HOST: database.status.host,
          DATABASE_PORT: Cel.string(database.status.port),
          DATABASE_READY: Cel.string(database.status.ready),
        },
      }),
    };
  },
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  }
);

// Deploy with external dependencies
const factory = await webappWithDbGraph.factory('direct');
const instance = await factory.deploy({
  name: 'webapp-prod',
  image: 'myapp:latest',
  replicas: 3,
  domain: 'myapp.com',
  environment: 'production',
});
```



## Implementation Strategy

### 1. Enhanced toResourceGraph Function

```typescript
// Clean API with definition-first parameter
export function toResourceGraph<TSpec, TStatus>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  resourceBuilder: ResourceBuilder<TSpec, TStatus>,
  statusBuilder: StatusBuilder<TSpec, TStatus>
): ResourceGraph<TSpec, TStatus> {
  // Create typed resource graph with separate resource and status builder functions
  return createTypedResourceGraph(definition, resourceBuilder, statusBuilder)
```

### 2. Factory Implementation

```typescript
class TypedResourceGraphImpl<TSpec, TStatus> implements ResourceGraph<TSpec, TStatus> {
  constructor(
    public name: string,
    private resources: Record<string, KubernetesResource>,
    private schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    public schema: SchemaProxy<TSpec, TStatus>
  ) {}

  async factory<TMode extends 'kro' | 'direct'>(
    mode: TMode,
    options: FactoryOptions = {}
  ): Promise<FactoryForMode<TMode, TSpec, TStatus>> {
    const {
      namespace = 'default',
      timeout = 300000,
      waitForReady = true,
      retryPolicy,
      progressCallback,
      alchemyScope
    } = options;

    const factoryConfig = {
      name: this.name,
      resources: this.resources,
      schemaDefinition: this.schemaDefinition,
      schema: this.schema,
      namespace,
      alchemyScope,
      options: { timeout, waitForReady, retryPolicy, progressCallback }
    };

    switch (mode) {
      case 'direct':
        return new DirectResourceFactory(factoryConfig) as FactoryForMode<TMode, TSpec, TStatus>;
        
      case 'kro':
        return new KroResourceFactory(factoryConfig) as FactoryForMode<TMode, TSpec, TStatus>;
        
      default:
        throw new Error(`Unsupported factory mode: ${mode}`);
    }
  }

  toYaml(): string {
    return serializeResourceGraphToYaml(
      this.name,
      this.resources,
      undefined,
      generateKroSchemaFromArktype(this.name, this.schemaDefinition)
    );
  }
}
```

### 3. DirectResourceFactory Implementation

```typescript
class DirectResourceFactory<TSpec, TStatus> implements DirectResourceFactory<TSpec, TStatus> {
  public readonly mode = 'direct' as const;
  public readonly isAlchemyManaged: boolean;
  
  constructor(config: FactoryConfig<TSpec, TStatus>) {
    this.name = config.name;
    this.namespace = config.namespace;
    this.isAlchemyManaged = !!config.alchemyScope;
    // ... initialize other properties
  }

  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // 1. Validate spec against ArkType schema
    const validationResult = this.schemaDefinition.spec(spec);
    if (validationResult instanceof type.errors) {
      throw new Error(`Invalid spec: ${validationResult.summary}`);
    }

    // 2. Generate instance name and resolve resources
    const instanceName = this.generateInstanceName(spec);
    const resolvedResources = await this.resolveResourcesWithSpec(spec, instanceName);
    
    // 3. Deploy based on alchemy configuration
    if (this.isAlchemyManaged) {
      return this.deployWithAlchemy(spec, instanceName, resolvedResources);
    } else {
      return this.deployDirect(spec, instanceName, resolvedResources);
    }
  }

  async rollback(): Promise<RollbackResult> {
    // Rollback all instances created by this factory
    const engine = new DirectDeploymentEngine(this.kubeConfig);
    return engine.rollback(this.name);
  }

  async toDryRun(spec: TSpec): Promise<DeploymentResult> {
    // Perform dry run deployment
    const instanceName = this.generateInstanceName(spec);
    const resolvedResources = await this.resolveResourcesWithSpec(spec, instanceName);
    
    const engine = new DirectDeploymentEngine(this.kubeConfig);
    const resourceGraph = this.createResourceGraph(instanceName, resolvedResources);
    
    return engine.deploy(resourceGraph, {
      namespace: this.namespace,
      dryRun: true,
      ...this.options
    });
  }

  // ... other methods
}
```

### 4. KroResourceFactory Implementation

```typescript
class KroResourceFactory<TSpec, TStatus> implements KroResourceFactory<TSpec, TStatus> {
  public readonly mode = 'kro' as const;
  public readonly rgdName: string;
  public readonly isAlchemyManaged: boolean;
  
  constructor(config: FactoryConfig<TSpec, TStatus>) {
    this.name = config.name;
    this.namespace = config.namespace;
    this.rgdName = `${config.name}-rgd`;
    this.isAlchemyManaged = !!config.alchemyScope;
    this.schema = config.schema;
    // ... initialize other properties
  }

  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // 1. Ensure RGD is deployed
    await this.ensureRGDDeployed();
    
    // 2. Validate spec against ArkType schema
    const validationResult = this.schemaDefinition.spec(spec);
    if (validationResult instanceof type.errors) {
      throw new Error(`Invalid spec: ${validationResult.summary}`);
    }

    // 3. Create instance using Kro controller
    const instanceName = this.generateInstanceName(spec);
    
    if (this.isAlchemyManaged) {
      return this.createAlchemyManagedInstance(spec, instanceName);
    } else {
      return this.createKroInstance(spec, instanceName);
    }
  }

  async getRGDStatus(): Promise<RGDStatus> {
    // Get status of the deployed RGD
    const kubeApi = this.createKubeApi();
    const rgd = await kubeApi.read({
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: this.rgdName, namespace: this.namespace }
    });
    
    return {
      name: rgd.metadata.name,
      phase: rgd.status?.phase || 'pending',
      conditions: rgd.status?.conditions || [],
      observedGeneration: rgd.status?.observedGeneration,
    };
  }

  // ... other methods
}
```

## Core Types and Interfaces

```typescript
export interface RetryPolicy {
  maxRetries: number;
  backoffMultiplier: number;
  initialDelay: number;
  maxDelay: number;
}

export interface DeploymentEvent {
  type: 'started' | 'progress' | 'completed' | 'failed' | 'rollback';
  resourceId?: string;
  message: string;
  timestamp: Date;
  error?: Error;
}

export interface DeploymentResult {
  deploymentId: string;
  resources: DeployedResource[];
  duration: number;
  status: 'success' | 'partial' | 'failed';
  errors: DeploymentError[];
}

export interface DeployedResource {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  manifest: KubernetesResource;
  status: 'deployed' | 'ready' | 'failed';
  deployedAt: Date;
  error?: Error;
}

export interface FactoryStatus {
  name: string;
  mode: 'kro' | 'direct';
  isAlchemyManaged: boolean;
  namespace: string;
  instanceCount: number;
  lastDeployment?: Date;
  health: 'healthy' | 'degraded' | 'failed';
}

export interface RGDStatus {
  name: string;
  phase: 'pending' | 'ready' | 'failed';
  conditions: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
  observedGeneration?: number;
}

export interface SchemaDefinition<TSpec, TStatus> {
  apiVersion: string;
  kind: string;
  spec: Type<TSpec>;    // ArkType schema
  status: Type<TStatus>; // ArkType schema
}

// Magic assignable type for status field mappings
export type MagicAssignableShape<T> = {
  [K in keyof T]: T[K] extends object 
    ? MagicAssignableShape<T[K]>  // Recursively handle nested objects
    : MagicAssignable<T[K]>;      // Apply MagicAssignable to primitive types
};

export interface ResourceGraphDefinition<TSpec, TStatus> {
  name: string;
  apiVersion: string;
  kind: string;
  spec: Type<TSpec>;
  status: Type<TStatus>;
}

export type ResourceBuilder<TSpec, TStatus> = (
  schema: SchemaProxy<TSpec, TStatus>
) => Record<string, KubernetesResource>;

export type StatusBuilder<TSpec, TStatus> = (
  schema: SchemaProxy<TSpec, TStatus>,
  resources: Record<string, KubernetesResource>
) => MagicAssignableShape<TStatus>;
```

## Alchemy Integration Strategy

### Core Vision

When an alchemy scope is provided to a factory, TypeKro uses a dynamic resource type registration system that ensures each resource type is registered only once, then creates multiple instances of those types. This approach combines type safety with efficient resource management.

### Dynamic Resource Type Registration

TypeKro uses a single `ensureResourceTypeRegistered()` function that handles registration on-demand, following alchemy's type safety guidelines:

```typescript
import type { Context } from 'alchemy';
import { Resource, type ResourceKind, type ResourceID, type ResourceFQN, type ResourceScope, type ResourceSeq, type DestroyStrategy } from 'alchemy';

// Import TypeKro types from our project
import type { Enhanced } from '../core/types/kubernetes.js';
import type { DeploymentOptions, DeploymentResult } from '../core/types/deployment.js';
import type { DirectDeploymentEngine } from '../core/deployment/engine.js';
import type { KroDeploymentEngine } from '../factories/kro/deployment-engine.js';

/**
 * Centralized deployment interface that abstracts deployment logic
 */
export interface TypeKroDeployer {
  /**
   * Deploy a TypeKro resource to Kubernetes
   */
  deploy<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<T>;
  
  /**
   * Delete a TypeKro resource from Kubernetes
   */
  delete<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<void>;
}

/**
 * Properties for creating or updating a TypeKro resource through alchemy
 */
export interface TypeKroResourceProps<T extends Enhanced<any, any>> {
  /**
   * The TypeKro Enhanced resource to deploy
   */
  resource: T;
  
  /**
   * The namespace to deploy the resource to
   */
  namespace: string;
  
  /**
   * The deployer instance to use for deployment operations
   */
  deployer: TypeKroDeployer;
  
  /**
   * Optional deployment options
   */
  options?: {
    waitForReady?: boolean;
    timeout?: number;
  };
}

/**
 * Output returned after TypeKro resource deployment through alchemy
 * Following alchemy pattern: interface name matches exported resource name
 */
export interface TypeKroResource<T extends Enhanced<any, any>> extends Resource<string> {
  /**
   * The original TypeKro resource
   */
  resource: T;
  
  /**
   * The namespace the resource was deployed to
   */
  namespace: string;
  
  /**
   * The deployed resource with live status from the cluster
   */
  deployedResource: T;
  
  /**
   * Whether the resource is ready and available
   */
  ready: boolean;
  
  /**
   * Deployment timestamp
   */
  deployedAt: number;
}

// Dynamic registration function with full type safety
function ensureResourceTypeRegistered<T extends Enhanced<any, any>>(
  resource: T
): typeof TypeKroResource {
  const alchemyType = inferAlchemyTypeFromTypeKroResource(resource);
  
  // Check if already registered
  if (PROVIDERS.has(alchemyType)) {
    return PROVIDERS.get(alchemyType)! as typeof TypeKroResource;
  }
  
  // Register new resource type following alchemy's pseudo-class pattern
  return Resource(
    alchemyType,
    async function(
      this: Context<TypeKroResource<T>>,
      id: string,
      props: TypeKroResourceProps<T>
    ): Promise<TypeKroResource<T>> {
      if (this.phase === 'delete') {
        try {
          // Use centralized deployer for deletion
          await props.deployer.delete(props.resource, {
            namespace: props.namespace,
            ...props.options
          });
        } catch (error) {
          console.error(`Error deleting ${alchemyType}:`, error);
        }
        return this.destroy();
      }
      
      // Deploy using centralized deployer
      const deployedResource = await props.deployer.deploy(props.resource, {
        namespace: props.namespace,
        waitForReady: props.options?.waitForReady ?? true,
        timeout: props.options?.timeout ?? 300000,
      });
      
      return this({
        resource: props.resource,
        namespace: props.namespace,
        deployedResource,
        ready: true,
        deployedAt: Date.now(),
      });
    }
  );
}

// Type-safe inference function
function inferAlchemyTypeFromTypeKroResource<T extends Enhanced<any, any>>(
  resource: T
): string {
  if (resource.apiVersion === 'kro.run/v1alpha1' && resource.kind === 'ResourceGraphDefinition') {
    return 'kro::ResourceGraphDefinition';
  }
  
  if (resource.apiVersion?.includes('kro.run')) {
    return `kro::${resource.kind}`;
  }
  
  return `kubernetes::${resource.kind}`;
}

/**
 * Direct deployment implementation using TypeKro's DirectDeploymentEngine
 */
export class DirectTypeKroDeployer implements TypeKroDeployer {
  constructor(private engine: DirectDeploymentEngine) {}
  
  async deploy<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<T> {
    const result = await this.engine.deployResource(resource, options);
    return result as T;
  }
  
  async delete<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<void> {
    await this.engine.deleteResource(resource, options);
  }
}

/**
 * Kro deployment implementation using TypeKro's KroDeploymentEngine
 */
export class KroTypeKroDeployer implements TypeKroDeployer {
  constructor(private engine: KroDeploymentEngine) {}
  
  async deploy<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<T> {
    const result = await this.engine.deployResource(resource, options);
    return result as T;
  }
  
  async delete<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<void> {
    await this.engine.deleteResource(resource, options);
  }
}
```

### Direct Mode Integration

For DirectResourceFactory with alchemy integration:

```typescript
// User calls this
const instance = await alchemyFactory.deploy(spec);

// TypeKro internally does this:
const deploymentResource = createDeploymentResource(spec); // Enhanced<TSpec, TStatus>
const serviceResource = createServiceResource(spec); // Enhanced<TSpec, TStatus>

// Create centralized deployer
const deployer = new DirectTypeKroDeployer(this.deploymentEngine);

// Ensure resource types are registered dynamically
const DeploymentProvider = ensureResourceTypeRegistered(deploymentResource);
const ServiceProvider = ensureResourceTypeRegistered(serviceResource);

// Create instances with deterministic IDs and centralized deployment
const deploymentId = generateDeterministicResourceId('Deployment', deploymentName, namespace);
const deployment = await DeploymentProvider(deploymentId, {
  resource: deploymentResource,
  namespace: namespace,
  deployer: deployer
});

const serviceId = generateDeterministicResourceId('Service', serviceName, namespace);
const service = await ServiceProvider(serviceId, {
  resource: serviceResource,
  namespace: namespace,
  deployer: deployer
});

// Return Enhanced instance that references the alchemy-managed resources
return createEnhancedInstance(spec, { deployment, service });
```

### Kro Mode Integration

For KroResourceFactory with alchemy integration:

```typescript
// User calls this
const instance = await alchemyKroFactory.deploy(spec);

// TypeKro internally does this:
// 1. Ensure RGD is deployed via alchemy (once per factory)
const rgdResource = createRGDResource(rgdManifest); // Enhanced<any, any>
const kroDeployer = new KroTypeKroDeployer(this.kroDeploymentEngine);
const RGDProvider = ensureResourceTypeRegistered(rgdResource);

const rgdId = generateDeterministicResourceId('ResourceGraphDefinition', rgdName, namespace);
const rgd = await RGDProvider(rgdId, {
  resource: rgdResource,
  namespace: namespace,
  deployer: kroDeployer
});

// 2. Create instance via alchemy (once per deploy call)
const crdInstanceResource = createCRDInstanceResource(spec, instanceManifest); // Enhanced<TSpec, TStatus>
const CRDInstanceProvider = ensureResourceTypeRegistered(crdInstanceResource);

const instanceId = generateDeterministicResourceId(schemaDefinition.kind, instanceName, namespace);
const crdInstance = await CRDInstanceProvider(instanceId, {
  resource: crdInstanceResource,
  namespace: namespace,
  deployer: kroDeployer
});

// Return Enhanced instance that references the alchemy-managed CRD instance
return createEnhancedInstance(spec, crdInstance);
```

### Implementation Strategy

The alchemy integration is implemented through:

1. **Dynamic Registration**: `ensureResourceTypeRegistered()` registers types on-demand
2. **Type Inference**: `inferAlchemyTypeFromTypeKroResource()` determines alchemy type from TypeKro resource
3. **Instance Creation**: Create multiple instances of registered types with unique IDs
4. **Deterministic IDs**: Use deterministic resource IDs for GitOps compatibility
5. **Type Safety**: `AlchemyCompatible<T>` type modifier maintains full TypeScript support

### Benefits of This Approach

1. **No Registration Conflicts**: Avoids "Resource already exists" errors by checking before registering
2. **Dynamic Type Inference**: Automatically determines correct alchemy type from TypeKro resource
3. **Deterministic Behavior**: Same configuration always produces same resource IDs
4. **Proper Dependencies**: Alchemy can track dependencies between resource instances
5. **Unified Cleanup**: When alchemy scope is destroyed, all resource instances are cleaned up
6. **State Persistence**: Alchemy manages state across deployments and updates
7. **Type Safety**: Full TypeScript support with proper type modifiers

## Recent Design Improvements (January 2025)

### API Version Handling Clarification

Based on our deep dive into Kro documentation and implementation, we've clarified the distinction between two different API versions:

1. **ResourceGraphDefinition CRD API Version**: Always `kro.run/v1alpha1` (Kro's own API)
2. **Generated Instance CRD API Version**: Specified in the RGD schema as just the version part (e.g., `v1alpha1`), which becomes `kro.run/v1alpha1` for instances

#### Implementation Details

```typescript
// Schema definition now correctly stores just the version part
const schemaDefinition: SchemaDefinition<TSpec, TStatus> = {
  apiVersion: definition.apiVersion || 'v1alpha1',  // Just the version part
  kind: definition.kind,
  spec: definition.spec,
  status: definition.status,
};

// Kro schema generation uses just the version part
const schemaApiVersion = schemaDefinition.apiVersion.includes('/') 
  ? schemaDefinition.apiVersion.split('/')[1] 
  : schemaDefinition.apiVersion;

return {
  apiVersion: schemaApiVersion,  // e.g., 'v1alpha1'
  kind: schemaDefinition.kind,
  spec: specFields,
  status: statusCelExpressions,
};

// Instance creation constructs the full API version
const apiVersion = this.schemaDefinition.apiVersion.includes('/')
  ? this.schemaDefinition.apiVersion  // Already has group prefix
  : `kro.run/${this.schemaDefinition.apiVersion}`;  // Add kro.run group

// Kubernetes API calls use the appropriate format for each API
const version = this.schemaDefinition.apiVersion.includes('/') 
  ? this.schemaDefinition.apiVersion.split('/')[1]
  : this.schemaDefinition.apiVersion;

await customApi.listNamespacedCustomObject(
  'kro.run',    // group
  version,      // just the version part (e.g., 'v1alpha1')
  namespace,
  plural
);
```

### Status Field Separation and Hydration

We've implemented intelligent status field separation that distinguishes between:

1. **Static Fields**: Hydrated directly by TypeKro (no Kubernetes references)
2. **Dynamic Fields**: Resolved by Kro from live Kubernetes resources (contain resource references)

#### Implementation

```typescript
// Status field separation logic
function separateStatusFields(statusMappings: any): { staticFields: Record<string, any>; dynamicFields: Record<string, any> } {
  const staticFields: Record<string, any> = {};
  const dynamicFields: Record<string, any> = {};

  for (const [key, value] of Object.entries(statusMappings)) {
    if (containsKubernetesReference(value)) {
      dynamicFields[key] = value;  // Send to Kro for resolution
    } else {
      staticFields[key] = value;   // Hydrate directly by TypeKro
    }
  }

  return { staticFields, dynamicFields };
}

// Enhanced proxy creation with mixed hydration
const enhancedProxy = {
  apiVersion: instanceApiVersion,
  kind: this.schemaDefinition.kind,
  spec,
  status: {
    ...staticFields,     // Static fields first
    ...liveInstance.status, // Dynamic fields from Kro override
  } as TStatus,
  metadata: {
    name: instanceName,
    namespace: this.namespace,
    // ... metadata
  },
} as unknown as Enhanced<TSpec, TStatus>;
```

### End-to-End Factory Pattern Validation

Our comprehensive e2e test validates the complete workflow:

```typescript
// 1. Static fields are hydrated directly by TypeKro
expect(instance.status.url).toBe('http://test-webapp-service.typekro-test.svc.cluster.local');
expect(instance.status.version).toBe('1.0.0');
expect(instance.status.environment).toBe('e2e-test');

// 2. Dynamic fields are resolved by Kro from live Kubernetes resources
expect(instance.status.phase).toBe('running');
expect(instance.status.replicas).toBe(2);
expect(instance.status.readyReplicas).toBe(2);

// 3. Mixed nested objects work correctly
expect(instance.status.metadata.name).toBe('webapp-factory-e2e'); // static
expect(instance.status.metadata.namespace).toBe('typekro-test');   // dynamic
expect(instance.status.metadata.createdBy).toBe('typekro-factory-e2e'); // static

// 4. Factory instance management works
const allInstances = await kroFactory.getInstances();
expect(allInstances).toHaveLength(1);
```

## Key Design Principles

### 1. **Single Responsibility**
- `ResourceGraph`: Pure resource definition and YAML generation
- `ResourceFactory`: Deployment strategy and instance management
- Clear separation between definition and deployment

### 2. **Configuration Over Convention**
- All deployment behavior configured at factory creation
- No hidden defaults or magic behavior
- Explicit alchemy integration through options

### 3. **Type Safety First**
- ArkType schemas provide runtime validation
- TypeScript inference for compile-time safety
- Proper API version handling without type assertions

### 4. **Intelligent Status Hydration**
- Automatic separation of static vs dynamic status fields
- Static fields hydrated directly by TypeKro for immediate availability
- Dynamic fields resolved by Kro from live Kubernetes resources
- Mixed hydration strategy for optimal performance and accuracy

### 5. **Correct Kro Integration**
- Proper understanding of RGD vs instance API versions
- Correct Kubernetes API usage for different operations
- Full compatibility with Kro controller patterns and expectationsy` casts in production code

### 4. **Consistent API**
- Single `deploy()` method across all factory types
- Consistent return types and error handling
- Uniform instance management interface

### 5. **Extensible Architecture**
- Easy to add new factory modes
- Plugin-style alchemy integration
- Future-proof option system

### 6. **Dynamic Integration**
- Alchemy integration happens at deployment time, not definition time
- Resources are wrapped dynamically based on factory configuration
- No static resource registration that could cause conflicts

## Alchemy Integration Implementation

### Dynamic Resource Type Registration Implementation

The alchemy integration is implemented through a single `ensureResourceTypeRegistered()` function that handles registration on-demand:

```typescript
// Type modifier to make Enhanced types compatible with alchemy
type AlchemyCompatible<T> = T & {
  [ResourceKind]: string;
  [ResourceID]: string;
  [ResourceFQN]: string;
  [ResourceScope]: Scope;
  [ResourceSeq]: number;
  [DestroyStrategy]: DestroyStrategy;
};

// Dynamic registration function
function ensureResourceTypeRegistered<T extends Enhanced<any, any>>(
  resource: T
): Provider<string, any> {
  const alchemyType = inferAlchemyTypeFromTypeKroResource(resource);
  
  // Check if already registered
  if (PROVIDERS.has(alchemyType)) {
    return PROVIDERS.get(alchemyType)!;
  }
  
  // Register new resource type
  return Resource(alchemyType, async function(id: string, props: any) {
    if (this.phase === 'delete') {
      await deleteTypeKroResourceInstance(props);
      return this.destroy();
    }
    
    const deployed = await deployTypeKroResourceInstance(props);
    return this({ ...props, deployed });
  });
}

// Infer alchemy type from TypeKro resource
function inferAlchemyTypeFromTypeKroResource<T extends Enhanced<any, any>>(
  resource: T
): string {
  if (resource.apiVersion === 'kro.run/v1alpha1' && resource.kind === 'ResourceGraphDefinition') {
    return 'kro::ResourceGraphDefinition';
  }
  
  if (resource.apiVersion?.includes('kro.run')) {
    return `kro::${resource.kind}`;
  }
  
  return `kubernetes::${resource.kind}`;
}

class DirectResourceFactory<TSpec, TStatus> {
  private async deployWithAlchemy(
    spec: TSpec,
    instanceName: string,
    resolvedResources: KubernetesResource[]
  ): Promise<Enhanced<TSpec, TStatus>> {
    const deployedResources: Record<string, any> = {};
    
    // Create type-safe alchemy resources for each Kubernetes resource
    for (const [resourceKey, resource] of Object.entries(resolvedResources)) {
      const enhancedResource = this.createEnhancedResource(resource); // Enhanced<any, any>
      const ResourceProvider = ensureResourceTypeRegistered(enhancedResource);
      
      const resourceId = generateDeterministicResourceId(
        resource.kind,
        resource.metadata?.name || resourceKey,
        this.namespace
      );
      
      // Deploy the resource through alchemy with full type safety
      deployedResources[resourceKey] = await ResourceProvider(resourceId, {
        resource: enhancedResource,
        namespace: this.namespace
      });
    }
    
    // Return Enhanced resource that references the alchemy-managed resources
    return this.createEnhancedInstance(spec, instanceName, deployedResources);
  }
}

class KroResourceFactory<TSpec, TStatus> {
  private async deployWithAlchemy(
    spec: TSpec,
    instanceName: string
  ): Promise<Enhanced<TSpec, TStatus>> {
    // 1. Ensure RGD is deployed via alchemy (once per factory)
    if (!this.rgdDeployed) {
      const rgdResource = this.createRGDResource(); // Enhanced<any, any>
      const RGDProvider = ensureResourceTypeRegistered(rgdResource);
      
      const rgdId = generateDeterministicResourceId('ResourceGraphDefinition', this.rgdName, this.namespace);
      await RGDProvider(rgdId, {
        resource: rgdResource,
        namespace: this.namespace
      });
      this.rgdDeployed = true;
    }
    
    // 2. Create instance via alchemy (once per deploy call)
    const crdInstanceResource = this.createCRDInstanceResource(spec, instanceName); // Enhanced<TSpec, TStatus>
    const CRDInstanceProvider = ensureResourceTypeRegistered(crdInstanceResource);
    
    const instanceId = generateDeterministicResourceId(this.schemaDefinition.kind, instanceName, this.namespace);
    const crdInstance = await CRDInstanceProvider(instanceId, {
      resource: crdInstanceResource,
      namespace: this.namespace
    });
    
    // Return Enhanced instance that references the alchemy-managed CRD instance
    return this.createEnhancedInstance(spec, crdInstance);
  }
}
```

### Benefits of This Implementation

1. **No Registration Conflicts**: Avoids "Resource already exists" errors by checking before registering
2. **Dynamic Type Inference**: Automatically determines correct alchemy type from TypeKro resource
3. **Deterministic Resource IDs**: Same configuration always produces same resource IDs
4. **Proper Dependencies**: Alchemy can track dependencies between resource instances
5. **Unified Cleanup**: When alchemy scope is destroyed, all resource instances are cleaned up
6. **State Persistence**: Alchemy manages state across deployments and updates
7. **Type Safety**: Full TypeScript support with proper type modifiers

## Migration Strategy

### 1. Backward Compatibility

The new API is designed to be additive:

```typescript
// Existing code continues to work
const graph = toResourceGraph(name, resources);
const factory = await graph.factory('direct');
const result = await factory.deploy();

// New typed API with definition-first approach
const typedGraph = toResourceGraph(definition, resourceBuilder, statusBuilder);
const typedFactory = await typedGraph.factory('direct', options);
const instance = await typedFactory.deploy(spec);
```

### 2. Clear Migration Path

1. **Phase 1**: Introduce new API alongside existing
2. **Phase 2**: Update documentation to promote new patterns and tests to use new patterns and add examples for each of the patterns
3. **Phase 3**: Remove deprecated APIs since there are no consumers of the current API.
4. **Phase 4**: Add e2e tests for each of these deployment scenarios.

## Benefits

### 1. **Developer Experience**
- Intuitive API that follows natural workflow
- Excellent IDE support with full autocomplete
- Clear error messages with actionable suggestions

### 2. **Type Safety**
- Compile-time validation through TypeScript
- Runtime validation through ArkType schemas
- No type casting required in user code

### 3. **Flexibility**
- Support for both simple and complex use cases
- Multiple deployment strategies with consistent API
- Seamless alchemy integration when needed

### 4. **Maintainability**
- Clean separation of concerns
- Consistent patterns throughout codebase
- Easy to test and extend

This design provides a solid, elegant foundation for kro-less deployment that prioritizes simplicity, type safety, and developer experience.

## Unified Kubernetes Apply Layer

Both DirectResourceFactory and KroResourceFactory use a shared KubernetesApplier for consistent manifest application:

```typescript
// Shared Kubernetes apply layer
class KubernetesApplier {
  constructor(private config: KubeConfig) {}
  
  async apply(manifest: KubernetesResource, options: ApplyOptions): Promise<ApplyResult> {
    // Unified apply logic used by both factories
    // - Consistent retry logic
    // - Unified error handling
    // - Common logging and metrics
    // - Shared timeout configuration
  }
  
  async delete(manifest: KubernetesResource, options: DeleteOptions): Promise<void> {
    // Unified delete logic
  }
}

// DirectFactory uses it directly
class DirectResourceFactory {
  private applier: KubernetesApplier;
  
  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // TypeKro orchestrates the order
    const manifests = this.resolveManifests(spec);
    
    // But uses shared apply layer
    for (const manifest of manifests) {
      await this.applier.apply(manifest, this.applyOptions);
    }
  }
}

// KroFactory also uses it for RGD deployment
class KroResourceFactory {
  private applier: KubernetesApplier;
  
  private async ensureRGDDeployed(): Promise<void> {
    const rgdManifest = this.createRGDManifest();
    
    // Uses same apply layer as DirectFactory
    await this.applier.apply(rgdManifest, this.applyOptions);
    
    // Then kro controller takes over for instances
  }
}
```

This ensures:
- **Consistent Configuration**: Same kubeconfig, timeouts, retry policies
- **Unified Error Handling**: Same error messages and recovery strategies  
- **Common Observability**: Same logging, metrics, and debugging for all applies
- **Predictable Behavior**: Both factories behave identically for Kubernetes operations

## Enhanced Integration Design

### Real Alchemy Provider Integration

The integration with alchemy will use real providers instead of mocks to demonstrate production-ready patterns:

```typescript
// Real alchemy provider usage in tests and examples
import { File } from 'alchemy/fs';
import { lowercaseId } from 'alchemy/util/nanoid';

// Create real file resources
const configFile = await File("app-config", {
  path: "config/app.yaml",
  content: `
    database:
      host: ${database.endpoint}
      port: 5432
    app:
      name: ${schema.spec.name}
      sessionSecret: ${sessionToken}
  `
});

// Generate real random strings
const sessionToken = lowercaseId(48);
const deploymentId = lowercaseId(16);

// Use in TypeKro resources
const webapp = simpleDeployment({
  name: schema.spec.name,
  image: schema.spec.image,
  env: {
    CONFIG_PATH: configFile.path,
    SESSION_SECRET: sessionToken,
    DEPLOYMENT_ID: deploymentId,
  }
});
```

### Alchemy State File Validation

Integration tests will validate that resources are properly registered in alchemy's state management:

```typescript
// State file validation utilities
interface AlchemyStateInspector {
  getRegisteredResources(): Promise<AlchemyResource[]>;
  getResourceDependencies(resourceId: string): Promise<string[]>;
  verifyResourceRegistration(resourceId: string, expectedType: string): Promise<boolean>;
  verifyResourceCleanup(resourceId: string): Promise<boolean>;
}

// Test assertions
describe('Alchemy State Integration', () => {
  it('should register kro resources in alchemy state', async () => {
    const factory = await graph.factory('kro', { alchemyScope });
    const instance = await factory.deploy(spec);
    
    // Verify RGD is registered
    const rgdRegistered = await stateInspector.verifyResourceRegistration(
      factory.rgdName, 
      'kro::ResourceGraphDefinition'
    );
    expect(rgdRegistered).toBe(true);
    
    // Verify instance is registered
    const instanceRegistered = await stateInspector.verifyResourceRegistration(
      instance.metadata.name,
      `kro::${schemaDefinition.kind}`
    );
    expect(instanceRegistered).toBe(true);
    
    // Verify dependencies are tracked
    const dependencies = await stateInspector.getResourceDependencies(instance.metadata.name);
    expect(dependencies).toContain(factory.rgdName);
  });
});
```

### Kro Factory Direct Deployment Architecture

The KroResourceFactory will use DirectDeploymentEngine for RGD deployment while maintaining kro controller functionality:

```typescript
class KroResourceFactory<TSpec, TStatus> {
  private directEngine: DirectDeploymentEngine;
  private kroEngine: KroDeploymentEngine;
  
  constructor(config: FactoryConfig<TSpec, TStatus>) {
    // Use direct engine for RGD deployment
    this.directEngine = new DirectDeploymentEngine(config.kubeConfig);
    // Use kro engine for instance management
    this.kroEngine = new KroDeploymentEngine(config.kubeConfig);
  }
  
  private async ensureRGDDeployed(): Promise<void> {
    if (this.rgdDeployed) return;
    
    // Deploy RGD using direct deployment engine
    const rgdResource = this.createRGDResource();
    const resourceGraph = {
      name: this.rgdName,
      resources: [rgdResource],
      dependencyGraph: { nodes: [rgdResource], edges: [] }
    };
    
    const result = await this.directEngine.deploy(resourceGraph, {
      namespace: this.namespace,
      waitForReady: true,
      timeout: this.options.timeout
    });
    
    if (result.status === 'failed') {
      throw new Error(`RGD deployment failed: ${result.errors.map(e => e.error.message).join(', ')}`);
    }
    
    // Wait for CRD registration
    await this.waitForCRDRegistration();
    this.rgdDeployed = true;
  }
}
```

### Status Field Architecture

The status field system uses separate builder functions for resources and status mappings:

```typescript
// Resource builder function - defines the Kubernetes resources
const resourceBuilder = (schema) => ({
  deployment: simpleDeployment({ ... }),
  service: simpleService({ ... }),
  database: simpleDeployment({ ... }),
});

// Status builder function - receives resources and defines status mappings
const statusBuilder = (schema, resources) => ({
  // Direct resource references (become KubernetesRef at runtime)
  url: resources.service.status.loadBalancer.ingress[0].hostname,
  readyReplicas: resources.deployment.status.availableReplicas,
  
  // CEL expressions for computed values
  phase: Cel.conditional(
    resources.deployment.status.readyReplicas,
    Cel.expr(resources.deployment.status.replicas, ' ? "ready" : "pending"')
  ),
  
  // Nested status objects (supported by Kro schema)
  database: {
    connected: resources.database.status.ready,
    host: resources.database.status.host,
  },
});

// Combined in toResourceGraph call with definition first
const graph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  resourceBuilder,
  statusBuilder
);
```

### Status Serialization and Hydration

The status mappings are serialized to CEL expressions in the RGD schema:

```yaml
# Generated RGD schema
status:
  url: ${service.status.loadBalancer.ingress[0].hostname}
  readyReplicas: ${deployment.status.availableReplicas}
  phase: ${deployment.status.readyReplicas == deployment.status.replicas ? "ready" : "pending"}
  database:
    connected: ${database.status.ready}
    host: ${database.status.host}
```

After deployment, the StatusHydrator waits for resources to be ready and populates Enhanced proxy status fields with actual values:

```typescript
interface StatusHydrator {
  hydrateEnhancedProxy<T extends Enhanced<any, any>>(
    enhanced: T, 
    deployedResources: DeployedResource[]
  ): Promise<void>;
}

class KroResourceFactory<TSpec, TStatus> {
  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // 1. Deploy RGD and create CRD instance
    const instance = await this.createInstance(spec);
    
    // 2. Wait for Kro controller to create underlying resources
    await this.waitForStabilization(instance);
    
    // 3. Hydrate Enhanced proxy with live status values
    await this.statusHydrator.hydrateEnhancedProxy(instance, deployedResources);
    
    return instance;
  }
}
```

### Benefits of User-Defined Status Mappings

This architecture provides several key advantages:

1. **Full User Control**: Users explicitly define how status fields map to resource status, eliminating guesswork
2. **Type Safety**: `MagicAssignableShape<TStatus>` ensures status mappings match the exact shape of the status schema
3. **Magic Proxy Integration**: Leverages existing magic proxy system for seamless developer experience
4. **Nested Object Support**: Supports complex nested status structures as defined in Kro schema specification
5. **CEL Expression Support**: Users can define computed status fields using CEL expressions
6. **No Auto-Generation**: Eliminates the problematic `generateStatusCelExpressions` function that tried to guess mappings
  }
}
```

### Enhanced Integration Testing Architecture

Comprehensive integration tests will validate the complete flow:

```typescript
describe('Complete Alchemy-Kro Integration', () => {
  let alchemyScope: Scope;
  let stateInspector: AlchemyStateInspector;
  
  beforeAll(async () => {
    alchemyScope = await alchemy('integration-test');
    stateInspector = new AlchemyStateInspector(alchemyScope);
  });
  
  it('should demonstrate complete integration flow', async () => {
    // Step 1: Create real alchemy resources
    const configFile = await File("app-config", {
      path: "config/app.yaml",
      content: "database:\n  host: postgres.example.com"
    });
    
    const sessionSecret = lowercaseId(48);
    
    // Step 2: Create TypeKro resource graph
    const graph = toResourceGraph('integration-test', (schema) => ({
      webapp: simpleDeployment({
        name: schema.spec.name,
        image: schema.spec.image,
        env: {
          CONFIG_PATH: configFile.path,
          SESSION_SECRET: sessionSecret,
          DATABASE_URL: schema.spec.databaseUrl,
        }
      })
    }), schemaDefinition);
    
    // Step 3: Deploy with kro factory
    const factory = await graph.factory('kro', {
      alchemyScope,
      namespace: 'integration-test',
      timeout: 120000
    });
    
    const instance = await factory.deploy({
      name: 'test-app',
      image: 'nginx:latest',
      databaseUrl: 'postgresql://postgres.example.com:5432/app'
    });
    
    // Step 4: Validate alchemy state registration
    await stateInspector.verifyResourceRegistration(configFile.id, 'fs::File');
    await stateInspector.verifyResourceRegistration(factory.rgdName, 'kro::ResourceGraphDefinition');
    await stateInspector.verifyResourceRegistration(instance.metadata.name, 'kro::IntegrationTest');
    
    // Step 5: Validate status hydration
    expect(instance.status.url).toBeDefined();
    expect(instance.status.readyReplicas).toBeGreaterThan(0);
    
    // Step 6: Test error handling
    const degradation = await factory.statusMonitor.checkDegradation(instance);
    if (degradation.isDegraded) {
      console.warn('Resource degradation detected:', degradation);
    }
    
    // Step 7: Cleanup and validate state cleanup
    await factory.deleteInstance(instance.metadata.name);
    await stateInspector.verifyResourceCleanup(instance.metadata.name);
  });
  
  it('should handle kro stabilization timeouts', async () => {
    const factory = await graph.factory('kro', {
      alchemyScope,
      timeout: 1000 // Very short timeout
    });
    
    await expect(factory.deploy(spec)).rejects.toThrow(
      /Kro resource failed to stabilize within 1000ms/
    );
  });
  
  it('should validate performance under load', async () => {
    const startTime = Date.now();
    
    // Deploy multiple instances concurrently
    const deployments = Array.from({ length: 10 }, (_, i) => 
      factory.deploy({ ...spec, name: `load-test-${i}` })
    );
    
    const instances = await Promise.all(deployments);
    const duration = Date.now() - startTime;
    
    expect(instances).toHaveLength(10);
    expect(duration).toBeLessThan(60000); // Should complete within 1 minute
    
    // Validate all instances are properly registered
    for (const instance of instances) {
      await stateInspector.verifyResourceRegistration(
        instance.metadata.name, 
        'kro::IntegrationTest'
      );
    }
  });
});
```

## Implementation Strategy

### Phase 1: Real Alchemy Provider Integration
1. Update all integration tests to use real File and nanoid providers
2. Remove all Resource() mock implementations
3. Create comprehensive examples showing real provider usage
4. Validate bidirectional value flow between alchemy and TypeKro

### Phase 2: Alchemy State File Validation
1. Implement AlchemyStateInspector utilities
2. Add state file assertions to all integration tests
3. Validate resource registration, dependencies, and cleanup
4. Create debugging tools for state inspection

### Phase 3: Kro Factory Direct Deployment
1. Modify KroResourceFactory to use DirectDeploymentEngine for RGDs
2. Maintain kro controller functionality for instance management
3. Add proper error handling and rollback for RGD deployment
4. Test end-to-end RGD deployment and instance creation

### Phase 4: Universal Kubernetes Resource Status Monitoring and Output Hydration

This phase expands beyond kro-specific monitoring to provide comprehensive status monitoring and output hydration for all Kubernetes resource types, ensuring consistent behavior across both DirectResourceFactory and KroResourceFactory.

#### Universal Status Monitoring Architecture

```typescript
/**
 * Universal Kubernetes resource status monitor
 * Works with any Kubernetes resource type (Deployment, Service, Pod, PVC, etc.)
 */
export class KubernetesResourceMonitor {
  constructor(
    private kubeApi: KubernetesApi,
    private options: StatusMonitoringOptions = {}
  ) {}

  /**
   * Monitor a resource until it reaches the desired state
   */
  async waitForResourceReady<T extends KubernetesResource>(
    resource: T,
    options?: ResourceMonitoringOptions
  ): Promise<T> {
    const monitor = this.createResourceSpecificMonitor(resource);
    return monitor.waitForReady(resource, options);
  }

  /**
   * Create resource-specific monitor based on resource kind
   */
  private createResourceSpecificMonitor<T extends KubernetesResource>(
    resource: T
  ): ResourceSpecificMonitor<T> {
    switch (resource.kind) {
      case 'Deployment':
        return new DeploymentMonitor(this.kubeApi, this.options);
      case 'Service':
        return new ServiceMonitor(this.kubeApi, this.options);
      case 'Pod':
        return new PodMonitor(this.kubeApi, this.options);
      case 'PersistentVolumeClaim':
        return new PVCMonitor(this.kubeApi, this.options);
      case 'Ingress':
        return new IngressMonitor(this.kubeApi, this.options);
      default:
        // For kro resources or unknown types
        return new GenericResourceMonitor(this.kubeApi, this.options);
    }
  }
}

/**
 * Resource-specific monitoring interface
 */
interface ResourceSpecificMonitor<T extends KubernetesResource> {
  waitForReady(resource: T, options?: ResourceMonitoringOptions): Promise<T>;
  checkReadiness(resource: T): Promise<ResourceReadinessStatus>;
  getStatusSummary(resource: T): Promise<string>;
}

/**
 * Deployment-specific monitoring
 */
class DeploymentMonitor implements ResourceSpecificMonitor<V1Deployment> {
  async waitForReady(deployment: V1Deployment, options?: ResourceMonitoringOptions): Promise<V1Deployment> {
    const timeout = options?.timeout ?? 300000; // 5 minutes default
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const current = await this.kubeApi.getDeployment(deployment.metadata!.name!, deployment.metadata!.namespace!);
      
      // Check if deployment is ready
      if (this.isDeploymentReady(current)) {
        return current;
      }

      // Check for failure conditions
      if (this.isDeploymentFailed(current)) {
        throw new ResourceFailedError(`Deployment ${deployment.metadata!.name} failed to deploy`, current);
      }

      await this.sleep(2000); // Check every 2 seconds
    }

    throw new ResourceTimeoutError(`Deployment ${deployment.metadata!.name} did not become ready within ${timeout}ms`);
  }

  private isDeploymentReady(deployment: V1Deployment): boolean {
    const status = deployment.status;
    if (!status) return false;

    return (
      status.readyReplicas === status.replicas &&
      status.updatedReplicas === status.replicas &&
      status.availableReplicas === status.replicas
    );
  }

  private isDeploymentFailed(deployment: V1Deployment): boolean {
    const conditions = deployment.status?.conditions || [];
    return conditions.some(condition => 
      condition.type === 'Progressing' && 
      condition.status === 'False' && 
      condition.reason === 'ProgressDeadlineExceeded'
    );
  }
}

/**
 * Service-specific monitoring
 */
class ServiceMonitor implements ResourceSpecificMonitor<V1Service> {
  async waitForReady(service: V1Service, options?: ResourceMonitoringOptions): Promise<V1Service> {
    // For LoadBalancer services, wait for external IP
    if (service.spec?.type === 'LoadBalancer') {
      return this.waitForLoadBalancerReady(service, options);
    }
    
    // For other service types, just verify endpoints
    return this.waitForEndpointsReady(service, options);
  }

  private async waitForLoadBalancerReady(service: V1Service, options?: ResourceMonitoringOptions): Promise<V1Service> {
    const timeout = options?.timeout ?? 600000; // 10 minutes for LB
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const current = await this.kubeApi.getService(service.metadata!.name!, service.metadata!.namespace!);
      
      if (current.status?.loadBalancer?.ingress?.length) {
        return current;
      }

      await this.sleep(5000); // Check every 5 seconds for LB
    }

    throw new ResourceTimeoutError(`LoadBalancer service ${service.metadata!.name} did not get external IP within ${timeout}ms`);
  }
}
```

#### Universal Status Hydration Architecture

```typescript
/**
 * Universal status hydrator for all Kubernetes resources
 */
export class StatusHydrator {
  constructor(
    private kubeApi: KubernetesApi,
    private cache: StatusCache = new StatusCache()
  ) {}

  /**
   * Hydrate Enhanced proxy with live status values from cluster
   */
  async hydrateResourceStatus<TSpec, TStatus>(
    enhanced: Enhanced<TSpec, TStatus>,
    options?: HydrationOptions
  ): Promise<Enhanced<TSpec, TStatus>> {
    const liveResource = await this.fetchLiveResource(enhanced);
    const statusExtractor = this.createStatusExtractor(enhanced);
    
    const extractedStatus = await statusExtractor.extractStatus(liveResource);
    
    // Update the Enhanced proxy with live status values
    return this.updateEnhancedProxy(enhanced, extractedStatus);
  }

  /**
   * Create resource-specific status extractor
   */
  private createStatusExtractor<T extends KubernetesResource>(
    resource: T
  ): ResourceStatusExtractor<T> {
    switch (resource.kind) {
      case 'Deployment':
        return new DeploymentStatusExtractor();
      case 'Service':
        return new ServiceStatusExtractor();
      case 'Pod':
        return new PodStatusExtractor();
      case 'PersistentVolumeClaim':
        return new PVCStatusExtractor();
      default:
        // For kro resources, use CEL expression evaluation
        if (resource.apiVersion?.includes('kro.run')) {
          return new KroResourceStatusExtractor();
        }
        return new GenericStatusExtractor();
    }
  }
}

/**
 * Deployment-specific status extraction
 */
class DeploymentStatusExtractor implements ResourceStatusExtractor<V1Deployment> {
  async extractStatus(deployment: V1Deployment): Promise<Record<string, any>> {
    const status = deployment.status || {};
    
    return {
      // Standard Kubernetes status fields
      replicas: status.replicas || 0,
      readyReplicas: status.readyReplicas || 0,
      availableReplicas: status.availableReplicas || 0,
      updatedReplicas: status.updatedReplicas || 0,
      unavailableReplicas: status.unavailableReplicas || 0,
      
      // Computed status fields
      ready: status.readyReplicas === status.replicas,
      phase: this.computePhase(status),
      conditions: status.conditions || [],
      
      // Useful derived fields
      rolloutComplete: status.observedGeneration === deployment.metadata?.generation,
      healthStatus: this.computeHealthStatus(status),
    };
  }

  private computePhase(status: V1DeploymentStatus): string {
    if (!status.replicas) return 'Pending';
    if (status.readyReplicas === status.replicas) return 'Ready';
    if (status.unavailableReplicas) return 'Degraded';
    return 'Progressing';
  }
}

/**
 * Service-specific status extraction
 */
class ServiceStatusExtractor implements ResourceStatusExtractor<V1Service> {
  async extractStatus(service: V1Service): Promise<Record<string, any>> {
    const status = service.status || {};
    
    return {
      // Standard Kubernetes status fields
      loadBalancer: status.loadBalancer,
      
      // Computed status fields
      externalIPs: this.extractExternalIPs(service),
      clusterIP: service.spec?.clusterIP,
      ports: service.spec?.ports || [],
      
      // For LoadBalancer services
      ready: service.spec?.type !== 'LoadBalancer' || !!status.loadBalancer?.ingress?.length,
      phase: this.computePhase(service, status),
      
      // Useful derived fields
      endpoints: await this.getEndpoints(service),
      url: this.computeServiceURL(service),
    };
  }

  private extractExternalIPs(service: V1Service): string[] {
    const ips: string[] = [];
    
    // From LoadBalancer ingress
    const ingress = service.status?.loadBalancer?.ingress || [];
    for (const ing of ingress) {
      if (ing.ip) ips.push(ing.ip);
      if (ing.hostname) ips.push(ing.hostname);
    }
    
    // From spec.externalIPs
    if (service.spec?.externalIPs) {
      ips.push(...service.spec.externalIPs);
    }
    
    return ips;
  }
}
```

#### Integration with Both Factory Types

```typescript
/**
 * Enhanced DirectResourceFactory with universal status monitoring
 */
class DirectResourceFactory<TSpec, TStatus> {
  private statusMonitor: KubernetesResourceMonitor;
  private statusHydrator: StatusHydrator;

  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // 1. Deploy resources using existing logic
    const deployedResources = await this.deployResources(spec);
    
    // 2. Monitor all resources until ready
    const readyResources = await Promise.all(
      deployedResources.map(resource => 
        this.statusMonitor.waitForResourceReady(resource, {
          timeout: this.options.timeout,
          progressCallback: this.options.progressCallback
        })
      )
    );
    
    // 3. Create Enhanced proxy
    const enhanced = this.createEnhancedProxy(spec, readyResources);
    
    // 4. Hydrate with live status values
    return this.statusHydrator.hydrateResourceStatus(enhanced);
  }
}

/**
 * Enhanced KroResourceFactory with universal status monitoring
 */
class KroResourceFactory<TSpec, TStatus> {
  private statusMonitor: KubernetesResourceMonitor;
  private statusHydrator: StatusHydrator;

  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // 1. Ensure RGD is deployed and ready
    await this.ensureRGDReady();
    
    // 2. Create CRD instance
    const crdInstance = await this.createCRDInstance(spec);
    
    // 3. Monitor CRD instance until ready (using kro-specific monitoring)
    const readyCRD = await this.statusMonitor.waitForResourceReady(crdInstance, {
      timeout: this.options.timeout,
      progressCallback: this.options.progressCallback
    });
    
    // 4. Create Enhanced proxy
    const enhanced = this.createEnhancedProxy(spec, readyCRD);
    
    // 5. Hydrate with live status values (using CEL expressions for kro resources)
    return this.statusHydrator.hydrateResourceStatus(enhanced);
  }
}
```

### Phase 5: Enhanced Integration Testing
1. Create comprehensive real-cluster integration tests for universal status monitoring
2. Add performance and reliability testing for status hydration
3. Update examples to demonstrate complete status monitoring integration
4. Create troubleshooting guides and documentation for all resource types

This enhanced design ensures that TypeKro provides production-ready status monitoring and output hydration for all Kubernetes resource types, not just kro resources, creating a consistent and powerful developer experience across both deployment modes.