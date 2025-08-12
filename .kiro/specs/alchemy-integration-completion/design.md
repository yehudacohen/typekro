# Design Document

## Overview

This design document outlines the implementation approach for completing the Alchemy integration in TypeKro to achieve comprehensive resource registration and management across both deployment modes. The goal is to ensure that:

**For Kro deployment mode:** Each RGD gets one Alchemy resource type registered, and each instance of each RGD gets a separate Alchemy resource registered.

**For Direct deployment mode:** Each individual Kubernetes resource in the resource graph gets its own Alchemy resource type registered (derived from the Kubernetes kind), and each instance of each resource gets a separate Alchemy resource registered.

This design will implement individual resource registration patterns, complete the AlchemyDeploymentStrategy implementation, and ensure consistent resource management across both deployment modes.

## Architecture

### Current State Analysis

#### Working Implementation: KroResourceFactory
The KroResourceFactory has a complete Alchemy integration that follows the desired pattern:

```typescript
// In KroResourceFactoryImpl.deployWithAlchemy()
// 1. Register RGD type (one per factory)
const RGDProvider = ensureResourceTypeRegistered(rgdManifest as any);
const rgdId = createAlchemyResourceId(rgdManifest as any, this.namespace);

await RGDProvider(rgdId, {
  resource: rgdManifest as any,
  namespace: this.namespace,
  deployer: deployer,
  options: { waitForReady: true, timeout: 60000 },
});

// 2. Register CRD instance type (one per instance)
const CRDInstanceProvider = ensureResourceTypeRegistered(crdInstanceManifest as any);
const instanceId = createAlchemyResourceId(crdInstanceManifest as any, this.namespace);

await CRDInstanceProvider(instanceId, {
  resource: crdInstanceManifest as any,
  namespace: this.namespace,
  deployer: deployer,
  options: { waitForReady: true, timeout: 300000 },
});
```

This correctly implements:
- One RGD resource type registration per factory
- One instance resource registration per deploy call

#### Incomplete Implementation: DirectResourceFactory
The DirectResourceFactory's AlchemyDeploymentStrategy currently has:
- TODO comment in `executeDeployment` method
- Mock `DeploymentResult` return value
- No individual resource registration logic
- Missing resource type inference based on Kubernetes kind

### Design Goals

1. **Implement Individual Resource Registration**: Each Kubernetes resource in a resource graph gets its own Alchemy resource type registration
2. **Consistent Resource Type Naming**: Use patterns like `kubernetes::Deployment`, `kro::WebApp` based on resource kind
3. **Complete AlchemyDeploymentStrategy**: Replace the TODO and mock result with actual individual resource deployment logic
4. **Resource Type Inference**: Automatically infer Alchemy resource types from Kubernetes kind fields
5. **Maintain Consistency**: Follow the same patterns as KroResourceFactory's Alchemy integration but adapted for individual resources
6. **Preserve Architecture**: Work within the existing strategy pattern and template method design
7. **Ensure Testability**: Design for comprehensive testing without mocking Alchemy dependencies

## Components and Interfaces

### 1. Individual Resource Registration System

The core enhancement is to register each individual Kubernetes resource as a separate Alchemy resource:

