# Design Document

## Overview

This design addresses a specific architectural limitation in TypeKro: deployment engines use centralized, generic readiness checking that cannot account for resource-specific readiness requirements. The solution decentralizes readiness control by allowing factory functions to provide resource-specific readiness evaluation functions.

**Core Problem**: Different Kubernetes resources have different readiness criteria:
- **Deployments**: Need ready replicas AND available replicas to match expected count
- **Services**: LoadBalancer needs ingress, ClusterIP is ready immediately, ExternalName needs externalName
- **StatefulSets**: Update strategy affects readiness (OnDelete vs RollingUpdate)
- **Jobs**: Need to consider completion count and success criteria

**Current State**: All resources use the same generic readiness checking logic in `ResourceReadinessChecker`

**Proposed Solution**: Factory functions provide readiness evaluation functions that deployment engines can use

**Extended Solution**: Apply the same pattern to Kro ResourceGraphDefinitions and CustomResourceDefinitions, allowing KroResourceFactory to use DirectDeploymentEngine for consistent deployment and readiness checking

## Architecture

### Current Architecture (Minimal Changes)

The existing TypeKro architecture remains unchanged except for the addition of optional readiness functions:

- **Factory Functions**: Continue to create `Enhanced<TSpec, TStatus>` resources, now optionally with readiness functions
- **DirectDeploymentEngine**: Enhanced to use factory-provided readiness functions when available
- **ResourceReadinessChecker**: Continues to work as fallback for resources without custom readiness functions
- **All Other Components**: Completely unchanged

### Design Principle

**Minimal Impact**: Make the smallest possible change to achieve decentralized readiness control while maintaining 100% backward compatibility with the production-ready kro-less-deployment functionality.

## Components and Interfaces

### Core Type Definitions

First, define the core interfaces that will be used throughout the implementation:

```typescript
// Structured resource status for detailed readiness information
interface ResourceStatus {
  ready: boolean;
  reason?: string;        // Machine-readable reason code
  message?: string;       // Human-readable status message
  details?: Record<string, any>; // Additional debugging information
}

// Readiness evaluator function type
type ReadinessEvaluator<T = any> = (liveResource: T) => ResourceStatus;

// Enhanced type with built-in readiness evaluation support
interface Enhanced<TSpec, TStatus> extends KubernetesResource {
  spec: TSpec;
  status: TStatus;
  
  // Optional readiness evaluator that returns structured status
  readinessEvaluator?: ReadinessEvaluator;
}

// Fluent builder interface for Enhanced resources
interface EnhancedBuilder<TSpec, TStatus> extends Enhanced<TSpec, TStatus> {
  withReadinessEvaluator(evaluator: ReadinessEvaluator): Enhanced<TSpec, TStatus>;
}

// Deployment event types extended for structured status reporting
interface DeploymentEvent {
  type: 'resource-ready' | 'resource-status' | 'resource-warning' | 'resource-error';
  resourceId: string;
  message: string;
  details?: Record<string, any>;
}
```

### 0. Enhanced Type Updates and Kro Factory Structure

Create Kro-specific factory functions using the fluent builder pattern:

