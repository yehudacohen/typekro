# Requirements Document

## Introduction

This document specifies the requirements for a comprehensive documentation overhaul of TypeKro. The goal is to create minimalist but exceedingly impactful documentation that captures the power and expressiveness of TypeKro, replacing stale and over-verbose content with clear, compelling examples that demonstrate TypeKro's unique value proposition.

## Glossary

- **TypeKro**: A TypeScript-first framework for orchestrating Kubernetes resources with type safety and runtime intelligence
- **Kro**: Kubernetes Resource Orchestrator - the underlying runtime that evaluates CEL expressions and manages resource dependencies
- **CEL**: Common Expression Language - the expression language used by Kubernetes for runtime evaluation
- **Magic_Proxy**: TypeKro's proxy system that intercepts property access to generate CEL expressions while maintaining TypeScript type safety
- **Enhanced_Type**: TypeKro's wrapper type that provides non-optional access to Kubernetes resource properties
- **ResourceGraphDefinition**: A Kro CRD that defines a group of Kubernetes resources and their relationships
- **Direct_Deployment**: TypeKro deployment mode that deploys resources directly to Kubernetes without Kro
- **Kro_Deployment**: TypeKro deployment mode that generates ResourceGraphDefinitions for Kro to manage
- **YAML_Closure**: TypeKro's ability to include external YAML files and directories in compositions
- **Simple_Factory**: Simplified factory functions (e.g., `simple.Deployment`) that reduce boilerplate
- **Alchemy**: Infrastructure-as-TypeScript tool for deploying to cloud providers (AWS, Cloudflare, etc.)

## Requirements

### Requirement 1: Hero Section and README

**User Story:** As a developer discovering TypeKro, I want to immediately understand what TypeKro does and see its power in action, so that I can decide if it's right for my project.

#### Acceptance Criteria

1. WHEN a developer visits the README or homepage, THE Documentation SHALL display a single, compelling code example under 30 lines that demonstrates TypeKro's core value
2. WHEN viewing the hero example, THE Documentation SHALL show type-safe schema definition, resource creation, cross-resource references, and JavaScript-to-CEL conversion in one cohesive example
3. THE Documentation SHALL include a one-sentence tagline that captures TypeKro's essence: "Write TypeScript. Deploy Kubernetes. Runtime intelligence included."
4. WHEN comparing to alternatives, THE Documentation SHALL provide a concise comparison table showing TypeKro vs Pulumi, CDK8s, Helm, and Kustomize
5. THE README SHALL be under 500 lines total, focusing on impact over comprehensiveness

### Requirement 2: Philosophy and Mental Model

**User Story:** As a developer learning TypeKro, I want to understand the philosophy and mental model behind it, so that I can use it effectively and understand design decisions.

#### Acceptance Criteria

1. THE Documentation SHALL explain TypeKro's core philosophy in under 200 words: "Write infrastructure like you write application code"
2. WHEN explaining the mental model, THE Documentation SHALL describe the three-layer architecture: TypeScript (compile-time) → CEL (runtime) → Kubernetes (cluster)
3. THE Documentation SHALL explain why TypeKro exists: bridging the gap between type-safe development and runtime-aware infrastructure
4. WHEN describing trade-offs, THE Documentation SHALL be honest about when TypeKro is NOT the right choice (simple static YAML, no runtime dependencies needed)

### Requirement 3: kubernetesComposition API Documentation

**User Story:** As a developer using TypeKro, I want clear documentation of the kubernetesComposition API, so that I can create type-safe resource compositions.

#### Acceptance Criteria

1. THE Documentation SHALL provide a complete API reference for `kubernetesComposition` with all parameters documented
2. WHEN showing examples, THE Documentation SHALL demonstrate the imperative pattern with auto-registration of resources
3. THE Documentation SHALL explain the composition function signature: `(spec) => StatusObject`
4. WHEN documenting status builders, THE Documentation SHALL show how JavaScript expressions are automatically converted to CEL
5. THE Documentation SHALL include examples of nested status objects and complex status expressions

### Requirement 4: Magic Proxy System Documentation

**User Story:** As a developer debugging TypeKro code, I want to understand how the magic proxy system works, so that I can understand what happens under the hood.

#### Acceptance Criteria

1. THE Documentation SHALL explain the dual nature of proxies: compile-time types vs runtime references
2. WHEN explaining schema proxies, THE Documentation SHALL show how `spec.name` becomes `${self.spec.name}` in CEL
3. WHEN explaining resource proxies, THE Documentation SHALL show how `deployment.status.readyReplicas` becomes `${resources.deployment.status.readyReplicas}`
4. THE Documentation SHALL clearly distinguish between static values (known at build time) and dynamic references (resolved at runtime)
5. WHEN documenting the `$` prefix, THE Documentation SHALL explain when and why to use explicit runtime references

### Requirement 5: JavaScript to CEL Conversion Documentation

**User Story:** As a developer writing status expressions, I want to understand what JavaScript patterns are supported for automatic CEL conversion, so that I can write natural code that works correctly.