```typescript
export class AlchemyDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType
> extends BaseDeploymentStrategy<TSpec, TStatus> {
  
  protected async executeDeployment(
    spec: TSpec,
    instanceName: string
  ): Promise<DeploymentResult> {
    try {
      // 1. Validate alchemy scope
      validateAlchemyScope(this.alchemyScope, 'Alchemy deployment');

      // 2. Import dynamic registration functions
      const { ensureResourceTypeRegistered, DirectTypeKroDeployer, createAlchemyResourceId } = 
        await import('../../alchemy/deployment.js');

      // 3. Create DirectTypeKroDeployer instance
      const deployer = new DirectTypeKroDeployer(this.getDeploymentEngine());

      // 4. Get resource graph for this instance
      const resourceGraph = this.createResourceGraphForInstance(spec, instanceName);

      // 5. Register and deploy each individual resource
      const deployedResources = [];
      for (const resource of resourceGraph.resources) {
        // Infer Alchemy resource type from Kubernetes kind
        const alchemyResourceType = this.inferAlchemyResourceType(resource.manifest);
        
        // Register resource type dynamically (shared across instances)
        const ResourceProvider = ensureResourceTypeRegistered(resource.manifest, alchemyResourceType);
        
        // Create unique resource ID for this instance
        const resourceId = createAlchemyResourceId(resource.manifest, this.namespace);

        // Deploy individual resource through Alchemy
        await ResourceProvider(resourceId, {
          resource: resource.manifest,
          namespace: this.namespace,
          deployer: deployer,
          options: {
            waitForReady: this.factoryOptions.waitForReady ?? true,
            timeout: this.factoryOptions.timeout ?? 300000,
          },
        });

        deployedResources.push({
          ...resource,
          alchemyResourceId: resourceId,
          alchemyResourceType: alchemyResourceType,
        });
      }

      // 6. Return actual deployment result with individual resource tracking
      return this.createDeploymentResultFromIndividualResources(deployedResources, instanceName);
      
    } catch (error) {
      handleDeploymentError(error, 'Alchemy deployment failed');
    }
  }

  /**
   * Infer Alchemy resource type from Kubernetes resource
   */
  private inferAlchemyResourceType(resource: KubernetesResource): string {
    // Use kubernetes:: prefix with the resource kind
    return `kubernetes::${resource.kind}`;
  }
}
```

### 2. Resource Type Inference and Registration

The system will automatically infer Alchemy resource types and handle registration:

```typescript
interface ResourceTypeInference {
  /**
   * Infer Alchemy resource type from Kubernetes resource
   */
  inferAlchemyResourceType(resource: KubernetesResource): string;
  
  /**
   * Create resource graph for individual resource deployment
   */
  createResourceGraphForInstance(spec: TSpec, instanceName: string): ResourceGraph;
  
  /**
   * Register individual resource type with Alchemy
   */
  registerIndividualResourceType(
    resource: KubernetesResource, 
    alchemyResourceType: string
  ): Promise<AlchemyResourceProvider>;
  
  /**
   * Create deployment result from individual resource deployments
   */
  createDeploymentResultFromIndividualResources(
    deployedResources: DeployedResource[], 
    instanceName: string
  ): DeploymentResult;
}

// Resource type naming patterns
const RESOURCE_TYPE_PATTERNS = {
  // Direct mode: kubernetes::{Kind}
  kubernetes: (kind: string) => `kubernetes::${kind}`,
  
  // Kro mode: kro::{Kind} or kro::ResourceGraphDefinition
  kro: (kind: string) => `kro::${kind}`,
  kroRgd: () => 'kro::ResourceGraphDefinition',
};
```

### 3. Enhanced Alchemy Resource Registration

The system will enhance the existing `ensureResourceTypeRegistered` function to handle individual Kubernetes resources:

```typescript
// Enhanced registration function
export function ensureResourceTypeRegistered<T extends KubernetesResource>(
  resource: T,
  alchemyResourceType?: string
): AlchemyResourceProvider {
  // Infer type if not provided
  const resourceType = alchemyResourceType || inferAlchemyTypeFromKubernetesResource(resource);

  // Check if already registered
  if (REGISTERED_TYPES.has(resourceType)) {
    return REGISTERED_TYPES.get(resourceType)!;
  }

  // Register new resource type following alchemy's pattern
  const ResourceProvider = Resource(
    resourceType,
    async function (
      this: Context<AlchemyKubernetesResource<T>>,
      _id: string,
      props: KubernetesResourceProps<T>
    ): Promise<AlchemyKubernetesResource<T>> {
      if (this.phase === 'delete') {
        await props.deployer.delete(props.resource, {
          mode: 'alchemy' as const,
          namespace: props.namespace,
          ...props.options
        });
        return this.destroy();
      }

      // Deploy individual Kubernetes resource
      const deployedResource = await props.deployer.deploy(props.resource, {
        mode: 'alchemy' as const,
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
        resourceType: resourceType,
      });
    }
  );

  REGISTERED_TYPES.set(resourceType, ResourceProvider);
  return ResourceProvider;
}

// Type inference for Kubernetes resources
export function inferAlchemyTypeFromKubernetesResource<T extends KubernetesResource>(
  resource: T
): string {
  // Use kubernetes:: prefix with the resource kind
  return `kubernetes::${resource.kind}`;
}
```