```typescript
// src/factories/kro/resource-graph-definition.ts
// ResourceGraphDefinition factory with readiness evaluation
export function resourceGraphDefinition(rgd: any): Enhanced<any, any> {
  return createResource({
    ...rgd,
    apiVersion: 'kro.run/v1alpha1',
    kind: 'ResourceGraphDefinition',
  }).withReadinessEvaluator((liveRGD: any): ResourceStatus => {
    const status = liveRGD.status;
    const phase = status?.phase;
    const conditions = status?.conditions || [];
    
    if (phase === 'ready') {
      const readyCondition = conditions.find(c => c.type === 'Ready');
      if (readyCondition?.status === 'True') {
        return {
          ready: true,
          message: `ResourceGraphDefinition is ready and processing instances`
        };
      }
    }
    
    return {
      ready: false,
      reason: 'RGDNotReady',
      message: `ResourceGraphDefinition phase: ${phase || 'unknown'}`,
      details: { phase, conditions }
    };
  });
}

// Type modifier for Kro-managed status fields
interface KroStatusFields {
  state?: 'ACTIVE' | 'PROGRESSING' | 'FAILED' | 'TERMINATING';
  conditions?: Array<{
    type: string;
    status: 'True' | 'False' | 'Unknown';
    lastTransitionTime?: string;
    reason?: string;
    message?: string;
  }>;
  observedGeneration?: number;
}

type WithKroStatusFields<TStatus> = TStatus & KroStatusFields;

// src/factories/kro/kro-custom-resource.ts
// Generic Kro custom resource factory with schema-based typing
export function kroCustomResource<TSpec, TStatus>(
  resource: {
    apiVersion: string; // e.g., 'kro.run/v1alpha1'
    kind: string;       // e.g., 'WebApplication'
    metadata: { name: string; namespace?: string };
    spec: TSpec;
  }
): Enhanced<TSpec, WithKroStatusFields<TStatus>> {
  // Capture kind in closure for readiness evaluation
  const resourceKind = resource.kind;
  
  return createResource({
    ...resource,
    metadata: resource.metadata ?? { name: 'unnamed-kro-resource' },
  }).withReadinessEvaluator((liveResource: any): ResourceStatus => {
    const status = liveResource.status as WithKroStatusFields<TStatus>;
    const state = status?.state;
    const conditions = status?.conditions || [];
    
    // Kro instances are ready when state is ACTIVE and Ready condition is True
    const readyCondition = conditions.find(c => c.type === 'Ready');
    const isActive = state === 'ACTIVE';
    const isReady = readyCondition?.status === 'True';
    
    if (isActive && isReady) {
      return {
        ready: true,
        message: `Kro ${resourceKind} instance is active and all resources are ready`
      };
    } else if (state === 'FAILED') {
      const failedCondition = conditions.find(c => c.status === 'False');
      return {
        ready: false,
        reason: 'KroInstanceFailed',
        message: `Kro ${resourceKind} instance failed: ${failedCondition?.message || 'Unknown error'}`,
        details: { 
          state,
          conditions,
          observedGeneration: status?.observedGeneration
        }
      };
    } else {
      return {
        ready: false,
        reason: 'KroInstanceProgressing',
        message: `Kro ${resourceKind} instance progressing - State: ${state || 'Unknown'}, Ready: ${readyCondition?.status || 'Unknown'}`,
        details: { 
          state,
          conditions,
          observedGeneration: status?.observedGeneration
        }
      };
    }
  });
}

// src/factories/kro/kro-crd.ts  
// Kro-generated CustomResourceDefinition factory
export function kroCustomResourceDefinition(crd: V1CustomResourceDefinition): Enhanced<V1CustomResourceDefinitionSpec, V1CustomResourceDefinitionStatus> {
  return createResource({
    ...crd,
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
  }).withReadinessEvaluator((liveCRD: V1CustomResourceDefinition): ResourceStatus => {
    const status = liveCRD.status;
    const conditions = status?.conditions || [];
    
    const establishedCondition = conditions.find(c => c.type === 'Established');
    const namesAcceptedCondition = conditions.find(c => c.type === 'NamesAccepted');
    
    const isEstablished = establishedCondition?.status === 'True';
    const namesAccepted = namesAcceptedCondition?.status === 'True';
    const isKroCRD = liveCRD.metadata?.name?.endsWith('.kro.run');
    
    if (isEstablished && namesAccepted && isKroCRD) {
      return {
        ready: true,
        message: `Kro-generated CRD ${liveCRD.metadata?.name} is established and ready for instances`
      };
    } else {
      return {
        ready: false,
        reason: 'KroCRDNotReady',
        message: `Kro CRD not ready - Established: ${establishedCondition?.status || 'Unknown'}, NamesAccepted: ${namesAcceptedCondition?.status || 'Unknown'}`,
        details: { conditions, isKroCRD, crdName: liveCRD.metadata?.name }
      };
    }
  });
}
```

### 1. Enhanced Factory Functions with Fluent Builder Pattern

Enhanced factory functions using the fluent builder pattern with proper serialization protection:

