# Requirements Document

## Introduction

This spec focuses on transforming TypeKro's documentation from comprehensive but confusing to cohesive, compelling, and simple while maintaining technical depth for advanced users. The goal is to create a clear user journey that guides users effectively through TypeKro's unique capabilities, eliminates API confusion, and showcases the magic proxy system and external references as key differentiators.

**Current Status**: Documentation is comprehensive with good VitePress infrastructure, but suffers from API confusion, inconsistent import patterns, example bloat, and fragmented user journey. Users get lost between imperative (`kubernetesComposition`) vs declarative (`toResourceGraph`) APIs and cannot easily find their path to success.

## Requirements

### Requirement 1: API Consistency and Standardization

**User Story:** As a TypeKro user following documentation, I want consistent API patterns throughout so that I can learn effectively without confusion between different approaches.

#### Acceptance Criteria

1. WHEN reading primary documentation THEN it SHALL use `kubernetesComposition` everywhere except dedicated declarative API page
2. WHEN viewing import examples THEN they SHALL consistently use `from 'typekro/simple'` pattern for factory functions
3. WHEN following guides THEN all examples SHALL use identical import patterns: `import { kubernetesComposition, Cel } from 'typekro'`
4. WHEN reviewing API documentation THEN `toResourceGraph` SHALL only appear in dedicated `/api/to-resource-graph.md` page
5. WHEN reading README and guides THEN the primary API SHALL be clearly `kubernetesComposition` 
6. WHEN following examples THEN all code SHALL compile and work with current TypeKro implementation

**Priority**: ⭐⭐⭐ CRITICAL - API confusion prevents effective learning

### Requirement 2: Essential Example Set Creation

**User Story:** As a developer learning TypeKro, I want a focused set of high-impact examples that teach core concepts progressively without overwhelming me with redundant content.

#### Acceptance Criteria

1. WHEN reviewing examples THEN there SHALL be 5-6 essential examples maximum
2. WHEN following example progression THEN it SHALL teach: basic factories → CRDs → Helm charts via `helmRelease()` → YAML via `yamlFile()` and `yamlDirectory()` → cross-references → external references
3. WHEN studying external references THEN examples SHALL demonstrate `externalRef()` function usage between different resource compositions
4. WHEN learning Helm integration THEN examples SHALL show `helmRelease()` factory with schema references in Helm values
5. WHEN learning YAML integration THEN examples SHALL demonstrate `yamlFile()` and `yamlDirectory()` deployment closures
6. WHEN testing examples THEN all code SHALL be verified against current codebase
7. WHEN exploring examples THEN each SHALL have clear learning objectives and build on previous concepts  
8. WHEN using examples THEN they SHALL be realistic but minimal complexity

**Priority**: ⭐⭐⭐ CRITICAL - Example bloat confuses users and dilutes key concepts

### Requirement 3: Streamlined User Journey

**User Story:** As a new TypeKro user, I want a clear primary learning path that takes me from installation through core concepts to advanced architecture without getting lost.

#### Acceptance Criteria

1. WHEN starting with TypeKro THEN the primary path SHALL be: Installation → Bootstrap → First App → Factories → Magic Proxy → External References → Advanced Architecture
2. WHEN learning core concepts THEN magic proxy system SHALL be prominently featured with CEL template and expression capabilities
3. WHEN progressing through content THEN each step SHALL build logically on previous concepts
4. WHEN exploring advanced topics THEN architecture section SHALL explain: schema proxy system, CEL integration, deployment strategies, extensibility
5. WHEN completing the journey THEN users SHALL understand TypeKro's unique value proposition
6. WHEN choosing paths THEN decision guides SHALL quickly route users to appropriate content

**Priority**: ⭐⭐⭐ CRITICAL - Fragmented journey causes user abandonment

### Requirement 4: Magic Proxy System and External References Highlighting

**User Story:** As a developer evaluating TypeKro, I want to understand the magic proxy system and external reference capabilities so that I can appreciate TypeKro's unique advantages over alternatives.

#### Acceptance Criteria

1. WHEN learning about magic proxy THEN it SHALL be prominently featured with progression: static values → schema references → resource references → external references
2. WHEN studying external references THEN examples SHALL show `externalRef()` function for cross-composition dependencies
3. WHEN reading architecture documentation THEN it SHALL explain schema proxy design, CEL integration, and cross-composition orchestration
4. WHEN comparing with alternatives THEN magic proxy and external references SHALL be highlighted as key differentiators
5. WHEN following examples THEN external reference patterns SHALL demonstrate seamless cross-graph dependencies using `externalRef()`
6. WHEN understanding deployment modes THEN both direct and KRO strategies SHALL be clearly explained