### 4. Consistent Registration Patterns Across Modes

The system will ensure consistent patterns between Kro and Direct modes:

```typescript
// Kro Mode Registration Pattern (existing)
class KroResourceFactory {
  private async deployWithAlchemy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // 1. Register RGD type (one per factory)
    const RGDProvider = ensureResourceTypeRegistered(rgdManifest, 'kro::ResourceGraphDefinition');
    await RGDProvider(rgdId, { resource: rgdManifest, namespace, deployer, options });

    // 2. Register instance type (one per deploy call)
    const InstanceProvider = ensureResourceTypeRegistered(instanceManifest, `kro::${this.schemaDefinition.kind}`);
    await InstanceProvider(instanceId, { resource: instanceManifest, namespace, deployer, options });
  }
}

// Direct Mode Registration Pattern (new)
class AlchemyDeploymentStrategy {
  protected async executeDeployment(spec: TSpec, instanceName: string): Promise<DeploymentResult> {
    const resourceGraph = this.createResourceGraphForInstance(spec, instanceName);
    
    // Register each individual Kubernetes resource
    for (const resource of resourceGraph.resources) {
      const resourceType = `kubernetes::${resource.manifest.kind}`;
      const ResourceProvider = ensureResourceTypeRegistered(resource.manifest, resourceType);
      const resourceId = createAlchemyResourceId(resource.manifest, this.namespace);
      
      await ResourceProvider(resourceId, {
        resource: resource.manifest,
        namespace: this.namespace,
        deployer: this.deployer,
        options: this.deploymentOptions,
      });
    }
  }
}

// Comparison:
// Kro Mode: RGD (1) + Instance (1) = 2 Alchemy resources per deploy
// Direct Mode: Individual K8s resources (N) = N Alchemy resources per deploy
```

## Data Models

### 1. Individual Resource Registration Structure

The structure for registering individual Kubernetes resources with Alchemy:

```typescript
interface AlchemyKubernetesResource<T extends KubernetesResource> extends AlchemyResource<string> {
  /**
   * The original Kubernetes resource
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

  /**
   * The Alchemy resource type (e.g., 'kubernetes::Deployment')
   */
  resourceType: string;
}

interface KubernetesResourceProps<T extends KubernetesResource> {
  /**
   * The Kubernetes resource to deploy
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
```

### 2. Individual Resource Deployment Result

The DeploymentResult structure enhanced for individual resource tracking:

```typescript
interface IndividualResourceDeploymentResult extends DeploymentResult {
  deploymentId: string;
  resources: Array<{
    id: string;
    kind: string;
    name: string;
    namespace: string;
    manifest: KubernetesResource;
    status: 'deployed' | 'pending' | 'failed';
    deployedAt: Date;
    alchemyResourceId: string;
    alchemyResourceType: string; // e.g., 'kubernetes::Deployment'
  }>;
  dependencyGraph: DependencyGraph;
  duration: number;
  status: 'success' | 'failed' | 'partial';
  errors: Array<{
    resourceId: string;
    error: Error;
    phase: string;
    alchemyResourceType?: string;
  }>;
  alchemyMetadata: {
    scope: string;
    registeredTypes: string[]; // All unique resource types registered
    resourceIds: string[]; // All individual resource IDs
    totalResources: number; // Total number of individual resources
  };
}

// Resource type registry tracking
interface ResourceTypeRegistry {
  // Map of resource type to registration count
  registeredTypes: Map<string, number>;
  
  // Map of resource ID to resource type
  resourceIdToType: Map<string, string>;
  
  // Track which types are shared across deployments
  sharedTypes: Set<string>;
}
```

