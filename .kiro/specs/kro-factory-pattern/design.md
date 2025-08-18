# TypeKro Factory Pattern: Some proposed changes
**Version**: 1.0
**Last Updated**: 2025-07-25

## 1. Overview

This document outlines the design for the TypeKro Factory Pattern, a significant enhancement to the TypeKro library. The primary goal is to enable developers to define, compose, and deploy type-safe Kubernetes Custom Resource Definitions (CRDs) using a powerful factory model.

This design supersedes the original `toKroResourceGraph()` function's behavior of returning a simple YAML string. It introduces a more robust, type-safe, and extensible system built around a builder function pattern and a two-resource deployment model for integration with orchestration tools like Alchemy.

The guiding principle is **end-to-end type safety**. From defining a CRD's schema to referencing its status fields in another resource, the entire workflow is designed to be validated by the TypeScript compiler, eliminating a large class of common configuration errors.

## 2. Core Concepts

### 2.1. The Schema Proxy

The cornerstone of the new design is the "Schema Proxy". Instead of developers building a static object of resources, they now provide a **builder function** to `toKroResourceGraph`. This function receives a `schema` argument, which is a `MagicProxy` object.

When a developer accesses a property on this proxy, such as `schema.spec.name`, it doesn't return a value. Instead, it returns a `KubernetesRef` object. The TypeKro serialization engine is specifically designed to recognize these special schema references and translate them into the appropriate Kro template expression (e.g., `'${schema.spec.name}'`) in the final `ResourceGraphDefinition` YAML.

This powerful mechanism achieves two key goals:
* It removes the need for error-prone, string-based templating.
* It makes the internal definition of a `ResourceGraphDefinition` just as type-safe as the composition between different external resources.

### 2.2. Two-Resource Alchemy Integration

To cleanly manage the lifecycle of a custom resource, the deployment model for orchestrators like Alchemy is split into two distinct resources:

1.  **`KroResourceGraphDefinition`**: A simple resource whose sole responsibility is to deploy the `ResourceGraphDefinition` YAML to the Kubernetes cluster. This action creates the CRD itself.
2.  **`KroCrdInstance`**: A more complex resource that represents a single, live instance of that CRD. It handles the "apply and wait" logic: applying the instance manifest and then polling the cluster until the resource's status fields are populated or a timeout is reached.

This decoupled approach ensures that state management is clean and that the logic for each part of the lifecycle is self-contained and easier to manage.

## 3. Components and Interfaces

### 3.1. Core Types

These types are central to the factory pattern and are defined in `types.ts`.

```typescript
// From: types.ts

/**
 * A proxy that provides type-safe access to a resource's fields,
 * returning a KubernetesRef for any accessed property.
 */
export type MagicProxy<T> = T & {
    [key: string]: KubernetesRef<any>;
};

/**
 * The user-facing type for a schema proxy. It enables type-safe
 * access to the spec and status fields of the CRD being defined.
 */
export type SchemaProxy<TSpec, TStatus> = {
  spec: MagicProxy<TSpec>;
  status: MagicProxy<TStatus>;
};

/**
 * The signature for the builder function that developers provide.
 * It takes the schema proxy and returns the set of resources for the graph.
 */
type ResourceBuilder<TSpec, TStatus> = (
  schema: SchemaProxy<TSpec, TStatus>
) => Record<string, KubernetesResource | Enhanced<any, any>>;

/**
 * The enhanced return type for toKroResourceGraph. This is the factory object
 * that holds the definition, schema, and utility methods.
 */
export interface TypedResourceGraphFactory<TSpec, TStatus> {
  /**
   * Creates a typed instance of the CRD defined by this ResourceGraphDefinition.
   */
  getInstance(spec: TSpec): Enhanced<TSpec, TStatus>;
  
  /**
   * Generates the ResourceGraphDefinition YAML string.
   */
  toYaml(): string;
  
  /**
   * A proxy object for creating type-safe references to the CRD's own schema.
   */
  schema: SchemaProxy<TSpec, TStatus>;
  
  /**
   * The underlying ResourceGraphDefinition object.
   */
  definition: TypedKroResourceGraphDefinition<TSpec, TStatus>;
}
````

### 3.2. `toKroResourceGraph` Function

This is the main entry point for creating a resource factory. Its signature is updated to accept the builder function.

```typescript
// Main factory function signature