```typescript
// Enhanced createResource function with fluent builder pattern and serialization protection
function createResource<TSpec, TStatus>(resource: KubernetesResource): EnhancedBuilder<TSpec, TStatus> {
  // Use existing createResource from src/factories/shared.ts as base
  const enhanced = existingCreateResource(resource) as EnhancedBuilder<TSpec, TStatus>;
  
  // Add fluent builder method for readiness evaluator with serialization protection
  Object.defineProperty(enhanced, 'withReadinessEvaluator', {
    value: function(evaluator: ReadinessEvaluator): Enhanced<TSpec, TStatus> {
      // Use Object.defineProperty with enumerable: false to prevent serialization
      Object.defineProperty(this, 'readinessEvaluator', {
        value: evaluator,
        enumerable: false,    // Prevents serialization - key requirement
        configurable: false,  // Cannot be modified after creation
        writable: false       // Cannot be overwritten
      });
      
      return this as Enhanced<TSpec, TStatus>;
    },
    enumerable: false,    // Prevents withReadinessEvaluator from being serialized
    configurable: false,  // Cannot be modified
    writable: false       // Cannot be overwritten
  });
  
  return enhanced;
}

// Clean, developer-friendly factory functions with fluent builder pattern
export function deployment(resource: V1Deployment): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  // Existing factory logic remains unchanged
  if (resource.spec?.template?.spec) {
    const processed = processPodSpec(resource.spec.template.spec);
    if (processed) {
      resource.spec.template.spec = processed;
    }
  }
  
  // Capture expected replicas in closure for readiness evaluation
  const expectedReplicas = resource.spec?.replicas || 1;
  
  // Fluent builder pattern with serialization-safe readiness evaluator
  return createResource<V1DeploymentSpec, V1DeploymentStatus>({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: resource.metadata ?? { name: 'unnamed-deployment' },
  }).withReadinessEvaluator((liveResource: V1Deployment): ResourceStatus => {
    try {
      const status = liveResource.status;
      
      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'Deployment status not available yet',
          details: { expectedReplicas }
        };
      }
      
      const readyReplicas = status.readyReplicas || 0;
      const availableReplicas = status.availableReplicas || 0;
      
      // Deployment-specific readiness: both ready and available replicas must match expected
      const ready = readyReplicas === expectedReplicas && availableReplicas === expectedReplicas;
      
      if (ready) {
        return {
          ready: true,
          message: `Deployment has ${readyReplicas}/${expectedReplicas} ready replicas and ${availableReplicas}/${expectedReplicas} available replicas`
        };
      } else {
        return {
          ready: false,
          reason: 'ReplicasNotReady',
          message: `Waiting for replicas: ${readyReplicas}/${expectedReplicas} ready, ${availableReplicas}/${expectedReplicas} available`,
          details: {
            expectedReplicas,
            readyReplicas,
            availableReplicas,
            updatedReplicas: status.updatedReplicas || 0
          }
        };
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating deployment readiness: ${error}`,
        details: { expectedReplicas, error: String(error) }
      };
    }
  });
}

