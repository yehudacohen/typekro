# Implementation Plan

## Overview

This implementation plan breaks down the three-composition nested compositions demo into discrete, manageable coding tasks. Each task builds incrementally on previous tasks and focuses on code implementation that can be executed by a coding agent.

The plan implements exactly three compositions as specified in the requirements:
1. **TypeKro Bootstrap Composition** (direct mode, 1 instance)
2. **Infrastructure Composition** (kro mode, 1 instance) - contains nested cert-manager and external-dns calls
3. **Webapp Composition** (kro mode, 2 instances) - references infrastructure status

## Task List

- [x] 1. Create TypeKro Bootstrap Composition
  - Use existing `typeKroRuntimeBootstrap` directly without modification
  - Create factory deployment with proper configuration
  - Validate status field access (`phase`, `components.kroSystem`)
  - _Requirements: 9.2_

- [x] 2. Create Infrastructure Composition with Nested Bootstrap Calls
  - Define `InfrastructureSpec` and `InfrastructureStatus` interfaces using ArkType
  - Implement composition function that calls `certManager.certManagerBootstrap()` and `externalDns.externalDnsBootstrap()` as nested compositions
  - Create ClusterIssuer resource directly within the composition
  - Return status object referencing nested composition status: `certManagerInstance.status.ready`, `externalDnsInstance.status.ready`
  - Test that nested resources are automatically flattened into parent composition
  - _Requirements: 9.3, 1.1, 1.2, 2.1_

- [x] 3. Create Webapp Composition with Cross-Composition References
  - Define `WebappSpec` and `WebappStatus` interfaces using ArkType
  - Implement composition function that creates Deployment, Service, Certificate, and Ingress resources
  - Use `simple.Deployment`, `simple.Service`, `simple.Ingress`, and `certManager.certificate` factories
  - Configure Ingress with cert-manager and external-dns annotations
  - Reference cross-composition parameters: `spec.issuerName`, `spec.dnsProvider`
  - Return status object with readiness checks for all resources
  - _Requirements: 9.4, 2.1, 2.2_

- [x] 4. Implement Demo Orchestration Script
  - Create `examples/hello-world-nested-compositions.ts` file
  - Implement three-step deployment function:
    1. Deploy TypeKro Bootstrap (direct mode)
    2. Deploy Infrastructure Composition (kro mode) with bootstrap status references
    3. Deploy two Webapp instances (kro mode) with infrastructure status references
  - Add proper error handling and progress logging
  - Include event monitoring configuration for all deployments
  - _Requirements: 9.1, 9.5, 9.6_

- [x] 5. Add Cross-Composition Reference Validation
  - Implement validation that Infrastructure Composition receives bootstrap status correctly
  - Implement validation that Webapp Compositions receive infrastructure status correctly
  - Add TypeScript type checking for cross-composition reference parameters
  - Test that CEL expressions are generated correctly for nested status references
  - _Requirements: 9.5, 2.3, 2.4_

- [x] 6. Add Configuration and Prerequisites Validation
  - Add AWS credentials and Route53 zone validation
  - Add cluster connectivity validation
  - Create configuration object with domain, email, AWS region, and hosted zone ID
  - Add environment variable support for sensitive configuration
  - Implement prerequisite checking before deployment starts
  - _Requirements: 9.8, 9.9_

- [x] 7. Implement Deployment Verification and Testing
  - Add DNS propagation waiting logic (120 seconds)
  - Implement HTTPS connectivity testing with curl
  - Add retry logic for connectivity verification
  - Provide clear success/failure messages with accessible URLs
  - Add troubleshooting guidance for common failure scenarios
  - _Requirements: 9.10, 9.9_

- [x] 8. Add Comprehensive Error Handling
  - Implement specific error handling for each deployment phase
  - Add circular dependency detection for nested compositions
  - Provide clear error messages for invalid cross-composition references
  - Add deployment failure recovery guidance
  - Include context information in all error messages
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 9. Create Integration Tests
  - Write integration test that deploys all three compositions in test cluster
  - Test cross-composition references work correctly in real deployment
  - Validate that nested resources are properly flattened
  - Test event monitoring across all compositions
  - Verify two webapp instances are accessible via HTTPS
  - _Requirements: 9.6, 9.7, 4.5_