**Priority**: ⭐⭐⭐ CRITICAL - Magic proxy and external references are TypeKro's key differentiators

### Requirement 5: Architecture and Extensibility Documentation

**User Story:** As an advanced developer or contributor, I want comprehensive architecture documentation so that I can understand TypeKro's internal design, extend it effectively, and contribute meaningfully.

#### Acceptance Criteria

1. WHEN studying architecture THEN documentation SHALL cover: schema proxy system, CEL integration, deployment strategies, external reference resolution
2. WHEN learning extensibility THEN guides SHALL explain: adding factories using `createResource()`, Enhanced type system, composition context
3. WHEN understanding design decisions THEN philosophy of enhancing Kubernetes types via proxy system SHALL be documented
4. WHEN contributing THEN clear patterns for maintaining API compatibility SHALL be provided
5. WHEN building custom factories THEN step-by-step guides with working examples SHALL be available using actual factory patterns
6. WHEN debugging issues THEN architecture knowledge SHALL enable effective troubleshooting

**Priority**: ⭐⭐ HIGH - Advanced users and contributors need deep architectural understanding

### Requirement 6: Content Quality and Deployment Best Practices

**User Story:** As a TypeKro user implementing solutions, I want accurate, up-to-date content with clear deployment guidance aligned with current best practices.

#### Acceptance Criteria

1. WHEN following examples THEN all code SHALL be tested against current implementation
2. WHEN choosing deployment strategies THEN guidance SHALL align with DirectDeploymentStrategy and KroDeploymentStrategy implementations
3. WHEN reading deployment guides THEN clear use cases for Direct/KRO modes SHALL be provided
4. WHEN troubleshooting THEN common real-world issues and solutions SHALL be documented
5. WHEN updating TypeKro THEN documentation SHALL remain synchronized with library changes
6. WHEN implementing patterns THEN security and performance considerations SHALL be included

**Priority**: ⭐⭐ HIGH - Accurate, practical guidance essential for successful implementation

## Business Value

### Primary Benefits

1. **Reduced Learning Curve**: Clear API consistency and streamlined journey accelerate user onboarding
2. **Increased Adoption**: Magic proxy differentiation and external reference capabilities attract users from alternatives  
3. **Community Growth**: Focused examples and clear architecture documentation enable contributions
4. **Support Reduction**: Comprehensive troubleshooting and clear patterns reduce support requests

### Success Metrics

1. **API Consistency**: 100% of primary docs use `kubernetesComposition` with consistent imports
2. **Example Focus**: Reduced to 5-6 essential examples with clear learning progression
3. **User Journey**: Linear path from installation to advanced architecture with clear decision points
4. **Architecture Coverage**: Complete documentation of magic proxy, CEL integration, deployment strategies, external references

### Risk Mitigation

1. **User Confusion**: Eliminates API inconsistency that causes user abandonment
2. **Feature Obscurity**: Prominently features magic proxy and external references as differentiators
3. **Contributor Barriers**: Comprehensive architecture documentation enables community growth
4. **Support Overhead**: Clear guidance and troubleshooting reduces repetitive support requests

## Technical Constraints

### API Standardization Constraints

1. Primary API must be `kubernetesComposition` throughout documentation
2. Import patterns must consistently use `from 'typekro/simple'` for factory functions
3. `toResourceGraph` limited to dedicated API reference page only
4. All examples must use current implementation and compile successfully

### Example Set Constraints

1. Maximum 5-6 essential examples to maintain focus
2. External reference example must demonstrate `externalRef()` function usage
3. Examples must progress logically: basic → advanced → external references
4. All examples must be realistic but minimal complexity

### Content Organization Constraints

1. Primary user journey must be linear and unambiguous
2. Advanced architecture must be separate from basic learning path
3. Magic proxy must be prominently featured throughout relevant content
4. Decision guides must quickly route users without overwhelming choices

## Dependencies

### Internal Dependencies

1. **TypeKro Codebase**: Stable `kubernetesComposition` API for documentation consistency
2. **External Reference Implementation**: Working `externalRef()` function for cross-composition examples
3. **Example Verification**: Test infrastructure to validate all examples against current code
4. **Architecture Stability**: Consistent internal architecture for comprehensive documentation

### External Dependencies

1. **VitePress Framework**: Continued support for documentation platform
2. **Documentation Hosting**: Reliable hosting for updated documentation site
3. **CI/CD Integration**: Automated validation of examples and content consistency
4. **Community Feedback**: User input to validate improved documentation effectiveness

### Timeline Dependencies

1. Example consolidation must occur before API standardization changes
2. API consistency changes depend on essential example set definition
3. Architecture documentation depends on stable internal APIs
4. User journey implementation depends on completed example set and API consistency