function toKroResourceGraph<TSpec, TStatus>(
  name: string,
  // The second argument is now a builder function, not a static object.
  builder: ResourceBuilder<TSpec, TStatus>,
  schemaDefinition: {
    apiVersion: string;
    kind: string;
    spec: TSpec;
    status: TStatus;
  }
): TypedResourceGraphFactory<TSpec, TStatus>;
```

### 3.3. `externalRef` Function

This function for referencing external resources remains a core part of the composition model. Its design is unchanged.

```typescript
// From: design.md

// Creates a type-safe reference to an external CRD instance for composition.
function externalRef<TSpec, TStatus>(
  apiVersion: string,
  kind: string,
  instanceName: string,
  namespace?: string
): Enhanced<TSpec, TStatus> {
  const resource: KubernetesResource<TSpec, TStatus> = {
    apiVersion,
    kind,
    metadata: { 
      name: instanceName,
      ...(namespace && { namespace })
    },
    spec: {} as TSpec,
    status: {} as TStatus,
    // A special flag for the serialization engine.
    __externalRef: true
  };
  
  return createResource(resource);
}
```

## 4\. Deployment and Execution Model (Alchemy)

### 4.1. Alchemy Resource 1: `KroResourceGraphDefinition`

This resource is a lean deployer for the CRD. It applies the definition and returns a factory function for creating instances of the second resource.

```typescript
// From: design.md

export const KroResourceGraphDefinition = Resource(
  "kro::ResourceGraphDefinition",
  async function<TSpec, TStatus>(
    this: Context<any>,
    id: string,
    props: { factory: TypedResourceGraphFactory<TSpec, TStatus>; namespace?: string }
  ): Promise<(instanceProps: { name: string; spec: TSpec; timeout?: number }) => Promise<Enhanced<TSpec, TStatus>>> {

    // On 'create' or 'update', apply the RGD manifest to the cluster.
    const rgdYaml = props.factory.toYaml();
    await this.k8s.apply(rgdYaml);

    // Persist minimal state about what was deployed.
    this.state.rgdName = props.factory.definition.metadata.name;
    this.state.crdSchema = props.factory.schema;

    // Return an async factory function for creating live instances.
    return async (instanceProps) => {
      // This function invokes the second Alchemy resource.
      return KroCrdInstance(instanceProps.name, {
        spec: instanceProps.spec,
        schema: props.factory.schema,
        namespace: props.namespace || 'default',
        timeout: instanceProps.timeout || 30000 // Default 30s timeout
      });
    };
  }
);
```

### 4.2. Alchemy Resource 2: `KroCrdInstance`

This resource manages the lifecycle of a single CRD instance and contains the core "apply and wait" logic.

```typescript
// From: design.md

