# TypeKro Codebase Structure

## Overview

This document describes the current structure of the TypeKro codebase after the major refactoring completed in the codebase-cleanup-restructure spec. Understanding this structure is essential for implementing new features and maintaining the codebase.

## Directory Structure

### Core Architecture (`src/core/`)

The core directory contains the fundamental TypeKro functionality organized by domain:

```
src/core/
├── composition/          # Simple resource builders (simpleDeployment, etc.)
├── dependencies/         # Dependency resolution and graph management
├── deployment/          # Direct deployment engine and readiness checking
├── references/          # Cross-resource references, CEL, and schema proxy
├── serialization/       # YAML generation and Kro schema creation
├── types/              # Domain-specific type definitions
└── errors.ts           # Core error classes
```

#### Key Modules:

- **`composition/`**: High-level composition functions that provide simple APIs for creating common resource patterns
- **`dependencies/`**: `DependencyResolver` and `DependencyGraph` for managing resource dependencies
- **`deployment/`**: `DirectDeploymentEngine` for deploying resources directly to Kubernetes without Kro controller
- **`references/`**: Reference resolution system including `ReferenceResolver`, CEL evaluation, and schema proxy
- **`serialization/`**: YAML generation and validation for Kro ResourceGraphDefinitions
- **`types/`**: Organized type definitions by domain (kubernetes, references, deployment, etc.)

### Factory Functions (`src/factories/`)

Factory functions are organized by ecosystem and resource type:

```
src/factories/
├── shared.ts                    # Shared utilities (createResource, processPodSpec)
├── index.ts                     # Main factory exports
└── kubernetes/                  # Kubernetes ecosystem
    ├── types.ts                 # Kubernetes type definitions
    ├── index.ts                 # Kubernetes factory exports
    ├── workloads/              # Deployment, Job, StatefulSet, etc.
    ├── networking/             # Service, Ingress, NetworkPolicy, etc.
    ├── storage/                # PVC, PV, StorageClass, etc.
    ├── config/                 # ConfigMap, Secret
    ├── rbac/                   # Role, RoleBinding, ServiceAccount, etc.
    ├── policy/                 # PodDisruptionBudget, ResourceQuota, etc.
    ├── core/                   # Pod, Namespace, Node, etc.
    ├── autoscaling/            # HorizontalPodAutoscaler
    ├── certificates/           # CertificateSigningRequest
    ├── coordination/           # Lease
    ├── admission/              # Webhook configurations
    ├── extensions/             # CustomResourceDefinition, customResource
    └── scheduling/             # PriorityClass, RuntimeClass
```

#### Factory Organization Principles:

- **Single Responsibility**: Each file contains factories for a specific resource type
- **Consistent Patterns**: All factories follow the same pattern using `createResource` from `shared.ts`
- **Type Safety**: Full TypeScript support with proper Enhanced<> types
- **Backward Compatibility**: Old imports continue to work through re-exports

### Utilities (`src/utils/`)

Common utilities and helper functions:

```
src/utils/
├── index.ts           # Main utility exports
├── helpers.ts         # General helper functions
└── type-guards.ts     # Type guard functions
```

### Alchemy Integration (`src/alchemy/`)

Integration with the Alchemy resource management system:

```
src/alchemy/
├── index.ts           # Alchemy exports
├── integration.ts     # Core alchemy integration logic
└── kubernetes-api.ts  # Kubernetes API utilities for alchemy
```

## API Evolution and Current State

### Primary API: `toResourceGraph`

The primary API for creating typed resource graphs is `toResourceGraph`, which uses the builder function pattern with ArkType schema integration:

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment } from '@yehudacohen/typekro';

const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
});

const WebAppStatusSchema = type({
  url: 'string',
  ready: 'boolean',
});

const graph = toResourceGraph(
  'webapp-stack',
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
    }),
  }),
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  }
);

