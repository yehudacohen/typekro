# Implementation Plan

This implementation plan focuses on decentralizing resource readiness control with minimal changes to the existing production-ready architecture. The goal is to allow factory functions to define resource-specific readiness criteria while maintaining 100% backward compatibility.

## Tasks

- [x] 0. Implement Fluent Builder Pattern for Readiness Evaluators
  - Add `ResourceStatus` interface for structured readiness information with `ready`, `reason`, `message`, and `details` fields
  - Add `ReadinessEvaluator<T>` type for readiness evaluator functions
  - Add `EnhancedBuilder<TSpec, TStatus>` interface extending `Enhanced<TSpec, TStatus>` with `withReadinessEvaluator()` method
  - Update `Enhanced<TSpec, TStatus>` interface in `src/core/types/kubernetes.ts` to include optional `readinessEvaluator` property
  - Update `createResource()` function in `src/factories/shared.ts` to include fluent builder method
  - Use `Object.defineProperty()` with `enumerable: false` to prevent serialization of BOTH `withReadinessEvaluator` method AND `readinessEvaluator` property
  - Ensure both method and property have `configurable: false` and `writable: false` for immutability
  - Add consistent error handling with try-catch blocks in all readiness evaluators
  - Handle missing status fields gracefully with appropriate error messages
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.7_

- [x] 1.2 Replace KroResourceFactory RGD Deployment with DirectDeploymentEngine
  - Replace custom RGD deployment logic in `KroResourceFactory.deploy()` with `DirectDeploymentEngine` calls
  - Replace `waitForRGDReady()` method with `DirectDeploymentEngine.waitForResourceReady()`
  - Replace `waitForCRDReady()` method with `DirectDeploymentEngine.waitForResourceReady()`
  - Maintain all existing KroResourceFactory functionality (status hydration, instance management, alchemy integration)
  - Ensure backward compatibility with existing KroResourceFactory API
  - _Requirements: 1.2, 2.1, 2.2, 2.3_

- [x] 1.3 Refactor Status Hydration for Integration with DirectDeploymentEngine
  - Add `hydrateStatusFromLiveData()` method to `StatusHydrator` that uses pre-fetched live resource data
  - Integrate status hydration into `DirectDeploymentEngine.waitForResourceReadyWithCustomEvaluator()`
  - Eliminate duplicate API calls by using single resource fetch for both readiness checking and status hydration
  - Add `hydrateResourceStatus()` method to `DirectDeploymentEngine` that coordinates with `StatusHydrator`
  - Maintain backward compatibility with existing `StatusHydrator.hydrateStatus()` method
  - _Requirements: 2.1, 3.5_

- [x] 1.4 Enhance KroResourceFactory Status Hydration for Mixed Static/Dynamic Fields
  - Update `createEnhancedProxyWithMixedHydration()` method to work with DirectDeploymentEngine deployment
  - Preserve existing `separateStatusFields()` logic for static/dynamic field separation
  - Add `hydrateDynamicStatusFields()` method that evaluates CEL expressions against live Kro resource data
  - Ensure static fields are populated immediately and dynamic fields are hydrated from live resources
  - Maintain existing KroResourceFactory status hydration behavior and API
  - _Requirements: 2.1, 2.2, 2.7_

- [x] 1. Create Kro Factory Structure Using Fluent Builder Pattern
  - Create `resourceGraphDefinition()` factory function in `src/factories/kro/resource-graph-definition.ts`
  - Add readiness evaluator that checks RGD status phase and conditions for 'ready' state
  - Create `WithKroStatusFields<TStatus>` type modifier that adds Kro-managed status fields (`state`, `conditions`, `observedGeneration`)
  - Create generic `kroCustomResource<TSpec, TStatus>()` factory function in `src/factories/kro/kro-custom-resource.ts`
  - Return type should be `Enhanced<TSpec, WithKroStatusFields<TStatus>>` to include both user-defined and Kro-managed status fields
  - Add readiness evaluator that checks Kro instance `state` (ACTIVE) and 'Ready' condition managed by Kro controller
  - Create `kroCustomResourceDefinition()` factory function in `src/factories/kro/kro-crd.ts`
  - Add readiness evaluator that checks Kro-generated CRD established condition and `.kro.run` naming
  - Export Kro factories from `src/factories/kro/index.ts`
  - Use fluent builder pattern consistently across all Kro factories
  - _Requirements: 1.1, 1.2, 2.1_