### 3. Resource Type Naming and Inference

Consistent naming patterns and inference logic:

```typescript
// Resource type naming patterns
const RESOURCE_TYPE_PATTERNS = {
  // Direct mode patterns
  KUBERNETES_DEPLOYMENT: 'kubernetes::Deployment',
  KUBERNETES_SERVICE: 'kubernetes::Service',
  KUBERNETES_CONFIGMAP: 'kubernetes::ConfigMap',
  KUBERNETES_SECRET: 'kubernetes::Secret',
  KUBERNETES_INGRESS: 'kubernetes::Ingress',
  
  // Kro mode patterns
  KRO_RGD: 'kro::ResourceGraphDefinition',
  KRO_WEBAPP: 'kro::WebApp',
  KRO_DATABASE: 'kro::Database',
  
  // Generic pattern generators
  kubernetes: (kind: string) => `kubernetes::${kind}`,
  kro: (kind: string) => `kro::${kind}`,
};

// Resource type inference logic
interface ResourceTypeInferenceConfig {
  /**
   * Primary source for resource type inference
   */
  primarySource: 'kind' | 'factory' | 'apiVersion';
  
  /**
   * Fallback sources if primary is not available
   */
  fallbackSources: Array<'kind' | 'factory' | 'apiVersion'>;
  
  /**
   * Custom type mappings for special cases
   */
  customMappings: Map<string, string>;
  
  /**
   * Validation rules for resource type names
   */
  validationRules: {
    maxLength: number;
    allowedCharacters: RegExp;
    reservedNames: string[];
  };
}
```

## Error Handling

### 1. Alchemy Scope Validation

```typescript
function validateAlchemyScope(scope: Scope | undefined, context: string): void {
  if (!scope) {
    throw new Error(`${context}: Alchemy scope is required but not provided`);
  }
  
  if (!scope.name) {
    throw new Error(`${context}: Alchemy scope must have a name`);
  }
  
  if (typeof scope.run !== 'function') {
    throw new Error(`${context}: Alchemy scope must have a run method`);
  }
}
```

### 2. Deployment Error Handling

```typescript
function handleAlchemyDeploymentError(error: unknown, context: string): never {
  if (error instanceof Error) {
    if (error.message.includes('Resource already exists')) {
      throw new Error(`${context}: Resource type already registered. This may indicate a naming conflict or duplicate registration.`);
    }
    
    if (error.message.includes('timeout')) {
      throw new Error(`${context}: Deployment timed out. Check resource readiness and cluster connectivity.`);
    }
    
    if (error.message.includes('not found')) {
      throw new Error(`${context}: Required resource or dependency not found. Ensure all dependencies are deployed.`);
    }
  }
  
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}
```

### 3. Resource Registration Error Handling

```typescript
function handleResourceRegistrationError(error: unknown, resourceType: string): never {
  if (error instanceof Error) {
    if (error.message.includes('already registered')) {
      // This is expected behavior - ensureResourceTypeRegistered handles this
      return;
    }
    
    if (error.message.includes('invalid type')) {
      throw new Error(`Resource registration failed: Invalid resource type '${resourceType}'. Check resource structure and metadata.`);
    }
  }
  
  throw new Error(`Resource registration failed for '${resourceType}': ${error instanceof Error ? error.message : String(error)}`);
}
```

## Testing Strategy

### 1. Unit Tests for AlchemyDeploymentStrategy

