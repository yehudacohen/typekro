# Troubleshooting

Common issues and solutions when working with TypeKro.

## Enable Debug Logging

### Environment Variables

```bash
# Set log level (trace, debug, info, warn, error, fatal)
export TYPEKRO_LOG_LEVEL=debug

# Enable debug mode for factory operations
export TYPEKRO_DEBUG=true

# Enable pretty-printed logs for development
export TYPEKRO_LOG_PRETTY=true
```

### Programmatic Configuration

```typescript
import { enableCompositionDebugging } from 'typekro';

// Enable composition debugging
enableCompositionDebugging();

// Or configure factory with debug options
const factory = webapp.factory('direct', {
  namespace: 'dev',
  debugLogging: {
    enabled: true,
    statusPolling: true,
    readinessEvaluation: true,
    verboseMode: true
  },
  eventMonitoring: {
    enabled: true,
    eventTypes: ['Normal', 'Warning', 'Error'],
    includeChildResources: true
  },
  progressCallback: (event) => {
    console.log(`[${event.type}]`, event);
  }
});
```

## Inspecting Generated CEL

Use `toYaml()` to see exactly what CEL expressions TypeKro generates:

```typescript
const yaml = composition.toYaml({ name: 'test', image: 'nginx' });
console.log(yaml);
// See the actual CEL expressions in status mappings
```

## Common Error Messages

### "Resource not found in composition context"

**Cause:** Resource created outside the composition function or missing `id` field.

```typescript
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';

// ❌ Wrong - resource outside composition
const deployment = Deployment({ id: 'deploy', name: 'app', image: 'nginx' });
const composition = kubernetesComposition(def, (spec) => {
  return { ready: deployment.status.readyReplicas > 0 }; // Won't work
});

// ✅ Correct - resource inside composition with id
const composition = kubernetesComposition(def, (spec) => {
  const deployment = Deployment({ 
    id: 'deployment',  // Required for cross-references
    name: 'app', 
    image: 'nginx'
  });
  return { ready: deployment.status.readyReplicas > 0 };
});
```

### "Invalid CEL expression"

**Cause:** Unsupported JavaScript pattern in status builder.

```typescript
// ❌ Unsupported - function calls
status: deployment.status.conditions.find(c => c.type === 'Available')

// ✅ Supported - use explicit CEL
status: Cel.expr(
  'deployment.status.conditions.filter(c, c.type == "Available")[0].status'
)
```

### "Cannot read property 'status' of undefined"

**Cause:** Resource reference without `id` or typo in resource variable name.

```typescript
import { Deployment } from 'typekro/simple';

// ❌ Wrong - no id field means status references won't work
const db = Deployment({ name: 'postgres', image: 'postgres:15' });
return { ready: db.status.readyReplicas > 0 }; // db.status may be undefined

// ✅ Correct - with id field
const db = Deployment({ 
  id: 'database',  // Enables status references
  name: 'postgres', 
  image: 'postgres:15'
});
return { ready: db.status.readyReplicas > 0 };
```

**When is `id` required?** See [Resource IDs](/advanced/resource-ids) for the complete rule:
- Required if you reference `.status` or `.metadata` on the resource
- Optional for standalone resources with no references

### "Resource ID collision detected"

**Cause:** Two resources have the same `id` value. See [Resource IDs](/advanced/resource-ids) for naming conventions.

```typescript
import { Deployment } from 'typekro/simple';

// ❌ Wrong - duplicate IDs
const frontend = Deployment({ id: 'app', name: 'frontend', image: 'nginx' });
const backend = Deployment({ id: 'app', name: 'backend', image: 'node' });

// ✅ Correct - unique IDs
const frontend = Deployment({ id: 'frontend', name: 'frontend', image: 'nginx' });
const backend = Deployment({ id: 'backend', name: 'backend', image: 'node' });
```

### "Timeout waiting for resource readiness"

**Cause:** Resource failed to become ready within timeout period.

```bash
# Check resource status
kubectl describe deployment <name> -n <namespace>
kubectl get events -n <namespace> --sort-by='.lastTimestamp'
```