#### Acceptance Criteria

1. THE Documentation SHALL list all supported JavaScript patterns: comparisons, logical operators, template literals, ternary expressions, optional chaining, nullish coalescing
2. WHEN showing conversions, THE Documentation SHALL provide side-by-side JavaScript → CEL examples
3. THE Documentation SHALL clearly document unsupported patterns: function calls, destructuring, loops, variable assignments
4. WHEN patterns are unsupported, THE Documentation SHALL show the explicit CEL escape hatch using `Cel.expr()`
5. THE Documentation SHALL explain that only expressions containing resource/schema references are converted

### Requirement 6: Explicit CEL API Documentation

**User Story:** As a developer needing advanced CEL operations, I want documentation of the explicit CEL API, so that I can use complex list operations and CEL functions.

#### Acceptance Criteria

1. THE Documentation SHALL document `Cel.expr()` for creating arbitrary CEL expressions with type parameters
2. THE Documentation SHALL document `Cel.template()` for string interpolation with `%s` placeholders
3. THE Documentation SHALL document `Cel.map()` and `Cel.filter()` for list operations
4. THE Documentation SHALL document `Cel.conditional()` for explicit ternary expressions
5. WHEN showing examples, THE Documentation SHALL demonstrate when explicit CEL is preferred over JavaScript expressions

### Requirement 7: Deployment Modes Documentation

**User Story:** As a developer deploying TypeKro compositions, I want to understand the different deployment modes, so that I can choose the right approach for my use case.

#### Acceptance Criteria

1. THE Documentation SHALL explain Direct deployment: immediate deployment without Kro, CRD timing handled automatically
2. THE Documentation SHALL explain Kro deployment: generates ResourceGraphDefinitions for Kro controller to manage
3. THE Documentation SHALL explain YAML generation: deterministic output for GitOps workflows
4. WHEN comparing modes, THE Documentation SHALL provide a decision matrix based on use case (development, production, GitOps, runtime dependencies)
5. THE Documentation SHALL explain how TypeKro delays CR deployment until CRDs are installed

### Requirement 8: Factory Functions Documentation

**User Story:** As a developer creating Kubernetes resources, I want comprehensive documentation of factory functions, so that I can use the right factory for each resource type.

#### Acceptance Criteria

1. THE Documentation SHALL provide a complete reference of all simple factories: Deployment, Service, ConfigMap, Secret, Ingress, PVC, etc.
2. WHEN documenting factories, THE Documentation SHALL show the minimal required parameters and common optional parameters
3. THE Documentation SHALL document the `id` parameter for cross-resource references
4. THE Documentation SHALL explain the difference between simple factories (`simple.Deployment`) and full factories (`kubernetes.Deployment`)
5. WHEN showing examples, THE Documentation SHALL demonstrate type-safe configuration with IDE autocomplete

### Requirement 9: YAML Closures and Helm Integration

**User Story:** As a developer integrating existing YAML and Helm charts, I want documentation of YAML closures and Helm integration, so that I can combine TypeKro with existing infrastructure.

#### Acceptance Criteria

1. THE Documentation SHALL document `yamlFile()` for including external YAML files
2. THE Documentation SHALL document `yamlDirectory()` for including directories with optional Kustomization
3. THE Documentation SHALL document `helmRelease()` and `helmRepository()` for Flux HelmRelease integration
4. WHEN showing Helm examples, THE Documentation SHALL demonstrate type-safe Helm values with schema references
5. THE Documentation SHALL explain how YAML closures integrate with the resource graph and status expressions

### Requirement 10: Creating Custom Integrations

**User Story:** As a developer extending TypeKro, I want documentation on creating custom factories and integrations, so that I can add support for new CRDs and resources.

#### Acceptance Criteria

1. THE Documentation SHALL provide a guide for creating custom factory functions using `createResource()`
2. WHEN creating factories, THE Documentation SHALL explain how to define proper TypeScript types for spec and status
3. THE Documentation SHALL document how to create factories for custom CRDs with proper type inference
4. THE Documentation SHALL explain the Enhanced type system and how to properly type factory return values
5. WHEN showing examples, THE Documentation SHALL demonstrate creating a factory for a real-world CRD (e.g., Cert-Manager Certificate)

### Requirement 11: Composability and External References

**User Story:** As a developer building complex systems, I want documentation on composing multiple compositions together, so that I can build modular, reusable infrastructure.

#### Acceptance Criteria

1. THE Documentation SHALL explain how to compose multiple `kubernetesComposition` results together
2. WHEN showing composition patterns, THE Documentation SHALL demonstrate referencing resources from one composition in another
3. THE Documentation SHALL document external references for cross-team coordination
4. THE Documentation SHALL explain how resource IDs enable cross-composition references
5. WHEN showing examples, THE Documentation SHALL demonstrate a realistic multi-tier application with database, API, and frontend compositions

### Requirement 12: Examples and Patterns