```typescript
describe('AlchemyDeploymentStrategy', () => {
  describe('executeDeployment', () => {
    it('should perform actual deployment using DirectTypeKroDeployer', async () => {
      // Test actual deployment logic without mocking
      const strategy = createAlchemyDeploymentStrategy();
      const spec = { name: 'test-app', image: 'nginx' };
      const result = await strategy.executeDeployment(spec, 'test-instance');
      
      expect(result.status).toBe('success');
      expect(result.resources).toHaveLength(1);
      expect(result.deploymentId).toBeDefined();
    });
    
    it('should handle deployment failures gracefully', async () => {
      // Test error handling without mocking the underlying systems
      const strategy = createAlchemyDeploymentStrategyWithInvalidConfig();
      const spec = { name: 'test-app', image: 'nginx' };
      
      await expect(strategy.executeDeployment(spec, 'test-instance'))
        .rejects.toThrow('Alchemy deployment failed');
    });
  });
});
```

### 2. Integration Tests with Real Alchemy

Following the pattern from `typekro-alchemy-integration.test.ts`:

```typescript
describe('AlchemyDeploymentStrategy Integration', () => {
  let alchemyScope: any;

  beforeAll(async () => {
    const { FileSystemStateStore } = await import('alchemy/state');
    alchemyScope = await alchemy('alchemy-deployment-strategy-test', {
      stateStore: (scope) => new FileSystemStateStore(scope, { 
        rootDir: './temp/.alchemy' 
      })
    });
  });

  it('should deploy resources through real Alchemy system', async () => {
    await alchemyScope.run(async () => {
      // Create DirectResourceFactory with Alchemy integration
      const factory = await createDirectResourceFactoryWithAlchemy({
        alchemyScope,
        namespace: 'test-namespace'
      });
      
      // Deploy instance through AlchemyDeploymentStrategy
      const instance = await factory.deploy({
        name: 'test-app',
        image: 'nginx:latest'
      });
      
      // Validate deployment through Alchemy state
      const alchemyState = await alchemyScope.state.all();
      const deployedResources = Object.values(alchemyState).filter(
        (state: any) => state.kind.includes('kubernetes::')
      );
      
      expect(deployedResources).toHaveLength(1);
      expect(instance.metadata?.name).toBe('test-app');
    });
  });
});
```

### 3. Error Scenario Tests

```typescript
describe('AlchemyDeploymentStrategy Error Handling', () => {
  it('should validate Alchemy scope before deployment', async () => {
    const strategy = new AlchemyDeploymentStrategy(
      'test-factory',
      'test-namespace',
      schemaDefinition,
      factoryOptions,
      undefined, // No alchemy scope
      baseStrategy
    );
    
    await expect(strategy.executeDeployment(spec, 'test-instance'))
      .rejects.toThrow('Alchemy scope is required');
  });
  
  it('should handle resource registration conflicts', async () => {
    // Test with real Alchemy scope that has conflicting registrations
    await alchemyScope.run(async () => {
      // Pre-register a conflicting resource type
      const { ensureResourceTypeRegistered } = await import('../../alchemy/deployment.js');
      ensureResourceTypeRegistered(conflictingResource);
      
      // Attempt deployment - should handle gracefully
      const result = await strategy.executeDeployment(spec, 'test-instance');
      expect(result.status).toBe('success');
    });
  });
});
```

## Implementation Phases

### Phase 1: Individual Resource Registration System (High Priority)

1. **Resource Type Inference Implementation**
   - Implement `inferAlchemyResourceType` function for Kubernetes resources
   - Add resource type naming patterns (`kubernetes::Deployment`, etc.)
   - Create validation logic for resource type names

2. **Enhanced Resource Registration**
   - Extend `ensureResourceTypeRegistered` to handle individual Kubernetes resources
   - Implement resource type registry tracking
   - Add support for shared resource types across deployments

3. **AlchemyDeploymentStrategy Core Logic**
   - Replace TODO comment with individual resource registration logic
   - Implement resource graph processing for individual resources
   - Add proper error handling for individual resource failures

### Phase 2: Deployment Result and Tracking (High Priority)

