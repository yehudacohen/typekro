# Requirements Document

## Introduction

This feature refactors the simple* factory functions (like `simpleDeployment`, `simpleService`, etc.) into a dedicated `simple` namespace to provide cleaner, more intuitive naming. Instead of calling `simpleDeployment()`, developers will be able to call `simple.Deployment()` or import from a dedicated simple namespace to use `Deployment()` directly.

## Requirements

### Requirement 1

**User Story:** As a TypeKro developer, I want to use cleaner factory function names like `Deployment()` instead of `simpleDeployment()`, so that my code is more readable and follows common naming conventions.

#### Acceptance Criteria

1. WHEN I import from the simple namespace THEN I SHALL be able to use `Deployment()` instead of `simpleDeployment()`
2. WHEN I import the simple namespace THEN I SHALL be able to use `simple.Deployment()` syntax
3. WHEN I use the new naming THEN the functionality SHALL remain identical to the current simple* functions

### Requirement 2

**User Story:** As a TypeKro developer, I want all simple factory functions to be available in the new namespace, so that I have a consistent API for all simple resource creation.

#### Acceptance Criteria

1. WHEN I access the simple namespace THEN I SHALL find all current simple* functions with their "simple" prefix removed
2. WHEN I use `simple.ConfigMap()` THEN it SHALL behave identically to `simpleConfigMap()`
3. WHEN I use `simple.Service()` THEN it SHALL behave identically to `simpleService()`
4. WHEN I use `simple.Deployment()` THEN it SHALL behave identically to `simpleDeployment()`
5. WHEN I use `simple.Job()` THEN it SHALL behave identically to `simpleJob()`
6. WHEN I use `simple.CronJob()` THEN it SHALL behave identically to `simpleCronJob()`
7. WHEN I use `simple.StatefulSet()` THEN it SHALL behave identically to `simpleStatefulSet()`
8. WHEN I use `simple.Secret()` THEN it SHALL behave identically to `simpleSecret()`
9. WHEN I use `simple.Pvc()` THEN it SHALL behave identically to `simplePvc()`
10. WHEN I use `simple.Hpa()` THEN it SHALL behave identically to `simpleHpa()`
11. WHEN I use `simple.Ingress()` THEN it SHALL behave identically to `simpleIngress()`
12. WHEN I use `simple.NetworkPolicy()` THEN it SHALL behave identically to `simpleNetworkPolicy()`

### Requirement 3

**User Story:** As a TypeKro developer, I want the new simple namespace to be available through multiple import patterns, so that I can choose the style that best fits my coding preferences.

#### Acceptance Criteria

1. WHEN I import `{ simple }` from 'typekro' THEN I SHALL be able to use `simple.Deployment()`
2. WHEN I import from 'typekro/simple' THEN I SHALL be able to use `Deployment()` directly
3. WHEN I import `{ Deployment }` from 'typekro/simple' THEN I SHALL be able to use `Deployment()` directly
4. WHEN I use any import pattern THEN the TypeScript types SHALL be correctly inferred
5. WHEN I use any import pattern THEN I SHALL get proper IDE autocomplete and type checking

### Requirement 4

**User Story:** As a TypeKro maintainer, I want all existing examples, tests, and documentation to be updated to use the new naming convention, so that developers see consistent usage patterns.

#### Acceptance Criteria

1. WHEN I look at examples in the examples/ directory THEN they SHALL use the new simple namespace syntax
2. WHEN I look at documentation in docs/ THEN it SHALL demonstrate the new simple namespace syntax
3. WHEN I run the test suite THEN all tests SHALL use the new simple namespace syntax
4. WHEN I look at README.md THEN it SHALL show the new simple namespace syntax in code examples
5. WHEN I look at API documentation THEN it SHALL document the new simple namespace with clear usage examples

### Requirement 5

**User Story:** As a TypeKro developer, I want the internal code structure to be clean and maintainable, so that future development is not hindered by the refactoring.

#### Acceptance Criteria

1. WHEN I examine the source code THEN the simple functions SHALL be organized in a dedicated directory structure
2. WHEN I look at exports THEN they SHALL be clearly organized between the new namespace and backward compatibility exports
3. WHEN I examine the codebase THEN there SHALL be no code duplication in the simple factory implementations
4. WHEN I look at the build output THEN the bundle size SHALL not increase significantly due to the refactoring
5. WHEN I examine TypeScript types THEN they SHALL be properly exported for the new naming conventions