- [x] 1.1 Implement Factory Functions with Fluent Builder Pattern
  - Add `withReadinessEvaluator()` method to `Enhanced<TSpec, TStatus>` interface in `src/core/types/kubernetes.ts`
  - Update `createResource()` function in `src/factories/shared.ts` to include fluent builder method
  - Use `Object.defineProperty()` with `enumerable: false` to prevent serialization of BOTH `withReadinessEvaluator` method AND `readinessEvaluator` property
  - Ensure both method and property have `configurable: false` and `writable: false` for immutability
  - Implement fluent pattern in `deployment()` function in `src/factories/kubernetes/workloads/deployment.ts`
  - Implement fluent pattern in `service()` function in `src/factories/kubernetes/networking/service.ts`
  - Implement fluent pattern in `statefulSet()` function in `src/factories/kubernetes/workloads/stateful-set.ts`
  - Implement fluent pattern in `job()` function in `src/factories/kubernetes/workloads/job.ts`
  - Use closures to capture resource-specific configuration at creation time
  - Ensure readiness evaluators only process live Kubernetes resources, not template strings or CEL expressions
  - Verify that readiness evaluators don't appear in `JSON.stringify()` or YAML output
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.7_

- [x] 1.5 Implement Factory Functions with Fluent Builder Pattern
  - Implement fluent pattern in `deployment()` function in `src/factories/kubernetes/workloads/deployment.ts`
  - Implement fluent pattern in `service()` function in `src/factories/kubernetes/networking/service.ts`
  - Implement fluent pattern in `statefulSet()` function in `src/factories/kubernetes/workloads/stateful-set.ts`
  - Implement fluent pattern in `job()` function in `src/factories/kubernetes/workloads/job.ts`
  - Use closures to capture resource-specific configuration at creation time
  - Ensure readiness evaluators only process live Kubernetes resources, not template strings or CEL expressions
  - Verify that readiness evaluators don't appear in `JSON.stringify()` or YAML output
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.7_

- [x] 1.6 Implement Deployment-Specific Readiness Logic with Structured Status
  - Capture expected replica count from deployment spec at creation time using closure
  - Implement readiness evaluator that returns `ResourceStatus` object with detailed information
  - Check both `readyReplicas` and `availableReplicas` match expected count for ready status
  - Provide detailed status messages and debugging information in `details` field
  - Handle edge cases where replica count is undefined (default to 1)
  - Return structured status with reason codes like 'ReplicasNotReady' when not ready
  - _Requirements: 1.3, 3.1, 3.2, 3.7_

- [x] 1.7 Implement Service-Specific Readiness Logic
  - Capture service type from service spec at creation time
  - Implement readiness evaluator that handles different service types:
    - LoadBalancer: requires ingress with IP or hostname
    - ExternalName: requires externalName field
    - ClusterIP/NodePort: ready immediately when created
  - Test that service readiness accurately reflects service type requirements
  - _Requirements: 1.4, 3.1, 3.2_

- [x] 1.8 Implement StatefulSet-Specific Readiness Logic
  - Capture expected replica count and update strategy from statefulset spec at creation time
  - Implement readiness evaluator that considers update strategy:
    - OnDelete: only check ready replicas
    - RollingUpdate: check ready, current, and updated replicas all match expected
  - Handle edge cases for undefined replica count and update strategy
  - Test that statefulset readiness accurately reflects update strategy requirements
  - _Requirements: 1.5, 3.1, 3.2_

- [x] 1.9 Implement Job-Specific Readiness Logic
  - Capture completion count and parallelism from job spec at creation time
  - Implement readiness evaluator that checks succeeded count against expected completions
  - Handle different job completion modes (fixed completion count vs work queue)
  - Test that job readiness accurately reflects completion requirements
  - _Requirements: 1.6, 3.1, 3.2_

