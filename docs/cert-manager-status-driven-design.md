# Cert-Manager Status-Driven Design

## Current Implementation Issues

The current `certManagerBootstrap` composition has a design limitation: it uses static values for status fields instead of leveraging TypeKro's status-driven capabilities.

## Why This Happened

1. **Bootstrap Focus**: The composition was designed as a "bootstrap" that only creates Helm resources
2. **Indirect Resource Management**: cert-manager creates its own Services/Deployments via Helm
3. **Missing Resource References**: We can't reference Service status because we don't create them directly

## Proper Status-Driven Approach

### Option 1: Full Resource Composition (Recommended)

Create a comprehensive composition that includes actual Kubernetes resources:

```typescript
export const certManagerFull = kubernetesComposition(
  {
    name: 'cert-manager-full',
    apiVersion: 'typekro.io/v1alpha1', 
    kind: 'CertManagerFull',
    spec: CertManagerFullConfigSchema,
    status: CertManagerFullStatusSchema,
  },
  (spec) => {
    // Create actual Kubernetes resources directly
    const controllerDeployment = simple.Deployment({
      name: `${spec.name}-controller`,
      namespace: spec.namespace,
      image: `quay.io/jetstack/cert-manager-controller:${ensureVersionPrefix(spec.version)}`,
      // ... full deployment spec
      id: 'controllerDeployment'
    });

    const controllerService = simple.Service({
      name: spec.name,
      namespace: spec.namespace,
      selector: { app: 'cert-manager' },
      ports: [{ port: 9402, targetPort: 9402 }],
      id: 'controllerService'
    });

    const webhookService = simple.Service({
      name: `${spec.name}-webhook`,
      namespace: spec.namespace,
      selector: { app: 'cert-manager-webhook' },
      ports: [{ port: 443, targetPort: 10250 }],
      id: 'webhookService'
    });

    // Return status with real resource references
    return {
      // Real-time status from actual resources
      ready: controllerDeployment.status.readyReplicas === controllerDeployment.spec.replicas,
      controllerReady: controllerDeployment.status.readyReplicas > 0,
      
      // Dynamic endpoints from actual service status
      endpoints: {
        webhook: `https://${webhookService.status.clusterIP}:443/mutate`,
        metrics: `http://${controllerService.status.clusterIP}:9402/metrics`,
        healthz: `http://${controllerService.status.clusterIP}:9402/healthz`,
      },
      
      // Real-time CRD count (requires cluster-level query)
      crds: {
        installed: true, // Could query actual CRDs
        count: 6, // Could count actual cert-manager CRDs
      }
    };
  }
);
```

### Option 2: Hybrid Approach

Keep Helm bootstrap but add resource queries:

```typescript
export const certManagerHybrid = kubernetesComposition(
  {
    name: 'cert-manager-hybrid',
    apiVersion: 'typekro.io/v1alpha1',
    kind: 'CertManagerHybrid', 
    spec: CertManagerHybridConfigSchema,
    status: CertManagerHybridStatusSchema,
  },
  (spec) => {
    // Create Helm resources
    const helmRepository = certManagerHelmRepository({...});
    const helmRelease = certManagerHelmRelease({...});
    
    // Query existing services created by Helm (requires service discovery)
    const controllerService = simple.Service.query({
      name: spec.name,
      namespace: spec.namespace,
      id: 'controllerService'
    });
    
    return {
      // Helm-based readiness
      ready: helmRelease.status.phase === 'Ready',
      
      // Dynamic endpoints from discovered services
      endpoints: {
        metrics: `http://${controllerService.status.clusterIP}:9402/metrics`,
      }
    };
  }
);
```

## Implementation Priority

1. **Short-term**: Keep current bootstrap with improved documentation
2. **Medium-term**: Implement cert-manager CRD factories (Task 6)
3. **Long-term**: Create full resource composition with real status references

## Key Principles

1. **Status fields should reference actual Kubernetes resources when possible**
2. **Static values are acceptable only when resource queries are impractical**
3. **Document why static values are used and how to make them dynamic**
4. **Prefer resource status over constructed values**

This aligns with TypeKro's core philosophy of type-safe, status-driven Kubernetes resource management.