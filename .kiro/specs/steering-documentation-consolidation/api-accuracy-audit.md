# API Accuracy Audit and Corrections

## Audit Summary

After reviewing the actual TypeKro implementation against the steering documentation, several API misuses and inaccuracies were identified. This document details the issues found and provides corrections.

## Critical API Misuses Identified

### 1. Factory Function Names and Import Paths

**Issue**: Documentation uses incorrect factory function names and import patterns.

**Incorrect Examples in Documentation**:
```typescript
// WRONG - These don't exist
import { deployment, service } from 'typekro';
const db = deployment({ name: 'database', image: 'postgres' });
const svc = service({ name: 'svc', ports: [80] });
```

**Correct API Usage**:
```typescript
// CORRECT - Use simple factory functions or full kubernetes factories
import { simple } from 'typekro';
// OR
import { Deployment, Service } from 'typekro/simple';

const db = simple.Deployment({ name: 'database', image: 'postgres' });
const svc = simple.Service({ name: 'svc', ports: [{ port: 80 }] });

// OR using direct imports
const db = Deployment({ name: 'database', image: 'postgres' });
const svc = Service({ name: 'svc', ports: [{ port: 80 }] });
```

### 2. toResourceGraph API Signature

**Issue**: Documentation shows incorrect API signature for `toResourceGraph`.

**Incorrect Examples in Documentation**:
```typescript
// WRONG - This signature doesn't exist
const graph = toResourceGraph(
  definition,
  (schema) => ({ /* resources */ }),
  (schema, resources) => ({ /* status */ })
);
```

**Correct API Usage**:
```typescript
// CORRECT - toResourceGraph requires definition as first parameter
const graph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'v1alpha1', 
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (schema) => ({
    deployment: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      id: 'webappDeployment', // id is required for references
    }),
  }),
  (_schema, resources) => ({
    url: 'http://example.com',
    readyReplicas: resources.deployment.status.readyReplicas,
  })
);
```

### 3. kubernetesComposition API

**Issue**: Documentation doesn't mention the primary imperative API `kubernetesComposition`.

**Missing from Documentation**:
```typescript
// CORRECT - This is the primary imperative API
import { kubernetesComposition } from 'typekro';

const webApp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (spec) => {
    // Resources are auto-captured
    const deployment = simple.Deployment({
      name: spec.name,
      image: spec.image,
      id: 'deployment',
    });

    // Return status - resources auto-captured
    return {
      ready: deployment.status.readyReplicas >= spec.replicas,
    };
  }
);
```

### 4. Factory Function Parameters

**Issue**: Documentation shows incorrect parameter structures for factory functions.

**Incorrect Examples**:
```typescript
// WRONG - Missing required id parameter and incorrect port structure
const deployment = simple.Deployment({ name: 'app', image: 'nginx' });
const service = simple.Service({ name: 'svc', ports: [80] });
```

**Correct API Usage**:
```typescript
// CORRECT - Include id for references and proper port structure
const deployment = simple.Deployment({ 
  name: 'app', 
  image: 'nginx',
  id: 'appDeployment' // Required for cross-resource references
});

const service = simple.Service({ 
  name: 'svc', 
  ports: [{ port: 80, targetPort: 3000 }], // Proper port object structure
  selector: { app: 'app' },
  id: 'appService'
});
```

### 5. Status Builder Patterns

**Issue**: Documentation shows outdated status builder patterns.

**Incorrect Examples**:
```typescript
// WRONG - This pattern is not the primary API
return {
  ready: Cel.expr<boolean>(resources.deployment?.status.readyReplicas, "> 0")
};
```

**Correct API Usage**:
```typescript
// CORRECT - Natural JavaScript expressions (imperative composition)
return {
  ready: deployment.status.readyReplicas >= deployment.spec.replicas
};

// OR for toResourceGraph (declarative)
(_schema, resources) => ({
  ready: resources.deployment.status.readyReplicas >= 1
})
```

### 6. Import Patterns

**Issue**: Documentation shows incorrect import patterns.

**Incorrect Examples**:
```typescript
// WRONG - These imports don't exist
import { deployment, service, simpleDeployment } from 'typekro';
```

**Correct Import Patterns**:
```typescript
// CORRECT - Available import patterns
import { simple, toResourceGraph, kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';
import { type } from 'arktype';
```

## Specific Documentation Corrections Needed

### Architecture Guide Corrections

**Section**: "Primary API: toResourceGraph"

