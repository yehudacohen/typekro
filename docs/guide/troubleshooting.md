# Troubleshooting

Common issues and solutions when working with TypeKro.

## Installation Issues

### TypeScript Version Conflicts

**Problem:** TypeScript compilation errors or version conflicts.

**Solution:**
```bash
# Ensure you have TypeScript 5.0+
bun add -d typescript@latest

# Check your version
bunx tsc --version
```

**tsconfig.json requirements:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true
  }
}
```

### Module Resolution Errors

**Problem:** Cannot find module 'typekro' or import errors.

**Solution:**
```bash
# Reinstall dependencies
rm -rf node_modules bun.lockb
bun install

# Verify installation
bun list typekro
```

## Deployment Issues

### Kubernetes Connection Errors

**Problem:** `kubectl` connection errors or cluster access issues.

**Diagnosis:**
```bash
# Test cluster connection
kubectl cluster-info
kubectl get nodes

# Check current context
kubectl config current-context
kubectl config get-contexts
```

**Solutions:**
```bash
# Switch context if needed
kubectl config use-context <context-name>

# Update kubeconfig
kubectl config view --raw > ~/.kube/config

# Test with specific kubeconfig
export KUBECONFIG=/path/to/your/kubeconfig
```

### Resource Deployment Failures

**Problem:** Resources fail to deploy or get stuck in pending state.

**Diagnosis:**
```typescript
// Enable debug logging
const factory = graph.factory('direct', {
  namespace: 'default',
  timeout: 60000  // Increase timeout
});

try {
  await factory.deploy(spec);
} catch (error) {
  console.error('Deployment failed:', error);
  
  // Check resource status
  const status = await factory.getStatus();
  console.log('Factory status:', status);
}
```

**Common solutions:**
```bash
# Check resource events
kubectl describe deployment <deployment-name>
kubectl get events --sort-by=.metadata.creationTimestamp

# Check resource quotas
kubectl describe resourcequota
kubectl get limitrange

# Check node resources
kubectl top nodes
kubectl describe nodes
```

### Namespace Issues

**Problem:** Resources deployed to wrong namespace or namespace doesn't exist.

**Solution:**
```typescript
// Ensure namespace exists
const factory = graph.factory('direct', {
  namespace: 'my-namespace'  // Make sure this namespace exists
});

// Or create namespace first
await kubectl.apply(`
apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`);
```

## Reference Resolution Issues

### Cross-Resource Reference Errors

**Problem:** References between resources fail to resolve.

**Diagnosis:**
```typescript
// Check if referenced resource exists
const graph = toResourceGraph(
  {
    name: 'my-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'MyApp',
    spec: MyAppSpec,
    status: MyAppStatus,
  },
  (schema) => ({
  database: simpleDeployment({ name: 'db' }),
  app: simpleDeployment({
    env: {
      DB_HOST: database.status.podIP  // Make sure 'database' is defined above
    }
  })
}));
```

**Common issues:**
- Referenced resource not defined in the same graph
- Typo in resource name
- Circular references between resources

### CEL Expression Errors

**Problem:** CEL expressions fail to evaluate or produce unexpected results.

**Diagnosis:**
```typescript
import { Cel } from 'typekro';

// Test CEL expressions in isolation
try {
  const expr = Cel.expr('5 > 3');  // Should be true
  console.log('CEL test passed');
} catch (error) {
  console.error('CEL error:', error);
}
```

**Common solutions:**
```typescript
// ✅ Correct CEL syntax
const ready = Cel.expr(deployment.status.readyReplicas, '> 0');

// ❌ Common mistakes
const wrong1 = Cel.expr(deployment.status.readyReplicas > 0);  // Don't use JS operators
const wrong2 = Cel.expr('deployment.status.readyReplicas > 0');  // Don't quote the whole expression
```

## Type Safety Issues

### Type Assertion Errors

**Problem:** TypeScript errors about type mismatches.

**Solution:**
```typescript
// ✅ Use proper types
const deployment = simpleDeployment({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3  // number, not string
});

// ❌ Common type errors
const badDeployment = simpleDeployment({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: '3'  // Error: string not assignable to number
});
```

### Missing Type Definitions

**Problem:** TypeScript can't find type definitions.

**Solution:**
```bash
# Install type definitions
bun add -d @types/node

# For Kubernetes types
bun add -d @kubernetes/client-node
```

## Performance Issues

### Slow Deployment Times

**Problem:** Deployments take too long or time out.

**Solutions:**
```typescript
// Increase timeout
const factory = graph.factory('direct', {
  timeout: 300000  // 5 minutes
});

// Disable readiness waiting for faster deployment
const factory = graph.factory('direct', {
  waitForReady: false
});