- [x] 2. Enhance DirectDeploymentEngine for Structured Readiness Evaluation
  - Modify `waitForResourceReady()` method in `src/core/deployment/direct-factory.ts` to check for `readinessEvaluator` property on Enhanced resources
  - Implement `waitForResourceReadyWithCustomEvaluator()` method that uses structured `ResourceStatus` objects
  - Add detailed status reporting through deployment events with status messages and debugging details
  - Add graceful fallback to existing `ResourceReadinessChecker` when custom evaluator fails or is not present
  - Emit status change events when readiness status or messages change
  - Ensure all existing deployment workflows continue to work unchanged
  - _Requirements: 1.2, 1.7, 2.3, 2.6, 3.7_

- [x] 2.1 Implement Custom Readiness Evaluation Logic
  - Use existing Kubernetes API reading logic to get live resource state
  - Apply factory-provided readiness evaluator to live resource
  - Maintain existing polling interval and timeout behavior
  - Add clear error messages when custom readiness evaluation fails
  - Ensure performance is not degraded compared to existing system
  - _Requirements: 3.1, 3.3, 3.5, 3.7_

- [x] 2.2 Add Comprehensive Fallback Mechanisms
  - Fall back to existing `ResourceReadinessChecker` when custom evaluator is not present
  - Fall back to existing `ResourceReadinessChecker` when custom evaluator throws errors
  - Log warnings when falling back to generic readiness checking
  - Ensure fallback behavior is identical to current system behavior
  - _Requirements: 2.3, 2.5, 2.6, 3.6_

- [x] 3. Testing and Validation
  - Create unit tests for each factory function's readiness evaluator
  - Test that resources with custom evaluators have more accurate readiness assessment
  - Test that resources without custom evaluators continue to work exactly as before
  - Test that custom readiness evaluation gracefully handles malformed live resources
  - Validate that all existing kro-less-deployment functionality remains intact
  - _Requirements: 2.1, 2.2, 2.4, 3.4, 3.6_

- [x] 3.1 Backward Compatibility and Serialization Validation
  - Ensure all existing factory function signatures remain unchanged
  - Validate that Enhanced type behavior is preserved (magic proxy functionality intact)
  - Test that existing deployment workflows continue without modification
  - Verify that serialization and YAML generation are unaffected by readiness evaluators
  - Test specific serialization scenarios:
    - Test that `Object.keys(enhancedResource)` doesn't include `withReadinessEvaluator` or `readinessEvaluator`
    - Test that `JSON.parse(JSON.stringify(enhancedResource))` doesn't contain function properties
    - Test that YAML serialization excludes non-enumerable properties
    - Test that `Object.getOwnPropertyNames()` includes the properties but `Object.propertyIsEnumerable()` returns false
  - Test that `toYaml()` methods don't include readiness evaluator functions in output
  - Verify that alchemy integration resource conversion doesn't serialize readiness evaluators
  - Confirm that no changes are required to user code or deployment configurations
  - _Requirements: 2.1, 2.2, 2.4, 2.7_

- [x] 3.2 Integration Testing with Production Components
  - Test integration with existing `ResourceRollbackManager`
  - Test integration with existing `DependencyResolver`
  - Test integration with existing `StatusHydrator`
  - Validate that all kro-less-deployment factory patterns continue to work
  - Ensure no regressions in the production-ready DirectResourceFactory and KroResourceFactory
  - _Requirements: 2.2, 2.4, 2.5_

- [x] 4. Documentation and Error Handling
  - Add JSDoc documentation to readiness evaluator functions explaining their purpose and behavior
  - Document the fallback behavior when custom readiness evaluation fails
  - Add clear error messages that help developers understand what readiness criteria are not met
  - Document how to add readiness evaluators to new factory functions
  - _Requirements: 3.7_

- [x] 4.1 Performance and Reliability Validation
  - Benchmark custom readiness evaluation vs generic readiness checking
  - Ensure custom readiness evaluation doesn't cause performance degradation
  - Test error handling when readiness evaluators encounter unexpected resource states
  - Validate that the system remains stable under various failure conditions
  - _Requirements: 3.5, 3.6_