**Current (Incorrect)**:
```typescript
const graph = toResourceGraph(
  'webapp-stack',
  (schema) => ({ /* resources */ }),
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  }
);
```

**Should Be**:
```typescript
const graph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (schema) => ({
    deployment: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      id: 'webappDeployment',
    }),
  }),
  (_schema, resources) => ({
    ready: resources.deployment.status.readyReplicas >= 1,
  })
);
```

### Testing Guidelines Corrections

**Section**: "Type Safety Testing"

**Current (Incorrect)**:
```typescript
const database = deployment({ name: 'db', image: 'postgres' });
const webapp = deployment({
  name: 'web',
  image: 'nginx',
  env: {
    DB_HOST: database.status.podIP
  }
});
```

**Should Be**:
```typescript
const database = simple.Deployment({ 
  name: 'db', 
  image: 'postgres',
  id: 'database'
});
const webapp = simple.Deployment({
  name: 'web',
  image: 'nginx',
  env: {
    DB_HOST: database.status.podIP
  },
  id: 'webapp'
});
```

**Section**: "Status Builder Testing"

**Current (Incorrect)**:
```typescript
// These patterns are STALE and not supported:
readyReplicas: resources.deployment?.status.readyReplicas || 0,
```

**Should Be**:
```typescript
// JavaScript fallbacks don't work in CEL serialization context
// But natural JavaScript expressions DO work in imperative compositions:

// SUPPORTED in kubernetesComposition:
return {
  readyReplicas: deployment.status.readyReplicas >= 1 ? deployment.status.readyReplicas : 0
};

// SUPPORTED in toResourceGraph:
(_schema, resources) => ({
  readyReplicas: resources.deployment.status.readyReplicas
})
```

### Development Standards Corrections

**Section**: "Problem-Solving Methodology"

**Current (Incorrect)**:
```typescript
// Test expects: 'readyReplicas: ${webapp-deployment.status.availableReplicas}'
// Code produces: 'readyReplicas: ${""}'
```

**Should Be**:
```typescript
// Test expects: 'readyReplicas: ${webappDeployment.status.readyReplicas}'
// Code produces: 'readyReplicas: ${""}'
// Fix: Ensure resource has proper id and is referenced correctly
```

## Missing API Documentation

### 1. kubernetesComposition API

The documentation completely misses the primary imperative composition API:

```typescript
import { kubernetesComposition } from 'typekro';

const webApp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1', 
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (spec) => {
    // Single function: resources auto-captured, return status
    const deployment = simple.Deployment({
      name: spec.name,
      image: spec.image,
      id: 'deployment',
    });

    return {
      ready: deployment.status.readyReplicas >= spec.replicas,
    };
  }
);
```

### 2. Simple Factory Namespace

The documentation doesn't properly explain the `simple` namespace:

```typescript
import { simple } from 'typekro';

// All simple factories available under simple namespace
const deployment = simple.Deployment({ /* config */ });
const service = simple.Service({ /* config */ });
const ingress = simple.Ingress({ /* config */ });
```

### 3. Factory Options and Methods

Missing documentation for factory creation and options:

```typescript
// Factory creation with options
const kroFactory = await graph.factory('kro', {
  namespace: 'production',
  timeout: 30000,
  waitForReady: true,
});

const directFactory = await graph.factory('direct', {
  namespace: 'production',
  waitForReady: true,
});
```

## Recommended Actions

### 1. Update Architecture Guide

- Fix all `toResourceGraph` examples with correct API signature
- Add `kubernetesComposition` as primary imperative API
- Correct factory function names and import patterns
- Add proper simple factory namespace documentation

### 2. Update Testing Guidelines

- Fix all factory function examples
- Correct status builder pattern examples
- Update type safety examples with proper imports
- Clarify which patterns work in which contexts (imperative vs declarative)

### 3. Update Development Standards

- Fix serialization examples with correct resource references
- Update problem-solving examples with actual API usage
- Correct all code examples to use proper factory functions

### 4. Add Missing API Coverage

- Document `kubernetesComposition` API thoroughly
- Document `simple` factory namespace
- Document factory creation and options
- Document proper resource ID requirements for cross-references

## Validation Required

After corrections are made, the following should be validated:

1. All code examples compile without errors
2. All import statements are correct
3. All factory function calls use proper signatures
4. All API patterns match actual implementation
5. Examples demonstrate real-world usage patterns

This audit reveals that the steering documentation contains significant API inaccuracies that would mislead developers. Immediate corrections are needed to ensure the documentation reflects the actual TypeKro implementation.