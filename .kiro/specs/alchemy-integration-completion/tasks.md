# Implementation Plan

- [x] 1. Enhance AlchemyDeploymentStrategy to process individual resources
  - Replace the TODO comment and mock DeploymentResult in executeDeployment method
  - Implement logic to get resource graph from base strategy using createResourceGraphForInstance
  - Process each resource in the resource graph individually for Alchemy registration
  - _Requirements: 1.1, 2.1, 2.2_

- [x] 1.1 Implement individual resource processing in AlchemyDeploymentStrategy.executeDeployment
  - Remove the TODO comment and mock deployment result creation
  - Add logic to call this.baseStrategy to get the resource graph for the instance
  - Iterate through each resource in the resource graph for individual registration
  - _Requirements: 1.1, 2.1_

- [x] 1.2 Add resource type inference for individual Kubernetes resources
  - Extend inferAlchemyTypeFromTypeKroResource to handle individual Kubernetes resources properly
  - Ensure it returns kubernetes::Deployment, kubernetes::Service, etc. based on resource.kind
  - Add validation for resource type naming patterns and reserved names
  - _Requirements: 1.2, 4.1, 4.2_

- [x] 1.3 Implement individual resource registration loop in executeDeployment
  - Create loop to process each resource from the resource graph
  - Call ensureResourceTypeRegistered for each individual resource
  - Create unique resource IDs using createAlchemyResourceId for each resource
  - Deploy each resource through Alchemy using the resource provider
  - _Requirements: 1.1, 1.3, 1.4, 1.5_

- [x] 2. Create DirectTypeKroDeployer instance and integrate with resource deployment
  - Import DirectTypeKroDeployer in AlchemyDeploymentStrategy
  - Create deployer instance using the DirectDeploymentEngine from base strategy
  - Pass deployer to each resource provider for actual deployment execution
  - _Requirements: 2.3, 3.4_

- [x] 2.1 Add method to get DirectDeploymentEngine from base strategy
  - Add getDeploymentEngine method to AlchemyDeploymentStrategy
  - Extract DirectDeploymentEngine from the base DirectDeploymentStrategy
  - Create DirectTypeKroDeployer instance using the extracted engine
  - _Requirements: 2.3_

- [x] 2.2 Implement resource provider deployment calls
  - For each resource, call the ResourceProvider with proper props
  - Pass the DirectTypeKroDeployer instance as the deployer
  - Include namespace, resource, and deployment options in the provider call
  - Handle deployment options like waitForReady and timeout from factoryOptions
  - _Requirements: 1.3, 3.5_

- [x] 3. Create proper DeploymentResult from individual resource deployments
  - Replace mock DeploymentResult with actual result from individual resource deployments
  - Track each deployed resource with its Alchemy resource ID and type
  - Include proper dependency graph and deployment metadata
  - _Requirements: 2.1, 1.6_

- [x] 3.1 Implement createDeploymentResultFromIndividualResources method
  - Create method to build DeploymentResult from array of deployed resources
  - Include deploymentId, resources array with Alchemy metadata, and dependency graph
  - Add duration tracking and proper status determination based on individual resource results
  - _Requirements: 2.1_

- [x] 3.2 Add Alchemy metadata tracking to DeploymentResult
  - Include alchemyResourceId and alchemyResourceType for each deployed resource
  - Track registered resource types and total resource count in metadata
  - Add scope information and resource ID mapping for debugging
  - _Requirements: 1.6_

- [x] 4. Enhance error handling for individual resource failures
  - Add try-catch around individual resource deployment loops
  - Collect errors from individual resource deployments rather than failing immediately
  - Use handleDeploymentError with context about which resource failed
  - _Requirements: 5.3, 5.7_

- [x] 4.1 Implement partial deployment failure handling
  - Continue processing remaining resources when individual resources fail
  - Collect all errors and include them in the final DeploymentResult
  - Set deployment status to 'partial' when some resources succeed and others fail
  - _Requirements: 5.7_

