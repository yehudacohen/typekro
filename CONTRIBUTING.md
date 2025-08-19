# Contributing to TypeKro

Welcome to TypeKro! We're excited to have you contribute to making Kubernetes infrastructure-as-TypeScript better for everyone.

## Table of Contents

- [Getting Started](#getting-started)
- [Code Structure](#code-structure)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Adding New Factory Functions](#adding-new-factory-functions)
- [Testing Guidelines](#testing-guidelines)
- [Submitting Pull Requests](#submitting-pull-requests)
- [Release Process](#release-process)

## Getting Started

### Prerequisites

- **Bun** >= 1.0.0 (we use Bun instead of npm/yarn)
- **Node.js** >= 18
- **TypeScript** knowledge
- Basic understanding of Kubernetes resources

### Setup

```bash
# 1. Fork and clone the repository
git clone https://github.com/your-username/typekro.git
cd typekro

# 2. Install dependencies
bun install

# 3. Build the library
bun run build

# 4. Run tests to ensure everything works
bun run test

# 5. Run quality checks
bun run quality
```

### Available Scripts

```bash
# Development
bun run build          # Build the library
bun run dev            # Watch mode for development

# Testing
bun run test           # Run unit tests
bun run test:integration    # Run integration tests (requires cluster)
bun run test:watch     # Run tests in watch mode

# Quality Assurance
bun run typecheck      # TypeScript type checking
bun run lint           # Lint code
bun run format         # Format code with Biome
bun run quality        # Run all quality checks

# Examples
bun run build:examples # Build example files
bun run examples       # Run example demonstrations
```

## Code Structure

TypeKro follows a modular architecture designed for maintainability and extensibility:

```
src/
├── core/                     # Core TypeKro functionality
│   ├── composition/         # Resource graph composition
│   ├── deployment/          # Factory and deployment engines
│   ├── evaluation/          # CEL expression evaluation
│   ├── kubernetes/          # Kubernetes API integration
│   ├── logging/             # Structured logging
│   ├── references/          # Reference resolution and CEL
│   ├── serialization/       # YAML serialization
│   ├── types/               # Core type definitions
│   └── validation/          # Schema validation
├── factories/               # Resource factory functions
│   ├── kubernetes/          # Kubernetes resource factories
│   │   ├── core/           # Core resources (Pod, Service, etc.)
│   │   ├── workloads/      # Workload resources (Deployment, Job, etc.)
│   │   ├── networking/     # Networking resources (Ingress, NetworkPolicy, etc.)
│   │   ├── config/         # Configuration resources (ConfigMap, Secret, etc.)
│   │   ├── rbac/           # RBAC resources (Role, ServiceAccount, etc.)
│   │   └── yaml/           # External YAML integration
│   ├── helm/               # Helm resource factories
│   ├── flux/               # Flux CD resource factories
│   └── kro/                # KRO-specific resources
├── alchemy/                # Alchemy integration
├── compositions/           # Pre-built compositions
└── utils/                  # Utility functions
```

### Key Architectural Principles

- **Factory Pattern**: Each resource type has a factory function that returns an Enhanced proxy
- **Magic Proxy System**: Schema references become CEL expressions at runtime via proxies
- **RefOrValue<T>**: All parameters accept static values or dynamic references
- **No Circular Dependencies**: Strict dependency graph validation prevents circular references
- **Type Safety**: Full TypeScript coverage with no `any` types allowed

## Development Workflow

### 1. Before You Start

- Check existing [issues](https://github.com/yehudacohen/typekro/issues) and [discussions](https://github.com/yehudacohen/typekro/discussions)
- For large features, open an issue to discuss the approach first
- Follow existing code patterns and TypeScript conventions
- Read the [architectural principles](#key-architectural-principles)

### 2. Creating Your Feature Branch

```bash
# Create a feature branch from master
git checkout -b feature/your-feature-name

# For bug fixes
git checkout -b fix/issue-description

# For documentation
git checkout -b docs/update-description
```

### 3. Making Changes

```bash
# Make your changes
# ... code changes ...

# Add tests for new functionality
# ... test changes ...

# Run quality checks frequently
bun run quality

# Run relevant tests
bun run test
```

### 4. Commit Guidelines

We follow conventional commits for clear changelog generation:

```bash
# Feature additions
git commit -m "feat: add support for CronJob resources"

# Bug fixes
git commit -m "fix: resolve CEL expression serialization edge case"

# Documentation
git commit -m "docs: update factory function examples"

# Breaking changes
git commit -m "feat!: change factory function signature for consistency"

# Other types: chore, refactor, style, test, perf
```

### 5. Pull Request Process

```bash
# Push your branch
git push origin feature/your-feature-name

# Create pull request through GitHub UI
# Fill out the PR template with:
# - Clear description of changes
# - Link to related issues
# - Testing information
# - Breaking changes (if any)
```

## Code Standards

### TypeScript Standards

- **Strict Mode**: All TypeScript must pass strict type checking
- **No `any` Types**: Use proper typing or `unknown` with type guards
- **Explicit Return Types**: For public APIs and complex functions
- **JSDoc Comments**: For all public functions and interfaces

```typescript
/**
 * Creates a Kubernetes Deployment resource with TypeKro enhancements
 * 
 * @param config - Configuration for the Deployment
 * @returns Enhanced Deployment resource with proxy capabilities
 * 
 * @example
 * ```typescript
 * const deployment = simpleDeployment({
 *   name: 'my-app',
 *   image: 'nginx:latest',
 *   replicas: 3
 * });
 * ```
 */
export function simpleDeployment(
  config: DeploymentConfig
): Enhanced<DeploymentSpec, DeploymentStatus> {
  // Implementation
}
```

### Code Formatting

We use **Biome** for consistent code formatting:

```bash
# Format code
bun run format

# Check formatting
bun run lint
```

Configuration is in `biome.json` - the formatter runs automatically on commit.

### Import Organization

Organize imports in this order:

```typescript
// 1. External libraries
import { type } from 'arktype';
import * as yaml from 'js-yaml';

// 2. Internal modules (absolute paths)
import { createResource } from '../shared.js';
import type { Enhanced } from '../../core/types/index.js';

// 3. Type-only imports (at the end)
import type { KubernetesResource } from '../../core/types/kubernetes.js';
```

## Adding New Factory Functions

### 1. Choose the Right Location

Place new factory functions in the appropriate category:

- `src/factories/kubernetes/workloads/` - Deployments, Jobs, etc.
- `src/factories/kubernetes/networking/` - Services, Ingress, etc.
- `src/factories/kubernetes/config/` - ConfigMaps, Secrets, etc.
- `src/factories/kubernetes/rbac/` - Roles, ServiceAccounts, etc.

### 2. Factory Function Template

```typescript
import { createResource } from '../shared.js';
import type { Enhanced } from '../../core/types/index.js';

// Define configuration interface
export interface MyResourceConfig {
  name: string;
  namespace?: string;
  // ... other config options
  id?: string; // Always include optional id
}

// Define spec and status types
export interface MyResourceSpec {
  // Kubernetes spec fields
}

export interface MyResourceStatus {
  // Kubernetes status fields
}

/**
 * Creates a MyResource with TypeKro enhancements
 */
export function myResource(
  config: MyResourceConfig
): Enhanced<MyResourceSpec, MyResourceStatus> {
  return createResource(
    {
      apiVersion: 'v1', // or appropriate API version
      kind: 'MyResource',
      metadata: {
        name: config.name,
        namespace: config.namespace,
      },
      spec: {
        // Map config to Kubernetes spec
      },
    },
    config.id,
    myResourceReadinessEvaluator // Add readiness evaluator
  );
}
```

### 3. Add Readiness Evaluator

Every factory function should include a readiness evaluator:

```typescript
import type { ReadinessEvaluator } from '../../core/types/deployment.js';

export const myResourceReadinessEvaluator: ReadinessEvaluator = {
  evaluate: (resource) => {
    // Implement readiness logic
    if (!resource.status) {
      return { ready: false, reason: 'Status not available' };
    }
    
    // Check resource-specific readiness conditions
    return { ready: true };
  }
};
```

### 4. Export from Index

Add your factory to the appropriate index file:

```typescript
// src/factories/kubernetes/workloads/index.ts
export * from './my-resource.js';
```

### 5. Add Tests

Create comprehensive tests for your factory:

```typescript
// test/factories/my-resource.test.ts
import { describe, expect, it } from 'bun:test';
import { myResource } from '../../src/factories/kubernetes/workloads/my-resource.js';

describe('MyResource Factory', () => {
  it('should create MyResource with correct structure', () => {
    const resource = myResource({
      name: 'test-resource',
      // ... config
    });

    expect(resource.apiVersion).toBe('v1');
    expect(resource.kind).toBe('MyResource');
    expect(resource.metadata.name).toBe('test-resource');
  });

  it('should have readiness evaluator', () => {
    const resource = myResource({ name: 'test' });
    expect(resource.readinessEvaluator).toBeDefined();
  });
});
```

## Testing Guidelines

### Unit Tests

- **Location**: `test/unit/` or alongside source files
- **Purpose**: Test individual functions and components
- **Requirements**: Fast, isolated, no external dependencies

```typescript
// Example unit test
import { describe, expect, it } from 'bun:test';
import { simpleDeployment } from '../src/factories/kubernetes/workloads/deployment.js';

describe('simpleDeployment', () => {
  it('should create deployment with correct defaults', () => {
    const deployment = simpleDeployment({
      name: 'test-app',
      image: 'nginx:latest'
    });

    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.template.spec.containers[0].image).toBe('nginx:latest');
  });
});
```

### Integration Tests

- **Location**: `test/integration/`
- **Purpose**: Test end-to-end workflows
- **Requirements**: May require Kubernetes cluster

```typescript
// Example integration test
import { describe, expect, it } from 'bun:test';
import { toResourceGraph, simpleDeployment } from '../src/index.js';

describe('End-to-End Deployment', () => {
  it('should deploy resources to cluster', async () => {
    const graph = toResourceGraph(/* ... */);
    const factory = await graph.factory('direct', { namespace: 'test' });
    
    const instance = await factory.deploy({ /* spec */ });
    expect(instance).toBeDefined();
  });
});
```

### Test Organization

```
test/
├── unit/                    # Unit tests
│   ├── deployment-*.test.ts
│   ├── serialization-*.test.ts
│   └── readiness-*.test.ts
├── integration/             # Integration tests
│   ├── e2e-*.test.ts
│   └── alchemy/
├── core/                    # Core functionality tests
│   ├── cel-*.test.ts
│   └── proxy-*.test.ts
└── factories/               # Factory function tests
    ├── kubernetes/
    └── helm/
```

## Submitting Pull Requests

### PR Checklist

Before submitting, ensure:

- [ ] All tests pass (`bun run test`)
- [ ] Code is properly formatted (`bun run format`)
- [ ] TypeScript compiles without errors (`bun run typecheck`)
- [ ] New features have tests
- [ ] Documentation is updated
- [ ] Commit messages follow conventional format
- [ ] PR description explains the change and motivation

### PR Template

When creating a PR, use this template:

```markdown
## Description
Brief description of changes and motivation.

## Type of Change
- [ ] Bug fix (non-breaking change)
- [ ] New feature (non-breaking change)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] All tests pass

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No breaking changes (or clearly marked)

## Related Issues
Closes #123
```

### Review Process

1. **Automated Checks**: CI runs tests and quality checks
2. **Code Review**: Maintainers review code quality and design
3. **Testing**: Changes are tested in various environments
4. **Approval**: At least one maintainer approval required
5. **Merge**: Squash and merge to maintain clean history

## Release Process

TypeKro follows semantic versioning:

- **Patch** (1.0.1): Bug fixes, documentation updates
- **Minor** (1.1.0): New features, backward compatible
- **Major** (2.0.0): Breaking changes

### Release Steps

1. Update version in `package.json`
2. Update `CHANGELOG.md` with release notes
3. Create release tag: `git tag v1.2.3`
4. Push tag: `git push origin v1.2.3`
5. GitHub Actions handles NPM publishing

## Getting Help

- **Questions**: Open a [Discussion](https://github.com/yehudacohen/typekro/discussions)
- **Bugs**: Open an [Issue](https://github.com/yehudacohen/typekro/issues)
- **Features**: Discuss in [Discussions](https://github.com/yehudacohen/typekro/discussions) first

## Recognition

Contributors are recognized in:
- `README.md` contributors section
- Release notes
- `package.json` contributors field

Thank you for contributing to TypeKro! 🚀