1. **Individual Resource Deployment Results**
   - Implement `createDeploymentResultFromIndividualResources` method
   - Add tracking for individual resource IDs and types
   - Include Alchemy metadata for resource type registry

2. **Resource Lifecycle Management**
   - Implement proper cleanup for individual resources
   - Add support for resource updates and status tracking
   - Handle partial deployment failures gracefully

3. **Integration with DirectTypeKroDeployer**
   - Ensure proper integration with existing deployer interface
   - Add support for individual resource deployment options
   - Validate resource readiness checking for individual resources

### Phase 3: Testing and Validation (High Priority)

1. **Individual Resource Registration Tests**
   - Write unit tests for resource type inference
   - Test resource registration for each Kubernetes resource type
   - Validate resource type naming patterns and uniqueness

2. **Integration Tests with Real Alchemy**
   - Create integration tests following existing Alchemy test patterns
   - Use real Alchemy scope and providers (no mocking)
   - Validate individual resource creation and state tracking

3. **Error Handling and Edge Cases**
   - Test resource registration conflicts and resolution
   - Validate error handling for individual resource failures
   - Test partial deployment scenarios and cleanup

## Migration Strategy

### From Mock to Real Implementation

1. **Backward Compatibility**
   - The change is internal to AlchemyDeploymentStrategy
   - No changes to public APIs or interfaces
   - Existing DirectResourceFactory usage remains unchanged

2. **Testing Migration**
   - Update any tests that relied on mock behavior
   - Ensure all tests use real Alchemy integration
   - Validate that test performance remains acceptable

3. **Deployment Validation**
   - Test with real Kubernetes clusters
   - Validate resource creation and lifecycle management
   - Ensure proper cleanup and error recovery

### Risk Mitigation

1. **Gradual Rollout**
   - Implement behind feature flag if needed
   - Test thoroughly in development environments
   - Monitor for performance or reliability issues

2. **Fallback Strategy**
   - Maintain ability to disable Alchemy integration
   - Ensure DirectDeploymentStrategy continues to work independently
   - Provide clear error messages for configuration issues

3. **Monitoring and Observability**
   - Add structured logging for deployment operations
   - Track success/failure rates and performance metrics
   - Monitor Alchemy resource registration and cleanup

## Success Criteria

### Functional Requirements

1. **Individual Resource Registration**: Each Kubernetes resource gets its own Alchemy resource type registration
2. **Consistent Resource Type Naming**: Resource types follow patterns like `kubernetes::Deployment`, `kro::WebApp`
3. **Complete AlchemyDeploymentStrategy**: Performs actual deployments with individual resource tracking
4. **Resource Type Inference**: Automatically infers Alchemy resource types from Kubernetes kind fields
5. **Consistent Patterns**: Both Kro and Direct modes follow similar registration patterns but adapted for their resource models

### Quality Requirements

1. **Test Coverage**: Comprehensive tests without mocking Alchemy dependencies
2. **Performance**: Deployment performance comparable to non-Alchemy direct mode
3. **Reliability**: Robust error handling and recovery mechanisms
4. **Documentation**: Clear documentation and examples for users

### Integration Requirements

1. **Alchemy Compatibility**: Works with existing Alchemy providers and follows the same patterns as cloudflare::Worker
2. **TypeKro Consistency**: Follows established TypeKro patterns and conventions
3. **Kubernetes Integration**: Proper integration with Kubernetes APIs and individual resource management
4. **Cross-Mode Consistency**: Kro and Direct modes both provide comprehensive Alchemy integration with appropriate resource granularity
5. **Developer Experience**: Clear error messages, resource type visibility, and debugging capabilities

## Summary

This design provides a comprehensive approach to completing the Alchemy integration by implementing individual resource registration for Direct mode while maintaining the existing RGD + instance pattern for Kro mode. The key innovation is treating each Kubernetes resource as a separate Alchemy resource type, enabling fine-grained resource management and tracking while following established Alchemy patterns. This ensures that both deployment modes provide complete Alchemy integration with appropriate resource granularity for their respective use cases.