export function service(resource: V1Service): Enhanced<V1ServiceSpec, V1ServiceStatus> {
  // Capture service type in closure for readiness evaluation
  const serviceType = resource.spec?.type || 'ClusterIP';
  
  return createResource<V1ServiceSpec, V1ServiceStatus>({
    ...resource,
    apiVersion: 'v1',
    kind: 'Service',
    metadata: resource.metadata ?? { name: 'unnamed-service' },
  }).withReadinessEvaluator((liveResource: V1Service): ResourceStatus => {
    try {
      if (serviceType === 'LoadBalancer') {
        const ingress = liveResource.status?.loadBalancer?.ingress;
        const hasIngress = !!(ingress && ingress.length > 0 && 
                             (ingress[0].ip || ingress[0].hostname));
        
        if (hasIngress) {
          return {
            ready: true,
            message: `LoadBalancer service has external endpoint: ${ingress![0].ip || ingress![0].hostname}`
          };
        } else {
          return {
            ready: false,
            reason: 'LoadBalancerPending',
            message: 'Waiting for LoadBalancer to assign external IP or hostname',
            details: { serviceType, ingressStatus: ingress }
          };
        }
      } else if (serviceType === 'ExternalName') {
        const hasExternalName = !!liveResource.spec?.externalName;
        
        if (hasExternalName) {
          return {
            ready: true,
            message: `ExternalName service configured with: ${liveResource.spec!.externalName}`
          };
        } else {
          return {
            ready: false,
            reason: 'ExternalNameMissing',
            message: 'ExternalName service missing externalName field',
            details: { serviceType }
          };
        }
      }
      
      // ClusterIP and NodePort services are ready when created
      return {
        ready: true,
        message: `${serviceType} service is ready`
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating service readiness: ${error}`,
        details: { serviceType, error: String(error) }
      };
    }
  });
}

export function statefulSet(resource: V1StatefulSet): Enhanced<V1StatefulSetSpec, V1StatefulSetStatus> {
  // Capture configuration in closure for StatefulSet-specific readiness logic
  const expectedReplicas = resource.spec?.replicas || 1;
  const updateStrategy = resource.spec?.updateStrategy?.type || 'RollingUpdate';
  
  return createResource<V1StatefulSetSpec, V1StatefulSetStatus>({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: resource.metadata ?? { name: 'unnamed-statefulset' },
  }).withReadinessEvaluator((liveResource: V1StatefulSet): ResourceStatus => {
    try {
      const status = liveResource.status;
      
      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'StatefulSet status not available yet',
          details: { expectedReplicas, updateStrategy }
        };
      }
      
      const readyReplicas = status.readyReplicas || 0;
      const currentReplicas = status.currentReplicas || 0;
      const updatedReplicas = status.updatedReplicas || 0;
      
      // StatefulSet readiness depends on update strategy
      if (updateStrategy === 'OnDelete') {
        const ready = readyReplicas === expectedReplicas;
        
        if (ready) {
          return {
            ready: true,
            message: `StatefulSet (OnDelete) has ${readyReplicas}/${expectedReplicas} ready replicas`
          };
        } else {
          return {
            ready: false,
            reason: 'ReplicasNotReady',
            message: `StatefulSet (OnDelete) waiting for replicas: ${readyReplicas}/${expectedReplicas} ready`,
            details: { expectedReplicas, readyReplicas, updateStrategy }
          };
        }
      } else {
        // RollingUpdate: ensure all replicas are updated and ready
        const ready = readyReplicas === expectedReplicas && 
                     currentReplicas === expectedReplicas &&
                     updatedReplicas === expectedReplicas;
        
        if (ready) {
          return {
            ready: true,
            message: `StatefulSet (RollingUpdate) has all ${expectedReplicas} replicas ready, current, and updated`
          };
        } else {
          return {
            ready: false,
            reason: 'RollingUpdateInProgress',
            message: `StatefulSet (RollingUpdate) updating: ${readyReplicas}/${expectedReplicas} ready, ${currentReplicas}/${expectedReplicas} current, ${updatedReplicas}/${expectedReplicas} updated`,
            details: {
              expectedReplicas,
              readyReplicas,
              currentReplicas,
              updatedReplicas,
              updateStrategy
            }
          };
        }
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating StatefulSet readiness: ${error}`,
        details: { expectedReplicas, updateStrategy, error: String(error) }
      };
    }
  });
}
```

### 2. Deployment Engine Enhancement

The `DirectDeploymentEngine` is enhanced to use the structured ResourceStatus from factory-provided readiness evaluators:

```typescript
// Enhanced DirectDeploymentEngine with structured readiness evaluation
class DirectDeploymentEngine {
  // All existing methods remain unchanged
  
  // ENHANCED: Check for factory-provided readiness evaluator before using generic checking
  private async waitForResourceReady(
    deployedResource: DeployedResource,
    options: DeploymentOptions,
    emitEvent: (event: DeploymentEvent) => void
  ): Promise<void> {
    // Check if resource has factory-provided readiness evaluator
    const readinessEvaluator = (deployedResource.manifest as Enhanced<any, any>).readinessEvaluator;
    
    if (readinessEvaluator) {
      try {
        return await this.waitForResourceReadyWithCustomEvaluator(
          deployedResource,
          readinessEvaluator,
          options,
          emitEvent
        );
      } catch (error) {
        // If custom readiness fails, fall back to generic checking
        console.warn(`Custom readiness evaluation failed for ${deployedResource.kind}/${deployedResource.name}, falling back to generic checking`);
        emitEvent({
          type: 'resource-warning',
          resourceId: deployedResource.resourceId,
          message: `Custom readiness evaluation failed, using generic checking: ${error}`,
        });
      }
    }
    
    // Use existing ResourceReadinessChecker as fallback
    return this.readinessChecker.waitForResourceReady(deployedResource, options, emitEvent);
  }
  
