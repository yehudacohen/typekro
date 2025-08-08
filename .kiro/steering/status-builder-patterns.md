# Status Builder Patterns

## Supported Patterns

Based on the complete-webapp.ts example, these are the **only** supported patterns for status builders:

### ✅ SUPPORTED: Direct Resource References
```typescript
// Simple field mapping - no fallbacks needed
totalReplicas: resources.webapp?.spec.replicas,
readyReplicas: resources.webapp?.status.readyReplicas,
```

### ✅ SUPPORTED: CEL Expressions for Complex Logic
```typescript
// Boolean expressions with CEL
databaseReady: Cel.expr<boolean>(resources.database?.status.readyReplicas, "> 0"),
webAppReady: Cel.expr<boolean>(resources.webapp?.status.readyReplicas, " = ", resources.webapp?.spec.replicas),
ingressReady: Cel.expr<boolean>(resources.webappIngress?.status.loadBalancer.ingress?.length, " > 0"),
```

### ✅ SUPPORTED: CEL Templates for String Construction
```typescript
// String templates with CEL
url: Cel.template(`https://%s`, schema.spec.hostname),
```

### ❌ NOT SUPPORTED: JavaScript Fallback Patterns
```typescript
// These patterns are STALE and not supported:
readyReplicas: resources.deployment?.status.readyReplicas || 0,
url: resources.service?.status.loadBalancer?.ingress?.[0]?.ip || 'http://pending',
endpoint: `http://${resources.webService?.metadata?.name || 'pending'}`,
```

## Why JavaScript Fallbacks Don't Work

The status builder functions are **serialized to CEL expressions** for Kro. JavaScript runtime logic like `||` operators and template literals with JavaScript expressions cannot be converted to CEL.

## Migration Guide

### Old Pattern → New Pattern

```typescript
// OLD (not supported)
readyReplicas: resources.deployment?.status.readyReplicas || 0,

// NEW (supported)
readyReplicas: resources.deployment?.status.readyReplicas,
```

```typescript
// OLD (not supported)
ready: resources.deployment?.status.readyReplicas > 0,

// NEW (supported)
ready: Cel.expr<boolean>(resources.deployment?.status.readyReplicas, "> 0"),
```

```typescript
// OLD (not supported)
url: `https://${schema.spec.hostname}/api`,

// NEW (supported)
url: Cel.template(`https://%s/api`, schema.spec.hostname),
```

## Test Writing Guidelines

When writing tests for status builders:

1. **Use only supported patterns** from this document
2. **Reference complete-webapp.ts** as the canonical example
3. **Don't test unsupported JavaScript patterns** - they should not work
4. **Focus on CEL expression generation** in serialization tests

## Enforcement

- Any test using `||` fallbacks in status builders should be updated or removed
- Status builders should only use patterns demonstrated in complete-webapp.ts
- New features should follow these established patterns