```typescript
// Increase timeout for slow resources
const factory = webapp.factory('direct', {
  namespace: 'prod',
  timeout: 300000  // 5 minutes
});
```

### "HelmRelease not ready"

**Cause:** Flux HelmRelease failed to reconcile.

```bash
# Check HelmRelease status
kubectl get helmrelease -A
kubectl describe helmrelease <name> -n <namespace>

# Check Flux logs
kubectl logs -n flux-system deployment/helm-controller
```

## Common Pitfalls

### Resources Outside Composition Context

Resources must be created inside the composition function:

```typescript
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';

// ❌ Won't be tracked
const sharedDeployment = Deployment({ id: 'shared', name: 'shared', image: 'nginx' });

// ✅ Created inside composition
const composition = kubernetesComposition(def, (spec) => {
  const deployment = Deployment({ id: 'app', name: 'app', image: 'nginx' });
  // ...
});
```

### Unsupported JavaScript Patterns

These JavaScript patterns don't convert to CEL:

```typescript
// ❌ Function calls
deployment.status.conditions.find(c => c.type === 'Ready')

// ❌ Destructuring
const { readyReplicas } = deployment.status

// ❌ Loops
for (const condition of deployment.status.conditions) { }

// ❌ Variable assignments
let ready = deployment.status.readyReplicas > 0
```

Use explicit CEL for complex operations:

```typescript
// ✅ Use Cel.expr for complex logic
ready: Cel.expr(
  'deployment.status.conditions.filter(c, c.type == "Ready")[0].status == "True"'
)
```

### Missing Type Parameters

Always specify types for CEL expressions:

```typescript
// ❌ Missing type
ready: Cel.expr(deployment.status.readyReplicas, ' > 0')

// ✅ With type parameter
ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0')
```

### Forgetting the `id` Field

The `id` field is required when you reference a resource's status or metadata.

```typescript
import { Deployment } from 'typekro/simple';

// ❌ Can't reference this resource's status (no id)
const deploy = Deployment({ name: 'app', image: 'nginx' });
return { ready: deploy.status.readyReplicas > 0 }; // Won't generate correct CEL

// ✅ Can reference status via id
const deploy = Deployment({ id: 'app', name: 'app', image: 'nginx' });
return { ready: deploy.status.readyReplicas > 0 }; // Generates: ${app.status.readyReplicas > 0}
```

**Quick rule:** If you access `.status` or `.metadata` on a resource, add an `id`.

See [Resource IDs](/advanced/resource-ids) for complete documentation.

## Validating CEL Before Deployment

Test your CEL expressions before deploying:

```typescript
// Generate YAML and inspect
const yaml = composition.toYaml(testSpec);
console.log(yaml);

// Look for status mappings section
// Verify CEL expressions are correct
```

## Debugging Deployment Issues

### Check Resource Events

```bash
kubectl get events -n your-namespace --sort-by='.lastTimestamp'
kubectl describe deployment your-app -n your-namespace
```

### Check Kro Controller (if using Kro mode)

```bash
kubectl logs -n kro-system deployment/kro-controller-manager
kubectl get resourcegraphdefinition
kubectl describe rgd your-graph
```

### Verify Cluster Access

```bash
kubectl cluster-info
kubectl auth can-i create deployments
kubectl auth can-i create services
```

## Performance Issues

### Slow Deployments

```typescript
// Reduce timeout for faster feedback in development
const factory = webapp.factory('direct', {
  namespace: 'dev',
  timeout: 60000,      // 1 minute
  waitForReady: false  // Don't wait for readiness
});
```

### Memory Usage

For large compositions, monitor memory:

```bash
node --max-old-space-size=4096 your-deploy-script.js
```

## Getting Help

1. **Check the YAML output** - `toYaml()` shows exactly what TypeKro generates
2. **Enable debug logging** - See internal operations
3. **Inspect cluster state** - Use kubectl to verify resources
4. **Check Kro logs** - If using Kro mode, controller logs show CEL evaluation

## Next Steps

- **[JavaScript to CEL](./javascript-to-cel.md)** - Supported patterns
- **[Magic Proxy](./magic-proxy.md)** - How references work
- **[API Reference](/api/)** - Complete function documentation