export const KroCrdInstance = Resource(
  "kro::CrdInstance",
  async function<TSpec, TStatus>(
    this: Context<any>,
    id: string, // The name of the instance, e.g., "my-database-1"
    props: {
      spec: TSpec;
      schema: { apiVersion: string; kind: string };
      namespace: string;
      timeout: number;
    }
  ): Promise<Enhanced<TSpec, TStatus>> {
    
    // 1. Instantiate a Kubernetes client using connection details
    //    from the orchestrator's context.
    const k8sClient = new K8sClient(this.context.kubeConfig);

    // 2. Define and apply the CRD instance manifest.
    const instanceManifest = {
      apiVersion: props.schema.apiVersion,
      kind: props.schema.kind,
      metadata: { name: id, namespace: props.namespace },
      spec: props.spec
    };
    await k8sClient.apply(instanceManifest);

    // 3. Begin polling for the resource's status to be populated.
    const startTime = Date.now();
    let liveStatus: TStatus | undefined = undefined;

    while (Date.now() - startTime < props.timeout) {
      const instance = await k8sClient.get(props.schema.apiVersion, props.schema.kind, id, props.namespace);
      // Check that status exists and is not empty.
      if (instance.status && Object.keys(instance.status).length > 0) {
          liveStatus = instance.status as TStatus;
          break; // Success: status is available.
      }
      // Wait before the next poll.
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (!liveStatus) {
      throw new CRDInstanceError(`Timeout after ${props.timeout}ms waiting for status on instance '${id}'`, /* ... */);
    }

    // 4. Return a final, "resolved" proxy containing the live status.
    const finalResource = { ...instanceManifest, status: liveStatus };
    return createResolvedProxy(finalResource);
  }
);
```

## 5\. Error Handling

To provide clear, actionable feedback during deployment, the system uses custom error types that extend the base `TypeKroError`.

```typescript
// From: errors.ts

export class ResourceGraphFactoryError extends TypeKroError {
  constructor(
    message: string,
    public readonly factoryName: string,
    public readonly operation: 'deployment' | 'getInstance' | 'cleanup',
    public readonly cause?: Error
  ) {
    super(message, 'RESOURCE_GRAPH_FACTORY_ERROR', { factoryName, operation, cause });
    this.name = 'ResourceGraphFactoryError';
  }
}

export class CRDInstanceError extends TypeKroError {
  constructor(
    message: string,
    public readonly apiVersion: string,
    public readonly kind: string,
    public readonly instanceName: string,
    public readonly operation: 'creation' | 'deletion' | 'statusResolution',
    public readonly cause?: Error
  ) {
    super(message, 'CRD_INSTANCE_ERROR', { apiVersion, kind, instanceName, operation, cause });
    this.name = 'CRDInstanceError';
  }
}
```

These errors are thrown in specific scenarios:

  * `ResourceGraphFactoryError`: Thrown if the `ResourceGraphDefinition` YAML itself fails to be applied to the cluster.
  * `CRDInstanceError`: Thrown with `operation: 'creation'` if the instance manifest fails to apply, or with `operation: 'statusResolution'` if the polling logic times out waiting for a status.

## 6\. Example Usage

This complete example demonstrates the end-to-end workflow, from defining a factory with the type-safe builder to deploying it with Alchemy.

```typescript
import alchemy from 'alchemy';
import { toKroResourceGraph, simpleDeployment, simpleService, externalRef } from 'typekro';

// 1. Define TypeScript interfaces for the CRD schemas
interface DatabaseSpec { name: string; storage: string; }
interface DatabaseStatus { connectionString: string; host: string; port: number; }

interface WebAppSpec { name: string; image: string; }
interface WebAppStatus { url: string; replicas: number; }

// 2. Create a factory for the 'Database' CRD using the builder function
const dbFactory = toKroResourceGraph('database-stack', (schema) => ({
  // The resources are defined within the builder function's scope
  deployment: simpleDeployment({
    // Type-safe reference to the schema's spec field
    name: schema.spec.name,
    image: 'postgres:13',
    env: {
      POSTGRES_DB: schema.spec.name,
      POSTGRES_PASSWORD: 'secure-password'
    }
  }),
  service: simpleService({
    name: schema.spec.name,
    selector: { app: schema.spec.name },
    ports: [{ port: 5432, targetPort: 5432 }]
  })
}), {
  // The definition of the CRD schema
  apiVersion: '[example.com/v1alpha1](https://example.com/v1alpha1)',
  kind: 'Database',
  spec: {} as DatabaseSpec,
  status: {} as DatabaseStatus
});

// 3. Create a factory for the 'WebApp' CRD, which depends on a 'Database'
const webappFactory = toKroResourceGraph('webapp-stack', (schema) => {
  // Create an external reference to a Database instance
  const database = externalRef<DatabaseSpec, DatabaseStatus>('[example.com/v1alpha1](https://example.com/v1alpha1)', 'Database', 'my-production-db');

  return {
    database: database, // The external resource is part of the graph
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        // Type-safe reference to the external resource's status
        DATABASE_URL: database.status.connectionString
      }
    }),
    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    })
  };
}, {
  apiVersion: '[example.com/v1alpha1](https://example.com/v1alpha1)',
  kind: 'WebApp',
  spec: {} as WebAppSpec,
  status: {} as WebAppStatus
});

// 4. Use the Alchemy orchestrator to deploy the definitions and create instances
async function deploy() {
  const app = await alchemy('my-infrastructure');

  // Deploy the RGDs and get back the instance factory functions
  const createDatabase = await KroResourceGraphDefinition("database-rgd", { factory: dbFactory });
  const createWebApp = await KroResourceGraph-definition("webapp-rgd", { factory: webappFactory });

  // Use the factory functions to create live instances.
  // This triggers the "apply and wait" logic in the KroCrdInstance resource.
  const myDB = await createDatabase({ name: "my-production-db", spec: { name: "my-production-db", storage: "50Gi" }, timeout: 60000 });
  const myApp = await createWebApp({ name: "my-frontend-app", spec: { name: "my-frontend-app", image: "nginx:latest" } });

  await app.finalize();

  // The returned objects have their status fields resolved
  console.log(`Database is ready. Host: ${myDB.status.host}`);
  console.log(`WebApp is ready. URL: ${myApp.status.url}`);
}

deploy();
```