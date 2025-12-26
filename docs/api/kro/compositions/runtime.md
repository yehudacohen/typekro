# TypeKro Runtime Bootstrap

Deploy the Kro controller and Flux CD with a single TypeKro composition.

## When You Need This

The runtime bootstrap is required when you want to use **Kro mode** deployment, which provides:

- Runtime CEL expression evaluation
- Continuous status reconciliation
- Cross-resource references resolved against live cluster state

If you only use **Direct mode**, you don't need the runtime bootstrap.

## Quick Start

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

const runtime = typeKroRuntimeBootstrap();

const factory = runtime.factory('direct', {
  namespace: 'flux-system',
  waitForReady: true,
  timeout: 300000  // 5 minutes - controllers take time to start
});

await factory.deploy({ namespace: 'flux-system' });
```

## What Gets Deployed

The bootstrap deploys:

1. **Flux CD** - GitOps toolkit (source-controller, helm-controller, etc.)
2. **Kro Controller** - ResourceGraphDefinition controller
3. **Required RBAC** - ClusterRoleBindings for controllers
4. **Namespaces** - `flux-system` and `kro`

## Configuration

```typescript
interface TypeKroRuntimeConfig {
  namespace?: string;     // Target namespace (default: 'flux-system')
  fluxVersion?: string;   // Flux version (default: 'v2.7.5')
  kroVersion?: string;    // Kro version (default: '0.3.0')
}
```

### Example with Custom Versions

```typescript
const runtime = typeKroRuntimeBootstrap({
  namespace: 'flux-system',
  fluxVersion: 'v2.7.5',
  kroVersion: '0.3.0'
});
```

## Status

The composition provides status on component readiness:

```typescript
interface TypeKroRuntimeStatus {
  phase: 'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading';
  components: {
    fluxSystem: boolean;
    kroSystem: boolean;
  };
}
```

## After Bootstrap

Once the runtime is deployed, you can use Kro mode:

```typescript
// Now Kro mode works
const factory = myComposition.factory('kro', { namespace: 'production' });
await factory.deploy({ name: 'my-app', image: 'nginx' });
```

## Verifying Installation

```bash
# Check Flux controllers
kubectl get pods -n flux-system

# Check Kro controller
kubectl get pods -n kro

# Check ResourceGraphDefinitions
kubectl get rgd -A
```

## Troubleshooting

### Controllers Not Starting

```bash
# Check Flux controller logs
kubectl logs -n flux-system deployment/helm-controller

# Check Kro controller logs
kubectl logs -n kro deployment/kro-controller-manager
```

### CRD Validation Errors

The bootstrap includes fixes for Kubernetes 1.33+ CRD schema validation. If you see validation errors, ensure you're using the latest TypeKro version.

## Next Steps

- [Deployment Modes](/guide/deployment-modes) - Direct vs Kro comparison
- [Kro Overview](/api/kro/) - ResourceGraphDefinition details

