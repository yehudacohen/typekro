# typekro - Requirements Document

## Introduction

typekro is a TypeScript-native library that enables developers to define Kro resource graphs using familiar TypeScript syntax with full type safety and promise-based dependency management. The library automatically serializes TypeScript resource definitions to Kro resource graph manifests while converting promise-based references to CEL expressions for Kubernetes reconciliation.

Typekro provides an intuitive alternative to YAML-based resource definitions while maintaining full compatibility with Kubernetes and Kro ecosystems.

## Requirements

### Requirement 1: TypeScript-Native Resource Definition

**User Story:** As a platform developer, I want to define Kro resource graphs as plain TypeScript objects with full type inference, so that I can leverage natural object composition and IDE support for infrastructure definition.

#### Acceptance Criteria

1. WHEN defining resources THEN the system SHALL support plain TypeScript objects with full type inference
2. WHEN resources reference other resources THEN the system SHALL use type-safe reference objects that resolve during Kubernetes reconciliation
3. WHEN resources are defined THEN the system SHALL provide compile-time type checking and validation for all properties
4. WHEN using IDE features THEN the system SHALL provide autocomplete, refactoring, and error detection for resource properties and cross-references
5. WHEN resources reference fields on other resources THEN the system SHALL maintain type safety using TypeScript generics
6. WHEN complex resource graphs are defined THEN the system SHALL support natural object composition without builder patterns

### Requirement 2: Kro YAML Serialization

**User Story:** As a platform developer, I want to serialize TypeScript resource definitions to Kro resource graph manifests, so that my code-defined infrastructure can be deployed to Kubernetes clusters.

#### Acceptance Criteria

1. WHEN TypeScript resources are serialized THEN the system SHALL generate valid Kro ResourceGraphDefinition YAML manifests
2. WHEN references are encountered during serialization THEN the system SHALL convert them to CEL expressions with proper dependency tracking
3. WHEN resource dependencies exist THEN the system SHALL maintain dependency ordering and relationships in the generated manifest
4. WHEN serialization occurs THEN the system SHALL preserve all resource metadata, labels, and annotations from TypeScript definitions
5. WHEN complex data types are used THEN the system SHALL handle serialization of nested objects, arrays, and custom types
6. WHEN resources have computed values THEN the system SHALL generate appropriate CEL expressions and template functions

### Requirement 3: Deterministic Resource Management and CEL Integration

**User Story:** As a platform developer, I want deterministic resource IDs and consistent CEL expression handling, so that I can reliably apply, update, and delete infrastructure resources in GitOps workflows without conflicts.

#### Acceptance Criteria