- [x] 10. Add Performance Monitoring and Optimization
  - Add performance metrics collection for nested composition execution
  - Implement resource flattening performance monitoring
  - Add CEL expression generation performance tracking
  - Optimize memory usage for large numbers of nested resources
  - Add performance logging and reporting
  - _Requirements: 6.1, 6.2, 6.3, 6.5_

- [x] 11. Create Documentation and Examples
  - Write comprehensive README for the hello-world demo
  - Document the three-composition architecture and cross-composition references
  - Create troubleshooting guide for common deployment issues
  - Add code comments explaining nested composition patterns
  - Document configuration options and prerequisites
  - _Requirements: 9.8_

- [ ] 12. Replace Existing Hello World Examples
  - Replace `examples/hello-world-complete.ts` with new nested compositions demo
  - Update `examples/README.md` to document the new demo
  - Ensure the new demo is under 200 lines while remaining complete
  - Add comparison showing TypeKro ergonomics vs manual kubectl approaches
  - _Requirements: 9.8_

- [ ] 13. Fix CRD dependency ordering in nested compositions
  - **CRITICAL**: Fix ClusterIssuer deployment failing with HTTP request errors due to cert-manager CRDs not being established
  - Ensure nested compositions (like cert-manager bootstrap) complete fully before parent composition deploys custom resources
  - Improve existing `waitForCRDIfCustomResource` logic to handle nested composition CRD dependencies
  - Add dependency inference so custom resources automatically wait for CRD-installing nested compositions
  - Test that Infrastructure Composition waits for cert-manager CRDs before deploying ClusterIssuer
  - _Requirements: 9.3, 1.2, 1.3, 4.1_

## Implementation Notes

### Nested Composition Usage Pattern

The Infrastructure Composition should use this pattern for nested compositions:

```typescript
const certManagerInstance = certManager.certManagerBootstrap({
  name: 'cert-manager',
  namespace: 'cert-manager',
  version: '1.13.3',
  installCRDs: true,
  // ... other config
});

const externalDnsInstance = externalDns.externalDnsBootstrap({
  name: 'external-dns',
  namespace: 'external-dns',
  provider: 'aws',
  domainFilters: [spec.domain],
  // ... other config
});

// Reference nested status naturally
return {
  certManagerReady: certManagerInstance.status.ready,
  externalDnsReady: externalDnsInstance.status.ready,
  // ... other status fields
};
```

### Cross-Composition Reference Pattern

The demo orchestration should use this pattern for cross-composition references:

```typescript
// Deploy infrastructure with bootstrap references
const infrastructure = await infraFactory.deploy({
  domain: 'example.com',
  email: 'admin@example.com',
  runtimePhase: bootstrap.status.phase, // Cross-composition reference
  kroSystemReady: bootstrap.status.components.kroSystem // Cross-composition reference
});

// Deploy webapp with infrastructure references
const webapp = await webappFactory.deploy({
  name: 'hello-world-1',
  domain: 'app1.example.com',
  issuerName: infrastructure.status.issuerName, // Cross-composition reference
  dnsProvider: infrastructure.status.dnsProvider // Cross-composition reference
});
```

### Factory Configuration Pattern

All factories should use this configuration pattern:

```typescript
const factory = composition.factory('kro', {
  namespace: 'default',
  waitForReady: true,
  eventMonitoring: {
    enabled: true,
    eventTypes: ['Warning', 'Error', 'Normal'],
    includeChildResources: true
  },
  progressCallback: (event) => {
    console.log(`📡 ${composition.name}: ${event.message}`);
  }
});
```

### Success Criteria

Each task is complete when:
- All code compiles without TypeScript errors
- All tests pass (unit and integration where applicable)
- Code follows TypeKro patterns and best practices
- Functionality works in real Kubernetes cluster deployment
- Documentation is complete and accurate

The overall implementation is successful when:
- Three-composition demo deploys successfully
- Cross-composition references work in real deployment
- Two webapp instances are accessible via HTTPS with valid TLS certificates
- Demo code is under 200 lines while remaining complete
- All nested resources are properly flattened and deployed
- Event monitoring shows real-time Kubernetes events across all compositions


# Nested Compositions plan (Mostly completed)

