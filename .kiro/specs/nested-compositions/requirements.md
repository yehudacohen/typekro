# Requirements Document

## Introduction

TypeKro needs support for nested compositions - the ability to use one composition as a resource within another composition. This enables powerful modularity and reusability patterns where complex infrastructure components can be composed together naturally. Currently, users must duplicate resources or use external references, which breaks the composability model that makes TypeKro powerful.

This feature will enable developers to build hierarchical compositions where infrastructure components (like databases, caches, monitoring) can be defined once and reused across multiple applications, while maintaining full type safety and cross-resource references.

## Requirements

### Requirement 1

**User Story:** As a developer using TypeKro, I want to nest one composition inside another composition so that I can build modular, reusable infrastructure components.

#### Acceptance Criteria

1. WHEN I call a TypedResourceGraph as a function within another composition THEN TypeKro SHALL treat it as a nested composition
2. WHEN I nest a composition THEN TypeKro SHALL flatten all nested resources into the parent composition's resource graph
3. WHEN I nest a composition THEN TypeKro SHALL preserve the nested composition's resource IDs with proper namespacing
4. WHEN I nest a composition THEN TypeKro SHALL make the nested composition's status available for references through a status proxy
5. WHEN I deploy a composition with nested compositions THEN all resources SHALL be deployed as a single cohesive unit

### Requirement 2

**User Story:** As a developer, I want to reference the status of nested compositions in my parent composition so that I can create dependencies and pass configuration between components.

#### Acceptance Criteria

1. WHEN I access `nestedComposition.status.field` THEN TypeKro SHALL generate proper CEL expressions for the nested status
2. WHEN I use nested status in environment variables THEN TypeKro SHALL create proper resource references
3. WHEN I use nested status in conditional expressions THEN TypeKro SHALL generate correct CEL logic
4. WHEN I reference nested status fields THEN TypeScript SHALL provide full type safety and autocomplete
5. WHEN nested status is used in parent status THEN TypeKro SHALL create proper dependency chains

### Requirement 3

**User Story:** As a developer, I want nested compositions to maintain their encapsulation while being composable so that I can build clean, maintainable infrastructure code.

#### Acceptance Criteria

1. WHEN I nest a composition THEN the nested composition's internal resource IDs SHALL be namespaced to avoid conflicts
2. WHEN I nest multiple instances of the same composition THEN each instance SHALL have unique resource identifiers
3. WHEN I nest compositions THEN the parent composition SHALL not need to know about internal nested resources
4. WHEN I nest compositions THEN the nested composition's interface SHALL remain stable regardless of internal changes
5. WHEN I nest compositions THEN TypeScript SHALL enforce the nested composition's spec interface

### Requirement 4

**User Story:** As a developer, I want nested compositions to work seamlessly with TypeKro's existing features so that I don't lose any functionality when composing.

#### Acceptance Criteria

1. WHEN I use nested compositions THEN they SHALL work with both direct and Kro deployment strategies
2. WHEN I use nested compositions THEN CEL expression generation SHALL work correctly for all references
3. WHEN I use nested compositions THEN resource dependency resolution SHALL handle nested dependencies
4. WHEN I use nested compositions THEN serialization to YAML SHALL produce correct ResourceGraphDefinitions
5. WHEN I use nested compositions THEN event monitoring SHALL track all nested resources

### Requirement 5

**User Story:** As a developer, I want clear error messages when nested compositions fail so that I can debug issues effectively.

#### Acceptance Criteria

1. WHEN nested composition validation fails THEN TypeKro SHALL provide clear error messages indicating which nested composition failed
2. WHEN nested resource ID conflicts occur THEN TypeKro SHALL provide specific guidance on resolution
3. WHEN nested status references are invalid THEN TypeKro SHALL indicate the specific nested composition and field
4. WHEN nested composition deployment fails THEN error messages SHALL include the nested composition context
5. WHEN circular dependencies exist between nested compositions THEN TypeKro SHALL detect and report them clearly
6. WHEN a composition is called outside composition context THEN TypeKro SHALL warn and default to direct mode

### Requirement 6

**User Story:** As a developer, I want nested compositions to be performant and not significantly impact deployment time so that complex compositions remain practical.