**User Story:** As a developer learning TypeKro, I want practical examples and patterns, so that I can apply TypeKro to real-world scenarios.

#### Acceptance Criteria

1. THE Documentation SHALL provide a "Basic Web App" example showing Deployment + Service + Ingress
2. THE Documentation SHALL provide a "Database-Backed App" example showing cross-resource references for database connection strings
3. THE Documentation SHALL provide a "Helm Integration" example showing HelmRelease with type-safe values
4. THE Documentation SHALL provide a "Multi-Environment" example showing environment-specific configurations
5. WHEN showing examples, THE Documentation SHALL keep each example under 50 lines and focused on one concept

### Requirement 13: Documentation Structure and Navigation

**User Story:** As a developer navigating the documentation, I want a clear structure and navigation, so that I can find information quickly.

#### Acceptance Criteria

1. THE Documentation SHALL organize content into: Getting Started, Core Concepts, API Reference, Examples, Advanced Topics
2. WHEN organizing Getting Started, THE Documentation SHALL provide a 5-minute quick start that deploys a working application
3. THE Documentation SHALL provide clear "Next Steps" links at the end of each page
4. WHEN organizing API Reference, THE Documentation SHALL group by category: Composition, Factories, CEL, Deployment
5. THE Documentation SHALL include a search function and comprehensive sidebar navigation

### Requirement 14: Migration and Compatibility

**User Story:** As a developer with existing infrastructure, I want documentation on migrating to TypeKro, so that I can adopt it incrementally.

#### Acceptance Criteria

1. THE Documentation SHALL provide migration guides from: raw YAML, Helm, CDK8s, Pulumi
2. WHEN showing migration, THE Documentation SHALL demonstrate the `yamlFile()` pattern for gradual adoption
3. THE Documentation SHALL document compatibility with existing Kubernetes tooling (kubectl, ArgoCD, Flux)
4. THE Documentation SHALL explain how to export TypeKro compositions as static YAML for review
5. WHEN discussing compatibility, THE Documentation SHALL be clear about Kro controller requirements for runtime features

### Requirement 15: Alchemy Integration Documentation

**User Story:** As a developer building multi-cloud infrastructure, I want documentation on integrating TypeKro with Alchemy, so that I can manage cloud resources and Kubernetes resources together in TypeScript.

#### Acceptance Criteria

1. THE Documentation SHALL explain what Alchemy is and why TypeKro integrates with it
2. WHEN showing integration, THE Documentation SHALL demonstrate creating cloud resources (S3, Lambda) alongside Kubernetes resources
3. THE Documentation SHALL document the `alchemyScope` option for factory deployment
4. THE Documentation SHALL show how to reference Alchemy resource outputs (bucket names, function URLs) in Kubernetes deployments
5. WHEN showing patterns, THE Documentation SHALL demonstrate the "cloud-first" pattern (cloud resources → K8s workloads) and "K8s-first" pattern (K8s workloads → cloud services)
6. THE Documentation SHALL explain the unified TypeScript experience across cloud and Kubernetes

### Requirement 16: ArkType Schema Documentation

**User Story:** As a developer defining custom resources, I want documentation on writing ArkType schemas, so that I can create type-safe spec and status definitions.

#### Acceptance Criteria

1. THE Documentation SHALL explain ArkType basics: primitive types, objects, arrays, unions
2. WHEN showing schemas, THE Documentation SHALL demonstrate common patterns: optional fields, enums, nested objects
3. THE Documentation SHALL explain how ArkType schemas become OpenAPI schemas in ResourceGraphDefinitions
4. THE Documentation SHALL document schema validation and error messages
5. WHEN showing examples, THE Documentation SHALL demonstrate real-world spec schemas (web app, database, etc.)

### Requirement 17: Resource IDs and Cross-References

**User Story:** As a developer building multi-resource compositions, I want clear documentation on resource IDs, so that I can properly reference resources across the composition.

#### Acceptance Criteria

1. THE Documentation SHALL explain the `id` parameter and why it's required for cross-resource references
2. WHEN showing cross-references, THE Documentation SHALL demonstrate how resource IDs map to CEL expression paths
3. THE Documentation SHALL explain naming conventions and best practices for resource IDs
4. THE Documentation SHALL document what happens when IDs are missing or duplicated
5. WHEN showing examples, THE Documentation SHALL demonstrate multi-resource compositions with proper ID usage

### Requirement 18: Troubleshooting and Debugging

**User Story:** As a developer debugging TypeKro issues, I want troubleshooting documentation, so that I can resolve problems quickly.

#### Acceptance Criteria

1. THE Documentation SHALL provide common error messages and their solutions
2. WHEN debugging, THE Documentation SHALL explain how to use `toYaml()` to inspect generated CEL expressions
3. THE Documentation SHALL document the `enableCompositionDebugging()` function for tracing
4. THE Documentation SHALL explain common pitfalls: resources created outside composition context, unsupported JavaScript patterns
5. WHEN showing debugging, THE Documentation SHALL demonstrate how to validate CEL expressions before deployment