  // NEW: Use factory-provided readiness evaluator with structured status reporting
  private async waitForResourceReadyWithCustomEvaluator(
    deployedResource: DeployedResource,
    readinessEvaluator: (liveResource: any) => ResourceStatus,
    options: DeploymentOptions,
    emitEvent: (event: DeploymentEvent) => void
  ): Promise<void> {
    const startTime = Date.now();
    const timeout = options.timeout || 300000; // 5 minutes default
    let lastStatus: ResourceStatus | null = null;
    
    while (Date.now() - startTime < timeout) {
      try {
        // Get current resource state
        const liveResource = await this.k8sApi.read({
          apiVersion: deployedResource.manifest.apiVersion,
          kind: deployedResource.kind,
          metadata: {
            name: deployedResource.name,
            namespace: deployedResource.namespace,
          },
        } as any);
        
        // Use factory-provided evaluator to get structured status
        const status = readinessEvaluator(liveResource.body);
        
        // Emit status updates when status changes
        if (!lastStatus || lastStatus.message !== status.message) {
          emitEvent({
            type: status.ready ? 'resource-ready' : 'resource-status',
            resourceId: deployedResource.resourceId,
            message: status.message || (status.ready ? 'Resource is ready' : 'Resource not ready'),
            details: status.details,
          });
          lastStatus = status;
        }
        
        if (status.ready) {
          return;
        }
        
        // Wait before next check (existing polling interval)
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        // If we can't read the resource, it's not ready yet
        emitEvent({
          type: 'resource-status',
          resourceId: deployedResource.resourceId,
          message: `Unable to read resource status: ${error}`,
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Provide detailed timeout error with last known status
    const timeoutMessage = lastStatus 
      ? `Timeout waiting for ${deployedResource.kind}/${deployedResource.name}: ${lastStatus.message}`
      : `Timeout waiting for ${deployedResource.kind}/${deployedResource.name} to be ready`;
    
    throw new Error(timeoutMessage);
  }
}
```

### 3. DirectDeploymentEngine Integration

The DirectDeploymentEngine integration uses the type definitions established at the beginning of this document.

## Implementation Strategy

### Phase 0: Enhanced Type Updates and Kro Factory Structure (Week 1)
- Update `Enhanced<TSpec, TStatus>` interface to include optional `readinessEvaluator` property
- Create `ResourceStatus` interface for structured readiness information
- Create `src/factories/kro/` directory structure for Kro-specific factory functions
- Create readiness evaluators for ResourceGraphDefinition and CustomResourceDefinition resources
- Replace custom RGD deployment logic in `KroResourceFactory` with `DirectDeploymentEngine` calls
- Replace custom CRD waiting logic with `DirectDeploymentEngine` readiness evaluation
- Maintain all existing KroResourceFactory functionality (status hydration, instance management, alchemy integration)

### Phase 1: Core Factory Functions (Week 1)
- Add readiness evaluators to `deployment()`, `service()`, `statefulSet()`, and `job()` factory functions
- Update `Enhanced<TSpec, TStatus>` interface to include optional `readinessEvaluator` property
- Create `ResourceStatus` interface for structured readiness information
- Test that existing serialization and YAML generation continue to work unchanged

### Phase 2: Deployment Engine Integration (Week 1)
- Enhance `DirectDeploymentEngine` to check for and use factory-provided readiness evaluators
- Implement structured status reporting with `ResourceStatus` objects
- Implement graceful fallback to existing `ResourceReadinessChecker` when evaluators fail or are not present
- Ensure all existing deployment workflows continue to work unchanged

### Phase 3: Testing and Validation (Week 1)
- Test that resources with custom readiness evaluators are more accurately assessed
- Test that resources without custom readiness evaluators continue to work exactly as before
- Test that KroResourceFactory integration with DirectDeploymentEngine works correctly
- Validate that all kro-less-deployment functionality remains 100% intact

## Backward Compatibility

**100% Backward Compatibility Guaranteed**:
- All existing factory function signatures remain unchanged
- All existing deployment workflows continue to work without modification
- Resources without readiness evaluators use existing generic checking
- No changes required to user code or deployment configurations
- All existing functionality (serialization, YAML generation, etc.) is unaffected

## Benefits

1. **More Accurate Readiness**: Resources can define their specific readiness criteria
2. **Better Debugging**: Clear understanding of what each resource is waiting for
3. **Extensible**: New resource types can easily provide their own readiness logic
4. **Zero Breaking Changes**: Existing code continues to work unchanged
5. **Minimal Risk**: Small, focused change with comprehensive fallback mechanisms

## Risk Mitigation

1. **Graceful Fallback**: If custom readiness evaluation fails, fall back to existing generic checking
2. **Non-Enumerable Properties**: Readiness evaluators don't interfere with serialization or other functionality
3. **Optional Feature**: Resources without readiness evaluators continue to work exactly as before
4. **Comprehensive Testing**: Validate that all existing functionality remains intact
5. **Production-Ready Foundation**: Building on the stable kro-less-deployment architecture

## Status Hydration Refactoring

### Current Status Hydration Issues

The current status hydration system has several issues that need to be addressed when integrating with DirectDeploymentEngine:

1. **Timing Dependency**: StatusHydrator runs after readiness checking, but DirectDeploymentEngine needs to coordinate both
2. **Duplicate API Calls**: Both readiness checking and status hydration make separate API calls to get live resource state
3. **Inconsistent Error Handling**: Different error handling patterns between readiness checking and status hydration
4. **Kro-Specific Complexity**: KroResourceFactory has complex static/dynamic field separation that needs to be preserved

### Refactored Status Hydration Design

```typescript
// Enhanced DirectDeploymentEngine with integrated status hydration
class DirectDeploymentEngine {
  private statusHydrator = new StatusHydrator(this.k8sApi);
  
  // ENHANCED: Integrate status hydration with readiness checking
  private async waitForResourceReadyWithCustomEvaluator(
    deployedResource: DeployedResource,
    readinessEvaluator: (liveResource: any) => ResourceStatus,
    options: DeploymentOptions,
    emitEvent: (event: DeploymentEvent) => void
  ): Promise<void> {
    const startTime = Date.now();
    const timeout = options.timeout || 300000;
    let lastStatus: ResourceStatus | null = null;
    
    while (Date.now() - startTime < timeout) {
      try {
        // Single API call gets live resource state for both readiness and hydration
        const liveResource = await this.k8sApi.read({
          apiVersion: deployedResource.manifest.apiVersion,
          kind: deployedResource.kind,
          metadata: {
            name: deployedResource.name,
            namespace: deployedResource.namespace,
          },
        } as any);
        
        // Use factory-provided evaluator to get structured status
        const status = readinessEvaluator(liveResource.body);
        
        // Emit status updates when status changes
        if (!lastStatus || lastStatus.message !== status.message) {
          emitEvent({
            type: status.ready ? 'resource-ready' : 'resource-status',
            resourceId: deployedResource.resourceId,
            message: status.message || (status.ready ? 'Resource is ready' : 'Resource not ready'),
            details: status.details,
          });
          lastStatus = status;
        }
        
        if (status.ready) {
          // Resource is ready - now hydrate status fields using the same live resource data
          if (options.hydrateStatus !== false) {
            await this.hydrateResourceStatus(deployedResource, liveResource.body);
          }
          return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        emitEvent({
          type: 'resource-status',
          resourceId: deployedResource.resourceId,
          message: `Unable to read resource status: ${error}`,
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    throw new Error(`Timeout waiting for ${deployedResource.kind}/${deployedResource.name} to be ready`);
  }
  
  // NEW: Integrated status hydration using live resource data
  private async hydrateResourceStatus(deployedResource: DeployedResource, liveResourceData: any): Promise<void> {
    try {
      const enhanced = deployedResource.manifest as Enhanced<any, any>;
      
      // Use existing StatusHydrator but with already-fetched live data
      await this.statusHydrator.hydrateStatusFromLiveData(enhanced, liveResourceData, deployedResource);
      
    } catch (error) {
      console.warn(`Status hydration failed for ${deployedResource.kind}/${deployedResource.name}:`, error);
      // Don't fail the deployment if status hydration fails
    }
  }
}

// Enhanced StatusHydrator with support for pre-fetched live data
export class StatusHydrator {
  // NEW: Hydrate status using already-fetched live resource data
  async hydrateStatusFromLiveData<TSpec, TStatus>(
    enhanced: Enhanced<TSpec, TStatus>,
    liveResourceData: any,
    deployedResource: DeployedResource
  ): Promise<{ success: boolean; resourceId: string; hydratedFields: string[]; error?: Error }> {
    try {
      const resourceId = enhanced.metadata?.name || 'unknown';
      const hydratedFields: string[] = [];
      
      // Extract status data from pre-fetched live resource
      const status = liveResourceData.status;
      
      if (!status) {
        return { success: false, resourceId, hydratedFields: [], error: new Error('No status found') };
      }
      
      // Populate Enhanced proxy with live status data
      this.populateEnhancedStatus(enhanced, status, hydratedFields);
      
      // Cache the result
      if (this.mergedOptions.enableCaching) {
        const cacheKey = this.getCacheKey(deployedResource);
        this.setCache(cacheKey, status);
      }
      
      return { success: true, resourceId, hydratedFields };
    } catch (error) {
      const resourceId = enhanced.metadata?.name || 'unknown';
      return {
        success: false,
        resourceId,
        hydratedFields: [],
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }
  
  // Existing method remains for backward compatibility
  async hydrateStatus<TSpec, TStatus>(
    enhanced: Enhanced<TSpec, TStatus>,
    deployedResource: DeployedResource
  ): Promise<{ success: boolean; resourceId: string; hydratedFields: string[]; error?: Error }> {
    // Fetch live resource data and delegate to hydrateStatusFromLiveData
    try {
      const liveResource = await this.k8sApi.read({
        apiVersion: deployedResource.manifest.apiVersion,
        kind: deployedResource.kind,
        metadata: {
          name: deployedResource.name,
          namespace: deployedResource.namespace,
        },
      } as any);
      
      return await this.hydrateStatusFromLiveData(enhanced, liveResource.body, deployedResource);
    } catch (error) {
      const resourceId = enhanced.metadata?.name || 'unknown';
      return {
        success: false,
        resourceId,
        hydratedFields: [],
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }
}
        resourceId,
        hydratedFields: [],
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }
  
  // Keep existing hydrateStatus method for backward compatibility
  async hydrateStatus<TSpec, TStatus>(
    enhanced: Enhanced<TSpec, TStatus>,
    deployedResource?: DeployedResource
  ): Promise<{ success: boolean; resourceId: string; hydratedFields: string[]; error?: Error }> {
    // Existing implementation unchanged for backward compatibility
    // This method still makes its own API call when live data isn't available
  }
}
```

### KroResourceFactory Status Hydration Integration

The KroResourceFactory needs special handling for its static/dynamic field separation:

```typescript
class KroResourceFactoryImpl<TSpec, TStatus> {
  // Enhanced to work with DirectDeploymentEngine
  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // 1. Deploy RGD using DirectDeploymentEngine with readiness evaluator
    const rgdResource = resourceGraphDefinition(this.createRGDManifest());
    await this.directEngine.deploy([rgdResource], this.factoryOptions);
    
    // 2. Deploy CRD using DirectDeploymentEngine with readiness evaluator  
    const crdResource = kroCustomResourceDefinition(this.createCRDManifest());
    await this.directEngine.deploy([crdResource], this.factoryOptions);
    
    // 3. Deploy Kro custom resource instance using DirectDeploymentEngine
    const instanceName = this.generateInstanceName(spec);
    const kroInstance = kroCustomResource<TSpec, WithKroStatusFields<TStatus>>({
      apiVersion: `kro.run/${this.schemaDefinition.apiVersion}`,
      kind: this.schemaDefinition.kind,
      metadata: { name: instanceName, namespace: this.namespace },
      spec: spec
    });
    
    await this.directEngine.deploy([kroInstance], this.factoryOptions);
    
    // 4. Create Enhanced proxy with mixed static/dynamic status hydration
    return await this.createEnhancedProxyWithMixedHydration(spec, instanceName);
  }
  
  // Enhanced proxy creation with mixed static/dynamic status hydration
  private async createEnhancedProxyWithMixedHydration(spec: TSpec, instanceName: string): Promise<Enhanced<TSpec, TStatus>> {
    // Separate static and dynamic status fields (existing logic)
    const { staticFields, dynamicFields } = this.separateStatusFields();
    
    // Start with static fields as the base status
    const status: TStatus = { ...staticFields } as TStatus;
    
    // Create Enhanced proxy
    const enhancedProxy = {
      apiVersion: `kro.run/${this.schemaDefinition.apiVersion}`,
      kind: this.schemaDefinition.kind,
      spec,
      status,
      metadata: { name: instanceName, namespace: this.namespace },
    } as Enhanced<TSpec, TStatus>;
    
    // Hydrate dynamic status fields from live Kro custom resource
    if (this.factoryOptions.hydrateStatus !== false && Object.keys(dynamicFields).length > 0) {
      try {
        // Get live custom resource data
        const liveResource = await this.k8sApi.read({
          apiVersion: `kro.run/${this.schemaDefinition.apiVersion}`,
          kind: this.schemaDefinition.kind,
          metadata: { name: instanceName, namespace: this.namespace },
        } as any);
        
        // Hydrate only the dynamic fields from live resource
        await this.hydrateDynamicStatusFields(enhancedProxy, liveResource.body, dynamicFields);
        
      } catch (error) {
        console.warn(`Dynamic status hydration failed for ${instanceName}:`, error);
        // Continue with static fields only
      }
    }
    
    return enhancedProxy;
  }
  
  // Hydrate only dynamic status fields from live Kro resource
  private async hydrateDynamicStatusFields(
    enhanced: Enhanced<TSpec, TStatus>,
    liveResourceData: any,
    dynamicFields: Record<string, any>
  ): Promise<void> {
    const statusProxy = enhanced.status as any;
    
    // Hydrate dynamic fields by evaluating their CEL expressions against live resource
    for (const [fieldName, celExpression] of Object.entries(dynamicFields)) {
      try {
        // Evaluate CEL expression against live resource data
        const value = this.evaluateCelExpression(celExpression, liveResourceData);
        statusProxy[fieldName] = value;
      } catch (error) {
        console.warn(`Failed to hydrate dynamic field ${fieldName}:`, error);
        // Keep existing static value or undefined
      }
    }
  }
}
```

### Benefits of Refactored Status Hydration

1. **Eliminates Duplicate API Calls**: Single API call serves both readiness checking and status hydration
2. **Consistent Error Handling**: Unified error handling pattern across readiness and hydration
3. **Better Performance**: Reduces API call overhead by ~50%
4. **Maintains Kro Complexity**: Preserves existing static/dynamic field separation in KroResourceFactory
5. **Backward Compatibility**: Existing StatusHydrator methods continue to work

## Serialization Protection

### Preventing Readiness Evaluator Serialization

Readiness evaluators are runtime functions that should never be serialized when resources are converted to YAML or JSON. The design ensures this through non-enumerable property definitions:

```typescript
// All readiness evaluators are added as non-enumerable properties
Object.defineProperty(enhanced, 'readinessEvaluator', {
  value: (liveResource: T): ResourceStatus => { /* ... */ },
  enumerable: false,    // Prevents inclusion in JSON.stringify() and YAML serialization
  configurable: false,  // Cannot be modified or deleted
});
```

### Serialization Flow Protection

The TypeKro serialization system uses several methods that could potentially serialize functions:

1. **YAML Generation**: `serializeResourceGraphToYaml()` uses `JSON.stringify()` internally
2. **Resource Cloning**: `JSON.parse(JSON.stringify(resource))` for deep cloning
3. **Alchemy Integration**: Resource conversion checks using `JSON.stringify(resource)`

By making readiness evaluators non-enumerable, they are automatically excluded from:
- `JSON.stringify()` operations
- `Object.keys()` iterations  
- `for...in` loops
- YAML serialization processes

### Verification Strategy

The implementation includes verification that readiness evaluators don't appear in serialized output:

```typescript
// Test that readiness evaluators are not serialized
const enhanced = deployment({ /* ... */ });
const serialized = JSON.stringify(enhanced);
expect(serialized).not.toContain('readinessEvaluator');
expect(serialized).not.toContain('function');

// Test that YAML generation excludes readiness evaluators
const yamlOutput = factory.toYaml(spec);
expect(yamlOutput).not.toContain('readinessEvaluator');
```

This design provides a focused solution to the readiness decentralization problem while maintaining the stability and reliability of the existing production-ready system.