Convert the feature design into a series of prompts for implementing nested compositions with a beautiful, callable API. The implementation builds on existing composition context infrastructure while adding callable composition objects, status proxies, and fixing critical bugs. Factory inheritance happens automatically through existing resource flattening.

## Tasks

### Phase 1: Core Callable Composition Infrastructure

- [x] 1. Make TypedResourceGraph interface callable
  - Add function signature `(spec: TSpec): NestedCompositionResource<TSpec, TStatus>` directly to `TypedResourceGraph` interface
  - Update interface in `src/core/types/deployment.ts` to support callable behavior
  - Ensure TypeScript recognizes both object properties and function call syntax
  - Note: `kubernetesComposition` internally uses `toResourceGraph`, so both APIs will be callable
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Implement NestedCompositionResource interface and types
  - Create `NestedCompositionResource<TSpec, TStatus>` interface in `src/core/types/deployment.ts`
  - Add properties: `status` (proxy), `spec`, `__compositionId`, `__resources`
  - Design interface to work with existing `executeNestedComposition` function
  - _Requirements: 2.1, 2.2, 3.1, 3.2_

### Phase 2: Callable Composition Implementation

- [x] 3. Modify kubernetesComposition to return callable objects
  - Update `kubernetesComposition` function in `src/core/composition/imperative.ts`
  - Create callable function wrapper that detects composition context using existing `getCurrentCompositionContext()`
  - Implement warning system for standalone calls (outside composition context)
  - Copy all TypedResourceGraph properties to callable function using `Object.assign`
  - _Requirements: 1.1, 1.2, 8.1, 8.2_

- [x] 4. Fix executeNestedComposition to support spec values and implement createNestedCompositionResource
  - **CRITICAL FIX**: Update `executeNestedComposition` to accept and pass actual spec values instead of `undefined`
  - Create `createNestedCompositionResource` function that calls fixed nested composition execution
  - Generate unique composition IDs using existing ID generation logic
  - Create and return NestedCompositionResource with status proxy
  - _Requirements: 2.1, 2.2, 3.1, 3.2_

### Phase 3: Status Proxy Implementation

- [x] 5. Implement nested status proxy system
  - Create `createNestedStatusProxy<TStatus>` function
  - Generate KubernetesRef objects for nested status field access
  - Use `__nestedComposition: true` flag for CEL generation identification
  - Ensure proxy works with TypeScript autocomplete and type safety
  - _Requirements: 2.1, 2.2, 2.4_

### Phase 4: CEL Expression Generation for Nested Status

- [x] 6. Extend existing CEL conversion engine for nested composition references
  - Modify `convertKubernetesRefToCel` method in `CelConversionEngine` to handle `__nestedComposition: true` flag
  - Generate CEL expressions that reference computed nested status: `${compositionId}_status.field`
  - Update existing JavaScript-to-CEL analyzer to detect nested composition patterns
  - Ensure integration with existing `kubernetesRefToCel` and `convertToCel` functions
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 7. Extend serialization system for nested status expressions
  - Modify existing serialization system to handle nested composition status expressions
  - Extend `serializeStatusMappingsToCel` function to create separate status expressions for each nested composition
  - Merge parent and nested status expressions into cohesive status object
  - Ensure proper dependency ordering in generated CEL expressions using existing serialization infrastructure
  - _Requirements: 2.1, 2.2, 4.2_

### Phase 5: Resource Flattening and Deployment Integration

- [x] 8. Update existing resource flattening to work with spec values
  - Update `executeNestedComposition` signature to accept spec parameter (fixing critical bug)
  - Ensure resource ID namespacing and merging logic works with spec-aware nested compositions
  - Verify that composition metadata tracking includes spec information
  - Test that nested compositions can access and use spec values correctly
  - _Requirements: 1.2, 1.3, 3.1, 3.2, 7.6_

- [x] 9. Verify factory inheritance and deployment integration
  - Test that when nested resources are flattened into parent context, they inherit factory settings automatically
  - Confirm both 'direct' and 'kro' factories work with flattened nested resources
  - Verify serialization generates correct ResourceGraphDefinition YAML for nested compositions
  - Test end-to-end deployment of compositions with nested compositions
  - _Requirements: 4.1, 4.2_

### Phase 6: Error Handling and Validation

