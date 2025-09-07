# Requirements Document

## Introduction

This specification addresses the fundamental issue with JavaScript template literal conversion to CEL expressions in TypeKro's magic proxy system. Currently, template literals containing KubernetesRef objects are being resolved to static strings with "undefined" values instead of being properly converted to CEL string concatenation expressions.

## Requirements

### Requirement 1

**User Story:** As a TypeKro developer, I want to use JavaScript template literals with schema and resource references in status expressions, so that I can write natural JavaScript code that gets converted to proper CEL expressions.

#### Acceptance Criteria

1. WHEN I write a template literal like `` `https://${spec.hostname}/api` `` in a status expression THEN the system SHALL convert it to a CEL expression like `${"https://" + schema.spec.hostname + "/api"}`
2. WHEN I write a template literal like `` `Deployment ${deployment.metadata.name} has ${deployment.status.readyReplicas} replicas` `` THEN the system SHALL convert it to `${"Deployment " + deployment.metadata.name + " has " + deployment.status.readyReplicas + " replicas"}`
3. WHEN template literals contain only schema references THEN they SHALL be converted to CEL expressions that reference the schema
4. WHEN template literals contain resource references THEN they SHALL be converted to CEL expressions that reference the resources
5. WHEN template literals contain mixed schema and resource references THEN they SHALL be converted to CEL expressions with proper concatenation

### Requirement 2

**User Story:** As a TypeKro developer, I want KubernetesRef objects to behave correctly in JavaScript template literals, so that they don't resolve to "undefined" during composition execution.

#### Acceptance Criteria

1. WHEN a KubernetesRef object is used in a template literal THEN it SHALL preserve its reference nature instead of resolving to undefined
2. WHEN the imperative analyzer processes template literals THEN it SHALL detect KubernetesRef objects within the template expressions
3. WHEN template literals are serialized THEN they SHALL appear as proper CEL expressions in the ResourceGraphDefinition YAML
4. WHEN template literals contain only schema references THEN they SHALL be classified as dynamic fields requiring Kro resolution
5. WHEN the magic proxy system is in status builder context THEN template literals SHALL preserve KubernetesRef objects for analysis

### Requirement 3

**User Story:** As a TypeKro developer, I want consistent behavior between different types of JavaScript expressions, so that template literals work the same way as other expressions containing references.

#### Acceptance Criteria

1. WHEN I use `deployment.status.readyReplicas > 0` THEN it SHALL be converted to a CEL expression
2. WHEN I use `` `Ready: ${deployment.status.readyReplicas > 0}` `` THEN it SHALL also be converted to a CEL expression with the same reference handling
3. WHEN expressions contain the same references THEN they SHALL be classified consistently as static or dynamic
4. WHEN the serialization system processes expressions THEN template literals SHALL follow the same rules as other JavaScript expressions
5. WHEN the validation system checks expressions THEN template literals SHALL be subject to the same reference validation as other expressions