#### Acceptance Criteria

1. WHEN I nest compositions THEN resource flattening SHALL not significantly impact composition execution time
2. WHEN I nest compositions THEN CEL expression generation SHALL remain efficient
3. WHEN I nest compositions THEN serialization performance SHALL scale linearly with the number of resources
4. WHEN I deploy nested compositions THEN deployment time SHALL not be significantly impacted by nesting depth
5. WHEN I use many nested compositions THEN memory usage SHALL remain reasonable

### Requirement 7

**User Story:** As a developer, I want to pass parameters to nested compositions so that I can customize their behavior for different use cases.

#### Acceptance Criteria

1. WHEN I call a nested composition THEN I SHALL be able to pass a spec object that matches the nested composition's spec schema
2. WHEN I pass parameters to nested compositions THEN TypeScript SHALL validate the parameter types
3. WHEN I pass schema references to nested compositions THEN TypeKro SHALL handle the references correctly
4. WHEN I pass complex objects to nested compositions THEN all nested fields SHALL be properly processed
5. WHEN nested composition parameters are invalid THEN TypeKro SHALL provide clear validation errors
6. WHEN I pass spec values to nested compositions THEN the nested composition SHALL receive and use those values (fixing current bug where undefined is passed)

### Requirement 8

**User Story:** As a developer, I want nested compositions to support the same patterns as top-level compositions so that the API is consistent and predictable.

#### Acceptance Criteria

1. WHEN I use nested compositions THEN they SHALL support the same JavaScript expression patterns as top-level compositions
2. WHEN I use nested compositions THEN they SHALL support the same resource factory patterns
3. WHEN I use nested compositions THEN they SHALL support the same status expression patterns
4. WHEN I use nested compositions THEN they SHALL support the same cross-resource reference patterns
5. WHEN I use nested compositions THEN the development experience SHALL be identical to top-level compositions

### Requirement 9: Three-Composition Demo Architecture

**User Story:** As a developer, I want a complete hello-world demo that showcases three distinct nested compositions with cross-composition referencing, so that I can see how TypeKro enables modular infrastructure patterns.

#### Acceptance Criteria

1. WHEN I run the hello-world demo THEN it SHALL create exactly three composition types:
   - TypeKro Bootstrap Composition (deployed in direct mode)
   - Infrastructure Composition (deployed in kro mode) 
   - Webapp Composition (deployed in kro mode)

2. WHEN TypeKro Bootstrap Composition deploys THEN it SHALL:
   - Deploy TypeKro runtime (Flux + Kro) in direct mode
   - Provide status indicating runtime readiness
   - Be deployed as one instance

3. WHEN Infrastructure Composition deploys THEN it SHALL:
   - Deploy external-dns, cert-manager, and certificate issuer in kro mode
   - Reference TypeKro Bootstrap status for deployment dependencies
   - Provide status with issuer readiness and DNS configuration
   - Be deployed as one instance

4. WHEN Webapp Composition deploys THEN it SHALL:
   - Deploy a Deployment and Service with TLS certificate in kro mode
   - Reference Infrastructure Composition status for certificate issuer and DNS configuration
   - Use cross-composition referencing to get issuer name and DNS settings
   - Provide status with deployment readiness and HTTPS URL
   - Be deployed as two instances with different configurations

5. WHEN cross-composition references are used THEN they SHALL:
   - Pass issuer name from Infrastructure to Webapp compositions
   - Pass DNS configuration from Infrastructure to Webapp compositions
   - Create proper dependency chains between compositions
   - Generate correct CEL expressions for status references

6. WHEN all compositions are deployed THEN event monitoring SHALL show real-time Kubernetes events for all nested resources across all three composition types

7. WHEN demo completes THEN two webapp instances SHALL be accessible via HTTPS with automatically managed DNS records and TLS certificates

8. WHEN examining the demo code THEN it SHALL demonstrate cross-composition referencing patterns in under 200 lines using only TypeKro APIs

9. WHEN demo encounters errors THEN it SHALL provide helpful guidance for troubleshooting composition dependencies

10. WHEN demo succeeds THEN it SHALL verify connectivity with curl and provide accessible URLs for both webapp instances