- [x] 10. Implement comprehensive error handling for nested compositions
  - Add validation for circular dependency detection between compositions
  - Create specific error messages for nested composition failures
  - Implement resource ID conflict detection and resolution guidance
  - Add type validation for nested composition spec parameters
  - Implement warning system for compositions called outside composition context
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 11. Add performance monitoring and optimization
  - Implement performance tracking for nested composition execution
  - Add memory usage monitoring for resource flattening operations
  - Optimize CEL expression generation for nested status references
  - Add caching for repeated nested composition calls with same parameters
  - _Requirements: 6.1, 6.2, 6.3, 6.5_

### Phase 7: Testing and Integration

- [x] 12. Fix the failing test "should handle nested compositions with cross-references"
  - Update test in `test/integration/javascript-to-cel-e2e.test.ts` to use callable composition syntax
  - Change from manual resource duplication to actual composition calls: `database({ name: 'test', storage: '10Gi' })`
  - Verify that nested status references work: `database.status.ready`, `database.status.connectionString`
  - Test that CEL expressions are generated correctly for nested status references
  - _Requirements: 1.1, 2.1, 7.1, 8.1, 8.2_

- [x] 13. Add comprehensive test coverage for nested compositions
  - Test callable composition API with various nesting levels
  - Verify factory inheritance works correctly through automatic resource flattening
  - Test standalone composition calls with warning system
  - Add integration tests for nested composition deployment scenarios
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.6_

### Phase 8: Documentation and Examples

- [x] 14. Update examples to showcase beautiful nested composition API
  - Update `examples/hello-world-complete.ts` to use callable composition syntax
  - Create examples showing automatic factory inheritance and standalone usage with warnings
  - Add documentation for nested composition patterns and best practices
  - Create migration guide for existing compositions (100% backward compatible)
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ] 15. Add TypeScript documentation and type improvements
  - Ensure full TypeScript autocomplete support for nested status references
  - Add JSDoc comments for all new interfaces and functions
  - Create type-level documentation for composition patterns
  - Verify IDE experience matches design goals for developer experience
  - _Requirements: 2.4, 3.4, 8.5_

### Phase 9: Runtime Reliability Fixes

- [x] 16. Fix event monitoring connection stability issues
  - Investigate and fix ConnResetException errors in event monitoring system
  - Improve connection cleanup and error handling in `src/core/deployment/event-monitor.ts`
  - Add retry logic for failed watch connections
  - Implement graceful connection termination to prevent abrupt connection resets
  - Add connection pooling or reuse strategies to reduce connection churn
  - _Requirements: 4.5, 5.1_

- [x] 17. Fix ClusterIssuer deployment HTTP request failures
  - Debug and resolve HTTP request failures when creating ClusterIssuer resources
  - Investigate cert-manager API compatibility and request formatting issues
  - Add proper error handling and retry logic for cert-manager resource creation
  - Validate ClusterIssuer resource specification against cert-manager API schema
  - Test ClusterIssuer creation in isolation to identify root cause
  - _Requirements: 4.1, 5.1, 5.4_

- [x] 18. Fix status builder analysis and CEL conversion issues
  - Investigate status builder analysis fallbacks causing "Static fields will be hydrated directly" warnings
  - Fix CEL expression generation for nested composition status references
  - Resolve "Status builder must return an object literal" errors
  - Ensure proper JavaScript-to-CEL conversion for complex status expressions
  - Validate that nested composition status references generate correct CEL expressions
  - _Requirements: 2.1, 2.2, 2.3, 4.2_

- [x] 19. Improve deployment reliability and error recovery
  - Add comprehensive error handling for partial deployment failures
  - Implement deployment rollback capabilities for failed nested compositions
  - Add validation for AWS credentials and Route53 configuration before deployment
  - Improve timeout handling for long-running deployments (cert-manager, external-dns)
  - Add health checks and readiness validation for all deployed components
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1_

- [x] 20. Add comprehensive integration testing for runtime scenarios
  - Create integration tests that reproduce the ConnResetException errors
  - Test ClusterIssuer deployment in various cluster configurations
  - Validate status builder analysis works correctly with nested compositions
  - Test deployment recovery scenarios and error handling
  - Add performance tests for event monitoring under load
  - _Requirements: 4.5, 5.1, 6.1, 6.2_