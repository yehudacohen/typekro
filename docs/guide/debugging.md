# Debugging TypeKro Applications

TypeKro provides comprehensive debugging capabilities to help you troubleshoot composition issues, understand resource references, and optimize deployment performance. This guide covers all debugging tools and techniques.

## Environment Variables

### TYPEKRO_LOG_LEVEL

Control TypeKro's logging verbosity with the `TYPEKRO_LOG_LEVEL` environment variable:

```bash
# Available log levels (in order of verbosity)
export TYPEKRO_LOG_LEVEL=trace   # Most verbose - all internal operations
export TYPEKRO_LOG_LEVEL=debug   # Debug information - recommended for development
export TYPEKRO_LOG_LEVEL=info    # General information - default production level
export TYPEKRO_LOG_LEVEL=warn    # Warnings only
export TYPEKRO_LOG_LEVEL=error   # Errors only
export TYPEKRO_LOG_LEVEL=fatal   # Critical errors only
```

### Additional Debugging Variables

```bash
# Enable proxy debugging (shows magic proxy operations)
export TYPEKRO_DEBUG=true

# Pretty-print JSON logs for development
export TYPEKRO_LOG_PRETTY=true

# Log to file instead of stdout
export TYPEKRO_LOG_DESTINATION=/tmp/typekro-debug.log

# Enable specific component debugging
export TYPEKRO_DEBUG_COMPONENTS="composition,proxy,serialization"
```

## Development Setup

### Recommended Development Configuration

```bash
# .env.development
TYPEKRO_LOG_LEVEL=debug
TYPEKRO_LOG_PRETTY=true  
TYPEKRO_DEBUG=true
NODE_ENV=development
```

### Production Debugging Configuration

```bash
# .env.production
TYPEKRO_LOG_LEVEL=info
TYPEKRO_LOG_PRETTY=false
TYPEKRO_LOG_DESTINATION=/var/log/typekro/app.log
```

## Common Debugging Scenarios

### 1. Resource Reference Issues

**Problem**: Cross-resource references not working as expected

```typescript
// Enable debug logging to see reference resolution
const deployment = Deployment({ name: 'web-app', image: 'nginx:latest', id: 'webApp' });
const service = Service({
  name: deployment.metadata.name, // This reference might not work as expected
  selector: { app: deployment.metadata.labels.app }
});
```

**Debug Steps**:

```bash
# Enable detailed proxy logging
export TYPEKRO_DEBUG=true
export TYPEKRO_LOG_LEVEL=debug

# Run your composition
node your-app.js 2>&1 | grep -E "(proxy|reference|serialization)"
```

**Expected Output**:
```json
{"level":"debug","component":"factory-proxy","msg":"Proxy created","resourceId":"webApp","basePath":"metadata"}
{"level":"debug","component":"serialization","msg":"Converting reference to CEL","fieldPath":"webApp.metadata.name"}
```

### 2. CEL Expression Debugging

**Problem**: CEL expressions in status builders not evaluating correctly

```typescript
const webApp = kubernetesComposition(
  { /* schema */ },
  (spec) => {
    const deployment = Deployment({ /* config */ });
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0') // Debug this expression
    };
  }
);
```

**Debug Steps**:

```bash
# Enable CEL debugging
export TYPEKRO_LOG_LEVEL=debug
export TYPEKRO_DEBUG_COMPONENTS="cel,serialization"

# Check generated CEL expressions
node -e "console.log(JSON.stringify(webApp.toYaml(), null, 2))" | grep -A5 -B5 "cel"
```

### 3. Composition Context Issues

**Problem**: Resources not being auto-captured in kubernetesComposition

```typescript
const myComposition = kubernetesComposition(
  { /* schema */ },
  (spec) => {
    // These resources should be auto-captured
    const db = Deployment({ name: 'database', image: 'postgres:15' });
    const web = Deployment({ name: 'webapp', image: 'nginx:latest' });
    
    return { ready: true };
  }
);
```