// Create factories for different deployment strategies
const directFactory = await graph.factory('direct', { namespace: 'production' });
const kroFactory = await graph.factory('kro', { namespace: 'production' });
```

### Legacy API Removal

The `toKroResourceGraph` function has been **completely removed** from the codebase. All examples and tests now use:
- `toResourceGraph` for the new factory pattern API
- `serializeResourceGraphToYaml` for direct YAML generation from static resources

### Factory Pattern Implementation

The factory pattern provides two deployment strategies:

1. **DirectResourceFactory**: TypeKro resolves dependencies and deploys individual Kubernetes manifests
2. **KroResourceFactory**: Deploys ResourceGraphDefinitions and lets Kro controller handle instances

Both factories implement the same `ResourceFactory<TSpec, TStatus>` interface for consistency.

## Key Architectural Decisions

### 1. Eliminated Circular Dependencies

- **Problem**: Circular dependency between `kubernetes.ts` → `references.ts` → `deployment.ts`
- **Solution**: Moved `ResolutionContext` from `references.ts` to `deployment.ts`
- **Result**: Clean dependency graph with no circular references

### 2. Centralized Type Definitions

- **Core Types**: Located in `src/core/types/` organized by domain
- **Factory Types**: Re-export from core types to maintain compatibility
- **Consistent Imports**: All type imports follow consistent patterns

### 3. Organized Factory Structure

- **Ecosystem-Based**: Organized by target platform (kubernetes, future: helm, crossplane)
- **Resource-Type Grouping**: Related resources grouped together (workloads, networking, etc.)
- **Shared Utilities**: Common functionality in `shared.ts` to avoid duplication

### 4. Import Pattern Standards

- **External Libraries First**: `@kubernetes/client-node`, `js-yaml`, etc.
- **Internal Modules Second**: Relative imports to other modules
- **Types Last**: `import type` statements grouped separately
- **No Circular Dependencies**: Enforced through tooling and structure

## Development Guidelines

### Adding New Factory Functions

1. **Determine Category**: Place in appropriate `src/factories/kubernetes/[category]/`
2. **Follow Pattern**: Use `createResource` from `shared.ts`
3. **Export Properly**: Add to category `index.ts` and main `kubernetes/index.ts`
4. **Type Definitions**: Add types to `kubernetes/types.ts` if needed

### Adding New Core Functionality

1. **Choose Domain**: Place in appropriate `src/core/[domain]/`
2. **Type Definitions**: Add types to `src/core/types/[domain].ts`
3. **Export Structure**: Update domain `index.ts` and main `core/index.ts`
4. **Avoid Circular Dependencies**: Check with `bunx madge --circular --extensions ts src/`

### Import Guidelines

1. **Use Consistent Patterns**: Follow the established import organization
2. **Type-Only Imports**: Use `import type` for type-only imports
3. **Relative Paths**: Use relative paths for internal modules
4. **Index Files**: Import from index files when available

## Testing Structure

Tests are organized to mirror the source structure:

```
test/
├── core/              # Tests for core functionality
├── factory/           # Tests for factory functions
└── integration/       # End-to-end integration tests
```

## Build and Development

- **Package Manager**: Use `bun` for all operations
- **Type Checking**: `bun run typecheck` validates all TypeScript
- **Testing**: `bun run test` runs the full test suite
- **Linting**: `bun run lint` checks code quality
- **Import Organization**: `./scripts/organize-imports.sh` organizes imports

## Migration Notes

### From Old Structure

- **Factory Imports**: Old imports like `import { deployment } from './core/factory'` still work
- **Type Imports**: Types are now centralized but re-exported for compatibility
- **Core Functionality**: All core functions available through `src/core.ts` and `src/index.ts`

### Breaking Changes

- **None**: The refactoring maintained full backward compatibility
- **Internal Structure**: Only internal organization changed, public API unchanged

## Future Considerations

### Planned Expansions

- **Additional Ecosystems**: `src/factories/helm/`, `src/factories/crossplane/`
- **Enhanced Composition**: More sophisticated composition functions
- **Performance Optimizations**: Bundle size and runtime performance improvements

### Maintenance

- **Regular Dependency Checks**: Use `bunx madge --circular` to prevent circular dependencies
- **Import Organization**: Run import organization script regularly
- **Type Safety**: Maintain strict TypeScript configuration