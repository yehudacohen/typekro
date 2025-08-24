# Implementation Plan - Imperative Composition Pattern

## Phase 1: Foundation and Context-Aware Registration

- [ ] 1. Add Composition Context Infrastructure
  - [x] 1.1 Add AsyncLocalStorage import and CompositionContext interface to shared.ts
  - [x] 1.2 Create getCurrentCompositionContext() helper function
  - [x] 1.3 Add context detection and registration logic to createResource()
  - [x] 1.4 Ensure backward compatibility - factory functions work unchanged outside context
  - _Requirements: 2.1, 2.2, 2.3, 4.1, 4.2_

- [ ] 2. Create Basic kubernetesComposition Function
  - [x] 2.1 Create new file src/core/composition/imperative.ts
  - [x] 2.2 Implement kubernetesComposition with basic context management
  - [x] 2.3 Add CompositionFactory interface and toResourceGraph() method
  - [x] 2.4 Integrate with existing toResourceGraph() function
  - _Requirements: 1.1, 1.2, 1.3, 6.1, 6.2_

- [x] 3. Use Existing Status Object Infrastructure
  - [x] 3.1 Update composition function signature to return MagicAssignableShape<TStatus>
  - [x] 3.2 Leverage existing status processing from toResourceGraph infrastructure
  - [x] 3.3 Support CEL expressions (Cel.expr, Cel.template) - pass through unchanged
  - [x] 3.4 Support resource references using existing magic proxy system
  - [x] 3.5 Validate returned object matches status schema using existing validation
  - _Requirements: 3.1, 3.2, 3.4, 7.1, 7.2_

- [ ] 4. Update Type Definitions
  - [x] 4.1 Add CompositionFactory interface to types/serialization.ts
  - [x] 4.2 Add composition-related error types to core/errors.ts
  - [x] 4.3 Export new types and functions from index.ts
  - _Requirements: 7.1, 7.2, 7.3, 8.3_

- [ ] 5. Create Basic Test Suite
  - [x] 5.1 Create test/core/imperative-composition.test.ts
  - [x] 5.2 Test context-aware resource registration
  - [x] 5.3 Test basic composition function execution
  - [x] 5.4 Test integration with toResourceGraph()
  - [x] 5.5 Test backward compatibility of factory functions
  - _Requirements: 2.1, 2.2, 4.1, 4.2, 6.1_

## Phase 2: Integration and Polish

- [ ] 6. Enhance Error Handling
  - [x] 6.1 Add CompositionError for composition-specific failures
  - [x] 6.2 Add ContextRegistrationError for resource registration failures
  - [x] 6.3 Provide clear error messages for unsupported patterns
  - [x] 6.4 Add debugging information for composition execution
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 7. Validate Status Object Integration
  - [x] 7.1 Test nested status object structures work with existing infrastructure
  - [x] 7.2 Verify error messages for invalid status objects are clear
  - [x] 7.3 Test schema validation works with MagicAssignableShape<TStatus>
  - [x] 7.4 Test complex status object scenarios with CEL expressions and resource references
  - _Requirements: 3.3, 3.4, 3.5_

## Phase 3: Advanced Features

- [x] 8. Synchronous Composition Support
  - [x] 8.1 Ensure AsyncLocalStorage works for synchronous context isolation
  - [x] 8.2 Validate synchronous composition functions work correctly
  - [x] 8.3 Ensure factory functions work synchronously within composition
  - [x] 8.4 Add proper cleanup for synchronous contexts
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 9. Enhance Resource Management
  - [ ] 9.1 Add automatic resource ID generation strategies
  - [ ] 9.2 Implement resource dependency tracking
  - [ ] 9.3 Add duplicate resource detection and handling
  - [ ] 9.4 Support custom resource naming patterns
  - _Requirements: 2.3, 2.4, 2.5_

## Phase 4: Testing and Documentation

- [ ] 10. Comprehensive Test Coverage
  - [ ] 10.1 Add unit tests for all composition patterns
  - [ ] 10.2 Add integration tests with real Kubernetes resources
  - [ ] 10.3 Add performance tests for context management
  - [ ] 10.4 Add error scenario tests
  - [ ] 10.5 Test synchronous composition patterns
  - _Requirements: All requirements for validation_

- [x] 11. Create Integration Tests
  - [x] 11.1 Create test/integration/imperative-e2e.test.ts
  - [x] 11.2 Test YAML generation compatibility
  - [x] 11.3 Test factory methods work identically
  - [x] 11.4 Test Alchemy integration (if applicable)
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 12. Add Generic Deployment Closure Support
  - [x] 12.1 Create registerDeploymentClosure() generic wrapper function
  - [x] 12.2 Extend CompositionContext to capture any deployment closures
  - [x] 12.3 Modify existing yamlFile() and yamlDirectory() to use registration wrapper
  - [x] 12.4 Update kubernetesComposition to pass closures to toResourceGraph
  - [x] 12.5 Test that any future deployment closure automatically works
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ] 13. Implement Direct API and Composition of Compositions
  - [x] 13.1 Change kubernetesComposition to return TypedResourceGraph directly
  - [x] 13.2 Add transparent context passing for nested compositions
  - [x] 13.3 Implement resource and closure merging for composed compositions
  - [x] 13.4 Add unique identifier generation across composition boundaries
  - [x] 13.5 Update all tests to use direct API
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ] 14. Add Examples and Documentation
  - [ ] 14.1 Create examples/imperative-composition.ts
  - [ ] 14.2 Add migration guide from toResourceGraph
  - [ ] 14.3 Create examples showing deployment closures
  - [ ] 14.4 Create examples showing composition of compositions
  - [ ] 14.5 Add debugging and troubleshooting guide
  - _Requirements: All requirements for demonstration_

## Success Metrics

### Functionality
- [ ] All factory functions work automatically with composition context
- [ ] Literal value and CEL expression support in status objects
- [ ] 100% compatibility with existing toResourceGraph output
- [ ] Full TypeScript type safety throughout composition process

### Quality
- [ ] >95% test coverage for composition functionality
- [ ] All existing tests continue to pass (regression testing)
- [ ] Clear error messages for all failure scenarios
- [ ] Performance impact <5% for normal factory function usage

### Usability
- [ ] Simple migration path from toResourceGraph documented
- [ ] Examples demonstrating common patterns
- [ ] IDE autocomplete and type checking work throughout
- [ ] Debugging capabilities for failed compositions

## Implementation Notes

### Key Design Decisions

1. **Modify createResource() in shared.ts**: This ensures zero changes needed to individual factory functions while providing automatic registration.

2. **Use AsyncLocalStorage**: Provides reliable context management for synchronous execution without global state pollution.

3. **MagicAssignableShape Status Return**: Use existing status builder infrastructure by returning MagicAssignableShape<TStatus> - no new processing needed.

4. **Additive API Design**: Completely backward compatible - existing code continues to work unchanged.

### Integration with Existing TypeKro Systems

This spec focuses on the imperative composition pattern itself. The status object processing leverages existing TypeKro infrastructure:

1. **MagicAssignableShape<TStatus>** - same type as status builders return
2. **Existing CEL expression handling** - Cel.expr, Cel.template pass through unchanged  
3. **Existing resource reference system** - magic proxy system handles resource.status.field references
4. **Existing schema validation** - no new validation logic needed

The imperative composition pattern provides a natural JavaScript API while leveraging existing TypeKro infrastructure for resource management and CEL expression handling.