**Debug Steps**:

```bash
export TYPEKRO_LOG_LEVEL=debug
export TYPEKRO_DEBUG_COMPONENTS="composition"
```

**Check Logs**:
```json
{"level":"debug","component":"composition","msg":"Resource registered","resourceId":"database","kind":"Deployment"}
{"level":"debug","component":"composition","msg":"Resource registered","resourceId":"webapp","kind":"Deployment"}
{"level":"info","component":"composition","msg":"Composition completed","resourceCount":2}
```

### 4. Serialization Problems

**Problem**: Resources not serializing to YAML correctly

```typescript
const resource = createResource({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'test' }
});

console.log(resource.toYaml()); // Not producing expected output
```

**Debug Steps**:

```bash
export TYPEKRO_LOG_LEVEL=trace
export TYPEKRO_DEBUG_COMPONENTS="serialization"

# Enable proxy debugging to see property access
export TYPEKRO_DEBUG=true
```

## Debugging Tools and Methods

### 1. Resource Inspection

```typescript
import { getCurrentCompositionContext } from 'typekro';

// Within a composition function
const myComposition = kubernetesComposition(
  { /* schema */ },
  (spec) => {
    const deployment = Deployment({ name: 'my-app', image: 'nginx:latest' });
    
    // Debug: Check composition context
    const context = getCurrentCompositionContext();
    if (context) {
      console.log('Registered resources:', Object.keys(context.resources));
      console.log('Resource count:', context.resourceCounter);
    }
    
    // Debug: Inspect Enhanced resource properties
    console.log('Resource ID:', deployment.id);
    console.log('Resource kind:', deployment.kind);
    console.log('Metadata name:', deployment.metadata.name);
    
    return { ready: true };
  }
);
```

### 2. CEL Expression Testing

```typescript
import { Cel } from 'typekro';

// Test CEL expressions in isolation
const testExpr = Cel.expr<boolean>('resources.deployment.status.readyReplicas', ' > 0');
console.log('CEL Expression:', JSON.stringify(testExpr));

const testTemplate = Cel.template('https://%s.example.com', 'my-app');
console.log('CEL Template:', JSON.stringify(testTemplate));
```

### 3. Readiness Evaluator Testing

```typescript
import type { ReadinessEvaluator } from 'typekro';

const customEvaluator: ReadinessEvaluator = (liveResource) => {
  console.log('Evaluating readiness for:', liveResource.metadata?.name);
  console.log('Resource status:', JSON.stringify(liveResource.status, null, 2));
  
  // Your readiness logic here
  return { ready: true, message: 'Custom evaluation complete' };
};

const deployment = Deployment({ 
  name: 'debug-app', 
  image: 'nginx:latest' 
}).withReadinessEvaluator(customEvaluator);
```

## Troubleshooting Common Issues

### Issue: "Resource not found in composition context"

**Symptoms**:
```
Error: Resource with ID 'myResource' not found in composition context
```

**Solutions**:
1. Ensure resource has explicit `id` field:
   ```typescript
   const resource = Deployment({ name: 'my-app', image: 'nginx:latest', id: 'myResource' });
   ```

2. Check that resource is created within composition function:
   ```typescript
   const composition = kubernetesComposition(
     { /* schema */ },
     (spec) => {
       // Resource must be created HERE, not outside
       const resource = Deployment({ /* config */ });
       return { /* status */ };
     }
   );
   ```

### Issue: "Invalid CEL expression"

**Symptoms**:
```
Error: Invalid CEL expression: unexpected token
```

**Solutions**:
1. Check CEL syntax:
   ```typescript
   // ❌ Wrong
   Cel.expr(resource.status.ready == true)
   
   // ✅ Correct  
   Cel.expr<boolean>(resource.status.ready, ' == true')
   ```