- [x] 4.2 Add resource-specific error context
  - Include resource kind, name, and Alchemy resource type in error messages
  - Add resource ID and namespace information to error context
  - Ensure error messages are actionable for debugging individual resource issues
  - _Requirements: 5.4, 5.5_

- [x] 5. Write comprehensive tests for individual resource registration
  - Create unit tests for AlchemyDeploymentStrategy with individual resource processing
  - Test resource type inference for different Kubernetes resource kinds
  - Validate proper resource registration and deployment through Alchemy
  - _Requirements: 6.1, 6.4, 6.9_

- [x] 5.1 Create unit tests for AlchemyDeploymentStrategy.executeDeployment
  - Test successful deployment with multiple individual resources
  - Verify each resource gets registered with correct Alchemy resource type
  - Validate proper DeploymentResult creation with individual resource tracking
  - _Requirements: 6.1, 6.4_

- [x] 5.2 Add integration tests with real Alchemy scope
  - Follow the pattern from typekro-alchemy-integration.test.ts
  - Use real Alchemy scope and providers without mocking
  - Test DirectResourceFactory with Alchemy integration end-to-end
  - Validate individual resources appear in alchemyScope.state.all()
  - _Requirements: 6.6, 6.7, 6.8_

- [x] 5.3 Create error handling tests for individual resource failures
  - Test scenarios where individual resources fail during deployment
  - Verify partial deployment handling and error collection
  - Test resource type inference failures and validation errors
  - _Requirements: 6.2, 6.10_

- [ ] 6. Add JSDoc documentation and examples
  - Document the individual resource registration pattern in AlchemyDeploymentStrategy
  - Explain the difference between Kro mode (RGD + instance) and Direct mode (individual resources)
  - Provide examples of resource type naming patterns and inference logic
  - _Requirements: 7.1, 7.4, 7.5_

- [x] 6.1 Document AlchemyDeploymentStrategy individual resource processing
  - Add comprehensive JSDoc comments to executeDeployment method
  - Explain the resource graph processing and individual registration logic
  - Document the relationship with DirectTypeKroDeployer and base strategy
  - _Requirements: 7.1, 7.4_

- [x] 6.2 Create examples showing Direct mode Alchemy integration
  - Add example showing DirectResourceFactory with Alchemy scope
  - Demonstrate individual resource registration for common Kubernetes resources
  - Show how to debug and inspect individual resources in Alchemy state
  - _Requirements: 7.2, 7.6_

- [x] 7. Move Alchemy integration tests to proper location
  - Move all tests from test/alchemy/ to test/integration/alchemy/
  - Update import paths to reflect new directory structure
  - Ensure all tests continue to pass in new location
  - _Requirements: 6.1, 6.6_

- [x] 8. Replace remaining dynamic imports with static ESM imports
  - Identify all remaining dynamic import() statements in the codebase
  - Replace with static imports where possible, document justifications for any remaining
  - Add ESLint rules to prevent new dynamic imports without explicit approval
  - _Requirements: Code Quality, Maintainability_

- [x] 8.1 Replace dynamic imports in direct-factory.ts
  - Replace rollback-manager dynamic import with static import
  - Replace status-hydrator dynamic import with static import
  - Ensure no circular dependencies are introduced
  - _Requirements: Code Quality_

- [x] 8.2 Replace dynamic imports in kro-factory.ts
  - Replace alchemy deployment dynamic import with static import
  - Replace kro deployment engine dynamic import with static import
  - Update import organization to follow project conventions
  - _Requirements: Code Quality_

- [x] 8.3 Replace dynamic imports in resolver.ts
  - Replace ResourceReadinessChecker dynamic import with static import
  - Ensure proper dependency management and no circular references
  - _Requirements: Code Quality_

- [x] 8.4 Add ESLint rules for dynamic import prevention
  - Add rule to disallow dynamic imports except in explicitly approved cases
  - Configure rule to allow dynamic imports only with eslint-disable comments
  - Update project documentation with dynamic import guidelines
  - _Requirements: Code Quality, Maintainability_