// Use parallel deployment
const results = await Promise.all([
  factory1.deploy(spec1),
  factory2.deploy(spec2)
]);
```

### Memory Issues

**Problem:** High memory usage or out-of-memory errors.

**Solutions:**
```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=4096"

# Or run with more memory
node --max-old-space-size=4096 your-script.js
```

## YAML Generation Issues

### Invalid YAML Output

**Problem:** Generated YAML is malformed or invalid.

**Diagnosis:**
```bash
# Validate generated YAML
kubectl apply --dry-run=client -f generated.yaml

# Check YAML syntax
yamllint generated.yaml
```

**Common issues:**
```typescript
// ✅ Proper string values
const config = simpleConfigMap({
  data: {
    'key': 'value'  // String value
  }
});

// ❌ Non-string values in ConfigMap data
const badConfig = simpleConfigMap({
  data: {
    'key': 123  // Should be string
  }
});
```

### Missing Required Fields

**Problem:** Kubernetes rejects resources due to missing required fields.

**Solution:**
```typescript
// Ensure all required fields are provided
const deployment = simpleDeployment({
  name: 'my-app',        // Required
  image: 'nginx:latest', // Required
  // Optional fields with defaults
  replicas: 1,
  ports: [{ containerPort: 80 }]
});
```

## Debugging Tips

### Enable Debug Logging

```typescript
import { createLogger } from 'typekro';

const logger = createLogger({
  level: 'debug',
  pretty: true
});
```

### Use Dry Run Mode

```typescript
const factory = graph.factory('direct', {
  dryRun: true  // Don't actually deploy
});

const result = await factory.deploy(spec);
console.log('Would deploy:', result);
```

### Inspect Generated Resources

```typescript
// Check what resources would be created
const resources = graph.getResources(spec);
console.log('Resources:', JSON.stringify(resources, null, 2));

// Check generated YAML
const yaml = graph.toYaml(spec);
console.log('Generated YAML:', yaml);
```

### Step-by-Step Debugging

```typescript
try {
  console.log('1. Creating factory...');
  const factory = graph.factory('direct', { namespace: 'test' });
  
  console.log('2. Deploying resources...');
  const result = await factory.deploy(spec);
  
  console.log('3. Checking status...');
  const status = await factory.getStatus();
  
  console.log('4. Success!', { result, status });
} catch (error) {
  console.error('Failed at step:', error.message);
  console.error('Full error:', error);
}
```

## Common Error Messages

### "Resource not found"

**Cause:** Referenced resource doesn't exist in cluster.
**Solution:** Check resource names and namespaces.

### "Namespace not found"

**Cause:** Target namespace doesn't exist.
**Solution:** Create namespace or use existing one.

### "Insufficient permissions"

**Cause:** RBAC permissions missing.
**Solution:** Check service account permissions.

### "CEL expression evaluation failed"

**Cause:** Invalid CEL syntax or missing references.
**Solution:** Validate CEL expressions and referenced fields.

### "Type 'X' is not assignable to type 'Y'"

**Cause:** TypeScript type mismatch.
**Solution:** Check parameter types and fix mismatches.

## Getting Help

### Check Documentation
- [Getting Started Guide](./getting-started.md)
- [API Reference](../api/)
- [Examples](../examples/)

### Community Support
- [GitHub Issues](https://github.com/yehudacohen/typekro/issues) - Bug reports and feature requests
- [GitHub Discussions](https://github.com/yehudacohen/typekro/discussions) - Questions and community help

### Debugging Information to Include

When reporting issues, include:

1. **TypeKro version:** `bun list typekro`
2. **Node.js/Bun version:** `node --version` or `bun --version`
3. **TypeScript version:** `bunx tsc --version`
4. **Kubernetes version:** `kubectl version`
5. **Error messages:** Full error output
6. **Minimal reproduction:** Smallest code that reproduces the issue
7. **Environment:** OS, cluster type (minikube, kind, cloud provider)

### Creating Minimal Reproductions

```typescript
// Minimal example that reproduces the issue
import { toResourceGraph, simpleDeployment } from 'typekro';
import { type } from 'arktype';

const AppSpec = type({ name: 'string' });

const graph = toResourceGraph(
  {
    name: 'test',
    apiVersion: 'example.com/v1alpha1',
    kind: 'TestApp',
    spec: TestAppSpec,
    status: TestAppStatus,
  },
  (schema) => ({
  app: simpleDeployment({
    name: schema.spec.name,
    image: 'nginx:latest'
  })
}), {
  apiVersion: 'example.com/v1alpha1',
  kind: 'TestApp',
  spec: AppSpec
});

// Code that demonstrates the issue
const factory = graph.factory('direct');
await factory.deploy({ name: 'test-app' });  // Fails here
```