2. Verify resource references:
   ```typescript
   // ❌ Wrong - using undefined resource
   Cel.expr<boolean>(undefinedResource.status.ready, ' == true')
   
   // ✅ Correct - using defined resource
   const deployment = Deployment({ /* config */ });
   Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0')
   ```

### Issue: "Cross-resource references not working"

**Symptoms**: Resources reference each other but values are not passed correctly

**Solutions**:
1. Ensure resources are Enhanced proxies:
   ```typescript
   const deployment = Deployment({ name: 'web', image: 'nginx:latest' });
   const service = Service({
     name: deployment.metadata.name, // This creates a KubernetesRef
     selector: deployment.spec.selector.matchLabels
   });
   ```

2. Check serialization output:
   ```bash
   export TYPEKRO_LOG_LEVEL=debug
   node -e "console.log(service.toYaml())" | grep -E "cel|ref"
   ```

## Performance Debugging

### Memory Usage

```bash
# Monitor memory usage during composition
node --max-old-space-size=8192 --expose-gc your-app.js

# In your application
if (global.gc) {
  console.log('Memory before:', process.memoryUsage());
  global.gc();
  console.log('Memory after GC:', process.memoryUsage());
}
```

### Timing Analysis

```typescript
import { performance } from 'perf_hooks';

const start = performance.now();

const composition = kubernetesComposition(
  { /* schema */ },
  (spec) => {
    const compositionStart = performance.now();
    
    // Your composition logic
    const resources = createMyResources(spec);
    
    const compositionEnd = performance.now();
    console.log(`Composition took ${compositionEnd - compositionStart}ms`);
    
    return { ready: true };
  }
);

const yaml = composition.toYaml();
const end = performance.now();

console.log(`Total execution time: ${end - start}ms`);
```

## Log Analysis

### Filtering Logs by Component

```bash
# View only composition-related logs
tail -f /var/log/typekro/app.log | jq 'select(.component == "composition")'

# View proxy operations
tail -f /var/log/typekro/app.log | jq 'select(.component == "factory-proxy")'

# View serialization details
tail -f /var/log/typekro/app.log | jq 'select(.component == "serialization")'
```

### Error Correlation

```bash
# Find errors and their context (5 lines before/after)
grep -C 5 '"level":"error"' /var/log/typekro/app.log | jq .
```

## Best Practices for Debugging

### 1. Structured Logging in Custom Code

```typescript
import { getComponentLogger } from 'typekro';

const logger = getComponentLogger('my-factory');

export function myCustomFactory(config: Config) {
  const functionLogger = logger.child({ 
    factoryName: 'myCustomFactory',
    resourceName: config.name 
  });
  
  functionLogger.debug('Starting factory creation', { config });
  
  try {
    const resource = createResource({ /* config */ });
    functionLogger.info('Factory resource created successfully');
    return resource;
  } catch (error) {
    functionLogger.error('Factory creation failed', error);
    throw error;
  }
}
```

### 2. Development vs Production Debugging

```typescript
const isDevelopment = process.env.NODE_ENV === 'development';

if (isDevelopment) {
  // Enable verbose debugging in development
  process.env.TYPEKRO_LOG_LEVEL = 'debug';
  process.env.TYPEKRO_DEBUG = 'true';
  process.env.TYPEKRO_LOG_PRETTY = 'true';
}
```

### 3. Conditional Debug Output

```typescript
const DEBUG = process.env.TYPEKRO_DEBUG === 'true';

function debugComposition(resources: Record<string, any>) {
  if (!DEBUG) return;
  
  console.log('=== DEBUG: Composition Resources ===');
  for (const [key, resource] of Object.entries(resources)) {
    console.log(`${key}:`, {
      id: resource.id,
      kind: resource.kind,
      name: resource.metadata?.name
    });
  }
  console.log('=== END DEBUG ===');
}
```

This comprehensive debugging guide should help developers troubleshoot issues effectively and understand TypeKro's internal operations during development and production.