1. WHEN resources are created THEN the system SHALL generate deterministic resource IDs based on resource kind, namespace, and name rather than timestamps or random values
2. WHEN explicit resource IDs are provided THEN the system SHALL use them directly (following Kro's pattern of explicit ID specification)
3. WHEN the same resource definition is processed multiple times THEN the system SHALL generate identical resource IDs for consistent GitOps operations
4. WHEN CEL expressions are generated THEN the system SHALL use configurable context-aware prefixes instead of hardcoded "resources." strings
5. WHEN single KubernetesRef objects are serialized THEN the system SHALL convert them to CEL expressions consistently with complex CEL expressions
6. WHEN CEL expressions are processed THEN the system SHALL use a unified processing function for all reference types
7. WHEN resources are reapplied or deleted THEN the system SHALL maintain stable resource identifiers across deployments
8. WHEN working in different Kro contexts THEN the system SHALL support configurable CEL expression formats

### Requirement 4: Kubernetes Type Library Integration

**User Story:** As a platform developer, I want to use reliable managed Kubernetes type libraries, so that I don't have to rebuild Kubernetes resource definitions from scratch and can leverage existing type safety.

#### Acceptance Criteria

1. WHEN defining Kubernetes resources THEN the system SHALL integrate with @kubernetes/client-node as the official TypeScript Kubernetes client library
2. WHEN using Kubernetes types THEN the system SHALL provide full type safety and validation for all standard Kubernetes resources using official type definitions
3. WHEN Kubernetes API versions change THEN the system SHALL support multiple API versions seamlessly through @kubernetes/client-node library updates
4. WHEN library updates occur THEN the system SHALL maintain backward compatibility where possible and provide migration paths
5. WHEN serializing Kubernetes resources THEN the system SHALL generate manifests that conform to the exact API specifications from @kubernetes/client-node

### Requirement 5: Custom Resource Definition Support

**User Story:** As a platform developer, I want to define custom resource definitions (CRDs) with static TypeScript typing, so that I can extend Kubernetes with type-safe custom resources integrated into the Kro resource graph system.

#### Acceptance Criteria

1. WHEN defining CRDs THEN the system SHALL support Arktype-based schema definitions with automatic TypeScript interface generation
2. WHEN using custom resources THEN the system SHALL provide the same type safety and reference-based dependency support as built-in Kubernetes resources
3. WHEN CRD schemas are defined THEN the system SHALL provide runtime validation with helpful error messages
4. WHEN custom resources have complex validation THEN the system SHALL enforce validation rules at both compile time and runtime
5. WHEN custom resources are serialized THEN the system SHALL generate valid custom resource instances within Kro resource graphs
6. WHEN CRDs have dependencies on other resources THEN the system SHALL support cross-resource type references and dependency relationships

### Requirement 6: Alchemy.run Integration

**User Story:** As a platform developer, I want typekro to integrate seamlessly with Alchemy.run for complete infrastructure lifecycle management, so that I can define infrastructure in TypeScript and have it automatically managed through its entire lifecycle.

#### Acceptance Criteria

1. WHEN using Alchemy.run THEN typekro SHALL provide resource factory functions that integrate with Alchemy's resource management
2. WHEN Alchemy resources are created THEN typekro SHALL automatically handle YAML generation and Kubernetes deployment
3. WHEN resources change THEN Alchemy SHALL detect changes and automatically regenerate and reapply Kro YAML
4. WHEN resources are deleted THEN Alchemy SHALL handle cleanup of generated Kubernetes resources
5. WHEN using typekro with Alchemy THEN developers SHALL have a seamless experience from TypeScript definition to running infrastructure

### Requirement 7: Developer Experience Excellence

**User Story:** As a platform developer, I want an exceptional developer experience when defining infrastructure, so that I can be productive and confident in my infrastructure definitions.

#### Acceptance Criteria

1. WHEN writing TypeScript infrastructure code THEN the system SHALL provide immediate feedback through IDE integration
2. WHEN errors occur THEN the system SHALL provide clear, actionable error messages with suggestions for resolution
3. WHEN learning the library THEN developers SHALL find comprehensive documentation, examples, and tutorials
4. WHEN debugging issues THEN developers SHALL have access to clear serialization output and dependency visualization
5. WHEN working with complex resource graphs THEN the system SHALL provide tools for validation and testing
6. WHEN collaborating with teams THEN the system SHALL support standard TypeScript tooling for code review and version control

### Requirement 8: Error Handling and Resilience

**User Story:** As a platform developer, I want comprehensive error handling and clear error messages, so that I can quickly identify and resolve issues in my infrastructure definitions.

#### Acceptance Criteria

1. WHEN compilation errors occur THEN the system SHALL provide precise error locations with helpful suggestions
2. WHEN serialization fails THEN the system SHALL provide detailed error messages with context about the failing resource
3. WHEN reference resolution fails THEN the system SHALL provide clear information about missing or invalid references
4. WHEN validation errors occur THEN the system SHALL provide actionable error messages with examples of correct usage
5. WHEN runtime errors occur THEN the system SHALL provide stack traces that map back to the original TypeScript code
6. WHEN schema validation fails THEN the system SHALL provide detailed information about which fields are invalid and why

### Requirement 9: Performance and Scalability

**User Story:** As a platform developer, I want typekro to perform well with large resource graphs, so that I can define complex infrastructure without performance bottlenecks.

#### Acceptance Criteria

1. WHEN compiling large projects THEN TypeScript compilation SHALL complete in reasonable time (<5s for 100+ resources)
2. WHEN serializing complex graphs THEN YAML generation SHALL be efficient (<1s for 50+ resources)
3. WHEN using IDE features THEN autocomplete and type checking SHALL be responsive (<500ms)
4. WHEN processing deep dependency chains THEN the system SHALL handle them efficiently without stack overflow
5. WHEN working with large schemas THEN memory usage SHALL remain reasonable (<100MB during compilation)
6. WHEN caching is possible THEN the system SHALL cache expensive operations to improve performance

### Requirement 10: Versioning and Compatibility

**User Story:** As a platform developer, I want clear versioning and compatibility guarantees, so that I can upgrade typekro safely without breaking my infrastructure definitions.

#### Acceptance Criteria

1. WHEN new versions are released THEN the system SHALL follow semantic versioning with clear breaking change documentation
2. WHEN Kubernetes API versions change THEN the system SHALL support multiple API versions with migration paths
3. WHEN Kro specifications evolve THEN the system SHALL maintain backward compatibility where possible
4. WHEN breaking changes are necessary THEN the system SHALL provide automated migration tools
5. WHEN dependencies are updated THEN the system SHALL maintain compatibility with existing user code
6. WHEN deprecating features THEN the system SHALL provide clear deprecation warnings and migration guidance

### Requirement 11: GitOps Integration

**User Story:** As a platform developer, I want to define GitOps workflows using TypeScript with full type safety, so that I can manage application deployments through Git-based workflows while maintaining cross-resource references.

#### Acceptance Criteria

1. WHEN defining ArgoCD applications THEN the system SHALL support Application, ApplicationSet, and AppProject CRDs with full type safety
2. WHEN defining Flux resources THEN the system SHALL support GitRepository, HelmRepository, Kustomization, and HelmRelease CRDs with full type safety
3. WHEN GitOps resources reference other resources THEN the system SHALL provide type-safe cross-resource references
4. WHEN GitOps resources are serialized THEN the system SHALL generate valid CRD manifests that conform to ArgoCD and Flux API specifications
5. WHEN using GitOps workflows THEN the system SHALL support app-of-apps patterns and multi-source configurations
6. WHEN GitOps resources have dependencies THEN the system SHALL maintain proper dependency ordering in generated manifests

### Requirement 12: Infrastructure CRD Support

**User Story:** As a platform developer, I want to define infrastructure components using popular CRDs with TypeScript type safety, so that I can manage certificates, secrets, and other infrastructure concerns alongside my applications.

#### Acceptance Criteria

1. WHEN defining TLS certificates THEN the system SHALL support cert-manager Certificate and ClusterIssuer CRDs with full type safety
2. WHEN defining external secrets THEN the system SHALL support External Secrets Operator CRDs with full type safety
3. WHEN infrastructure CRDs reference other resources THEN the system SHALL provide type-safe cross-resource references
4. WHEN infrastructure CRDs are serialized THEN the system SHALL generate valid CRD manifests that conform to the respective operator API specifications
5. WHEN infrastructure resources have complex validation THEN the system SHALL enforce validation rules at both compile time and runtime
6. WHEN infrastructure resources are used THEN the system SHALL provide the same developer experience as built-in Kubernetes resources

### Requirement 13: Remove Hardcoded Field Whitelist and Use Explicit CEL Conversions

**User Story:** As a platform developer, I want to use existing CEL utility methods for type conversions and have the existing type system prevent type mismatches, so that I don't rely on brittle field whitelists and get compile-time safety through the current `EnvVarValue` type.

#### Acceptance Criteria

1. WHEN the system generates CEL expressions THEN it SHALL NOT use hardcoded field name whitelists for type conversion
2. WHEN I need to convert a numeric reference to string THEN I SHALL use existing `Cel.string(ref)` utility methods
3. WHEN I try to assign `KubernetesRef<number>` to `EnvVarValue` THEN TypeScript SHALL prevent the assignment at compile time
4. WHEN I assign `KubernetesRef<string>` to `EnvVarValue` THEN TypeScript SHALL allow the assignment without conversion
5. WHEN I assign `CelExpression` to `EnvVarValue` THEN TypeScript SHALL allow the assignment as it represents valid CEL syntax
6. WHEN I use `Cel.string(database.status.readyReplicas)` THEN it SHALL generate `${string(database.status.readyReplicas)}` CEL expression
7. WHEN the system processes `KubernetesRef` objects THEN it SHALL generate basic `${resource.field}` expressions without automatic conversions
8. WHEN the system processes `CelExpression` objects THEN it SHALL use the pre-built CEL syntax from the expression
9. WHEN new Kubernetes field types are added THEN the system SHALL work without code changes because it uses explicit conversions and existing type constraints

## Non-Functional Requirements

### Performance Requirements

1. **Compilation Speed** - TypeScript compilation with typekro SHALL complete in <5 seconds for projects with 100+ resources
2. **Serialization Speed** - YAML generation SHALL complete in <1 second for resource graphs with 50+ resources
3. **Memory Usage** - typekro SHALL use <100MB of memory during compilation and serialization
4. **IDE Responsiveness** - IDE features (autocomplete, error checking) SHALL respond in <500ms

### Compatibility Requirements

1. **TypeScript Versions** - Support TypeScript 5.0+ with backward compatibility for 4.8+
2. **Node.js Versions** - Support Node.js 18+ and Bun 1.0+
3. **Kubernetes Versions** - Support Kubernetes 1.25+ through @kubernetes/client-node integration
4. **Kro Versions** - Support Kro v1alpha1 API with forward compatibility planning

### Security Requirements

1. **Input Validation** - All user inputs SHALL be validated using Arktype schemas with comprehensive error handling
2. **Code Generation** - Generated YAML SHALL be safe from injection attacks and malformed content
3. **Dependency Management** - All dependencies SHALL be regularly updated and security-scanned
4. **Secrets Handling** - The library SHALL NOT log or expose sensitive data during serialization

## Success Criteria

typekro will be considered successful when:

1. **Developer Adoption** - 90% of Kubernetes developers prefer typekro over YAML for infrastructure definition
2. **Error Reduction** - Infrastructure definition errors reduced by 80% compared to YAML-based approaches
3. **Development Speed** - Infrastructure development time reduced by 70% compared to traditional methods
4. **Type Safety** - 100% of cross-resource references are type-safe with compile-time validation
5. **Ecosystem Integration** - Seamless integration with popular TypeScript tooling and development workflows